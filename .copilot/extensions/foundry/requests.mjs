/** Decoders shared by the tool/HTTP operation boundary; domain rules still own semantics. */
import { arrayOf as array, decodeRecord as decodeObject, nullable, optional, readRecord as record } from "./data.mjs";
import { assertKnownKeys, assertPlanId, FoundryDomainError } from "./plan/fields.mjs";
import { identifier as factoryIdentifier, integer, reference as factoryReference, strings, text } from "./factory/fields.mjs";
import { packageDecomposition } from "./plan/parallel-contracts.mjs";
import { validateTechnicalPolicy } from "./plan/schemas/approval.mjs";
import { validateFactoryEvaluations, validateFactoryLearning } from "./plan/schemas/factory.mjs";
import { ATTEMPT_ID_PATTERN, REQUEST_ID_PATTERN, TASK_ID_PATTERN } from "./plan/values.mjs";
import { repairDigest } from "./analysis/repair.mjs";

/** @template T @typedef {(value: unknown) => T} Decoder */
/** @template {Record<string, Decoder<unknown>>} T @typedef {import("./data.mjs").Decoded<T>} Decoded */
/** @param {unknown} value */
function string(value) {
	if (typeof value !== "string") throw new TypeError("Expected a string input field");
	return value;
}
/** @param {unknown} value */
function runId(value) {
	if (typeof value !== "string" || !value.trim()) throw new FoundryDomainError("workflow_run_invalid", "A non-empty native Workflow run ID is required");
	return value;
}
/** @param {unknown} value */
function number(value) {
	if (typeof value !== "number") throw new FoundryDomainError("invalid_expected_revision", "Expected a numeric revision");
	return value;
}
/** @param {unknown} value @returns {0} */
function zero(value) {
	if (value !== 0) throw new FoundryDomainError("invalid_expected_revision", "Creating or importing requires expectedRevision 0");
	return value;
}
/** @param {unknown} value */
function boolean(value) {
	if (typeof value !== "boolean") throw new TypeError("Expected a boolean input field");
	return value;
}
/** @param {unknown} value */
function knowledgeKind(value) {
	switch (value) {
		case "observation": case "inference": case "proposal": case "obligation": case "evaluation": return value;
		default: throw new TypeError("Expected a knowledge kind");
	}
}
/** @param {unknown} value */
const opaque = (value) => value;
/** Preserve extra keys so closed domain validators, rather than a decoder, reject them.
 * @template {Record<string, Decoder<unknown>>} T @param {T} fields @returns {Decoder<Decoded<T>>} */
const object = (fields) => (value) => ({ ...record(value), ...decodeObject(fields, value) });
/** @template {Record<string, Decoder<unknown>>} T @param {T} fields @returns {Decoder<Decoded<T>>} */
const closedObject = (fields) => (value) => {
	assertKnownKeys(record(value), new Set(Object.keys(fields)), "technical");
	return decodeObject(fields, value);
};
const repository = object({ workingDirectory: string, baseBranch: string });
const repairIdentity = { preparationId: repairDigest, preparationDigest: repairDigest };
const reference = object({ id: string, revision: number });
const revision = { planId: assertPlanId, expectedRevision: number };
const task = { ...revision, taskId: string };
const attempt = { ...task, attemptId: string };
const planId = { planId: assertPlanId };
const factoryPlan = {
	id: assertPlanId, repository, candidateId: string, expectedRevision: zero,
	expectedFactoryRevision: optional(number), expectedFiles: optional(array(string)), evaluations: optional(array(reference)),
	decomposition: optional(packageDecomposition),
};
/** @param {unknown} value */
const learning = (value) => { validateFactoryLearning(value); return value; };
/** @param {unknown} value */
const evaluations = (value) => { validateFactoryEvaluations(value); return value; };
const nullableText = optional(nullable(string));
/** @param {RegExp} pattern @param {string} label */
const identifier = (pattern, label) => (/** @type {unknown} */ value) => {
	if (typeof value !== "string" || !pattern.test(value)) throw new FoundryDomainError("parallel_request_invalid", `Invalid ${label}`);
	return value;
};
/** @param {unknown} value */
const dispatchLimit = value => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new FoundryDomainError("parallel_request_invalid", "Dispatch limit must be a positive safe integer");
	}
	return value;
};
/** @param {unknown} value */
const technicalPolicy = value => { validateTechnicalPolicy(value); return value; };
/** @param {unknown} value */
const failures = value => strings(value, "triggering failures", undefined, 1);
/** @param {unknown} value */
const positiveRevision = value => integer(value, "revision");
/** @param {unknown} value */
const factoryRevision = value => integer(value, "expectedRevision", 0);
/** @param {unknown} value */
const contractReason = value => text(value, "reason");
const technicalRetry = closedObject({ id: factoryIdentifier, failures });
const technicalRenewal = closedObject({
	id: factoryIdentifier, planId: assertPlanId, expectedPlanRevision: positiveRevision,
	delegationId: assertPlanId, previous: factoryReference, next: factoryReference, failures,
});
/** @param {unknown} value */
const approvalKind = value => {
	if (value !== "plan" && value !== "completion" && value !== "retry") throw new FoundryDomainError("delegation_approval_type", "Approval kind must be plan, completion or retry");
	return value;
};
/** @param {unknown} value */
const delegationKind = value => {
	if (value !== "plan" && value !== "completion" && value !== "technical") throw new FoundryDomainError("delegation_approval_type", "Delegation kind must be plan, completion or technical");
	return value;
};

export const requestShapes = {
	preparePlan: {
		repositoryPath: string, unitId: string, intent: optional(string), objective: string,
		constraints: optional(array(string)), repositoryContext: string, maxTasks: optional(number),
	},
	createPlan: { expectedRevision: zero, id: assertPlanId, repository, runId: string },
	preparePlanRepair: { runId, repositoryPath: string, continuationOf: optional(runId) },
	launchPlanRepair: { ...repairIdentity, effectId: optional(repairDigest) },
	reconcilePlanRepair: { ...repairIdentity, effectId: optional(repairDigest) },
	importPlanRepair: { ...repairIdentity, effectId: optional(repairDigest), expectedRevision: zero, id: assertPlanId, repository: closedObject({ workingDirectory: string, baseBranch: string }), runId },
	getPlan: planId,
	getStatus: { ...planId, sessionInventory: opaque, includeWorkflows: optional(boolean) },
	getWorkflow: { ...planId, runId, beforeSeq: opaque },
	controlWorkflow: { runId: string, action: string, planId: optional(assertPlanId), expectedRevision: optional(number) },
	listPlans: { limit: optional(number) },
	quarantinePlan: { ...planId, reason: string, requestedBy: string },
	importPlan: { source: opaque, expectedRevision: zero },
	exportPlan: planId,
	submitPlan: revision,
	approve: { ...revision, approvedBy: optional(string), approvalType: optional(approvalKind), retryStatus: optional(string), delegationId: optional(assertPlanId), review: optional(string), technical: optional(technicalRetry) },
	planApprovalDelegation: { action: string, id: assertPlanId, planId: optional(assertPlanId), expectedRevision: optional(number), reason: optional(string), authority: opaque, approvalType: optional(delegationKind), technical: optional(technicalPolicy) },
	nextTasks: planId,
	dispatchReady: { ...planId, limit: dispatchLimit },
	reconcileParallel: { ...planId, taskId: identifier(TASK_ID_PATTERN, "taskId"), reservationId: identifier(REQUEST_ID_PATTERN, "reservationId") },
	materializeInputs: { ...planId, taskId: identifier(TASK_ID_PATTERN, "taskId"), attemptId: identifier(ATTEMPT_ID_PATTERN, "attemptId") },
	assessPackage: { ...planId, taskId: identifier(TASK_ID_PATTERN, "taskId"), report: opaque },
	reserveTask: { ...task, reservationId: string, scopeOverride: optional(nullable(object({ approvedBy: string, reason: string }))) },
	attachTask: {
		...attempt, sessionId: string, branch: nullableText,
		bootstrap: optional(object({ worktreePath: string, baseCommit: string })),
		rename: optional(object({ fromBranch: string, worktreePath: string, actor: string, reason: string })),
	},
	completeTask: {
		...attempt, status: string, resultSummary: nullableText, evidence: opaque, error: nullableText,
		branch: nullableText, commit: nullableText, prUrl: nullableText, sessionInventory: opaque,
		learning: optional(learning), factoryEvaluations: optional(evaluations),
	},
	retry: task,
	prepareVerification: { ...revision, reservationId: string, replacementReason: optional(string), requestedBy: optional(string) },
	finishVerification: { ...revision, runId: string },
	cancel: { ...revision, requestId: opaque, reason: opaque, requestedBy: opaque },
	cancelVerificationRun: { ...revision, requestId: string },
	finalizeCancellation: {
		...revision, dispositions: opaque,
		verificationDisposition: optional(string), finalizationOverride: optional(nullable(object({ reason: string, attestedBy: string }))),
		sessionInventory: opaque, finalizedBy: string,
	},
	activate: revision,
	createFactoryPlan: factoryPlan,
	createEvaluationPlan: factoryPlan,
	recordHumanJudgment: {
		repositoryPath: string, expectedRevision: number, actor: string, reason: string,
		sourceRef: opaque, judgmentId: opaque, performedAt: opaque, id: string, candidateId: string,
		evaluation: reference, contractDigest: string, contextDigest: string, commit: string,
		procedureDigest: string, outcome: string, environment: string, workload: string, report: string,
	},
	syncFactory: planId,
	captureAnalysis: { repositoryPath: string, unitId: string, runId: string, expectedRevision: number, actor: string },
	factoryAction: { repositoryPath: string, action: string, input: optional(record) },
	acceptContract: {
		expectedRevision: factoryRevision, unitId: factoryIdentifier, unitRevision: positiveRevision,
		obligations: array(factoryReference), evaluations: array(factoryReference), actor: optional(string), reason: contractReason,
		rationale: optional(array(factoryReference)),
		resolutions: optional(array(closedObject({ knowledge: factoryReference, reason: string }))),
		renewalSignalIds: optional(array(factoryIdentifier)), technical: optional(technicalRenewal),
	},
	factoryInspect: {
		unitId: optional(string), candidateId: optional(string), limit: optional(number), includeRetired: optional(boolean),
		environment: optional(string), workload: optional(string), kinds: optional(array(knowledgeKind)), query: optional(string),
		relatedTo: optional(array(reference)), cursor: optional(string),
	},
	factoryExportPage: { afterRevision: optional(number), throughRevision: optional(number), throughDigest: optional(string), limit: optional(number) },
	factoryImportPage: { importId: string, page: opaque, expectedRevision: number },
	factoryAbandonImport: { importId: string, expectedRevision: number, actor: string, reason: string },
	factoryMigrate: { expectedRevision: number, actor: string, reason: string },
};

/** @template {keyof typeof requestShapes} K @typedef {Decoded<(typeof requestShapes)[K]>} Request */
/** @template {keyof typeof requestShapes} K @param {K} name @param {unknown} value @returns {Request<K>} */
export function decodeRequest(name, value) {
	if (["approve", "planApprovalDelegation"].includes(name)
		&& ["invocation", "sessionId", "toolCallId", "agentId"].some(key => key in record(value))) {
		throw new FoundryDomainError("delegation_identity_required", "Caller JSON cannot supply native invocation identity");
	}
	if (["approve", "planApprovalDelegation", "factoryAction", "acceptContract", "dispatchReady", "reconcileParallel", "materializeInputs", "assessPackage", "preparePlanRepair", "launchPlanRepair", "reconcilePlanRepair", "importPlanRepair"].includes(name)) {
		assertKnownKeys(record(value), new Set(Object.keys(requestShapes[name])), name);
	}
	return { ...record(value), ...decodeObject(requestShapes[name], value) };
}

/**
 * @typedef {{signal?: AbortSignal, invocation?: Pick<import("@github/copilot-sdk").ToolInvocation, "sessionId" | "toolCallId" | "agentId">}} OperationContext
 */
/**
 * Keep external JSON unknown while giving the implementation its decoded input.
 * @template {keyof typeof requestShapes} K
 * @template R
 * @param {K} name
 * @param {(input: Request<K>, options?: OperationContext) => R | Promise<R>} operation
 * @returns {(input: unknown, options?: OperationContext) => Promise<R>}
 */
export function requestHandler(name, operation) {
	return async (input, options) => await operation(decodeRequest(name, input), options);
}
