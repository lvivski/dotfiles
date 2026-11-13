import { errorCode, isList, isOneOf, isRecord } from "../data.mjs";
import { stableStringify } from "../digest.mjs";
import { isTerminatedSessionState, normalizeInventory, sessionState } from "../inventory.mjs";
import { isMissingRun, TERMINAL } from "../native/guards.mjs";
import { bindCancellationVerificationRun, finalizePlanCancellation, requestPlanCancellation } from "../plan/cancellation.mjs";
import { PLAN_STATUS } from "../plan/values.mjs";
import { FOUNDRY_WORKFLOWS } from "../workflows/registry.mjs";
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
 * analysis: Pick<WorkflowAnalysis, "cancelVerificationRun" | "inspectWorkflow">,
 * discoverReservedVerification: ReturnType<typeof import("./ownership.mjs").createVerificationOwnership>["discoverReservedVerification"],
 * syncFactoryPlan: ReturnType<typeof import("./repository.mjs").createRepositoryOperations>["syncFactoryPlan"],
 * }} dependencies */
export function createCancellationOperations({ storeFor, persist, readForMutation, factory, analysis, discoverReservedVerification, syncFactoryPlan }) {

	/** @param {string} planId @param {() => Promise<FoundryPlan>} operation @param {(plan: FoundryPlan) => boolean} matches */
	const persistMatching = async (planId, operation, matches) => {
		try {
			return await operation();
		} catch (error) {
			if (errorCode(error) !== "revision_conflict") throw error;
			const latest = await storeFor().read(planId);
			factory.requireOwner(latest);
			if (matches(latest)) return latest;
			throw error;
		}
	};

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
		return persistMatching(planId, () => persist(
			planId,
			expectedRevision,
			(current) => requestPlanCancellation(current, {
				requestId, reason, requestedBy,
				verificationRunId: discovery.state === "found" ? discovery.run.runId : undefined,
			}),
			"plan-cancellation-requested",
		), latest => latest.cancellation !== null && latest.cancellation.requestId === requestId
			&& latest.cancellation.reason === reason && latest.cancellation.requestedBy === requestedBy);
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
			plan = await persistMatching(planId, () => persist(
				planId,
				expectedRevision,
				(current) => bindCancellationVerificationRun(current, discovery.run.runId),
				"verification-cancellation-bound",
			), latest => latest.status === PLAN_STATUS.CANCELLING
				&& latest.cancellation?.requestId === requestId
				&& latest.cancellation.verificationRunId === discovery.run.runId);
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
		const plan = await storeFor().read(planId);
		factory.requireOwner(plan);
		/** @param {unknown[]} entries */
		const normalizedDispositions = entries => entries.map(entry => isRecord(entry)
			? { attemptId: entry.attemptId, disposition: entry.disposition, sessionId: entry.sessionId ?? null }
			: entry).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
		/** A duplicate may arrive after the finalization transaction committed. @param {FoundryPlan} latest */
		const matches = latest => latest.status === PLAN_STATUS.CANCELLED
			&& latest.cancellation?.finalizedBy === finalizedBy
			&& latest.cancellation.verificationDisposition === (verificationDisposition ?? null)
			&& stableStringify(latest.cancellation.finalizationOverride) === stableStringify(finalizationOverride ?? null)
			&& isList(dispositions)
			&& dispositions.every(entry => isRecord(entry)
				&& Object.keys(entry).every(key => ["attemptId", "disposition", "sessionId"].includes(key)))
			&& stableStringify(normalizedDispositions(dispositions))
				=== stableStringify(normalizedDispositions(latest.cancellation.acknowledgements));
		if (matches(plan)) return plan;
		if (plan.revision !== expectedRevision) throw revisionConflict(planId, expectedRevision, plan.revision);
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
			let observed = null;
			try {
				observed = await analysis.inspectWorkflow(verificationRunId);
			} catch (error) {
				if (!isMissingRun(error)) throw error;
			}
			if (observed && (observed.runId !== verificationRunId || observed.workflowName !== FOUNDRY_WORKFLOWS.verify.meta.name)) {
				throw new FoundryOperationError("workflow_run_identity_mismatch", "Cancellation terminal observation belongs to another Workflow run");
			}
			verificationTerminated = observed !== null && TERMINAL.has(observed.status);
			if (!verificationTerminated && !finalizationOverride) {
				throw new FoundryOperationError(
					"verification_not_terminated",
					`Verification run ${verificationRunId} is still active, paused, or unobservable`,
					{ runId: verificationRunId },
				);
			}
		}
		const updated = await persistMatching(planId, () => persist(
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
		), matches);
		if (updated.factory?.candidateId) syncFactoryPlan(updated);
		return updated;
	};
	return { cancel, cancelVerificationRun, finalizeCancellation };
}
