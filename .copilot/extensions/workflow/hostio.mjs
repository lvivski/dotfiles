/**
 * @module hostio
 *
 * Curated, determinism-safe host I/O for a harness — the deliberate alternative to exposing raw
 * `fs`/`child_process` in the sandbox. Harness code is a pure conductor of `(args, agent results)`;
 * these primitives keep that property intact so checkpoint/resume, dry-run, and restricted mode all
 * keep working:
 *
 *   - `git(...args)` runs a **read-only** git subcommand (allowlisted) and returns stdout. Reads are
 *     deterministic once the caller pins mutable refs to SHAs (`git("rev-parse", ref)`).
 *   - `files.read*`/`exists`/`glob` are read-only queries of the tree as of run start.
 *   - `files.write*` are the only side effects; like `memory`, they no-op under dry-run and throw in
 *     restricted mode.
 *   - `parseDiff` and the `path` helpers are pure functions (no host access at all).
 *
 * Anything nondeterministic, mutating, or exotic (builds, branch creation, network) belongs in an
 * `agent()` — outside the determinism boundary by design, audited, and OS-sandboxable — not here.
 *
 * Pure Node built-ins only, so the module stays unit-testable under plain `node --test`.
 */
import { readFile, writeFile, mkdir, access, readdir } from "node:fs/promises";
import { resolve, isAbsolute, basename, dirname, join, relative, extname, sep } from "node:path";
import { homedir } from "node:os";

import { spawnGit } from "./git.mjs";
import { sortKeysDeep } from "./json.mjs";

const MAX_GIT_OUTPUT_CHARS = 256_000;

/** git subcommands that cannot mutate the repository regardless of their arguments. */
const READ_ONLY_GIT = new Set([
	"diff", "log", "show", "status", "rev-parse", "merge-base", "rev-list", "ls-files", "ls-tree",
	"cat-file", "name-rev", "describe", "for-each-ref", "blame", "shortlog", "whatchanged", "grep",
	"var", "cat-remote", "count-objects",
]);

/** Expand a bare `~` or a leading `~/`. @param {string} p */
const expandHome = (p) => (p === "~" ? homedir() : p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p);

/** Pure path helpers (deterministic string math) exposed to the harness as `path`. */
export const pathHelpers = Object.freeze({ basename, dirname, join, relative, extname, sep });

/**
 * Curated host I/O bound to a run's cwd + mode. Exposes `git` (read-only) and a `files` object; all
 * file ops are async so a harness `await`s them uniformly and large reads never block the event loop.
 */
export class HostIO {
	#cwd;
	#dryRun;
	#restricted;
	#log;

	/** @param {{ cwd?: string, dryRun?: boolean, restricted?: boolean, log?: (m: string) => void }} [opts] */
	constructor({ cwd = process.cwd(), dryRun = false, restricted = false, log = () => {} } = {}) {
		this.#cwd = cwd;
		this.#dryRun = !!dryRun;
		this.#restricted = !!restricted;
		this.#log = log;

		// Arrow fields so the primitives keep `this` when destructured/injected as bare globals.
		this.git = (/** @type {string[]} */ ...args) => this.#git(args);
		this.files = Object.freeze({
			readText: (/** @type {string} */ path) => this.#readText(path),
			readJson: (/** @type {string} */ path) => this.#readJson(path),
			exists: (/** @type {string} */ path) => this.#exists(path),
			glob: (/** @type {string} */ pattern, /** @type {GlobOpts} */ opts = {}) => this.#glob(pattern, opts),
			writeText: (/** @type {string} */ path, /** @type {string} */ text) => this.#writeText(path, text),
			writeJson: (/** @type {string} */ path, /** @type {unknown} */ value, /** @type {WriteJsonOpts} */ opts = {}) => this.#writeJson(path, value, opts),
		});
	}

	/** Resolve `p` (expanding `~`) against the run cwd. @param {string} p */
	#resolve(p) {
		const e = expandHome(String(p));
		return isAbsolute(e) ? e : resolve(this.#cwd, e);
	}

	// ---- git (read-only) ----------------------------------------------
	/** @param {string[]} args @returns {Promise<string>} trimmed stdout; rejects on a non-zero exit. */
	async #git(args) {
		if (this.#restricted) throw new Error("workflow: git() is forbidden in restricted mode");
		const sub = args[0];
		if (typeof sub !== "string" || sub.startsWith("-")) {
			throw new Error("workflow: git() needs a subcommand first, e.g. git('diff', '--name-status', range)");
		}
		if (!READ_ONLY_GIT.has(sub)) {
			throw new Error(`workflow: git('${sub}', …) is not a read-only subcommand — use worktree() or an agent() for mutations`);
		}
		const r = await spawnGit(args, this.#cwd, MAX_GIT_OUTPUT_CHARS);
		if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim()}`);
		return r.stdout.trimEnd();
	}

	// ---- reads (always allowed; deterministic as of run start) ---------
	/** @param {string} path @returns {Promise<string>} */
	async #readText(path) {
		return readFile(this.#resolve(path), "utf8");
	}

	/** @param {string} path @returns {Promise<any>} */
	async #readJson(path) {
		const abs = this.#resolve(path);
		const raw = await readFile(abs, "utf8");
		try {
			return JSON.parse(raw);
		} catch (e) {
			throw new Error(`workflow: readJson(${path}) — invalid JSON: ${e instanceof Error ? e.message : e}`);
		}
	}

	/** @param {string} path @returns {Promise<boolean>} */
	async #exists(path) {
		try {
			await access(this.#resolve(path));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Deterministic (sorted) glob under the run cwd. Supports `**` (any depth), `*`, `?`. Prunes
	 * `node_modules` and dotfiles by default (`dot`/`ignore` to override); results are cwd-relative.
	 * @param {string} pattern @param {GlobOpts} [opts] @returns {Promise<string[]>}
	 */
	async #glob(pattern, opts = {}) {
		const { dot = false, ignore = [] } = opts;
		const cwd = opts.cwd ? this.#resolve(opts.cwd) : this.#cwd;
		const re = globToRegExp(String(pattern));
		const ignoreRes = ignore.map(globToRegExp);
		/** @type {string[]} */
		const out = [];
		/** @param {string} dir relative dir ("" = root) */
		const walk = async (dir) => {
			let entries;
			try {
				entries = await readdir(join(cwd, dir), { withFileTypes: true });
			} catch {
				return;
			}
			for (const ent of entries) {
				const rel = dir ? `${dir}/${ent.name}` : ent.name;
				if (!dot && ent.name.startsWith(".")) continue;
				if (ent.isDirectory()) {
					if (ent.name === "node_modules") continue;
					await walk(rel);
				} else if (re.test(rel) && !ignoreRes.some((r) => r.test(rel))) {
					out.push(rel);
				}
			}
		};
		await walk("");
		return out.sort();
	}

	// ---- writes (side effects; dry-run + restricted gated) -------------
	/** @param {string} path @param {string} text @returns {Promise<void>} */
	async #writeText(path, text) {
		const abs = this.#resolve(path);
		const body = String(text);
		if (this.#restricted) throw new Error("workflow: writeText() is forbidden in restricted mode");
		if (this.#dryRun) {
			this.#log(`  hostio: [dry-run] skipped write ${abs} (${body.length} chars)`);
			return;
		}
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, body, "utf8");
		this.#log(`  hostio: wrote ${abs} (${body.length} chars)`);
	}

	/**
	 * Write pretty JSON. Keys are sorted by default so manifests are byte-stable across runs.
	 * @param {string} path @param {unknown} value @param {WriteJsonOpts} [opts] @returns {Promise<void>}
	 */
	async #writeJson(path, value, opts = {}) {
		const { indent = 2, sort = true } = opts;
		const text = JSON.stringify(sort ? sortKeysDeep(value) : value, null, indent) + "\n";
		return this.#writeText(path, text);
	}
}

/** @typedef {{ cwd?: string, dot?: boolean, ignore?: string[] }} GlobOpts */
/** @typedef {{ indent?: number, sort?: boolean }} WriteJsonOpts */

/** Translate a glob (`**`, `*`, `?`) into an anchored RegExp over POSIX-style relative paths. @param {string} pattern */
function globToRegExp(pattern) {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				// `**/` matches zero or more path segments; a trailing `**` matches anything.
				if (pattern[i + 2] === "/") {
					re += "(?:[^/]+/)*";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if ("\\^$.|+()[]{}".includes(c)) {
			re += "\\" + c;
		} else {
			re += c;
		}
	}
	return new RegExp("^" + re + "$");
}

/**
 * Parse a unified diff (one or many files) into structured hunks. Pure — no host access. Each change
 * carries its 1-based line number in the new/old file so callers can classify hunks with line refs.
 * @param {string} text @returns {FileDiff[]}
 */
export function parseDiff(text) {
	/** @type {FileDiff[]} */
	const files = [];
	/** @type {FileDiff|null} */
	let file = null;
	/** @type {Hunk|null} */
	let hunk = null;
	let oldLine = 0;
	let newLine = 0;

	for (const line of String(text).split("\n")) {
		if (line.startsWith("diff --git ")) {
			file = { path: "", oldPath: "", hunks: [] };
			files.push(file);
			hunk = null;
			const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
			if (m) {
				file.oldPath = m[1];
				file.path = m[2];
			}
			continue;
		}
		if (!file) continue;
		if (line.startsWith("--- ")) {
			const p = line.slice(4).replace(/^a\//, "");
			file.oldPath = p === "/dev/null" ? "" : p; // /dev/null ⇒ newly created file
			continue;
		}
		if (line.startsWith("+++ ")) {
			const p = line.slice(4).replace(/^b\//, "");
			file.path = p === "/dev/null" ? "" : p; // /dev/null ⇒ deleted file
			continue;
		}
		const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hm) {
			oldLine = parseInt(hm[1], 10);
			newLine = parseInt(hm[2], 10);
			hunk = { header: line, oldStart: oldLine, newStart: newLine, changes: [] };
			file.hunks.push(hunk);
			continue;
		}
		if (!hunk) continue;
		const sign = line[0];
		if (sign === "+") {
			hunk.changes.push({ type: "add", text: line.slice(1), oldLine: null, newLine });
			newLine++;
		} else if (sign === "-") {
			hunk.changes.push({ type: "del", text: line.slice(1), oldLine, newLine: null });
			oldLine++;
		} else if (sign === " ") {
			hunk.changes.push({ type: "context", text: line.slice(1), oldLine, newLine });
			oldLine++;
			newLine++;
		}
		// "\ No newline at end of file" and any other metadata lines are ignored.
	}
	return files;
}

/** @typedef {{ type: "add"|"del"|"context", text: string, oldLine: number|null, newLine: number|null }} Change */
/** @typedef {{ header: string, oldStart: number, newStart: number, changes: Change[] }} Hunk */
/** @typedef {{ path: string, oldPath: string, hunks: Hunk[] }} FileDiff */

export { READ_ONLY_GIT as _READ_ONLY_GIT, globToRegExp as _globToRegExp };
