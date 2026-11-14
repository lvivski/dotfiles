import { realpathSync } from "node:fs";
import { fail } from "../factory/fields.mjs";
import { branchCommit, git, gitPath, requireCommit } from "./git.mjs";

/** @param {string} repository */
function worktrees(repository) {
	const result = git(repository, ["worktree", "list", "--porcelain", "-z"]);
	if (result.error || result.status !== 0) fail("factory_worktree_unsupported", "The host cannot inspect registered repository worktrees", { disposition: "unsupported" });
	return result.stdout.toString("utf8").split("\0\0").filter(Boolean).map((record) =>
		Object.fromEntries(record.split("\0").filter(Boolean).map((field) => {
			const index = field.indexOf(" ");
			return index < 0 ? [field, ""] : [field.slice(0, index), field.slice(index + 1)];
		})));
}

/** The session/branch association is claimed, but the registered execution surface is not guessed.
 * @param {string} repository @param {string | null} branch
 * @returns {import("../types/plan.js").VerifierWorktree} */
export function attachVerifierWorktree(repository, branch) {
	try {
		if (!branch || git(repository, ["check-ref-format", `refs/heads/${branch}`]).status !== 0) {
			return { status: "unsupported", reason: "The attached verifier has no unambiguous local branch" };
		}
		const matches = worktrees(repository).filter((entry) => entry.branch === `refs/heads/${branch}`);
		if (matches.length !== 1 || matches[0].prunable !== undefined || !matches[0].worktree) {
			return { status: "unsupported", reason: "The attached verifier branch has no unique accessible registered worktree; remote hosts cannot be inspected locally" };
		}
		const path = realpathSync(matches[0].worktree);
		if (matches[0].worktree !== path) return { status: "unsupported", reason: "The attached worktree has a noncanonical or symlinked registration path" };
		if (path === gitPath(repository, "--show-toplevel")
			|| gitPath(path, "--absolute-git-dir") === gitPath(repository, "--git-common-dir")) {
			return { status: "unsupported", reason: "Verification requires the attached child's distinct linked worktree, not the coordinator repository directory" };
		}
		if (gitPath(path, "--show-toplevel") !== path || gitPath(path, "--git-common-dir") !== gitPath(repository, "--git-common-dir")) {
			return { status: "unsupported", reason: "The attached branch worktree does not belong to this repository" };
		}
		return { status: "available", path, gitDirectory: gitPath(path, "--absolute-git-dir") };
	} catch {
		return { status: "unsupported", reason: "The attached verifier worktree is inaccessible on this host" };
	}
}

/** Corroborates a local ref rename; the App session association remains a claim.
 * @param {string} repository @param {string} from @param {string} to
 * @param {string} worktreePath @param {string} startedAt
 * @param {import("../types/plan.js").VerifierWorktree | undefined} pinned */
export function checkTaskBranchRename(repository, from, to, worktreePath, startedAt, pinned) {
	if (from === to || [from, to].some((branch) => git(repository, ["check-ref-format", `refs/heads/${branch}`]).status !== 0)) {
		fail("task_branch_rename_invalid", "Branch reconciliation requires distinct valid local branch names");
	}
	let worktree = attachVerifierWorktree(repository, to);
	if (worktree.status !== "available" && pinned?.status === "available") {
		const registered = checkPinnedWorktree(repository, pinned);
		if (registered.detached !== undefined && registered.branch === undefined
			&& !worktrees(repository).some((entry) => entry.branch === `refs/heads/${to}`)) {
			worktree = pinned;
		}
	}
	if (worktree.status !== "available") fail("task_branch_rename_unsupported", worktree.reason);
	if (worktree.path !== worktreePath
		|| (pinned && (pinned.status !== "available" || pinned.path !== worktree.path || pinned.gitDirectory !== worktree.gitDirectory))) {
		fail("task_branch_rename_mismatch", "The renamed branch does not identify the claimed or pinned child worktree");
	}
	const oldRef = git(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${from}`]);
	if (oldRef.error || oldRef.status !== 1) {
		fail("task_branch_rename_unproven", "The original branch must be absent; copying or replacing an existing branch is not reconciliation");
	}
	const log = git(repository, ["reflog", "show", "--date=unix", "--format=%gD%x00%gs", `refs/heads/${to}`, "--"]);
	if (log.error || log.status !== 0) fail("task_branch_rename_unsupported", "The branch rename reflog is unavailable");
	const message = `Branch: renamed refs/heads/${from} to refs/heads/${to}`;
	const entry = log.stdout.toString("utf8").split("\n").find((line) => line.split("\0")[1] === message);
	const seconds = entry?.split("\0")[0].match(/@\{(\d+)\}$/)?.[1];
	const time = seconds === undefined ? NaN : Number(seconds) * 1000;
	if (!Number.isFinite(time) || time < Math.floor(Date.parse(startedAt) / 1000) * 1000 || time > Date.now()) {
		fail("task_branch_rename_unproven", "No direct post-attachment rename appears in the complete available Git reflog");
	}
	return { worktree, renamedAt: new Date(time).toISOString() };
}

/** @param {string} repository @param {Extract<import("../types/plan.js").VerifierWorktree, {status: "available"}>} binding */
function checkPinnedWorktree(repository, binding) {
	let actualPath;
	try { actualPath = realpathSync(binding.path); }
	catch { return fail("factory_worktree_unsupported", "The attached verifier worktree is no longer accessible", { disposition: "unsupported" }); }
	const registered = worktrees(repository).filter((entry) => entry.worktree === binding.path && entry.prunable === undefined);
	if (actualPath !== binding.path || registered.length !== 1
		|| gitPath(binding.path, "--show-toplevel") !== binding.path
		|| gitPath(binding.path, "--absolute-git-dir") !== binding.gitDirectory
		|| gitPath(binding.path, "--git-common-dir") !== gitPath(repository, "--git-common-dir")) {
		fail("factory_worktree_mismatch", "The verifier's pinned worktree was replaced, moved or belongs to a different repository");
	}
	return registered[0];
}

/** Corroborates setup without treating a child acknowledgement as proof of inactivity or ownership.
 * @param {string} repository @param {string} baseBranch @param {string | null} branch
 * @param {{worktreePath: string, baseCommit: string}} bootstrap */
export function checkTaskBootstrap(repository, baseBranch, branch, bootstrap) {
	requireCommit(repository, bootstrap.baseCommit);
	const worktree = attachVerifierWorktree(repository, branch);
	if (worktree.status !== "available") fail("task_bootstrap_unsupported", worktree.reason);
	if (worktree.path !== bootstrap.worktreePath) fail("task_bootstrap_mismatch", "Setup must retain the exact App-observed canonical child worktree");
	if (branchCommit(repository, baseBranch) !== bootstrap.baseCommit) {
		fail("task_bootstrap_base_changed", "The reserved base branch changed after its immutable pre-create snapshot; hold dispatch");
	}
	checkVerifierWorktree(repository, worktree, bootstrap.baseCommit);
	return worktree;
}

/** @param {string} repository @param {import("../types/plan.js").VerifierWorktree | undefined} binding @param {string} commit */
export function checkVerifierWorktree(repository, binding, commit) {
	if (!binding || binding.status !== "available") fail("factory_worktree_unsupported", binding?.reason ?? "No actual verifier worktree was pinned at attachment", { disposition: "unsupported" });
	checkPinnedWorktree(repository, binding);
	const head = git(binding.path, ["rev-parse", "--verify", "HEAD"]);
	if (head.error || head.status !== 0) fail("factory_worktree_unsupported", "The attached verifier HEAD is unavailable", { disposition: "inconclusive" });
	const observed = head.stdout.toString("utf8").trim();
	if (observed !== commit) fail("factory_worktree_head_mismatch", "The actual attached verifier HEAD does not equal the target commit", { expected: commit, observed });
	const index = git(binding.path, ["ls-files", "-v", "-z"]);
	if (index.error || index.status !== 0) fail("factory_worktree_unsupported", "The attached verifier index is unavailable", { disposition: "inconclusive" });
	if (index.stdout.toString("utf8").split("\0").filter(Boolean).some((entry) => !entry.startsWith("H "))) {
		fail("factory_worktree_unsupported", "Sparse, assume-unchanged or conflicted index entries cannot establish a clean verifier surface", { disposition: "unsupported" });
	}
	const status = git(binding.path, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
	if (status.error || status.status !== 0) fail("factory_worktree_unsupported", "The attached verifier cleanliness cannot be determined", { disposition: "inconclusive" });
	if (status.stdout.length) fail("factory_worktree_dirty", "The actual attached verifier worktree has tracked or untracked changes");
	return { head: observed, clean: /** @type {const} */ (true) };
}
