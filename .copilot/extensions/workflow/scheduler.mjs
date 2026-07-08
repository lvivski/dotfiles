/** @module scheduler — small scheduling primitives shared by the workflow runtime. */
import { cpus } from "node:os";

/** @typedef {Pick<import("./agent.mjs").AgentResult, "ok"|"cached"|"skipped"|"error"|"nanoAiu">} ResultStats */
/** @typedef {{ agents: number, launched: number, done: number, failed: number, cached: number, skipped: number }} RunCounts */

/** Raised (strict mode only) when observed AIC spend passes the cap. */
export class BudgetExceeded extends Error {}

/** @returns {number} default concurrency: min(16, max(2, cpuCount - 1)). */
export function defaultConcurrency() {
	const cpu = cpus()?.length || 4;
	return Math.min(16, Math.max(2, cpu - 1));
}

/** A minimal async counting semaphore bounding concurrent leaf work. */
export class Semaphore {
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

/** Compact run accounting; full agent content stays in harness variables and checkpoints. */
export class RunStats {
	/** @type {RunCounts} */
	#counts = { agents: 0, launched: 0, done: 0, failed: 0, cached: 0, skipped: 0 };
	#nanoAiu = 0;

	/** @param {ResultStats} result */
	record(result) {
		this.#counts.agents++;
		this.#nanoAiu += result.nanoAiu || 0;
		const kind = classifyResult(result);
		this.#counts[kind]++;
		if (kind === "done" || kind === "failed") this.#counts.launched++;
	}

	get agentCount() {
		return this.#counts.agents;
	}

	get nanoAiu() {
		return this.#nanoAiu;
	}

	/** @returns {RunCounts} */
	counts() {
		return { ...this.#counts };
	}
}

/** @param {ResultStats} r @returns {"done"|"failed"|"cached"|"skipped"} */
function classifyResult(r) {
	if (r.skipped || (!r.ok && String(r.error || "").startsWith("skipped:"))) return "skipped";
	if (r.cached) return "cached";
	return r.ok ? "done" : "failed";
}
