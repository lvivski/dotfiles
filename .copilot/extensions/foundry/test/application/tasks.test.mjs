import assert from "node:assert/strict";
import test from "node:test";
import { arrayOf, errorCode, property, readString } from "../../data.mjs";
import { TASK_STATUS } from "../../plan/values.mjs";
import { analysisStub, createApproved, evidence, planBlueprint, withOperations } from "./fixture.mjs";

/** @param {unknown} error */
const missingFields = (error) => arrayOf(readString)(property(property(error, "details"), "missing"));

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
