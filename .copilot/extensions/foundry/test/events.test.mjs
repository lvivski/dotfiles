import assert from "node:assert/strict";
import test from "node:test";
import { publishPlanChange, publishWorkflowChange, subscribeToPlan } from "../events.mjs";

test("native invalidations preserve plan revisions and unsubscribe with the board", () => {
	/** @type {import("../events.mjs").FoundryChangeEvent[]} */
	const received = [];
	const unsubscribe = subscribeToPlan("/workspace", "plan", (event) => received.push(event));
	try {
		publishPlanChange({ workspacePath: "/workspace", planId: "other", revision: 99 });
		publishPlanChange({ workspacePath: "/workspace", planId: "plan", revision: 2 });
		publishWorkflowChange({ runId: "events-run", revision: 7 });
		publishWorkflowChange({ runId: "events-run", revision: 7 });
		publishWorkflowChange({ runId: "events-run", revision: 6 });
		publishWorkflowChange({ runId: "events-run", revision: 8 });
		assert.deepEqual(received, [
			{ workspacePath: "/workspace", planId: "plan", revision: 2 },
			{ workflowRunId: "events-run", workflowRevision: 7 },
			{ workflowRunId: "events-run", workflowRevision: 8 },
		]);
	} finally {
		unsubscribe();
	}
	publishWorkflowChange({ runId: "events-run", revision: 9 });
	assert.equal(received.length, 3);
});
