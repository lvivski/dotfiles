import assert from "node:assert/strict";
import { isRecord, parseJson, property, readJsonValue } from "../../data.mjs";
import { must } from "../assertions.mjs";
import { workflowDetail as nativeDetail } from "./detail.mjs";
import { researchFinding } from "../research/fixture.mjs";
import { assertLabeled } from "./assertions.mjs";

/** @typedef {import("@github/copilot-sdk").JsonValue} JsonValue */
/** @typedef {NonNullable<Parameters<import("@github/copilot-sdk").WorkflowContext["agent"]>[1]>} AgentOptions */
/** @typedef {AgentOptions & {label: string}} NamedAgentOptions */

// Test sentinel for run failures that the native runtime propagates instead of returning null.
export class FatalWorkflowFailure extends Error { }

export class WorkflowCheckpointPause extends FatalWorkflowFailure {
	/** @param {string} key */
	constructor(key) {
		super(`Paused at ${key}`);
		this.name = "AbortError";
		this.key = key;
	}
}

/** @template T @param {T} value @returns {T} */
export function freezePrepared(value) {
	if (value !== null && typeof value === "object") {
		Object.values(value).forEach(freezePrepared);
		Object.freeze(value);
	}
	return value;
}

/**
 * @template {JsonValue} TArgs
 * @param {TArgs} args
 * @param {((prompt: string, options: NamedAgentOptions) => unknown) | null} [responseFor]
 * @param {{agents: Map<string, Promise<unknown>>, steps: Map<string, JsonValue>, checkpoints: Set<string>}} [journal]
 */
export function createWorkflowContext(args, responseFor = null, journal = {
	agents: new Map(), steps: new Map(), checkpoints: new Set(),
}) {
	/** @type {string[]} */
	const phases = [];
	/** @type {string[]} */
	const logs = [];
	/** @type {Array<{prompt: string, options: NamedAgentOptions}>} */
	const calls = [];
	/** @type {number[]} */
	const pipelineBatches = [];
	/** @type {number[]} */
	const parallelBatches = [];
	/** @type {string[]} */
	const stepCalls = [];
	/** @type {string[]} */
	const stepExecutions = [];
	/** @type {string[]} */
	const pauseCalls = [];
	return {
		args,
		runId: "workflow-run",
		signal: new AbortController().signal,
		session: {
			workflow: {
				getRunDetail: async () => nativeDetail({
					runId: "workflow-run", workflowName: "deep-research", status: "running",
					approved: {},
				}),
			},
		},
		phases,
		logs,
		calls,
		pipelineBatches,
		parallelBatches,
		stepCalls,
		stepExecutions,
		pauseCalls,
		journal,
		/** @param {string} prompt @param {AgentOptions} [options] */
		async agent(prompt, options = {}) {
			assertLabeled(options);
			const key = JSON.stringify({ prompt, options });
			if (journal.agents.has(key)) {
				return structuredClone(await journal.agents.get(key));
			}
			const result = (async () => {
				calls.push({ prompt, options });
				const configured = await responseFor?.(prompt, options);
				if (configured !== undefined) return structuredClone(configured);
				const schema = options.schema;
				if (!schema) return "NO ISSUES";
				if (schema.type === "array") {
					return property(schema.items, "type") === "string" ? ["primary angle"] : [];
				}
				const properties = isRecord(schema.properties) ? schema.properties : {};
				if (properties.authModel) {
					return {
						authModel: "unknown",
						assets: [],
						trustBoundaries: [],
						attackerInputs: [],
					};
				}
				if (properties.findings) {
					return { findings: [researchFinding()], limitations: [] };
				}
				if (properties.passed) return { passed: true, reasons: "supported" };
				if (properties.risk) {
					return {
						risk: "low",
						issues: [],
						missingTests: [],
						maintainability: [],
						uncertainty: [],
						summary: "clean",
					};
				}
				if (properties.category) {
					return {
						category: "bug",
						priority: "p2",
						confidence: "high",
						rationale: "reproducible",
						action: "fix it",
					};
				}
				if (properties.verdict) {
					return { verdict: "true-positive", reasoning: "reachable" };
				}
				throw new Error("unhandled test schema");
			})();
			journal.agents.set(key, result);
			try {
				return structuredClone(await result);
			} catch (error) {
				journal.agents.delete(key);
				throw error;
			}
		},
		/** @param {string} key @param {() => JsonValue | Promise<JsonValue>} producer */
		async step(key, producer) {
			stepCalls.push(key);
			if (!journal.steps.has(key)) {
				stepExecutions.push(key);
				const prepared = await producer();
				const json = readJsonValue(parseJson(JSON.stringify(prepared)));
				assert.deepEqual(json, prepared, "Prepared scopes must contain only JSON data");
				// Freezing catches accidental mutations of durable scope by later stages.
				journal.steps.set(key, freezePrepared(json));
			}
			return must(journal.steps.get(key));
		},
		/** @param {string} key */
		async pause(key) {
			pauseCalls.push(key);
			if (!journal.checkpoints.has(key)) {
				journal.checkpoints.add(key);
				throw new WorkflowCheckpointPause(key);
			}
		},
		/** @template T @param {Array<() => T | Promise<T>>} thunks */
		async parallel(thunks) {
			parallelBatches.push(thunks.length);
			return Promise.all(
				thunks.map(async (thunk) => {
					try {
						return await thunk();
					} catch (error) {
						if (error instanceof FatalWorkflowFailure) throw error;
						return null;
					}
				}),
			);
		},
		/** @param {unknown[]} items @param {Array<(previous: unknown, original: unknown, index: number) => unknown | Promise<unknown>>} stages */
		async pipeline(items, ...stages) {
			pipelineBatches.push(items.length);
			return Promise.all(
				items.map(async (item, index) => {
					let previous = item;
					for (const stage of stages) {
						try {
							previous = await stage(previous, item, index);
						} catch (error) {
							if (error instanceof FatalWorkflowFailure) throw error;
							return null;
						}
					}
					return previous;
				}),
			);
		},
		/** @param {string} title */
		phase(title) {
			phases.push(title);
		},
		/** @param {string} message */
		log(message) {
			logs.push(message);
		},
	};
}

/** @param {JsonValue} args @param {Record<string, unknown>} responses */
export function workflowWithResponses(args, responses) {
	return createWorkflowContext(
		args,
		(_prompt, options) => responses[options.label ?? ""] ?? null,
	);
}
