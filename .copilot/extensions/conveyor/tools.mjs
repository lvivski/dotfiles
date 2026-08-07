/** @module tools — resolve Conveyor source and launch the native Factory. */
import { homedir } from "node:os";
import { join } from "node:path";

import { assertJson, normalizeLimits } from "./schema.mjs";
import { resolveSource } from "./source.mjs";

const USER_CONVEYORS = join(homedir(), ".copilot", "conveyors");

/**
 * @typedef {object} ToolContext
 * @property {() => Promise<string|undefined>} getWorkspaceCwd
 * @property {(args: Record<string, unknown>, limits: Record<string, number>) => Promise<any>} launch
 */

/** Launch one fresh Conveyor Factory run. @param {any} input @param {ToolContext} context */
export async function runConveyor(input, context) {
	try {
		if (!input || typeof input !== "object" || Array.isArray(input)) {
			throw new TypeError("run_conveyor input must be an object");
		}
		for (const key of Object.keys(input)) {
			if (!["script", "scriptPath", "name", "args", "limits"].includes(key)) {
				throw new TypeError(`unknown run_conveyor option '${key}'`);
			}
		}
		const cwd = (await context.getWorkspaceCwd()) || process.cwd();
		const resolved = resolveSource(input, {
			cwd,
			userDir: process.env.CONVEYOR_DIR || USER_CONVEYORS,
		});
		const invocationLimits = normalizeLimits(input?.limits);
		const limits = { ...resolved.meta.limits, ...invocationLimits };
		const args = {
			source: resolved.source,
			filename: resolved.filename,
			input: assertJson(input?.args ?? {}, { label: "Conveyor arguments" }),
		};
		const run = await context.launch(args, limits);
		return toolResult(projectRun(run), run?.status === "completed" ? "success" : "failure");
	} catch (error) {
		return toolResult(
			{
				error: error instanceof Error ? error.message : String(error),
			},
			"failure",
		);
	}
}

/** Keep tool output bounded to the native terminal envelope fields callers act on. @param {any} run */
function projectRun(run) {
	if (!run || typeof run !== "object" || Array.isArray(run)) return null;
	return {
		runId: run.runId,
		status: run.status,
		...(Object.hasOwn(run, "result") ? { result: run.result } : {}),
		...(run.failure != null ? { failure: run.failure } : {}),
		...(run.error != null ? { error: run.error } : {}),
		...(run.reason != null ? { reason: run.reason } : {}),
	};
}

/** Build the single Conveyor convenience tool. @param {ToolContext} context */
export function buildTools(context) {
	return [
		{
			name: "run_conveyor",
			defer: "never",
			description:
				"Resolve and execute one Conveyor harness using the native Agent Factory runtime. " +
				"Provide exactly one of script, scriptPath, or name. Factory limits, persistence, resume, " +
				"cancellation, progress, and results are native; use run_factory with resumeFromRunId and " +
				"factories_manage for later control and inspection.",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					script: {
						type: "string",
						description: "Inline plain JavaScript harness source.",
					},
					scriptPath: {
						type: "string",
						description: "Absolute or workspace-relative .mjs harness path.",
					},
					name: {
						type: "string",
						description: "Saved Conveyor name; nearest project definition wins, then user scope.",
					},
					args: {
						description: "Strict JSON value exposed as context.args.",
					},
					limits: {
						type: "object",
						additionalProperties: false,
						properties: {
							maxConcurrentSubagents: { type: "integer", minimum: 1 },
							maxTotalSubagents: { type: "integer", minimum: 1 },
							timeoutSeconds: { type: "number", exclusiveMinimum: 0 },
							maxAiCredits: { type: "number", exclusiveMinimum: 0 },
						},
						description: "Native Factory limit overrides.",
					},
				},
			},
			handler: (input) => runConveyor(input, context),
		},
	];
}

/** @param {unknown} value @param {"success"|"failure"} resultType */
function toolResult(value, resultType) {
	return {
		textResultForLlm: JSON.stringify(value),
		resultType,
		toolTelemetry: {
			extension: "conveyor",
			outcome: resultType,
		},
	};
}
