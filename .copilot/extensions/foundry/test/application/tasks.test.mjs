import assert from "node:assert/strict";
import path from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import test from "node:test";
import { arrayOf, errorCode, property, readString } from "../../data.mjs";
import { TASK_STATUS } from "../../plan/values.mjs";
import { analysisStub, createApproved, evidence, planBlueprint, withOperations } from "./fixture.mjs";
import { COMMIT, git } from "../git.mjs";
import { must } from "../assertions.mjs";

test("setup kickoff separates task authority and reservation replay preserves launch identity", () => (
	withOperations(async ({ operations, workspacePath }) => {
		const plan = await createApproved(operations, workspacePath);
		const request = { planId: plan.id, taskId: "T-001", expectedRevision: plan.revision, reservationId: "setup-once" };
		const reserved = await operations.reserveTask(request);
		const initialization = must(reserved.initialization);
		assert.equal(initialization.kickoff.mode, "interactive");
		assert.match(initialization.kickoff.prompt, /NOT the task delegation/);
		assert.match(initialization.kickoff.prompt, /Do not inspect task source, run commands, edit files, change branches/);
		assert.match(initialization.kickoff.prompt, /after successful Foundry attachment/);
		assert.ok(initialization.kickoff.prompt.includes(initialization.acknowledgement));
		assert.ok(initialization.kickoff.prompt.length < 1500);
		assert.equal(initialization.kickoff.prompt.includes(plan.tasks[0].description), false);
		assert.equal(initialization.kickoff.prompt.includes(plan.objective), false);
		assert.equal(reserved.plan.tasks[0].attempts[0].sessionId, null);
		const replay = await operations.reserveTask(request);
		assert.deepEqual(replay.initialization, initialization);
		assert.equal(replay.delegationPrompt, reserved.delegationPrompt);
		const worktree = path.join(workspacePath, "setup-child");
		git(workspacePath, "worktree", "add", "--quiet", "-b", "work/setup", worktree, reserved.baseBranch);
		git(worktree, "branch", "-m", "work/named-before-attach");
		const identity = { planId: plan.id, taskId: "T-001", attemptId: reserved.attemptId, sessionId: "same-canonical-child", branch: "work/named-before-attach" };
		const attach = { ...identity, expectedRevision: reserved.plan.revision, bootstrap: { worktreePath: worktree, baseCommit: COMMIT } };
		await assert.rejects(operations.attachTask({ ...attach, expectedRevision: reserved.plan.revision - 1 }), { code: "revision_conflict" });
		const attached = await operations.attachTask(attach);
		assert.equal(attached.tasks[0].attempts[0].branch, identity.branch);
		assert.equal((await operations.attachTask(attach)).revision, attached.revision);
		const attachedReplay = await operations.reserveTask(request);
		assert.equal(attachedReplay.initialization, null);
		assert.equal(attachedReplay.delegationPrompt, reserved.delegationPrompt);
		await assert.rejects(operations.attachTask({ ...attach, expectedRevision: attached.revision, sessionId: "replacement" }), { code: "task_bootstrap_mismatch" });
		const cancelled = await operations.cancel({ planId: plan.id, expectedRevision: attached.revision, requestId: "stop-setup", requestedBy: "owner", reason: "Stop" });
		assert.equal((await operations.reserveTask({ ...request, expectedRevision: cancelled.revision })).initialization, null);
	})
));

test("setup attachment holds the reservation on wrong path, dirty state, wrong HEAD or base drift", () => (
	withOperations(async ({ operations, workspacePath }) => {
		const plan = await createApproved(operations, workspacePath);
		const reserved = await operations.reserveTask({ planId: plan.id, taskId: "T-001", expectedRevision: plan.revision, reservationId: "setup-checks" });
		const worktree = path.join(workspacePath, "setup-child");
		git(workspacePath, "worktree", "add", "--quiet", "-b", "work/setup", worktree);
		const request = {
			planId: plan.id, taskId: "T-001", attemptId: reserved.attemptId, expectedRevision: reserved.plan.revision,
			sessionId: "setup-child", branch: "work/setup", bootstrap: { worktreePath: worktree, baseCommit: COMMIT },
		};
		await assert.rejects(operations.attachTask({ ...request, branch: "missing" }), { code: "task_bootstrap_unsupported" });
		await assert.rejects(operations.attachTask({ ...request, bootstrap: { ...request.bootstrap, worktreePath: workspacePath } }), { code: "task_bootstrap_mismatch" });
		await assert.rejects(operations.attachTask({ ...request, bootstrap: { ...request.bootstrap, baseCommit: "f".repeat(40) } }), { code: "factory_commit_missing" });
		await writeFile(path.join(worktree, "unexpected.txt"), "Startup changed a file\n");
		await assert.rejects(operations.attachTask(request), { code: "factory_worktree_dirty" });
		await unlink(path.join(worktree, "unexpected.txt"));
		git(worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "Unexpected setup commit");
		await assert.rejects(operations.attachTask(request), { code: "factory_worktree_head_mismatch" });
		git(workspacePath, "update-ref", "refs/heads/main", git(worktree, "rev-parse", "HEAD"));
		await assert.rejects(operations.attachTask(request), { code: "task_bootstrap_base_changed" });
		const held = await operations.getPlan({ planId: plan.id });
		assert.equal(held.revision, reserved.plan.revision);
		assert.equal(held.tasks[0].attempts[0].sessionId, null);
		assert.equal(held.tasks[0].attempts[0].status, "reserved");
		assert.equal(held.tasks[0].status, TASK_STATUS.RUNNING);
	})
));

/** @param {unknown} error */
const missingFields = (error) => arrayOf(readString)(property(property(error, "details"), "missing"));

test("App branch reconciliation retains the attached session, attempt and rename history", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await createApproved(operations, workspacePath);
		const reserved = await operations.reserveTask({
			planId: plan.id, taskId: "T-001", expectedRevision: plan.revision, reservationId: "renamed-child",
		});
		const worktree = path.join(workspacePath, "child");
		git(workspacePath, "worktree", "add", "--quiet", "-b", "work/generated", worktree);
		const identity = { planId: plan.id, taskId: "T-001", attemptId: reserved.attemptId, sessionId: "same-child" };
		plan = await operations.attachTask({ ...identity, expectedRevision: reserved.plan.revision, branch: "work/generated" });
		const original = structuredClone(plan.tasks[0].attempts[0]);
		git(worktree, "branch", "-m", "work/meaningful");
		const request = {
			...identity, expectedRevision: plan.revision, branch: "work/meaningful",
			rename: { fromBranch: "work/generated", worktreePath: worktree, actor: "owner", reason: "App-required initial rename" },
		};
		await assert.rejects(operations.attachTask({ ...request, expectedRevision: plan.revision - 1 }), { code: "revision_conflict" });
		await assert.rejects(operations.attachTask({ ...request, sessionId: "replacement" }), { code: "task_branch_rename_mismatch" });
		await assert.rejects(operations.attachTask({ ...request, rename: { ...request.rename, worktreePath: workspacePath } }), { code: "task_branch_rename_mismatch" });
		await assert.rejects(operations.attachTask({ ...identity, expectedRevision: plan.revision, branch: request.branch }), { code: "attempt_already_attached" });
		assert.equal((await operations.getPlan({ planId: plan.id })).revision, plan.revision);
		plan = await operations.attachTask(request);
		const renamed = plan.tasks[0].attempts[0];
		assert.deepEqual({ ...renamed, branch: original.branch, branchRenames: undefined }, { ...original, branchRenames: undefined });
		assert.equal(renamed.branch, request.branch);
		assert.equal(renamed.branchRenames?.[0].from, original.branch);
		assert.equal(renamed.branchRenames?.[0].worktree.path, worktree);
		assert.equal(plan.activity.at(-1)?.event, "task-branch-reconciled:T-001:T-001-A001");
		assert.equal((await operations.attachTask(request)).revision, plan.revision);
		git(worktree, "branch", "-m", "work/final");
		plan = await operations.attachTask({
			...request, expectedRevision: plan.revision, branch: "work/final",
			rename: { ...request.rename, fromBranch: request.branch },
		});
		assert.equal(plan.tasks[0].attempts[0].branchRenames?.length, 2);
		await assert.rejects(operations.completeTask({
			...identity, expectedRevision: plan.revision, status: "done", branch: original.branch,
			resultSummary: "Delivered", evidence: evidence("Passed"),
		}), { code: "branch_mismatch" });
		plan = await operations.completeTask({
			...identity, expectedRevision: plan.revision, status: "done", branch: "work/final",
			resultSummary: "Delivered", evidence: evidence("Passed"),
		});
		git(worktree, "branch", "-m", "work/too-late");
		await assert.rejects(operations.attachTask({
			...request, expectedRevision: plan.revision, branch: "work/too-late",
			rename: { ...request.rename, fromBranch: "work/final" },
		}), { code: "attempt_already_attached" });
		assert.equal((await operations.getPlan({ planId: plan.id })).tasks[0].attempts[0].branch, "work/final");
	})
));

test("branch reconciliation does not mutate a cancelling attempt", () => (
	withOperations(async ({ operations, workspacePath }) => {
		const approved = await createApproved(operations, workspacePath);
		const reserved = await operations.reserveTask({
			planId: approved.id, taskId: "T-001", expectedRevision: approved.revision, reservationId: "cancelled-rename",
		});
		const worktree = path.join(workspacePath, "child");
		git(workspacePath, "worktree", "add", "--quiet", "-b", "work/before", worktree);
		const identity = { planId: approved.id, taskId: "T-001", attemptId: reserved.attemptId, sessionId: "cancelled-child" };
		let plan = await operations.attachTask({ ...identity, expectedRevision: reserved.plan.revision, branch: "work/before" });
		git(worktree, "branch", "-m", "work/after");
		plan = await operations.cancel({
			planId: plan.id, expectedRevision: plan.revision, requestId: "cancel-before-reconcile", requestedBy: "owner", reason: "Stop",
		});
		await assert.rejects(operations.attachTask({
			...identity, expectedRevision: plan.revision, branch: "work/after",
			rename: { fromBranch: "work/before", worktreePath: worktree, actor: "owner", reason: "App rename" },
		}), { code: "attempt_already_attached" });
		assert.equal((await operations.getPlan({ planId: plan.id })).revision, plan.revision);
	})
));

test("done attempts report actionable missing delivery fields", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await createApproved(operations, workspacePath);
		const first = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-001",
			expectedRevision: plan.revision,
			reservationId: "missing-completion-fields",
		});
		plan = await operations.attachTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: first.attemptId,
			expectedRevision: first.plan.revision,
			sessionId: "missing-completion-session",
			branch: "work/missing-completion",
		});
		await assert.rejects(
			operations.completeTask({
				planId: plan.id,
				taskId: "T-001",
				attemptId: first.attemptId,
				expectedRevision: plan.revision,
				status: TASK_STATUS.DONE,
			}),
			(/** @type {unknown} */ error) =>
				errorCode(error) === "task_completion_incomplete"
				&& missingFields(error).includes("resultSummary")
				&& missingFields(error).includes("evidence")
				&& !missingFields(error).includes("branch"),
		);
		await assert.rejects(
			operations.completeTask({
				planId: plan.id,
				taskId: "T-001",
				attemptId: first.attemptId,
				expectedRevision: plan.revision,
				status: TASK_STATUS.DONE,
				resultSummary: "Foundation complete",
				evidence: evidence("Foundation passed"),
				branch: "work/wrong-branch",
			}),
			{ code: "branch_mismatch" },
		);
		plan = await operations.completeTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: first.attemptId,
			expectedRevision: plan.revision,
			status: TASK_STATUS.DONE,
			resultSummary: "Foundation complete",
			evidence: evidence("Foundation passed"),
		});
		assert.equal(plan.tasks[0].attempts[0].branch, "work/missing-completion");

		const second = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-002",
			expectedRevision: plan.revision,
			reservationId: "short-commit",
		});
		plan = await operations.attachTask({
			planId: plan.id,
			taskId: "T-002",
			attemptId: second.attemptId,
			expectedRevision: second.plan.revision,
			sessionId: "short-commit-session",
			branch: "work/short-commit",
		});
		await assert.rejects(
			operations.completeTask({
				planId: plan.id,
				taskId: "T-002",
				attemptId: second.attemptId,
				expectedRevision: plan.revision,
				status: TASK_STATUS.DONE,
				resultSummary: "Integration complete",
				evidence: evidence("Integration passed"),
				branch: "work/short-commit",
				commit: "abcdef0",
			}),
			(/** @type {unknown} */ error) =>
				errorCode(error) === "task_completion_incomplete"
				&& missingFields(error).includes("full commit"),
		);
	})
));

test("completion only reuses a branch when one was attached", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await createApproved(operations, workspacePath);
		const reserved = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-001",
			expectedRevision: plan.revision,
			reservationId: "branch-not-attached",
		});
		plan = await operations.attachTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: reserved.attemptId,
			expectedRevision: reserved.plan.revision,
			sessionId: "branchless-session",
		});
		const result = {
			planId: plan.id,
			taskId: "T-001",
			attemptId: reserved.attemptId,
			expectedRevision: plan.revision,
			status: TASK_STATUS.DONE,
			resultSummary: "Delivered",
			evidence: evidence("Passed"),
		};
		await assert.rejects(operations.completeTask(result), (/** @type {unknown} */ error) => {
			assert.equal(errorCode(error), "task_completion_incomplete");
			assert.deepEqual(missingFields(error), ["branch"]);
			return true;
		});
		plan = await operations.completeTask({ ...result, branch: "work/reported" });
		assert.equal(plan.tasks[0].attempts[0].branch, "work/reported");
	})
));

test("attached task failures require terminal session inventory", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await createApproved(operations, workspacePath);
		const reserved = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-001",
			expectedRevision: plan.revision,
			reservationId: "failed-session-proof",
		});
		plan = await operations.attachTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: reserved.attemptId,
			expectedRevision: reserved.plan.revision,
			sessionId: "failed-session",
			branch: "work/failed-session",
		});
		await assert.rejects(
			operations.completeTask({
				planId: plan.id,
				taskId: "T-001",
				attemptId: reserved.attemptId,
				expectedRevision: plan.revision,
				status: TASK_STATUS.FAILED,
				error: "Worker failed",
			}),
			(/** @type {unknown} */ error) =>
				errorCode(error) === "task_session_not_terminated",
		);
		plan = await operations.completeTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: reserved.attemptId,
			expectedRevision: plan.revision,
			status: TASK_STATUS.FAILED,
			error: "Worker failed",
			sessionInventory: {
				complete: true, capturedAt: new Date().toISOString(),
				sessions: [{ id: "failed-session", status: "archived" }],
			},
		});
		assert.equal(
			plan.tasks[0].attempts[0].sessionTerminatedAt,
			plan.tasks[0].attempts[0].completedAt,
		);
	})
));

test("scope overlap needs an auditable override and running scopes stay occupied", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await createApproved(operations, workspacePath);
		const first = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-001",
			expectedRevision: plan.revision,
			reservationId: "reserve-overlap-one",
		});
		plan = first.plan;
		const next = await operations.nextTasks({ planId: plan.id });
		assert.deepEqual(next.dispatchableTaskIds, []);
		assert.deepEqual(next.heldTaskIds, ["T-002"]);
		await assert.rejects(
			operations.reserveTask({
				planId: plan.id,
				taskId: "T-002",
				expectedRevision: plan.revision,
				reservationId: "reserve-overlap-two",
			}),
			(/** @type {unknown} */ error) => errorCode(error) === "scope_overlap_requires_approval",
		);
		const override = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-002",
			expectedRevision: plan.revision,
			reservationId: "reserve-overlap-two",
			scopeOverride: {
				approvedBy: "octocat",
				reason: "Tasks use disjoint generated sections",
			},
		});
		assert.equal(
			override.plan.tasks[1].attempts[0].scopeOverride?.approvedBy,
			"octocat",
		);
	}, {
		analysis: analysisStub({
			plan: {
				...planBlueprint(),
				tasks: [
					...planBlueprint().tasks.slice(0, 2).map((task) => ({
						...task,
						dependsOn: [],
						expectedFiles: ["src/**"],
					})),
					{
						id: "T-003",
						title: "Integrate",
						kind: "implement",
						description: "Integrate both tasks",
						dependsOn: ["T-001", "T-002"],
						acceptanceCriteria: ["Integration is complete"],
						expectedFiles: ["src/integration.mjs"],
						deliveryRequirement: "commit",
					},
					{
						...planBlueprint().tasks[2],
						id: "T-004",
						dependsOn: ["T-003"],
					},
				],
			},
		}),
	})
));
