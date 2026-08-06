/**
 * @module memory
 *
 * Durable cross-run text memory exposed to a harness as `memory`. Backed by a single file so it can
 * be shared across recurring ticks. No-ops (reads return "") when no path is configured. Under
 * `dryRun` it is read-only: writes are logged as skipped and never mutate the file.
 */
import { readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

import { atomicWriteFile } from "./persistence.mjs";

/** Expand a bare `~` or a leading `~/`. @param {string} p */
const expandHome = (p) => (p === "~" ? homedir() : p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p);

/** A durable text file shared across runs/ticks; no-op when unset, read-only under dry-run. */
export class Memory {
	/** @type {string | undefined} */
	path;
	#readOnly;
	#log;

	/**
	 * @param {string | null | undefined} path
	 * @param {{ readOnly?: boolean, log?: (m: string) => void }} [opts]
	 */
	constructor(path, { readOnly = false, log = () => {} } = {}) {
		this.path = path ? resolve(expandHome(path)) : undefined;
		this.#readOnly = readOnly;
		this.#log = log;
	}

	/** True when a memory file is configured. */
	get enabled() {
		return this.path !== undefined;
	}

	/** Full file contents, or "" when unset/absent. */
	read() {
		if (!this.path) return "";
		try {
			return readFileSync(this.path, "utf8");
		} catch (e) {
			if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") {
				this.#log(`  ! memory read failed: ${e instanceof Error ? e.message : e}`);
			}
			return "";
		}
	}

	/** Overwrite memory. No-op when unset or dry-run. @param {string} text */
	write(text) {
		this.#put(String(text), false);
	}

	/** Append a newline-terminated note. No-op when unset or dry-run. @param {string} text */
	append(text) {
		this.#put(String(text), true);
	}

	/** Truncate memory to empty. No-op when unset or dry-run. */
	clear() {
		this.#put("", false);
	}

	/** @param {string} text @param {boolean} append */
	#put(text, append) {
		if (!this.path) return;
		if (this.#readOnly) {
			this.#log(`  memory: [dry-run] skipped ${append ? "append" : "write"} (${text.length} chars)`);
			return;
		}
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			// Memory is durable cross-run state, so writes are fsync'd like ledger records.
			if (!append) {
				atomicWriteFile(this.path, text);
				return;
			}
			const fd = openSync(this.path, "a");
			try {
				writeSync(fd, text && !text.endsWith("\n") ? text + "\n" : text, null, "utf8");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		} catch (e) {
			this.#log(`  ! memory write failed: ${e instanceof Error ? e.message : e}`);
		}
	}
}
