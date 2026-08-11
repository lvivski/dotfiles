/** @module factory — Mobius adapters for native Agent Factory runs. */
import {
	MobiusAnalysisError,
	analysisInputDigest,
	buildPlanningArgs,
	buildVerificationInput,
	normalizePlanningInput,
	validatePlanningResult,
	validateVerificationResult,
} from "./analysis.mjs";
import { meta as planMeta, run as runPlan } from "./factories/plan.mjs";
import { meta as verifyMeta, run as runVerify } from "./factories/verify.mjs";
import { parseVerificationMarker } from "./marker.mjs";

/** Native Mobius Factory definitions shared by registration and launch preparation. */
export const MOBIUS_FACTORIES = Object.freeze({
	plan: Object.freeze({ meta: planMeta, run: runPlan }),
	verify: Object.freeze({ meta: verifyMeta, run: runVerify }),
});

const TERMINAL = new Set(["completed", "error", "halted", "cancelled"]);

/** Typed failure raised when a native Factory run cannot satisfy Mobius invariants. */
export class MobiusFactoryError extends Error {
	/** @param {string} code @param {string} message @param {unknown} [details] */
	constructor(code, message, details = null) {
		super(message);
		this.name = "MobiusFactoryError";
		this.code = code;
		this.details = details;
	}
}

/** @param {string} code @param {string} message @param {unknown} [details] */
function fail(code, message, details) {
	throw new MobiusFactoryError(code, message, details);
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
 * Build the Mobius analysis boundary over the current session's native Factory API.
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
				"Mobius requires native Factory run inspection APIs",
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
				error instanceof MobiusFactoryError &&
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

	/** Read reservation markers from bounded, base-agnostic progress pages. */
	const readReservationMarkers = async (runId) => {
		try {
			const detail = await api().getRunDetail(runId);
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

	/** Discover the native verification run associated with one reservation. */
	const discoverVerificationRun = async (reservationId, reservedAt) => {
		const threshold = Date.parse(String(reservedAt));
		if (!Number.isFinite(threshold)) {
			fail("factory_reservation_invalid", "Verification reservation timestamp is invalid");
		}
		let summaries;
		try {
			summaries = await api().listRuns();
		} catch (error) {
			return {
				state: "inconclusive",
				reason: error instanceof Error ? error.message : String(error),
				candidates: [],
			};
		}
		if (!Array.isArray(summaries)) {
			return {
				state: "inconclusive",
				reason: "factory run listing is unavailable",
				candidates: [],
			};
		}
		const matches = [];
		const inconclusive = [];
		for (const summary of summaries
			.filter((entry) => (
				entry?.factoryName === MOBIUS_FACTORIES.verify.meta.name
				&& Number.isFinite(entry.createdAt)
				&& entry.createdAt >= threshold
			))
			.sort((left, right) => left.createdAt - right.createdAt)) {
			const progress = await readReservationMarkers(summary.runId);
			if (progress.state === "inconclusive") {
				inconclusive.push({ ...summary, reason: progress.reason });
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
		if (matches.length === 1 && inconclusive.length > 0) {
			return {
				state: "inconclusive",
				reason: "a matching verification run exists alongside unresolved candidates",
				candidates: [...matches, ...inconclusive],
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
			};
		}
		return { state: "absent" };
	};

	/** Build the exact native planning Factory invocation. */
	const preparePlanning = async (input) => {
		const args = buildPlanningArgs(input);
		const specification = MOBIUS_FACTORIES.plan;
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
		const { run } = await loadRun(runId, MOBIUS_FACTORIES.plan);
		assertCompleted(run);
		const result = run.result;
		if (!result || typeof result !== "object" || Array.isArray(result)) {
			fail("factory_result_invalid", `Factory run ${runId} returned no planning object`);
		}
		const persistedInput = result.input;
		if (!persistedInput || typeof persistedInput !== "object" || Array.isArray(persistedInput)) {
			fail("factory_input_missing", `Planning run ${runId} did not return its canonical input`);
		}
		const { inputDigest, ...rawInput } = persistedInput;
		const normalized = normalizePlanningInput(rawInput);
		const expectedDigest = analysisInputDigest(normalized);
		if (inputDigest !== expectedDigest || result.inputDigest !== expectedDigest) {
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
		const specification = MOBIUS_FACTORIES.verify;
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
		const { run, detail } = await loadRun(runId, MOBIUS_FACTORIES.verify);
		const expectedArgs = buildVerificationInput(plan);
		const reservationId = String(plan.verification.reservationId || "");
		const reservedAt = Date.parse(String(plan.verification.reservedAt || ""));
		if (!reservationId || !Number.isFinite(reservedAt)) {
			fail(
				"factory_reservation_invalid",
				"Verification inspection requires its reservation identity and timestamp",
			);
		}
		if (!Number.isFinite(detail.createdAt) || detail.createdAt < reservedAt) {
			fail(
				"factory_run_identity_mismatch",
				`Factory run ${runId} predates verification reservation ${reservationId}`,
				{ runId, reservationId, createdAt: detail.createdAt, reservedAt },
			);
		}
		const progress = await readReservationMarkers(runId);
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
					error instanceof MobiusAnalysisError
					|| (error instanceof MobiusFactoryError
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

	/** Cancel the exact Mobius verification run and observe a terminal envelope. */
	const cancelVerificationRun = async (runId) => {
		const { run } = await loadRun(runId, MOBIUS_FACTORIES.verify);
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
				"Mobius requires the native Factory cancellation API",
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
			if (typeof factoryApi.waitForRun !== "function") {
				fail(
					"factory_cancel_incomplete",
					`Factory run ${runId} did not reach a terminal state`,
					{ runId, status: settled?.status ?? null },
				);
			}
			try {
				settled = await factoryApi.waitForRun(runId);
			} catch (error) {
				fail(
					"factory_cancel_failed",
					error instanceof Error ? error.message : String(error),
					{ runId },
				);
			}
		}
		if (!TERMINAL.has(settled?.status)) {
			fail(
				"factory_cancel_incomplete",
				`Factory run ${runId} did not reach a terminal state`,
				{ runId, status: settled?.status ?? null },
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
