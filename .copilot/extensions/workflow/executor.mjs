/**
 * @module executor
 *
 * Workflow execution lifecycle: artifacts, runtime setup, harness execution, cleanup, and results.
 */
import vm from "node:vm";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join, basename } from "node:path";

import { Runtime, permissionCapability } from "./runtime.mjs";
import { CheckpointStore } from "./checkpoint.mjs";
import { Memory } from "./memory.mjs";
import { ProgressReporter } from "./progress.mjs";
import { runHarness, createDeterministicContext } from "./sandbox.mjs";
import { loadHost } from "./effects.mjs";
import { BudgetExceeded } from "./scheduler.mjs";
import { createAgentBackend, normalizeBackend } from "./agent.mjs";
import { createCliBackend } from "./cli.mjs";
import {
	FORMAT_VERSION,
	Persistence,
	readJsonFile,
} from "./persistence.mjs";

const ABORT_DRAIN_GRACE_MS = 2000;

/** Internal sentinel used to distinguish run cancellation from a harness failure. */
class RunAborted extends Error {}

/**
 * Strip ESM `export` keywords so the harness runs as VM script text (it cannot import extension
 * internals). `export const meta = …` becomes `const meta = …`. The keywords are blanked in place
 * rather than deleted, so every line and column in the stripped source still matches the original —
 * stack frames and {@link Runtime} group identities depend on that.
 * @param {string} source
 * @returns {string}
 */
export function stripExports(source) {
	return source
		.replace(/^([ \t]*)export(\s+)default(\s+)(?=\S)/gm, (_m, indent, gap1, gap2) => `${indent}      ${gap1}       ${gap2}`)
		.replace(/^([ \t]*)export(\s+)(?=(?:const|let|var|function|class|async)\b)/gm, (_m, indent, gap) => `${indent}      ${gap}`);
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
	const end = objectLiteralEnd(source, open);
	if (end < 0) return {};
	const literal = source.slice(open, end + 1);
	try {
		const ctx = createDeterministicContext({}, "workflow-meta");
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

/** @param {string} source @param {number} open */
function objectLiteralEnd(source, open) {
	let depth = 0;
	let state = "code";
	for (let i = open; i < source.length; i++) {
		const c = source[i];
		const n = source[i + 1];
		if (state === "code") {
			if (c === "/" && n === "/") {
				i++;
				state = "line";
			} else if (c === "/" && n === "*") {
				i++;
				state = "block";
			} else if (c === "'" || c === '"' || c === "`") state = c;
			else if (c === "{") depth++;
			else if (c === "}" && --depth === 0) return i;
		} else if (state === "line") {
			if (c === "\n") state = "code";
		} else if (state === "block") {
			if (c === "*" && n === "/") {
				i++;
				state = "code";
			}
		} else if (c === "\\") i++;
		else if (c === state) state = "code";
	}
	return -1;
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
 * @property {number[][]} [invalidatedBranches]
 * @property {string|null} [memoryPath]
 * @property {string|null} [hostPath]
 * @property {number} [harnessSyncTimeoutMs]
 * @property {string} [cwd]
 * @property {string[]} [allowedDirs]
 * @property {AbortSignal} [signal]
 * @property {(line: string, level?: "info"|"warning"|"error", meta?: { ephemeral?: boolean }) => void} [onLine]
 * @property {"dashboard"|"events"|"off"} [progressMode]
 * @property {string} [title]
 * @property {"off"|"on"|"auto"} [parentPermissionMode]
 * @property {string} [parentSessionMode]
 * @property {number|null} [maxAgents]
 * @property {{ kindFor: Function, openRun: Function }} [agentBackend]
 * @property {string|null} [planId]
 * @property {((request: { current: number, spent: number, increment: number, proposed: number }) => Promise<boolean|null>|boolean|null)|null} [requestBudgetIncrease]
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
 * @property {{ agents: number, launched: number, done: number, failed: number, cached: number, skipped: number, dropped: number, unknownUsage: number }} counts
 * @property {string[]} preservedWorktrees
 * @property {string[]} preservedSessions
 * @property {string} result
 * @property {number} plannedMaxAgents
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
	const dryRunReasons = error ? [] : incompleteReasons(rt);
	if (dryRunReasons.length) error = `workflow preview incomplete: ${dryRunReasons.join(", ")}`;
	return finalize({
		runId: cfg.runId,
		status: error ? (dryRunReasons.length ? "partial" : "error") : "complete",
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
	const persistence = new Persistence(cfg.runDir, { runId: cfg.runId });
	const lease = persistence.acquire();
	try {
		const agentBackend = cfg.agentBackend ?? createAgentBackend({ backend: "cli", cli: createCliBackend() });
		const requestedBackend = normalizeBackend(agentBackend.kindFor());
		const manifest = persistence.ensureManifest(
			{
				runId: cfg.runId,
				formatVersion: FORMAT_VERSION,
				backend: requestedBackend,
				parentPermissionMode: cfg.parentPermissionMode ?? "off",
				parentSessionMode: cfg.parentSessionMode ?? "interactive",
				permissionMode: permissionCapability(cfg.parentPermissionMode ?? "off"),
				permissionInheritance: {
					tools: "parent-mode-with-profile-denials",
					paths: "workflow-approved-directories",
					urls: "parent-mode-with-profile-denials",
					mcp: "launch-opt-in-and-profile-narrowed",
					fineGrainedRules: "not-exposed-by-parent-sdk",
				},
				hostPath: cfg.hostPath ?? null,
				cwd: cfg.cwd || process.cwd(),
				budget: cfg.budget ?? null,
				model: cfg.model ?? null,
				effort: cfg.effort ?? null,
				context: cfg.context ?? null,
				concurrency: cfg.concurrency ?? null,
				enableMcp: !!cfg.enableMcp,
				restricted: !!cfg.restricted,
				strictBudget: !!cfg.strictBudget,
				memoryPath: cfg.memoryPath ?? null,
				progressMode: cfg.progressMode ?? "dashboard",
				maxAgents: cfg.maxAgents ?? null,
				planId: cfg.planId ?? null,
				createdAt: new Date(startedAt).toISOString(),
			},
			{ resume: !!cfg.resume },
		);
		const backend = normalizeBackend(manifest.backend);
		if (backend !== requestedBackend) {
			throw new Error(`workflow run '${cfg.runId}' is pinned to backend '${backend}' and cannot resume with '${requestedBackend}'`);
		}
		const checkpoints = new CheckpointStore(cfg.runDir, { resume: !!cfg.resume, lease });
		if (cfg.invalidatedBranches?.length) checkpoints.invalidate(cfg.invalidatedBranches);
		resetRunArtifacts(cfg.runDir);
		persistence.writeFile(lease, "script.js", cfg.source);
		copyHostArtifact(cfg, persistence, lease);
		writeMeta(persistence, lease, cfg.runId, meta, cfg.args, !!cfg.restricted);

		const reporter = new ProgressReporter({
			jsonlPath: join(cfg.runDir, "progress.jsonl"),
			statePath: join(cfg.runDir, "state.json"),
			writeState: (state) => persistence.writeJson(lease, "state.json", state),
			runId: cfg.runId,
			meta,
			title,
			onLine,
			dashboard: cfg.progressMode === "dashboard",
		});
		const memory = new Memory(cfg.memoryPath, { readOnly: false, log: (m) => onLine(m, "info", { ephemeral: true }) });
		const runBackend = await agentBackend.openRun();
		const abortBackend = () => runBackend.abort?.(cfg.signal?.reason);
		if (cfg.signal?.aborted) abortBackend();
		else cfg.signal?.addEventListener("abort", abortBackend, { once: true });
		const rt = new Runtime({
			...runtimeOpts(cfg),
			agentBackend: runBackend,
			checkpoints,
			memory,
			abortController: linkedAbortController(cfg.signal),
			progress: (e) => reporter.emit(e),
			log: (m, /** @type {"info"|"warning"|"error"} */ level = "info") => onLine(m, level, { ephemeral: true }),
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
					status = "failed";
					error = e.message;
					onLine(`  budget reached: ${e.message}`, "warning", { ephemeral: false });
				} else if (e instanceof RunAborted || cfg.signal?.aborted) {
					status = statusForAbort(cfg.signal);
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
			await closeRunBackend(runBackend, onLine);
			if (cfg.signal?.aborted) status = statusForAbort(cfg.signal);
			const preservedWorktrees = await rt.cleanup();
			if (preservedWorktrees.length) onLine(`  preserved ${preservedWorktrees.length} dirty worktree(s): ${preservedWorktrees.join(", ")}`, "warning", { ephemeral: false });
			if (status === "complete") {
				const reasons = incompleteReasons(rt);
				if (reasons.length) {
					status = result.trim() ? "partial" : "failed";
					error = `workflow incomplete: ${reasons.join(", ")}`;
					onLine(`  ! ${error}`, "warning", { ephemeral: false });
				}
			}
			// After the final status: a run that did not complete keeps every agent session, since it
			// can still be resumed or inspected.
			const { deleted, preserved: preservedSessions } = await rt.cleanupSessions({ status });
			if (deleted.length) onLine(`  cleaned up ${deleted.length} agent session(s)`, "info", { ephemeral: true });
			if (preservedSessions.length) {
				onLine(`  preserved ${preservedSessions.length} agent session(s): copilot --resume ${preservedSessions[0]}`, "info", { ephemeral: false });
			}
			const record = finalize({ runId: cfg.runId, status, error, meta, args: cfg.args, startedAt, rt, result, preservedWorktrees, preservedSessions });
			persistence.writeJson(lease, "run.json", record);
			persistence.writeJson(lease, "result.json", { runId: record.runId, status: record.status, aic: record.aic, result: record.result });
			reporter.emit({ ev: "run_end", runId: cfg.runId, status: record.status, error: record.error, ...record.counts, nanoAiu: rt.stats().nanoAiu, aic: record.aic });
			closeStatus = status;
			const summaryLevel = status === "partial" ? "warning" : status === "complete" ? "info" : "error";
			onLine(reporter.runSummary(), summaryLevel, { ephemeral: false });
			return record;
		} finally {
			cfg.signal?.removeEventListener("abort", abortBackend);
			await closeRunBackend(runBackend, onLine);
			reporter.close(closeStatus);
		}
	} finally {
		lease.release();
	}
}

export { normalizeBackend };

/** @param {any} backend @param {NonNullable<ExecuteConfig["onLine"]>} onLine */
async function closeRunBackend(backend, onLine) {
	if (!backend) return;
	try {
		await backend.close?.();
	} catch (error) {
		onLine(`  ! workflow agent backend shutdown failed: ${error instanceof Error ? error.message : error}`, "warning", { ephemeral: false });
	}
}

/** @param {Runtime} rt @returns {string[]} */
function incompleteReasons(rt) {
	const counts = rt.stats().counts;
	const reasons = [];
	if (counts.failed) reasons.push(`${counts.failed} agent failure(s)`);
	if (counts.skipped) reasons.push(`${counts.skipped} skipped agent(s)`);
	if (counts.dropped) reasons.push(`${counts.dropped} dropped item(s)`);
	if (rt.currentUnknownUsage) reasons.push(`${rt.currentUnknownUsage} agent(s) with unknown usage`);
	if (rt.budget.hit) reasons.push("budget boundary reached");
	return reasons;
}

/** Remove stale presentation artifacts while preserving the checkpoint journal. @param {string} runDir */
function resetRunArtifacts(runDir) {
	for (const file of ["run.json", "result.json", "state.json", "progress.jsonl"]) {
		rmSync(join(runDir, file), { force: true });
	}
}

/**
 * @param {ExecuteConfig} cfg
 * @param {Persistence} persistence
 * @param {import("./persistence.mjs").Lease} lease
 */
function copyHostArtifact(cfg, persistence, lease) {
	if (!cfg.hostPath || cfg.restricted) return;
	// Not a provenance copy: `preparePersistedResume` loads the sidecar from this file, so a run
	// that fails to write it would resume with no `host.*` effects at all.
	persistence.writeFile(lease, "host.mjs", readFileSync(cfg.hostPath));
}

/** @param {AbortSignal|undefined} signal */
function linkedAbortController(signal) {
	const ac = new AbortController();
	if (!signal) return ac;
	if (signal.aborted) ac.abort(signal.reason);
	else signal.addEventListener("abort", () => ac.abort(signal.reason), { once: true });
	return ac;
}

/** @param {AbortSignal|undefined} signal @returns {RunStatus} */
function statusForAbort(signal) {
	const reason = signal?.reason;
	const kind = reason && typeof reason === "object" ? reason.kind : reason;
	if (kind === "pause") return "paused";
	if (kind === "cancel") return "cancelled";
	return "timeout";
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
		parentPermissionMode: cfg.parentPermissionMode,
		parentSessionMode: cfg.parentSessionMode,
		maxAgents: cfg.maxAgents,
		requestBudgetIncrease: cfg.requestBudgetIncrease,
		cwd: cfg.cwd,
		allowedDirs: cfg.allowedDirs,
		harness: { file: `${cfg.runId}.mjs`, source: stripExports(cfg.source) },
	};
}

/**
 * @param {{ runId: string, status: RunStatus, error: string|null, meta: object, args: unknown,
 *   startedAt: number, rt: Runtime, result: string, preservedWorktrees?: string[], preservedSessions?: string[] }} p
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
			hit: rt.budget.hit,
		},
		aic: nanoAiu / 1_000_000_000,
		counts,
		preservedWorktrees: p.preservedWorktrees ?? [],
		preservedSessions: p.preservedSessions ?? [],
		result: p.result,
		plannedMaxAgents: rt.plannedMaxAgents,
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
 * @param {Persistence} persistence
 * @param {import("./persistence.mjs").Lease} lease
 * @param {string} runId
 * @param {object} meta
 * @param {unknown} args
 * @param {boolean} restricted
 */
function writeMeta(persistence, lease, runId, meta, args, restricted) {
	const path = join(persistence.runDir, "meta.json");
	/** @type {any} */
	let existing = {};
	if (existsSync(path)) {
		existing = readJsonFile(path) || {};
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
	// Not just listing metadata: `preparePersistedResume` replays `args` from this file, so losing it
	// would silently resume the workflow with different input.
	persistence.writeJson(lease, "meta.json", record);
}
