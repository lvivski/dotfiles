/**
 * @module checkpoint
 *
 * Append-only, resumable cache of successful agent results (`journal.jsonl`). On resume it loads
 * completed results so unchanged agents return instantly, and it accumulates their prior AIC spend
 * so a resumed budget is not double-charged. Torn trailing records (from a crash mid-write) are
 * repaired. Records carry a cache schema version so a future incompatible key change can invalidate
 * old entries instead of colliding.
 */
import { openSync, readSync, writeSync, fsyncSync, closeSync, existsSync, statSync, truncateSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const CHUNK = 64 * 1024;

/** @typedef {import("./agent.mjs").AgentResult} AgentResult */

/**
 * Drop an unterminated final JSONL line left by a crash mid-write, so the next append does not
 * fuse two records into one unparseable line (which would silently lose a committed result).
 * @param {string} path
 */
function repairTrailingLine(path) {
	try {
		const size = statSync(path).size;
		if (size === 0) return;
		const fd = openSync(path, "r+");
		try {
			const tail = Buffer.alloc(1);
			readSync(fd, tail, 0, 1, size - 1);
			if (tail[0] === 0x0a) return; // ends with newline: intact
			const buf = Buffer.alloc(Math.min(CHUNK, size));
			for (let pos = size; pos > 0;) {
				const len = Math.min(buf.length, pos);
				pos -= len;
				readSync(fd, buf, 0, len, pos);
				const nl = buf.subarray(0, len).lastIndexOf(0x0a);
				if (nl >= 0) {
					truncateSync(path, pos + nl + 1);
					return;
				}
			}
			truncateSync(path, 0);
		} finally {
			closeSync(fd);
		}
	} catch {
		// A bad repair attempt should not prevent loading the remaining journal records.
	}
}

/** Append-only, in-process cache of agent results keyed by a stable string key. */
export class CheckpointStore {
	#path;
	/** @type {Map<string, AgentResult>} */
	#cache = new Map();
	#priorSpent = 0;
	#priorUnknownUsage = 0;
	#latestBudget = null;
	#budgetIncreaseDeclined = false;
	/** @type {Map<string, number>} */
	#invalidationEpochs = new Map();
	#invalidationGeneration = 0;
	/** Durable branch block per logical group: `[parent, site]` -> base index. @type {Map<string, number>} */
	#groupBases = new Map();
	/** Next free branch index under each parent. @type {Map<string, number>} */
	#nextGroupBase = new Map();
	#lease;
	#readOnly = false;

	/**
	 * @param {string} runDir directory holding this run's artifacts
	 * @param {{ resume?: boolean, readOnly?: boolean, lease?: import("./persistence.mjs").Lease|null }} [opts]
	 */
	constructor(runDir, { resume = false, readOnly = false, lease = null } = {}) {
		this.runDir = runDir;
		this.#lease = lease;
		this.#readOnly = readOnly;
		mkdirSync(runDir, { recursive: true });
		this.#path = join(runDir, "journal.jsonl");
		const exists = existsSync(this.#path);
		if (resume && exists) {
			if (!readOnly) repairTrailingLine(this.#path);
			this.#load();
		} else if (!resume && exists) {
			truncateSync(this.#path, 0); // fresh run reusing a dir: drop stale checkpoints eagerly
		}
	}

	#load() {
		if (!existsSync(this.#path)) return;
		const fd = openSync(this.#path, "r");
		const buf = Buffer.alloc(CHUNK);
		const decoder = new StringDecoder("utf8");
		let carry = "";
		try {
			let n;
			while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
				carry += decoder.write(buf.subarray(0, n));
				let start = 0;
				let nl;
				while ((nl = carry.indexOf("\n", start)) >= 0) {
					this.#loadLine(carry.slice(start, nl));
					start = nl + 1;
				}
				carry = carry.slice(start);
			}
			carry += decoder.end();
			if (carry.trim()) this.#loadLine(carry);
		} finally {
			closeSync(fd);
		}
	}

	/** @param {string} line */
	#loadLine(line) {
		if (!line.trim()) return;
		let rec;
		try {
			rec = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof rec.type !== "string") return;
		if (rec.type === "control") {
			if (rec.action === "budget_increased") {
				if (typeof rec.to === "number" && Number.isFinite(rec.to) && rec.to > 0) this.#latestBudget = rec.to;
			} else if (rec.action === "budget_increase_declined") {
				this.#budgetIncreaseDeclined = true;
			} else if (rec.action === "branches_invalidated") {
				this.#applyInvalidation(rec);
			}
			return;
		}
		if (rec.type === "group") {
			this.#applyGroup(rec);
			return;
		}
		if (rec.type === "usage") {
			if (typeof rec.aic === "number" && Number.isFinite(rec.aic) && rec.aic >= 0) this.#priorSpent += rec.aic;
			else if (rec.usageUnknown) this.#priorUnknownUsage++;
			return;
		}
		if (rec.type !== "result" || typeof rec.key !== "string" || !rec.result || this.#cache.has(rec.key)) return;
		/** @type {AgentResult} */
		this.#cache.set(rec.key, { ...rec.result, cached: true });
	}

	/** AIC spent by completed results loaded on resume. */
	get priorSpent() {
		return this.#priorSpent;
	}

	get priorUnknownUsage() {
		return this.#priorUnknownUsage;
	}

	get latestBudget() {
		return this.#latestBudget;
	}

	/** True once the host declined an increase: a resumed run must not ask again. */
	get budgetIncreaseDeclined() {
		return this.#budgetIncreaseDeclined;
	}

	/**
	 * Return the latest invalidation generation applying to `branch`. Invalidating a parent also
	 * invalidates every descendant branch. Zero preserves pre-invalidation cache-key compatibility.
	 * @param {number[]} branch
	 */
	invalidationEpoch(branch) {
		let epoch = 0;
		for (let depth = 0; depth <= branch.length; depth++) {
			epoch = Math.max(epoch, this.#invalidationEpochs.get(JSON.stringify(branch.slice(0, depth))) ?? 0);
		}
		return epoch;
	}

	/** @param {string} key */
	get(key) {
		return this.#cache.get(key);
	}

	/**
	 * Durably record a successful result under `key` (first write wins). fsync'd so a crash can't
	 * leave a torn line.
	 * @param {string} key
	 * @param {AgentResult} result
	 */
	put(key, result) {
		if (this.#cache.has(key)) return;
		this.#cache.set(key, result);
		this.#append({ type: "result", key, result });
	}

	/** Persist spend for every launched terminal outcome, whether or not its result is cacheable. @param {string} key @param {AgentResult} result */
	recordUsage(key, result) {
		this.#append({
			type: "usage",
			key,
			aic: result.aic,
			nanoAiu: result.nanoAiu,
			usageUnknown: result.usageUnknown === true,
			outcome: result.skipped ? "skipped" : result.ok ? "ok" : "failed",
			label: result.label,
			sessionId: result.sessionId,
			model: result.model,
			durationMs: result.durationMs,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			cacheReadTokens: result.cacheReadTokens,
			cacheWriteTokens: result.cacheWriteTokens,
			reasoningTokens: result.reasoningTokens,
		});
	}

	/** @param {string} key @param {import("./agent.mjs").AgentSpec} spec @param {number[]} [branch] */
	recordStarted(key, spec, branch = []) {
		this.#append({
			type: "agent_started",
			key,
			branch,
			branchPath: formatBranchPath(branch),
			prompt: spec.prompt,
			label: spec.label,
			model: spec.model,
			cwd: spec.cacheCwd,
			startedAt: new Date().toISOString(),
		});
	}

	/** @param {Record<string, unknown>} record */
	recordControl(record) {
		this.#append({ type: "control", ...record });
	}

	/**
	 * Persist a new selective-resume generation. Each call advances one durable generation shared by
	 * all requested branches, so repeated resumes cannot collide with prior invalidated results.
	 * @param {number[][]} branches
	 */
	invalidate(branches) {
		if (this.#readOnly) throw new Error("checkpoint journal is read-only");
		if (!Array.isArray(branches) || !branches.length) return null;
		const generation = this.#invalidationGeneration + 1;
		const record = {
			type: "control",
			action: "branches_invalidated",
			generation,
			branches: branches.map((branch) => [...branch]),
			invalidatedAt: new Date().toISOString(),
		};
		this.#append(record);
		this.#applyInvalidation(record);
		return generation;
	}

	/**
	 * Durable branch block for one logical group. The first run records the block; every resume
	 * reuses it, so sibling groups keep their branch paths no matter what order they start in.
	 * `site` already encodes the group's size, so a resized group gets a fresh block instead of
	 * overlapping its neighbour.
	 * @param {number[]} parent @param {string} site @param {number} size
	 */
	reserveBranches(parent, site, size) {
		const existing = this.#groupBases.get(JSON.stringify([parent, site]));
		if (existing !== undefined) return existing;
		const record = { type: "group", parent: [...parent], site, base: this.#nextGroupBase.get(JSON.stringify(parent)) ?? 0, size };
		this.#append(record);
		this.#applyGroup(record);
		return record.base;
	}

	/** @param {any} record */
	#applyGroup(record) {
		if (!validBranch(record.parent) || typeof record.site !== "string" || !record.site) return;
		const base = Number(record.base);
		const size = Number(record.size);
		if (!Number.isSafeInteger(base) || base < 0 || !Number.isSafeInteger(size) || size < 1) return;
		const parentKey = JSON.stringify(record.parent);
		// Blocks are always appended at the current high-water mark, so a lower base means a corrupt
		// journal. Drop the record but still reserve the range it claimed, so a later allocation
		// cannot be handed branches an earlier group may already have used.
		if (base < (this.#nextGroupBase.get(parentKey) ?? 0)) {
			this.#nextGroupBase.set(parentKey, Math.max(this.#nextGroupBase.get(parentKey) ?? 0, base + size));
			return;
		}
		this.#groupBases.set(JSON.stringify([record.parent, record.site]), base);
		this.#nextGroupBase.set(parentKey, base + size);
	}

	/** @param {any} record */
	#applyInvalidation(record) {
		const generation = Number(record.generation);
		if (!Number.isSafeInteger(generation) || generation < 1 || !Array.isArray(record.branches)) return;
		const branches = record.branches.filter(validBranch).map((/** @type {number[]} */ branch) => branch.map(Number));
		if (!branches.length) return;
		this.#invalidationGeneration = Math.max(this.#invalidationGeneration, generation);
		for (const branch of branches) {
			const key = JSON.stringify(branch);
			this.#invalidationEpochs.set(key, Math.max(this.#invalidationEpochs.get(key) ?? 0, generation));
		}
	}

	/** @param {unknown} record */
	#append(record) {
		if (this.#readOnly) throw new Error("checkpoint journal is read-only");
		this.#lease?.assertOwned();
		const fd = openSync(this.#path, "a");
		try {
			writeSync(fd, JSON.stringify(record) + "\n");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
}

/** @param {unknown} value @returns {value is number[]} */
function validBranch(value) {
	return Array.isArray(value) && value.every((part) => Number.isSafeInteger(part) && part >= 0);
}

/** @param {number[]} branch */
export function formatBranchPath(branch) {
	return branch.length ? `/${branch.join("/")}` : "/";
}
