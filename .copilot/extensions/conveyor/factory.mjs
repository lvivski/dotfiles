/** @module factory — execute Conveyor harnesses exclusively through a native Factory context. */
import { runHarness } from "./sandbox.mjs";
import { assertJson } from "./schema.mjs";
import { extractMeta, stripExports } from "./source.mjs";

export const CONVEYOR_FACTORY_META = Object.freeze({
	name: "conveyor",
	description:
		"Execute a plain JavaScript Conveyor harness on the native Factory runtime. " +
		"args: { source: string, filename?: string, input?: JSON }. Prefer run_conveyor for source discovery.",
	phases: [],
	limits: {
		maxConcurrentSubagents: 8,
		maxTotalSubagents: 700,
		timeoutSeconds: 3600,
		maxAiCredits: 1000,
	},
});

/**
 * Native Factory body.
 * @param {any} factory
 * @returns {Promise<any>}
 */
export async function executeConveyor(factory) {
	const payload = normalizePayload(factory.args);
	return executeSource(factory, payload);
}

/** @param {any} factory @param {{source:string, filename:string, input:unknown}} payload */
async function executeSource(factory, payload) {
	const metadata = extractMeta(payload.source);
	factory.log(`Conveyor ${metadata.name || payload.filename} started`);
	const api = buildApi(factory, payload.input);
	const result = await runHarness(stripExports(payload.source), {
		api,
		filename: payload.filename,
		log: (message) => factory.log(message),
	});
	return assertJson(result, { allowUndefined: true, label: "Conveyor result" });
}

/** @param {any} factory @param {unknown} input */
export function buildApi(factory, input) {
	const context = Object.freeze({
		args: assertJson(input ?? {}, { label: "Conveyor arguments" }),
		runId: String(factory.runId),
		signal: factory.signal,
	});
	return Object.freeze({
		context,
		agent: (prompt, options) => factory.agent(assertPrompt(prompt), normalizeAgentOptions(options)),
		parallel: (thunks) => {
			if (!Array.isArray(thunks)) throw new TypeError("parallel thunks must be an array");
			return factory.parallel(
				Array.from(thunks, (thunk, index) => async () =>
					bridgeValue(await thunk(), `Conveyor parallel result ${index}`)),
			);
		},
		pipeline: (items, ...stages) => {
			const bridgedItems = assertJson(items, { label: "Conveyor pipeline items" });
			if (!Array.isArray(bridgedItems)) throw new TypeError("pipeline items must be an array");
			const bridgedStages = Array.from(stages, (stage, stageIndex) =>
				async (previous, item, index) =>
					bridgeValue(
						await stage(previous, item, index),
						`Conveyor pipeline stage ${stageIndex} result`,
					));
			return factory.pipeline(bridgedItems, ...bridgedStages);
		},
		phase: (title) => factory.phase(assertTitle(title)),
		step: (key, producer, options) => {
			const durableKey = assertKey(key);
			return factory.step(
				durableKey,
				async () => assertJson(await producer(), { label: `Conveyor step '${durableKey}'` }),
				normalizeStepOptions(options),
			);
		},
		log: (message) => factory.log(String(message)),
	});
}

/** Normalize VM values before native Factory code observes them. @param {unknown} value @param {string} label */
function bridgeValue(value, label) {
	return value === undefined ? undefined : assertJson(value, { label });
}

/** @param {unknown} value */
function normalizePayload(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("Conveyor Factory args must be an object");
	}
	const payload = /** @type {Record<string, unknown>} */ (value);
	for (const key of Object.keys(payload)) {
		if (!["source", "filename", "input"].includes(key)) {
			throw new TypeError(`unknown Conveyor Factory argument '${key}'`);
		}
	}
	if (typeof payload.source !== "string" || !payload.source.trim()) {
		throw new TypeError("Conveyor Factory args.source must be a non-empty string");
	}
	const filename =
		typeof payload.filename === "string" && payload.filename.trim()
			? payload.filename
			: "conveyor.mjs";
	return {
		source: payload.source,
		filename,
		input: Object.hasOwn(payload, "input") ? assertJson(payload.input, { label: "Conveyor input" }) : {},
	};
}

/** @param {unknown} value */
function normalizeAgentOptions(value) {
	if (value == null) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("agent options must be an object");
	}
	const options = /** @type {Record<string, unknown>} */ (value);
	for (const key of Object.keys(options)) {
		if (!["label", "schema", "model"].includes(key)) {
			throw new TypeError(`unsupported Factory agent option '${key}'`);
		}
	}
	return {
		...(options.label != null ? { label: String(options.label) } : {}),
		...(options.model != null ? { model: String(options.model) } : {}),
		...(options.schema != null
			? { schema: assertJson(options.schema, { label: "Factory agent schema" }) }
			: {}),
	};
}

/** @param {unknown} value */
function normalizeStepOptions(value) {
	if (value == null) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("step options must be an object");
	}
	const options = /** @type {Record<string, unknown>} */ (value);
	for (const key of Object.keys(options)) {
		if (key !== "volatile") throw new TypeError(`unsupported Factory step option '${key}'`);
	}
	return options.volatile === true ? { volatile: true } : {};
}

/** @param {unknown} value */
function assertPrompt(value) {
	if (typeof value !== "string" || !value.trim()) throw new TypeError("agent prompt must be a non-empty string");
	return value;
}

/** @param {unknown} value */
function assertTitle(value) {
	if (typeof value !== "string" || !value.trim()) throw new TypeError("phase title must be a non-empty string");
	return value;
}

/** @param {unknown} value */
function assertKey(value) {
	if (typeof value !== "string" || !value.trim()) throw new TypeError("step key must be a non-empty string");
	return value;
}
