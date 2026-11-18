import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, openSync, closeSync } from "node:fs";
import path from "node:path";

/** @typedef {{path:string,tip:string,landingRef:string,landingTip:string}} TreeProof */

/** Git status can suppress dirty bytes via ignore/clean filters, assume-unchanged,
 * the stat cache, or skipped submodules. Compare raw bytes without running a
 * repository's external filters. Any unsupported tree stays on disk.
 * @param {string} root @param {(...args:string[])=>string} git */
function treeChanges(root, git) {
	const paths = new Map();
	const index = git("ls-files", "-v", "--stage", "-z").split("\0").filter(Boolean);
	for (const entry of index) {
		const parsed = /^H (100644|100755|120000) ([0-9a-f]+) 0\t([\s\S]+)$/u.exec(entry);
		if (!parsed || parsed[3].includes("\uFFFD")) return "hidden-or-nested-index-work";
		paths.set(parsed[3], { mode: parsed[1], oid: parsed[2] });
	}
	const head = git("ls-tree", "-r", "-z", "HEAD").split("\0").filter(Boolean);
	if (head.length !== paths.size || head.some(entry => {
		const m = /^(\d+) blob ([0-9a-f]+)\t([\s\S]+)$/u.exec(entry);
		return !m || paths.get(m[3])?.mode !== m[1] || paths.get(m[3])?.oid !== m[2];
	})) return "tracked-index-changes";
	const algorithm = git("rev-parse", "--show-object-format").trimEnd();
	if (!["sha1", "sha256"].includes(algorithm)) return "unverified-object-format";
	const directories = [""];
	let bytes = 0;
	const untracked = (/** @type {string} */ name) => {
		try { git("check-ignore", "--quiet", "--", name); return "ignored-files"; }
		catch { return "untracked-files"; }
	};
	for (const parent of directories) {
		const entries = readdirSync(path.join(root, parent), { withFileTypes: true });
		if (!entries.length && parent) return untracked(parent);
		for (const entry of entries) {
			const name = path.join(parent, entry.name);
			if (name === ".git") continue;
			if (entry.name.includes("\uFFFD")) return "unverifiable-filename";
			if (entry.isDirectory()) { directories.push(name); continue; }
			const expected = paths.get(name);
			if (!expected) return untracked(name);
			paths.delete(name);
			const file = path.join(root, name);
			const stat = lstatSync(file);
			const mode = stat.isSymbolicLink() ? "120000" : stat.isFile() ? (stat.mode & 0o100 ? "100755" : "100644") : "";
			if (mode !== expected.mode) return "tracked-changes";
			if (stat.size > 64 * 1024 ** 2 || (bytes += stat.size) > 1024 ** 3) return "worktree-inspection-limit";
			let contents;
			if (mode === "120000") contents = readlinkSync(file, { encoding: "buffer" });
			else {
				const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try { contents = readFileSync(fd); } finally { closeSync(fd); }
			}
			if (createHash(algorithm).update(`blob ${contents.length}\0`).update(contents).digest("hex") !== expected.oid) return "tracked-changes";
		}
	}
	if (paths.size) return "tracked-changes";
}

/** Read the whole linked worktree, never a scoped pathspec. No fetch, ref update,
 * index refresh, or assumption that another disposable worker branch is a landing.
 * The native conditional archive must repeat these safeguards at removal time.
 * @param {string} directory @param {string} databasePath @param {string} [observedDirectory]
 * @param {{targetRef:string,newTip:string}} [landing]
 * @returns {{reason:string,proof?:never}|{proof:TreeProof,reason?:never}} */
export function inspectRetirementTree(directory, databasePath, observedDirectory, landing) {
	try {
		const root = realpathSync(directory);
		if (!path.isAbsolute(directory) || root !== directory || observedDirectory && root !== observedDirectory) return { reason: "workspace-path-mismatch" };
		const common = path.dirname(path.dirname(databasePath));
		const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
		Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
		const git = (/** @type {string[]} */ ...args) => execFileSync("git", ["--no-pager", "--no-optional-locks", "-C", root,
			"-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
		{ encoding: "utf8", env, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
		const gitdir = realpathSync(git("rev-parse", "--absolute-git-dir").trimEnd());
		if (root !== git("rev-parse", "--show-toplevel").trimEnd() || git("rev-parse", "--path-format=absolute", "--git-common-dir").trimEnd() !== common
			|| path.dirname(gitdir) !== path.join(common, "worktrees") || !lstatSync(path.join(root, ".git")).isFile()
			|| readFileSync(path.join(gitdir, "gitdir"), "utf8").trimEnd() !== path.join(root, ".git"))
			return { reason: "not-an-isolated-linked-worktree" };
		const worktrees = git("worktree", "list", "--porcelain", "-z").split("\0\0").map(entry => entry.split("\0"));
		const entry = worktrees.find(fields => fields[0] === `worktree ${root}`);
		if (!entry || entry.some(field => /^(locked|prunable|bare)( |$)/u.test(field))
			|| worktrees.some(fields => fields[0].startsWith(`worktree ${root}${path.sep}`))) return { reason: "worktree-locked-nested-or-unverified" };
		if (["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge", "sequencer", "index.lock"]
			.some(name => existsSync(path.join(gitdir, name)))) return { reason: "git-operation-in-progress" };
		const changes = treeChanges(root, git);
		if (changes) return { reason: changes };
		const landingRef = landing?.targetRef ?? worktrees[0]?.find(field => field.startsWith("branch refs/heads/"))?.slice(7);
		if (existsSync(path.join(common, "info", "grafts")) || existsSync(path.join(common, "shallow"))) return { reason: "unverified-commit-ancestry" };
		const tip = git("rev-parse", "--verify", "HEAD^{commit}").trimEnd();
		if (!landingRef?.startsWith("refs/heads/") || !entry.includes(`HEAD ${tip}`) || entry.includes(`branch ${landingRef}`)) return { reason: "independent-landing-ref-unverified" };
		git("check-ref-format", landingRef);
		const landed = git("rev-parse", "--verify", `${landingRef}^{commit}`).trimEnd();
		try {
			if (landing && (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(landing.newTip)
				|| git("merge-base", "--is-ancestor", landing.newTip, landed) !== "")) return { reason: "landed-receipt-no-longer-reachable" };
			git("merge-base", "--is-ancestor", tip, landed);
		}
		catch { return { reason: "unique-or-unproven-tip" }; }
		return { proof: { path: root, tip, landingRef, landingTip: landed } };
	} catch { return { reason: "worktree-inspection-unavailable" }; }
}
