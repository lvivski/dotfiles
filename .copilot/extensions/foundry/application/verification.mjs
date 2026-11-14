import { LIMITS, PLAN_STATUS, VERIFICATION_STATUS } from "../plan/values.mjs";
import { bindVerificationRun, completeVerification, reserveVerification } from "../plan/verification.mjs";
import { FoundryOperationError, revisionConflict } from "./errors.mjs";

/** @typedef {import("../types/workflow.js").WorkflowAnalysisPort} WorkflowAnalysis */
/** @typedef {import("../types/workflow.js").WorkflowDiscovery} Discovery */
/** @template {keyof typeof import("../requests.mjs").requestShapes} K @typedef {import("../requests.mjs").Request<K>} Request */

const TERMINAL_WORKFLOW_STATUSES = new Set([
	"completed",
	"error",
	"halted",
	"cancelled",
]);

/** @param {{
 * storeFor: ReturnType<typeof import("./storage.mjs").createSessionStorage>["storeFor"],
 * persist: ReturnType<typeof import("./mutation.mjs").createPlanMutations>["persist"],
 * readForMutation: ReturnType<typeof import("./mutation.mjs").createPlanMutations>["readForMutation"],
 * factory: Pick<ReturnType<typeof import("../bridge.mjs").createFactoryBridge>, "requireOwner" | "sync" | "verificationGate" | "verificationContext">,
 * analysis: Pick<WorkflowAnalysis, "prepareVerification" | "assessVerificationRun" | "importVerification">,
 * discoverReservedVerification: ReturnType<typeof import("./ownership.mjs").createVerificationOwnership>["discoverReservedVerification"],
 * assertVerificationRun: ReturnType<typeof import("./ownership.mjs").createVerificationOwnership>["assertVerificationRun"],
 * syncFactoryPlan: ReturnType<typeof import("./repository.mjs").createRepositoryOperations>["syncFactoryPlan"],
 * }} dependencies */
export function createVerificationOperations({ storeFor, persist, readForMutation, factory, analysis, discoverReservedVerification, assertVerificationRun, syncFactoryPlan }) {

	/**
	 * Persists a verification launch reservation before returning a run spec.
	 *
	 * @param {Request<"prepareVerification">} input
	 */
	const prepareVerification = async ({
		planId,
		expectedRevision,
		reservationId,
		replacementReason,
		requestedBy,
	}) => {
		const plan = await storeFor().read(planId);
		factory.requireOwner(plan);
		factory.sync(plan);
		if (plan.status !== PLAN_STATUS.RUNNING) {
			throw new FoundryOperationError(
				"invalid_plan_transition",
				`Verification can only be prepared from running, not ${plan.status}`,
			);
		}
		if (plan.verification.reservationId === reservationId
			&& plan.verification.status === VERIFICATION_STATUS.RESERVED) {
			const prepared = await analysis.prepareVerification(structuredClone(plan), reservationId);
			if (prepared.inputDigest !== plan.verification.inputDigest) {
				throw new FoundryOperationError(
					"verification_input_mismatch",
					"Reserved verification input changed",
				);
			}
			const discovery = await discoverReservedVerification(plan);
			if (discovery.state === "inconclusive") {
				throw new FoundryOperationError(
					"verification_launch_indeterminate",
					"Verification launch cannot be established; do not launch or replace it until ownership is observable",
					{ discovery },
				);
			}
			const bound = discovery.state === "found" && plan.verification.runId === null
				? await persist(planId, plan.revision,
					(current) => bindVerificationRun(current, discovery.run.runId), "verification-bound")
				: plan;
			return discovery.state === "found"
				? {
					plan: bound,
					reservationId,
					...prepared,
					runId: discovery.run.runId,
					launchSpec: null,
				}
				: { plan, reservationId, ...prepared };
		}
		if (plan.verification.reservationId === reservationId) {
			throw new FoundryOperationError(
				"duplicate_request_id",
				`Verification reservation ${reservationId} is already bound or terminal`,
			);
		}
		if (plan.revision !== expectedRevision) {
			throw revisionConflict(planId, expectedRevision, plan.revision);
		}
		/** @type {null | {
		 *   supersededReservationId: string,
		 *   supersededRunId: string | null,
		 *   reason: string,
		 *   requestedBy: string
		 * }} */
		let replacement = null;
		if (plan.verification.status === VERIFICATION_STATUS.RESERVED) {
			if (!plan.verification.reservationId) throw new FoundryOperationError("workflow_reservation_invalid", "Reserved verification requires its identity");
			if (
				typeof replacementReason !== "string"
				|| !replacementReason.trim()
				|| typeof requestedBy !== "string"
				|| !requestedBy.trim()
			) {
				throw new FoundryOperationError(
					"verification_replacement_requires_approval",
					"Replacing a verification reservation requires reason and actor",
				);
			}
			const discovery = await discoverReservedVerification(plan, true);
			if (
				discovery.state === "inconclusive"
				&& Array.isArray(discovery.candidates)
				&& discovery.candidates.length > 1
			) {
				throw new FoundryOperationError(
					"verification_duplicate_runs",
					"Multiple Workflow runs carry the same verification reservation",
					{ discovery },
				);
			}
			const activeCandidate = discovery.state === "inconclusive"
				&& Array.isArray(discovery.candidates)
				? discovery.candidates.find(
					(candidate) => typeof candidate.status !== "string" || !TERMINAL_WORKFLOW_STATUSES.has(candidate.status),
				)
				: null;
			if (activeCandidate) {
				throw new FoundryOperationError(
					"verification_already_reserved",
					`Verification run ${activeCandidate.runId} may still be active or paused`,
					{ discovery },
				);
			}
			if (discovery.state !== "found") {
				throw new FoundryOperationError(
					"verification_launch_indeterminate",
					"Replacing verification requires an identified terminal run, not missing or inconclusive evidence",
					{ discovery },
				);
			}
			if (plan.verification.runId !== null && plan.verification.runId !== discovery.run.runId) {
				throw new FoundryOperationError("verification_run_mismatch", "Discovery disagrees with bound verification");
			}
			const assessment = await analysis.assessVerificationRun(discovery.run.runId, plan);
			if (assessment.state === "active" || assessment.state === "paused") {
				throw new FoundryOperationError(
					"verification_already_reserved",
					`Verification run ${discovery.run.runId} is ${assessment.state}; inspect or cancel it first`,
				);
			}
			if (assessment.state === "importable") {
				throw new FoundryOperationError(
					"verification_result_available",
					`Verification run ${discovery.run.runId} must be imported`,
				);
			}
			if (typeof discovery.run.status !== "string" || !TERMINAL_WORKFLOW_STATUSES.has(discovery.run.status)) {
				throw new FoundryOperationError("verification_launch_indeterminate", "The previous verification run is not conclusively terminal");
			}
			replacement = {
				supersededReservationId: plan.verification.reservationId,
				supersededRunId: discovery.run.runId,
				reason: replacementReason,
				requestedBy,
			};
		}
		factory.verificationGate(plan);
		const frozenContext = structuredClone(factory.verificationContext(plan));
		const prepared = await analysis.prepareVerification(structuredClone({ ...plan, factoryVerification: frozenContext }), reservationId);
		const updated = await persist(
			planId,
			expectedRevision,
			(current) => reserveVerification({ ...current, factoryVerification: structuredClone(frozenContext) }, {
				reservationId,
				inputDigest: prepared.inputDigest,
				replacement: replacement ?? undefined,
			}),
			plan.verification.status === VERIFICATION_STATUS.RESERVED
				? "verification-replaced"
				: "verification-reserved",
		);
		return { plan: updated, reservationId, ...prepared };
	};

	/**
	 * Imports the exact terminal result for the active verification reservation.
	 *
	 * @param {Request<"finishVerification">} input
	 * @param {{signal?: AbortSignal}} [options]
	 */
	const finishVerification = async ({
		planId,
		expectedRevision,
		runId,
	}, { signal } = {}) => {
		let plan = await readForMutation(planId, expectedRevision);
		if (plan.verification.status !== VERIFICATION_STATUS.RESERVED) {
			throw new FoundryOperationError(
				"verification_not_reserved",
				`Plan ${planId} has no active verification reservation`,
			);
		}
		signal?.throwIfAborted();
		await assertVerificationRun(plan, runId, true);
		if (plan.verification.runId === null) {
			plan = await persist(planId, expectedRevision, (current) => {
				signal?.throwIfAborted();
				return bindVerificationRun(current, runId);
			}, "verification-bound");
			expectedRevision = plan.revision;
		}
		const inspected = await analysis.importVerification(runId, plan, { signal });
		plan = await readForMutation(planId, expectedRevision);
		await assertVerificationRun(plan, runId, true);
		signal?.throwIfAborted();
		if ("state" in inspected) return { ...inspected, planId, revision: plan.revision };
		const result = inspected.result;
		if (result.passed) factory.verificationGate(plan, true);
		const updated = await persist(
			planId,
			expectedRevision,
			(current) => {
				signal?.throwIfAborted();
				return completeVerification(current, result, {
					runId,
					at: typeof inspected.detail.completedAt === "number" && Number.isFinite(inspected.detail.completedAt) ? inspected.detail.completedAt : undefined,
				});
			},
			result.passed ? "verification-passed" : "verification-failed",
		);
		syncFactoryPlan(updated);
		return updated;
	};
	return { prepareVerification, finishVerification };
}
