/**
 * @module worktree
 *
 * Per-agent detached git worktrees — a JS port of `worktree.py`. Serialized (async mutex),
 * idempotent, and auto-cleaned. Supports isolated worktrees for the launch repo, another local
 * repo, or a remote clone (blob-less, with a normal `--no-checkout` fallback when the server rejects
 * filtering), plus fetching a specific ref (e.g. a PR head). Two behaviours differ from the Python
 * reference, per the migration plan: a **clone `--filter=blob:none` fallback**, and **dirty
 * worktrees are preserved** for inspection instead of force-removed.
 *
 * Git runs asynchronously (`spawn`) so a clone never blocks the extension's event loop.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, realpathSync, statSync } from "node:fs";
import { join, dirname, basename, resolve, sep } from "node:path";

const SAFE = /[^A-Za-z0-9._-]+/g;
/** Sanitized name segment (dots stripped so `.`/`..` can't alias). @param {string} s */
const sanitize = (s) => s.replace(SAFE, "-").replace(/^[-.]+|[-.]+$/g, "") || "wt";

/** A tiny async mutex serializing a manager's create/remove (mirrors the Python threading.Lock). */
class Mutex {
	#tail = Promise.resolve();
	/** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
	run(fn) {
		const result = this.#tail.then(fn);
		this.#tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}
}

/** @typedef {{ code: number, stdout: string, stderr: string }} GitResult */

/** Run a git command asynchronously. @param {string[]} args @param {string} cwd @returns {Promise<GitResult>} */
function gitResult(args, cwd) {
	return new Promise((res) => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
		child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
		child.on("error", (e) => res({ code: 127, stdout: "", stderr: String(e?.message || e) }));
		child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
	});
}

/** Run git, returning trimmed stdout; throws on failure when `check`. @param {string[]} args @param {string} cwd @param {boolean} [check] */
async function git(args, cwd, check = true) {
	const r = await gitResult(args, cwd);
	if (check && r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
	return r.stdout.trim();
}

/** Directory name for a persistent clone of `repo`. @param {string} repo */
export function repoName(repo) {
	repo = repo.replace(/\/+$/, "");
	let path;
	try {
		path = decodeURIComponent(new URL(repo).pathname);
	} catch {
		path = repo;
	}
	const name = path.includes("/_git/") ? path.split("/_git/").at(-1) : basename(path);
	return sanitize((name ?? "").replace(/\.git$/, "")) || "repo";
}

/** Best-effort repo identity (normalizes GitHub/ADO variants). @param {string} repo */
export function repoKey(repo) {
	if (existsSync(repo)) return "file:" + realpathSync(repo);
	if (repo.startsWith("git@")) repo = "ssh://git@" + repo.slice(4).replace(":", "/");
	let netloc = "";
	let path = repo;
	try {
		const u = new URL(repo.replace(/\/+$/, "").replace(/\.git$/, ""));
		netloc = u.host;
		path = decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, "");
	} catch {
		// treat as a bare path
	}
	if (path.includes("/_git/")) {
		const [prefix, name] = path.split("/_git/");
		const parts = prefix.split("/");
		const project = parts.at(-1);
		let org;
		if (netloc.endsWith(".visualstudio.com")) org = netloc.split(".visualstudio.com")[0];
		else if (netloc === "dev.azure.com" && parts.length) org = parts[0];
		else org = netloc;
		return `ado:${org}/${project}/${name}`.toLowerCase();
	}
	return `${netloc}/${path}`.toLowerCase();
}

/** Persistent clone path for `repo` under `cloneDir`. @param {string} repo @param {string} cloneDir */
export function clonePath(repo, cloneDir) {
	return join(resolve(cloneDir.replace(/^~(?=\/)/, process.env.HOME ?? "~")), repoName(repo));
}

/** Detect the git repo root containing `start`, or null. @param {string} start @returns {Promise<string|null>} */
export async function findRepoRoot(start) {
	const r = await gitResult(["rev-parse", "--show-toplevel"], start);
	return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Clone `repo` into `dest` once (blob-less, no-checkout); reuse an existing clone after validating
 * its origin. Falls back to a normal `--no-checkout` clone if the server rejects `--filter`.
 * @param {string} repo @param {string} dest @param {(m: string) => void} [log]
 * @returns {Promise<string>}
 */
export async function ensureClone(repo, dest, log = () => {}) {
	const gitDir = join(dest, ".git");
	if (existsSync(gitDir) && statSync(gitDir).isDirectory()) {
		const origin = await git(["remote", "get-url", "origin"], dest, false);
		if (origin && repoKey(origin) !== repoKey(repo)) throw new Error(`existing clone ${dest} has origin ${origin}, expected ${repo}`);
		return dest;
	}
	mkdirSync(dirname(dest) || ".", { recursive: true });
	const filtered = await gitResult(["clone", "--filter=blob:none", "--no-checkout", repo, dest], process.cwd());
	if (filtered.code === 0) {
		log(`  clone ${repo}`);
		return dest;
	}
	// Server may reject partial-clone filtering — retry a normal no-checkout clone.
	log(`  clone --filter rejected, retrying without filter: ${filtered.stderr.trim().split("\n").at(-1)}`);
	await git(["clone", "--no-checkout", repo, dest], process.cwd());
	log(`  clone ${repo}`);
	return dest;
}

/** Creates/removes detached worktrees under a base dir; serialized + idempotent. */
export class WorktreeManager {
	repoRoot;
	baseDir;
	baseRef;
	fetchRemote;
	/** @type {string[]} */
	preservedDirty = [];
	#log;
	#lock = new Mutex();
	/** @type {string[]} */
	#created = [];

	/**
	 * @param {string} repoRoot
	 * @param {string} baseDir
	 * @param {{ logger?: (m: string) => void, baseRef?: string, fetchRemote?: boolean }} [opts]
	 */
	constructor(repoRoot, baseDir, { logger = () => {}, baseRef = "HEAD", fetchRemote = true } = {}) {
		this.repoRoot = repoRoot;
		this.baseDir = baseDir;
		this.baseRef = baseRef;
		this.fetchRemote = fetchRemote;
		this.#log = logger;
	}

	/**
	 * Create a detached worktree named `name` (unique per concurrent branch). `fetchRef` (e.g.
	 * `pull/7/head`) is fetched and materialized when set. Returns the worktree path.
	 * @param {string} name @param {string|null} [baseRef] @param {string|null} [fetchRef]
	 * @returns {Promise<string>}
	 */
	create(name, baseRef = null, fetchRef = null) {
		return this.#lock.run(async () => {
			const safe = sanitize(name);
			const path = join(this.baseDir, safe);
			mkdirSync(this.baseDir, { recursive: true });
			// Contain the worktree within the base via realpath (resolves symlinks), like Python.
			const realBase = realpathSync(this.baseDir);
			const realPath = existsSync(path) ? realpathSync(path) : join(realBase, safe);
			if (realPath === realBase || !realPath.startsWith(realBase + sep)) throw new Error(`unsafe worktree name ${JSON.stringify(name)} resolves outside the worktree base`);
			if (this.#created.includes(path)) throw new Error(`worktree ${JSON.stringify(name)} is already active — use a unique name per concurrent branch`);
			let ref = baseRef || this.baseRef;
			if (fetchRef) {
				if (this.fetchRemote) {
					await git(["fetch", "--depth", "1", "origin", fetchRef], this.repoRoot);
					ref = "FETCH_HEAD";
				} else {
					ref = fetchRef;
				}
			}
			// Reuse a valid leftover worktree from a crashed run; rebuild non-worktree debris.
			if (existsSync(path) && !existsSync(join(path, ".git"))) {
				await gitResult(["worktree", "remove", "--force", path], this.repoRoot);
				rmSync(path, { recursive: true, force: true });
			}
			if (!existsSync(path)) await git(["worktree", "add", "--detach", path, ref], this.repoRoot);
			this.#created.push(path);
			this.#log(`  worktree + ${basename(path)}`);
			return path;
		});
	}

	/** Whether the worktree has uncommitted changes. @param {string} path @returns {Promise<boolean>} */
	async isDirty(path) {
		const r = await gitResult(["status", "--porcelain"], path);
		return r.code === 0 && r.stdout.trim().length > 0;
	}

	/**
	 * Remove a worktree — but **preserve it if dirty** (don't delete user/subagent work).
	 * @param {string} path @returns {Promise<void>}
	 */
	remove(path) {
		return this.#lock.run(async () => {
			const drop = () => {
				const i = this.#created.indexOf(path);
				if (i >= 0) this.#created.splice(i, 1);
			};
			if (!existsSync(path)) return drop();
			if (await this.isDirty(path)) {
				if (!this.preservedDirty.includes(path)) this.preservedDirty.push(path);
				drop();
				this.#log(`  worktree ~ ${basename(path)} preserved (uncommitted changes)`);
				return;
			}
			const r = await gitResult(["worktree", "remove", "--force", path], this.repoRoot);
			if (r.code === 0 || !existsSync(path)) {
				drop();
				this.#log(`  worktree - ${basename(path)}`);
			} else {
				this.#log(`  ! worktree remove failed for ${basename(path)}: ${r.stderr.trim()}`);
			}
		});
	}

	/** Remove every created worktree (preserving dirty ones) and prune. @returns {Promise<string[]>} preserved dirty paths. */
	async cleanupAll() {
		for (const path of [...this.#created]) await this.remove(path);
		await gitResult(["worktree", "prune"], this.repoRoot);
		return this.preservedDirty;
	}
}

export { sanitize as _sanitize, SAFE as _SAFE };
