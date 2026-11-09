import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { errorCode, parseJson } from "../../data.mjs";
import { LIMITS, PLAN_STATUS, TASK_STATUS } from "../../plan/values.mjs";
import { createPlanStore } from "../../storage.mjs";
import { must } from "../assertions.mjs";
import { analysisStub, createApproved, createInput, evidence, runTask, withOperations } from "./fixture.mjs";

test("activity stays bounded and records resulting revisions", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await operations.createPlan(createInput(workspacePath));
		plan.activity = Array.from({ length: LIMITS.activity }, (_, index) => ({
			event: `event-${index}`,
			at: plan.updatedAt,
			revision: 1,
		}));
		const store = createPlanStore({ workspacePath });
		plan = await store.update(plan.id, plan.revision, plan);

		const submitted = await operations.submitPlan({
			planId: plan.id,
			expectedRevision: plan.revision,
		});
		assert.equal(submitted.activity.length, LIMITS.activity);
		assert.equal(submitted.activity.at(-1)?.event, "plan-submitted");
		assert.equal(submitted.activity.at(-1)?.revision, submitted.revision);
		assert.equal(submitted.activity[0].event, "event-1");
	})
));

test("explicit JSON interchange restores a plan without activating or launching work", () => (
	withOperations(async ({ operations, workspacePath, notifications }) => {
		const original = await operations.createPlan(createInput(workspacePath));
		const exported = parseJson(await operations.exportPlan({ planId: original.id }));
		assert.deepEqual(exported, original);
		const restored = await operations.importPlan({
			source: JSON.stringify({ ...exported, id: "restored-plan" }), expectedRevision: 0,
		});
		assert.equal(restored.id, "restored-plan");
		assert.equal(restored.status, PLAN_STATUS.DRAFT);
		assert.equal(await operations.getActivation(), null);
		assert.equal(notifications.length, 2);
		await assert.rejects(operations.importPlan({
			source: JSON.stringify(restored), expectedRevision: 0,
		}), { code: "plan_exists" });
	})
));

test("operations drive reservation, App attachment, verification, and approval", () => (
	withOperations(async ({ operations, notifications, workspacePath }) => {
		let plan = await createApproved(operations, workspacePath);
		let next = await operations.nextTasks({ planId: plan.id });
		assert.deepEqual(next.dispatchableTaskIds, ["T-001"]);
		assert.equal(next.tasks[0].launch.baseBranch, "main");
		assert.equal(Object.hasOwn(next.tasks[0], "delegationPrompt"), false);

		const first = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-001",
			expectedRevision: plan.revision,
			reservationId: "reserve-foundation",
		});
		plan = first.plan;
		assert.equal(first.attemptId, "T-001-A001");
		assert.match(first.delegationPrompt, /attempt T-001-A001/);
		assert.equal(plan.activity.at(-1)?.revision, plan.revision);
		assert.equal(
			plan.activity.at(-1)?.event,
			"task-reserved:T-001:T-001-A001",
		);
		const replay = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-001",
			expectedRevision: plan.revision - 1,
			reservationId: "reserve-foundation",
		});
		assert.equal(replay.plan.revision, plan.revision);
		assert.equal(replay.attemptId, first.attemptId);

		plan = await operations.attachTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: first.attemptId,
			expectedRevision: plan.revision,
			sessionId: "session-foundation",
			branch: "work/foundation",
		});
		const attachedRevision = plan.revision;
		const attachedReplay = await operations.attachTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: first.attemptId,
			expectedRevision: plan.revision - 1,
			sessionId: "session-foundation",
			branch: "work/foundation",
		});
		assert.equal(attachedReplay.revision, attachedRevision);

		plan = await operations.completeTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: first.attemptId,
			expectedRevision: plan.revision,
			status: TASK_STATUS.DONE,
			resultSummary: "Foundation complete",
			evidence: evidence("foundation tests passed"),
			branch: "work/foundation",
			commit: "b".repeat(40),
			prUrl: "https://github.com/example/repo/pull/1",
		});
		assert.equal(plan.tasks[1].status, TASK_STATUS.PLANNED);
		assert.deepEqual((await operations.getStatus({ planId: plan.id })).projection.scheduling.readyTaskIds, ["T-002"]);

		next = await operations.nextTasks({ planId: plan.id });
		assert.equal(next.tasks[0].launch.baseBranch, "work/foundation");
		const second = await runTask(operations, plan, "T-002", {
			reservationId: "reserve-integration",
			sessionId: "session-integration",
			branch: "work/integration",
			commit: "c".repeat(40),
		});
		plan = second.plan;
		({ plan } = await runTask(operations, plan, "T-003", {
			reservationId: "reserve-verifier",
			sessionId: "session-verifier",
			branch: "work/verifier",
			commit: "c".repeat(40),
		}));

		const verificationLaunch = await operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			reservationId: "reserve-verification-success",
		});
		assert.equal(verificationLaunch.workflow, "verify");
		plan = verificationLaunch.plan;
		plan = await operations.finishVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			runId: "workflow-run-1",
		});
		assert.equal(plan.status, PLAN_STATUS.AWAITING_COMPLETION_APPROVAL);
		plan = await operations.approve({
			planId: plan.id,
			expectedRevision: plan.revision,
			approvedBy: "octocat",
			approvalType: "completion",
		});
		assert.equal(plan.status, PLAN_STATUS.COMPLETED);
		assert.equal(plan.activity.at(-1)?.revision, plan.revision);
		assert.equal(notifications.at(-1)?.revision, plan.revision);
	}, {
		analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "found",
				run: { runId: "workflow-run-1", status: "completed" },
				duplicates: [],
			}),
		}),
	})
));

test("status projection distinguishes unknown from complete-inventory absence", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await createApproved(operations, workspacePath);
		const reserved = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-001",
			expectedRevision: plan.revision,
			reservationId: "reserve-projection",
		});
		plan = await operations.attachTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: reserved.attemptId,
			expectedRevision: reserved.plan.revision,
			sessionId: "session-projection",
		});
		const unknown = await operations.getStatus({ planId: plan.id });
		assert.equal(unknown.projection.activeAttempts[0].sessionState, "unknown");
		const absent = await operations.getStatus({
			planId: plan.id,
			sessionInventory: {
				complete: true,
				capturedAt: "2099-01-01T00:00:00.000Z",
				sessions: [],
			},
		});
		assert.equal(absent.projection.activeAttempts[0].sessionState, "absent");
		assert.equal(absent.projection.nextAction.kind, "inspect-missing-session");
	})
));

test("plan guardrails require explicit session-local activation", () => (
	withOperations(async ({ operations, workspacePath }) => {
		const plan = await operations.createPlan(createInput(workspacePath));
		assert.equal(await operations.getActive(), null);
		const marker = await operations.activate({
			planId: plan.id,
			expectedRevision: plan.revision,
		});
		assert.equal(marker.planId, plan.id);
		const persistedMarker = must(await operations.getActivation());
		assert.deepEqual(Object.keys(persistedMarker).sort(), ["activatedAt", "planId"]);
		assert.equal((await operations.getActive())?.plan.id, plan.id);
		assert.deepEqual(await operations.deactivate(), {
			deactivated: true,
			planId: plan.id,
			repaired: false,
		});
		assert.equal(await operations.getActive(), null);

		/** @param {string} planId @param {string} activatedAt */
		const corruptActivation = (planId, activatedAt) => {
			const database = new DatabaseSync(operations.storeFor().databasePath);
			try {
				database.exec("PRAGMA foreign_keys = OFF");
				database.prepare("INSERT OR REPLACE INTO activation(singleton, plan_id, activated_at) VALUES (1, ?, ?)").run(planId, activatedAt);
			} finally {
				database.close();
			}
		};
		corruptActivation(plan.id, "invalid-time");
		await assert.rejects(
			operations.getActive(),
			(/** @type {unknown} */ error) => errorCode(error) === "activation_invalid",
		);
		assert.deepEqual(await operations.deactivate(), {
			deactivated: true,
			planId: null,
			repaired: true,
		});
		assert.equal(await operations.getActive(), null);

		corruptActivation("../invalid", persistedMarker.activatedAt);
		await assert.rejects(
			operations.getActive(),
			(/** @type {unknown} */ error) => errorCode(error) === "invalid_plan_id",
		);
		assert.equal((await operations.deactivate()).repaired, true);

	})
));
