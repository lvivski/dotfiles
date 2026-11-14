import { approvePlan, retryFailedPlan, transitionPlan } from "../plan/lifecycle.mjs";
import { assertString } from "../plan/fields.mjs";
import { LIMITS, PLAN_STATUS } from "../plan/values.mjs";
import { FoundryOperationError } from "./errors.mjs";
import { realpathSync } from "node:fs";
import { buildRepairPreparation, repairAuthority, repairLaunch, repairObject } from "../analysis/repair.mjs";
import { errorMessage, isRecord, parseJson, readJsonValue } from "../data.mjs";
import { stableStringify } from "../digest.mjs";
import { createRepairJournal } from "../storage/repair.mjs";

/** @typedef {import("../types/workflow.js").WorkflowAnalysisPort} WorkflowAnalysis */
/** @template {keyof typeof import("../requests.mjs").requestShapes} K @typedef {import("../requests.mjs").Request<K>} Request */

/** @param {{
 * analysis: Pick<WorkflowAnalysis, "preparePlanning" | "importPlanning" | "readPlanningRepairSource" | "importPlanningRepair" | "reconcilePlanningRepair" | "inspectWorkflow">,
 * factory: Pick<ReturnType<typeof import("../bridge.mjs").createFactoryBridge>, "context" | "createBoundDraft" | "requireRetry" | "activateEvaluation" | "verificationGate">,
 * persist: ReturnType<typeof import("./mutation.mjs").createPlanMutations>["persist"],
 * syncFactoryPlan: ReturnType<typeof import("./repository.mjs").createRepositoryOperations>["syncFactoryPlan"],
 * approveDelegated: ReturnType<typeof import("./approval.mjs").createApprovalOperations>["approveDelegated"],
 * approveTechnical: ReturnType<typeof import("./technical.mjs").createTechnicalOperations>["approveTechnical"],
 * workspace: () => string,
 * storeFor: ReturnType<typeof import("./storage.mjs").createSessionStorage>["storeFor"],
 * coordinator: ReturnType<typeof import("./approval.mjs").createApprovalOperations>["coordinator"],
 * getSession?: () => import("../types/repair.js").RepairSession | null | undefined,
 * }} dependencies */
export function createPlanningOperations({ analysis, factory, persist, syncFactoryPlan, approveDelegated, approveTechnical, workspace, storeFor, coordinator, getSession }) {
	/** @param {string} code @param {string} message @returns {never} */
	function fail(code, message) { throw new FoundryOperationError(code, message); }
	/** @param {import("../requests.mjs").OperationContext} options */
	async function journalFor(options) {
		const invocation = coordinator(options);
		await storeFor().list();
		coordinator(options);
		return createRepairJournal({ workspacePath: workspace(), sessionId: invocation.sessionId });
	}
	/** @param {string} repositoryPath @param {import("../types/repair.js").RepairSource} source */
	function authorityFor(repositoryPath, source) {
		const context = repairAuthority(source.material.input.factoryContext);
		if (context.owner !== workspace() || typeof context.unitId !== "string") fail("repair_foreign_owner", "Native source belongs to another owner");
		const canonicalPath = realpathSync(repositoryPath);
		if (canonicalPath !== repositoryPath) fail("repair_repository_changed", "Use the exact canonical repository path");
		const current = repairAuthority(factory.context(canonicalPath, context.unitId, { query: source.material.input.objective }));
		if (stableStringify(context) !== stableStringify(current)) fail("repair_authority_stale", "Repository, capability or governing authority changed");
		return { repositoryPath: canonicalPath, authority: current };
	}
	/** @param {import("../types/repair.js").RepairPreparation} preparation @param {import("../requests.mjs").OperationContext} options */
	async function revalidate(preparation, options) {
		const invocation = coordinator(options);
		if (preparation.owner !== workspace() || preparation.sessionId !== invocation.sessionId || preparation.mode !== "recovery"
			|| !preparation.repositoryPath || !analysis.readPlanningRepairSource) fail("repair_foreign_owner", "Recovery requires this owner's native preparation");
		const source = await analysis.readPlanningRepairSource(preparation.rootRunId);
		coordinator(options);
		if (source.resultDigest !== preparation.sourceDigest || source.inputDigest !== preparation.inputDigest
			|| stableStringify(source.material) !== stableStringify(preparation.material)
			|| stableStringify({ result: source.result, native: source.native }) !== stableStringify(preparation.source)) {
			fail("repair_source_changed", "The source result or its native lineage changed");
		}
		const current = authorityFor(preparation.repositoryPath, source);
		if (stableStringify(current.authority) !== stableStringify(preparation.authority)) fail("repair_authority_stale", "Prepared authority changed");
		return source;
	}

	/** @param {Request<"preparePlanRepair">} input @param {import("../requests.mjs").OperationContext} [options] */
	const preparePlanRepair = async (input, options = {}) => {
		const invocation = coordinator(options);
		if (!analysis.readPlanningRepairSource) fail("repair_backend_unavailable", "Native planning recovery inspection is unavailable");
		const source = await analysis.readPlanningRepairSource(input.runId);
		coordinator(options);
		const authority = authorityFor(input.repositoryPath, source);
		const preparation = buildRepairPreparation({
			owner: workspace(), sessionId: invocation.sessionId, rootRunId: source.runId,
			sourceDigest: source.resultDigest, mode: "recovery", ...authority,
			source: repairObject({ result: source.result, native: source.native }), material: source.material,
		});
		const journal = await journalFor(options);
		authorityFor(input.repositoryPath, source);
		const record = journal.prepare(preparation);
		return { preparationId: preparation.id, preparationDigest: preparation.digest, state: record.state, sourceRunId: source.runId, launchSpec: repairLaunch(preparation) };
	};

	/** Only the offered native tool may admit this exact prepared launch, with its normal permission.
	 * @param {Request<"launchPlanRepair">} input @param {import("../requests.mjs").OperationContext} [options] */
	const launchPlanRepair = async (input, options = {}) => {
		options.signal?.throwIfAborted();
		const journal = await journalFor(options);
		const preparation = journal.read(input.preparationId, input.preparationDigest).preparation;
		await revalidate(preparation, options);
		coordinator(options);
		options.signal?.throwIfAborted();
		journal.intent(preparation.id, preparation.digest);
		const executor = getSession?.()?.rpc?.tools;
		if (!executor) {
			journal.outcome(preparation.id, preparation.digest, "unavailable", null, { error: "Native offered-tool invocation is unavailable" });
			fail("repair_invocation_unavailable", "No supported offered run_dynamic_workflow route; the retained claim is held, not retried");
		}
		let raw;
		try {
			raw = readJsonValue(await executor.execute({ name: "run_dynamic_workflow", arguments: repairLaunch(preparation) }));
		} catch (error) {
			journal.outcome(preparation.id, preparation.digest, "uncertain", null, { error: errorMessage(error) });
			fail("repair_admission_uncertain", `Native admission is uncertain: ${errorMessage(error)}. Reconcile; do not launch again.`);
		}
		if (!isRecord(raw) || raw.resultType !== "success") {
			const state = isRecord(raw) && ["denied", "rejected"].includes(String(raw.resultType)) ? "denied" : "uncertain";
			journal.outcome(preparation.id, preparation.digest, state, null, raw);
			fail(state === "denied" ? "repair_permission_denied" : "repair_admission_uncertain", `Native admission did not succeed: ${stableStringify(raw)}`);
		}
		let runId;
		try {
			const decoded = parseJson(String(raw.textResultForLlm));
			const value = isRecord(decoded) && decoded.ok === true ? decoded.value : decoded;
			if (!isRecord(value) || typeof value.runId !== "string" || !value.runId || value.runId === preparation.rootRunId) throw new Error("Missing distinct native repair run ID");
			runId = value.runId;
			coordinator(options);
			const detail = await analysis.inspectWorkflow(runId);
			if (detail.runId !== runId || detail.workflowName !== "plan-repair") throw new Error("Native admission identity differs");
			coordinator(options);
		} catch (error) {
			journal.outcome(preparation.id, preparation.digest, "uncertain", runId ?? null, { raw, error: errorMessage(error) });
			fail("repair_admission_uncertain", errorMessage(error));
		}
		return journal.outcome(preparation.id, preparation.digest, "admitted", runId, raw);
	};

	/** @param {Request<"reconcilePlanRepair">} input @param {import("../requests.mjs").OperationContext} [options] */
	const reconcilePlanRepair = async (input, options = {}) => {
		const journal = await journalFor(options);
		const record = journal.read(input.preparationId, input.preparationDigest);
		if (record.state === "prepared" || !analysis.reconcilePlanningRepair) fail("repair_admission_held", "No native admission intent or supported reconciliation");
		await revalidate(record.preparation, options);
		const observation = await analysis.reconcilePlanningRepair(record.preparation);
		coordinator(options);
		return journal.outcome(input.preparationId, input.preparationDigest, "admitted", observation.runId, observation.evidence);
	};

	/** @param {Request<"importPlanRepair">} input @param {import("../requests.mjs").OperationContext} [options] */
	const importPlanRepair = async (input, options = {}) => {
		const journal = await journalFor(options);
		const record = journal.read(input.preparationId, input.preparationDigest);
		await revalidate(record.preparation, options);
		if (record.state !== "completed" || record.runId !== input.runId || !record.result
			|| record.preparation.repositoryPath !== input.repository.workingDirectory || !analysis.importPlanningRepair) {
			fail("repair_import_held", "A ready completed journal-bound repair in the same repository is required");
		}
		const imported = await analysis.importPlanningRepair(input.runId, record.preparation);
		coordinator(options);
		if (stableStringify(imported.outcome) !== stableStringify(record.result) || !imported.factoryContext) {
			fail("repair_result_mismatch", "Native repair result differs from the original durable execution evidence");
		}
		await revalidate(record.preparation, options);
		const created = await factory.createBoundDraft({
			id: input.id, repository: input.repository, expectedRevision: input.expectedRevision, blueprint: imported.plan,
			planning: { runId: imported.runId, inputDigest: imported.inputDigest, ...(imported.conceptualReview ? { conceptualReview: imported.conceptualReview } : {}) },
			factoryContext: imported.factoryContext,
		});
		syncFactoryPlan(created);
		return created;
	};

	/**
	 * Builds the native planning Workflow launch specification.
	 *
	 * @param {Request<"preparePlan">} input
	 */
	const preparePlan = async (input) => {
		const factoryContext = factory.context(input.repositoryPath, input.unitId, { query: input.objective });
		if (input.intent !== undefined && input.intent !== "discovery") {
			throw new FoundryOperationError("factory_planning_intent", "Native planning intent must be discovery; accepted reconstruction uses a sealed candidate");
		}
		if (factoryContext.contract && input.intent !== "discovery") {
			throw new FoundryOperationError("factory_candidate_required", "Accepted capabilities use prepare_candidate and create_factory_plan by default. Explicit intent: discovery is only for exploration, not replacement.");
		}
		return analysis.preparePlanning({ ...input, factoryContext: { ...factoryContext, purpose: "discovery" } });
	};

	/**
	 * Imports a completed planning run as a new draft artifact.
	 *
	 * @param {Request<"createPlan">} input
	 * @param {import("../requests.mjs").OperationContext} [options]
	 */
	const createPlan = async ({
		expectedRevision,
		id,
		repository,
		runId,
	}, options = {}) => {
		const { signal } = options;
		const imported = await analysis.importPlanning(runId, { signal });
		signal?.throwIfAborted();
		if (!imported.factoryContext) {
			throw new FoundryOperationError("factory_context_required", "Planning results must carry canonical factory context; prepare a capability-backed plan");
		}
		if (imported.repair) {
			const { preparationId, preparationDigest } = imported.repair.repairBudget;
			const journal = await journalFor(options);
			const record = journal.read(preparationId, preparationDigest);
			if (record.preparation.mode !== "inline" || record.state !== "completed" || record.runId !== runId
				|| record.preparation.rootRunId !== runId || stableStringify(record.result) !== stableStringify(imported.repair)
				|| stableStringify(record.preparation.material.input.factoryContext) !== stableStringify(imported.factoryContext)) {
				fail("repair_import_held", "Ordinary repaired plans require the original completed owner-local allowance");
			}
			const context = repairAuthority(imported.factoryContext);
			if (context.owner !== workspace() || typeof context.unitId !== "string"
				|| stableStringify(context) !== stableStringify(repairAuthority(factory.context(repository.workingDirectory, context.unitId)))) {
				fail("repair_authority_stale", "Ordinary repair authority changed before import");
			}
		}
		const created = await factory.createBoundDraft({
			id, repository, expectedRevision, blueprint: imported.plan,
			planning: { runId, inputDigest: imported.inputDigest, ...(imported.conceptualReview ? { conceptualReview: imported.conceptualReview } : {}) },
			factoryContext: imported.factoryContext,
		});
		syncFactoryPlan(created);
		return created;
	};

	/**
	 * Moves a draft into explicit approval review.
	 *
	 * @param {{planId: string, expectedRevision: number}} input
	 */
	const submitPlan = async ({ planId, expectedRevision }) => {
		return persist(
			planId,
			expectedRevision,
			(plan) => transitionPlan(plan, PLAN_STATUS.AWAITING_APPROVAL),
			"plan-submitted",
		);
	};

	/**
	 * Records initial approval, correction retry, or completion approval.
	 *
	 * @param {Request<"approve">} input
	 * @param {import("../requests.mjs").OperationContext} [options]
	 */
	const approve = async (input, options = {}) => {
		const {
			planId,
			expectedRevision,
			approvedBy,
			approvalType = "plan",
			retryStatus = PLAN_STATUS.RUNNING,
			delegationId,
			review,
			technical,
		} = input;
		if (delegationId && (approvedBy !== undefined || (approvalType === "retry") !== (technical !== undefined))) {
			throw new FoundryOperationError("delegation_approval_type", "Use the explicitly granted approval kind and required technical retry payload; native agent attribution cannot be supplied by the caller");
		}
		if (technical !== undefined && (!delegationId || approvalType !== "retry")) {
			throw new FoundryOperationError("delegation_approval_type", "Technical retries require their explicit technical grant, never mixed manual approval");
		}
		if (!delegationId && review !== undefined) throw new FoundryOperationError("delegation_approval_type", "Delegated review cannot be mixed with manual attribution");
		if (!delegationId) assertString(approvedBy, "approvedBy", LIMITS.actor);
		const updated = await persist(
			planId,
			expectedRevision,
			(plan, delegation) => {
				if (delegationId && approvalType === "retry") return approveTechnical(plan, delegation, input, options);
				if (delegationId) return approveDelegated(plan, delegation, review, options, approvalType === "completion" ? "completion" : "plan");
				assertString(approvedBy, "approvedBy", LIMITS.actor);
				if (approvalType === "plan") return approvePlan(plan, approvedBy);
				if (approvalType === "completion") {
					factory.verificationGate(plan, true, true);
					return transitionPlan(plan, PLAN_STATUS.COMPLETED, { actor: approvedBy });
				}
				if (approvalType !== "retry") throw new TypeError(`Unknown approvalType ${approvalType}`);
				factory.requireRetry(plan);
				if (retryStatus !== PLAN_STATUS.RUNNING) {
					throw new FoundryOperationError("invalid_retry_status", "Failed Foundry plans retry directly to running");
				}
				const retry = retryFailedPlan(plan, approvedBy);
				if (plan.evaluationTarget) syncFactoryPlan(plan);
				factory.activateEvaluation(retry);
				return retry;
			},
			approvalType === "retry" ? null : delegationId ? approvalType === "completion" ? "completion-approved:delegated" : "plan-approved:delegated" : `plan-approved:${approvalType}`,
			{ delegationId },
		);
		if (approvalType === "completion") syncFactoryPlan(updated);
		return updated;
	};
	return { preparePlan, createPlan, submitPlan, approve, preparePlanRepair, launchPlanRepair, reconcilePlanRepair, importPlanRepair };
}
