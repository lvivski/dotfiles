import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkTaskRepository } from "../../application/repository.mjs";
import { attachVerifierWorktree, checkTaskBranchRename, checkVerifierWorktree } from "../../evidence/worktrees.mjs";
import { fixture } from "../bridge/fixture.mjs";
import { must } from "../assertions.mjs";
import { COMMIT, git } from "../git.mjs";

/** @param {import("../../types/plan.js").FoundryPlan} plan */
const verifier = (plan) => {
	const attempt = must(plan.tasks.find((task) => task.kind === "verify")?.attempts.at(-1));
	const worktree = attempt.verifierWorktree;
	assert.ok(worktree?.status === "available");
	return { attempt, worktree };
};

/** @param {string} repo @param {string} text */
async function candidateCommit(repo, text) {
	await writeFile(path.join(repo, "implementation.mjs"), text);
	git(repo, "add", "implementation.mjs");
	git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Candidate implementation");
	return git(repo, "rev-parse", "HEAD");
}

test("rename reconciliation rejects extant old refs, unrelated branches, old or missing reflogs and changed worktrees", async (t) => {
	const f = await fixture(t);
	const worktree = path.join(f.root, "renamed-child");
	git(f.repo, "worktree", "add", "--quiet", "-b", "before", worktree);
	const startedAt = new Date().toISOString();
	const pinned = attachVerifierWorktree(f.repo, "before");
	git(worktree, "branch", "-m", "after");
	const check = (at = startedAt, binding = pinned) => checkTaskBranchRename(f.repo, "before", "after", worktree, at, binding);
	assert.equal(check().worktree.path, worktree);
	const originalHead = git(worktree, "rev-parse", "HEAD");
	const newer = await candidateCommit(worktree, "later branch activity\n");
	for (let index = 0; index < 260; index++) {
		git(worktree, "update-ref", "-m", `later fixture activity ${index}`, "refs/heads/after", index % 2 ? newer : originalHead);
	}
	git(worktree, "update-ref", "-m", "restore fixture original head", "refs/heads/after", originalHead);
	assert.equal(check().worktree.path, worktree, "A genuine rename beyond the former 256-entry window remains corroborated");
	git(f.repo, "branch", "before", "after");
	assert.throws(() => check(), { code: "task_branch_rename_unproven" });
	git(f.repo, "branch", "-d", "before");
	assert.throws(() => check(new Date(Date.now() + 2000).toISOString()), { code: "task_branch_rename_unproven" });
	assert.throws(() => checkTaskBranchRename(f.repo, "unrelated", "after", worktree, startedAt, pinned), { code: "task_branch_rename_unproven" });
	assert.throws(() => checkTaskBranchRename(f.repo, "before", "not-local", worktree, startedAt, pinned), { code: "task_branch_rename_unsupported" });
	assert.throws(() => check(startedAt, { status: "unsupported", reason: "Original verifier was unavailable" }), { code: "task_branch_rename_mismatch" });
	assert.ok(pinned.status === "available");
	assert.throws(() => check(startedAt, { ...pinned, gitDirectory: `${pinned.gitDirectory}-replacement` }), { code: "task_branch_rename_mismatch" });
	git(worktree, "reflog", "expire", "--expire=all", "refs/heads/after");
	assert.throws(() => check(), { code: "task_branch_rename_unproven" });
});

test("an App-renamed verifier preserves its original pinned worktree through completion", async (t) => {
	const f = await fixture(t);
	let plan = await f.attach(f.ops, await f.implement(await f.generationPlan()), "T-002");
	const { attempt, worktree } = verifier(plan);
	git(f.repo, "branch", "-m", must(attempt.branch), "fixture/renamed-verifier");
	plan = await f.ops.attachTask({
		planId: plan.id, taskId: "T-002", attemptId: attempt.id, expectedRevision: plan.revision,
		sessionId: must(attempt.sessionId), branch: "fixture/renamed-verifier",
		rename: { fromBranch: must(attempt.branch), worktreePath: worktree.path, actor: "owner", reason: "App initial rename" },
	});
	assert.deepEqual(verifier(plan).worktree, worktree);
	assert.equal(verifier(plan).attempt.startedAt, attempt.startedAt);
	plan = await f.ops.completeTask(f.payload(plan, "T-002"));
	assert.equal(verifier(plan).attempt.repositoryCheck?.worktree?.clean, true);
});

test("verifier cleanliness belongs to its pinned worktree, never the coordinator repository directory", async (t) => {
	const f = await fixture(t);
	let plan = await f.attach(f.ops, await f.implement(await f.generationPlan()), "T-002");
	const { worktree } = verifier(plan);
	assert.notEqual(worktree.path, f.repo);
	await writeFile(path.join(f.repo, "implementation.mjs"), "Uncommitted coordinator change\n");
	plan = await f.ops.completeTask(f.payload(plan, "T-002"));
	assert.equal(plan.tasks[1].attempts[0].repositoryCheck?.worktree?.clean, true);
	assert.equal(f.factory.snapshot().candidates[0].evidence[0].trust, "independent-claim");
});

test("actual wrong HEAD, dirty files and hidden index changes reject echoed passing workspace claims", async (t) => {
	const f = await fixture(t);
	const plan = await f.attach(f.ops, await f.implement(await f.generationPlan()), "T-002");
	const { worktree } = verifier(plan);
	const other = await candidateCommit(f.repo, "export const preserve = input => input;\n");
	git(worktree.path, "checkout", "--quiet", "--detach", other);
	await assert.rejects(f.ops.completeTask(f.payload(plan, "T-002")), { code: "factory_worktree_head_mismatch" });
	git(worktree.path, "checkout", "--quiet", "--detach", COMMIT);
	await writeFile(path.join(worktree.path, "evaluators/helper.mjs"), "export const check = () => true;\n");
	await assert.rejects(f.ops.completeTask(f.payload(plan, "T-002")), { code: "factory_worktree_dirty" });
	git(worktree.path, "update-index", "--assume-unchanged", "evaluators/helper.mjs");
	await assert.rejects(f.ops.completeTask(f.payload(plan, "T-002")), { code: "factory_worktree_unsupported" });
	git(worktree.path, "update-index", "--no-assume-unchanged", "evaluators/helper.mjs");
	git(worktree.path, "restore", "--source", COMMIT, "evaluators/helper.mjs");
	assert.equal((await f.ops.completeTask(f.payload(plan, "T-002"))).tasks[1].status, "done");
});

test("missing and remote/unregistered verifier surfaces are explicitly unsupported without a repository fallback", async (t) => {
	const f = await fixture(t);
	let plan = await f.implement(await f.generationPlan());
	const reserved = await f.ops.reserveTask({ planId: plan.id, taskId: "T-002", expectedRevision: plan.revision, reservationId: "remote" });
	plan = await f.ops.attachTask({
		planId: plan.id, taskId: "T-002", attemptId: reserved.attemptId, expectedRevision: reserved.plan.revision,
		sessionId: "remote-verifier", branch: "remote/only",
	});
	assert.equal(plan.tasks[1].attempts[0].verifierWorktree?.status, "unsupported");
	await assert.rejects(f.ops.completeTask({
		...f.payload(plan, "T-002"),
		repositoryCheck: { version: 1, commit: COMMIT, integrationCommits: [COMMIT], worktree: { head: COMMIT, clean: true } },
	}), { code: "factory_worktree_unsupported" });
	assert.equal((await f.ops.getPlan({ planId: plan.id })).revision, plan.revision);
	assert.equal(attachVerifierWorktree(f.repo, "main").status, "unsupported");
	assert.equal(attachVerifierWorktree(path.join(f.root, "missing-host"), "main").status, "unsupported");
});

test("unavailable and replaced attachment paths do not acquire a different worktree's identity", async (t) => {
	const f = await fixture(t);
	const plan = await f.attach(f.ops, await f.implement(await f.generationPlan()), "T-002");
	const { worktree } = verifier(plan);
	assert.throws(() => checkVerifierWorktree(f.repo, { ...worktree, path: f.repo }, COMMIT), { code: "factory_worktree_mismatch" });
	await rename(worktree.path, `${worktree.path}-moved`);
	await assert.rejects(f.ops.completeTask(f.payload(plan, "T-002")), { code: "factory_worktree_unsupported" });
});

test("candidate commit existence and dependency ancestry are independently checked", async (t) => {
	const f = await fixture(t);
	const plan = await f.implement(await f.generationPlan());
	const first = await candidateCommit(f.repo, "export const preserve = input => input.map(value => ({...value}));\n// first delivery\n");
	git(f.repo, "checkout", "--quiet", "--detach", COMMIT);
	const unrelated = await candidateCommit(f.repo, "export const preserve = input => [...input];\n// different lineage\n");
	const target = structuredClone(plan);
	target.tasks[0].attempts[0].commit = first;
	target.tasks[1].kind = "implement";
	assert.throws(() => checkTaskRepository(target, "T-002", target.tasks[0].attempts[0], "f".repeat(40)), { code: "factory_commit_missing" });
	assert.throws(() => checkTaskRepository(target, "T-002", target.tasks[0].attempts[0], unrelated), { code: "factory_integration_mismatch" });
	assert.deepEqual(checkTaskRepository(target, "T-002", target.tasks[0].attempts[0], first)?.integrationCommits, [first]);
});

test("read-only renewal checks the unchanged historical delivery after newer repository commits", async (t) => {
	const f = await fixture(t);
	let generation = await f.verify(f.ops, await f.implement(await f.generationPlan()));
	({ plan: generation } = await f.finish(f.ops, generation));
	const delivered = structuredClone(f.factory.snapshot().candidates[0]);
	await candidateCommit(f.repo, "export const preserve = () => [];\n");
	let plan = await f.approve(f.ops, await f.ops.createEvaluationPlan({
		id: "historical-renewal", expectedRevision: 0, expectedFactoryRevision: f.factory.snapshot().revision,
		candidateId: f.candidate.id, repository: { workingDirectory: f.repo, baseBranch: "main" },
	}));
	assert.equal(plan.evaluationTarget?.commit, COMMIT);
	plan = await f.verify(f.ops, plan);
	assert.equal(plan.tasks[0].attempts[0].repositoryCheck?.commit, COMMIT);
	const renewed = f.factory.snapshot().candidates[0];
	assert.deepEqual(renewed.delivery, delivered.delivery);
	assert.deepEqual(renewed.completion, delivered.completion);
	assert.equal(renewed.evidence.at(-1)?.identity?.candidateCommit, COMMIT);
	assert.equal(renewed.evidence.at(-1)?.trust, "independent-claim");
});
