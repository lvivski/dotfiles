import { analysisInputDigest } from "../digest.mjs";
import { contractFor, same } from "../factory/records.mjs";
import { assertTechnicalLineage, renewalArtifacts, validateRenewal, validateRenewalProposal, validateTechnicalDecision } from "../factory/technical.mjs";
import { assertString } from "../plan/fields.mjs";
import { retryFailedPlan } from "../plan/lifecycle.mjs";
import { approvalScope, sameApprovalScope } from "../plan/schemas/approval.mjs";
import { LIMITS, PLAN_STATUS } from "../plan/values.mjs";
import { decodeRequest } from "../requests.mjs";
import { FoundryOperationError } from "./errors.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("../types/plan.js").ApprovalDelegation} ApprovalDelegation */
/** @typedef {import("../types/plan.js").TechnicalDecision} TechnicalDecision */
/** @typedef {import("../types/factory.js").FactorySnapshot} FactorySnapshot */
/** @typedef {import("../requests.mjs").OperationContext} OperationContext */
/** @typedef {ReturnType<typeof import("./approval.mjs").createApprovalOperations>} ApprovalOperations */
/** @typedef {import("../requests.mjs").Request<"acceptContract">} RenewalRequest */

/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) { throw new FoundryOperationError(code, message); }

/** @param {FactorySnapshot} state @param {number} revision */
function requireRevision(state, revision) {
	if (state.revision !== revision) fail("revision_conflict", "Repository authority changed; read the current plan and factory before retrying");
}

/** @param {Omit<TechnicalDecision, "digest">} payload @returns {TechnicalDecision} */
function decisionReceipt(payload) {
	const decision = { ...payload, digest: analysisInputDigest(payload) };
	validateTechnicalDecision(decision);
	return decision;
}

/** @param {{
 * workspace: () => string,
 * storeFor: ReturnType<typeof import("./storage.mjs").createSessionStorage>["storeFor"],
 * readForMutation: ReturnType<typeof import("./mutation.mjs").createPlanMutations>["readForMutation"],
 * persist: ReturnType<typeof import("./mutation.mjs").createPlanMutations>["persist"],
 * factory: Pick<ReturnType<typeof import("../bridge.mjs").createFactoryBridge>, "factoryFor" | "prompt" | "inspectPlan" | "requireRetry">,
 * syncFactoryPlan: ReturnType<typeof import("./repository.mjs").createRepositoryOperations>["syncFactoryPlan"],
 * coordinator: ApprovalOperations["coordinator"],
 * checkOwner: ApprovalOperations["checkOwner"],
 * checkAuthority: ApprovalOperations["checkAuthority"],
 * executeTechnical?: import("../types/factory.js").TechnicalExecutor,
 * }} dependencies */
export function createTechnicalOperations({
	workspace, storeFor, readForMutation, persist, factory, syncFactoryPlan,
	coordinator, checkOwner, checkAuthority, executeTechnical,
}) {
	/** @param {FoundryPlan} plan @param {ApprovalDelegation} delegation
	 * @param {ReturnType<ApprovalOperations["coordinator"]>} invocation */
	function checkScope(plan, delegation, invocation) {
		checkOwner(delegation, invocation);
		if (delegation.scope.approvalType !== "technical" || !delegation.scope.technical) {
			fail("delegation_out_of_scope", "Historical plan/completion grants cannot authorize technical decisions");
		}
		const derived = approvalScope(plan, invocation.sessionId, "technical", delegation.scope.technical);
		if (!sameApprovalScope(delegation.scope, { ...derived, contractDigest: delegation.scope.contractDigest })) {
			fail("delegation_out_of_scope", "Technical authority requires the exact owner, repository path, capability revision and file scope");
		}
		return derived;
	}

	/** @param {FoundryPlan} plan @param {ApprovalDelegation | null} delegation
	 * @param {ReturnType<ApprovalOperations["coordinator"]>} invocation
	 * @param {TechnicalDecision["kind"]} kind @param {FactorySnapshot} state */
	function authorize(plan, delegation, invocation, kind, state) {
		if (!delegation || delegation.revocation) fail("delegation_unavailable", "A current explicit technical delegation is required");
		const scope = checkScope(plan, delegation, invocation);
		if (!scope.technical?.kinds.includes(kind)) fail("delegation_out_of_scope", "This technical decision kind was not explicitly delegated");
		if (plan.factory?.owner !== workspace() || state.repository.id !== scope.repositoryId) {
			fail("delegation_foreign", "The current owner and repository must match the recorded technical scope");
		}
		assertTechnicalLineage(state, delegation.scope, scope.contractDigest);
		checkAuthority(plan);
		return delegation;
	}

	/** Called only inside the plan writer, with its transactionally re-read grant.
	 * @param {FoundryPlan} plan @param {ApprovalDelegation | null} delegation
	 * @param {import("../requests.mjs").Request<"approve">} rawInput
	 * @param {OperationContext} [options] @returns {FoundryPlan} */
	function approveTechnical(plan, delegation, rawInput, options = {}) {
		factory.requireRetry(plan);
		const invocation = coordinator(options);
		const input = decodeRequest("approve", rawInput);
		if (input.approvalType !== "retry" || !input.technical || !input.delegationId
			|| input.approvedBy !== undefined || input.planId !== plan.id || input.expectedRevision !== plan.revision) {
			fail("delegation_approval_type", "Technical retry requires the exact failed plan revision, technical decision and native attribution");
		}
		if (input.retryStatus !== undefined && input.retryStatus !== PLAN_STATUS.RUNNING) fail("invalid_retry_status", "Failed plans retry directly to running");
		if (plan.factory?.candidateId !== null || plan.evaluationTarget
			|| plan.status !== PLAN_STATUS.FAILED || plan.verification.status !== "failed") {
			fail("technical_retry_unsupported", "Technical retry is limited to failed discovery verification, never delivered or sealed candidates");
		}
		assertString(input.review, "review");
		const state = factory.factoryFor(plan.repository.workingDirectory).snapshot();
		const grant = authorize(plan, delegation, invocation, "retry", state);
		if (grant.id !== input.delegationId) fail("delegation_out_of_scope", "Retry must use the exact recorded grant");
		if (plan.technicalDecisions?.some(entry => entry.id === input.technical?.id)) {
			fail("technical_decision_conflict", "A technical decision ID cannot be reused for another correction");
		}
		const decision = decisionReceipt({
			id: input.technical.id, kind: "retry", delegation: structuredClone(grant),
			planId: plan.id, planRevision: plan.revision, blueprintDigest: plan.factory.blueprintDigest,
			sessionId: invocation.sessionId, toolCallId: invocation.toolCallId, at: new Date().toISOString(),
			reason: input.review, failures: [...input.technical.failures],
			factoryRevision: state.revision, contractDigest: plan.factory.contractDigest,
			oldScope: [...(grant.scope.technical?.files ?? [])], newScope: [...(grant.scope.technical?.files ?? [])],
			verification: structuredClone(plan.verification), renewal: null,
		});
		const updated = retryFailedPlan(plan, `agent-session:${invocation.sessionId}`);
		updated.technicalDecisions = [...(plan.technicalDecisions ?? []), decision];
		return updated;
	}

	/** @param {RenewalRequest} input @param {string} actor
	 * @param {import("../types/factory.js").TechnicalRenewal["publication"]} defaults */
	function publication(input, actor, defaults) {
		return {
			unitId: input.unitId, unitRevision: input.unitRevision,
			obligations: input.obligations, evaluations: input.evaluations,
			rationale: input.rationale ?? defaults.rationale,
			resolutions: input.resolutions ?? defaults.resolutions,
			renewalSignalIds: input.renewalSignalIds ?? defaults.renewalSignalIds,
			actor, reason: input.reason,
		};
	}

	/** @param {FoundryPlan} plan @param {TechnicalDecision} receipt */
	function publishedResult(plan, receipt) {
		const service = factory.factoryFor(plan.repository.workingDirectory);
		let state = service.snapshot();
		/** @param {FactorySnapshot} snapshot */
		const findDecision = snapshot => snapshot.decisions.find(entry => entry.kind === "accept-contract"
			&& entry.technical?.id === receipt.id && same(entry.technical, receipt));
		let decision = findDecision(state);
		let contract = state.contracts.find(entry => entry.decisionId === decision?.id);
		if (decision?.kind === "accept-contract" && contract) return { repository: state.repository, revision: state.revision, contract, decision };
		storeFor().requireTechnicalAuthorization(plan.id, receipt.id, receipt.digest);
		syncFactoryPlan(plan);
		state = service.snapshot();
		decision = findDecision(state);
		contract = state.contracts.find(entry => entry.decisionId === decision?.id);
		if (!decision || decision.kind !== "accept-contract" || !contract) {
			fail("factory_sync_pending", "The immutable technical decision is persisted but its matching publication is pending");
		}
		return { repository: state.repository, revision: state.revision, contract, decision };
	}

	/** @param {{repositoryPath: string, input: Record<string, unknown>}} request
	 * @param {OperationContext} [options]
	 * @returns {Promise<import("../types/factory.js").FactoryMutationResult<"acceptContract">>} */
	async function renewContract({ repositoryPath, input: rawInput }, options = {}) {
		const initial = coordinator(options);
		const identity = { sessionId: initial.sessionId, toolCallId: initial.toolCallId };
		const currentInvocation = () => {
			const current = coordinator(options);
			if (current.sessionId !== identity.sessionId || current.toolCallId !== identity.toolCallId) {
				fail("delegation_identity_required", "Native invocation identity changed during technical execution");
			}
			return current;
		};
		const input = decodeRequest("acceptContract", rawInput);
		const technical = input.technical;
		if (!technical || input.actor !== undefined) fail("delegation_approval_type", "Technical renewal requires native actor attribution; omit caller actor and receipts");
		const plan = await readForMutation(technical.planId, technical.expectedPlanRevision);
		if (repositoryPath !== plan.repository.workingDirectory) fail("delegation_out_of_scope", "Renewal must use the exact owner-local repository path");
		const service = factory.factoryFor(repositoryPath);
		let state = service.snapshot();
		requireRevision(state, input.expectedRevision);
		const invocation = currentInvocation();
		const existing = plan.technicalDecisions?.find(entry => entry.id === technical.id);
		if (existing) {
			validateTechnicalDecision(existing);
			checkScope(plan, existing.delegation, invocation);
			factory.inspectPlan(plan);
			if (existing.kind !== "consumer-expectation" || !existing.renewal
				|| existing.planId !== plan.id || existing.blueprintDigest !== plan.factory?.blueprintDigest
				|| existing.delegation.id !== technical.delegationId || !same(existing.failures, technical.failures)
				|| !same(existing.renewal.previous, technical.previous) || !same(existing.renewal.next, technical.next)
				|| !same(existing.renewal.publication, publication(input, `agent-session:${invocation.sessionId}`, existing.renewal.publication))) {
				fail("technical_decision_conflict", "A recorded technical decision can only replay its exact historical publication");
			}
			return publishedResult(plan, existing);
		}
		const stored = await storeFor().getApprovalDelegation(technical.delegationId);
		state = service.snapshot();
		requireRevision(state, input.expectedRevision);
		const grant = authorize(plan, stored, currentInvocation(), "consumer-expectation", state);
		const previous = contractFor(state, input.unitId);
		if (previous.digest !== plan.factory?.contractDigest || !grant.scope.technical?.agreement) {
			fail("technical_contract_changed", "Renewal requires the plan's exact current accepted contract");
		}
		const priorDecision = state.decisions.find(entry => entry.id === previous.decisionId);
		if (priorDecision?.kind !== "accept-contract") fail("technical_contract_changed", "The previous accepted decision is unavailable");
		const published = publication(input, `agent-session:${invocation.sessionId}`, {
			unitId: previous.unitId, unitRevision: previous.unitRevision, obligations: previous.obligations,
			evaluations: previous.evaluations, rationale: previous.rationale, resolutions: priorDecision.resolutions,
			renewalSignalIds: priorDecision.renewalSignalIds ?? [], actor: priorDecision.actor, reason: priorDecision.reason,
		});
		const artifacts = renewalArtifacts(repositoryPath, state, grant.scope, technical.previous, technical.next);
		const renewal = {
			previous: technical.previous, next: technical.next, agreement: artifacts.agreement,
			before: artifacts.before, after: artifacts.after, publication: published,
		};
		validateRenewalProposal(state, {
			scope: grant.scope, contractDigest: previous.digest, sessionId: invocation.sessionId,
			reason: input.reason, renewal,
		});
		if (!executeTechnical) fail("technical_execution_unavailable", "Trusted evaluator execution is unavailable; native resource permission is a separate gate");
		currentInvocation();
		const execution = await executeTechnical({
			repositoryPath, before: artifacts.bundles.before, after: artifacts.bundles.after, agreement: artifacts.agreement,
		}, options.signal);
		currentInvocation();
		const updated = await persist(plan.id, plan.revision, (current, delegation) => {
			const native = currentInvocation();
			const fresh = service.snapshot();
			requireRevision(fresh, input.expectedRevision);
			const retained = authorize(current, delegation, native, "consumer-expectation", fresh);
			if (!same(retained, grant)) fail("delegation_unavailable", "The explicit technical delegation changed during execution");
			if (current.technicalDecisions?.some(entry => entry.id === technical.id)) fail("technical_decision_conflict", "Technical decision ID already exists");
			const decision = decisionReceipt({
				id: technical.id, kind: "consumer-expectation", delegation: structuredClone(retained),
				planId: current.id, planRevision: current.revision, blueprintDigest: current.factory?.blueprintDigest ?? "",
				sessionId: native.sessionId, toolCallId: native.toolCallId, at: new Date().toISOString(),
				reason: input.reason, failures: [...technical.failures], factoryRevision: fresh.revision,
				contractDigest: previous.digest, oldScope: [...(retained.scope.technical?.files ?? [])],
				newScope: [...(retained.scope.technical?.files ?? [])], verification: null,
				renewal: { ...renewal, execution },
			});
			validateRenewal(fresh, decision);
			return { ...current, technicalDecisions: [...(current.technicalDecisions ?? []), decision] };
		}, "contract-renewal-authorized:technical", { delegationId: technical.delegationId });
		const receipt = updated.technicalDecisions?.find(entry => entry.id === technical.id);
		if (!receipt) fail("technical_decision_conflict", "The technical authorization receipt was not persisted");
		return publishedResult(updated, receipt);
	}
	return { approveTechnical, renewContract };
}
