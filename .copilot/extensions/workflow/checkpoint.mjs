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

/** Bump when the cache key algorithm or record shape changes incompatibly. */
export const CACHE_SCHEMA = 2;
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

	/**
	 * @param {string} runDir directory holding this run's artifacts
	 * @param {{ resume?: boolean }} [opts]
	 */
	constructor(runDir, { resume = false } = {}) {
		this.runDir = runDir;
		mkdirSync(runDir, { recursive: true });
		this.#path = join(runDir, "journal.jsonl");
		const exists = existsSync(this.#path);
		if (resume && exists) {
			repairTrailingLine(this.#path);
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
		if (rec.v !== CACHE_SCHEMA || typeof rec.key !== "string" || !rec.result) return;
		if (this.#cache.has(rec.key)) return; // first write wins
		/** @type {AgentResult} */
		const result = { ...rec.result, cached: true };
		this.#cache.set(rec.key, result);
		this.#priorSpent += result.aic || 0;
	}

	/** AIC spent by completed results loaded on resume. */
	get priorSpent() {
		return this.#priorSpent;
	}

	/** Number of cached results. */
	get count() {
		return this.#cache.size;
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
		const fd = openSync(this.#path, "a");
		try {
			writeSync(fd, JSON.stringify({ v: CACHE_SCHEMA, key, result }) + "\n");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
}
