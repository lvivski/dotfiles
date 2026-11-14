import { approvePlan, retryFailedPlan, transitionPlan } from "../plan/lifecycle.mjs";
import { assertString } from "../plan/fields.mjs";
import { PLAN_STATUS } from "../plan/values.mjs";
import { FoundryOperationError } from "./errors.mjs";
import { realpathSync } from "node:fs";
import { assertRepairComparisonBinding, buildRepairEffect, buildRepairPreparation, checkRepairConservation, compareRepairProgress, repairAuthority, repairLaunch, repairObject } from "../analysis/repair.mjs";
import { admitRepairEffect, assertRepairContinuationSource, assertRepairSource, authenticateRepairEvidence } from "../native/repair.mjs";
import { errorCode, errorMessage, isRecord, parseJson, property, readJsonValue } from "../data.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { createRepairJournal } from "../storage/repair.mjs";

/** @typedef {import("../types/workflow.js").WorkflowAnalysisPort} WorkflowAnalysis */
/** @template {keyof typeof import("../requests.mjs").requestShapes} K @typedef {import("../requests.mjs").Request<K>} Request */

/** @param {{
 * analysis: Pick<WorkflowAnalysis, "preparePlanning" | "importPlanning" | "readPlanningRepairSource" | "readPlanningContinuation" | "importPlanningRepair" | "reconcilePlanningRepair" | "inspectWorkflow">,
 * factory: Pick<ReturnType<typeof import("../bridge.mjs").createFactoryBridge>, "context" | "createBoundDraft" | "requireRetry" | "activateEvaluation" | "verificationGate">,
 * persist: ReturnType<typeof import("./mutation.mjs").createPlanMutations>["persist"],
 * syncFactoryPlan: ReturnType<typeof import("./repository.mjs").createRepositoryOperations>["syncFactoryPlan"],
 * approveDelegated: ReturnType<typeof import("./approval.mjs").createApprovalOperations>["approveDelegated"],
 * approveTechnical: ReturnType<typeof import("./technical.mjs").createTechnicalOperations>["approveTechnical"],
 * workspace: () => string,
 * storeFor: ReturnType<typeof import("./storage.mjs").createSessionStorage>["storeFor"],
 * coordinator: ReturnType<typeof import("./approval.mjs").createApprovalOperations>["coordinator"],
 * getSession?: () => import("../types/repair.js").RepairSession | null | undefined,
 * getWorkflowRoute?: () => ((args: import("../types/repair.js").RepairLaunch, correlation: string) => Promise<unknown>) | undefined,
 * repairHost?: import("../types/repair.js").RepairHostPort,
 * }} dependencies */
export function createPlanningOperations({ analysis, factory, persist, syncFactoryPlan, approveDelegated, approveTechnical, workspace, storeFor, coordinator, getSession, getWorkflowRoute, repairHost }) {
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
	/** @param {import("../types/repair.js").RepairPreparation} preparation @param {import("../requests.mjs").OperationContext} options
	 * @param {import("../types/repair.js").RepairEffect} [effect] */
	async function revalidate(preparation, options, effect) {
		const invocation = coordinator(options);
		if (preparation.mode === "inline" && effect) {
			if (preparation.owner !== workspace() || preparation.sessionId !== invocation.sessionId || !analysis.readPlanningContinuation) fail("repair_foreign_owner", "Inline continuation requires its original owner and authentic native reader");
			const context = repairObject(effect.operation.context);
			const source = await analysis.readPlanningContinuation(preparation.rootRunId, preparation);
			assertRepairContinuationSource(preparation, source, context);
			if (typeof context.repositoryPath !== "string") fail("repair_repository_changed", "Continuation has no prepared canonical repository");
			const current = authorityFor(context.repositoryPath, source);
			if (stableStringify(current.authority) !== stableStringify(context.authority)) fail("repair_authority_stale", "Inline continuation authority changed");
			coordinator(options);
			return source;
		}
		if (preparation.owner !== workspace() || preparation.sessionId !== invocation.sessionId || preparation.mode !== "recovery"
			|| !preparation.repositoryPath || !analysis.readPlanningRepairSource) fail("repair_foreign_owner", "Recovery requires this owner's native preparation");
		const source = await analysis.readPlanningRepairSource(preparation.rootRunId);
		coordinator(options);
		assertRepairSource(preparation, source);
		const current = authorityFor(preparation.repositoryPath, source);
		if (stableStringify(current.authority) !== stableStringify(preparation.authority)) fail("repair_authority_stale", "Prepared authority changed");
		return source;
	}

	/** @param {Request<"preparePlanRepair">} input @param {import("../requests.mjs").OperationContext} [options] */
	const preparePlanRepair = async (input, options = {}) => {
		const invocation = coordinator(options);
		const retainedJournal = input.continuationOf === input.runId ? await journalFor(options) : null;
		const inline = retainedJournal?.findRoot(input.runId);
		if (inline?.preparation.mode === "inline") {
			if (!repairHost?.propose || !analysis.readPlanningContinuation) fail("repair_admission_unavailable", "Authentic inline continuation provider unavailable; legacy claims cannot supply another effect");
			const preparation = inline.preparation;
			const source = await analysis.readPlanningContinuation(input.runId, preparation);
			const current = authorityFor(input.repositoryPath, source);
			if (!retainedJournal) fail("repair_storage_authority", "Missing exact owner journal");
			const history = retainedJournal.comparisonHistory(preparation.id, preparation.digest);
			const latest = assertRepairComparisonBinding(preparation, history.at(-1));
			if (!compareRepairProgress(latest, history.slice(0, -1)).passed || !latest.obligations.some(item => item.status === "unresolved")) fail("repair_continuation_held", "Inline continuation requires retained substantive progress and an unresolved obligation");
			const prior = retainedJournal.events(preparation.id, preparation.digest).find(event => event.event === "recovery-result"
				&& isRecord(event.payload) && event.payload.runId === input.runId);
			const priorResult = prior && isRecord(prior.payload) ? repairObject(prior.payload.result) : null;
			const sourceOutcome = repairObject(Object.fromEntries(["plan", "verification", "synthesisRepair", "issues", "repairBudget", "recovery"].map(key => [key, source.result[key]])));
			if (!priorResult || stableStringify(priorResult) !== stableStringify(sourceOutcome)) fail("repair_source_changed", "Inline continuation native evidence differs from its original journal outcome");
			const context = repairObject({ ...current, source: { result: source.result, native: source.native } });
			const raw = await repairHost.propose(preparation, history, input.runId, context);
			retainedJournal.retain(preparation.id, preparation.digest, "raw-effect-proposal", readJsonValue(raw));
			await authenticateRepairEvidence(repairHost, raw);
			const previousRepair = repairObject(priorResult.synthesisRepair);
			const proposed = buildRepairEffect(preparation, "launch", history, previousRepair.candidate, priorResult.issues, null,
				repairObject({ launch: repairLaunch(preparation), continuationOf: input.runId, context }));
			if (stableStringify(proposed) !== stableStringify(raw)) fail("repair_effect_conflict", "Inline proposal changed actual source, candidate, diagnostics, contributors or authority");
			retainedJournal.proposeEffect(proposed);
			return { preparationId: preparation.id, preparationDigest: preparation.digest, state: "prepared", sourceRunId: input.runId,
				launchSpec: repairLaunch(preparation, proposed.id) };
		}
		if (!analysis.readPlanningRepairSource) fail("repair_backend_unavailable", "Native planning recovery inspection is unavailable");
		const source = await analysis.readPlanningRepairSource(input.runId);
		coordinator(options);
		const authority = authorityFor(input.repositoryPath, source);
		const proposedPreparation = buildRepairPreparation({
			owner: workspace(), sessionId: invocation.sessionId, rootRunId: source.runId,
			sourceDigest: source.resultDigest, mode: "recovery", ...authority,
			source: repairObject({ result: source.result, native: source.native }), material: source.material,
		});
		const journal = await journalFor(options);
		authorityFor(input.repositoryPath, source);
		const baseline = repairHost ? await repairHost.prepare(proposedPreparation) : undefined;
		if (baseline !== undefined) {
			await authenticateRepairEvidence(repairHost, baseline);
			assertRepairComparisonBinding(proposedPreparation, baseline);
		}
		const record = journal.prepare(proposedPreparation, baseline === undefined ? undefined : readJsonValue(baseline));
		const preparation = record.preparation;
		if (input.continuationOf !== undefined) {
			if (!repairHost?.propose) fail("repair_admission_unavailable", "Explicit recovery continuation requires an authentic proposed-effect host");
			const prior = journal.events(preparation.id, preparation.digest).find(event => event.event === "recovery-result"
				&& isRecord(event.payload) && event.payload.runId === input.continuationOf);
			if (!prior || !isRecord(prior.payload) || !isRecord(prior.payload.result)) fail("repair_continuation_held", "Continuation must name an exact retained recovery outcome");
			const previous = prior.payload.result;
			const history = journal.comparisonHistory(preparation.id, preparation.digest);
			const latest = assertRepairComparisonBinding(preparation, history.at(-1));
			if (!compareRepairProgress(latest, history.slice(0, -1)).passed || !latest.obligations.some(item => item.status === "unresolved")) {
				fail("repair_continuation_held", "Continuation requires independently evidenced progress with a remaining substantive obligation");
			}
			const repair = repairObject(previous.synthesisRepair);
			checkRepairConservation(preparation.material, repair.candidate);
			const raw = await repairHost.propose(preparation, history, input.continuationOf);
			journal.retain(preparation.id, preparation.digest, "raw-effect-proposal", readJsonValue(raw));
			await authenticateRepairEvidence(repairHost, raw);
			const proposed = buildRepairEffect(preparation, "launch", history, repair.candidate, previous.issues, null,
				repairObject({ launch: repairLaunch(preparation), continuationOf: input.continuationOf }));
			if (stableStringify(proposed) !== stableStringify(raw)) fail("repair_effect_conflict", "Host proposal does not bind the exact retained candidate, history and continuation");
			journal.proposeEffect(proposed);
			return { preparationId: preparation.id, preparationDigest: preparation.digest, state: "prepared", sourceRunId: source.runId,
				launchSpec: repairLaunch(preparation, proposed.id) };
		}
		return { preparationId: preparation.id, preparationDigest: preparation.digest, state: record.state, sourceRunId: source.runId, launchSpec: repairLaunch(preparation) };
	};

	/** Only the offered native tool may admit this exact prepared launch, with its normal permission.
	 * @param {Request<"launchPlanRepair">} input @param {import("../requests.mjs").OperationContext} [options] */
	const launchPlanRepair = async (input, options = {}) => {
		options.signal?.throwIfAborted();
		const journal = await journalFor(options);
		const preparation = journal.read(input.preparationId, input.preparationDigest).preparation;
		const selected = input.effectId === undefined ? undefined : journal.effects(preparation.id, preparation.digest).find(row => isRecord(row.effect) && row.effect.id === input.effectId)?.effect;
		const selectedEffect = selected && isRecord(selected) ? /** @type {import("../types/repair.js").RepairEffect} */ (selected) : undefined;
		await revalidate(preparation, options, selectedEffect);
		coordinator(options);
		options.signal?.throwIfAborted();
		const retained = journal.read(preparation.id, preparation.digest);
		if (retained.state === "prepared" && preparation.mode === "recovery") journal.intent(preparation.id, preparation.digest);
		/** @param {Parameters<typeof journal.outcome>[2]} state @param {string | null} runId
		 * @param {import("../types/json.js").JsonValue} evidence */
		function retain(state, runId, evidence) {
			const previous = journal.read(preparation.id, preparation.digest);
			if (preparation.mode === "inline") {
				journal.retain(preparation.id, preparation.digest, "subsequent-native-outcome", readJsonValue({ effectId: input.effectId ?? null, state, runId, evidence }));
				return { ...previous, state, runId };
			}
			if (input.effectId && previous.runId !== null && runId !== previous.runId) {
				journal.retain(preparation.id, preparation.digest, "subsequent-native-outcome", readJsonValue({ effectId: input.effectId, state, runId, evidence }));
				return { ...previous, state, runId };
			}
			try { return journal.outcome(preparation.id, preparation.digest, state, runId, evidence); }
			catch (error) {
				const details = property(error, "details");
				throw new FoundryOperationError(errorCode(error) ?? "repair_outcome_persistence_failed",
					`${errorMessage(error)}. Retain the original native evidence; reconcile this repair intent without launching again`, {
						...(isRecord(details) ? details : {}),
						preparationId: preparation.id, preparationDigest: preparation.digest,
						operation: "run_dynamic_workflow", disposition: "uncertain", unpersisted: { state, runId, evidence },
						persistenceError: { code: errorCode(error) ?? "repair_persistence_failed", message: errorMessage(error) },
					});
			}
		}
		if (!repairHost) {
			retain("unavailable", null, { error: "Authentic atomic native admission/review provider is unavailable" });
			fail("repair_admission_unavailable", "Fresh repair is held; plain tools.execute cannot establish atomic native resource admission");
		}
		if (["denied", "unavailable"].includes(retained.state)) fail("repair_admission_held", "Denied or unavailable historical admission cannot authorize a new effect");
		const history = journal.comparisonHistory(preparation.id, preparation.digest);
		const launch = repairLaunch(preparation, input.effectId);
		const previousLaunch = journal.effects(preparation.id, preparation.digest).find(row => isRecord(row.effect)
			&& row.effect.kind === "launch" && (input.effectId === undefined || row.effect.id === input.effectId));
		if (input.effectId !== undefined && !previousLaunch) fail("repair_preparation_missing", "Explicit effect must be an exact retained host proposal");
		const effect = previousLaunch && isRecord(previousLaunch.effect) ? /** @type {import("../types/repair.js").RepairEffect} */ (previousLaunch.effect)
			: buildRepairEffect(preparation, "launch", history, preparation.material.candidate, preparation.material.diagnostics, null, repairObject(launch));
		if (previousLaunch?.state === "prepared" && effect.historyDigest !== analysisInputDigest(history)) fail("repair_history_conflict", "Proposed effect history changed before admission");
		const route = getWorkflowRoute?.();
		if (!route && !journal.effects(preparation.id, preparation.digest).some(row => isRecord(row.effect) && row.effect.id === effect.id)) {
			retain("unavailable", null, { error: "Normal offered native route unavailable; no SDK fallback" });
			fail("repair_invocation_unavailable", "No normal offered native workflow route; retain the unavailable hold");
		}
		let raw;
		try {
			raw = await admitRepairEffect(repairHost, journal, effect, history, async () => {
				if (!route) fail("repair_invocation_unavailable", "Normal offered native route unavailable; no SDK fallback");
				return route(launch, `repair-${effect.id}`);
			}, options.signal);
		} catch (error) {
			const receipt = property(error, "receipt");
			const observed = journal.effects(preparation.id, preparation.digest).find(row => isRecord(row.effect) && row.effect.id === effect.id)?.receipt;
			const denied = isRecord(observed) && observed.disposition === "denied";
			retain(denied ? "denied" : "uncertain", null, readJsonValue({ error: errorMessage(error), ...(receipt === undefined ? {} : { receipt }), ...(observed ? { nativeReceipt: observed } : {}) }));
			fail(denied ? "repair_permission_denied" : "repair_admission_uncertain", `Native admission is held: ${errorMessage(error)}. Reconcile; do not launch again.`);
		}
		let runId;
		try {
			if (typeof raw.nativeRunId !== "string" || !raw.nativeRunId || raw.nativeRunId === preparation.rootRunId) throw new Error("Missing distinct native repair run ID");
			runId = raw.nativeRunId;
			coordinator(options);
			const detail = await analysis.inspectWorkflow(runId);
			if (detail.runId !== runId || detail.workflowName !== "plan-repair") throw new Error("Native admission identity differs");
			coordinator(options);
		} catch (error) {
			retain("uncertain", runId ?? null, { raw, error: errorMessage(error) });
			fail("repair_admission_uncertain", errorMessage(error));
		}
		return retain("admitted", runId, raw);
	};

	/** @param {Request<"reconcilePlanRepair">} input @param {import("../requests.mjs").OperationContext} [options] */
	const reconcilePlanRepair = async (input, options = {}) => {
		const journal = await journalFor(options);
		const record = journal.read(input.preparationId, input.preparationDigest);
		if (["denied", "unavailable"].includes(record.state)) fail("repair_admission_held", "Denied/unavailable admissions remain held; reconciliation cannot renew permission");
		if ((record.state === "prepared" && !journal.effects(input.preparationId, input.preparationDigest).some(row => isRecord(row.effect)
			&& row.effect.kind === "launch" && row.state !== "prepared")) || !analysis.reconcilePlanningRepair) fail("repair_admission_held", "No native admission intent or supported reconciliation");
		const selected = input.effectId === undefined ? undefined : journal.effects(input.preparationId, input.preparationDigest).find(row => isRecord(row.effect) && row.effect.id === input.effectId)?.effect;
		await revalidate(record.preparation, options, selected && isRecord(selected) ? /** @type {import("../types/repair.js").RepairEffect} */ (selected) : undefined);
		const effects = journal.effects(input.preparationId, input.preparationDigest).filter(row => isRecord(row.effect) && row.effect.kind === "launch"
			&& (input.effectId === undefined || row.effect.id === input.effectId));
		if (effects.length) {
			const latest = effects.at(-1);
			if (!latest || !isRecord(latest.effect) || !repairHost) fail("repair_admission_unavailable", "New effect reconciliation requires the authentic native host");
			const effect = /** @type {import("../types/repair.js").RepairEffect} */ (latest.effect);
			const receipt = await admitRepairEffect(repairHost, journal, effect, journal.comparisonHistory(input.preparationId, input.preparationDigest),
				async () => { fail("repair_admission_held", "Reconciliation never invokes a replacement effect"); }, options.signal);
			coordinator(options);
			if (typeof receipt.nativeRunId !== "string") fail("repair_admission_uncertain", "Missing native run");
			if (record.preparation.mode === "inline" || (input.effectId && record.runId !== null && receipt.nativeRunId !== record.runId)) {
				journal.retain(input.preparationId, input.preparationDigest, "subsequent-native-outcome", readJsonValue({ effectId: input.effectId, state: "admitted", runId: receipt.nativeRunId, evidence: receipt }));
				return { ...record, state: /** @type {const} */ ("admitted"), runId: receipt.nativeRunId };
			}
			return journal.outcome(input.preparationId, input.preparationDigest, "admitted", receipt.nativeRunId, receipt);
		}
		const observation = await analysis.reconcilePlanningRepair(record.preparation, { signal: options.signal });
		coordinator(options);
		return journal.outcome(input.preparationId, input.preparationDigest, "admitted", observation.runId, observation.evidence);
	};

	/** @param {Request<"importPlanRepair">} input @param {import("../requests.mjs").OperationContext} [options] */
	const importPlanRepair = async (input, options = {}) => {
		const journal = await journalFor(options);
		const record = journal.read(input.preparationId, input.preparationDigest);
		if (["denied", "unavailable"].includes(record.state)) fail("repair_import_held", "Denied/unavailable admission cannot authorize import");
		const selected = journal.effects(input.preparationId, input.preparationDigest).find(row => isRecord(row.effect)
			&& row.effect.kind === "launch" && isRecord(row.receipt) && row.receipt.nativeRunId === input.runId
			&& (input.effectId === undefined || row.effect.id === input.effectId))?.effect;
		if (input.effectId !== undefined && !isRecord(selected)) {
			fail("repair_effect_conflict", "Import effect must select the exact retained launch effect and native run");
		}
		const effect = selected && isRecord(selected) ? /** @type {import("../types/repair.js").RepairEffect} */ (selected) : undefined;
		await revalidate(record.preparation, options, effect);
		const modern = journal.events(input.preparationId, input.preparationDigest).find(event => event.event === "recovery-result"
			&& isRecord(event.payload) && event.payload.runId === input.runId);
		const result = modern && isRecord(modern.payload) ? modern.payload.result : record.result;
		const continuationContext = effect?.operation.context;
		const repositoryPath = record.preparation.mode === "inline" && isRecord(continuationContext) ? continuationContext.repositoryPath : record.preparation.repositoryPath;
		if ((!modern && (record.state !== "completed" || record.runId !== input.runId)) || !result
			|| repositoryPath !== input.repository.workingDirectory || !analysis.importPlanningRepair) {
			fail("repair_import_held", "A ready completed journal-bound repair in the same repository is required");
		}
		const imported = await analysis.importPlanningRepair(input.runId, record.preparation, effect);
		coordinator(options);
		if (stableStringify(imported.outcome) !== stableStringify(result) || !imported.factoryContext) {
			fail("repair_result_mismatch", "Native repair result differs from the original durable execution evidence");
		}
		await revalidate(record.preparation, options, effect);
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
			const modern = journal.events(preparationId, preparationDigest).find(event => event.event === "recovery-result"
				&& isRecord(event.payload) && event.payload.runId === runId);
			const result = modern && isRecord(modern.payload) ? modern.payload.result : record.result;
			if (record.preparation.mode !== "inline" || (!modern && (record.state !== "completed" || record.runId !== runId))
				|| record.preparation.rootRunId !== runId || stableStringify(result) !== stableStringify(imported.repair)
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
		if (!delegationId) assertString(approvedBy, "approvedBy");
		const updated = await persist(
			planId,
			expectedRevision,
			(plan, delegation) => {
				if (delegationId && approvalType === "retry") return approveTechnical(plan, delegation, input, options);
				if (delegationId) return approveDelegated(plan, delegation, review, options, approvalType === "completion" ? "completion" : "plan");
				assertString(approvedBy, "approvedBy");
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
