import assert from "node:assert/strict";
import test from "node:test";
import { requestPlanCancellation } from "../../plan/cancellation.mjs";
import { projectPlan } from "../../projection.mjs";
import { browser } from "./browser.mjs";
import { snapshot } from "./fixture.mjs";

test("planning provenance and cancellation guidance use workflow terminology", async () => {
	const board = await browser();
	const state = snapshot(1, { approved: true });
	state.plan.planning = { runId: "planning-run", inputDigest: "a".repeat(64) };
	state.plan = requestPlanCancellation(state.plan, {
		requestId: "cancel-renderer-workflow",
		reason: "Stop",
		requestedBy: "tester",
	});
	state.projection = projectPlan(state.plan);
	await board.respond(0, state);
	assert.match(board.nodes.get("#summary").textContent, /Workflow.*planning-run/);
	assert.match(board.nodes.get("#recovery").textContent, /cancel the authoritative workflow run/);
});

test("Ready task groups and badges derive from scheduling rather than persisted task status", async () => {
	const board = await browser();
	const state = snapshot(1, { approved: true });
	assert.deepEqual(state.plan.tasks.map(({ status }) => status), ["planned", "planned"]);
	assert.deepEqual(state.projection.scheduling.readyTaskIds, ["T-001"]);
	await board.respond(0, state);
	const tasks = board.nodes.get("#tasks");
	const ready = tasks.children.find((section) => section.children[0].textContent === "ready (1)");
	assert.ok(ready);
	assert.match(ready.textContent, /T-001/);
	assert.equal(ready.children[1].children[0].children[1].textContent, "ready");
	state.projection.scheduling.readyTaskIds = [];
	board.change();
	await board.respond(1, state);
	assert.equal(tasks.children[0].children[0].textContent, "planned (2)");
	assert.deepEqual(state.plan.tasks.map(({ status }) => status), ["planned", "planned"]);
});
