import assert from "node:assert/strict";
import test from "node:test";
import { researchWithTimeReview } from "../../research/budget.mjs";
import { context, detail, flush, gate } from "./time.mjs";

test("unfinished research pauses one minute before its cumulative approved deadline", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const current = context(detail({ status: "running", consumed: { activeMs: 0, subagents: 0, nanoAiu: 0 } }));
	const pending = gate();
	let started = 0;
	const paused = assert.rejects(researchWithTimeReview(current.workflow, () => {
		started++;
		return pending.promise.then(() => "Report");
	}), { name: "AbortError" });
	await flush();
	assert.equal(started, 1);
	t.mock.timers.tick(3_539_999);
	assert.deepEqual(current.pauses, []);
	t.mock.timers.tick(1);
	await paused;
	assert.deepEqual(current.pauses, ["deep-research:time-review:v1:3600"]);
	pending.release();
});

test("another hour schedules the next review against retained active time", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const current = context(detail({ status: "running", approved: { timeoutSeconds: 7200 } }));
	const pending = gate();
	const paused = assert.rejects(researchWithTimeReview(current.workflow, () => pending.promise.then(() => "Report")), { name: "AbortError" });
	await flush();
	t.mock.timers.tick(3_599_999);
	assert.deepEqual(current.pauses, []);
	t.mock.timers.tick(1);
	await paused;
	assert.deepEqual(current.pauses, ["deep-research:time-review:v1:7200"]);
	pending.release();
});

test("completed, failed, and cancelled research never leaves a live review timer", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const scheduled = t.mock.method(globalThis, "setTimeout");
	const cleared = t.mock.method(globalThis, "clearTimeout");
	const current = context(detail({ status: "running", consumed: { activeMs: 0, nanoAiu: 0, subagents: 0 } }));
	assert.equal(await researchWithTimeReview(current.workflow, async () => "Report"), "Report");
	await assert.rejects(researchWithTimeReview(current.workflow, async () => { throw new Error("Research failed"); }), /Research failed/);
	const pending = gate();
	const cancelled = assert.rejects(researchWithTimeReview(current.workflow, () => pending.promise.then(() => "Report")), { name: "AbortError" });
	await flush();
	current.controller.abort();
	await cancelled;
	t.mock.timers.tick(3_600_000);
	assert.deepEqual(current.pauses, []);
	assert.equal(scheduled.mock.callCount(), 3);
	assert.deepEqual(
		cleared.mock.calls.map((call) => call.arguments[0]),
		scheduled.mock.calls.map((call) => call.result),
	);
	pending.release();
});

test("native observation latency does not postpone the checkpoint", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const run = detail({ status: "running", consumed: { activeMs: 0, subagents: 0, nanoAiu: 0 } });
	const current = context(run);
	const observation = gate();
	const pending = gate();
	current.workflow.session.workflow.getRunDetail = async () => { await observation.promise; return run; };
	const paused = assert.rejects(researchWithTimeReview(current.workflow, () => pending.promise.then(() => "Report")), { name: "AbortError" });
	t.mock.timers.tick(120_000);
	observation.release();
	await flush();
	t.mock.timers.tick(3_419_999);
	assert.deepEqual(current.pauses, []);
	t.mock.timers.tick(1);
	await paused;
	assert.deepEqual(current.pauses, ["deep-research:time-review:v1:3600"]);
	pending.release();
});

test("near-deadline work pauses before dispatch; an unbounded run is not given a new ceiling", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const current = context(detail({ status: "running" }));
	let started = 0;
	const work = async () => { started++; return "Report"; };
	await assert.rejects(researchWithTimeReview(current.workflow, work), { name: "AbortError" });
	assert.equal(started, 0);
	current.workflow.pause = async (key) => { current.pauses.push(key); };
	assert.equal(await researchWithTimeReview(current.workflow, work), "Report");
	assert.equal(started, 1);
	const unbounded = context(detail({ status: "running", approved: {} }));
	assert.equal(await researchWithTimeReview(unbounded.workflow, work), "Report");
	t.mock.timers.tick(3_600_000);
	assert.deepEqual(unbounded.pauses, []);
});

test("invalid native identity or accounting cannot start research", async () => {
	/** @type {Partial<import("@github/copilot-sdk").WorkflowRunDetail>[]} */
	const cases = [
		{ workflowName: "audit" }, { approved: null }, { status: "paused" },
		{ approved: { timeoutSeconds: -1 } }, { consumed: { activeMs: NaN, subagents: 0, nanoAiu: 0 } },
		{ observedAt: NaN }, { approved: { timeoutSeconds: 2_147_484 } },
	];
	for (const overrides of cases) {
		const current = context(detail({ status: "running", ...overrides }));
		await assert.rejects(researchWithTimeReview(current.workflow, async () => assert.fail("Must not start research")));
	}
});
