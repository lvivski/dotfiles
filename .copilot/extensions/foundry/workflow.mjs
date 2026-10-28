/** @module workflow — Foundry control-plane adapters and registered native Dynamic Workflows. */
import {
	FoundryAnalysisError,
	buildPlanningArgs,
	buildVerificationInput,
	validatePlanningArgs,
	validatePlanningResult,
	validateVerificationResult,
} from "./analysis.mjs";
import { meta as auditMeta, run as runAudit } from "./workflows/audit.mjs";
import { meta as deepResearchMeta, run as runDeepResearch } from "./workflows/deep-research.mjs";
import { meta as planMeta, run as runPlan } from "./workflows/plan.mjs";
import { meta as reviewQueueMeta, run as runReviewQueue } from "./workflows/review-queue.mjs";
import { meta as securityReviewMeta, run as runSecurityReview } from "./workflows/security-review.mjs";
import { meta as triageMeta, run as runTriage } from "./workflows/triage.mjs";
import { meta as verifyMeta, run as runVerify } from "./workflows/verify.mjs";
import { parseVerificationMarker } from "./marker.mjs";

/** Native Workflow definitions registered by the Foundry control plane. */
export const FOUNDRY_WORKFLOWS = Object.freeze({
	audit: Object.freeze({ meta: auditMeta, run: runAudit }),
	deepResearch: Object.freeze({ meta: deepResearchMeta, run: runDeepResearch }),
	plan: Object.freeze({ meta: planMeta, run: runPlan }),
	reviewQueue: Object.freeze({ meta: reviewQueueMeta, run: runReviewQueue }),
	securityReview: Object.freeze({ meta: securityReviewMeta, run: runSecurityReview }),
	triage: Object.freeze({ meta: triageMeta, run: runTriage }),
	verify: Object.freeze({ meta: verifyMeta, run: runVerify }),
});

// Paused runs retain their reservation and are not cancellation evidence.
const TERMINAL = new Set(["completed", "error", "halted", "cancelled"]);
const RUN_DISCOVERY_PAGE_SIZE = 200;
const RUN_DISCOVERY_MAX_PAGES = 10;

/**
 * @typedef {Pick<import("@github/copilot-sdk").SessionWorkflowApi,
 *   "getRun" | "getRunDetail" | "getRunProgress" | "listRuns">
 *   & Partial<Pick<import("@github/copilot-sdk").SessionWorkflowApi,
 *     "cancel" | "pause" | "resume" | "waitForRun">>} WorkflowInspectionApi
 */

/** @param {unknown} value @returns {value is WorkflowInspectionApi} */
function hasInspectionApi(value) {
	return typeof value === "object" && value !== null
		&& "getRun" in value && typeof value.getRun === "function"
		&& "getRunDetail" in value && typeof value.getRunDetail === "function"
		&& "getRunProgress" in value && typeof value.getRunProgress === "function"
		&& "listRuns" in value && typeof value.listRuns === "function";
}

/** Typed failure raised when a native Workflow run cannot satisfy Foundry invariants. */
export class FoundryWorkflowError extends Error {
	/** @param {string} code @param {string} message @param {unknown} [details] */
	constructor(code, message, details = null) {
		super(message);
		this.name = "FoundryWorkflowError";
		this.code = code;
		this.details = details;
	}
}

/**
 * @param {string} code
 * @param {string} message
 * @param {unknown} [details]
 * @returns {never}
 */
function fail(code, message, details) {
	throw new FoundryWorkflowError(code, message, details);
}

/**
 * Native pause/resume have no AbortSignal option; interrupt only the caller's wait.
 * @param {Promise<import("@github/copilot-sdk").WorkflowRunResult>} pending
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<import("@github/copilot-sdk").WorkflowRunResult>}
 */
function waitForControl(pending, signal) {
	if (!signal) return pending;
	return new Promise((resolve, reject) => {
		const aborted = () => reject(signal.reason);
		signal.addEventListener("abort", aborted, { once: true });
		if (signal.aborted) aborted();
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
	});
}

/** @param {any} error */
function isMissingRun(error) {
	const codes = [
		error?.code,
		error?.data?.code,
		error?.cause?.code,
		error?.cause?.data?.code,
	].filter((value) => typeof value === "string");
	if (codes.some((code) => code === "workflow_run_not_found" || code === "not_found")) {
		return true;
	}
	return /\b(?:workflow )?run\b.*\bnot found\b/i.test(error?.message ?? String(error));
}

/**
 * Build the Foundry analysis boundary over the current session's native Workflow API.
 * @param {() => unknown} getWorkflowApi
 */
export function createWorkflowAnalysis(getWorkflowApi) {
	if (typeof getWorkflowApi !== "function") {
		throw new TypeError("createWorkflowAnalysis requires getWorkflowApi");
	}
	/** Resolve the current session's Workflow API or fail closed. */
	const api = () => {
		const value = getWorkflowApi();
		if (!hasInspectionApi(value)) {
			fail(
				"workflow_backend_unavailable",
				"Foundry requires native Workflow run inspection APIs",
			);
		}
		return value;
	};

	/** @param {string} runId @param {Pick<import("@github/copilot-sdk").WorkflowHandle, "meta">} specification */
	const loadRun = async (runId, specification) => {
		let run;
		let detail;
		try {
			[run, detail] = await Promise.all([
				api().getRun(runId),
				api().getRunDetail(runId),
			]);
		} catch (error) {
			if (
				error instanceof FoundryWorkflowError &&
				error.code === "workflow_backend_unavailable"
			) {
				throw error;
			}
			const message = error?.message ?? String(error);
			fail(
				isMissingRun(error)
					? "workflow_run_not_found"
					: "workflow_run_invalid",
				message,
				{ runId },
			);
		}
		if (detail.workflowName !== specification.meta.name) {
			fail(
				"workflow_run_identity_mismatch",
				`Workflow run ${runId} belongs to ${detail.workflowName}, not ${specification.meta.name}`,
				{ runId, actualWorkflow: detail.workflowName },
			);
		}
		return { run, detail };
	};

	/**
	 * @param {string} runId
	 * @param {Pick<import("@github/copilot-sdk").WorkflowHandle, "meta">} specification
	 * @param {Awaited<ReturnType<typeof loadRun>>} inspected
	 * @param {{signal?: AbortSignal, wait?: boolean}} [options]
	 */
	const settleRun = async (runId, specification, inspected, { signal, wait = true } = {}) => {
		signal?.throwIfAborted();
		if (wait && (inspected.run.status === "pending" || inspected.run.status === "running")) {
			const backend = api();
			if (typeof backend.waitForRun !== "function") {
				fail("workflow_backend_unavailable", "Importing an active Workflow requires native waitForRun");
			}
			await backend.waitForRun(runId, { signal });
			signal?.throwIfAborted();
			inspected = await loadRun(runId, specification);
		}
		assertCompleted(inspected.run);
		return inspected;
	};

	/** @param {string} runId */
	const inspectWorkflow = async (runId) => {
		if (typeof runId !== "string" || !runId.trim()) {
			fail("workflow_run_invalid", "A non-empty native Workflow run ID is required");
		}
		const detail = await api().getRunDetail(runId);
		if (detail.runId !== runId || !Object.values(FOUNDRY_WORKFLOWS)
			.some(({ meta }) => meta.name === detail.workflowName)) {
			fail("workflow_run_identity_mismatch", `Run ${runId} is not a Foundry Workflow`);
		}
		return detail;
	};

	const listWorkflowRuns = async () => {
		const page = await api().listRuns({ limit: 20 });
		const names = new Set(Object.values(FOUNDRY_WORKFLOWS).map(({ meta }) => meta.name));
		const runs = await Promise.all(page.runs.filter((run) => names.has(run.workflowName))
			.map((run) => run.status === "paused" ? inspectWorkflow(run.runId) : run));
		return { ...page, runs };
	};

	/** @param {string} runId @param {"pause" | "resume"} action @param {{signal?: AbortSignal}} [options] */
	const controlWorkflow = async (runId, action, { signal } = {}) => {
		signal?.throwIfAborted();
		const detail = await inspectWorkflow(runId);
		if (action !== "pause" && action !== "resume") {
			fail("workflow_action_invalid", "Workflow action must be pause or resume");
		}
		if (action === "pause" && detail.status !== "running") {
			fail("workflow_not_active", `Run ${runId} is ${detail.status}; refresh its state`);
		}
		if (action === "resume" && !detail.canResume) {
			fail("workflow_not_resumable", `The native runtime cannot resume run ${runId}`);
		}
		if (action === "resume" && detail.terminal?.failure?.type === "workflow_limit_reached") {
			fail("workflow_limit_reached", "Use run_dynamic_workflow to resume with an explicitly approved increase to the reached limit");
		}
		const backend = api();
		signal?.throwIfAborted();
		let pending;
		if (action === "pause") {
			if (typeof backend.pause !== "function") {
				fail("workflow_backend_unavailable", "Native Workflow pause is unavailable");
			}
			pending = backend.pause(runId);
		} else {
			if (typeof backend.resume !== "function") {
				fail("workflow_backend_unavailable", "Native Workflow resume is unavailable");
			}
			pending = backend.resume(runId, { notifyOnComplete: true, logPhaseNames: true });
		}
		const settled = await waitForControl(pending, signal);
		if (settled.runId !== runId) {
			fail("workflow_run_identity_mismatch", `Workflow ${action} returned a different run`);
		}
		if (!TERMINAL.has(settled.status) && settled.status !== "paused") {
			fail("workflow_control_incomplete", `Workflow ${action} has not settled`, { runId, status: settled.status });
		}
		return settled;
	};

	/**
	 * Read reservation markers from bounded, base-agnostic progress pages.
	 *
	 * @param {string} runId
	 * @param {import("@github/copilot-sdk").WorkflowRunDetail | null} [existingDetail]
	 * @returns {Promise<
	 *   {state: "readable", markers: string[]}
	 *   | {state: "inconclusive", reason: string}
	 * >}
	 */
	const readReservationMarkers = async (runId, existingDetail = null) => {
		try {
			const detail = existingDetail ?? await api().getRunDetail(runId);
			let page = detail?.progress;
			const markers = new Set();
			for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
				if (!page || !Array.isArray(page.records)) {
					return { state: "inconclusive", reason: "progress-unavailable" };
				}
				for (const record of page.records) {
					if (record?.kind !== "log") continue;
					const marker = parseVerificationMarker(record.text);
					if (marker) markers.add(marker);
				}
				if (markers.size > 0) {
					return { state: "readable", markers: [...markers] };
				}
				if (page.hasMoreOlder !== true) {
					return { state: "readable", markers: [...markers] };
				}
				if (typeof page.oldestSeq !== "number" || !Number.isSafeInteger(page.oldestSeq)) {
					return { state: "inconclusive", reason: "progress-cursor-unavailable" };
				}
				page = await api().getRunProgress(runId, {
					beforeSeq: page.oldestSeq,
					limit: 500,
				});
			}
			return { state: "inconclusive", reason: "progress-unbounded" };
		} catch (error) {
			return {
				state: "inconclusive",
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	};

	/**
	 * Discover the native verification run associated with one reservation.
	 * @param {string} reservationId
	 * @param {string} reservedAt
	 * @returns {Promise<
	 *   {state: "absent"}
	 *   | {state: "found", run: import("@github/copilot-sdk").WorkflowRunSummary, duplicates: []}
	 *   | {state: "inconclusive", reason: string,
	 *     candidates: Array<import("@github/copilot-sdk").WorkflowRunSummary & {reason?: string}>,
	 *     unattributable?: Array<import("@github/copilot-sdk").WorkflowRunSummary & {reason?: string}>}
	 * >}
	 */
	const discoverVerificationRun = async (reservationId, reservedAt) => {
		const threshold = Date.parse(String(reservedAt));
		if (!Number.isFinite(threshold)) {
			fail("workflow_reservation_invalid", "Verification reservation timestamp is invalid");
		}
		/** @type {Map<string, import("@github/copilot-sdk").WorkflowRunSummary>} */
		const summaries = new Map();
		let beforeSeq;
		/** @type {string | null} */
		let historyReason = "workflow run history exceeds the discovery page budget";
		for (let pageNumber = 0; pageNumber < RUN_DISCOVERY_MAX_PAGES; pageNumber++) {
			/** @type {import("@github/copilot-sdk").WorkflowRunsPage} */
			let page;
			try {
				page = await api().listRuns({
					limit: RUN_DISCOVERY_PAGE_SIZE,
					...(beforeSeq === undefined ? {} : { beforeSeq }),
				});
			} catch (error) {
				historyReason = error instanceof Error ? error.message : String(error);
				break;
			}
			if (!page || !Array.isArray(page.runs)) {
				historyReason = "workflow run listing is unavailable";
				break;
			}
			for (const summary of page.runs) {
				// Active runs can accompany every terminal window. They are not duplicates.
				if (summary && !summaries.has(summary.runId)) {
					summaries.set(summary.runId, summary);
				}
			}
			if (pageNumber === 0 && page.hasMoreNewer !== false) {
				historyReason = "workflow run listing has unresolved newer history";
				break;
			}
			if (
				typeof page.omittedOlder !== "number"
				|| !Number.isSafeInteger(page.omittedOlder)
				|| page.omittedOlder < 0
			) {
				historyReason = "workflow run listing has unknown omitted older history";
				break;
			}
			if (page.omittedOlder === 0) {
				historyReason = null;
				break;
			}
			// These are terminal-run cursors, not offsets into runs (which includes active runs).
			if (
				typeof page.oldestSeq !== "number"
				|| !Number.isSafeInteger(page.oldestSeq)
				|| (beforeSeq !== undefined && page.oldestSeq >= beforeSeq)
			) {
				historyReason = "workflow run listing has no advancing older cursor";
				break;
			}
			beforeSeq = page.oldestSeq;
		}
		const matches = [];
		const inconclusive = [];
		const unattributable = [];
		for (const summary of [...summaries.values()]
			.filter((entry) => entry?.workflowName === FOUNDRY_WORKFLOWS.verify.meta.name)
			.filter((entry) => !Number.isFinite(entry.createdAt) || entry.createdAt >= threshold)
			.sort((left, right) => (
				(Number.isFinite(left.createdAt) ? left.createdAt : Number.POSITIVE_INFINITY)
				- (Number.isFinite(right.createdAt) ? right.createdAt : Number.POSITIVE_INFINITY)
			))) {
			const progress = await readReservationMarkers(summary.runId);
			if (progress.state === "inconclusive") {
				const candidate = { ...summary, reason: progress.reason };
				if (!Number.isFinite(summary.createdAt) && TERMINAL.has(summary.status)) {
					unattributable.push(candidate);
				} else {
					inconclusive.push(candidate);
				}
				continue;
			}
			if (progress.markers.includes(reservationId)) {
				matches.push(summary);
				continue;
			}
			if (progress.markers.length > 0) continue;
			if (
				!TERMINAL.has(summary.status)
			) {
				inconclusive.push({ ...summary, reason: "run has not emitted a reservation marker" });
			}
		}
		if (matches.length > 1) {
			return {
				state: "inconclusive",
				reason: "multiple Workflow runs carry the verification reservation",
				candidates: matches,
			};
		}
		if (historyReason !== null) {
			return {
				state: "inconclusive",
				reason: historyReason,
				candidates: [...matches, ...inconclusive],
				unattributable,
			};
		}
		if (matches.length === 1 && (inconclusive.length > 0 || unattributable.length > 0)) {
			return {
				state: "inconclusive",
				reason: "a matching verification run exists alongside unresolved candidates",
				candidates: [...matches, ...inconclusive],
				unattributable,
			};
		}
		if (matches.length === 1) {
			return {
				state: "found",
				run: matches[0],
				duplicates: [],
			};
		}
		if (inconclusive.length > 0) {
			return {
				state: "inconclusive",
				reason: "verification launch is not yet observable",
				candidates: inconclusive,
				unattributable,
			};
		}
		if (unattributable.length > 0) {
			return {
				state: "inconclusive",
				reason: "terminal Workflow runs cannot be attributed to this reservation",
				candidates: [],
				unattributable,
			};
		}
		return { state: "absent" };
	};

	/** Build the exact native planning Workflow invocation. */
	const preparePlanning = async (input) => {
		const args = buildPlanningArgs(input);
		const specification = FOUNDRY_WORKFLOWS.plan;
		return {
			workflow: specification.meta.name,
			inputDigest: args.inputDigest,
			launchSpec: {
				name: specification.meta.name,
				args,
			},
		};
	};

	/**
	 * Wait for and validate a planning result without starting or resuming its run.
	 * @param {string} runId
	 * @param {{signal?: AbortSignal}} [options]
	 */
	const importPlanning = async (runId, options = {}) => {
		const inspected = await loadRun(runId, FOUNDRY_WORKFLOWS.plan);
		const { run } = await settleRun(runId, FOUNDRY_WORKFLOWS.plan, inspected, options);
		const result = run.result;
		if (!result || typeof result !== "object" || Array.isArray(result)) {
			fail("workflow_result_invalid", `Workflow run ${runId} returned no planning object`);
		}
		const persistedInput = result.input;
		if (!persistedInput || typeof persistedInput !== "object" || Array.isArray(persistedInput)) {
			fail("workflow_input_missing", `Planning run ${runId} did not return its canonical input`);
		}
		let normalized;
		try {
			normalized = validatePlanningArgs(persistedInput);
		} catch (error) {
			if (error instanceof FoundryAnalysisError && error.code === "analysis_input_mismatch") {
				fail("workflow_input_mismatch", `Planning run ${runId} carries an invalid input digest`);
			}
			throw error;
		}
		const { inputDigest } = normalized;
		if (result.inputDigest !== inputDigest) {
			fail("workflow_input_mismatch", `Planning run ${runId} carries an invalid input digest`);
		}
		return {
			runId,
			inputDigest,
			plan: validatePlanningResult(result, normalized, normalized.maxTasks),
		};
	};

	/** Build the exact native verification Workflow invocation. */
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
	 * @param {any} plan
	 * @param {{signal?: AbortSignal, wait?: boolean}} [options]
	 */
	const importVerification = async (runId, plan, options = {}) => {
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
		if (Number.isFinite(detail.createdAt) && detail.createdAt < reservedAt) {
			fail(
				"workflow_run_identity_mismatch",
				`Workflow run ${runId} predates verification reservation ${reservationId}`,
				{ runId, reservationId, createdAt: detail.createdAt, reservedAt },
			);
		}
		const progress = await readReservationMarkers(runId, detail);
		if (progress.state !== "readable") {
			fail(
				"workflow_progress_inconclusive",
				`Workflow run ${runId} progress cannot establish reservation identity`,
				{ runId, reservationId, reason: progress.reason },
			);
		}
		if (!progress.markers.includes(reservationId)) {
			fail(
				"workflow_run_identity_mismatch",
				`Workflow run ${runId} does not carry verification reservation ${reservationId}`,
				{ runId, reservationId },
			);
		}
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

	/** Classify whether one discovered verification run can be superseded. */
	const assessVerificationRun = async (runId, plan) => {
			const run = await api().getRun(runId);
			if (run.status === "paused") return { state: "paused", run };
			if (!TERMINAL.has(run.status)) return { state: "active", run };
			if (run.status !== "completed") {
				return { state: "terminal-nonimportable", run };
			}
			try {
				const imported = await importVerification(runId, plan, { wait: false });
				return { state: "importable", run, imported };
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
						state: "terminal-nonimportable",
						run,
						reason: error instanceof Error ? error.message : String(error),
					};
				}
				throw error;
			}
	};

	/** Observe whether a verification Workflow run is terminal. */
	const verificationRunIsTerminal = async (runId) => {
		try {
			const run = await api().getRun(runId);
			return TERMINAL.has(run.status);
		} catch (error) {
			if (isMissingRun(error)) return false;
			throw error;
		}
	};

	/** Cancel the exact Foundry verification run and observe a terminal envelope. */
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

	return Object.freeze({
		controlWorkflow,
		inspectWorkflow,
		listWorkflowRuns,
		importPlanning,
		importVerification,
		assessVerificationRun,
		cancelVerificationRun,
		discoverVerificationRun,
		preparePlanning,
		prepareVerification,
		verificationRunIsTerminal,
	});
}

/**
 * @param {import("@github/copilot-sdk").WorkflowRunResult | null | undefined} run
 * @returns {asserts run is import("@github/copilot-sdk").WorkflowRunResult
 *   & {status: "completed"}}
 */
function assertCompleted(run) {
	if (run?.status !== "completed" || !Object.hasOwn(run, "result")) {
		fail(
			"workflow_result_unavailable",
			`Workflow run ${run?.runId ?? "(unknown)"} is ${run?.status ?? "unknown"} and has no result`,
			{ status: run?.status, failure: run?.failure ?? null },
		);
	}
}
