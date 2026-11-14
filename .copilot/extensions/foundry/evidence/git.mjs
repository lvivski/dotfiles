import { spawnSync } from "node:child_process";
import { constants } from "node:buffer";
import { realpathSync } from "node:fs";
import { devNull } from "node:os";
import { COMMIT, fail } from "../factory/fields.mjs";

/** Read-only Git calls never honor ambient repository/index overrides or replacement objects.
 * @param {string} directory @param {string[]} args @param {number} [maxBuffer] */
export function git(directory, args, maxBuffer = constants.MAX_LENGTH) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	return spawnSync("git", ["--no-pager", "--no-replace-objects", "-c", "core.fsmonitor=false", "-C", directory, ...args], {
		env: { ...env, GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_GRAFT_FILE: devNull },
		encoding: "buffer", maxBuffer, stdio: ["ignore", "pipe", "pipe"],
	});
}

/** @param {string} directory @param {unknown} commit @returns {string} */
export function requireCommit(directory, commit) {
	if (typeof commit !== "string" || !COMMIT.test(commit)) fail("factory_commit_invalid", "Repository checks require a full lowercase Git commit ID");
	const repository = git(directory, ["rev-parse", "--git-dir"]);
	if (repository.error || repository.status !== 0) fail("factory_repository_unsupported", "The repository is not accessible on this host", { disposition: "unsupported" });
	const result = git(directory, ["cat-file", "-t", commit]);
	if (result.error) fail("factory_repository_unsupported", "The repository or Git objects are not accessible on this host", { disposition: "unsupported" });
	if (result.status !== 0 || result.stdout.toString("utf8").trim() !== "commit") {
		fail("factory_commit_missing", "The reported immutable commit is not present as a Git commit in this repository", { commit, disposition: "inconclusive" });
	}
	return commit;
}

/** @param {string} directory @param {string} ancestor @param {string} commit */
export function requireAncestor(directory, ancestor, commit) {
	requireCommit(directory, ancestor);
	requireCommit(directory, commit);
	const result = git(directory, ["merge-base", "--is-ancestor", ancestor, commit]);
	if (result.status === 1) fail("factory_integration_mismatch", "The candidate does not include a required dependency delivery", { ancestor, commit });
	if (result.error || result.status !== 0) fail("factory_integration_unsupported", "Integration ancestry cannot be established from the available Git objects", { ancestor, commit, disposition: "inconclusive" });
}

/** @param {string} directory @param {string} branch */
export function branchCommit(directory, branch) {
	if (git(directory, ["check-ref-format", `refs/heads/${branch}`]).status !== 0) fail("factory_integration_unsupported", "The dependency branch is not an unambiguous local Git branch", { disposition: "unsupported" });
	const result = git(directory, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
	if (result.error || result.status !== 0) fail("factory_integration_unsupported", "A branch-only dependency has no accessible local delivery", { branch, disposition: "inconclusive" });
	return requireCommit(directory, result.stdout.toString("utf8").trim());
}

/** @param {string} directory @param {"--absolute-git-dir" | "--git-common-dir" | "--show-toplevel"} field */
export function gitPath(directory, field) {
	const result = git(directory, ["rev-parse", "--path-format=absolute", field]);
	if (result.error || result.status !== 0) fail("factory_worktree_unsupported", "The attached worktree is not accessible on this host", { disposition: "unsupported" });
	try { return realpathSync(result.stdout.toString("utf8").trim()); }
	catch { return fail("factory_worktree_unsupported", "The attached Git path is unavailable on this host", { disposition: "unsupported" }); }
}
