/**
 * @module runs
 *
 * Read-only inspection of persisted workflow runs: listing recent runs, retrieving paginated final
 * results, replaying partial progress when final artifacts are missing, and rendering the
 * `/workflow` slash-command output.
 */
import { existsSync, lstatSync, statSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { formatDashboard, PROCESS_INSTANCE_ID } from "./progress.mjs";
import { FORMAT_VERSION } from "./persistence.mjs";

const RUN_LIST_LIMIT = 50;
const STATUS_WIDTH = 11;
const INSPECT_LIST_LIMIT = 50;
const INSPECT_LABEL_CHARS = 500;
const INSPECT_TEXT_CHARS = 2000;
const CTRL = /[\u0000-\u001f\u007f-\u009f]/g;
const HOME = homedir();

export const MAX_RESULT_CHUNK_CHARS = 32_000;

export class WorkflowResultError extends Error {}

/** @returns {string} */
export const workflowsDir = () => process.env.CWF_WORKFLOWS_DIR || join(HOME, ".copilot/workflows");
/** @returns {string} */
export const runsDir = () => process.env.CWF_RUNS_DIR || join(workflowsDir(), "runs");

/** @param {unknown} value @returns {value is string} */
export function isValidRunId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

/** `list_workflow_runs` implementation — read persisted run artifacts, newest first. */
export function listWorkflowRuns() {
	const dir = runsDir();
	if (!existsSync(dir)) return `No workflow runs in ${dir}.`;
	const entries = listRunDirs(dir);
	const rows = [];
	for (const { name, d, mtime } of entries.slice(0, RUN_LIST_LIMIT)) {
		const meta = readJson(join(d, "meta.json")) || {};
		const rec = runRecordOf(d) || {};
		rows.push({
			runId: name,
			status: rec.status || "?",
			workflow: workflowName(meta, rec),
			aic: Number(rec.aic || 0),
			updated: rec.finishedAt || rec.updatedAt || meta.updatedAt || new Date(mtime).toISOString(),
		});
	}
	if (!rows.length) return `No workflow runs in ${dir}.`;
	rows.sort((a, b) => timestampMs(b.updated) - timestampMs(a.updated));
	const header = `${"RUN ID".padEnd(30)} ${"STATUS".padEnd(STATUS_WIDTH)} ${"WORKFLOW".padEnd(16)} ${"AIC".padStart(7)}  UPDATED`;
	const body = rows
		.map((r) => `${r.runId.slice(0, 30).padEnd(30)} ${String(r.status).padEnd(STATUS_WIDTH)} ${String(r.workflow).slice(0, 16).padEnd(16)} ${r.aic.toFixed(1).padStart(7)}  ${r.updated}`)
		.join("\n");
	const footer = entries.length > RUN_LIST_LIMIT ? `\n(showing newest ${RUN_LIST_LIMIT} of ${entries.length} runs)` : "";
	return `${header}\n${body}${footer}`;
}

/** @param {unknown} value @returns {number} */
function timestampMs(value) {
	const parsed = Date.parse(String(value || ""));
	return Number.isNaN(parsed) ? 0 : parsed;
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
		if (!lstatSync(path).isFile()) return null;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** @param {any} meta @param {any} rec @returns {string} */
function workflowName(meta, rec) {
	const explicit = meta.workflow?.name || meta.name || rec.workflow?.name || rec.name || rec.title;
	return explicit ? String(explicit) : "";
}

/** @param {string} runId @returns {string|null} the run dir if it exists. */
function findRunDir(runId) {
	if (!isValidRunId(runId)) return null;
	const d = join(runsDir(), runId);
	try {
		return existsSync(d) && lstatSync(d).isDirectory() ? d : null;
	} catch {
		return null;
	}
}

/** @param {unknown} value @returns {number|null} */
function finiteNumber(value) {
	const n = Number(value);
	return value == null || !Number.isFinite(n) ? null : n;
}

/** @param {unknown} value @returns {string|null} */
function resultError(value) {
	if (value == null) return null;
	const text = String(value);
	return text.length > 2000 ? `${text.slice(0, 1997)}...` : text;
}

/** @param {unknown} value @param {number} [max] @returns {string|null} */
function inspectString(value, max = INSPECT_TEXT_CHARS) {
	if (value == null) return null;
	const text = String(value).replace(CTRL, " ");
	return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

/** @param {unknown} value @returns {number|null} */
function inspectInteger(value) {
	const n = Number(value);
	return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** @param {unknown} value @returns {Record<string, number|null>} */
function inspectCounts(value) {
	const counts = value && typeof value === "object" && !Array.isArray(value) ? /** @type {any} */ (value) : {};
	return Object.fromEntries(
		["agents", "launched", "done", "failed", "cached", "skipped", "dropped", "unknownUsage"].map((key) => [key, inspectInteger(counts[key])]),
	);
}

/** @param {unknown} value @returns {{ total: number|null, spent: number|null, remaining: number|null, hit: boolean }|null} */
function inspectBudget(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const budget = /** @type {any} */ (value);
	return {
		total: finiteNumber(budget.total),
		spent: finiteNumber(budget.spent),
		remaining: finiteNumber(budget.remaining),
		hit: budget.hit === true,
	};
}

/** @param {unknown} value @returns {any[]} */
function inspectRunning(value) {
	if (!Array.isArray(value)) return [];
	return value.slice(0, INSPECT_LIST_LIMIT).map((item) => ({
		seq: inspectInteger(item?.seq),
		label: inspectString(item?.label, INSPECT_LABEL_CHARS),
		model: inspectString(item?.model, INSPECT_LABEL_CHARS),
		phase: inspectString(item?.phase, INSPECT_LABEL_CHARS),
		branchPath: inspectString(item?.branchPath, 256) || "/",
	}));
}

/** @param {unknown} value @returns {any[]} */
function inspectGroups(value) {
	if (!Array.isArray(value)) return [];
	return value.slice(0, INSPECT_LIST_LIMIT).map((item) => ({
		gid: inspectInteger(item?.gid),
		kind: inspectString(item?.kind, INSPECT_LABEL_CHARS),
		phase: inspectString(item?.phase, INSPECT_LABEL_CHARS),
		n: inspectInteger(item?.n),
	}));
}

/** @param {unknown} value @returns {any[]} */
function inspectRecent(value) {
	if (!Array.isArray(value)) return [];
	return value.slice(0, INSPECT_LIST_LIMIT).map((item) => ({
		label: inspectString(item?.label, INSPECT_LABEL_CHARS),
		status: inspectString(item?.status, 64),
		aic: finiteNumber(item?.aic),
		error: inspectString(item?.error),
	}));
}

/** @param {unknown} value @returns {any[]} */
function inspectErrors(value) {
	if (!Array.isArray(value)) return [];
	return value.slice(0, INSPECT_LIST_LIMIT).map((item) => ({
		label: inspectString(item?.label, INSPECT_LABEL_CHARS),
		error: inspectString(item?.error),
	}));
}

/** @param {unknown} value @returns {string[]} */
function inspectPaths(value) {
	if (!Array.isArray(value)) return [];
	return value
		.slice(0, INSPECT_LIST_LIMIT)
		.map((item) => inspectString(item))
		.filter((item) => item !== null);
}

/** @param {unknown} branch @returns {string|null} */
function branchPath(branch) {
	return Array.isArray(branch) && branch.every((part) => Number.isSafeInteger(part) && part >= 0) ? (branch.length ? `/${branch.join("/")}` : "/") : null;
}

/** @param {any[]} records */
function inspectInvalidations(records) {
	return records
		.filter((record) => record?.type === "control" && record.action === "branches_invalidated")
		.slice(-INSPECT_LIST_LIMIT)
		.map((record) => ({
			generation: inspectInteger(record.generation),
			branches: Array.isArray(record.branches) ? record.branches.map(branchPath).filter(Boolean) : [],
			invalidatedAt: inspectString(record.invalidatedAt, 128),
		}));
}

/** @param {...unknown} values @returns {string} */
function resultStatus(...values) {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const text = value.trim();
		if (text) return text.slice(0, 64);
	}
	return "unknown";
}

/** @param {unknown} value @param {string} name @returns {number} */
function resultInteger(value, name) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new WorkflowResultError(`${name} must be a non-negative safe integer.`);
	}
	return value;
}

/**
 * Slice text for bounded tool/notification output.
 * @param {string} text @param {number} offset @param {number} limit
 * @returns {{ text: string, nextOffset: number|null }}
 */
export function pageText(text, offset, limit) {
	const start = Math.min(offset, text.length);
	const end = Math.min(start + limit, text.length);
	return {
		text: text.slice(start, end),
		nextOffset: end < text.length ? end : null,
	};
}

/** @param {string} runId @param {string} resultPath @returns {any|undefined} */
function readResultArtifact(runId, resultPath) {
	let raw;
	try {
		const stat = lstatSync(resultPath);
		if (!stat.isFile()) throw new WorkflowResultError(`workflow result for '${runId}' is not a regular file.`);
		raw = readFileSync(resultPath, "utf8");
	} catch (e) {
		if (e instanceof WorkflowResultError) throw e;
		if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return undefined;
		throw new WorkflowResultError(`workflow result for '${runId}' could not be read: ${e instanceof Error ? e.message : e}`);
	}
	try {
		return JSON.parse(raw);
	} catch {
		throw new WorkflowResultError(`workflow result for '${runId}' is malformed JSON.`);
	}
}

/**
 * Load the canonical persisted result state for a workflow run.
 * @param {unknown} requestedRunId
 * @returns {{ runId: string, status: string, error: string|null, aic: number|null, result: string|null }}
 */
export function loadWorkflowResult(requestedRunId) {
	if (!isValidRunId(requestedRunId)) throw new WorkflowResultError("runId must be a bare workflow run id (1-255 characters, no path separators).");
	const runId = requestedRunId;
	const dir = findRunDir(runId);
	if (!dir) throw new WorkflowResultError(`no workflow run found with id '${runId}'. Use list_workflow_runs to find a runId.`);
	const rec = runRecordOf(dir);
	const artifact = readResultArtifact(runId, join(dir, "result.json"));
	if (artifact === undefined) {
		return {
			runId,
			status: resultStatus(rec?.status),
			error: resultError(rec?.error),
			aic: finiteNumber(rec?.aic),
			result: null,
		};
	}
	if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
		throw new WorkflowResultError(`workflow result for '${runId}' must be a JSON object.`);
	}
	if (artifact.runId != null && artifact.runId !== runId) {
		throw new WorkflowResultError(`workflow result artifact id does not match requested run '${runId}'.`);
	}
	if (typeof artifact.result !== "string") {
		throw new WorkflowResultError(`workflow result for '${runId}' has a non-string result.`);
	}
	return {
		runId,
		status: resultStatus(artifact.status, rec?.status),
		error: resultError(rec?.error),
		aic: finiteNumber(artifact.aic) ?? finiteNumber(rec?.aic),
		result: artifact.result,
	};
}

/**
 * `get_workflow_result` implementation. Returns JSON so pagination metadata remains machine-readable.
 * @param {{ runId?: unknown, offset?: unknown, limit?: unknown }} input
 * @returns {string}
 */
export function getWorkflowResult(input) {
	const offset = resultInteger(input?.offset ?? 0, "offset");
	const limit = resultInteger(input?.limit ?? MAX_RESULT_CHUNK_CHARS, "limit");
	if (limit < 1 || limit > MAX_RESULT_CHUNK_CHARS) {
		throw new WorkflowResultError(`limit must be between 1 and ${MAX_RESULT_CHUNK_CHARS} characters.`);
	}
	const loaded = loadWorkflowResult(input?.runId);
	if (loaded.result === null) {
		const mayStillFinish = loaded.status === "running" || loaded.status === "unknown";
		return JSON.stringify(
			{
				...loaded,
				resultAvailable: false,
				guidance: mayStillFinish
					? "Result is not available yet. Wait for the workflow completion notification; do not poll this tool."
					: `The run is ${loaded.status} and has no result artifact. Waiting will not produce one; inspect /workflow ${loaded.runId} or resume/re-run the workflow.`,
			},
			null,
			2,
		);
	}

	const page = pageText(loaded.result, offset, limit);
	return JSON.stringify(
		{
			...loaded,
			resultAvailable: true,
			result: page.text,
			offset,
			nextOffset: page.nextOffset,
		},
		null,
		2,
	);
}

/**
 * `inspect_workflow_run` implementation. Returns bounded JSON metadata without result text or args.
 * String fields originate from workflow-provided data and must be treated as untrusted.
 * @param {{ runId?: unknown }} input
 * @returns {string}
 */
export function inspectWorkflowRun(input) {
	const requestedRunId = input?.runId;
	if (!isValidRunId(requestedRunId)) throw new WorkflowResultError("runId must be a bare workflow run id (1-255 characters, no path separators).");
	const runId = requestedRunId;
	const dir = findRunDir(runId);
	if (!dir) throw new WorkflowResultError(`no workflow run found with id '${runId}'. Use list_workflow_runs to find a runId.`);

	const meta = readJson(join(dir, "meta.json")) || {};
	const manifest = readJson(join(dir, "manifest.json")) || {};
	const state = readJson(join(dir, "state.json")) || {};
	const rec = runRecordOf(dir) || {};
	const journal = readJsonl(join(dir, "journal.jsonl"));
	const status = resultStatus(rec.status, state.status);
	let result;
	try {
		const loaded = loadWorkflowResult(runId);
		result = { available: loaded.result !== null, status: inspectString(loaded.status, 64) };
	} catch (e) {
		if (!(e instanceof WorkflowResultError)) throw e;
		result = { available: false, error: inspectString(e.message) };
	}

	const workflow = inspectString(workflowName(meta, rec), INSPECT_LABEL_CHARS);
	const resumable = status !== "running" && manifest.formatVersion === FORMAT_VERSION && existsSync(join(dir, "script.js"));
	return JSON.stringify(
		{
			runId,
			status,
			workflow: workflow || null,
			title: inspectString(rec.title ?? state.title ?? workflow, INSPECT_LABEL_CHARS),
			phase: inspectString(state.phase ?? rec.phase, INSPECT_LABEL_CHARS),
			backend: inspectString(manifest.backend, 64),
			permissionMode: inspectString(manifest.permissionMode, 128),
			parentPermissionMode: inspectString(manifest.parentPermissionMode, 32),
			parentSessionMode: inspectString(manifest.parentSessionMode, 32),
			permissionInheritance:
				manifest.permissionInheritance && typeof manifest.permissionInheritance === "object" && !Array.isArray(manifest.permissionInheritance)
					? Object.fromEntries(
							Object.entries(manifest.permissionInheritance)
								.slice(0, 20)
								.map(([key, value]) => [inspectString(key, 128), inspectString(value, 256)]),
						)
					: null,
			resumable,
			controlActions: status === "running" ? ["pause", "cancel"] : resumable ? ["resume"] : [],
			timing: {
				startedAt: inspectString(rec.startedAt ?? state.startedAt, 128),
				updatedAt: inspectString(state.updatedAt ?? rec.updatedAt ?? meta.updatedAt, 128),
				finishedAt: inspectString(rec.finishedAt, 128),
				durationMs: finiteNumber(rec.durationMs),
			},
			aic: finiteNumber(rec.aic) ?? finiteNumber(state.aic),
			budget: inspectBudget(rec.budget),
			counts: inspectCounts(rec.counts ?? state.counts),
			running: status === "running" ? inspectRunning(state.running) : [],
			groups: status === "running" ? inspectGroups(state.groups) : [],
			recent: inspectRecent(state.recent),
			errors: inspectErrors(state.errors),
			error: inspectString(rec.error ?? state.error),
			invalidations: inspectInvalidations(journal),
			branchPathFormat: "/ is the root; /0 and /0/2 identify nested parallel or pipeline item branches.",
			preservedWorktrees: inspectPaths(rec.preservedWorktrees),
			preservedSessions: inspectPaths(rec.preservedSessions),
			result,
			artifactsDir: inspectString(dir),
		},
		null,
		2,
	);
}

/**
 * Inspect one workflow agent from the typed journal.
 * @param {{ runId?: unknown, agent?: unknown, section?: unknown, offset?: unknown, limit?: unknown }} input
 */
export function inspectWorkflowAgent(input) {
	const runId = input?.runId;
	if (!isValidRunId(runId)) throw new WorkflowResultError("runId must be a bare workflow run id (1-255 characters, no path separators).");
	const dir = findRunDir(runId);
	if (!dir) throw new WorkflowResultError(`no workflow run found with id '${runId}'. Use list_workflow_runs to find a runId.`);
	const agent = String(input?.agent || "").trim();
	if (!agent) throw new WorkflowResultError("agent must be a journal key, sessionId, or label.");
	const section = String(input?.section || "summary");
	if (!["summary", "prompt", "result", "events", "usage"].includes(section)) throw new WorkflowResultError("section must be summary, prompt, result, events, or usage.");
	const offset = resultInteger(input?.offset ?? 0, "offset");
	const limit = resultInteger(input?.limit ?? MAX_RESULT_CHUNK_CHARS, "limit");
	if (limit < 1 || limit > MAX_RESULT_CHUNK_CHARS) throw new WorkflowResultError(`limit must be between 1 and ${MAX_RESULT_CHUNK_CHARS} characters.`);

	const records = readJsonl(join(dir, "journal.jsonl"));
	const keys = new Set();
	for (const record of records) {
		if (record.key === agent || record.label === agent || record.sessionId === agent || record.result?.label === agent || record.result?.sessionId === agent) keys.add(record.key);
	}
	if (!keys.size) throw new WorkflowResultError(`no workflow agent matched '${agent}' in run '${runId}'.`);
	const selected = records.filter((record) => keys.has(record.key));
	const started = selected.filter((record) => record.type === "agent_started").at(-1);
	const resultRecord = selected.filter((record) => record.type === "result").at(-1);
	const usage = selected.filter((record) => record.type === "usage");
	const result = resultRecord?.result;
	if (section === "summary") {
		return JSON.stringify(
			{
				runId,
				key: started?.key ?? resultRecord?.key ?? usage[0]?.key,
				branchPath: inspectString(started?.branchPath, 256) || branchPath(started?.branch) || "/",
				label: inspectString(started?.label ?? result?.label, INSPECT_LABEL_CHARS),
				sessionId: inspectString(result?.sessionId ?? usage.at(-1)?.sessionId, 255),
				model: inspectString(result?.model ?? started?.model, INSPECT_LABEL_CHARS),
				outcome: usage.at(-1)?.outcome ?? (result?.ok ? "ok" : null),
				aic: finiteNumber(usage.reduce((sum, record) => sum + (finiteNumber(record.aic) || 0), 0)),
				usageUnknown: usage.some((record) => record.usageUnknown),
				attempts: usage.length,
				hasPrompt: typeof started?.prompt === "string",
				hasResult: typeof result?.content === "string",
			},
			null,
			2,
		);
	}
	if (section === "usage") return JSON.stringify({ runId, agent, usage }, null, 2);
	const text =
		section === "prompt"
			? String(started?.prompt ?? "")
			: section === "result"
				? String(result?.content ?? "")
				: readAgentEvents(dir, started?.label ?? result?.label);
	const page = pageText(text, offset, limit);
	return JSON.stringify({ runId, agent, section, text: page.text, offset, nextOffset: page.nextOffset }, null, 2);
}

/** @param {string} path */
function readJsonl(path) {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.flatMap((line) => {
				try {
					return [JSON.parse(line)];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

/** @param {string} dir @param {unknown} label */
function readAgentEvents(dir, label) {
	const expected = String(label || "");
	return readJsonl(join(dir, "progress.jsonl"))
		.filter((event) => !expected || event.label === expected)
		.map((event) => JSON.stringify(event))
		.join("\n");
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
	return reconcileRunning(readJson(join(runDir, "run.json")) || readJson(join(runDir, "state.json")) || replayProgress(runDir));
}

/**
 * A process exit cannot finish asynchronous workflow cleanup, so persisted state may still say
 * `running`. New records carry an owner PID + process-instance id; legacy records fall back to the
 * maximum supported run timeout plus a small grace period.
 * @param {any} rec
 * @returns {any}
 */
function reconcileRunning(rec) {
	if (!rec || rec.status !== "running") return rec;
	const pid = Number(rec.ownerPid);
	if (!Number.isInteger(pid) || pid <= 0) return rec;
	const interrupted = (pid === process.pid && rec.ownerInstanceId !== PROCESS_INSTANCE_ID) || !processIsAlive(pid);
	if (!interrupted) return rec;
	return {
		...rec,
		status: "interrupted",
		error: rec.error || "workflow host process exited before completion",
	};
}

/** @param {number} pid @returns {boolean} */
function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
	}
}

/** Reconstruct a minimal record from progress.jsonl when state/run json are missing. @param {string} runDir */
function replayProgress(runDir) {
	const path = join(runDir, "progress.jsonl");
	if (!existsSync(path)) return null;
	/** @type {any} */
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
		if (rec.ev === "run_start") meta = { ...(rec.meta || {}) };
		else if (rec.ev === "run_end") end = rec;
	}
	if (!end) return { status: "running", workflow: meta, counts: null, aic: 0 };
	const nanoAiu = Number(end.nanoAiu ?? 0);
	return {
		status: end.status || "complete",
		error: end.error || null,
		workflow: meta,
		counts: { agents: end.agents, launched: end.launched, done: end.done, failed: end.failed, cached: end.cached, skipped: end.skipped, dropped: end.dropped || 0 },
		aic: end.aic != null ? Number(end.aic || 0) : nanoAiu / 1_000_000_000,
		updatedAt: progressTimestamp(end.t),
	};
}

/** @param {unknown} value epoch milliseconds, as every progress event records. */
function progressTimestamp(value) {
	if (value == null) return undefined;
	const raw = Number(value);
	if (!Number.isFinite(raw)) return undefined;
	const date = new Date(raw);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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
		c ? `agents: ${c.agents} (done ${c.done}, cached ${c.cached}, skipped ${c.skipped}, failed ${c.failed}, dropped ${c.dropped || 0})` : "",
		rec?.aic != null ? `AIC: ${Number(rec.aic).toFixed(1)}` : "",
		rec?.durationMs != null ? `duration: ${(rec.durationMs / 1000).toFixed(1)}s` : "",
		rec?.preservedWorktrees?.length ? `preserved worktrees: ${rec.preservedWorktrees.join(", ")}` : "",
		rec?.preservedSessions?.length ? `preserved sessions: ${rec.preservedSessions.join(", ")}` : "",
		rec?.error ? `error: ${rec.error}` : "",
		`artifacts: ${dir}`,
		`result: ${join(dir, "result.json")}`,
	]
		.filter(Boolean)
		.join("\n");
}

/** @param {string} runId @param {string} dir @returns {string|null} dashboard text when state.json exists. */
function formatRunDashboard(runId, dir) {
	const state = reconcileRunning(readJson(join(dir, "state.json")));
	if (!state) return null;
	return formatDashboard({ ...state, runId: state.runId || runId });
}

/**
 * `/workflow`/`/wf` command dispatcher. Renders read-only run inspection via `ctx.log`.
 *   /wf | /wf latest | /wf <runId> | /wf runs | /wf result <id> | /wf artifacts <id>
 * @param {string} argsStr @param {{ log: (message: string, ephemeral?: boolean, level?: "info"|"warning"|"error") => void }} ctx
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
			try {
				const loaded = loadWorkflowResult(id);
				return void log(loaded.result !== null ? loaded.result || "(no result text)" : "workflow: no result yet (run may still be in progress).");
			} catch (e) {
				if (e instanceof WorkflowResultError) return void log(`workflow: ${e.message}`);
				throw e;
			}
		}
		const files = readdirSync(dir).sort().map((f) => `  ${join(dir, f)}`);
		return void log(`workflow artifacts for ${id}:\n${files.join("\n")}`);
	}

	const id = sub === "latest" ? latestRunId() : sub;
	if (!id) return void log("workflow: no workflow runs yet. Start one with run_copilot_workflow.");
	const dir = findRunDir(id);
	if (!dir) return void log(`workflow: no run found with id '${id}'. Try /workflow runs.`);
	log(formatRunDashboard(id, dir) || formatRunSummary(id, runRecordOf(dir), dir));
}
