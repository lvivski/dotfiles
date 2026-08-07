/** @module factory — Mobius adapters for native Agent Factory runs. */
import {
	analysisInputDigest,
	buildPlanningArgs,
	buildVerificationInput,
	normalizePlanningInput,
	validatePlanningResult,
	validateVerificationResult,
} from "./analysis.mjs";
import { meta as planMeta, run as runPlan } from "./factories/plan.mjs";
import { meta as verifyMeta, run as runVerify } from "./factories/verify.mjs";

/** Native Mobius Factory definitions shared by registration and launch preparation. */
export const MOBIUS_FACTORIES = Object.freeze({
	plan: Object.freeze({ meta: planMeta, run: runPlan }),
	verify: Object.freeze({ meta: verifyMeta, run: runVerify }),
});

const ACTIVE = new Set(["pending", "running"]);
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
			typeof value.getRunDetail !== "function"
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

	/** Build the exact native planning Factory invocation. */
	const preparePlanning = async (input) => {
		const args = buildPlanningArgs(input);
		const specification = MOBIUS_FACTORIES.plan;
		return {
			backend: "factory",
			factory: specification.meta.name,
			inputDigest: args.inputDigest,
			launchSpec: {
				name: specification.meta.name,
				args,
				limits: specification.meta.limits,
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
	const prepareVerification = async (plan) => {
		const args = buildVerificationInput(plan);
		const specification = MOBIUS_FACTORIES.verify;
		return {
			backend: "factory",
			factory: specification.meta.name,
			inputDigest: args.inputDigest,
			launchSpec: {
				name: specification.meta.name,
				args,
				limits: specification.meta.limits,
			},
		};
	};

	/** Bind or import one verification Factory run against canonical plan evidence. */
	const inspectVerification = async (runId, plan, options = {}) => {
		const { run, detail } = await loadRun(runId, MOBIUS_FACTORIES.verify);
		const expectedArgs = buildVerificationInput(plan);
		if (options.requireComplete) {
			assertCompleted(run);
		} else if (!ACTIVE.has(run.status) && run.status !== "completed") {
			fail(
				"factory_result_unavailable",
				`Factory run ${runId} cannot be bound from ${run.status}`,
				{ status: run.status },
			);
		}
		const result =
			run.status === "completed"
				? validateVerificationResult(run.result, expectedArgs)
				: undefined;
		return {
			run,
			detail,
			inputDigest: expectedArgs.inputDigest,
			...(result === undefined ? {} : { result }),
		};
	};

	/** Decide whether a non-active, non-importable verification run can be replaced. */
	const verificationRunCanBeReplaced = async (runId, plan) => {
		let run;
		try {
			run = await api().getRun(runId);
		} catch (error) {
			if (isMissingRun(error)) return true;
			throw error;
		}
		if (ACTIVE.has(run.status)) return false;
		if (!TERMINAL.has(run.status)) return false;
		if (run.status !== "completed") return true;
		try {
			await inspectVerification(runId, plan, { requireComplete: true });
			return false;
		} catch (error) {
			if (error?.code === "factory_backend_unavailable") throw error;
			return true;
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

	return Object.freeze({
		importPlanning,
		inspectVerification,
		preparePlanning,
		prepareVerification,
		verificationRunCanBeReplaced,
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
