/**
 * @module tools
 *
 * SDK-free implementation of the workflow tools (`run_workflow`, `list_workflow_runs`). All host
 * interaction goes through an injected {@link ToolCtx} (`log` / `send` / `getWorkspaceCwd`), so this
 * module runs — and is tested — under plain `node`. `extension.mjs` supplies a `ctx` backed by the
 * real Copilot session and registers the tools returned by {@link buildTools}.
 */
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { executeWorkflow } from "./runtime.mjs";
import { formatDashboard } from "./progress.mjs";

export const DEFAULT_BUDGET = 10000;
export const XTREME_BUDGET = 1_000_000;
export const MAX_TIMEOUT_SEC = 7200;
const RUN_LIST_LIMIT = 50;
const PROGRESS_MODES = new Set(["dashboard", "events", "off"]);

const HOME = homedir();

/**
 * Host capabilities the tools need. Injected by `extension.mjs` (backed by the SDK session).
 * @typedef {object} ToolCtx
 * @property {(message: string, ephemeral?: boolean, level?: "info"|"warning"|"error") => void} log timeline logging
 * @property {(prompt: string) => void} send inject a turn to wake the agent (background completion)
 * @property {() => Promise<string | undefined>} getWorkspaceCwd session working directory
 */

/** @returns {string} */
const workflowsDir = () => process.env.CWF_WORKFLOWS_DIR || join(HOME, ".copilot/workflows");
/** @returns {string} */
export const runsDir = () => process.env.CWF_RUNS_DIR || join(workflowsDir(), "runs");
/** @param {string} p @returns {boolean} true when `p` is an existing regular file. */
const isFile = (p) => {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
};

/** In-flight runs, so callers can abort one by id. @type {Map<string, AbortController>} */
const LIVE_RUNS = new Map();

/** Abort an in-flight run by id. @param {string} runId @returns {boolean} true if a live run was aborted. */
export function abortRun(runId) {
	const ac = LIVE_RUNS.get(runId);
	if (!ac) return false;
	ac.abort();
	return true;
}
/** @param {string|undefined} p */
const expandHome = (p) => (p && p.startsWith("~/") ? join(HOME, p.slice(2)) : p);

export class ValidationError extends Error {}
/** @param {unknown} ok @param {string} msg @returns {asserts ok} */
function check(ok, msg) {
	if (!ok) throw new ValidationError(msg);
}
/** @param {string} message @param {string} [resultType] */
const failure = (message, resultType = "failure") => ({ textResultForLlm: `Error: ${message}`, resultType, error: message });

/** Resolve harness source text from exactly one of `script` / `scriptPath` / `name`. @param {any} input @returns {{ source: string, label: string }} */
export function resolveSource(input) {
	if (input.script) return { source: String(input.script), label: "inline harness" };
	if (input.scriptPath) {
		const p = /** @type {string} */ (expandHome(input.scriptPath));
		check(existsSync(p) && statSync(p).isFile(), `scriptPath is not a readable file: ${p}`);
		check(!p.endsWith(".py"), `Python workflows are no longer supported: ${p}. Convert it to .mjs; see the workflow skill's migration guide.`);
		check(p.endsWith(".mjs"), `scriptPath must point to a .mjs workflow: ${p}`);
		return { source: readFileSync(p, "utf8"), label: basename(p) };
	}
	check(!/[\\/]|\.\./.test(input.name), `name must be a bare workflow name without path separators (got '${input.name}').`);
	const mjs = join(workflowsDir(), `${input.name}.mjs`);
	if (isFile(mjs)) return { source: readFileSync(mjs, "utf8"), label: input.name };
	const py = [`${input.name}.cwf.py`, `${input.name}.py`].map((f) => join(workflowsDir(), f)).find(isFile);
	check(!py, `saved workflow '${input.name}' is a Python workflow (${py}). Convert it to ${input.name}.mjs; see the workflow skill's migration guide.`);
	throw new ValidationError(`no saved workflow named '${input.name}' in ${workflowsDir()} (looked for ${input.name}.mjs).`);
}

/** @param {string} label @returns {string} a fresh run id `<stem>-<ts>-<rand>`. */
function newRunId(label) {
	const stem = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "wf";
	const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
	return `${stem}-${ts}-${randomUUID().slice(0, 4)}`;
}

/**
 * Format a finished/dry-run {@link import("./runtime.mjs").RunRecord} into a tool result.
 * @param {any} rec
 * @param {{ runDir: string, cwd?: string, dryRun?: boolean }} ctx
 * @returns {string | { textResultForLlm: string, resultType: string, error: string }}
 */
function formatResult(rec, ctx) {
	const c = rec.counts || {};
	const text = [
		ctx.dryRun ? "workflow dry-run complete (no agents spawned, no AIC spent)" : `workflow run ${rec.status}`,
		`runId: ${rec.runId}`,
		`artifacts: ${ctx.runDir}`,
		ctx.dryRun ? "AIC used: 0.0" : `AIC used: ${Number(rec.aic || 0).toFixed(1)}`,
		`agents: ${c.agents ?? 0} (done ${c.done ?? 0}, cached ${c.cached ?? 0}, skipped ${c.skipped ?? 0}, failed ${c.failed ?? 0})`,
		ctx.cwd ? `cwd: ${ctx.cwd}` : "",
		rec.error ? `error: ${rec.error}` : "",
		rec.result ? `\n--- workflow result ---\n${rec.result}` : "",
	]
		.filter(Boolean)
		.join("\n");
	if (rec.status === "complete") return text;
	return { textResultForLlm: text, resultType: "failure", error: rec.error ?? rec.status };
}

/**
 * Resolve the working directory for a run (session workspace unless overridden).
 * @param {string|undefined} explicit
 * @param {ToolCtx} ctx
 * @returns {Promise<string>}
 */
async function resolveCwd(explicit, ctx) {
	let dir = expandHome(explicit);
	if (!dir) dir = (await ctx.getWorkspaceCwd()) || process.cwd();
	check(existsSync(dir), `cwd does not exist: ${dir}`);
	check(statSync(dir).isDirectory(), `cwd is not a directory: ${dir}`);
	return dir;
}

/**
 * `run_workflow` implementation.
 * @param {any} input
 * @param {ToolCtx} ctx
 */
export async function runWorkflow(input, ctx) {
	try {
		const sources = ["script", "scriptPath", "name"].filter((k) => input[k]);
		check(sources.length === 1, `provide EXACTLY ONE of script | scriptPath | name (got: ${sources.join(", ") || "none"}).`);
		check(input.concurrency == null || (Number.isInteger(input.concurrency) && input.concurrency >= 1), `concurrency must be an integer >= 1 (got ${input.concurrency}).`);
		check(!input.resume || !input.script, "resume requires scriptPath or name (the persisted harness), not an inline script.");
		const requestedTimeout = input.timeoutSec ?? 1800;
		check(typeof requestedTimeout === "number" && requestedTimeout >= 1, `timeoutSec must be a number >= 1 (got ${requestedTimeout}).`);
		const timeoutSec = Math.min(requestedTimeout, MAX_TIMEOUT_SEC);

		const preset = input.preset === "xtreme";
		const budget = input.dryRun ? input.budget ?? null : input.budget ?? (preset ? XTREME_BUDGET : DEFAULT_BUDGET);
		if (!input.dryRun) check(typeof budget === "number" && budget > 0, `budget must be a positive number for non-dry runs (got ${budget}).`);
		const progressMode = input.quiet ? "off" : input.progress ?? "dashboard";
		check(PROGRESS_MODES.has(progressMode), `progress must be one of dashboard | events | off (got ${progressMode}).`);

		const { source, label } = resolveSource(input);
		const cwd = await resolveCwd(input.cwd, ctx);
		if (input.runId) check(!/[\\/]|\.\./.test(input.runId), `runId must be a bare id without path separators (got '${input.runId}').`);
		const runId = input.resume || input.runId || newRunId(input.name || label);
		const runDir = join(runsDir(), runId);
		if (input.resume) check(existsSync(runDir) && statSync(runDir).isDirectory(), `workflow: no such run to resume: ${runId}`);

		/** @type {import("./runtime.mjs").ExecuteConfig} */
		const cfg = {
			source,
			args: input.args,
			runId,
			runDir,
			budget,
			model: input.model ?? (preset ? "auto" : null),
			effort: input.effort ?? (preset ? "xhigh" : null),
			context: input.context ?? (preset ? "long_context" : null),
			concurrency: input.concurrency ?? null,
			enableMcp: !!input.enableMcp,
			restricted: !!input.restricted,
			strictBudget: !!input.strictBudget,
			dryRun: !!input.dryRun,
			resume: !!input.resume,
			memoryPath: input.memory ? resolve(cwd, /** @type {string} */ (expandHome(input.memory))) : null,
			progressMode,
			cwd,
			title: input.name || undefined,
		};

		if (input.dryRun) {
			const rec = await executeWorkflow({ ...cfg, onLine: (m) => ctx.log(m, true) });
			return formatResult(rec, { runDir, cwd, dryRun: true });
		}

		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutSec * 1000);
		if (typeof timer.unref === "function") timer.unref();
		LIVE_RUNS.set(runId, ac);
		const onLine =
			progressMode === "off"
				? undefined
				: (/** @type {string} */ m, /** @type {any} */ level, /** @type {{ ephemeral?: boolean }|undefined} */ meta) => ctx.log(m, meta?.ephemeral ?? true, level);

		const background = input.background ?? true;
		if (!background) {
			ctx.log(`workflow: ${label} (budget ${budget} AIC, run ${runId}, cwd ${cwd})`);
			try {
				const rec = await executeWorkflow({ ...cfg, signal: ac.signal, onLine });
				return formatResult(rec, { runDir, cwd });
			} finally {
				clearTimeout(timer);
				LIVE_RUNS.delete(runId);
			}
		}

		// Background: the engine persists script.js/meta.json/state.json immediately, so `/workflow` and
		// list_workflow_runs work at once. Return now; wake the agent on completion. NOTE: an
		// extension reload aborts an in-host run — resume with the same runId if that happens.
		ctx.log(`workflow: ${label} started in background (budget ${budget} AIC, run ${runId})`);
		executeWorkflow({ ...cfg, signal: ac.signal, onLine })
			.then((rec) => notifyDone(rec, runDir, ctx))
			.catch((e) => notifyError(runId, e, runDir, ctx))
			.finally(() => {
				clearTimeout(timer);
				LIVE_RUNS.delete(runId);
			});
		return [
			"workflow run started in background",
			`runId: ${runId}`,
			`artifacts: ${runDir}`,
			`inspect while running: read ${join(runDir, "state.json")}`,
			`final result: ${join(runDir, "result.json")}`,
			"You will be notified when it completes.",
		].join("\n");
	} catch (e) {
		if (e instanceof ValidationError) return failure(e.message);
		ctx.log(`run_workflow internal error: ${e instanceof Error ? e.stack : e}`);
		return failure(`internal workflow extension error: ${e instanceof Error ? e.message : e}`);
	}
}

/** @param {any} rec @param {string} runDir @param {ToolCtx} ctx */
function notifyDone(rec, runDir, ctx) {
	const line = `workflow ${rec.runId} ${rec.status}: ${Number(rec.aic || 0).toFixed(1)} AIC, ${rec.counts?.done ?? 0} done / ${rec.counts?.failed ?? 0} failed. Result: ${join(runDir, "result.json")}`;
	ctx.log(line);
	ctx.send(line);
}

/** @param {string} runId @param {unknown} err @param {string} runDir @param {ToolCtx} ctx */
function notifyError(runId, err, runDir, ctx) {
	const line = `workflow ${runId} FAILED: ${err instanceof Error ? err.message : err}. Artifacts: ${runDir}`;
	ctx.log(line);
	ctx.send(line);
}

/** `list_workflow_runs` implementation — read persisted run artifacts, newest first. */
export function listWorkflowRuns() {
	const dir = runsDir();
	if (!existsSync(dir)) return `No workflow runs in ${dir}.`;
	const entries = listRunDirs(dir);
	const rows = [];
	for (const { name, d, mtime } of entries.slice(0, RUN_LIST_LIMIT)) {
		const meta = readJson(join(d, "meta.json")) || {};
		const rec = readJson(join(d, "run.json")) || readJson(join(d, "state.json")) || {};
		rows.push({
			runId: name,
			status: rec.status || "?",
			workflow: meta.workflow?.name || rec.workflow?.name || "",
			aic: Number(rec.aic || 0),
			updated: meta.updatedAt || rec.finishedAt || rec.updatedAt || new Date(mtime).toISOString(),
		});
	}
	if (!rows.length) return `No workflow runs in ${dir}.`;
	rows.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
	const header = `${"RUN ID".padEnd(30)} ${"STATUS".padEnd(9)} ${"WORKFLOW".padEnd(16)} ${"AIC".padStart(7)}  UPDATED`;
	const body = rows
		.map((r) => `${r.runId.slice(0, 30).padEnd(30)} ${String(r.status).padEnd(9)} ${String(r.workflow).slice(0, 16).padEnd(16)} ${r.aic.toFixed(1).padStart(7)}  ${r.updated}`)
		.join("\n");
	const footer = entries.length > RUN_LIST_LIMIT ? `\n(showing newest ${RUN_LIST_LIMIT} of ${entries.length} runs)` : "";
	return `${header}\n${body}${footer}`;
}

/** @param {string} dir @returns {{ name: string, d: string, mtime: number }[]} newest dirs first. */
function listRunDirs(dir) {
	const rows = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		if (!ent.isDirectory()) continue;
		const d = join(dir, ent.name);
		try {
			rows.push({ name: ent.name, d, mtime: runMtime(d) });
		} catch {
			// vanished while listing
		}
	}
	rows.sort((a, b) => b.mtime - a.mtime);
	return rows;
}

/** @param {string} d @returns {number} latest artifact mtime for a run dir. */
function runMtime(d) {
	let mtime = statSync(d).mtimeMs;
	for (const file of ["run.json", "state.json", "meta.json"]) {
		try {
			mtime = Math.max(mtime, statSync(join(d, file)).mtimeMs);
		} catch {
			// artifact may not exist yet
		}
	}
	return mtime;
}

/** @param {string} path @returns {any} parsed JSON or null. */
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

// ---- /workflow slash-command inspection (read-only; renders via ctx.log) ---------------------

/** @param {string} runId @returns {string|null} the run dir if it exists. */
function findRunDir(runId) {
	const d = join(runsDir(), runId);
	try {
		return existsSync(d) && statSync(d).isDirectory() ? d : null;
	} catch {
		return null;
	}
}

/** @returns {string|null} the most recently updated run id, or null. */
function latestRunId() {
	const dir = runsDir();
	if (!existsSync(dir)) return null;
	return listRunDirs(dir)[0]?.name || null;
}

/**
 * The best available record for a run: run.json, else state.json, else a progress.jsonl replay.
 * @param {string} runDir @returns {any}
 */
function runRecordOf(runDir) {
	return readJson(join(runDir, "run.json")) || readJson(join(runDir, "state.json")) || replayProgress(runDir);
}

/** Reconstruct a minimal record from progress.jsonl when state/run json are missing. @param {string} runDir */
function replayProgress(runDir) {
	const path = join(runDir, "progress.jsonl");
	if (!existsSync(path)) return null;
	let meta = {};
	let end = null;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const s = line.trim();
		if (!s) continue;
		let rec;
		try {
			rec = JSON.parse(s);
		} catch {
			continue;
		}
		if (rec.ev === "run_start") meta = rec.meta || {};
		else if (rec.ev === "run_end") end = rec;
	}
	if (!end) return { status: "running", workflow: meta, counts: null, aic: 0 };
	return { status: "complete", workflow: meta, counts: { agents: end.agents, launched: end.launched, done: end.done, failed: end.failed, cached: end.cached, skipped: end.skipped }, aic: Number(end.aic || 0) };
}

/**
 * @param {string} runId @param {any} rec @param {string} dir @returns {string}
 */
function formatRunSummary(runId, rec, dir) {
	const c = rec?.counts;
	return [
		`workflow run ${runId}`,
		`status: ${rec?.status ?? "?"}`,
		rec?.workflow?.name ? `workflow: ${rec.workflow.name}` : "",
		c ? `agents: ${c.agents} (done ${c.done}, cached ${c.cached}, skipped ${c.skipped}, failed ${c.failed})` : "",
		rec?.aic != null ? `AIC: ${Number(rec.aic).toFixed(1)}` : "",
		rec?.durationMs != null ? `duration: ${(rec.durationMs / 1000).toFixed(1)}s` : "",
		rec?.preservedWorktrees?.length ? `preserved worktrees: ${rec.preservedWorktrees.join(", ")}` : "",
		rec?.error ? `error: ${rec.error}` : "",
		`artifacts: ${dir}`,
		`result: ${join(dir, "result.json")}`,
	]
		.filter(Boolean)
		.join("\n");
}

/** @param {string} runId @param {string} dir @returns {string|null} dashboard text when state.json exists. */
function formatRunDashboard(runId, dir) {
	const state = readJson(join(dir, "state.json"));
	if (!state) return null;
	return formatDashboard({ ...state, runId: state.runId || runId });
}

/**
 * `/workflow`/`/wf` command dispatcher. Renders read-only run inspection via `ctx.log`.
 *   /wf | /wf latest | /wf <runId> | /wf runs | /wf result <id> | /wf artifacts <id>
 * @param {string} argsStr @param {ToolCtx} ctx
 */
export function workflowCommand(argsStr, ctx) {
	const parts = String(argsStr || "").trim().split(/\s+/).filter(Boolean);
	const sub = parts[0] || "latest";
	const log = (/** @type {string} */ s) => ctx.log(s);

	if (sub === "runs") return void log(listWorkflowRuns());

	if (sub === "result" || sub === "artifacts") {
		const id = parts[1] || latestRunId();
		if (!id) return void log("workflow: no workflow runs yet.");
		const dir = findRunDir(id);
		if (!dir) return void log(`workflow: no run found with id '${id}'. Try /workflow runs.`);
		if (sub === "result") {
			const r = readJson(join(dir, "result.json"));
			return void log(r ? r.result || "(no result text)" : "workflow: no result yet (run may still be in progress).");
		}
		const files = readdirSync(dir).sort().map((f) => `  ${join(dir, f)}`);
		return void log(`workflow artifacts for ${id}:\n${files.join("\n")}`);
	}

	const id = sub === "latest" ? latestRunId() : sub;
	if (!id) return void log("workflow: no workflow runs yet. Start one with run_workflow.");
	const dir = findRunDir(id);
	if (!dir) return void log(`workflow: no run found with id '${id}'. Try /workflow runs.`);
	log(formatRunDashboard(id, dir) || formatRunSummary(id, runRecordOf(dir), dir));
}

/**
 * Build the slash-command definitions for `joinSession({ commands })`.
 * @param {ToolCtx} ctx @returns {any[]}
 */
export function buildCommands(ctx) {
	const handler = async (/** @type {any} */ context) => {
		workflowCommand(context?.args || "", ctx);
	};
	return [
		{
			name: "workflow",
			description: "Inspect workflow runs: /workflow [runId] · /workflow runs · /workflow latest · /workflow result <id> · /workflow artifacts <id>",
			handler,
		},
		{
			name: "wf",
			description: "Alias for /workflow: inspect workflow runs with /wf [runId] · /wf runs · /wf result <id> · /wf artifacts <id>",
			handler,
		},
	];
}

/** @returns {boolean} true when running nested inside a workflow subagent (don't offer run_workflow). */
export function isNested() {
	const depth = Number.parseInt(process.env.CWF_DEPTH || "0", 10) || 0;
	const maxDepth = Number.parseInt(process.env.CWF_MAX_DEPTH || "1", 10) || 1;
	return process.env.CWF_DISABLE_WORKFLOW_TOOLS === "1" || depth >= maxDepth;
}

/**
 * Build the tool definitions to pass to `joinSession({ tools })`.
 * @param {ToolCtx} ctx
 * @returns {any[]}
 */
export function buildTools(ctx) {
	/** @type {any[]} */
	const tools = [
		{
			name: "list_workflow_runs",
			skipPermission: true,
			description: "List recent workflow runs (id, status, workflow, AIC) from persisted run artifacts. Use to find a runId to resume or inspect.",
			parameters: { type: "object", additionalProperties: false, properties: {} },
			handler: async () => listWorkflowRuns(),
		},
	];
	if (isNested()) return tools;
	tools.unshift({
		name: "run_workflow",
		defer: "never",
		description:
			"Run a Copilot Workflow dynamic workflow: a JavaScript (.mjs) harness that fans work out to many " +
			"`copilot` subagents in parallel (fan-out/synthesize, adversarial verify, tournament, " +
			"generate-and-filter, classify-and-route, loop-until-done). The harness (an async JS body " +
			"using injected globals: agent, parallel, fanOut, pipeline, phase, log, args, budget, memory) " +
			"owns the loop/branching; only the final `return` value comes back here. Use for large/parallel/" +
			"adversarial/cross-checked work (audits, deep research, ranking/triage) — NOT routine edits or " +
			"quick lookups. Spends AIC, so ALWAYS preview with dryRun:true first. Provide EXACTLY ONE of: " +
			"`script` (inline .mjs source), `scriptPath` (a .mjs file), or `name` (a saved workflow " +
			"in ~/.copilot/workflows). Non-dry runs default to background:true and notify on completion.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				script: { type: "string", description: "Inline .mjs harness source (async JS body using injected globals + `args`). One of script|scriptPath|name." },
				scriptPath: { type: "string", description: "Path to an existing .mjs harness on disk. One of script|scriptPath|name." },
				name: { type: "string", description: "Name of a saved workflow in ~/.copilot/workflows (resolves <name>.mjs). One of script|scriptPath|name." },
				args: { description: "Value exposed to the harness as the global `args`. Pass an actual JSON value (string/array/object), NOT a JSON-encoded string." },
				budget: { type: "number", exclusiveMinimum: 0, description: `Soft observed AIC cap. Default ${DEFAULT_BUDGET}, or ${XTREME_BUDGET} with preset='xtreme'. Required for non-dry runs.` },
				dryRun: { type: "boolean", description: "Plan only — run the harness with stubbed agents to show fan-out shape without spawning subagents or spending AIC. Preview here first." },
				resume: { type: "string", description: "RunId of a prior run to resume; unchanged agents return instantly from checkpoints. Pass the same scriptPath/name." },
				runId: { type: "string", description: "Explicit run id for a fresh run (default: auto-generated). Bare id, no path separators." },
				background: { type: "boolean", description: "Run asynchronously (default true for non-dry) and notify on completion. Set false for small/test runs that should return the final result inline." },
				model: { type: "string", description: "Default model agents inherit unless they pin their own (the harness's per-agent choice wins). Any Copilot model or 'auto'." },
				effort: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"], description: "Default reasoning effort agents inherit unless they pin their own." },
				context: { type: "string", enum: ["default", "long_context"], description: "Default context-window tier agents inherit unless they pin their own." },
				preset: { type: "string", enum: ["xtreme"], description: `Named run preset. 'xtreme' sets model=auto, effort=xhigh, context=long_context and a ${XTREME_BUDGET.toLocaleString("en-US")} AIC default budget.` },
				concurrency: { type: "integer", minimum: 1, description: "Max concurrent subagents (default min(16, max(2, cpu-1)))." },
				enableMcp: { type: "boolean", description: "Start subagents with built-in MCP servers enabled (default OFF; opt-in). Deny rules still win over allow." },
				restricted: { type: "boolean", description: "Run the harness determinism-only + orchestration-only (read-only memory, no worktree, no per-agent tool escalation). Footgun-prevention, not a security jail." },
				strictBudget: { type: "boolean", description: "Raise/stop once the budget cap is observed instead of gracefully skipping new agents." },
				memory: { type: "string", description: "Durable text file the harness reads/appends via `memory` (persists across runs; a relative path resolves against the workflow cwd, or use ~/)." },
				progress: { type: "string", enum: ["dashboard", "events", "off"], description: "Progress output mode. dashboard (default) emits ephemeral TUI-like snapshots, events emits per-event lines, off suppresses progress output." },
				quiet: { type: "boolean", description: "Suppress progress output (equivalent to progress:'off')." },
				cwd: { type: "string", description: "Directory to run the workflow from (default: the session's working directory)." },
				timeoutSec: { type: "number", minimum: 1, maximum: MAX_TIMEOUT_SEC, description: "Kill the run (and its subagents) after this many seconds (default 1800)." },
			},
		},
		handler: (/** @type {any} */ input) => runWorkflow(input, ctx),
	});
	return tools;
}
