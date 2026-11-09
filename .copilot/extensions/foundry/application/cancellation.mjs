import { isList, isOneOf, isRecord } from "../data.mjs";
import { isTerminatedSessionState, normalizeInventory, sessionState } from "../inventory.mjs";
import { bindCancellationVerificationRun, finalizePlanCancellation, requestPlanCancellation } from "../plan/cancellation.mjs";
import { PLAN_STATUS } from "../plan/values.mjs";
import { FoundryOperationError, revisionConflict } from "./errors.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("../types/workflow.js").WorkflowAnalysisPort} WorkflowAnalysis */
/** @template {keyof typeof import("../requests.mjs").requestShapes} K @typedef {import("../requests.mjs").Request<K>} Request */

/** Find one attempt by its globally unique attempt ID. @param {FoundryPlan} plan @param {string} attemptId */
function findAttemptById(plan, attemptId) {
	for (const task of plan.tasks) {
		const attempt = task.attempts.find((candidate) => candidate.id === attemptId);
		if (attempt) return attempt;
	}
	return null;
}

/** @param {{
 * storeFor: ReturnType<typeof import("./storage.mjs").createSessionStorage>["storeFor"],
 * persist: ReturnType<typeof import("./mutation.mjs").createPlanMutations>["persist"],
 * readForMutation: ReturnType<typeof import("./mutation.mjs").createPlanMutations>["readForMutation"],
 * factory: Pick<ReturnType<typeof import("../bridge.mjs").createFactoryBridge>, "requireOwner">,
 * analysis: Pick<WorkflowAnalysis, "cancelVerificationRun" | "verificationRunIsTerminal">,
 * discoverReservedVerification: ReturnType<typeof import("./ownership.mjs").createVerificationOwnership>["discoverReservedVerification"],
 * syncFactoryPlan: ReturnType<typeof import("./repository.mjs").createRepositoryOperations>["syncFactoryPlan"],
 * }} dependencies */
export function createCancellationOperations({ storeFor, persist, readForMutation, factory, analysis, discoverReservedVerification, syncFactoryPlan }) {

	/**
	 * Requests cancellation and snapshots active external work.
	 *
	 * @param {Request<"cancel">} input
	 */
	const cancel = async ({
		planId,
		expectedRevision,
		requestId,
		reason,
		requestedBy,
	}) => {
		const plan = await storeFor().read(planId);
		factory.requireOwner(plan);
		if (plan.cancellation && plan.cancellation.requestId === requestId) {
			if (plan.cancellation.reason === reason
				&& plan.cancellation.requestedBy === requestedBy) {
				return plan;
			}
			throw new FoundryOperationError(
				"duplicate_request_id",
				`Cancellation request ${requestId} already exists with different input`,
			);
		}
		if (plan.revision !== expectedRevision) {
			throw revisionConflict(planId, expectedRevision, plan.revision);
		}
		const discovery = await discoverReservedVerification(plan, true);
		return persist(
			planId,
			expectedRevision,
			(current) => requestPlanCancellation(current, {
				requestId, reason, requestedBy,
				verificationRunId: discovery.state === "found" ? discovery.run.runId : undefined,
			}),
			"plan-cancellation-requested",
		);
	};

	/**
	 * Cancels only the verification Workflow run owned by an active cancellation.
	 *
	 * @param {Request<"cancelVerificationRun">} input
	 */
	const cancelVerificationRun = async ({
		planId,
		expectedRevision,
		requestId,
	}) => {
		let plan = await readForMutation(planId, expectedRevision);
		if (plan.status !== PLAN_STATUS.CANCELLING || plan.cancellation === null) {
			throw new FoundryOperationError(
				"invalid_plan_transition",
				`Verification cancellation cannot run while the plan is ${plan.status}`,
			);
		}
		if (plan.cancellation.requestId !== requestId) {
			throw new FoundryOperationError(
				"cancellation_request_mismatch",
				`Cancellation request ${requestId} is not active for plan ${planId}`,
				{
					expectedRequestId: plan.cancellation.requestId,
					requestId,
				},
			);
		}
		if (plan.cancellation.verificationReservationId === null) {
			return {
				planId,
				revision: plan.revision,
				requestId,
				state: "not-required",
				runId: null,
				status: null,
				alreadyTerminal: true,
				verificationDisposition: null,
			};
		}
		let runId = plan.cancellation.verificationRunId;
		if (runId === null) {
			const discovery = await discoverReservedVerification(plan, true);
			if (discovery.state === "inconclusive") {
				throw new FoundryOperationError(
					"verification_launch_indeterminate",
					"Verification launch cannot be resolved for cancellation",
					{ discovery },
				);
			}
			if (discovery.state === "absent") {
				return {
					planId,
					revision: plan.revision,
					requestId,
					state: "absent",
					runId: null,
					status: null,
					alreadyTerminal: true,
					verificationDisposition: "no-run-created",
				};
			}
			runId = discovery.run.runId;
			plan = await persist(
				planId,
				expectedRevision,
				(current) => bindCancellationVerificationRun(current, discovery.run.runId),
				"verification-cancellation-bound",
			);
		}
		const outcome = await analysis.cancelVerificationRun(runId);
		return {
			planId,
			revision: plan.revision,
			requestId,
			state: "terminated",
			runId,
			status: outcome.status,
			alreadyTerminal: outcome.alreadyTerminal,
			verificationDisposition: "run-terminated",
		};
	};

	/**
	 * Finalizes cancellation after every external action has a disposition.
	 *
	 * @param {Request<"finalizeCancellation">} input
	 */
	const finalizeCancellation = async ({
		planId,
		expectedRevision,
		dispositions,
		verificationDisposition,
		finalizationOverride,
		sessionInventory,
		finalizedBy,
	}) => {
		const plan = await readForMutation(planId, expectedRevision);
		if (verificationDisposition !== undefined && !isOneOf(verificationDisposition, ["run-terminated", "no-run-created"])) {
			throw new FoundryOperationError("invalid_cancellation_verification", "Verification disposition is invalid");
		}
		if (plan.status !== PLAN_STATUS.CANCELLING || plan.cancellation === null) {
			throw new FoundryOperationError(
				"invalid_plan_transition",
				`Cancellation cannot be finalized from ${plan.status}`,
			);
		}
		if (!isList(dispositions)) {
			throw new FoundryOperationError(
				"invalid_cancellation_dispositions",
				"Cancellation dispositions must be an array",
			);
		}
		const inventory = normalizeInventory(sessionInventory);
		if (!inventory.complete
			|| inventory.capturedAt === null
			|| Date.parse(inventory.capturedAt)
			<= Date.parse(plan.cancellation.requestedAt)) {
			throw new FoundryOperationError(
				"cancellation_inventory_incomplete",
				"Cancellation finalization requires a complete, current session inventory",
			);
		}
		for (const disposition of dispositions) {
			if (!isRecord(disposition)) throw new FoundryOperationError("invalid_cancellation_dispositions", "Cancellation dispositions must be objects");
			if (disposition.disposition !== "session-terminated") continue;
			if (typeof disposition.attemptId !== "string") throw new FoundryOperationError("invalid_cancellation_dispositions", "A cancellation disposition requires its attempt ID");
			const attempt = findAttemptById(plan, disposition.attemptId);
			const observedAt = attempt?.startedAt ?? attempt?.reservedAt;
			if (!observedAt
				|| Date.parse(inventory.capturedAt) <= Date.parse(observedAt)) {
				throw new FoundryOperationError(
					"cancellation_inventory_stale",
					`Session inventory predates attempt ${disposition.attemptId}`,
				);
			}
			const state = attempt ? sessionState(attempt, inventory) : "unknown";
			if (!isTerminatedSessionState(state) && !finalizationOverride) {
				throw new FoundryOperationError(
					"cancellation_session_not_terminated",
					`Session ${disposition.sessionId || "(unknown)"} remains ${state}`,
					{ attemptId: disposition.attemptId, state },
				);
			}
		}
		const discovery =
			plan.cancellation?.verificationReservationId
				? await discoverReservedVerification(plan, true)
				: { state: /** @type {const} */ ("absent") };
		if (discovery.state === "inconclusive" && !finalizationOverride) {
			throw new FoundryOperationError(
				"verification_launch_indeterminate",
				"Verification launch cannot be resolved for cancellation",
				{ discovery },
			);
		}
		const verificationRunId =
			plan.cancellation?.verificationRunId
			?? (discovery.state === "found" ? discovery.run.runId : null);
		let verificationTerminated = true;
		if (verificationRunId) {
			verificationTerminated = await analysis.verificationRunIsTerminal(
				verificationRunId,
			);
			if (!verificationTerminated && !finalizationOverride) {
				throw new FoundryOperationError(
					"verification_not_terminated",
					`Verification run ${verificationRunId} is still active, paused, or unobservable`,
					{ runId: verificationRunId },
				);
			}
		}
		const updated = await persist(
			planId,
			expectedRevision,
			(current) => finalizePlanCancellation(current, dispositions, {
				finalizedBy,
				verificationTerminated,
				verificationDisposition,
				verificationRunId,
				finalizationOverride,
			}),
			"plan-cancellation-finalized",
		);
		if (updated.factory?.candidateId) syncFactoryPlan(updated);
		return updated;
	};
	return { cancel, cancelVerificationRun, finalizeCancellation };
}
