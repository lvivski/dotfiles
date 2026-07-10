/**
 * @module runtime
 *
 * Harness runtime: agents, fan-out, budgets, checkpoints, worktrees, host effects, and progress.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runAgent, copilotBin } from "./agent.mjs";
import { Memory } from "./memory.mjs";
import * as patterns from "./patterns.mjs";
import { BudgetExceeded, defaultConcurrency, RunStats, Semaphore } from "./scheduler.mjs";
import { WorktreeManager, findRepoRoot, ensureClone, clonePath, _sanitize } from "./worktree.mjs";
import { buildHostProxy } from "./effects.mjs";
import { stableStringify } from "./json.mjs";

/** @typedef {import("./agent.mjs").AgentResult} AgentResult */
/** @typedef {import("./agent.mjs").AgentSpec} AgentSpec */
/** @typedef {import("./scheduler.mjs").RunCounts} RunCounts */

export { BudgetExceeded, defaultConcurrency };

/** Hard caps (overridable only by workflow-owned test/dev env, never by workflow source). */
export const MAX_AGENTS = 1000;
export const MAX_FANOUT = 4096;
const maxAgents = () => Number(process.env.CWF_MAX_AGENTS || MAX_AGENTS);
const maxFanout = () => Number(process.env.CWF_MAX_FANOUT || MAX_FANOUT);

/** Spec fields that define an agent's identity for checkpoint keys (excludes label/phase/timeout). */
const KEY_FIELDS = [
	"prompt", "model", "agentType", "effort", "context", "cwd", "resume", "enableMcp", "mcp",
	"allow", "deny", "allowUrl", "denyUrl", "addDir", "allowAllTools", "extraArgs",
];

const branchStore = new AsyncLocalStorage();

/**
 * The orchestration runtime injected into a harness (as the `agent`/`parallel`/… globals).
 */
export class Runtime {
	#budgetTotal;
	#checkpoints;
	/** @type {(e: any) => void} */
	#progress;
	/** @type {(m: string) => void} */
	#log;
	#sem;
	#abort;
	#spent = 0;
	#budgetHit = false;
	#seq = 0;
	#agentCount = 0;
	/** @type {string|null} */
	#currentPhase = null;
	/** @type {Map<string, number>} */
	#occurrence = new Map();
	/** @type {Set<Promise<void>>} in-flight agent() promises, so fire-and-forget calls can be drained. */
	#inflight = new Set();
	#stats = new RunStats();
	#droppedCount = 0;
	#cwd = process.cwd();
	/** @type {string|null} */
	#repoRoot = null;
	/** @type {string|null} */
	#wtBase = null;
	/** @type {Map<string, WorktreeManager>} */
	#wtManagers = new Map();
	/** @type {string[]} */
	#preservedDirty = [];
	#isoCounter = 0;
	/** @type {import("./effects.mjs").LoadedHost|null} */
	#host = null;
	/** @type {import("./effects.mjs").EffectCtx|null} */
	#hostCtx = null;
	#groupSeq = 0;
	/**
	 * @param {{
	 *   concurrency?: number|null, model?: string|null, effort?: string|null, context?: string|null,
	 *   defaultEnableMcp?: boolean, budget?: number|null, strictBudget?: boolean, dryRun?: boolean,
	 *   restricted?: boolean, checkpoints?: import("./checkpoint.mjs").CheckpointStore|null, memory?: Memory,
	 *   progress?: (e: any) => void, log?: (m: string) => void, abortController?: AbortController,
	 *   agentTimeout?: number|null, cwd?: string, repoRoot?: string|null,
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
		this.agentTimeout = opts.agentTimeout ?? null;
		this.memory = opts.memory ?? new Memory(null);
		this.#budgetTotal = opts.budget ?? null;
		this.#checkpoints = opts.checkpoints ?? null;
		this.#progress = opts.progress ?? (() => {});
		this.#log = opts.log ?? (() => {});
		this.#sem = new Semaphore(this.concurrency);
		this.#abort = opts.abortController ?? new AbortController();
		this.#spent = this.#checkpoints ? this.#checkpoints.priorSpent : 0;
		if (opts.cwd) this.#cwd = opts.cwd;
		this.#repoRoot = opts.repoRoot ?? null;

		// Budget accessors. `total` and `hit` are live; `set()` updates the run cap in-place.
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
			set: (/** @type {number|null} */ aic) => {
				rt.#budgetTotal = aic;
			},
		};
	}

	/** @returns {boolean} whether the observed soft cap has been reached. */
	get budgetHit() {
		return this.#budgetHit;
	}

	get agentCount() {
		return this.#stats.agentCount;
	}

	/** @returns {{ counts: RunCounts & { dropped: number }, nanoAiu: number }} */
	stats() {
		return { counts: { ...this.#stats.counts(), dropped: this.#droppedCount }, nanoAiu: this.#stats.nanoAiu };
	}

	/**
	 * Await every in-flight agent() call (including fire-and-forget ones a harness never awaited), so
	 * no subagent outlives the run uncounted. Idempotent; loops in case draining launches more.
	 * @returns {Promise<void>}
	 */
	async drain() {
		while (this.#inflight.size) await Promise.allSettled([...this.#inflight]);
	}

	/** @param {string} msg route a harness `log()`/`console.log` line to the run's narration sink. */
	log(msg) {
		this.#log(String(msg));
	}

	/** @param {string|null} name set the current phase for subsequently-launched agents. */
	phase(name) {
		this.#currentPhase = name ? String(name) : null;
	}

	// ---- single agent --------------------------------------------------
	/**
	 * Launch one subagent and track it so {@link Runtime#drain} can await fire-and-forget calls.
	 * @param {string|Record<string, any>} prompt
	 * @param {Record<string, any>} [opts]
	 * @returns {Promise<AgentResult>}
	 */
	agent(prompt, opts = {}) {
		return this.#track(this.#agentRun(prompt, opts));
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
	async #agentRun(prompt, opts = {}) {
		const o = this.#agentOptions(prompt, opts);
		if (o.isolation === "worktree" && !this.dryRun && !this.restricted) {
			return this.#worktree(`iso-${++this.#isoCounter}`, {}, (dir) => this.agent(o.prompt, { ...o, isolation: undefined, cwd: dir }));
		}
		this.#reserveAgentSlot();

		const spec = this.#buildSpec(o);
		const run = this.#startAgent(spec, o);

		if (this.dryRun) {
			const res = this.#synthetic("[dry-run]", spec);
			this.#finish(run.seq, res, false, run.phase);
			return res;
		}

		const key = this.#agentCacheKey(o, spec);
		const cached = this.#checkpoints?.get(key);
		if (cached) {
			this.#finish(run.seq, cached, false, run.phase);
			return cached;
		}

		await this.#sem.acquire();
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
		if (++this.#agentCount > maxAgents()) throw new Error(`workflow: agent cap exceeded (MAX_AGENTS=${maxAgents()}) — likely a runaway loop`);
	}

	/** @param {AgentSpec} spec @param {Record<string, any>} opts */
	#startAgent(spec, opts) {
		const phase = opts.phase ?? this.#currentPhase ?? null;
		const seq = ++this.#seq;
		this.#emit({ ev: "start", seq, label: spec.label || "agent", model: spec.model, phase });
		return { seq, phase };
	}

	/** @param {Record<string, any>} opts @param {AgentSpec} spec */
	#agentCacheKey(opts, spec) {
		return opts.key != null ? this.#scopedKey(String(opts.key)) : this.#agentKey(spec);
	}

	/**
	 * @param {AgentSpec} spec
	 * @param {string} key
	 * @param {{ seq: number, phase: string|null }} run
	 * @returns {Promise<{ res: AgentResult, skipped: boolean, strictStop: boolean }>}
	 */
	async #executeAgent(spec, key, run) {
		if (this.#abort.signal.aborted) {
			return { res: this.#synthetic("", spec, { skipped: true, error: "skipped: run aborting" }), skipped: true, strictStop: false };
		}
		if (this.#overBudget()) {
			this.#budgetHit = true;
			const res = this.#synthetic("", spec, { skipped: true, error: "skipped: budget reached" });
			if (this.strictBudget) {
				this.#finish(run.seq, res, true, run.phase);
				throw new BudgetExceeded(`budget ${this.#budgetTotal} reached (spent ${this.#spent.toFixed(4)})`);
			}
			return { res, skipped: true, strictStop: false };
		}

		const res = await runAgent(spec, { signal: this.#abort.signal });
		this.#charge(res.aic);
		if (this.#checkpoints && res.ok) this.#checkpoints.put(key, res);
		return { res, skipped: false, strictStop: this.strictBudget && this.#overBudget() };
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
	 * @param {{ concurrency?: number, errors?: "raise"|"drop" }} [opts]
	 * @returns {Promise<any[]>}
	 */
	async parallel(thunks, opts = {}) {
		const list = [...thunks];
		this.#capItems(list.length, "parallel");
		return this.#concurrentMap(list.length, (i) => list[i](), { errors: opts.errors ?? "drop", concurrency: opts.concurrency, kind: "parallel" });
	}

	/**
	 * Run `fn(item)` for every item concurrently; results in order (a barrier).
	 * @param {any[]} items
	 * @param {(item: any, index: number) => any} fn
	 * @param {{ concurrency?: number, errors?: "raise"|"drop" }} [opts]
	 * @returns {Promise<any[]>}
	 */
	async fanOut(items, fn, opts = {}) {
		const list = [...items];
		this.#capItems(list.length, "fanOut");
		return this.#concurrentMap(list.length, (i) => fn(list[i], i), { ...opts, kind: "fanOut" });
	}

	/**
	 * Stream each item through `stages` independently (no barrier between stages). An optional
	 * trailing non-function argument is treated as `{ concurrency?, errors? }`.
	 * @param {any[]} items
	 * @param {...((prev: any, item: any, index: number) => any) | { concurrency?: number, errors?: "raise"|"drop" }} stages
	 * @returns {Promise<any[]>}
	 */
	async pipeline(items, ...stages) {
		/** @type {{ concurrency?: number, errors?: "raise"|"drop" }} */
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
				for (const stage of fns) prev = await stage(prev, list[i], i);
				return prev;
			},
			{ errors: opts.errors ?? "drop", concurrency: opts.concurrency, kind: "pipeline" },
		);
	}

	/**
	 * Call `step(i)` until `done(result)` or `maxIters` reached; returns the history array.
	 * @param {(i: number) => any} step
	 * @param {(r: any) => boolean} done
	 * @param {{ maxIters?: number }} [opts]
	 * @returns {Promise<any[]>}
	 */
	async loopUntil(step, done, opts = {}) {
		const maxIters = opts.maxIters ?? 10;
		const history = [];
		for (let i = 0; i < maxIters; i++) {
			const r = await step(i);
			history.push(r);
			if (done(r)) break;
		}
		return history;
	}

	/**
	 * Option defaults for `agent(...)` that lock down an untrusted-content reader (deny shell+write,
	 * deny all URLs, MCP off). Pure — returns an options object.
	 * @param {{ deny?: string[], denyUrl?: string[], enableMcp?: boolean, [k: string]: any }} [opts]
	 * @returns {Record<string, any>}
	 */
	quarantine(opts = {}) {
		const { deny, denyUrl, enableMcp, ...extra } = opts;
		return {
			allowAllTools: true,
			deny: deny ?? ["shell", "write"],
			denyUrl: denyUrl ?? ["*"],
			enableMcp: enableMcp ?? false,
			...extra,
		};
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
			const path = opts.repo && existsSync(opts.repo) ? resolve(opts.repo) : this.#repoRoot || (await findRepoRoot(this.#cwd)) || this.#cwd;
			return { path, cleanup: async () => {} };
		}
		const mgr = await this.#managerFor(opts.repo ?? null, opts.cloneDir ?? null);
		const path = await mgr.create(name, opts.baseRef ?? null, opts.ref ?? null);
		return { path, cleanup: async () => mgr.remove(path) };
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
			const found = this.#repoRoot || (await findRepoRoot(this.#cwd));
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
		return this.#preservedDirty;
	}

	/**
	 * Shared concurrent map with branch-scoped cache keys. `errors:"drop"` returns null for a failed
	 * slot; `"raise"` (default) aborts on the first error. `BudgetExceeded` always propagates.
	 * @param {number} n
	 * @param {(i: number) => any} work
	 * @param {{ concurrency?: number, errors?: "raise"|"drop", kind?: "parallel"|"fanOut"|"pipeline" }} opts
	 * @returns {Promise<any[]>}
	 */
	async #concurrentMap(n, work, opts) {
		if (n <= 0) return [];
		const drop = (opts.errors ?? "raise") === "drop";
		const limit = Math.min(opts.concurrency && opts.concurrency > 0 ? opts.concurrency : this.concurrency, n);
		const parent = branchStore.getStore() || [];
		const results = new Array(n).fill(null);
		let next = 0;
		let firstError = /** @type {any} */ (null);
		const kind = opts.kind || "parallel";
		const gid = ++this.#groupSeq;
		const phase = this.#currentPhase ?? null;
		this.#emit({ ev: "group_start", gid, kind, phase, n });

		const runOne = async () => {
			while (true) {
				const i = next++;
				if (i >= n || firstError) return;
				try {
					results[i] = await branchStore.run([...parent, i], () => work(i));
				} catch (e) {
					if (e instanceof BudgetExceeded) {
						firstError = firstError || e;
						return;
					}
					if (drop) {
						const error = e instanceof Error ? e.message : String(e);
						this.#droppedCount++;
						this.#log(`  ! dropped item ${i}: ${error}`);
						this.#emit({ ev: "drop", gid, kind, phase, index: i, error });
						results[i] = null;
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

	// ---- internals -----------------------------------------------------
	/** @param {Record<string, any>} o @returns {AgentSpec} */
	#buildSpec(o) {
		if (this.restricted) {
			const escalations = ["allowAllTools", "allow", "allowUrl", "addDir", "mcp", "isolation"].filter((k) => (k === "allowAllTools" ? o[k] === true : Array.isArray(o[k]) ? o[k].length : o[k]));
			if (escalations.length) throw new Error(`workflow: restricted mode forbids tool-escalation options: ${escalations.join(", ")}`);
		}
		return applyRunSettings(o, { model: this.model, effort: this.effort, context: this.context, defaultEnableMcp: this.defaultEnableMcp, cwd: this.#cwd, agentTimeout: this.agentTimeout });
	}

	/**
	 * @param {string} content
	 * @param {AgentSpec} spec
	 * @param {{ skipped?: boolean, error?: string|null }} [extra]
	 * @returns {AgentResult}
	 */
	#synthetic(content, spec, extra = {}) {
		return {
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

	/** @param {number} count @param {"parallel"|"fanOut"|"pipeline"} kind */
	#capItems(count, kind) {
		if (count > maxFanout()) {
			throw new Error(`workflow: ${kind} item cap exceeded (${count} > MAX_FANOUT=${maxFanout()})`);
		}
	}

	/**
	 * Cache key for an explicit user key, namespaced by branch scope. A structured JSON tuple (not a
	 * `-`-joined string) so an explicit key can never collide with another scope's key or an auto key.
	 * @param {string} key @returns {string}
	 */
	#scopedKey(key) {
		return JSON.stringify(["e", branchStore.getStore() || [], key]);
	}

	/**
	 * Cache key for an auto-keyed agent: (branch scope, full spec fingerprint, occurrence index).
	 * Structured and tagged `"a"`, so it can't collide with an explicit `"e"` key.
	 * @param {AgentSpec} spec @returns {string}
	 */
	#agentKey(spec) {
		const branch = branchStore.getStore() || [];
		const fp = fingerprint(spec);
		const base = JSON.stringify(["a", branch, fp]);
		const n = this.#occurrence.get(base) ?? 0;
		this.#occurrence.set(base, n + 1);
		return JSON.stringify(["a", branch, fp, n]);
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
			const canon = stableStringify(input);
			const base = JSON.stringify(["fx", branch, name, canon]);
			const n = this.#occurrence.get(base) ?? 0;
			this.#occurrence.set(base, n + 1);
			key = JSON.stringify(["fx", branch, name, canon, n]);
			const cached = /** @type {any} */ (checkpoints.get(key));
			if (cached) {
				this.#log(`  ${label} (cached)`);
				return cached.value;
			}
		}

		// Bound effect concurrency with the same semaphore agents use — a large fanOut of spawning/
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
		this.#log(`  ${label}${cache ? "" : " (uncached)"}`);
		return normalized;
	}

	/**
	 * Build the object of globals injected into the harness VM.
	 * @param {unknown} args
	 * @returns {Record<string, unknown>}
	 */
	buildApi(args) {
		return {
			args,
			dryRun: this.dryRun,
			budget: this.budget,
			memory: this.memory,
			host: this.#hostApi(),
			agent: this.agent.bind(this),
			followUp: this.followUp.bind(this),
			parallel: this.parallel.bind(this),
			fanOut: this.fanOut.bind(this),
			pipeline: this.pipeline.bind(this),
			loopUntil: this.loopUntil.bind(this),
			quarantine: this.quarantine.bind(this),
			phase: this.phase.bind(this),
			log: this.log.bind(this),
			...this.#patternApi(),
			worktree: this.#worktreeApi(),
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

	#patternApi() {
		return {
			structured: (/** @type {string} */ prompt, /** @type {any} */ schema, /** @type {any} */ opts) => patterns.structured(this, prompt, schema, opts),
			verify: (/** @type {any} */ subject, /** @type {any} */ rubric, /** @type {any} */ opts) => patterns.verify(this, subject, rubric, opts),
			consensus: (/** @type {any} */ subject, /** @type {any} */ rubric, /** @type {any} */ opts) => patterns.consensus(this, subject, rubric, opts),
			synthesize: (/** @type {any[]} */ inputs, /** @type {any} */ opts) => patterns.synthesize(this, inputs, opts),
			classify: (/** @type {any} */ text, /** @type {string[]} */ classes, /** @type {any} */ opts) => patterns.classify(this, text, classes, opts),
			tournament: (/** @type {any[]} */ candidates, /** @type {any} */ criteria, /** @type {any} */ opts) => patterns.tournament(this, candidates, criteria, opts),
			generateAndFilter: (/** @type {any} */ generate, /** @type {any} */ opts) => patterns.generateAndFilter(this, generate, opts),
		};
	}
}

/**
 * Resolve an agent options object into a full {@link AgentSpec}, filling model/effort/context/cwd/
 * enableMcp/timeout from the run-level defaults only where the per-agent option is unset (per-agent
 * wins). Pure — exported so run-settings inheritance is testable without the Runtime.
 * @param {Record<string, any>} o
 * @param {{ model?: string|null, effort?: string|null, context?: string|null, defaultEnableMcp?: boolean, cwd?: string, agentTimeout?: number|null }} [defaults]
 * @returns {AgentSpec}
 */
export function applyRunSettings(o, defaults = {}) {
	return {
		prompt: String(o.prompt ?? ""),
		model: o.model ?? defaults.model ?? null,
		effort: o.effort ?? defaults.effort ?? null,
		context: o.context ?? defaults.context ?? null,
		agentType: o.agentType ?? null,
		cwd: o.cwd ? resolve(String(o.cwd)) : defaults.cwd ?? null,
		allow: o.allow ?? null,
		deny: o.deny ?? null,
		allowUrl: o.allowUrl ?? null,
		denyUrl: o.denyUrl ?? null,
		addDir: o.addDir ?? null,
		mcp: o.mcp ?? null,
		enableMcp: o.enableMcp ?? defaults.defaultEnableMcp ?? false,
		allowAllTools: o.allowAllTools ?? true,
		resume: o.resume ?? null,
		timeout: o.timeout ?? defaults.agentTimeout ?? null,
		label: o.label ?? null,
		extraArgs: o.extraArgs ?? null,
	};
}

/** Stable sha256 over the semantic key fields (excludes label/phase). @param {AgentSpec} spec */
export function fingerprint(spec) {
	const payload = Object.fromEntries(KEY_FIELDS.map((f) => [f, /** @type {any} */ (spec)[f] ?? null]));
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export { copilotBin };
