import { analysisInputDigest } from "../digest.mjs";
import { errorCode, errorMessage, isOneOf } from "../data.mjs";
import { requiresHumanJudgment } from "../factory/definitions.mjs";
import { decodeRequest } from "../requests.mjs";
import { FoundryOperationError } from "./errors.mjs";
import { branchCommit, requireAncestor, requireCommit } from "../evidence/git.mjs";
import { checkVerifierWorktree } from "../evidence/worktrees.mjs";
import { fail } from "../factory/fields.mjs";
import { latestSuccessfulAttempt } from "../plan/queries.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("../types/workflow.js").WorkflowAnalysisPort} WorkflowAnalysis */
/** @template {keyof typeof import("../requests.mjs").requestShapes} K @typedef {import("../requests.mjs").Request<K>} Request */
/** @typedef {ReturnType<typeof import("../factory.mjs").createFactoryService>} FactoryService */
/** @typedef {"inspect" | "createUnit" | "appendKnowledge" | "acceptContract" | "prepareCandidate" | "recordDelivery" | "recordEvaluation" | "decideCandidate" | "recordSignal" | "retire" | "compactFactory" | "exportFactory" | "importFactory" | "exportFactoryPage" | "importFactoryPage" | "abandonFactoryImport" | "migrateFactory"} PublicFactoryAction */

/** Reads repository/worktree facts before the task writer transaction.
 * @param {FoundryPlan} plan @param {string} taskId @param {import("../types/plan.js").FoundryAttempt} attempt
 * @param {string | null | undefined} commit @returns {import("../types/plan.js").RepositoryCheck | undefined} */
export function checkTaskRepository(plan, taskId, attempt, commit) {
	if (commit == null) return undefined;
	const directory = plan.repository.workingDirectory;
	const target = requireCommit(directory, commit);
	const task = plan.tasks.find((entry) => entry.id === taskId);
	if (!task) fail("factory_execution_mismatch", "Repository checks require the exact task");
	const dependencies = task.dependsOn.map((id) => {
		const dependency = plan.tasks.find((entry) => entry.id === id);
		const delivery = dependency ? latestSuccessfulAttempt(dependency) : null;
		if (!delivery) fail("factory_integration_unsupported", "A dependency has no successful immutable delivery", { disposition: "inconclusive" });
		return delivery.commit ?? (delivery.branch ? branchCommit(directory, delivery.branch) : fail("factory_integration_unsupported", "Dependency ancestry cannot be established from a PR URL alone", { disposition: "unsupported" }));
	});
	for (const dependency of dependencies) requireAncestor(directory, dependency, target);
	let worktree;
	if (task.kind === "verify") {
		const expected = plan.evaluationTarget?.commit ?? dependencies[0];
		if (expected !== target) fail("factory_evidence_subject_mismatch", "A verifier must report the exact delivered target, not a different integration commit");
		worktree = checkVerifierWorktree(directory, attempt.verifierWorktree, target);
	}
	return {
		version: 1, commit: target, integrationCommits: [...new Set(dependencies)].sort(),
		...(worktree ? { worktree } : {}),
	};
}

/** @param {{
 * workspace: () => string,
 * storeFor: ReturnType<typeof import("./storage.mjs").createSessionStorage>["storeFor"],
 * notify: (event: import("../types/plan.js").ChangeEvent) => void,
 * factory: Pick<ReturnType<typeof import("../bridge.mjs").createFactoryBridge>, "sync" | "factoryFor" | "createPlan" | "createEvaluationPlan">,
 * analysis: Pick<WorkflowAnalysis, "importAnalysis">,
 * }} dependencies */
export function createRepositoryOperations({ workspace, storeFor, notify, factory, analysis }) {

	/** @param {FoundryPlan} plan */
	const syncFactoryPlan = (plan) => {
		try {
			const result = factory.sync(plan);
			if (result.published) notify({ workspacePath: workspace(), planId: plan.id, revision: plan.revision });
			return result;
		} catch (error) {
			throw new FoundryOperationError("factory_sync_pending", "Plan state is persisted; repository factory synchronization needs recovery with foundry_sync_factory", {
				planId: plan.id, revision: plan.revision, cause: { code: errorCode(error), message: errorMessage(error) },
			});
		}
	};

	/**
	 * @template {PublicFactoryAction} A
	 * @overload
	 * @param {{repositoryPath: string, action: A, input?: Record<string, unknown>}} value
	 * @returns {Promise<ReturnType<FactoryService[A]>>}
	 */
	/** @overload @param {unknown} value @returns {Promise<ReturnType<FactoryService[PublicFactoryAction]>>} */
	/** @param {unknown} value @returns {Promise<ReturnType<FactoryService[PublicFactoryAction]>>} */
	async function factoryAction(value) {
		const { repositoryPath, action, input = {} } = decodeRequest("factoryAction", value);
		const service = factory.factoryFor(repositoryPath);
		const allowed = /** @type {const} */ (["inspect", "createUnit", "appendKnowledge", "acceptContract", "prepareCandidate", "recordDelivery", "recordEvaluation", "decideCandidate", "recordSignal", "retire", "compactFactory", "exportFactory", "importFactory", "exportFactoryPage", "importFactoryPage", "abandonFactoryImport", "migrateFactory"]);
		if (!isOneOf(action, allowed)) throw new FoundryOperationError("factory_action_invalid", `Unsupported factory action ${action}`);
		if (["recordDelivery", "recordEvaluation"].includes(action)) {
			const candidate = service.snapshot().candidates.find((entry) => entry.id === input.candidateId);
			if (candidate?.binding) throw new FoundryOperationError("factory_bound_evidence", "Bound candidate evidence must come from its attached task/verification flow");
		}
		switch (action) {
			case "exportFactory": return service.exportFactory();
			case "inspect": return service.inspect(decodeRequest("factoryInspect", input));
			case "exportFactoryPage": return service.exportFactoryPage(decodeRequest("factoryExportPage", input));
			case "importFactory": return service.importFactory({ source: input.source, expectedRevision: input.expectedRevision });
			case "importFactoryPage": {
				const parsed = decodeRequest("factoryImportPage", input);
				return service.importFactoryPage({ ...parsed, page: parsed.page });
			}
			case "abandonFactoryImport": return service.abandonFactoryImport(decodeRequest("factoryAbandonImport", input));
			case "migrateFactory": return service.migrateFactory(decodeRequest("factoryMigrate", input));
			default: return service[action](input);
		}
	}

	/** @param {Request<"createFactoryPlan">} input */
	const createFactoryPlan = (input) => factory.createPlan(input);

	/** @param {Request<"createEvaluationPlan">} input */
	const createEvaluationPlan = (input) => factory.createEvaluationPlan(input);

	/** @param {Request<"recordHumanJudgment">} input */
	const recordHumanJudgment = async ({ repositoryPath, expectedRevision, actor, reason, sourceRef, judgmentId, performedAt, ...input }) => {
		if (typeof judgmentId !== "string" || !judgmentId.trim() || judgmentId.length > 512
			|| typeof sourceRef !== "string" || !sourceRef.trim()
			|| typeof performedAt !== "string" || !performedAt.trim()) {
			throw new FoundryOperationError("factory_human_source_required", "A stable claimed judgmentId, actual sourceRef and performedAt are required. Receipt IDs and publication time are not judgment identity or observation time.");
		}
		const service = factory.factoryFor(repositoryPath);
		const definition = service.generation(input.candidateId).evaluations.find((entry) => entry.id === input.evaluation?.id && entry.revision === input.evaluation?.revision);
		if (!definition || !requiresHumanJudgment(definition.evaluation)) {
			throw new FoundryOperationError("factory_human_judgment_required", "This path records a genuinely human evaluation, not an executable or agent check");
		}
		return service.recordEvaluation({
			expectedRevision, ...input,
			source: { kind: "human", ref: sourceRef, actor, at: performedAt, owner: workspace(), judgmentId },
			independence: { method: "human-review", reason },
		});
	};

	/** @param {Request<"syncFactory">} input */
	const syncFactory = async ({ planId }) => syncFactoryPlan(await storeFor().read(planId));

	/** @param {Request<"captureAnalysis">} input */
	const captureAnalysis = async ({ repositoryPath, unitId, runId, expectedRevision, actor }) => {
		const service = factory.factoryFor(repositoryPath);
		const before = service.snapshot();
		if (before.revision !== expectedRevision) throw new FoundryOperationError("revision_conflict", "Repository authority changed before analysis capture");
		if (!before.units.some((unit) => unit.id === unitId)) throw new FoundryOperationError("factory_unit_missing", "Analysis capture requires an explicit existing capability scope");
		const imported = await analysis.importAnalysis(runId);
		/** @type {Record<string, import("../types/factory.js").SourceKind>} */
		const kinds = { audit: "audit", "deep-research": "research", "review-queue": "review", "security-review": "security", triage: "triage" };
		return service.ingestAnalysis({
			expectedRevision, unitId, report: imported.report,
			source: {
				kind: kinds[imported.workflowName], ref: `workflow:${runId}`, actor,
				at: new Date(imported.completedAt).toISOString(), runId, owner: workspace(),
				digest: analysisInputDigest(imported.report),
			},
		});
	};
	return { syncFactoryPlan, factoryAction, createFactoryPlan, createEvaluationPlan, recordHumanJudgment, syncFactory, captureAnalysis };
}
