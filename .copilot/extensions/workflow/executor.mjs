/**
 * @module executor
 *
 * Run lifecycle for one workflow: prepare artifacts, build runtime dependencies, execute the harness
 * in dry-run or real mode, drain/cleanup, and persist the final record.
 */
import vm from "node:vm";
import { writeFileSync, mkdirSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";

import { Runtime } from "./runtime.mjs";
import { CheckpointStore } from "./checkpoint.mjs";
import { Memory } from "./memory.mjs";
import { ProgressReporter } from "./progress.mjs";
import { runHarness, deterministicGlobals } from "./sandbox.mjs";
import { loadHost } from "./effects.mjs";
import { BudgetExceeded } from "./scheduler.mjs";

/**
 * Strip ESM `export` keywords so the harness runs as VM script text (it cannot import extension
 * internals). `export const meta = …` becomes `const meta = …`.
 * @param {string} source
 * @returns {string}
 */
export function stripExports(source) {
	return source
		.replace(/^(\s*)export\s+default\s+/gm, "$1")
		.replace(/^(\s*)export\s+(?=(?:const|let|var|function|class|async))/gm, "$1");
}

/**
 * Extract and validate the harness's `meta` object as a pure literal (before any agent runs).
 * Evaluates only the object literal in a fresh deterministic context; returns `{}` on any error.
 * @param {string} source
 * @returns {{ name?: string, description?: string, phases?: any[] }}
 */
export function extractMeta(source) {
	const m = /(?:^|\n)\s*(?:export\s+)?const\s+meta\s*=\s*\{/.exec(source);
	if (!m) return {};
	const open = source.indexOf("{", m.index);
	let depth = 0;
	let end = -1;
	for (let i = open; i < source.length; i++) {
		const c = source[i];
		if (c === "{") depth++;
		else if (c === "}" && --depth === 0) {
			end = i;
			break;
		}
	}
	if (end < 0) return {};
	const literal = source.slice(open, end + 1);
	try {
		const ctx = vm.createContext(deterministicGlobals(), { codeGeneration: { strings: false, wasm: false } });
		const value = new vm.Script(`(${literal})`).runInContext(ctx, { timeout: 200 });
		if (!value || typeof value !== "object") return {};
		/** @type {{ name?: string, description?: string, phases?: any[] }} */
		const meta = {};
		if (typeof value.name === "string") meta.name = value.name;
		if (typeof value.description === "string") meta.description = value.description;
		if (Array.isArray(value.phases)) meta.phases = value.phases;
		return meta;
	} catch {
		return {};
	}
}

/**
 * @typedef {object} ExecuteConfig
 * @property {string} source        raw `.mjs` text
 * @property {unknown} [args]
 * @property {string} runId
 * @property {string} runDir
 * @property {number|null} [budget]
 * @property {string|null} [model]
 * @property {string|null} [effort]
 * @property {string|null} [context]
 * @property {number|null} [concurrency]
 * @property {boolean} [enableMcp]
 * @property {boolean} [restricted]
 * @property {boolean} [strictBudget]
 * @property {boolean} [dryRun]
 * @property {boolean} [resume]
 * @property {string|null} [memoryPath]
 * @property {string|null} [hostPath]
 * @property {string} [cwd]
 * @property {string|null} [repoRoot]
 * @property {AbortSignal} [signal]
 * @property {(line: string, level?: "info"|"warning"|"error", meta?: { ephemeral?: boolean }) => void} [onLine]
 * @property {"dashboard"|"events"|"off"} [progressMode]
 * @property {string} [title]
 */

/**
 * @typedef {object} RunRecord
 * @property {string} runId
 * @property {RunStatus} status
 * @property {string|null} error
 * @property {object} workflow
 * @property {unknown} args
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {number} durationMs
 * @property {{ total: number|null, spent: number, remaining: number, hit: boolean }} budget
 * @property {number} aic
 * @property {{ agents: number, launched: number, done: number, failed: number, cached: number, skipped: number }} counts
 * @property {string[]} preservedWorktrees
 * @property {string} result
 */
/** @typedef {import("./progress.mjs").RunStatus} RunStatus */

/**
 * Run one workflow end to end, persisting artifacts. Never rejects for harness failure: a crash is
 * caught, persisted with an `error` status, and returned as a {@link RunRecord}.
 * @param {ExecuteConfig} cfg
 * @returns {Promise<RunRecord>}
 */
export async function executeWorkflow(cfg) {
	const meta = extractMeta(cfg.source);
	const title = cfg.title || meta.name || basename(cfg.runDir);
	const onLine = cfg.onLine || (() => {});
	const startedAt = Date.now();

	// --- dry run: execute the harness with stubbed agents, persist nothing, return the plan. ---
	if (cfg.dryRun) {
		const rt = new Runtime({ ...runtimeOpts(cfg), dryRun: true, checkpoints: null, memory: new Memory(cfg.memoryPath, { readOnly: true, log: onLine }), progress: () => {}, log: onLine });
		let error = null;
		try {
			if (cfg.hostPath && !cfg.restricted) rt.setHost(await loadHost(cfg.hostPath));
			await runHarness(stripExports(cfg.source), { api: rt.buildApi(cfg.args), filename: `${cfg.runId}.mjs`, log: onLine });
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		await rt.drain();
		const preservedWorktrees = await rt.cleanup();
		return finalize({
			runId: cfg.runId,
			status: error ? "error" : "complete",
			error,
			meta,
			args: cfg.args,
			startedAt,
			rt,
			result: `dry-run plan: ${rt.agentCount} agent call(s)` + (meta.name ? ` — ${meta.name}` : ""),
			preservedWorktrees,
		});
	}

	// --- real run ---
	mkdirSync(cfg.runDir, { recursive: true });
	writeFileSync(join(cfg.runDir, "script.js"), cfg.source, "utf8");
	if (cfg.hostPath && !cfg.restricted) {
		try {
			copyFileSync(cfg.hostPath, join(cfg.runDir, "host.js")); // provenance copy alongside script.js
		} catch {
			// non-fatal: the sidecar is still loaded from cfg.hostPath below
		}
	}
	writeMeta(cfg.runDir, cfg.runId, meta, cfg.args, !!cfg.restricted);

	const reporter = new ProgressReporter({
		jsonlPath: join(cfg.runDir, "progress.jsonl"),
		statePath: join(cfg.runDir, "state.json"),
		runId: cfg.runId,
		meta,
		title,
		onLine,
		dashboard: cfg.progressMode === "dashboard",
	});
	const checkpoints = new CheckpointStore(cfg.runDir, { resume: !!cfg.resume });
	// Memory is writable in a real run even under `restricted`: the runtime owns the file I/O, so a
	// restricted harness may still persist cross-run state.
	const memory = new Memory(cfg.memoryPath, { readOnly: false, log: (m) => onLine(m, "info", { ephemeral: true }) });
	const abortController = new AbortController();
	if (cfg.signal) {
		if (cfg.signal.aborted) abortController.abort();
		else cfg.signal.addEventListener("abort", () => abortController.abort(), { once: true });
	}
	const rt = new Runtime({
		...runtimeOpts(cfg),
		checkpoints,
		memory,
		abortController,
		progress: (e) => reporter.emit(e),
		log: (m) => onLine(m, "info", { ephemeral: true }),
	});

	reporter.emit({ ev: "run_start", runId: cfg.runId, meta });
	let status = /** @type {RunStatus} */ ("complete");
	let error = null;
	let result = "";
	try {
		if (cfg.hostPath && !cfg.restricted) rt.setHost(await loadHost(cfg.hostPath));
		const value = await runHarness(stripExports(cfg.source), { api: rt.buildApi(cfg.args), filename: `${cfg.runId}.mjs`, log: (m) => rt.log(m) });
		result = coerceResult(value);
	} catch (e) {
		if (e instanceof BudgetExceeded) {
			status = "complete";
			onLine(`  budget reached: ${e.message}`, "warning", { ephemeral: false });
		} else {
			status = "error";
			error = e instanceof Error ? e.message : String(e);
			onLine(`  ! workflow error: ${error}`, "error", { ephemeral: false });
		}
	}
	if (cfg.signal?.aborted) status = "timeout";

	await rt.drain(); // await any fire-and-forget agents so none outlive the run uncounted
	const preservedWorktrees = await rt.cleanup();
	if (preservedWorktrees.length) onLine(`  preserved ${preservedWorktrees.length} dirty worktree(s): ${preservedWorktrees.join(", ")}`, "warning", { ephemeral: false });
	const record = finalize({ runId: cfg.runId, status, error, meta, args: cfg.args, startedAt, rt, result, preservedWorktrees });
	writeFileSync(join(cfg.runDir, "run.json"), JSON.stringify(record, null, 2), "utf8");
	writeFileSync(join(cfg.runDir, "result.json"), JSON.stringify({ runId: record.runId, status: record.status, aic: record.aic, result: record.result }, null, 2), "utf8");
	reporter.emit({ ev: "run_end", runId: cfg.runId, ...record.counts, nanoAiu: rt.stats().nanoAiu, aic: record.aic });
	onLine(reporter.runSummary(), status === "error" || status === "timeout" ? "error" : "info", { ephemeral: false });
	reporter.close(status);
	return record;
}

/** @param {ExecuteConfig} cfg */
function runtimeOpts(cfg) {
	return {
		concurrency: cfg.concurrency ?? null,
		model: cfg.model ?? null,
		effort: cfg.effort ?? null,
		context: cfg.context ?? null,
		defaultEnableMcp: !!cfg.enableMcp,
		budget: cfg.budget ?? null,
		strictBudget: !!cfg.strictBudget,
		restricted: !!cfg.restricted,
		cwd: cfg.cwd,
		repoRoot: cfg.repoRoot ?? null,
	};
}

/**
 * @param {{ runId: string, status: RunStatus, error: string|null, meta: object, args: unknown,
 *   startedAt: number, rt: Runtime, result: string, preservedWorktrees?: string[] }} p
 * @returns {RunRecord}
 */
function finalize(p) {
	const rt = p.rt;
	const { counts, nanoAiu } = rt.stats();
	return {
		runId: p.runId,
		status: p.status,
		error: p.error,
		workflow: p.meta,
		args: p.args ?? null,
		startedAt: new Date(p.startedAt).toISOString(),
		finishedAt: new Date().toISOString(),
		durationMs: Date.now() - p.startedAt,
		budget: {
			total: rt.budget.total,
			spent: rt.budget.spent(),
			remaining: rt.budget.remaining(),
			hit: rt.budgetHit,
		},
		aic: nanoAiu / 1_000_000_000,
		counts,
		preservedWorktrees: p.preservedWorktrees ?? [],
		result: p.result,
	};
}

/** @param {unknown} value @returns {string} coerce a harness return value into the workflow result text. */
function coerceResult(value) {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "object" && typeof (/** @type {any} */ (value).content) === "string") return /** @type {any} */ (value).content;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/**
 * @param {string} runDir
 * @param {string} runId
 * @param {object} meta
 * @param {unknown} args
 * @param {boolean} restricted
 */
function writeMeta(runDir, runId, meta, args, restricted) {
	const path = join(runDir, "meta.json");
	/** @type {any} */
	let existing = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			existing = {};
		}
	}
	const now = new Date().toISOString();
	const record = {
		runId,
		workflow: meta,
		createdAt: existing.createdAt || now,
		updatedAt: now,
		restricted,
		args: args ?? null,
	};
	try {
		writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
	} catch {
		/* best-effort */
	}
}
