import assert from "node:assert/strict";
import test from "node:test";
import { must } from "../assertions.mjs";
import { detail, flush, gate, service } from "./time.mjs";

test("the first hourly question survives a dropped checkpoint event through the native wait", async () => {
	const run = detail({ status: "running", canResume: false, terminal: null });
	const current = service([run]);
	try {
		await current.review.refresh();
		await current.review.refresh();
		assert.equal(current.waits.length, 1);
		assert.equal(current.waits[0].runId, run.runId);
		assert.equal(must(current.waits[0].signal).aborted, false);
		assert.equal(current.dialogs.length, 0);

		run.status = "paused";
		run.canResume = true;
		run.revision++;
		run.terminal = { pauseInfo: { type: "checkpoint", key: "deep-research:time-review:v1:3600" } };
		current.waits[0].settle();
		await flush();

		assert.equal(current.dialogs.length, 1);
		assert.equal(current.controls[0].runId, run.runId);
		assert.deepEqual(must(current.controls[0].options).limits, { timeoutSeconds: 7200 });
		assert.deepEqual(run.approved, { timeoutSeconds: 7200, maxAiCredits: 10, maxConcurrentSubagents: 2, maxTotalSubagents: 40 });
		assert.deepEqual(current.logs, []);
	} finally { current.close(); }
});

test("native waits deduplicate pending/running invalidations and reread the settled run directly", async () => {
	const run = detail({ status: "pending", canResume: false, terminal: null });
	const current = service([run], { choose: async () => "Keep paused" });
	try {
		await current.review.refresh();
		run.status = "running";
		run.revision++;
		await current.review.refresh(run.runId);
		await current.review.refresh(run.runId);
		assert.equal(current.waits.length, 1);
		const stale = structuredClone(run);
		current.api.listRuns = async () => ({ runs: [stale], omittedOlder: 0 });
		run.status = "paused";
		run.canResume = true;
		run.revision++;
		run.terminal = { pauseInfo: { type: "checkpoint", key: "deep-research:time-review:v1:3600" } };
		current.waits[0].settle();
		await flush();
		assert.equal(current.dialogs.length, 1);
		assert.equal(current.waits.length, 1);
		assert.deepEqual(current.controls, []);
		assert.deepEqual(current.logs, []);
	} finally { current.close(); }
});

test("known-run waits and invalidations do not depend on global history discovery", async () => {
	const run = detail({ status: "running", canResume: false, terminal: null });
	const current = service([run], { choose: async () => "Keep paused" });
	try {
		await current.review.refresh();
		current.api.listRuns = async () => assert.fail("Known runs use direct native lookup");
		run.status = "paused";
		run.canResume = true;
		run.revision++;
		run.terminal = { pauseInfo: { type: "checkpoint", key: "deep-research:time-review:v1:3600" } };
		current.waits[0].settle();
		await flush();
		await current.review.refresh(run.runId);
		assert.equal(current.dialogs.length, 1);
		assert.deepEqual(current.logs, []);
	} finally { current.close(); }
});

test("failed restart discovery reports its error but cannot hide an explicitly invalidated checkpoint", async () => {
	const current = service(undefined, { choose: async () => "Keep paused" });
	current.api.listRuns = async () => { throw new Error("History unavailable"); };
	try {
		await current.review.refresh("research-run");
		assert.equal(current.dialogs.length, 1);
		assert.equal(current.logs.length, 1);
		assert.match(current.logs[0], /discovery failed: History unavailable/);
		assert.deepEqual(current.controls, []);
	} finally { current.close(); }
});

test("restart discovery observes active research without replaying historical timeout dialogs", async () => {
	const active = detail({ status: "running", canResume: false, terminal: null });
	/** @param {string} runId @returns {import("@github/copilot-sdk").WorkflowRunResult["failure"]} */
	const failure = (runId) => ({
		type: "workflow_limit_reached", kind: "timeoutSeconds", value: 3600, runId,
	});
	const old = detail({
		runId: "old-timeout", status: "error",
		terminal: { pauseInfo: null, failure: failure("old-timeout") },
	});
	const first = service([active, old]);
	await first.review.refresh();
	assert.equal(first.waits.length, 1);
	first.close();
	assert.equal(must(first.waits[0].signal).aborted, true);

	const restarted = service([active, old], { choose: async () => "Keep paused" });
	try {
		await restarted.review.refresh();
		assert.equal(restarted.waits.length, 1);
		assert.equal(restarted.dialogs.length, 0);
		active.status = "error";
		active.canResume = true;
		active.revision++;
		active.terminal = { pauseInfo: null, failure: failure(active.runId) };
		restarted.waits[0].settle();
		await flush();
		assert.equal(restarted.dialogs.length, 1);
		assert.match(restarted.dialogs[0].message, /Research research-run reached/);
		assert.deepEqual(restarted.controls, []);
	} finally { restarted.close(); }
});

test("all active runs are watched before waiting for a serialized time decision", async () => {
	const answer = gate();
	const entered = gate();
	const active = detail({ runId: "second-run", status: "running", canResume: false, terminal: null });
	const pending = detail({ runId: "third-run", status: "pending", canResume: false, terminal: null });
	const current = service([detail(), active, pending], {
		choose: async () => { entered.release(); await answer.promise; return "Keep paused"; },
	});
	try {
		const refreshing = current.review.refresh();
		await entered.promise;
		assert.deepEqual(current.waits.map(({ runId }) => runId), ["second-run", "third-run"]);
		active.status = "paused";
		active.canResume = true;
		active.revision++;
		active.terminal = { pauseInfo: { type: "checkpoint", key: "deep-research:time-review:v1:3600" } };
		current.waits[0].settle();
		await flush();
		assert.equal(current.dialogs.length, 1);
		answer.release();
		await refreshing;
		assert.equal(current.dialogs.length, 2);
		assert.equal(current.waits.length, 2);
	} finally { answer.release(); current.close(); }
});

test("closing the provider aborts only its wait and suppresses late dialogs", async () => {
	const run = detail({ status: "running", canResume: false, terminal: null });
	const current = service([run]);
	await current.review.refresh();
	current.close();
	await flush();
	current.waits[0].settle({ runId: run.runId, status: "paused" });
	await current.review.refresh(run.runId);
	await flush();
	assert.equal(must(current.waits[0].signal).aborted, true);
	assert.equal(run.status, "running");
	assert.deepEqual(current.controls, []);
	assert.deepEqual(current.dialogs, []);
	assert.deepEqual(current.logs, []);
});

test("failed native waits are explicit and retry only after a new observation revision", async () => {
	const run = detail({ status: "running", canResume: false, terminal: null });
	const current = service([run]);
	let calls = 0;
	current.api.waitForRun = async () => { calls++; throw new Error("Native wait unavailable"); };
	try {
		await current.review.refresh();
		await flush();
		await current.review.refresh();
		await current.review.refresh(run.runId);
		assert.equal(calls, 1);
		assert.equal(current.logs.length, 1);
		assert.match(current.logs[0], /wait for research-run failed: Native wait unavailable/);
		run.revision++;
		await current.review.refresh(run.runId);
		await flush();
		assert.equal(calls, 2);
		assert.deepEqual(current.controls, []);
	} finally { current.close(); }
});

test("native waits cannot introduce a foreign or still-active settlement", async () => {
	for (const result of /** @type {const} */ ([{ runId: "foreign-run", status: "paused" }, { runId: "research-run", status: "running" }])) {
		const current = service([detail({ status: "running", canResume: false, terminal: null })]);
		try {
			await current.review.refresh();
			current.waits[0].settle(result);
			await flush();
			assert.match(current.logs.join("\n"), /different or unsettled run/);
			assert.deepEqual(current.dialogs, []);
			assert.deepEqual(current.controls, []);
		} finally { current.close(); }
	}
});

test("native acceptance adds exactly one hour to the same run without changing other limits", async () => {
	const run = detail();
	const current = service([run]);
	try {
		await current.review.refresh();
		assert.deepEqual(current.controls, [{
			action: "resume", runId: run.runId,
			options: { limits: { timeoutSeconds: 7200 }, notifyOnComplete: true, logPhaseNames: true },
		}]);
		assert.deepEqual(run.approved, { timeoutSeconds: 7200, maxAiCredits: 10, maxConcurrentSubagents: 2, maxTotalSubagents: 40 });
		assert.deepEqual(current.dialogs[0].choices, ["Extend by one hour", "Keep paused", "Stop"]);
		assert.match(current.dialogs[0].message, /120-minute total limit/);
		await current.review.refresh();
		assert.equal(current.dialogs.length, 1);
		run.status = "paused";
		run.terminal = { pauseInfo: { type: "checkpoint", key: "deep-research:time-review:v1:7200" } };
		run.revision++;
		await current.review.refresh();
		assert.equal(current.controls[1].options.limits.timeoutSeconds, 10800);
		assert.equal(current.dialogs.length, 2);
	} finally { current.close(); }
});

test("dismissal and keeping paused never dispatch or repeatedly prompt", async () => {
	for (const choice of [null, "Keep paused"]) {
		const current = service(undefined, { choose: async () => choice });
		try {
			await current.review.refresh();
			await current.review.refresh();
			assert.equal(current.controls.length, 0);
			assert.equal(current.dialogs.length, 1);
		} finally { current.close(); }
	}
});

test("stop cancels the existing run without changing its budget", async () => {
	const run = detail();
	const current = service([run], { choose: async () => "Stop" });
	try {
		await current.review.refresh();
		assert.deepEqual(current.controls, [{ action: "cancel", runId: run.runId }]);
		assert.equal(run.status, "cancelled");
		assert.equal(run.approved?.timeoutSeconds, 3600);
	} finally { current.close(); }
});

test("manual checkpoints, unrelated recipes, and non-time failures do not request another hour", async () => {
	const current = service([
		detail({ runId: "manual", terminal: { pauseInfo: { type: "user" } } }),
		detail({ runId: "scope", terminal: { pauseInfo: { type: "checkpoint", key: "deep-research:before-research:v1" } } }),
		detail({ runId: "foreign", workflowName: "audit" }),
		detail({ runId: "credits", terminal: { pauseInfo: null, failure: { type: "workflow_limit_reached", runId: "credits", kind: "maxAiCredits", value: 10 } } }),
		detail({ runId: "completed", status: "completed", canResume: false }),
	]);
	try {
		await current.review.refresh();
		assert.equal(current.dialogs.length, 0);
		assert.deepEqual(current.reads, []);
	} finally { current.close(); }
});

test("stale decisions and provider closure cannot dispatch a late answer", async () => {
	for (const reason of ["changed", "closed"]) {
		const answer = gate();
		const entered = gate();
		const run = detail();
		const current = service([run], { choose: async () => { entered.release(); await answer.promise; return "Extend by one hour"; } });
		try {
			const pending = current.review.refresh();
			await entered.promise;
			if (reason === "changed") run.revision++;
			else current.review.close();
			answer.release();
			await pending;
			assert.deepEqual(current.controls, []);
			if (reason === "changed") assert.match(current.logs.join("\n"), /changed while awaiting/);
		} finally { answer.release(); current.close(); }
	}
});

test("invalidations coalesce while a dialog waits and resumed work does not block the next decision", async () => {
	const answer = gate();
	const entered = gate();
	let decisions = 0;
	const current = service([detail(), detail({ runId: "second-run" })], {
		choose: async () => {
			decisions++;
			if (decisions === 1) { entered.release(); await answer.promise; return "Extend by one hour"; }
			return "Keep paused";
		},
	});
	try {
		const pending = current.review.refresh();
		await entered.promise;
		await current.review.refresh();
		await current.review.refresh();
		assert.equal(current.dialogs.length, 1);
		answer.release();
		await pending;
		assert.equal(current.dialogs.length, 2);
		assert.equal(current.controls.length, 1);
	} finally { answer.release(); current.close(); }
});

test("a notified checkpoint outside the history window still asks only once", async () => {
	const current = service(undefined, { choose: async () => "Keep paused" });
	current.api.listRuns = async () => ({ runs: [], omittedOlder: 30 });
	try {
		await current.review.refresh("research-run");
		assert.equal(current.dialogs.length, 1);
		await current.review.refresh();
		await current.review.refresh("research-run");
		assert.equal(current.dialogs.length, 1);
		assert.deepEqual(current.controls, []);
	} finally { current.close(); }
});

test("an unreadable invalidation cannot hide another research decision", async () => {
	const current = service(undefined, { choose: async () => "Keep paused" });
	try {
		await current.review.refresh("missing-run");
		assert.equal(current.dialogs.length, 1);
		assert.match(current.logs.join("\n"), /lookup for missing-run failed/);
		assert.deepEqual(current.controls, []);
	} finally { current.close(); }
});

test("unsupported hosts and failed native dialogs stay explicit without automatic extension", async () => {
	for (const options of [
		{ supported: false },
		{ choose: async () => { throw new Error("Host dialog failed"); } },
		{ choose: async () => "Unexpected answer" },
	]) {
		const current = service(undefined, options);
		try {
			await current.review.refresh();
			await current.review.refresh();
			assert.equal(current.controls.length, 0);
			assert.equal(current.logs.length, 1);
			assert.match(current.logs[0], /unavailable|failed|unsupported/);
		} finally { current.close(); }
	}
});

test("a missed deadline offers recovery only for research observed active by this provider", async () => {
	const timedOut = detail({
		status: "error", terminal: {
			pauseInfo: null, failure: {
				type: "workflow_limit_reached", kind: "timeoutSeconds", value: 3600, runId: "research-run",
			}
		},
	});
	const current = service([timedOut]);
	try {
		await current.review.refresh();
		assert.equal(current.dialogs.length, 0);
		timedOut.status = "running";
		await current.review.refresh();
		assert.deepEqual(current.reads, []);
		timedOut.status = "error";
		await current.review.refresh();
		assert.equal(current.dialogs.length, 1);
		assert.match(current.dialogs[0].message, /reached its 60-minute/);
		assert.equal(must(must(current.controls[0].options).limits).timeoutSeconds, 7200);
	} finally { current.close(); }
});

test("the native maximum is not bypassed and a failed control is reported", async () => {
	const seconds = 2_147_483;
	const capped = service([detail({
		approved: { timeoutSeconds: seconds },
		terminal: { pauseInfo: { type: "checkpoint", key: `deep-research:time-review:v1:${seconds}` } },
	})], { choose: async () => "Keep paused" });
	try {
		await capped.review.refresh();
		assert.deepEqual(capped.dialogs[0].choices, ["Keep paused", "Stop"]);
	} finally { capped.close(); }
	/** @type {import("@github/copilot-sdk").SessionWorkflowApi["resume"][]} */
	const failures = [
		async () => { throw new Error("Resume unavailable"); },
		async () => Promise.reject("Resume unavailable"),
		async (runId) => ({ runId, status: "error", error: "Resume unavailable" }),
	];
	for (const resume of failures) {
		const failed = service();
		failed.api.resume = resume;
		try {
			await failed.review.refresh();
			await flush();
			assert.match(failed.logs.join("\n"), /Resume unavailable/);
		} finally { failed.close(); }
	}
});
