import assert from "node:assert/strict";
import test from "node:test";
import { RENDERER_SCRIPTS } from "../../server/assets.mjs";
import { browser, flush, rendererRoot } from "./browser.mjs";
import { snapshot } from "./fixture.mjs";

test("the module entry loads the complete served dependency graph before reading a snapshot", async () => {
	const board = await browser();
	assert.deepEqual([...board.loaded].sort(), RENDERER_SCRIPTS.map((name) => new URL(name, rendererRoot).href).sort());
	assert.equal(board.requests.length, 1);
	assert.equal(board.requests[0].url, "api/plan");
	await board.respond(0, snapshot(1));
	board.hidePage();
});

test("refresh bursts coalesce without losing invalidations and accept equal-revision projections", async () => {
	const board = await browser();
	for (let count = 0; count < 4; count += 1) board.change();
	board.nodes.get("#refresh-button").click();
	assert.equal(board.requests.length, 1);
	await board.respond(0, snapshot(1));
	assert.equal(board.requests.length, 2);
	board.change();
	board.change();
	await board.respond(1, snapshot(2, { approved: true }));
	assert.equal(board.requests.length, 3);
	const equalRevision = snapshot(2, { approved: true });
	equalRevision.projection.nextAction = { kind: "record-task-result" };
	equalRevision.projection.progress.attempts = 7;
	await board.respond(2, equalRevision);
	assert.equal(board.requests.length, 3);
	assert.match(board.nodes.get("#recovery").textContent, /record-task-result/);
	assert.match(board.nodes.get("#summary").textContent, /Attempts7/);
	assert.equal(board.nodes.get("#approve-button").hidden, true);
});

test("failed refreshes retain pending invalidations and permit later recovery", async () => {
	const board = await browser();
	board.change();
	board.requests[0].reject(new Error("Network unavailable"));
	await flush();
	assert.equal(board.nodes.get("#error").textContent, "Network unavailable");
	assert.equal(board.requests.length, 2);
	await board.respond(1, snapshot(1));
	assert.equal(board.nodes.get("#error").textContent, "");
	board.nodes.get("#refresh-button").click();
	board.requests[2].reply({ ok: false, error: { message: "Plan temporarily unreadable" } }, 500);
	await flush();
	assert.equal(board.requests.length, 3);
	assert.equal(board.nodes.get("#error").textContent, "Plan temporarily unreadable");
	board.events.onerror();
	assert.match(board.nodes.get("#error").textContent, /Live updates disconnected/);
	board.change();
	await board.respond(3, snapshot(2));
	assert.equal(board.nodes.get("#error").textContent, "");
});

test("binding changes require a new document and reset revision and refresh state", async () => {
	const oldBoard = await browser("old-plan");
	await oldBoard.respond(0, snapshot(9, { id: "old-plan", approved: true }));
	oldBoard.nodes.get("#refresh-button").click();
	oldBoard.change();
	const rebound = await browser("new-plan");
	await rebound.respond(0, snapshot(1, { id: "new-plan" }));
	assert.equal(rebound.nodes.get("#approve-button").hidden, false);
	rebound.change();
	await rebound.respond(1, snapshot(99, { id: "old-plan" }));
	assert.equal(rebound.nodes.get("#plan-title").textContent, "Revision 1");
	await oldBoard.respond(1, snapshot(10, { id: "old-plan", approved: true }));
	await oldBoard.respond(2, snapshot(11, { id: "old-plan", approved: true }));
	assert.equal(rebound.requests.length, 2);
	assert.equal(rebound.nodes.get("#plan-title").textContent, "Revision 1");
	rebound.nodes.get("#approve-button").click();
	await rebound.respond(2, snapshot(100, { id: "old-plan", approved: true }));
	assert.equal(rebound.nodes.get("#approve-button").hidden, false);
	await rebound.respond(3, snapshot(2, { id: "new-plan", approved: true }));
	assert.equal(rebound.nodes.get("#plan-title").textContent, "Revision 2");
});
