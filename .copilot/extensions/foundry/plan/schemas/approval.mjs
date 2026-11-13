import { stableStringify } from "../../digest.mjs";
import { assertKnownKeys, assertPlainObject, assertPlanId, assertString, assertStringArray, assertTimestamp, fail } from "../fields.mjs";
import { LIMITS } from "../values.mjs";

/** @typedef {import("../../types/plan.js").ApprovalDelegation} ApprovalDelegation */
/** @typedef {import("../../types/plan.js").ApprovalScope} ApprovalScope */

/** @param {unknown} value @param {string[]} keys @param {string} label */
function record(value, keys, label) {
	assertPlainObject(value, label);
	assertKnownKeys(value, new Set(keys), label);
	return value;
}

/** @param {unknown} value @param {string} label */
function revision(value, label) {
	if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1) fail("invalid_approval_revision", `${label} must be a positive revision`);
}

/** @param {unknown} value @returns {asserts value is ApprovalScope} */
export function validateApprovalScope(value) {
	const scope = record(value, ["owner", "coordinatorSessionId", "repositoryId", "repositoryPath", "unitId", "unitRevision", "contractDigest", "approvalType", "technical"], "approval.scope");
	if (scope.approvalType !== undefined && !["plan", "completion", "technical"].includes(String(scope.approvalType))) {
		fail("invalid_approval_scope", "Unsupported delegation kind");
	}
	for (const key of ["owner", "repositoryPath"]) assertString(scope[key], `approval.scope.${key}`, LIMITS.repositoryPath);
	for (const key of ["coordinatorSessionId", "repositoryId", "unitId"]) assertString(scope[key], `approval.scope.${key}`, LIMITS.actor);
	revision(scope.unitRevision, "approval.scope.unitRevision");
	if (scope.contractDigest !== null && (typeof scope.contractDigest !== "string" || !/^[a-f0-9]{64}$/.test(scope.contractDigest))) {
		fail("invalid_approval_scope", "Delegation must pin the accepted contract digest or explicit discovery-only null");
	}
	if (scope.approvalType === "technical") {
		const technical = record(scope.technical, ["kinds", "files", "agreement"], "approval.scope.technical");
		validateTechnicalPolicy({ kinds: technical.kinds, agreement: technical.agreement });
		assertStringArray(technical.files, "approval.scope.technical.files", { maximum: 128, itemMaximum: 512 });
		if (!technical.files.length || new Set(technical.files).size !== technical.files.length) fail("invalid_approval_scope", "Technical decisions require a nonempty exact file scope");
		if (scope.contractDigest === null && technical.agreement !== null) fail("invalid_approval_scope", "Discovery-only authority cannot renew an accepted evaluator");
	} else if (scope.technical !== undefined) fail("invalid_approval_scope", "Historical plan/completion authority cannot contain technical policy");
}

/** @param {unknown} value @returns {asserts value is import("../../types/plan.js").TechnicalPolicy} */
export function validateTechnicalPolicy(value) {
	const policy = record(value, ["kinds", "agreement"], "technical policy");
	assertStringArray(policy.kinds, "technical kinds", { maximum: 2, itemMaximum: 32 });
	if (!policy.kinds.length || new Set(policy.kinds).size !== policy.kinds.length
		|| policy.kinds.some(kind => !["retry", "consumer-expectation"].includes(kind))) fail("technical_kind_unsupported", "Only bounded retry and consumer-expectation alignment are supported");
	if (policy.agreement !== null) {
		const agreement = record(policy.agreement, ["evaluation", "path", "digest"], "technical agreement");
		const evaluation = record(agreement.evaluation, ["id", "revision"], "technical evaluation");
		assertString(evaluation.id, "technical evaluation.id", 96);
		revision(evaluation.revision, "technical evaluation.revision");
		assertString(agreement.path, "technical agreement.path", 1024);
		if (typeof agreement.digest !== "string" || !/^[a-f0-9]{64}$/.test(agreement.digest)) fail("technical_agreement_required", "Pin the immutable agreement digest");
	}
	if (policy.kinds.includes("consumer-expectation") !== (policy.agreement !== null)) fail("technical_agreement_required", "Consumer alignment requires a pinned pre-existing executable agreement");
}

/** @typedef {{factory?: import("../../types/plan.js").FoundryPlan["factory"], repository: {workingDirectory: string}, tasks?: import("../../types/plan.js").FoundryTask[]}} ScopedPlan */
/** @param {ScopedPlan} plan @param {string} coordinatorSessionId
 * @param {import("../../types/plan.js").DelegatedApprovalType} [approvalType]
 * @param {import("../../types/plan.js").TechnicalPolicy} [technical] @returns {ApprovalScope} */
export function approvalScope(plan, coordinatorSessionId, approvalType = "plan", technical) {
	if (!plan.factory) fail("factory_context_required", "Plan approval delegation requires a bound capability");
	const scope = {
		owner: plan.factory.owner, coordinatorSessionId, approvalType,
		repositoryId: plan.factory.repositoryId, repositoryPath: plan.repository.workingDirectory,
		unitId: plan.factory.unitId, unitRevision: plan.factory.unitRevision,
		contractDigest: plan.factory.contractDigest,
		...(approvalType === "technical" && technical ? { technical: {
			...technical, files: [...new Set(plan.tasks?.flatMap(task => task.expectedFiles) ?? [])].sort(),
		} } : {}),
	};
	validateApprovalScope(scope);
	return scope;
}

/** @param {ApprovalScope} left @param {ApprovalScope} right */
export const sameApprovalScope = (left, right) => (
	stableStringify({ ...left, approvalType: left.approvalType ?? "plan" })
	=== stableStringify({ ...right, approvalType: right.approvalType ?? "plan" })
);

/** @param {unknown} value @param {string} coordinatorSessionId @returns {asserts value is import("../../types/plan.js").ApprovalInstructionSource} */
function validateInstructionSource(value, coordinatorSessionId) {
	assertPlainObject(value, "approval.source");
	const relayed = value.kind === "relayed-user";
	assertKnownKeys(value, new Set(["kind", "sessionId", "messageRef", "messageRevision", ...(relayed ? ["relayedBySessionId"] : [])]), "approval.source");
	if (value.kind !== "direct-user" && !relayed) fail("invalid_approval_source", "Only an explicit direct or relayed user instruction can be attested, not generated plans, child reports or inferred consent");
	assertString(value.sessionId, "approval.source.sessionId", LIMITS.sessionId);
	assertString(value.messageRef, "approval.source.messageRef", LIMITS.evidenceSource);
	if (value.messageRevision !== undefined) revision(value.messageRevision, "approval.source.messageRevision");
	if (relayed) assertString(value.relayedBySessionId, "approval.source.relayedBySessionId", LIMITS.sessionId);
	else if (value.sessionId !== coordinatorSessionId) fail("invalid_approval_source", "Direct user instruction must belong to this coordinator; record cross-session instructions as relayed");
}

/** Source fields are agent attestations, not authenticated user-message imports.
 * @param {unknown} value @param {string} coordinatorSessionId @returns {asserts value is import("../../types/plan.js").ApprovalInstruction} */
export function validateApprovalInstruction(value, coordinatorSessionId) {
	if (value === undefined || value === null) fail("delegation_instruction_required", "Record the existing explicit user instruction and its provenance; ask once only if no such instruction exists");
	const authority = record(value, ["instruction", "grantedBy", "source"], "approval.authority");
	assertString(authority.instruction, "approval.authority.instruction", 16000);
	assertString(authority.grantedBy, "approval.authority.grantedBy", LIMITS.actor);
	validateInstructionSource(authority.source, coordinatorSessionId);
}

/** @param {unknown} value @returns {asserts value is ApprovalDelegation} */
export function validateApprovalDelegation(value) {
	const delegation = record(value, ["id", "scope", "grant", "revocation"], "approval.delegation");
	assertPlanId(delegation.id);
	validateApprovalScope(delegation.scope);
	assertPlainObject(delegation.grant, "approval.grant");
	const attested = delegation.grant.method === "user-instruction-attestation";
	const grant = record(delegation.grant, ["method", "grantedBy", "at", "toolCallId", "statement", "planId", "planRevision", ...(attested ? ["attestedBy", "source"] : [])], "approval.grant");
	if (!attested && grant.method !== "native-ui-elicitation") fail("invalid_approval_grant", "Delegation requires a retained native form or explicit user-instruction attestation");
	if (!attested && ["completion", "technical"].includes(delegation.scope.approvalType ?? "plan")) fail("invalid_approval_grant", "Historical native-form grants cannot authorize completion or technical decisions");
	assertString(grant.grantedBy, "approval.grant.grantedBy", LIMITS.actor);
	assertTimestamp(grant.at, "approval.grant.at");
	assertString(grant.toolCallId, "approval.grant.toolCallId", 512);
	assertString(grant.statement, "approval.grant.statement", 16000);
	assertPlanId(grant.planId);
	revision(grant.planRevision, "approval.grant.planRevision");
	if (attested) {
		validateInstructionSource(grant.source, delegation.scope.coordinatorSessionId);
		if (grant.attestedBy !== `agent-session:${delegation.scope.coordinatorSessionId}`) fail("invalid_approval_grant", "The actual attesting owner session must be retained");
	}
	if (delegation.revocation !== null) {
		const revoked = record(delegation.revocation, ["at", "actor", "reason", "toolCallId"], "approval.revocation");
		assertTimestamp(revoked.at, "approval.revocation.at");
		assertString(revoked.actor, "approval.revocation.actor", LIMITS.actor);
		assertString(revoked.reason, "approval.revocation.reason", LIMITS.error);
		assertString(revoked.toolCallId, "approval.revocation.toolCallId", 512);
	}
}

/** @param {unknown} value
 * @param {ScopedPlan & {id: string, revision: number, gates: Record<string, unknown>, verification?: import("../../types/plan.js").Verification, targetCommit?: string | null}} plan
 * @param {import("../../types/plan.js").DelegatedApprovalType} [approvalType] */
export function validateDelegatedApproval(value, plan, approvalType = "plan") {
	if (value === undefined) return;
	const completion = approvalType === "completion";
	const label = completion ? "gates.delegatedCompletion" : "gates.delegatedApproval";
	const receipt = record(value, ["delegation", "planId", "planRevision", "blueprintDigest", "sessionId", "toolCallId", "review", ...(completion ? ["verification"] : [])], label);
	validateApprovalDelegation(receipt.delegation);
	assertPlanId(receipt.planId);
	revision(receipt.planRevision, `${label}.planRevision`);
	assertString(receipt.sessionId, `${label}.sessionId`, LIMITS.actor);
	assertString(receipt.toolCallId, `${label}.toolCallId`, 512);
	assertString(receipt.review, `${label}.review`, LIMITS.error);
	if (receipt.delegation.revocation !== null
		|| receipt.planId !== plan.id || Number(receipt.planRevision) > plan.revision
		|| receipt.blueprintDigest !== plan.factory?.blueprintDigest
		|| plan.gates[completion ? "completionApprovedBy" : "planApprovedBy"] !== `agent-session:${receipt.sessionId}`
		|| plan.gates[completion ? "completionApprovedAt" : "planApprovedAt"] === null
		|| !sameApprovalScope(receipt.delegation.scope, approvalScope(plan, receipt.sessionId, approvalType))) {
		fail("invalid_delegated_approval", "Delegated approval must retain its exact plan, coordinator, grant and authority pins");
	}
	if (completion) {
		const binding = record(receipt.verification, ["reservationId", "runId", "inputDigest", "targetCommit"], "gates.delegatedCompletion.verification");
		if (plan.verification?.status !== "passed" || stableStringify(binding) !== stableStringify({
			reservationId: plan.verification.reservationId, runId: plan.verification.runId,
			inputDigest: plan.verification.inputDigest, targetCommit: plan.targetCommit,
		})) fail("invalid_delegated_completion", "Technical closure must retain the authoritative passed verification and exact delivered target");
	}
}
