/**
 * @module runtime
 *
 * Harness runtime: agents, fan-out, budgets, checkpoints, worktrees, host effects, and progress.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { copilotBin, runAgent } from "./agent.mjs";
import { Memory } from "./memory.mjs";
import * as patterns from "./patterns.mjs";
import { BudgetExceeded, defaultConcurrency, RunStats, Semaphore } from "./scheduler.mjs";
import { WorktreeManager, findRepoRoot, ensureClone, clonePath, _sanitize } from "./worktree.mjs";
import { buildHostProxy } from "./effects.mjs";
import { stableStringify } from "./json.mjs";
import { formatBranchPath } from "./checkpoint.mjs";

/** @typedef {import("./agent.mjs").AgentResult} AgentResult */
/** @typedef {import("./agent.mjs").AgentSpec} AgentSpec */
/** @typedef {import("./scheduler.mjs").RunCounts} RunCounts */

export { BudgetExceeded, defaultConcurrency };
export class AgentCapExceeded extends Error {}

/** Hard caps (overridable only by workflow-owned test/dev env, never by workflow source). */
export const MAX_AGENTS = 1000;
export const MAX_GROUP_ITEMS = 4096;
const maxAgents = () => Number(process.env.CWF_MAX_AGENTS || MAX_AGENTS);
const maxGroupItems = () => Number(process.env.CWF_MAX_GROUP_ITEMS || MAX_GROUP_ITEMS);

/** Spec fields that define an agent's identity for checkpoint keys (excludes label/phase/timeout). */
const KEY_FIELDS = [
	"prompt", "model", "agentType", "effort", "context", "cacheCwd", "resume", "enableMcp",
	"allow", "deny", "allowUrl", "denyUrl", "availableTools", "excludedTools", "allowAllTools",
	"allowAllUrls", "addDir", "permissionMode", "autopilot",
];
const SET_LIKE_KEY_FIELDS = new Set(["allow", "deny", "allowUrl", "denyUrl", "availableTools", "excludedTools", "addDir"]);

const branchStore = new AsyncLocalStorage();
const phaseStore = new AsyncLocalStorage();
/** This extension's own directory: stack frames inside it are framework code, not the harness. */
const FRAMEWORK_DIR = fileURLToPath(new URL("./", import.meta.url));

/** @param {unknown} value @returns {value is AgentResult} */
function isFailedAgentOutcome(value) {
	return isUnsuccessfulAgentOutcome(value) && /** @type {any} */ (value).skipped !== true;
}

/** @param {unknown} value @returns {value is AgentResult} */
function isUnsuccessfulAgentOutcome(value) {
	return !!value && typeof value === "object" && /** @type {any} */ (value).kind === "agent" && /** @type {any} */ (value).ok === false;
}

/**
 * The orchestration runtime injected into a harness (as the `agent`/`parallel`/… globals).
 */
export class Runtime {
	/** @type {number|null} */
	#budgetTotal;
	/** @type {import("./checkpoint.mjs").CheckpointStore|null} */
	#checkpoints;
	/** @type {(e: any) => void} */
	#progress;
	/** @type {(m: string, level?: "info"|"warning"|"error") => void} */
	#log;
	#sem;
	#abort;
	#spent = 0;
	#priorUnknownUsage = 0;
	#budgetHit = false;
	#seq = 0;
	#agentCount = 0;
	#retryHeadroom = 0;
	/** @type {string|null} */
	#currentPhase = null;
	/** @type {Map<string, number>} */
	#occurrence = new Map();
	/** @type {Map<string, number>} */
	#sideEffectEpoch = new Map();
	/** @type {Set<Promise<void>>} in-flight agent() promises, so fire-and-forget calls can be drained. */
	#inflight = new Set();
	#stats = new RunStats();
	#droppedCount = 0;
	#cwd = process.cwd();
	/** @type {string[]} */
	#allowedDirs = [];
	/** @type {string|null} */
	/** @type {string|null} */
	#wtBase = null;
	/** @type {Map<string, WorktreeManager>} */
	#wtManagers = new Map();
	/** @type {Set<string>} */
	#trustedWorktreeDirs = new Set();
	/** @type {string[]} */
	#preservedDirty = [];
	#isoCounter = 0;
	/** @type {number|null} */
	#maxAgents = null;
	/** @type {"off"|"on"|"auto"} */
	#parentPermissionMode = "off";
	/** @type {"interactive"|"autopilot"} */
	#parentSessionMode = "interactive";
	/** @type {string} */
	/** @type {{ kind: string, run: Function }} */
	#agentBackend;
	/** @type {((request: { current: number, spent: number, increment: number, proposed: number }) => Promise<boolean|null>|boolean|null)|null} */
	#requestBudgetIncrease;
	/** @type {Promise<boolean>|null} */
	#budgetIncreasePromise = null;
	/** True once the host declined (or could not be asked): approvals do not latch, refusals do. */
	#budgetIncreaseDeclined = false;
	/** @type {import("./effects.mjs").LoadedHost|null} */
	#host = null;
	/** @type {import("./effects.mjs").EffectCtx|null} */
	#hostCtx = null;
	#groupSeq = 0;
	/** Occurrences of each `[parent, group identity]`, so one call site reached twice gets two blocks. @type {Map<string, number>} */
	#groupSites = new Map();
	/** Next free branch index per parent, used when there is no journal (dry runs). @type {Map<string, number>} */
	#nextBranchIndex = new Map();
	/** Harness filename as V8 reports it, plus its source lines, for durable group identity. */
	#harnessFile = "";
	/** @type {string[]} */
	#harnessLines = [];
	/**
	 * @param {{
	 *   concurrency?: number|null, model?: string|null, effort?: string|null, context?: string|null,
	 *   defaultEnableMcp?: boolean, budget?: number|null, strictBudget?: boolean, dryRun?: boolean,
	 *   restricted?: boolean, checkpoints?: import("./checkpoint.mjs").CheckpointStore|null, memory?: Memory,
	 *   progress?: (e: any) => void, log?: (m: string, level?: "info"|"warning"|"error") => void, abortController?: AbortController,
	 *   cwd?: string, allowedDirs?: string[],
	 *   parentPermissionMode?: "off"|"on"|"auto", parentSessionMode?: string, maxAgents?: number|null, agentBackend?: { kind: string, run: Function },
	 *   harness?: { file: string, source: string },
	 *   requestBudgetIncrease?: ((request: { current: number, spent: number, increment: number, proposed: number }) => Promise<boolean|null>|boolean|null)|null,
	 * }} [opts]
	 */
	constructor(opts = {}) {
		this.concurrency = opts.concurrency && opts.concurrency > 0 ? opts.concurrency : defaultConcurrency();
		this.model = opts.model ?? null;
		this.effort = opts.effort ?? null;
		this.context = opts.context ?? null;
		this.defaultEnableMcp = !!opts.defaultEnableMcp;
		this.restricted = !!opts.restricted;
		this.dryRun = !!opts.dryRun;
		this.strictBudget = !!opts.strictBudget;
		this.#maxAgents = opts.maxAgents ?? null;
		this.#parentPermissionMode = normalizePermissionMode(opts.parentPermissionMode);
		this.#parentSessionMode = opts.parentSessionMode === "autopilot" ? "autopilot" : "interactive";
		this.#agentBackend = opts.agentBackend ?? { kind: "cli", run: runAgent };
		this.#harnessFile = opts.harness?.file ?? "";
		this.#harnessLines = opts.harness?.source ? opts.harness.source.split("\n") : [];
		this.#requestBudgetIncrease = opts.requestBudgetIncrease ?? null;
		this.memory = opts.memory ?? new Memory(null);
		this.#checkpoints = opts.checkpoints ?? null;
		this.#budgetTotal = this.#checkpoints?.latestBudget ?? opts.budget ?? null;
		this.#budgetIncreaseDeclined = this.#checkpoints?.budgetIncreaseDeclined ?? false;
		this.#progress = opts.progress ?? (() => {});
		this.#log = opts.log ?? (() => {});
		this.#sem = new Semaphore(this.concurrency);
		this.#abort = opts.abortController ?? new AbortController();
		this.#spent = this.#checkpoints ? this.#checkpoints.priorSpent : 0;
		this.#priorUnknownUsage = this.#checkpoints ? this.#checkpoints.priorUnknownUsage : 0;
		if (opts.cwd) this.#cwd = opts.cwd;
		this.#allowedDirs = (opts.allowedDirs?.length ? opts.allowedDirs : [this.#cwd]).map((dir) => resolve(dir));

		// The launch-time budget is immutable from workflow source.
		const rt = this;
		this.budget = {
			get total() {
				return rt.#budgetTotal;
			},
			get hit() {
				return rt.#budgetHit;
			},
			spent: () => rt.#spent,
			remaining: () => (rt.#budgetTotal == null ? Infinity : Math.max(0, rt.#budgetTotal - rt.#spent)),
		};
	}

	get agentCount() {
		return this.#stats.agentCount;
	}

	get currentUnknownUsage() {
		return this.#stats.counts().unknownUsage;
	}

	get plannedMaxAgents() {
		const observed = this.#stats.agentCount;
		return Math.min(maxAgents(), Math.max(observed + this.#retryHeadroom, Math.ceil(observed * 1.25) + (observed ? 2 : 0)));
	}

	/** @returns {{ counts: RunCounts & { dropped: number }, nanoAiu: number }} */
	stats() {
		const counts = this.#stats.counts();
		return { counts: { ...counts, unknownUsage: counts.unknownUsage + this.#priorUnknownUsage, dropped: this.#droppedCount }, nanoAiu: this.#stats.nanoAiu };
	}

	/**
	 * Await every in-flight agent() call (including fire-and-forget ones a harness never awaited), so
	 * no subagent outlives the run uncounted. Idempotent; loops in case draining launches more.
	 * @returns {Promise<void>}
	 */
	async drain() {
		while (this.#inflight.size) await Promise.allSettled([...this.#inflight]);
	}

	/** @param {unknown} msg @param {{ level?: "info"|"warning"|"error", fields?: Record<string, unknown> }} [options] */
	log(msg, options = {}) {
		const fields = options.fields && typeof options.fields === "object" ? ` ${stableStringify(options.fields)}` : "";
		this.#log(`${String(msg)}${fields}`, options.level ?? "info");
	}

	/** @param {string|null} name @param {(() => any)} [callback] set the current phase for subsequently-launched agents. */
	phase(name, callback) {
		const phase = name ? String(name) : null;
		if (typeof callback === "function") return phaseStore.run(phase, callback);
		this.#currentPhase = phase;
	}

	// ---- single agent --------------------------------------------------
	/**
	 * Launch one subagent and track it so {@link Runtime#drain} can await fire-and-forget calls.
	 * @param {string|Record<string, any>} prompt
	 * @param {Record<string, any>} [opts]
	 * @returns {Promise<AgentResult>}
	 */
	agent(prompt, opts = {}) {
		const options = this.#agentOptions(prompt, opts);
		if (options.schema != null) return this.#track(this.#structuredAgent(options));
		return this.#track(this.#agentRun(prompt, opts));
	}

	/** @param {Record<string, any>} options */
	async #structuredAgent(options) {
		const { schema, retries = 2, ...rawOptions } = options;
		const structured = await patterns.structured(this, String(options.prompt ?? ""), schema, { ...rawOptions, retries });
		if (this.dryRun) this.#retryHeadroom += retries;
		if (structured.ok) return { ...structured.raw, value: structured.value };
		return { ...structured.raw, ok: false, value: null, error: structured.error || structured.raw.error || "structured output failed" };
	}

	/**
	 * Register a task promise so {@link Runtime#drain} awaits it even when the harness never awaits it
	 * (fire-and-forget). A never-rejecting mirror lets drain settle orphans without swallowing the
	 * caller's own rejection and prevents unhandled-rejection warnings on orphans.
	 * @template T @param {Promise<T>} p @returns {Promise<T>}
	 */
	#track(p) {
		const tracked = p.then(
			() => {},
			() => {},
		);
		this.#inflight.add(tracked);
		tracked.finally(() => this.#inflight.delete(tracked));
		return p;
	}

	/**
	 * Run one subagent, or return a cached/dry-run/skipped result.
	 * @param {string|Record<string, any>} prompt
	 * @param {Record<string, any>} [opts]
	 * @returns {Promise<AgentResult>}
	 */
	async #agentRun(prompt, opts = {}, internal = {}) {
		const o = this.#agentOptions(prompt, opts);
		if (o.isolation === "worktree" && !this.dryRun && !this.restricted) {
			const iso = `iso-${++this.#isoCounter}`;
			return this.#worktree(iso, {}, (dir) => this.#agentRun(o.prompt, { ...o, isolation: undefined, cwd: dir }, { trustedCwd: true, cacheCwd: `<worktree:${iso}>` }));
		}
		this.#reserveAgentSlot();

		const spec = this.#buildSpec(o, internal);
		const run = this.#startAgent(spec, o);

		if (this.dryRun) {
			const res = this.#synthetic(`[dry-run:${run.seq}]`, spec);
			this.#finish(run.seq, res, false, run.phase);
			return res;
		}

		const key = this.#agentCacheKey(o, spec);
		const cached = this.#checkpoints?.get(key);
		if (cached) {
			this.#finish(run.seq, cached, false, run.phase);
			return cached;
		}

		while (true) {
			const gated = await this.#budgetGate(spec, run);
			if (gated) return gated;
			await this.#sem.acquire();
			if (!this.#overBudget()) break;
			this.#sem.release();
		}
		try {
			const { res, skipped, strictStop } = await this.#executeAgent(spec, key, run);
			this.#finish(run.seq, res, skipped, run.phase);
			if (strictStop) throw new BudgetExceeded(`budget ${this.#budgetTotal} exceeded (spent ${this.#spent.toFixed(4)})`);
			return res;
		} finally {
			this.#sem.release();
		}
	}

	/** @param {string|Record<string, any>} prompt @param {Record<string, any>} opts */
	#agentOptions(prompt, opts) {
		return /** @type {Record<string, any>} */ (typeof prompt === "string" ? { ...opts, prompt } : { ...prompt });
	}

	#reserveAgentSlot() {
		const cap = this.#maxAgents ?? maxAgents();
		if (++this.#agentCount > cap) throw new AgentCapExceeded(`workflow: agent cap exceeded (MAX_AGENTS=${cap}) — the run exceeded its approved plan or entered a runaway loop`);
	}

	/** @param {AgentSpec} spec @param {Record<string, any>} opts */
	#startAgent(spec, opts) {
		const phase = opts.phase ?? phaseStore.getStore() ?? this.#currentPhase ?? null;
		const branch = [...(branchStore.getStore() || [])];
		const seq = ++this.#seq;
		this.#emit({ ev: "start", seq, label: spec.label || "agent", model: spec.model, phase, branchPath: formatBranchPath(branch) });
		return { seq, phase, branch };
	}

	/** @param {Record<string, any>} opts @param {AgentSpec} spec */
	#agentCacheKey(opts, spec) {
		return opts.key != null ? this.#scopedKey(String(opts.key), spec) : this.#agentKey(spec);
	}

	/**
	 * @param {AgentSpec} spec
	 * @param {string} key
	 * @param {{ seq: number, phase: string|null, branch: number[] }} run
	 * @returns {Promise<{ res: AgentResult, skipped: boolean, strictStop: boolean }>}
	 */
	async #executeAgent(spec, key, run) {
		if (this.#abort.signal.aborted) {
			return { res: this.#synthetic("", spec, { skipped: true, error: "skipped: run aborting" }), skipped: true, strictStop: false };
		}

		this.#checkpoints?.recordStarted(key, spec, run.branch);
		const res = await this.#agentBackend.run(spec, { signal: this.#abort.signal });
		this.#charge(res.aic ?? 0);
		this.#checkpoints?.recordUsage(key, res);
		if (this.#checkpoints && res.ok) this.#checkpoints.put(key, res);
		return { res, skipped: false, strictStop: this.strictBudget && this.#overBudget() };
	}

	/** @param {AgentSpec} spec @param {{ seq: number, phase: string|null }} run */
	async #budgetGate(spec, run) {
		if (this.#abort.signal.aborted) {
			const res = this.#synthetic("", spec, { skipped: true, error: "skipped: run aborting" });
			this.#finish(run.seq, res, true, run.phase);
			return res;
		}
		if (!this.#overBudget()) return null;
		this.#budgetHit = true;
		if (!this.strictBudget && (await this.#tryBudgetIncrease())) return null;
		const res = this.#synthetic("", spec, { skipped: true, error: "skipped: budget reached" });
		this.#finish(run.seq, res, true, run.phase);
		if (this.strictBudget) throw new BudgetExceeded(`budget ${this.#budgetTotal} reached (spent ${this.#spent.toFixed(4)})`);
		return res;
	}

	async #tryBudgetIncrease() {
		const requestBudgetIncrease = this.#requestBudgetIncrease;
		if (!requestBudgetIncrease || this.#budgetTotal == null) return false;
		if (this.#budgetIncreasePromise) return this.#budgetIncreasePromise;
		if (this.#budgetIncreaseDeclined) return false;
		const current = this.#budgetTotal;
		const increment = Math.max(1, current);
		const proposed = Math.max(current + increment, this.#spent + increment);
		this.#log(`  budget: ${this.#spent.toFixed(2)}/${current.toFixed(2)} AIC used; awaiting approval for ${increment.toFixed(2)} additional AIC`, "warning");
		this.#budgetIncreasePromise = Promise.resolve(requestBudgetIncrease({ current, spent: this.#spent, increment, proposed }))
			.then((approved) => {
				if (approved == null) {
					// Not journaled: a later resume in a session that can prompt may still ask.
					this.#budgetIncreaseDeclined = true;
					this.#log("  budget: approval UI unavailable", "warning");
					return false;
				}
				if (!approved) {
					this.#budgetIncreaseDeclined = true;
					this.#checkpoints?.recordControl({ action: "budget_increase_declined", from: current, proposed, spent: this.#spent, decidedAt: new Date().toISOString() });
					this.#log("  budget: increase declined", "warning");
					return false;
				}
				const approvedTotal = Math.max(proposed, this.#spent + increment);
				this.#budgetTotal = approvedTotal;
				this.#budgetHit = false;
				this.#checkpoints?.recordControl({ action: "budget_increased", from: current, proposed, to: approvedTotal, increment, spent: this.#spent, approvedAt: new Date().toISOString() });
				this.#log(`  budget: approved ${increment.toFixed(2)} additional AIC; ceiling is now ${approvedTotal.toFixed(2)}`, "info");
				return true;
			})
			.catch((error) => {
				this.#budgetIncreaseDeclined = true;
				this.#log(`  budget: approval failed: ${error instanceof Error ? error.message : error}`, "warning");
				return false;
			})
			.finally(() => {
				this.#budgetIncreasePromise = null;
			});
		return this.#budgetIncreasePromise;
	}

	/**
	 * Send another turn to an existing agent's session (multi-turn via `--resume`).
	 * @param {AgentResult} result
	 * @param {string} prompt
	 * @param {Record<string, any>} [opts]
	 * @returns {Promise<AgentResult>}
	 */
	async followUp(result, prompt, opts = {}) {
		if (!result || !result.sessionId) throw new Error("workflow: cannot follow up — result has no sessionId");
		return this.agent(prompt, { ...opts, resume: result.sessionId });
	}

	// ---- barriers & pipeline ------------------------------------------
	/**
	 * Run zero-arg `thunks` concurrently; results in order (a barrier).
	 * @param {(() => any)[]} thunks
	 * @param {{ concurrency?: number, onFailure?: "raise"|"drop"|"keep" }} [opts]
	 * @returns {Promise<any[]>}
	 */
	async parallel(thunks, opts = {}) {
		const list = [...thunks];
		this.#capItems(list.length, "parallel");
		return this.#concurrentMap(list.length, (i) => list[i](), { ...opts, kind: "parallel" });
	}

	/**
	 * Stream each item through `stages` independently (no barrier between stages). An optional
	 * trailing non-function argument is treated as `{ concurrency?, onFailure? }`.
	 * @param {any[]} items
	 * @param {...((prev: any, item: any, index: number) => any) | { concurrency?: number, onFailure?: "raise"|"drop"|"keep" }} stages
	 * @returns {Promise<any[]>}
	 */
	async pipeline(items, ...stages) {
		/** @type {{ concurrency?: number, onFailure?: "raise"|"drop"|"keep" }} */
		let opts = {};
		if (stages.length && typeof stages[stages.length - 1] !== "function") opts = /** @type {any} */ (stages.pop());
		const fns = /** @type {((prev: any, item: any, index: number) => any)[]} */ (stages);
		const list = [...items];
		if (!list.length) return [];
		this.#capItems(list.length, "pipeline");
		if (!fns.length) return list;
		return this.#concurrentMap(
			list.length,
			async (i) => {
				let prev = list[i];
				for (const stage of fns) {
					prev = await stage(prev, list[i], i);
					if (isUnsuccessfulAgentOutcome(prev)) break;
				}
				return prev;
			},
			{ ...opts, kind: "pipeline" },
		);
	}

	// ---- worktrees -----------------------------------------------------
	/**
	 * Give an agent its own detached git worktree. Callback form runs `cb(dir)` then auto-cleans;
	 * without a callback, returns a `{ path, cleanup }` handle (explicit lifecycle form).
	 * @param {string} name
	 * @param {Record<string, any> | ((dir: string) => any)} [optsOrCb]
	 * @param {(dir: string) => any} [maybeCb]
	 * @returns {Promise<any>}
	 */
	async #worktree(name, optsOrCb, maybeCb) {
		let opts = {};
		let cb = null;
		if (typeof optsOrCb === "function") cb = optsOrCb;
		else {
			opts = optsOrCb || {};
			cb = maybeCb || null;
		}
		const wt = await this.#worktreeCreate(name, opts);
		if (!cb) return wt;
		try {
			return await cb(wt.path);
		} finally {
			await wt.cleanup();
		}
	}

	/**
	 * Create a worktree and return a `{ path, cleanup }` handle.
	 * @param {string} name
	 * @param {{ baseRef?: string, repo?: string, ref?: string, cloneDir?: string }} [opts]
	 * @returns {Promise<{ path: string, cleanup: () => Promise<void> }>}
	 */
	async #worktreeCreate(name, opts = {}) {
		if (this.restricted) throw new Error("workflow: worktree() is forbidden in restricted mode");
		if (this.dryRun) {
			const path = opts.repo && existsSync(opts.repo) ? resolve(opts.repo) : (await findRepoRoot(this.#cwd)) || this.#cwd;
			return { path, cleanup: async () => {} };
		}
		const mgr = await this.#managerFor(opts.repo ?? null, opts.cloneDir ?? null);
		const path = await mgr.create(name, opts.baseRef ?? null, opts.ref ?? null);
		this.#trustedWorktreeDirs.add(resolve(path));
		return {
			path,
			cleanup: async () => {
				try {
					await mgr.remove(path);
				} finally {
					this.#trustedWorktreeDirs.delete(resolve(path));
				}
			},
		};
	}

	/**
	 * Lazily build (and cache) a {@link WorktreeManager} for a repo root. `repo` may be null (launch
	 * repo), a local path, or a clone URL (cloned once into a cache or `cloneDir`). Worktrees live in a
	 * per-run temp base (`$TMPDIR/cwf-wt-*`), outside the repo, so they leave no repo footprint and
	 * don't trip repo-scoped file watchers / Spotlight / Time Machine during a fan-out.
	 * @param {string|null} repo @param {string|null} cloneDir
	 * @returns {Promise<WorktreeManager>}
	 */
	async #managerFor(repo, cloneDir) {
		this.#wtBase ??= mkdtempSync(join(tmpdir(), "cwf-wt-"));
		/** @type {string} */
		let root;
		if (repo == null) {
			const found = await findRepoRoot(this.#cwd);
			if (!found) throw new Error(`worktree requires a git repository (none found at ${this.#cwd})`);
			root = found;
		} else if (existsSync(repo)) {
			root = repo;
		} else {
			// Remote URL: clone once into a persistent dir (`cloneDir`) or the per-run temp cache.
			const dest = cloneDir ? clonePath(repo, cloneDir) : join(this.#wtBase, "_repos", _sanitize(repo));
			root = await ensureClone(repo, dest, this.#log);
		}
		let mgr = this.#wtManagers.get(root);
		if (!mgr) {
			// The launch repo's worktrees sit directly under the temp base; other repos get a
			// per-root subdir so their worktree names can't collide.
			const base = repo == null ? this.#wtBase : join(this.#wtBase, _sanitize(root));
			mgr = new WorktreeManager(root, base, { logger: this.#log, fetchRemote: !(repo && existsSync(repo)) });
			this.#wtManagers.set(root, mgr);
		}
		return mgr;
	}

	/**
	 * Remove every worktree created during the run (force-removing clean ones, preserving dirty ones)
	 * and prune. The per-run temp base (`$TMPDIR/cwf-wt-*`) is deleted only when nothing dirty was
	 * preserved, so a clean run leaves zero on-disk trace while any dirty subagent work survives (still
	 * in temp, outside the repo) for inspection. Safe to call always. Returns preserved dirty paths.
	 * @returns {Promise<string[]>}
	 */
	async cleanup() {
		if (!this.#wtManagers.size) return this.#preservedDirty;
		for (const mgr of this.#wtManagers.values()) {
			try {
				this.#preservedDirty.push(...(await mgr.cleanupAll()));
			} catch (e) {
				this.#log(`  ! worktree cleanup failed: ${e instanceof Error ? e.message : e}`);
			}
		}
		// Zero-trace on a clean run; keep the temp base when dirty worktrees were preserved under it.
		if (this.#wtBase && !this.#preservedDirty.length) {
			rmSync(this.#wtBase, { recursive: true, force: true });
			this.#wtBase = null;
		}
		this.#wtManagers.clear();
		this.#trustedWorktreeDirs.clear();
		return this.#preservedDirty;
	}

	/**
	 * Shared concurrent map with branch-scoped cache keys. `errors:"drop"` returns null for a failed
	 * slot; `"raise"` (default) aborts on the first error. `BudgetExceeded` always propagates.
	 * @param {number} n
	 * @param {(i: number) => any} work
	 * @param {{ concurrency?: number, onFailure?: "raise"|"drop"|"keep", kind?: "parallel"|"pipeline" }} opts
	 * @returns {Promise<any[]>}
	 */
	async #concurrentMap(n, work, opts) {
		if (n <= 0) return [];
		const failureMode = opts.onFailure ?? "raise";
		if (!["keep", "drop", "raise"].includes(failureMode)) throw new Error(`workflow: onFailure must be keep, drop, or raise (got ${failureMode})`);
		const limit = Math.min(opts.concurrency && opts.concurrency > 0 ? opts.concurrency : this.concurrency, n);
		const parent = branchStore.getStore() || [];
		const kind = opts.kind || "parallel";
		const base = this.#reserveBranches(parent, n);
		const results = new Array(n).fill(null);
		let next = 0;
		let firstError = /** @type {any} */ (null);
		const gid = ++this.#groupSeq;
		const phase = this.#currentPhase ?? null;
		this.#emit({ ev: "group_start", gid, kind, phase, n });

		const runOne = async () => {
			while (true) {
				const i = next++;
				if (i >= n || firstError) return;
				try {
					const value = await branchStore.run([...parent, base + i], () => work(i));
					if (isFailedAgentOutcome(value)) {
						if (failureMode === "keep") results[i] = value;
						else if (failureMode === "drop") this.#dropGroupItem({ results, i, gid, kind, phase, error: value.error || "agent failed" });
						else firstError = new Error(value.error || "agent failed");
						continue;
					}
					results[i] = value;
				} catch (e) {
					if (e instanceof BudgetExceeded || e instanceof AgentCapExceeded) {
						firstError = firstError || e;
						return;
					}
					if (failureMode === "keep") {
						results[i] = this.#callbackFailure(e);
					} else if (failureMode === "drop") {
						this.#dropGroupItem({ results, i, gid, kind, phase, error: e instanceof Error ? e.message : String(e) });
					} else {
						firstError = firstError || e;
						return;
					}
				}
			}
		};

		try {
			await Promise.all(Array.from({ length: limit }, runOne));
		} finally {
			this.#emit({ ev: "group_end", gid, kind, phase, n });
		}
		if (firstError) throw firstError;
		return results;
	}

	/**
	 * Claim a contiguous block of `size` branch indices under `parent`. The block is identified by
	 * the harness code that created the group (see {@link Runtime#groupIdentity}) and recorded in
	 * the journal, so a resume gives each logical group the branches it had originally no matter
	 * what order the groups start in.
	 * @param {number[]} parent @param {number} size
	 */
	#reserveBranches(parent, size) {
		const identity = this.#groupIdentity();
		const seen = JSON.stringify([parent, identity]);
		const occurrence = this.#groupSites.get(seen) ?? 0;
		this.#groupSites.set(seen, occurrence + 1);
		if (this.#checkpoints) return this.#checkpoints.reserveBranches(parent, `${identity}#${occurrence}|${size}`, size);
		const parentKey = JSON.stringify(parent);
		const base = this.#nextBranchIndex.get(parentKey) ?? 0;
		this.#nextBranchIndex.set(parentKey, base + size);
		return base;
	}

	/**
	 * Durable identity of the harness code creating a group: the *text* of the harness line the call
	 * came from, plus how many earlier lines carry that same text. Using text rather than a line
	 * number means inserting a comment above a group, or reordering two groups whose call lines
	 * differ in text, keeps each group's identity — and therefore its branches and its cache.
	 * Editing the line yields a new identity, which safely re-runs that group rather than adopting
	 * another group's branches. Two byte-identical call lines are separated only by their order in
	 * the file, so reordering those does swap their blocks.
	 *
	 * Only the innermost harness frame is used: frames further up the stack depend on whether an
	 * awaited agent was cached, so they differ between a run and its resume.
	 */
	#groupIdentity() {
		const frames = harnessFrames();
		const own = frames.find((frame) => frame.file === this.#harnessFile);
		if (own) return this.#lineIdentity(own);
		const outer = frames[0];
		return outer ? `${outer.file}:${outer.line}:${outer.column}` : "unknown";
	}

	/** @param {{ file: string, line: number, column: number }} frame */
	#lineIdentity(frame) {
		const text = (this.#harnessLines[frame.line - 1] ?? "").trim();
		if (!text) return `${frame.line}:${frame.column}`;
		let ordinal = 0;
		for (let i = 0; i < frame.line - 1; i++) if (this.#harnessLines[i].trim() === text) ordinal++;
		return `${text}@${ordinal}`;
	}

	/** @param {{ results: any[], i: number, gid: number, kind: string, phase: string|null, error: string }} p */
	#dropGroupItem(p) {
		this.#droppedCount++;
		this.#log(`  ! dropped item ${p.i}: ${p.error}`);
		this.#emit({ ev: "drop", gid: p.gid, kind: p.kind, phase: p.phase, index: p.i, error: p.error });
		p.results[p.i] = null;
	}

	/** @param {unknown} error @returns {AgentResult} */
	#callbackFailure(error) {
		const message = error instanceof Error ? error.message : String(error);
		return this.#synthetic("", { prompt: "", model: null, label: "callback" }, { error: message });
	}

	// ---- internals -----------------------------------------------------
	/** @param {Record<string, any>} o @param {{ cacheCwd?: string|null, trustedCwd?: boolean }} [internal] @returns {AgentSpec} */
	#buildSpec(o, internal = {}) {
		const removed = ["allowAllTools", "allow", "deny", "allowUrl", "denyUrl", "enableMcp", "addDir", "extraArgs", "cacheCwd"].filter((key) => {
			const value = o[key];
			return Array.isArray(value) ? value.length > 0 : value != null;
		});
		if (removed.length) {
			throw new Error(`workflow: removed agent option(s): ${removed.join(", ")}. Use profile, tools, permissions, and mcp instead.`);
		}
		if (o.mcp != null && !["inherit", "off"].includes(o.mcp)) {
			throw new Error("workflow: agent mcp must be 'inherit' or 'off'; arbitrary MCP configuration belongs at workflow launch");
		}
		if (this.restricted) {
			if (!["none", "read-only"].includes(o.profile ?? "read-only")) {
				throw new Error(`workflow: restricted mode forbids agent profile '${o.profile}'`);
			}
			if (o.isolation) throw new Error("workflow: restricted mode forbids tool-escalation options: isolation");
		}
		if (!this.dryRun && this.#parentPermissionMode === "off" && ["read-only", "research"].includes(o.profile)) {
			throw new Error(`workflow: profile '${o.profile}' requires parent allow-all 'on' or 'auto'; fine-grained parent rules are not exposed authoritatively. Change the parent permission mode or use profile 'none'.`);
		}
		const effective = applyAgentProfile(o, {
			parentPermissionMode: this.#parentPermissionMode,
			parentSessionMode: this.#parentSessionMode,
			allowedDirs: this.#allowedDirs,
		});
		const spec = applyRunSettings(effective, { model: this.model, effort: this.effort, context: this.context, defaultEnableMcp: this.defaultEnableMcp, cwd: this.#cwd });
		if (!spec.enableMcp) {
			spec.excludedTools = [...new Set([...(spec.excludedTools || []), "mcp:*"])];
		}
		spec.cacheCwd = internal.cacheCwd ?? spec.cwd;
		if (spec.cwd && !internal.trustedCwd && !this.#cwdAllowed(spec.cwd)) {
			throw new Error(`workflow: agent cwd is outside the parent-approved directories: ${spec.cwd}`);
		}
		return spec;
	}

	/** @param {string} candidate */
	#cwdAllowed(candidate) {
		let target;
		try {
			target = realpathSync(candidate);
		} catch {
			target = resolve(candidate);
		}
		if ([...this.#trustedWorktreeDirs].some((dir) => {
			const rel = relative(dir, target);
			return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
		})) return true;
		return this.#allowedDirs.some((dir) => {
			let root;
			try {
				root = realpathSync(dir);
			} catch {
				root = resolve(dir);
			}
			const rel = relative(root, target);
			return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
		});
	}

	/**
	 * @param {string} content
	 * @param {AgentSpec} spec
	 * @param {{ skipped?: boolean, error?: string|null }} [extra]
	 * @returns {AgentResult}
	 */
	#synthetic(content, spec, extra = {}) {
		return {
			kind: "agent",
			value: content,
			content,
			ok: !extra.skipped && !extra.error,
			error: extra.error ?? null,
			sessionId: null,
			model: spec.model ?? null,
			cached: false,
			skipped: !!extra.skipped,
			label: spec.label ?? null,
			nanoAiu: 0,
			aic: 0,
			usageUnknown: false,
			outputTokens: 0,
			inputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			durationMs: 0,
			exitCode: extra.skipped ? -1 : 0,
			warnings: null,
		};
	}

	/**
	 * @param {number} seq
	 * @param {AgentResult} res
	 * @param {boolean} skipped
	 * @param {string|null} phase
	 */
	#finish(seq, res, skipped, phase) {
		this.#stats.record(res);
		this.#emit({
			ev: "end",
			seq,
			label: res.label || "agent",
			ok: res.ok,
			cached: res.cached,
			skipped,
			nanoAiu: res.nanoAiu,
			outputTokens: res.outputTokens,
			error: res.error,
			usageUnknown: res.usageUnknown,
			model: res.model,
			phase,
		});
	}

	/** @param {any} rec */
	#emit(rec) {
		try {
			this.#progress({ ...rec, t: Date.now() });
		} catch {
			/* progress must never crash the run */
		}
	}

	/** @returns {boolean} */
	#overBudget() {
		return this.#budgetTotal != null && this.#spent >= this.#budgetTotal;
	}

	/** @param {number} amount */
	#charge(amount) {
		this.#spent += amount || 0;
		if (this.#budgetTotal != null && this.#spent >= this.#budgetTotal) this.#budgetHit = true;
	}

	/** @param {number} count @param {"parallel"|"pipeline"} kind */
	#capItems(count, kind) {
		if (count > maxGroupItems()) {
			throw new Error(`workflow: ${kind} item cap exceeded (${count} > MAX_GROUP_ITEMS=${maxGroupItems()})`);
		}
	}

	/**
	 * Cache key for an explicit user key, namespaced by branch scope. A structured JSON tuple (not a
	 * `-`-joined string) so an explicit key can never collide with another scope's key or an auto key.
	 * @param {string} key @returns {string}
	 */
	#scopedKey(key, /** @type {AgentSpec} */ spec) {
		const branch = branchStore.getStore() || [];
		return JSON.stringify(["e", branch, this.#currentEpoch(branch), key, fingerprint(spec)]);
	}

	/**
	 * Cache key for an auto-keyed agent: (branch scope, full spec fingerprint, occurrence index).
	 * Structured and tagged `"a"`, so it can't collide with an explicit `"e"` key.
	 * @param {AgentSpec} spec @returns {string}
	 */
	#agentKey(spec) {
		const branch = branchStore.getStore() || [];
		const epoch = this.#currentEpoch(branch);
		const fp = fingerprint(spec);
		const base = JSON.stringify(["a", branch, epoch, fp]);
		const n = this.#occurrence.get(base) ?? 0;
		this.#occurrence.set(base, n + 1);
		return JSON.stringify(["a", branch, epoch, fp, n]);
	}

	/** @param {number[]} [branch] */
	#currentEpoch(branch = branchStore.getStore() || []) {
		const sideEffectEpoch = this.#sideEffectEpoch.get(JSON.stringify(branch)) ?? 0;
		const invalidationEpoch = this.#checkpoints?.invalidationEpoch(branch) ?? 0;
		return invalidationEpoch ? `i${invalidationEpoch}:s${sideEffectEpoch}` : sideEffectEpoch;
	}

	#bumpEpoch() {
		const branch = branchStore.getStore() || [];
		const key = JSON.stringify(branch);
		this.#sideEffectEpoch.set(key, (this.#sideEffectEpoch.get(key) ?? 0) + 1);
	}

	// ---- host effects --------------------------------------------------
	/** Install the loaded sidecar (its effect functions become the `host.*` namespace). @param {import("./effects.mjs").LoadedHost|null} loaded */
	setHost(loaded) {
		this.#host = loaded;
	}

	/**
	 * The context object every sidecar effect receives as its 2nd arg: the run's cwd/mode + signal +
	 * log. Deliberately minimal — sidecars implement whatever host I/O they need with raw Node
	 * (`node:child_process`, `node:fs`, `fetch`, npm), so the framework carries no utility grab-bag.
	 * Built once per run.
	 * @returns {import("./effects.mjs").EffectCtx}
	 */
	#effectCtx() {
		if (!this.#hostCtx) {
			this.#hostCtx = { cwd: this.#cwd, dryRun: this.dryRun, restricted: this.restricted, signal: this.#abort.signal, log: (/** @type {unknown} */ m) => this.#log(String(m)) };
		}
		return this.#hostCtx;
	}

	/**
	 * Run one sidecar effect and checkpoint its result — the code analogue of {@link Runtime#agent}.
	 * Cached by (branch, name, canonical input, occurrence) so repeated calls and read-after-write
	 * stay correct, and a resumed run replays recorded results instead of re-executing. Mutating
	 * effects are skipped under dry-run; execution is bounded by the run's concurrency semaphore and
	 * cancelled with the run; every returned result is JSON-normalized (so it stays checkpointable and
	 * dry-run/uncached behave like a cached real run).
	 * @param {string} name @param {unknown} input @param {{ cache?: boolean }} [opts]
	 * @returns {Promise<unknown>}
	 */
	async #effect(name, input, opts = {}) {
		const host = this.#host;
		const fn = host?.fns.get(name);
		if (!host || !fn) throw new Error(`workflow: no host effect '${name}'`);
		const cache = opts.cache !== false;
		const mutates = host.mutates.has(name);
		const label = `host.${name}`;

		if (this.dryRun && mutates) {
			this.#log(`  ${label}: [dry-run] skipped (mutating)`);
			return undefined;
		}
		if (this.#abort.signal.aborted) throw new Error(`${label} skipped: run aborting`);

		// Reuse the agent checkpoint journal: an effect record is `{ value, ok, aic:0 }`, keyed by
		// (branch, name, canonical input, occurrence) so repeated calls and read-after-write are
		// distinct and a resumed run replays in order. Cast at the store boundary since the store is
		// typed for AgentResult.
		const checkpoints = cache ? this.#checkpoints : null;
		let key = null;
		if (checkpoints) {
			const branch = branchStore.getStore() || [];
			const epoch = this.#currentEpoch(branch);
			const canon = stableStringify(input);
			const base = JSON.stringify(["fx", branch, epoch, host.hash, name, canon]);
			const n = this.#occurrence.get(base) ?? 0;
			this.#occurrence.set(base, n + 1);
			key = JSON.stringify(["fx", branch, epoch, host.hash, name, canon, n]);
			const cached = /** @type {any} */ (checkpoints.get(key));
			if (cached) {
				if (mutates) this.#bumpEpoch();
				this.#log(`  ${label} (cached)`);
				return cached.value;
			}
		}

		// Bound effect concurrency with the same semaphore agents use — a large pipeline of spawning/
		// fetching effects can't outrun the limiter.
		let value;
		await this.#sem.acquire();
		try {
			value = await fn(input, this.#effectCtx());
		} catch (e) {
			throw new Error(`${label} failed: ${e instanceof Error ? e.message : e}`);
		} finally {
			this.#sem.release();
		}

		// Normalize every returned result through a JSON round-trip so dry-run/uncached and cached runs
		// behave identically and a non-serializable result fails loudly rather than silently.
		let normalized;
		try {
			normalized = JSON.parse(JSON.stringify(value === undefined ? null : value));
		} catch {
			throw new Error(`${label} result must be JSON-serializable — return plain data or call with { cache: false }`);
		}
		if (checkpoints && key) checkpoints.put(key, /** @type {any} */ ({ value: normalized, ok: true, aic: 0 }));
		if (mutates) this.#bumpEpoch();
		this.#log(`  ${label}${cache ? "" : " (uncached)"}`);
		return normalized;
	}

	/**
	 * Build the object of globals injected into the harness VM.
	 * @param {unknown} args
	 * @returns {Record<string, unknown>}
	 */
	buildApi(args) {
		const agent = /** @type {any} */ (this.agent.bind(this));
		agent.followUp = this.followUp.bind(this);
		const context = Object.freeze({
			args,
			dryRun: this.dryRun,
			budget: Object.freeze(this.budget),
			capabilities: Object.freeze({
				backend: this.#agentBackend.kind,
				permissions: permissionCapability(this.#parentPermissionMode),
				interactionMode: this.#parentSessionMode,
				structuredOutput: "parse-repair",
			}),
			memory: this.#memoryApi(),
		});
		const phase = (/** @type {string} */ name, /** @type {() => any} */ callback) => {
			if (typeof callback !== "function") throw new Error("workflow: phase(name, callback) requires a callback");
			return this.phase(name, callback);
		};
		return {
			context,
			agent,
			parallel: this.parallel.bind(this),
			pipeline: this.pipeline.bind(this),
			phase,
			log: this.log.bind(this),
			verify: (/** @type {any} */ subject, /** @type {any} */ rubric, /** @type {any} */ opts) => patterns.verify(this, subject, rubric, opts),
			host: this.#hostApi(),
			workspace: Object.freeze({ worktree: this.#worktreeApi() }),
		};
	}

	#hostApi() {
		return buildHostProxy({
			names: this.#host?.names ?? [],
			invoke: (name, input, opts) => this.#track(this.#effect(name, input, opts)),
			restricted: this.restricted,
			hasSidecar: !!this.#host,
		});
	}

	#worktreeApi() {
		/** @type {any} */
		const worktree = this.restricted
			? () => {
					throw new Error("workflow: worktree() is forbidden in restricted mode");
			  }
			: (/** @type {string} */ name, /** @type {any} */ a, /** @type {any} */ b) => this.#worktree(name, a, b);
		if (!this.restricted) worktree.create = (/** @type {string} */ name, /** @type {any} */ opts) => this.#worktreeCreate(name, opts);
		return worktree;
	}

	#memoryApi() {
		const rt = this;
		return Object.freeze({
			get enabled() {
				return rt.memory.enabled;
			},
			read() {
				const branch = branchStore.getStore() || [];
				const epoch = rt.#currentEpoch(branch);
				const base = JSON.stringify(["memory-read", branch, epoch, rt.memory.path || null]);
				const occurrence = rt.#occurrence.get(base) ?? 0;
				rt.#occurrence.set(base, occurrence + 1);
				const key = JSON.stringify(["memory-read", branch, epoch, rt.memory.path || null, occurrence]);
				const cached = /** @type {any} */ (rt.#checkpoints?.get(key));
				if (cached) return String(cached.value ?? "");
				const value = rt.memory.read();
				rt.#checkpoints?.put(key, /** @type {any} */ ({ value, ok: true, aic: 0 }));
				return value;
			},
			write(/** @type {string} */ text) {
				rt.memory.write(String(text));
				rt.#bumpEpoch();
			},
			append(/** @type {string} */ text) {
				rt.memory.append(String(text));
				rt.#bumpEpoch();
			},
			clear() {
				rt.memory.clear();
				rt.#bumpEpoch();
			},
		});
	}

}

/**
 * Stack frames outside this extension: the harness code that created a concurrent group. Frames
 * inside the extension are skipped so `patterns.*` helpers report their caller rather than their
 * own source line. The trace limit is raised while capturing so a deep async stack cannot truncate
 * the harness frames away.
 * @returns {{ file: string, line: number, column: number }[]}
 */
function harnessFrames() {
	const previousPrepare = Error.prepareStackTrace;
	const previousLimit = Error.stackTraceLimit;
	Error.prepareStackTrace = (_error, frames) => frames;
	Error.stackTraceLimit = 200;
	try {
		const frames = /** @type {any} */ (new Error().stack);
		if (!Array.isArray(frames)) return [];
		const out = [];
		for (const frame of frames) {
			const file = frame?.getFileName?.();
			if (typeof file !== "string" || file.startsWith("node:")) continue;
			if ((file.startsWith("file:") ? fileURLToPath(file) : file).startsWith(FRAMEWORK_DIR)) continue;
			out.push({ file, line: frame.getLineNumber?.() ?? 0, column: frame.getColumnNumber?.() ?? 0 });
		}
		return out;
	} finally {
		Error.stackTraceLimit = previousLimit;
		if (previousPrepare === undefined) delete Error.prepareStackTrace;
		else Error.prepareStackTrace = previousPrepare;
	}
}

/**
 * Resolve an agent options object into a full {@link AgentSpec}, filling model/effort/context/cwd/
 * enableMcp/timeout from the run-level defaults only where the per-agent option is unset (per-agent
 * wins). Pure — exported so run-settings inheritance is testable without the Runtime.
 * @param {Record<string, any>} o
 * @param {{ model?: string|null, effort?: string|null, context?: string|null, defaultEnableMcp?: boolean, cwd?: string }} [defaults]
 * @returns {AgentSpec}
 */
export function applyRunSettings(o, defaults = {}) {
	const cwd = o.cwd ? resolve(defaults.cwd ?? process.cwd(), String(o.cwd)) : defaults.cwd ?? null;
	const addDir = Array.isArray(o.addDir) ? o.addDir.map((dir) => resolve(defaults.cwd ?? process.cwd(), String(dir))) : null;
	return {
		prompt: String(o.prompt ?? ""),
		model: o.model ?? defaults.model ?? null,
		effort: o.effort ?? defaults.effort ?? null,
		context: o.context ?? defaults.context ?? null,
		agentType: o.agentType ?? null,
		cwd,
		allow: o.allow ?? null,
		deny: o.deny ?? null,
		allowUrl: o.allowUrl ?? null,
		denyUrl: o.denyUrl ?? null,
		availableTools: o.availableTools ?? null,
		excludedTools: o.excludedTools ?? null,
		enableMcp: o.enableMcp ?? defaults.defaultEnableMcp ?? false,
		allowAllTools: o.allowAllTools ?? true,
		allowAllUrls: o.allowAllUrls ?? false,
		addDir,
		permissionMode: o.permissionMode ?? "off",
		autopilot: o.autopilot === true,
		resume: o.resume ?? null,
		timeout: o.timeout ?? null,
		label: o.label ?? null,
		cacheCwd: cwd,
	};
}

/**
 * @param {Record<string, any>} o
 * @param {{ parentPermissionMode: "off"|"on"|"auto", parentSessionMode: string, allowedDirs: string[] }} inherited
 */
function applyAgentProfile(o, inherited) {
	const profile = o.profile ?? "inherit";
	if (!["inherit", "none", "read-only", "research"].includes(profile)) {
		throw new Error(`workflow: unknown agent profile '${profile}'`);
	}
	const tools = o.tools && typeof o.tools === "object" ? o.tools : {};
	const permissions = o.permissions && typeof o.permissions === "object" ? o.permissions : {};
	const paths = stringListOption(permissions.paths, "permissions.paths");
	const deny = stringListOption(permissions.deny, "permissions.deny");
	const denyUrls = stringListOption(permissions.denyUrls, "permissions.denyUrls");
	const availableTools = stringListOption(tools.available, "tools.available");
	const excludedTools = stringListOption(tools.excluded, "tools.excluded");
	if (paths.length > 1) throw new Error("workflow: one permissions.paths root is supported per agent; use separate agents for disjoint roots");
	const permissionMode = profile === "none" ? "off" : inherited.parentPermissionMode;
	const parentAllowAll = permissionMode === "on";
	const coarseInherit = profile === "inherit" && permissionMode === "off";
	/** @type {Record<string, any>} */
	const base =
		profile === "none" || coarseInherit
			? { allowAllTools: false, allowAllUrls: false, enableMcp: false, denyUrl: ["*"], excludedTools: ["*"] }
			: profile === "read-only"
				? { allowAllTools: parentAllowAll, allowAllUrls: false, enableMcp: false, deny: ["shell", "write"], denyUrl: ["*"] }
				: profile === "research"
					? { allowAllTools: parentAllowAll, allowAllUrls: parentAllowAll, ...(o.mcp === "off" ? { enableMcp: false } : {}), deny: ["shell", "write"] }
					: { allowAllTools: parentAllowAll, allowAllUrls: parentAllowAll, ...(o.mcp === "off" ? { enableMcp: false } : {}) };
	return {
		...o,
		...(paths.length ? { cwd: paths[0] } : {}),
		...base,
		permissionMode,
		autopilot: inherited.parentSessionMode === "autopilot",
		addDir: profile === "none" || coarseInherit ? [] : paths.length ? paths : inherited.allowedDirs,
		allow: null,
		allowUrl: null,
		availableTools: availableTools.length ? availableTools : base.availableTools ?? null,
		excludedTools: [...new Set([...(base.excludedTools || []), ...excludedTools])],
		deny: [...new Set([...(base.deny || []), ...deny])],
		denyUrl: [...new Set([...(base.denyUrl || []), ...denyUrls])],
	};
}

/** @param {unknown} value @param {string} name */
function stringListOption(value, name) {
	const values = value == null ? [] : Array.isArray(value) ? value : [value];
	if (!values.every((item) => typeof item === "string" && item.length > 0)) {
		throw new Error(`workflow: ${name} must be a string or array of non-empty strings`);
	}
	return values;
}

/** @param {unknown} value @returns {"off"|"on"|"auto"} */
function normalizePermissionMode(value) {
	return value === "on" || value === "auto" ? value : "off";
}

/** The harness-visible capability string for a parent allow-all mode. @param {"off"|"on"|"auto"} mode */
export function permissionCapability(mode) {
	return mode === "on" ? "parent-on-profile-narrowed" : mode === "auto" ? "parent-auto-profile-narrowed" : "coarse-deny";
}

/** Stable sha256 over the semantic key fields (excludes label/phase). @param {AgentSpec} spec */
export function fingerprint(spec) {
	const payload = Object.fromEntries(
		KEY_FIELDS.map((field) => {
			let value = /** @type {any} */ (spec)[field] ?? null;
			if (SET_LIKE_KEY_FIELDS.has(field) && Array.isArray(value)) value = [...new Set(value.map(String))].sort();
			return [field, value];
		}),
	);
	return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export { copilotBin };
