/**
 * @module executor
 *
 * Workflow execution lifecycle: artifacts, runtime setup, harness execution, cleanup, and results.
 */
import vm from "node:vm";
import { existsSync, rmSync } from "node:fs";
import { join, basename, resolve } from "node:path";

import { Runtime, permissionCapability } from "./runtime.mjs";
import { Memory } from "./memory.mjs";
import { ProgressReporter } from "./progress.mjs";
import { runHarness, createDeterministicContext } from "./sandbox.mjs";
import { loadHost } from "./effects.mjs";
import { createAgentBackend, normalizeBackend } from "./agent.mjs";
import { createCliBackend } from "./cli.mjs";
import { readJsonFile } from "./persistence.mjs";
import { Work } from "./work.mjs";
import { snapshotHost, verifyHostSnapshot } from "./snapshot.mjs";
import { Ledger } from "./ledger.mjs";
import { consumeConveyorPlan } from "./plans.mjs";
import {
	assertJson,
	durableFailure,
	AccountingError,
	harnessFailure,
	interruptionFailure,
	limitFailure,
	LimitError,
	normalizeLimits,
	normalizePhases,
	runEnvelope,
} from "./schema.mjs";

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
 * @returns {{ name?: string, description?: string, phases?: any[], limits?: Record<string, number> }}
 */
export function extractMeta(source) {
	const m = /(?:^|\n)\s*(?:export\s+)?const\s+meta\s*=\s*\{/.exec(source);
	if (!m) return {};
	const open = source.indexOf("{", m.index);
	const end = objectLiteralEnd(source, open);
	if (end < 0) return {};
	const literal = source.slice(open, end + 1);
	let value;
	try {
		const ctx = createDeterministicContext({}, "conveyor-meta");
		value = new vm.Script(`(${literal})`).runInContext(ctx, { timeout: 200 });
	} catch {
		return {};
	}
	if (!value || typeof value !== "object") return {};
	/** @type {{ name?: string, description?: string, phases?: any[], limits?: Record<string, number> }} */
	const meta = {};
	if (typeof value.name === "string") meta.name = value.name;
	if (typeof value.description === "string") meta.description = value.description;
	if (value.phases != null) meta.phases = normalizePhases(value.phases);
	if (value.limits != null) meta.limits = normalizeLimits(value.limits);
	return meta;
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
 * @property {Work} [work]
 * @property {number|null} [attemptTimeoutSeconds]
 * @property {number|null} [budget] legacy alias accepted by callers
 * @property {Record<string, number>} [limits]
 * @property {string|null} [model]
 * @property {string|null} [effort]
 * @property {string|null} [context]
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
 * @property {boolean} [retainAgentContent]
 * @property {((request: { current: Record<string, number>, proposed: Record<string, number> }) => Promise<boolean|null>|boolean|null)|null} [requestLimitApproval]
 */

/**
 * @typedef {object} RunRecord
 * @property {string} runId
 * @property {RunStatus} status
 * @property {string|null} error
 * @property {unknown} [failure]
 * @property {number} revision
 * @property {object} conveyor
 * @property {unknown} args
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {number} durationMs
 * @property {{ total: number|null, spent: number, remaining: number|null, hit: boolean }} budget
 * @property {number} aic
 * @property {{ agents: number, launched: number, done: number, failed: number, cached: number, skipped: number, dropped: number, unknownUsage: number }} counts
 * @property {string[]} preservedWorktrees
 * @property {string[]} preservedSessions
 * @property {unknown} [result]
 * @property {number} plannedMaxAgents
 */
/** @typedef {import("./progress.mjs").RunStatus} RunStatus */

/**
 * Run one workflow end to end, persisting artifacts. Never rejects for harness failure: a crash is
 * caught, persisted with an `error` status, and returned as a {@link RunRecord}.
 * @param {ExecuteConfig} cfg
 * @returns {Promise<RunRecord>}
 */
export async function executeConveyor(cfg) {
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
		...runtimeOpts(cfg, meta),
		dryRun: true,
		memory: new Memory(cfg.memoryPath, { readOnly: true, log: onLine }),
		progress: () => {},
		log: onLine,
	});
	/** @type {string|null} */
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
	if (dryRunReasons.length) error = `conveyor preview incomplete: ${dryRunReasons.join(", ")}`;
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
	const ownsWork = !cfg.work;
	const work = cfg.work ?? Work.open({
		runId: cfg.runId,
		runDir: cfg.runDir,
		timeoutSec: cfg.attemptTimeoutSeconds ?? null,
		signal: cfg.signal,
	});
	if (work.runId !== cfg.runId || work.runDir !== cfg.runDir) {
		throw new Error(`supplied Work '${work.runId}' at '${work.runDir}' does not match conveyor '${cfg.runId}' at '${cfg.runDir}'`);
	}
	cfg = { ...cfg, signal: work.signal };
	const { persistence, lease } = work;
	try {
		const agentBackend = cfg.agentBackend ?? createAgentBackend({ backend: "cli", cli: createCliBackend() });
		const requestedBackend = normalizeBackend(agentBackend.kindFor());
		const declaredLimits = normalizeLimits(cfg.limits ?? (/** @type {{ limits?: Record<string, number> }} */ (meta)).limits ?? {});
		const requestedLimits = normalizeLimits(cfg.limits ?? declaredLimits);
		const manifest = persistence.ensureManifest(
			{
				runId: cfg.runId,
				conveyor: meta,
				args: cfg.args ?? null,
				backend: requestedBackend,
				parentPermissionMode: cfg.parentPermissionMode ?? "off",
				parentSessionMode: cfg.parentSessionMode ?? "interactive",
				permissionMode: permissionCapability(cfg.parentPermissionMode ?? "off"),
				permissionInheritance: {
					tools: "parent-mode-with-profile-denials",
					paths: "conveyor-approved-directories",
					urls: "parent-mode-with-profile-denials",
					mcp: "launch-opt-in-and-profile-narrowed",
					fineGrainedRules: "not-exposed-by-parent-sdk",
				},
				cwd: cfg.cwd || process.cwd(),
				model: cfg.model ?? null,
				effort: cfg.effort ?? null,
				context: cfg.context ?? null,
				enableMcp: !!cfg.enableMcp,
				restricted: !!cfg.restricted,
				strictBudget: !!cfg.strictBudget,
				memoryPath: cfg.memoryPath ?? null,
				progressMode: cfg.progressMode ?? "dashboard",
				maxAgents: cfg.maxAgents ?? null,
				planId: cfg.planId ?? null,
				declaredLimits,
				retainAgentContent: cfg.retainAgentContent === true,
				createdAt: new Date(startedAt).toISOString(),
			},
			{ resume: !!cfg.resume },
		);
		const backend = normalizeBackend(manifest.backend);
		if (backend !== requestedBackend) {
			throw new Error(`conveyor run '${cfg.runId}' is pinned to backend '${backend}' and cannot resume with '${requestedBackend}'`);
		}
		const ledger = new Ledger(cfg.runDir, { lease });
		if (!Object.keys(ledger.approvedLimits).length) ledger.approve(declaredLimits, requestedLimits);
		else if (JSON.stringify(ledger.approvedLimits) !== JSON.stringify(requestedLimits)) ledger.approve(declaredLimits, requestedLimits);
		const attempt = ledger.startAttempt();
		if (cfg.invalidatedBranches?.length) ledger.invalidate(cfg.invalidatedBranches);
		resetRunArtifacts(cfg.runDir);
		persistence.writeFile(lease, "script.js", cfg.source);
		const hostPath = copyHostArtifact(cfg, persistence, lease);

		const reporter = new ProgressReporter({
			writeState: (state) => persistence.writeJson(lease, "state.json", state),
			runId: cfg.runId,
			meta,
			title,
			onLine,
			dashboard: cfg.progressMode === "dashboard",
			ownerGeneration: lease.generation,
		});
		const memory = new Memory(cfg.memoryPath, { readOnly: false, log: (m) => onLine(m, "info", { ephemeral: true }) });
		const runBackend = await agentBackend.openRun();
		const abortBackend = () => runBackend.abort?.(cfg.signal?.reason);
		if (cfg.signal?.aborted) abortBackend();
		else cfg.signal?.addEventListener("abort", abortBackend, { once: true });
		const rt = new Runtime({
			...runtimeOpts(cfg, meta),
			agentBackend: runBackend,
			ledger,
			attemptId: attempt.attemptId,
			limits: ledger.approvedLimits,
			memory,
			abortController: linkedAbortController(cfg.signal),
			progress: (e) => reporter.emit(e),
			log: (m, /** @type {"info"|"warning"|"error"} */ level = "info") => onLine(m, level, { ephemeral: true }),
		});

		let status = /** @type {RunStatus} */ ("complete");
		let closeStatus = /** @type {RunStatus} */ ("error");
		/** @type {unknown} */
		let failure = null;
		try {
			const startEvent = { ev: "run_start", runId: cfg.runId, attemptId: attempt.attemptId, meta };
			reporter.emit({ ...startEvent, ...ledger.progress(startEvent) });
			ledger.flushProgress();
			if (cfg.planId) {
				try {
					consumeConveyorPlan(cfg.planId);
				} catch (error) {
					onLine(`  ! conveyor plan cleanup failed: ${error instanceof Error ? error.message : error}`, "warning", { ephemeral: false });
				}
			}
			/** @type {string|null} */
			let error = null;
			let result;
			try {
				if (hostPath && !cfg.restricted) rt.setHost(await loadHost(hostPath));
				const value = await abortable(
					runHarness(stripExports(cfg.source), {
						api: rt.buildApi(cfg.args),
						filename: `${cfg.runId}.mjs`,
						log: (m) => rt.log(m),
						syncTimeoutMs: cfg.harnessSyncTimeoutMs,
					}),
					cfg.signal,
				);
				result = assertJson(value, { allowUndefined: true, label: "Conveyor result" });
			} catch (e) {
				if (e instanceof LimitError) {
					status = "failed";
					error = e.message;
					failure = limitFailure(
						e.kind,
						e.value,
						e.consumed,
					);
					onLine(`  budget reached: ${e.message}`, "warning", { ephemeral: false });
				} else if (e instanceof AccountingError) {
					status = "error";
					error = e.message;
					failure = durableFailure("accounting", e);
				} else if (e instanceof RunAborted || cfg.signal?.aborted) {
					status = statusForAbort(cfg.signal);
					failure = interruptionFailure(cfg.signal?.reason);
				} else {
					status = "error";
					error = e instanceof Error ? e.message : String(e);
					failure = harnessFailure(e);
					onLine(`  ! conveyor error: ${error}`, "error", { ephemeral: false });
				}
			}

			const drained = await drainRuntime(rt, cfg.signal);
			if (!drained) {
				onLine(`  ! conveyor cleanup exceeded ${ABORT_DRAIN_GRACE_MS}ms; host work may still be unwinding`, "warning", { ephemeral: false });
			}
			await closeRunBackend(runBackend, onLine);
			if (cfg.signal?.aborted) status = statusForAbort(cfg.signal);
			if (rt.durableError) {
				status = "error";
				error = `durable progress failed: ${rt.durableError.message}`;
				failure = durableFailure("progress", rt.durableError);
			}
			const preservedWorktrees = await rt.cleanup();
			if (preservedWorktrees.length) onLine(`  preserved ${preservedWorktrees.length} dirty worktree(s): ${preservedWorktrees.join(", ")}`, "warning", { ephemeral: false });
			if (status === "complete") {
				const reasons = incompleteReasons(rt);
				if (reasons.length) {
					status = result !== undefined ? "partial" : "failed";
					error = `conveyor incomplete: ${reasons.join(", ")}`;
					failure = { type: "incomplete", reasons };
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
			const terminalEvent = {
				ev: "run_end",
				runId: cfg.runId,
				attemptId: attempt.attemptId,
				status,
				error,
				...rt.stats().counts,
				nanoAiu: rt.stats().nanoAiu,
			};
			const terminalRevision = ledger.record("terminal_reserved", { status, failure });
			const record = finalize({
				runId: cfg.runId,
				status,
				error,
				failure,
				revision: terminalRevision,
				meta,
				args: cfg.args,
				startedAt,
				rt,
				result,
				preservedWorktrees,
				preservedSessions,
			});
			const envelope = runEnvelope(record);
			persistence.writeJson(lease, "run.json", envelope);
			ledger.finishAttempt(attempt, status, failure);
			const terminalProgress = ledger.progress(terminalEvent);
			ledger.flushProgress();
			const progressWarning = ledger.takeProgressWarning();
			if (progressWarning) onLine(`  ! terminal progress was not persisted: ${progressWarning.message}`, "warning", { ephemeral: false });
			reporter.emit({ ...terminalEvent, aic: record.aic, ...terminalProgress, revision: terminalRevision });
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
		if (ownsWork) work.close();
	}
}

export { normalizeBackend };

/** @param {any} backend @param {NonNullable<ExecuteConfig["onLine"]>} onLine */
async function closeRunBackend(backend, onLine) {
	if (!backend) return;
	try {
		await backend.close?.();
	} catch (error) {
		onLine(`  ! conveyor agent backend shutdown failed: ${error instanceof Error ? error.message : error}`, "warning", { ephemeral: false });
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

/** Remove the stale live view before a new attempt starts. @param {string} runDir */
function resetRunArtifacts(runDir) {
	for (const file of ["state.json"]) {
		rmSync(join(runDir, file), { force: true });
	}
}

/**
 * @param {ExecuteConfig} cfg
 * @param {import("./persistence.mjs").Persistence} persistence
 * @param {import("./persistence.mjs").Lease} lease
 */
function copyHostArtifact(cfg, persistence, lease) {
	if (!cfg.hostPath || cfg.restricted) return null;
	lease.assertOwned();
	const target = join(cfg.runDir, "host");
	if (cfg.resume && resolve(cfg.hostPath) === resolve(target)) {
		verifyHostSnapshot(target);
		return target;
	}
	const snapshot = snapshotHost(cfg.hostPath, target);
	lease.assertOwned();
	return snapshot.root;
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
		return Promise.reject(new RunAborted("conveyor aborted"));
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new RunAborted("conveyor aborted"));
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
function runtimeOpts(cfg, meta = {}) {
	return {
		model: cfg.model ?? null,
		effort: cfg.effort ?? null,
		context: cfg.context ?? null,
		defaultEnableMcp: !!cfg.enableMcp,
		limits: cfg.limits ?? {},
		strictBudget: !!cfg.strictBudget,
		restricted: !!cfg.restricted,
		parentPermissionMode: cfg.parentPermissionMode,
		parentSessionMode: cfg.parentSessionMode,
		maxAgents: cfg.maxAgents,
		requestLimitApproval: cfg.requestLimitApproval,
		cwd: cfg.cwd,
		allowedDirs: cfg.allowedDirs,
		harness: { file: `${cfg.runId}.mjs`, source: stripExports(cfg.source) },
		phases: Array.isArray(meta.phases) ? meta.phases : [],
		retainAgentContent: cfg.retainAgentContent === true,
		runId: cfg.runId,
	};
}

/**
 * @param {{ runId: string, status: RunStatus, error: string|null, failure?: unknown, revision?: number,
 *   meta: object, args: unknown, startedAt: number, rt: Runtime, result?: unknown,
 *   preservedWorktrees?: string[], preservedSessions?: string[] }} p
 * @returns {RunRecord}
 */
function finalize(p) {
	const rt = p.rt;
	const { counts, nanoAiu } = rt.stats();
	return {
		runId: p.runId,
		status: p.status,
		error: p.error,
		failure: p.failure ?? null,
		revision: p.revision ?? 0,
		conveyor: p.meta,
		args: p.args ?? null,
		startedAt: new Date(p.startedAt).toISOString(),
		finishedAt: new Date().toISOString(),
		durationMs: Date.now() - p.startedAt,
		budget: {
			total: rt.budget.total,
			spent: rt.budget.spent(),
			remaining: Number.isFinite(rt.budget.remaining()) ? rt.budget.remaining() : null,
			hit: rt.budget.hit,
		},
		aic: nanoAiu / 1_000_000_000,
		counts,
		preservedWorktrees: p.preservedWorktrees ?? [],
		preservedSessions: p.preservedSessions ?? [],
		...(p.result !== undefined ? { result: p.result } : {}),
		plannedMaxAgents: rt.plannedMaxAgents,
	};
}
