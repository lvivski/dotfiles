import assert from "node:assert/strict";
import test from "node:test";
import { getReadyTasks, latestSuccessfulAttempt, summarizePlan } from "../../plan/queries.mjs";
import { validatePlan } from "../../plan/validation.mjs";
import { TASK_STATUS } from "../../plan/values.mjs";
import { approved, completeTask, required, task, throwsCode } from "./fixture.mjs";

test("approval resolves ready tasks deterministically", () => {
	const plan = approved({
		tasks: [task("T-002"), task("T-001"), task("T-003", ["T-001"])],
	});
	assert.deepEqual(getReadyTasks(plan).map((entry) => entry.id), ["T-001", "T-002"]);
	assert.equal(
		required(plan.tasks.find((entry) => entry.id === "T-003")).status,
		TASK_STATUS.PLANNED,
	);
});

test("readiness is derived without changing the stored plan or its revision", () => {
	const plan = approved();
	const before = structuredClone(plan);
	assert.equal(plan.tasks[0].status, TASK_STATUS.PLANNED);
	assert.deepEqual(getReadyTasks(plan).map((task) => [task.id, task.status]), [["T-001", TASK_STATUS.READY]]);
	assert.deepEqual(plan, before);
	const invalid = structuredClone(plan);
	invalid.tasks[0].status = TASK_STATUS.READY;
	throwsCode(() => validatePlan(invalid), "invalid_task_status");
});

test("summaries include attempt counts without duplicating attempt state", () => {
	let plan = approved({ tasks: [task("T-001")] });
	({ plan } = completeTask(plan, "T-001"));
	const summary = summarizePlan(plan);
	assert.equal(summary.tasksDone, 1);
	assert.equal(summary.attemptsTotal, 1);
	assert.equal(latestSuccessfulAttempt(required(plan.tasks[0]))?.id, "T-001-A001");
});

test("PF-ADM-02 a done label without a recorded successful delivery cannot unblock dependents", () => {
	const plan = approved();
	plan.tasks[0].status = TASK_STATUS.DONE;
	assert.deepEqual(getReadyTasks(plan), []);
	let completed = completeTask(approved(), "T-001").plan;
	assert.deepEqual(getReadyTasks(completed).map(task => task.id), ["T-002"]);
	completed.tasks[0].attempts[0].commit = null;
	assert.deepEqual(getReadyTasks(completed), []);
});
