import { FoundryAnalysisError } from "../errors.mjs";
import { validateVerificationResult } from "../analysis/verdicts.mjs";
import { buildVerificationInput } from "../analysis/verification.mjs";
import { FOUNDRY_WORKFLOWS } from "../workflows/registry.mjs";
import { fail, FoundryWorkflowError, isMissingRun, TERMINAL } from "./guards.mjs";
import { pendingWorkflow } from "./reader.mjs";

/** @param {{
 * api: ReturnType<typeof import("./reader.mjs").createRunReader>["api"],
 * loadRun: ReturnType<typeof import("./reader.mjs").createRunReader>["loadRun"],
 * settleRun: ReturnType<typeof import("./reader.mjs").createRunReader>["settleRun"],
 * readReservationIdentity: ReturnType<typeof import("./discovery.mjs").createReservationDiscovery>["readReservationIdentity"],
 * }} dependencies */
export function createVerificationWorkflow({ api, loadRun, settleRun, readReservationIdentity }) {

	/** Build the exact native verification Workflow invocation.
	 * @param {import("../types/plan.js").FoundryPlan} plan @param {string} reservationId */
	const prepareVerification = async (plan, reservationId) => {
		const canonicalInput = buildVerificationInput(plan);
		const args = { ...canonicalInput, reservationId };
		const specification = FOUNDRY_WORKFLOWS.verify;
		return {
			workflow: specification.meta.name,
			inputDigest: canonicalInput.inputDigest,
			launchSpec: {
				name: specification.meta.name,
				args,
			},
		};
	};

	/**
	 * @param {string} runId
	 * @param {import("../types/plan.js").FoundryPlan} plan
	 * @param {{signal?: AbortSignal, wait?: boolean}} [options]
	 */
	const importVerification = async (runId, plan, options = {}) => {
		options.signal?.throwIfAborted();
		const { run, detail } = await loadRun(runId, FOUNDRY_WORKFLOWS.verify);
		const expectedArgs = buildVerificationInput(plan);
		const reservationId = String(plan.verification.reservationId || "");
		const reservedAt = Date.parse(String(plan.verification.reservedAt || ""));
		if (!reservationId || !Number.isFinite(reservedAt)) {
			fail(
				"workflow_reservation_invalid",
				"Verification inspection requires its reservation identity and timestamp",
			);
		}
		if (plan.verification.runId && plan.verification.runId !== runId) {
			fail(
				"workflow_run_identity_mismatch",
				`Verification reservation ${reservationId} is bound to another run`,
				{ runId, expectedRunId: plan.verification.runId },
			);
		}
		if (Number.isFinite(detail.createdAt) && detail.createdAt < reservedAt) {
			fail(
				"workflow_run_identity_mismatch",
				`Workflow run ${runId} predates verification reservation ${reservationId}`,
				{ runId, reservationId, createdAt: detail.createdAt, reservedAt },
			);
		}
		if (run.status !== "completed") {
			const identity = await readReservationIdentity(runId, detail);
			if (identity.state !== "readable") {
				fail(
					"workflow_progress_inconclusive",
					`Workflow run ${runId} progress cannot establish reservation identity`,
					{ runId, reservationId, reason: identity.reason },
				);
			}
			if (!identity.reservationIds.includes(reservationId)) {
				fail(
					"workflow_run_identity_mismatch",
					`Workflow run ${runId} does not carry verification reservation ${reservationId}`,
					{ runId, reservationId },
				);
			}
		}
		options.signal?.throwIfAborted();
		const pending = pendingWorkflow(run, detail);
		if (pending) return pending;
		const settled = await settleRun(runId, FOUNDRY_WORKFLOWS.verify, { run, detail }, options);
		const result = validateVerificationResult(
			settled.run.result,
			expectedArgs,
			reservationId,
		);
		return {
			...settled,
			result,
		};
	};

	/** Classify whether one discovered verification run can be superseded.
	 * @param {string} runId @param {import("../types/plan.js").FoundryPlan} plan */
	const assessVerificationRun = async (runId, plan) => {
		const run = await api().getRun(runId);
		if (run.status === "paused") return { state: /** @type {const} */ ("paused"), run };
		if (!TERMINAL.has(run.status)) return { state: /** @type {const} */ ("active"), run };
		if (run.status !== "completed") {
			return { state: /** @type {const} */ ("terminal-nonimportable"), run };
		}
		try {
			const imported = await importVerification(runId, plan, { wait: false });
			return { state: /** @type {const} */ ("importable"), run, imported };
		} catch (error) {
			if (
				error instanceof FoundryAnalysisError
				|| (error instanceof FoundryWorkflowError
					&& [
						"workflow_input_missing",
						"workflow_input_mismatch",
						"workflow_result_invalid",
						"workflow_result_unavailable",
						"workflow_run_identity_mismatch",
					].includes(error.code))
			) {
				return {
					state: /** @type {const} */ ("terminal-nonimportable"),
					run,
					reason: error instanceof Error ? error.message : String(error),
				};
			}
			throw error;
		}
	};

	/** Observe whether a verification Workflow run is terminal. @param {string} runId */
	const verificationRunIsTerminal = async (runId) => {
		try {
			const run = await api().getRun(runId);
			return TERMINAL.has(run.status);
		} catch (error) {
			if (isMissingRun(error)) return false;
			throw error;
		}
	};

	/** Cancel the exact Foundry verification run and observe a terminal envelope. @param {string} runId */
	const cancelVerificationRun = async (runId) => {
		const { run } = await loadRun(runId, FOUNDRY_WORKFLOWS.verify);
		if (TERMINAL.has(run.status)) {
			return {
				runId,
				status: run.status,
				alreadyTerminal: true,
			};
		}
		const workflowApi = api();
		if (typeof workflowApi.cancel !== "function") {
			fail(
				"workflow_backend_unavailable",
				"Foundry requires the native Workflow cancellation API",
			);
		}
		let settled;
		try {
			settled = await workflowApi.cancel(runId);
		} catch (error) {
			fail(
				"workflow_cancel_failed",
				error instanceof Error ? error.message : String(error),
				{ runId },
			);
		}
		if (!TERMINAL.has(settled?.status)) {
			fail(
				"workflow_cancel_incomplete",
				`Workflow run ${runId} did not reach a terminal state`,
				{ runId, status: settled?.status ?? null },
			);
		}
		if (settled.runId !== runId) {
			fail(
				"workflow_run_identity_mismatch",
				`Workflow cancellation returned a different run than ${runId}`,
				{ runId, actualRunId: settled.runId },
			);
		}
		return {
			runId,
			status: settled.status,
			alreadyTerminal: false,
		};
	};
	return { prepareVerification, importVerification, assessVerificationRun, verificationRunIsTerminal, cancelVerificationRun };
}
