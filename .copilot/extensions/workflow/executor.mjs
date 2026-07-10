/**
 * @module executor
 *
 * Workflow execution lifecycle: artifacts, runtime setup, harness execution, cleanup, and results.
 */
import vm from "node:vm";
import { writeFileSync, mkdirSync, readFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";

import { Runtime } from "./runtime.mjs";
import { CheckpointStore } from "./checkpoint.mjs";
import { Memory } from "./memory.mjs";
import { ProgressReporter } from "./progress.mjs";
import { runHarness, deterministicGlobals } from "./sandbox.mjs";
import { loadHost } from "./effects.mjs";
import { BudgetExceeded } from "./scheduler.mjs";

const ABORT_DRAIN_GRACE_MS = 2000;

/** Internal sentinel used to distinguish run cancellation from a harness failure. */
class RunAborted extends Error {}

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
 * @property {number} [harnessSyncTimeoutMs]
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

	if (cfg.dryRun) return executeDryRun(cfg, { meta, onLine, startedAt });
	return executeRealRun(cfg, { meta, title, onLine, startedAt });
}

/**
 * @param {ExecuteConfig} cfg
 * @param {{ meta: object, onLine: NonNullable<ExecuteConfig["onLine"]>, startedAt: number }} run
 * @returns {Promise<RunRecord>}
 */
async function executeDryRun(cfg, run) {
	const { meta, onLine, startedAt } = run;
	const rt = new Runtime({
		...runtimeOpts(cfg),
		dryRun: true,
		checkpoints: null,
		memory: new Memory(cfg.memoryPath, { readOnly: true, log: onLine }),
		progress: () => {},
		log: onLine,
	});
	let error = null;
	try {
		if (cfg.hostPath && !cfg.restricted) rt.setHost(await loadHost(cfg.hostPath));
		await runHarness(stripExports(cfg.source), {
			api: rt.buildApi(cfg.args),
			filename: `${cfg.runId}.mjs`,
			log: onLine,
			syncTimeoutMs: cfg.harnessSyncTimeoutMs,
		});
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
		result: `dry-run plan: ${rt.agentCount} agent call(s)` + (/** @type {any} */ (meta).name ? ` — ${/** @type {any} */ (meta).name}` : ""),
		preservedWorktrees,
	});
}

/**
 * @param {ExecuteConfig} cfg
 * @param {{ meta: object, title: string, onLine: NonNullable<ExecuteConfig["onLine"]>, startedAt: number }} run
 * @returns {Promise<RunRecord>}
 */
async function executeRealRun(cfg, run) {
	const { meta, title, onLine, startedAt } = run;
	mkdirSync(cfg.runDir, { recursive: true });
	const checkpoints = new CheckpointStore(cfg.runDir, { resume: !!cfg.resume });
	resetRunArtifacts(cfg.runDir);
	writeFileSync(join(cfg.runDir, "script.js"), cfg.source, "utf8");
	copyHostArtifact(cfg);
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
	const memory = new Memory(cfg.memoryPath, { readOnly: false, log: (m) => onLine(m, "info", { ephemeral: true }) });
	const rt = new Runtime({
		...runtimeOpts(cfg),
		checkpoints,
		memory,
		abortController: linkedAbortController(cfg.signal),
		progress: (e) => reporter.emit(e),
		log: (m) => onLine(m, "info", { ephemeral: true }),
	});

	let status = /** @type {RunStatus} */ ("complete");
	let closeStatus = /** @type {RunStatus} */ ("error");
	try {
		reporter.emit({ ev: "run_start", runId: cfg.runId, meta });
		let error = null;
		let result = "";
		try {
			if (cfg.hostPath && !cfg.restricted) rt.setHost(await loadHost(cfg.hostPath));
			const value = await abortable(
				runHarness(stripExports(cfg.source), {
					api: rt.buildApi(cfg.args),
					filename: `${cfg.runId}.mjs`,
					log: (m) => rt.log(m),
					syncTimeoutMs: cfg.harnessSyncTimeoutMs,
				}),
				cfg.signal,
			);
			result = coerceResult(value);
		} catch (e) {
			if (e instanceof BudgetExceeded) {
				status = "complete";
				onLine(`  budget reached: ${e.message}`, "warning", { ephemeral: false });
			} else if (e instanceof RunAborted || cfg.signal?.aborted) {
				status = "timeout";
			} else {
				status = "error";
				error = e instanceof Error ? e.message : String(e);
				onLine(`  ! workflow error: ${error}`, "error", { ephemeral: false });
			}
		}

		const drained = await drainRuntime(rt, cfg.signal);
		if (!drained) {
			onLine(`  ! workflow cleanup exceeded ${ABORT_DRAIN_GRACE_MS}ms; host work may still be unwinding`, "warning", { ephemeral: false });
		}
		if (cfg.signal?.aborted) status = "timeout";
		const preservedWorktrees = await rt.cleanup();
		if (preservedWorktrees.length) onLine(`  preserved ${preservedWorktrees.length} dirty worktree(s): ${preservedWorktrees.join(", ")}`, "warning", { ephemeral: false });
		const record = finalize({ runId: cfg.runId, status, error, meta, args: cfg.args, startedAt, rt, result, preservedWorktrees });
		writeJson(join(cfg.runDir, "run.json"), record);
		writeJson(join(cfg.runDir, "result.json"), { runId: record.runId, status: record.status, aic: record.aic, result: record.result });
		reporter.emit({ ev: "run_end", runId: cfg.runId, status: record.status, error: record.error, ...record.counts, nanoAiu: rt.stats().nanoAiu, aic: record.aic });
		closeStatus = status;
		onLine(reporter.runSummary(), status === "error" || status === "timeout" ? "error" : "info", { ephemeral: false });
		return record;
	} finally {
		reporter.close(closeStatus);
	}
}

/** Remove stale presentation artifacts while preserving the checkpoint journal. @param {string} runDir */
function resetRunArtifacts(runDir) {
	for (const file of ["run.json", "result.json", "state.json", "progress.jsonl"]) {
		rmSync(join(runDir, file), { force: true });
	}
}

/** @param {ExecuteConfig} cfg */
function copyHostArtifact(cfg) {
	if (!cfg.hostPath || cfg.restricted) return;
	try {
		copyFileSync(cfg.hostPath, join(cfg.runDir, "host.js"));
	} catch {
		// The sidecar is loaded from cfg.hostPath; this provenance copy is diagnostic only.
	}
}

/** @param {AbortSignal|undefined} signal */
function linkedAbortController(signal) {
	const ac = new AbortController();
	if (!signal) return ac;
	if (signal.aborted) ac.abort();
	else signal.addEventListener("abort", () => ac.abort(), { once: true });
	return ac;
}

/**
 * Await a promise until it settles or the run aborts. The original promise keeps rejection handlers
 * attached, so a later failure cannot become an unhandled rejection after cancellation wins.
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<T>}
 */
function abortable(promise, signal) {
	if (!signal) return promise;
	if (signal.aborted) {
		promise.then(
			() => {},
			() => {},
		);
		return Promise.reject(new RunAborted("workflow aborted"));
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new RunAborted("workflow aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * Drain fire-and-forget work normally, but after cancellation wait only a bounded grace period.
 * Agent subprocesses receive the same signal and should settle immediately; the bound protects the
 * extension from a host sidecar that ignores its AbortSignal.
 * @param {Runtime} rt
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<boolean>} true when every tracked task settled
 */
async function drainRuntime(rt, signal) {
	const draining = rt.drain();
	try {
		await abortable(draining, signal);
		return true;
	} catch (e) {
		if (!(e instanceof RunAborted)) throw e;
		return settleWithin(draining, ABORT_DRAIN_GRACE_MS);
	}
}

/** @param {Promise<unknown>} promise @param {number} timeoutMs @returns {Promise<boolean>} */
async function settleWithin(promise, timeoutMs) {
	let timer;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** @param {string} path @param {unknown} value */
function writeJson(path, value) {
	writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
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
		writeJson(path, record);
	} catch {
		// Metadata is useful for listing runs; execution artifacts still carry the final result.
	}
}
