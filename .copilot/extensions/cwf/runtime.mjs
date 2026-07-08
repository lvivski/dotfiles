/**
 * @module runtime
 *
 * The `wf`-equivalent engine: spawns and coordinates subagents with a concurrency limiter, an
 * observed-spend AIC budget, resumable checkpoints, branch-scoped cache keys, hard caps, and
 * progress. It also owns the run lifecycle (`executeWorkflow`): prepare the run dir, extract `meta`,
 * run the harness in the deterministic VM, and persist `script.js` / `meta.json` / `run.json` /
 * `result.json` (+ `state.json`, `progress.jsonl`, `journal.jsonl` via their owners).
 *
 * Pure Node built-ins only — the SDK is imported solely by `extension.mjs`, keeping this testable
 * under plain `node`.
 */
import vm from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";

import { runAgent, killAllAgents, copilotBin } from "./agent.mjs";
import { CheckpointStore } from "./checkpoint.mjs";
import { Memory } from "./memory.mjs";
import { ProgressReporter } from "./progress.mjs";
import { runHarness, deterministicGlobals } from "./sandbox.mjs";
import * as patterns from "./patterns.mjs";
import { WorktreeManager, findRepoRoot, ensureClone, clonePath, _sanitize } from "./worktree.mjs";

/** @typedef {import("./agent.mjs").AgentResult} AgentResult */
/** @typedef {import("./agent.mjs").AgentSpec} AgentSpec */

/** Hard caps (overridable only by CWF-owned test/dev env, never by workflow source). */
export const MAX_AGENTS = 1000;
export const MAX_FANOUT = 4096;
const maxAgents = () => Number(process.env.CWF_MAX_AGENTS || MAX_AGENTS);
const maxFanout = () => Number(process.env.CWF_MAX_FANOUT || MAX_FANOUT);

/** Spec fields that define an agent's identity for checkpoint keys (excludes label/phase/timeout). */
const KEY_FIELDS = [
	"prompt", "model", "agentType", "effort", "context", "cwd", "resume", "enableMcp", "mcp",
	"allow", "deny", "allowUrl", "denyUrl", "addDir", "allowAllTools", "extraArgs",
];

/** Raised (strict mode only) when observed AIC spend passes the cap. */
export class BudgetExceeded extends Error {}

/** @returns {number} default concurrency: min(16, max(2, cpuCount - 1)). */
export function defaultConcurrency() {
	const cpu = cpus()?.length || 4;
	return Math.min(16, Math.max(2, cpu - 1));
}

/** A minimal async counting semaphore bounding concurrent leaf agent spawns. */
class Semaphore {
	#free;
	/** @type {(() => void)[]} */
	#waiters = [];
	#head = 0;
	/** @param {number} n */
	constructor(n) {
		this.#free = Math.max(1, n);
	}
	/** @returns {Promise<void>} */
	acquire() {
		if (this.#free > 0) {
			this.#free--;
			return Promise.resolve();
		}
		return new Promise((res) => this.#waiters.push(res));
	}
	release() {
		if (this.#head >= this.#waiters.length) {
			this.#free++;
			return;
		}
		const next = this.#waiters[this.#head++];
		// Advance a head index instead of shift() (O(1) not O(n)); compact the drained prefix
		// occasionally so the queue can't grow unbounded under many queued waiters.
		if (this.#head > 1024 && this.#head * 2 > this.#waiters.length) {
			this.#waiters = this.#waiters.slice(this.#head);
			this.#head = 0;
		}
		next();
	}
}

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
	#groupSeq = 0;
	/**
	 * @param {{
	 *   concurrency?: number|null, model?: string|null, effort?: string|null, context?: string|null,
	 *   defaultEnableMcp?: boolean, budget?: number|null, strictBudget?: boolean, dryRun?: boolean,
	 *   restricted?: boolean, checkpoints?: CheckpointStore|null, memory?: Memory,
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
		/** @type {AgentResult[]} */
		this.results = [];
		this.#budgetTotal = opts.budget ?? null;
		this.#checkpoints = opts.checkpoints ?? null;
		this.#progress = opts.progress ?? (() => {});
		this.#log = opts.log ?? (() => {});
		this.#sem = new Semaphore(this.concurrency);
		this.#abort = opts.abortController ?? new AbortController();
		this.#spent = this.#checkpoints ? this.#checkpoints.priorSpent : 0;
		if (opts.cwd) this.#cwd = opts.cwd;
		this.#repoRoot = opts.repoRoot ?? null;

		// Budget accessors. `total`/`hit` are live getters; `set()` mirrors Python's `wf.budget(aic)`.
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

	/** Abort the run: stop launching new agents and kill live subagents. */
	abort() {
		this.#abort.abort();
		killAllAgents();
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
	 * Launch one subagent (public entry). Registers the returned promise so a fire-and-forget
	 * (un-awaited) call is still awaited, counted, and reaped by {@link Runtime#drain} before the run
	 * finalizes — the async analogue of Python's blocking `wf.agent`.
	 * @param {string|Record<string, any>} prompt prompt string, or an options object containing `prompt`.
	 * @param {Record<string, any>} [opts] AgentSpec fields, plus runtime opts: `key` (explicit cache
	 *   key), `phase` (override the current phase label), and `isolation:"worktree"` (run in a fresh
	 *   detached worktree).
	 * @returns {Promise<AgentResult>}
	 */
	agent(prompt, opts = {}) {
		const p = this.#agentRun(prompt, opts);
		// A never-rejecting mirror: lets drain() await orphans without swallowing the caller's own
		// rejection, and (by attaching a handler to `p`) prevents an unhandled-rejection on orphans.
		const tracked = p.then(
			() => {},
			() => {},
		);
		this.#inflight.add(tracked);
		tracked.finally(() => this.#inflight.delete(tracked));
		return p;
	}

	/**
	 * Run one subagent (or return a cached/dry-run/skipped result). Never throws for ordinary
	 * subagent failure; throws only for cap breaches and (strict mode) budget overrun.
	 * @param {string|Record<string, any>} prompt
	 * @param {Record<string, any>} [opts]
	 * @returns {Promise<AgentResult>}
	 */
	async #agentRun(prompt, opts = {}) {
		const o = /** @type {Record<string, any>} */ (typeof prompt === "string" ? { ...opts, prompt } : { ...prompt });
		// isolation:"worktree" convenience — run this agent inside a fresh detached worktree.
		if (o.isolation === "worktree" && !this.dryRun && !this.restricted) {
			return this.#worktree(`iso-${++this.#isoCounter}`, {}, (dir) => this.agent(o.prompt, { ...o, isolation: undefined, cwd: dir }));
		}
		if (++this.#agentCount > maxAgents()) {
			throw new Error(`cwf: agent cap exceeded (MAX_AGENTS=${maxAgents()}) — likely a runaway loop`);
		}
		const spec = this.#buildSpec(o);
		const label = spec.label || "agent";
		const phase = o.phase ?? this.#currentPhase ?? null;
		const seq = ++this.#seq;
		this.#emit({ ev: "start", seq, label, model: spec.model, phase });

		if (this.dryRun) {
			const res = this.#synthetic("[dry-run]", spec);
			this.#finish(seq, res, false, phase);
			return res;
		}

		const key = o.key != null ? this.#scopedKey(String(o.key)) : this.#agentKey(spec);
		const cached = this.#checkpoints?.get(key);
		if (cached) {
			this.#finish(seq, cached, false, phase);
			return cached;
		}

		await this.#sem.acquire();
		let res;
		let skipped = false;
		let strictStop = false;
		try {
			if (this.#abort.signal.aborted) {
				res = this.#synthetic("", spec, { skipped: true, error: "skipped: run aborting" });
				skipped = true;
			} else if (this.#overBudget()) {
				this.#budgetHit = true;
				if (this.strictBudget) {
					res = this.#synthetic("", spec, { skipped: true, error: "skipped: budget reached" });
					this.#finish(seq, res, true, phase);
					throw new BudgetExceeded(`budget ${this.#budgetTotal} reached (spent ${this.#spent.toFixed(4)})`);
				}
				res = this.#synthetic("", spec, { skipped: true, error: "skipped: budget reached" });
				skipped = true;
			} else {
				res = await runAgent(spec, { signal: this.#abort.signal });
				this.#charge(res.aic);
				if (this.#checkpoints && res.ok) this.#checkpoints.put(key, res);
				strictStop = this.strictBudget && this.#overBudget();
			}
		} finally {
			this.#sem.release();
		}

		this.#finish(seq, res, skipped, phase);
		if (strictStop) throw new BudgetExceeded(`budget ${this.#budgetTotal} exceeded (spent ${this.#spent.toFixed(4)})`);
		return res;
	}

	/**
	 * Send another turn to an existing agent's session (multi-turn via `--resume`).
	 * @param {AgentResult} result
	 * @param {string} prompt
	 * @param {Record<string, any>} [opts]
	 * @returns {Promise<AgentResult>}
	 */
	async followUp(result, prompt, opts = {}) {
		if (!result || !result.sessionId) throw new Error("cwf: cannot follow up — result has no sessionId");
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
	 * trailing non-function argument is treated as `{ concurrency?, errors? }` (Python parity).
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
		if (this.restricted) throw new Error("cwf: worktree() is forbidden in restricted mode");
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
						this.#log(`  ! dropped item ${i}: ${e instanceof Error ? e.message : e}`);
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
			if (escalations.length) throw new Error(`cwf: restricted mode forbids tool-escalation options: ${escalations.join(", ")}`);
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
		this.results.push(res);
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
			throw new Error(`cwf: ${kind} item cap exceeded (${count} > MAX_FANOUT=${maxFanout()})`);
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

	/**
	 * Build the object of globals injected into the harness VM.
	 * @param {unknown} args
	 * @returns {Record<string, unknown>}
	 */
	buildApi(args) {
		// worktree() — callable (callback/lifecycle) with a `.create` for the explicit form.
		/** @type {any} */
		const worktree = this.restricted
			? () => {
					throw new Error("cwf: worktree() is forbidden in restricted mode");
			  }
			: (/** @type {string} */ name, /** @type {any} */ a, /** @type {any} */ b) => this.#worktree(name, a, b);
		if (!this.restricted) worktree.create = (/** @type {string} */ name, /** @type {any} */ opts) => this.#worktreeCreate(name, opts);
		return {
			args,
			budget: this.budget,
			memory: this.memory,
			agent: this.agent.bind(this),
			followUp: this.followUp.bind(this),
			parallel: this.parallel.bind(this),
			fanOut: this.fanOut.bind(this),
			pipeline: this.pipeline.bind(this),
			loopUntil: this.loopUntil.bind(this),
			quarantine: this.quarantine.bind(this),
			phase: this.phase.bind(this),
			log: this.log.bind(this),
			// Pattern helpers (Phase 5) — bound to this runtime, sharing the agent()/fanOut() path.
			structured: (/** @type {string} */ prompt, /** @type {any} */ schema, /** @type {any} */ opts) => patterns.structured(this, prompt, schema, opts),
			verify: (/** @type {any} */ subject, /** @type {any} */ rubric, /** @type {any} */ opts) => patterns.verify(this, subject, rubric, opts),
			consensus: (/** @type {any} */ subject, /** @type {any} */ rubric, /** @type {any} */ opts) => patterns.consensus(this, subject, rubric, opts),
			synthesize: (/** @type {any[]} */ inputs, /** @type {any} */ opts) => patterns.synthesize(this, inputs, opts),
			classify: (/** @type {any} */ text, /** @type {string[]} */ classes, /** @type {any} */ opts) => patterns.classify(this, text, classes, opts),
			tournament: (/** @type {any[]} */ candidates, /** @type {any} */ criteria, /** @type {any} */ opts) => patterns.tournament(this, candidates, criteria, opts),
			generateAndFilter: (/** @type {any} */ generate, /** @type {any} */ opts) => patterns.generateAndFilter(this, generate, opts),
			worktree,
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
 * @property {string} source        raw `.cwf.mjs` text
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
 * @property {string} [cwd]
 * @property {string|null} [repoRoot]
 * @property {AbortSignal} [signal]
 * @property {(line: string, level?: "info"|"warning"|"error") => void} [onLine]
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
			await runHarness(stripExports(cfg.source), { api: rt.buildApi(cfg.args), filename: `${cfg.runId}.cwf.mjs`, log: onLine });
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
			result: `dry-run plan: ${rt.results.length} agent call(s)` + (meta.name ? ` — ${meta.name}` : ""),
			preservedWorktrees,
		});
	}

	// --- real run ---
	mkdirSync(cfg.runDir, { recursive: true });
	writeFileSync(join(cfg.runDir, "script.js"), cfg.source, "utf8");
	writeMeta(cfg.runDir, cfg.runId, meta, cfg.args, !!cfg.restricted);

	const reporter = new ProgressReporter({
		jsonlPath: join(cfg.runDir, "progress.jsonl"),
		statePath: join(cfg.runDir, "state.json"),
		runId: cfg.runId,
		meta,
		title,
		onLine,
	});
	const checkpoints = new CheckpointStore(cfg.runDir, { resume: !!cfg.resume });
	// Memory is writable in a real run even under `restricted`: the runtime owns the file I/O, so a
	// restricted harness may still persist cross-run state (matches Python's `read_only=dry_run`).
	const memory = new Memory(cfg.memoryPath, { readOnly: false, log: onLine });
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
		log: onLine,
	});

	reporter.emit({ ev: "run_start", runId: cfg.runId, meta });
	let status = /** @type {RunStatus} */ ("complete");
	let error = null;
	let result = "";
	try {
		const value = await runHarness(stripExports(cfg.source), { api: rt.buildApi(cfg.args), filename: `${cfg.runId}.cwf.mjs`, log: (m) => rt.log(m) });
		result = coerceResult(value);
	} catch (e) {
		if (e instanceof BudgetExceeded) {
			status = "complete";
			onLine(`  budget reached: ${e.message}`, "warning");
		} else {
			status = "error";
			error = e instanceof Error ? e.message : String(e);
			onLine(`  ! workflow error: ${error}`, "error");
		}
	}
	if (cfg.signal?.aborted) status = "timeout";

	await rt.drain(); // await any fire-and-forget agents so none outlive the run uncounted
	const preservedWorktrees = await rt.cleanup();
	if (preservedWorktrees.length) onLine(`  preserved ${preservedWorktrees.length} dirty worktree(s): ${preservedWorktrees.join(", ")}`, "warning");
	const record = finalize({ runId: cfg.runId, status, error, meta, args: cfg.args, startedAt, rt, result, preservedWorktrees });
	writeFileSync(join(cfg.runDir, "run.json"), JSON.stringify(record, null, 2), "utf8");
	writeFileSync(join(cfg.runDir, "result.json"), JSON.stringify({ runId: record.runId, status: record.status, aic: record.aic, result: record.result }, null, 2), "utf8");
	reporter.emit({ ev: "run_end", runId: cfg.runId, ...record.counts, nanoAiu: rt.results.reduce((a, r) => a + r.nanoAiu, 0), aic: record.aic });
	onLine(reporter.runSummary(), status === "error" || status === "timeout" ? "error" : "info");
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
	const counts = summarize(rt.results);
	const nanoAiu = rt.results.reduce((a, r) => a + r.nanoAiu, 0);
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

/** @param {AgentResult[]} results */
function summarize(results) {
	let launched = 0, done = 0, failed = 0, cached = 0, skipped = 0;
	for (const r of results) {
		if (r.skipped || (!r.ok && String(r.error || "").startsWith("skipped:"))) skipped++;
		else if (r.cached) cached++;
		else if (r.ok) {
			done++;
			launched++;
		} else {
			failed++;
			launched++;
		}
	}
	return { agents: results.length, launched, done, failed, cached, skipped };
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

export { copilotBin };
