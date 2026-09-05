/** @module factory — Foundry control-plane adapters and registered native Agent Factories. */
import {
	FoundryAnalysisError,
	buildPlanningArgs,
	buildVerificationInput,
	validatePlanningArgs,
	validatePlanningResult,
	validateVerificationResult,
} from "./analysis.mjs";
import { meta as auditMeta, run as runAudit } from "./factories/audit.mjs";
import { meta as deepResearchMeta, run as runDeepResearch } from "./factories/deep-research.mjs";
import { meta as planMeta, run as runPlan } from "./factories/plan.mjs";
import { meta as reviewQueueMeta, run as runReviewQueue } from "./factories/review-queue.mjs";
import { meta as securityReviewMeta, run as runSecurityReview } from "./factories/security-review.mjs";
import { meta as triageMeta, run as runTriage } from "./factories/triage.mjs";
import { meta as verifyMeta, run as runVerify } from "./factories/verify.mjs";
import { parseVerificationMarker } from "./marker.mjs";

/** Native Factory definitions registered by the Foundry control plane. */
export const FOUNDRY_FACTORIES = Object.freeze({
	audit: Object.freeze({ meta: auditMeta, run: runAudit }),
	deepResearch: Object.freeze({ meta: deepResearchMeta, run: runDeepResearch }),
	plan: Object.freeze({ meta: planMeta, run: runPlan }),
	reviewQueue: Object.freeze({ meta: reviewQueueMeta, run: runReviewQueue }),
	securityReview: Object.freeze({ meta: securityReviewMeta, run: runSecurityReview }),
	triage: Object.freeze({ meta: triageMeta, run: runTriage }),
	verify: Object.freeze({ meta: verifyMeta, run: runVerify }),
});

const TERMINAL = new Set(["completed", "error", "halted", "cancelled"]);
const RUN_DISCOVERY_PAGE_SIZE = 200;
const RUN_DISCOVERY_MAX_PAGES = 10;

/** Typed failure raised when a native Factory run cannot satisfy Foundry invariants. */
export class FoundryFactoryError extends Error {
	/** @param {string} code @param {string} message @param {unknown} [details] */
	constructor(code, message, details = null) {
		super(message);
		this.name = "FoundryFactoryError";
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
	throw new FoundryFactoryError(code, message, details);
}

/** @param {any} error */
function isMissingRun(error) {
	const codes = [
		error?.code,
		error?.data?.code,
		error?.cause?.code,
		error?.cause?.data?.code,
	].filter((value) => typeof value === "string");
	if (codes.some((code) => code === "factory_run_not_found" || code === "not_found")) {
		return true;
	}
	return /\b(?:factory )?run\b.*\bnot found\b/i.test(error?.message ?? String(error));
}

/**
 * Build the Foundry analysis boundary over the current session's native Factory API.
 * @param {() => any} getFactoryApi
 */
export function createFactoryAnalysis(getFactoryApi) {
	if (typeof getFactoryApi !== "function") {
		throw new TypeError("createFactoryAnalysis requires getFactoryApi");
	}
	/** Resolve the current session's Factory API or fail closed. */
	const api = () => {
		const value = getFactoryApi();
		if (
			!value ||
			typeof value.getRun !== "function" ||
			typeof value.getRunDetail !== "function" ||
			typeof value.getRunProgress !== "function" ||
			typeof value.listRuns !== "function"
		) {
			fail(
				"factory_backend_unavailable",
				"Foundry requires native Factory run inspection APIs",
			);
		}
		return value;
	};

	/** @param {string} runId @param {any} specification */
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
				error instanceof FoundryFactoryError &&
				error.code === "factory_backend_unavailable"
			) {
				throw error;
			}
			const message = error?.message ?? String(error);
			fail(
				isMissingRun(error)
					? "factory_run_not_found"
					: "factory_run_invalid",
				message,
				{ runId },
			);
		}
		if (detail.factoryName !== specification.meta.name) {
			fail(
				"factory_run_identity_mismatch",
				`Factory run ${runId} belongs to ${detail.factoryName}, not ${specification.meta.name}`,
				{ runId, actualFactory: detail.factoryName },
			);
		}
		return { run, detail };
	};

	/**
	 * Read reservation markers from bounded, base-agnostic progress pages.
	 *
	 * @param {string} runId
	 * @param {any} [existingDetail]
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
				if (!Number.isSafeInteger(page.oldestSeq)) {
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
	 *   | {state: "found", run: import("@github/copilot-sdk").FactoryRunSummary, duplicates: []}
	 *   | {state: "inconclusive", reason: string,
	 *     candidates: Array<import("@github/copilot-sdk").FactoryRunSummary & {reason?: string}>,
	 *     unattributable?: Array<import("@github/copilot-sdk").FactoryRunSummary & {reason?: string}>}
	 * >}
	 */
	const discoverVerificationRun = async (reservationId, reservedAt) => {
		const threshold = Date.parse(String(reservedAt));
		if (!Number.isFinite(threshold)) {
			fail("factory_reservation_invalid", "Verification reservation timestamp is invalid");
		}
		/** @type {Map<string, import("@github/copilot-sdk").FactoryRunSummary>} */
		const summaries = new Map();
		let beforeSeq;
		/** @type {string | null} */
		let historyReason = "factory run history exceeds the discovery page budget";
		for (let pageNumber = 0; pageNumber < RUN_DISCOVERY_MAX_PAGES; pageNumber++) {
			/** @type {import("@github/copilot-sdk").FactoryRunsPage} */
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
				historyReason = "factory run listing is unavailable";
				break;
			}
			for (const summary of page.runs) {
				// Active runs can accompany every terminal window. They are not duplicates.
				if (summary && !summaries.has(summary.runId)) {
					summaries.set(summary.runId, summary);
				}
			}
			if (pageNumber === 0 && page.hasMoreNewer !== false) {
				historyReason = "factory run listing has unresolved newer history";
				break;
			}
			if (
				typeof page.omittedOlder !== "number"
				|| !Number.isSafeInteger(page.omittedOlder)
				|| page.omittedOlder < 0
			) {
				historyReason = "factory run listing has unknown omitted older history";
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
				historyReason = "factory run listing has no advancing older cursor";
				break;
			}
			beforeSeq = page.oldestSeq;
		}
		const matches = [];
		const inconclusive = [];
		const unattributable = [];
		for (const summary of [...summaries.values()]
			.filter((entry) => entry?.factoryName === FOUNDRY_FACTORIES.verify.meta.name)
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
				reason: "multiple Factory runs carry the verification reservation",
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
				reason: "terminal Factory runs cannot be attributed to this reservation",
				candidates: [],
				unattributable,
			};
		}
		return { state: "absent" };
	};

	/** Build the exact native planning Factory invocation. */
	const preparePlanning = async (input) => {
		const args = buildPlanningArgs(input);
		const specification = FOUNDRY_FACTORIES.plan;
		return {
			factory: specification.meta.name,
			inputDigest: args.inputDigest,
			launchSpec: {
				name: specification.meta.name,
				args,
			},
		};
	};

	/** Import and validate one completed planning Factory run. */
	const importPlanning = async (runId) => {
		const { run } = await loadRun(runId, FOUNDRY_FACTORIES.plan);
		assertCompleted(run);
		const result = run.result;
		if (!result || typeof result !== "object" || Array.isArray(result)) {
			fail("factory_result_invalid", `Factory run ${runId} returned no planning object`);
		}
		const persistedInput = result.input;
		if (!persistedInput || typeof persistedInput !== "object" || Array.isArray(persistedInput)) {
			fail("factory_input_missing", `Planning run ${runId} did not return its canonical input`);
		}
		let normalized;
		try {
			normalized = validatePlanningArgs(persistedInput);
		} catch (error) {
			if (error instanceof FoundryAnalysisError && error.code === "analysis_input_mismatch") {
				fail("factory_input_mismatch", `Planning run ${runId} carries an invalid input digest`);
			}
			throw error;
		}
		const { inputDigest } = normalized;
		if (result.inputDigest !== inputDigest) {
			fail("factory_input_mismatch", `Planning run ${runId} carries an invalid input digest`);
		}
		return {
			runId,
			inputDigest,
			plan: validatePlanningResult(result, normalized, normalized.maxTasks),
		};
	};

	/** Build the exact native verification Factory invocation. */
	const prepareVerification = async (plan, reservationId) => {
		const canonicalInput = buildVerificationInput(plan);
		const args = { ...canonicalInput, reservationId };
		const specification = FOUNDRY_FACTORIES.verify;
		return {
			factory: specification.meta.name,
			inputDigest: canonicalInput.inputDigest,
			launchSpec: {
				name: specification.meta.name,
				args,
			},
		};
	};

	/** Import one terminal verification Factory result against its reservation. */
	const importVerification = async (runId, plan) => {
		const { run, detail } = await loadRun(runId, FOUNDRY_FACTORIES.verify);
		const expectedArgs = buildVerificationInput(plan);
		const reservationId = String(plan.verification.reservationId || "");
		const reservedAt = Date.parse(String(plan.verification.reservedAt || ""));
		if (!reservationId || !Number.isFinite(reservedAt)) {
			fail(
				"factory_reservation_invalid",
				"Verification inspection requires its reservation identity and timestamp",
			);
		}
		if (Number.isFinite(detail.createdAt) && detail.createdAt < reservedAt) {
			fail(
				"factory_run_identity_mismatch",
				`Factory run ${runId} predates verification reservation ${reservationId}`,
				{ runId, reservationId, createdAt: detail.createdAt, reservedAt },
			);
		}
		const progress = await readReservationMarkers(runId, detail);
		if (progress.state !== "readable") {
			fail(
				"factory_progress_inconclusive",
				`Factory run ${runId} progress cannot establish reservation identity`,
				{ runId, reservationId, reason: progress.reason },
			);
		}
		if (!progress.markers.includes(reservationId)) {
			fail(
				"factory_run_identity_mismatch",
				`Factory run ${runId} does not carry verification reservation ${reservationId}`,
				{ runId, reservationId },
			);
		}
		assertCompleted(run);
		const result = validateVerificationResult(
			run.result,
			expectedArgs,
			reservationId,
		);
		return {
			run,
			detail,
			result,
		};
	};

	/** Classify whether one discovered verification run can be superseded. */
	const assessVerificationRun = async (runId, plan) => {
			const run = await api().getRun(runId);
			if (!TERMINAL.has(run.status)) return { state: "active", run };
			if (run.status !== "completed") {
				return { state: "terminal-nonimportable", run };
			}
			try {
				const imported = await importVerification(runId, plan);
				return { state: "importable", run, imported };
			} catch (error) {
				if (
					error instanceof FoundryAnalysisError
					|| (error instanceof FoundryFactoryError
						&& [
							"factory_input_missing",
							"factory_input_mismatch",
							"factory_result_invalid",
							"factory_result_unavailable",
							"factory_run_identity_mismatch",
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

	/** Observe whether a verification Factory run is terminal. */
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
		const { run } = await loadRun(runId, FOUNDRY_FACTORIES.verify);
		if (TERMINAL.has(run.status)) {
			return {
				runId,
				status: run.status,
				alreadyTerminal: true,
			};
		}
		const factoryApi = api();
		if (typeof factoryApi.cancel !== "function") {
			fail(
				"factory_backend_unavailable",
				"Foundry requires the native Factory cancellation API",
			);
		}
		let settled;
		try {
			settled = await factoryApi.cancel(runId);
		} catch (error) {
			fail(
				"factory_cancel_failed",
				error instanceof Error ? error.message : String(error),
				{ runId },
			);
		}
		if (!TERMINAL.has(settled?.status)) {
			fail(
				"factory_cancel_incomplete",
				`Factory run ${runId} did not reach a terminal state`,
				{ runId, status: settled?.status ?? null },
			);
		}
		if (settled.runId !== runId) {
			fail(
				"factory_run_identity_mismatch",
				`Factory cancellation returned a different run than ${runId}`,
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

/** @param {any} run */
function assertCompleted(run) {
	if (run?.status !== "completed" || !Object.hasOwn(run, "result")) {
		fail(
			"factory_result_unavailable",
			`Factory run ${run?.runId ?? "(unknown)"} is ${run?.status ?? "unknown"} and has no result`,
			{ status: run?.status, failure: run?.failure ?? null },
		);
	}
}
