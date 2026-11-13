import { assessDeterministicVerification } from "../analysis/verdicts.mjs";
import { buildVerificationInput, normalizeVerificationInput } from "../analysis/verification.mjs";
import { assertPlanId, assertString } from "../plan/fields.mjs";
import { approvePlan, transitionPlan } from "../plan/lifecycle.mjs";
import { approvalScope, sameApprovalScope, validateApprovalInstruction } from "../plan/schemas/approval.mjs";
import { LIMITS, PLAN_STATUS } from "../plan/values.mjs";
import { FoundryOperationError } from "./errors.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("../types/plan.js").ApprovalDelegation} ApprovalDelegation */
/** @typedef {Pick<import("@github/copilot-sdk").CopilotSession, "sessionId" | "workspacePath">} ApprovalSession */
/** @typedef {import("../requests.mjs").OperationContext} OperationContext */

/** @param {{
 * workspace: () => string,
 * storeFor: ReturnType<typeof import("./storage.mjs").createSessionStorage>["storeFor"],
 * readForMutation: ReturnType<typeof import("./mutation.mjs").createPlanMutations>["readForMutation"],
 * factory: Pick<ReturnType<typeof import("../bridge.mjs").createFactoryBridge>, "prompt" | "inspectPlan" | "verificationGate">,
 * getSession?: () => ApprovalSession | null | undefined,
 * }} dependencies */
export function createApprovalOperations({ workspace, storeFor, readForMutation, factory, getSession }) {
	/** @param {OperationContext} options */
	const coordinator = (options) => {
		options.signal?.throwIfAborted();
		const session = getSession?.();
		const invocation = options.invocation;
		if (!session || session.workspacePath !== workspace() || !invocation
			|| invocation.sessionId !== session.sessionId || invocation.agentId !== undefined) {
			throw new FoundryOperationError("delegation_identity_required", "Delegation requires the invoking owner session's native tool context, not a child, renderer or supplied actor");
		}
		assertString(invocation.sessionId, "invocation.sessionId", LIMITS.actor - "agent-session:".length);
		assertString(invocation.toolCallId, "invocation.toolCallId", 512);
		return invocation;
	};

	/** @param {FoundryPlan} plan */
	const checkAuthority = (plan) => {
		factory.prompt(plan, { kind: "implement" });
		if (factory.inspectPlan(plan).synchronization.pending.length) {
			throw new FoundryOperationError("factory_sync_pending", "Synchronize persisted factory receipts before delegating or approving");
		}
	};

	/** @param {ApprovalDelegation} delegation @param {ReturnType<typeof coordinator>} invocation */
	const checkOwner = (delegation, invocation) => {
		if (delegation.scope.owner !== workspace() || delegation.scope.coordinatorSessionId !== invocation.sessionId) {
			throw new FoundryOperationError("delegation_foreign", "Delegation belongs to another coordinator session");
		}
	};

	/** @param {import("../requests.mjs").Request<"planApprovalDelegation">} input @param {OperationContext} [options] */
	const planApprovalDelegation = async (input, options = {}) => {
		const invocation = coordinator(options);
		assertPlanId(input.id);
		const existing = await storeFor().getApprovalDelegation(input.id);
		if (existing) checkOwner(existing, invocation);
		if (input.action === "inspect") return existing;
		if (input.action === "revoke") {
			assertString(input.reason, "reason", LIMITS.error);
			return storeFor().revokeApprovalDelegation(input.id, workspace(), invocation.sessionId, {
				at: new Date().toISOString(), actor: `agent-session:${invocation.sessionId}`,
				toolCallId: invocation.toolCallId, reason: input.reason,
			});
		}
		if (input.action !== "grant") throw new FoundryOperationError("delegation_action", "Delegation action must be grant, inspect or revoke");
		if (!input.planId || input.expectedRevision === undefined) throw new FoundryOperationError("delegation_plan_required", "Granting requires a named plan and its exact revision");
		const plan = await readForMutation(input.planId, input.expectedRevision);
		checkAuthority(plan);
		const approvalType = input.approvalType ?? "plan";
		if (approvalType !== "plan" && approvalType !== "completion") throw new FoundryOperationError("delegation_approval_type", "Delegation is limited to initial plan approval or verified technical completion");
		const scope = approvalScope(plan, invocation.sessionId, approvalType);
		if (existing) {
			if (existing.revocation || !sameApprovalScope(existing.scope, scope)) {
				throw new FoundryOperationError("delegation_conflict", "A delegation ID cannot change scope or be reactivated after revocation");
			}
			return existing;
		}
		validateApprovalInstruction(input.authority, invocation.sessionId);
		const authority = input.authority;
		coordinator(options);
		return storeFor().createApprovalDelegation({
			id: input.id, scope, revocation: null,
			grant: {
				method: "user-instruction-attestation", grantedBy: authority.grantedBy, at: new Date().toISOString(),
				attestedBy: `agent-session:${invocation.sessionId}`, source: authority.source,
				toolCallId: invocation.toolCallId, statement: authority.instruction, planId: plan.id, planRevision: plan.revision,
			},
		});
	};

	/** @param {FoundryPlan} plan @param {ApprovalDelegation | null} delegation @param {unknown} review @param {OperationContext} options
	 * @param {import("../types/plan.js").DelegatedApprovalType} [approvalType] */
	const approveDelegated = (plan, delegation, review, options, approvalType = "plan") => {
		const invocation = coordinator(options);
		if (!delegation || delegation.revocation) throw new FoundryOperationError("delegation_unavailable", "A current recorded user delegation is required; manual approval remains available");
		checkOwner(delegation, invocation);
		if (!sameApprovalScope(delegation.scope, approvalScope(plan, invocation.sessionId, approvalType))) {
			throw new FoundryOperationError("delegation_out_of_scope", "Approval kind, project, capability revision or contract is outside the recorded delegation; historical grants are initial-plan-only");
		}
		if (approvalType === "plan" && plan.status !== PLAN_STATUS.AWAITING_APPROVAL) throw new FoundryOperationError("delegation_submitted_plan_required", "Initial approval requires a submitted execution plan");
		if (approvalType === "completion" && plan.status !== PLAN_STATUS.AWAITING_COMPLETION_APPROVAL) throw new FoundryOperationError("delegation_verified_completion_required", "Technical completion requires the post-verification awaiting-completion-approval state");
		assertString(review, "review", LIMITS.error);
		checkAuthority(plan);
		if (!plan.factory) throw new FoundryOperationError("factory_context_required", "Delegation requires a bound capability");
		const actor = `agent-session:${invocation.sessionId}`;
		const receipt = {
			delegation, planId: plan.id, planRevision: plan.revision,
			blueprintDigest: plan.factory.blueprintDigest,
			sessionId: invocation.sessionId, toolCallId: invocation.toolCallId, review,
		};
		if (approvalType === "completion") {
			const input = normalizeVerificationInput(buildVerificationInput(plan));
			const assessment = assessDeterministicVerification(input);
			if (input.inputDigest !== plan.verification.inputDigest || !assessment.hardPassed
				|| assessment.requiredEvidenceIds.some((id) => !plan.verification.evidence.includes(id))) {
				throw new FoundryOperationError("delegation_verification_mismatch", "Technical closure requires unchanged canonical delivery and complete independent passing evidence from the authoritative verification");
			}
			factory.verificationGate(plan, true);
			assertString(plan.verification.reservationId, "verification.reservationId", LIMITS.requestId);
			assertString(plan.verification.runId, "verification.runId", LIMITS.verificationRunId);
			assertString(input.verificationReport.target.commit, "verification.targetCommit", 64);
			const approved = transitionPlan(plan, PLAN_STATUS.COMPLETED, { actor });
			approved.gates.delegatedCompletion = {
				...receipt,
				verification: {
					reservationId: plan.verification.reservationId, runId: plan.verification.runId,
					inputDigest: input.inputDigest, targetCommit: input.verificationReport.target.commit,
				},
			};
			return approved;
		}
		const approved = approvePlan(plan, actor);
		approved.gates.delegatedApproval = receipt;
		return approved;
	};
	return { planApprovalDelegation, approveDelegated };
}
