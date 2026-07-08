/**
 * @module runs
 *
 * Read-only inspection of persisted workflow runs: listing recent runs, replaying partial progress
 * when final artifacts are missing, and rendering the `/workflow` slash-command output.
 */
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

import { formatDashboard } from "./progress.mjs";

const RUN_LIST_LIMIT = 50;
const HOME = homedir();

/** @returns {string} */
const workflowsDir = () => process.env.CWF_WORKFLOWS_DIR || join(HOME, ".copilot/workflows");
/** @returns {string} */
export const runsDir = () => process.env.CWF_RUNS_DIR || join(workflowsDir(), "runs");

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
			updated: meta.updatedAt || meta.updated_at || rec.finishedAt || rec.updatedAt || new Date(mtime).toISOString(),
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

/** @param {any} meta @param {any} rec @returns {string} */
function workflowName(meta, rec) {
	const explicit = meta.workflow?.name || meta.name || rec.workflow?.name || rec.name;
	if (explicit) return String(explicit);
	const harness = meta.harness || rec.harness || rec.workflow?.harness;
	return harness ? basename(String(harness)).replace(/(?:\.cwf)?\.(?:mjs|py)$/i, "") : "";
}

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
		if (rec.ev === "run_start") meta = { ...(rec.meta || {}), harness: rec.harness || rec.meta?.harness || "" };
		else if (rec.ev === "run_end") end = rec;
	}
	if (!end) return { status: "running", workflow: meta, harness: meta.harness || "", counts: null, aic: 0 };
	const aic = end.aic != null ? Number(end.aic || 0) : Number(end.nano_aiu || end.nanoAiu || 0) / 1_000_000_000;
	const updatedAt = typeof end.t === "number" ? new Date(end.t * 1000).toISOString() : undefined;
	return { status: "complete", workflow: meta, harness: meta.harness || "", counts: { agents: end.agents, launched: end.launched, done: end.done, failed: end.failed, cached: end.cached, skipped: end.skipped }, aic, updatedAt };
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
