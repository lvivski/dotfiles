import assert from "node:assert/strict";
import test from "node:test";
import { must } from "../assertions.mjs";
import { browser, buttons, flush, posted } from "./browser.mjs";
import { snapshot, workflowSnapshot } from "./fixture.mjs";

test("native dialogs receive action intents without browser confirmation or client attribution", async () => {
	const board = await browser();
	const state = { ...workflowSnapshot(1), interactions: { native: true } };
	await board.respond(0, state);
	board.nodes.get("#approve-button").click();
	board.nodes.get("#approve-button").click();
	assert.equal(board.requests.length, 2);
	assert.deepEqual(posted(board.requests[1]), {
		action: "approve", revision: 1, approvalType: "plan",
	});
	assert.deepEqual(board.prompts, []);
	assert.deepEqual(board.confirmations, []);
	await board.respond(1, { action: "approve" });
	await board.respond(2, state);
	board.nodes.get("#cancel-plan-button").click();
	assert.deepEqual(posted(board.requests[3]), {
		action: "cancel", revision: 1, requestId: "cancel-request",
	});
	await board.respond(3, { action: "cancel" });
	await board.respond(4, state);
	buttons(board.nodes.get("#workflows"))[0].click();
	assert.deepEqual(posted(board.requests[5]), {
		action: "resume-workflow", runId: "research-run", revision: 1,
	});
	board.requests[5].reply({ ok: false, error: { message: "Native dialog failed" } }, 500);
	await flush();
	await board.respond(6, state);
	assert.match(board.nodes.get("#workflows").textContent, /Native dialog failed/);
	assert.deepEqual(board.prompts, []);
	assert.deepEqual(board.confirmations, []);
});

test("mutation acknowledgments invalidate an in-flight GET instead of owning view state", async () => {
	const board = await browser();
	await board.respond(0, snapshot(1));
	board.nodes.get("#refresh-button").click();
	board.nodes.get("#approve-button").click();
	assert.equal(board.requests[1].url, "api/plan");
	assert.equal(board.requests[2].url, "api/action");
	assert.equal(must(board.requests[2].options.headers)["x-foundry-token"], "token-renderer-plan");
	assert.deepEqual(posted(board.requests[2]), {
		action: "approve", revision: 1, approvalType: "plan", approvedBy: "tester", confirmed: true,
	});

	test("malformed wire snapshots retain the last valid board and surface the decoding error", async () => {
		const board = await browser();
		await board.respond(0, snapshot(1));
		board.change();
		const malformed = snapshot(2);
		await board.respond(1, { ...malformed, plan: { ...malformed.plan, revision: "two" } });
		assert.equal(board.nodes.get("#plan-title").textContent, "Revision 1");
		assert.match(board.nodes.get("#error").textContent, /Invalid board number/);
		board.change();
		await board.respond(2, snapshot(3));
		assert.equal(board.nodes.get("#plan-title").textContent, "Revision 3");
	});
	await board.respond(2, { action: "approve" });
	assert.equal(board.requests.length, 3);
	assert.equal(board.nodes.get("#plan-title").textContent, "Revision 1");
	await board.respond(1, snapshot(1));
	assert.equal(board.requests[3].url, "api/plan");
	await board.respond(3, snapshot(2, { approved: true }));
	assert.equal(board.nodes.get("#plan-title").textContent, "Revision 2");
	assert.equal(board.nodes.get("#approve-button").hidden, true);
	assert.match(board.confirmations[0], /dependency-ready/);

	// Cancellation still uses confirmation, attribution, and the accepted revision.
	board.nodes.get("#cancel-plan-button").click();
	assert.deepEqual(posted(board.requests[4]), {
		action: "cancel", revision: 2, requestId: "cancel-request",
		reason: "  tester  ", requestedBy: "tester", confirmed: true,
	});
	await board.respond(4, { action: "cancel" });
	await board.respond(5, snapshot(3, { approved: true }));
	assert.equal(board.nodes.get("#plan-title").textContent, "Revision 3");
});

test("a delayed action cannot replace a newer read even if it includes an obsolete snapshot", async () => {
	const board = await browser();
	await board.respond(0, snapshot(1));
	board.nodes.get("#approve-button").click();
	board.change();
	await board.respond(2, snapshot(3, { approved: true }));
	await board.respond(1, snapshot(2));
	assert.equal(board.nodes.get("#plan-title").textContent, "Revision 3");
	assert.equal(board.nodes.get("#approve-button").hidden, true);
	assert.equal(board.requests[3].url, "api/plan");
	await board.respond(3, snapshot(3, { approved: true }));
});

test("controls map only supported semantic actions, not raw statuses or recovery guidance", async () => {
	const board = await browser();
	const state = snapshot(1);
	state.projection.actions = [
		{ kind: "approve-correction", taskIds: ["T-001"] },
		{ kind: "reserve-task", taskId: "T-001" },
		{ kind: "resolve-stale-reservation", taskId: "T-001" },
	];
	await board.respond(0, state);
	assert.equal(board.nodes.get("#approve-button").hidden, true);
	assert.deepEqual(buttons(board.nodes.get("#tasks")), []);
	await board.nodes.get("#approve-button").click();
	assert.equal(board.requests.length, 1);

	// Deliberately keep the raw status unchanged: projection owns eligibility.
	state.projection.actions = [{ kind: "approve-completion" }, { kind: "retry-task", taskId: "T-002" }];
	board.change();
	await board.respond(1, state);
	assert.equal(board.nodes.get("#approve-button").textContent, "Approve completion");
	board.nodes.get("#approve-button").click();
	assert.match(board.confirmations[0], /entire plan as complete/);
	assert.deepEqual(posted(board.requests[2]), {
		action: "approve", revision: 1, approvalType: "completion", approvedBy: "tester", confirmed: true,
	});
	board.requests[2].reply({
		ok: false, error: { code: "revision_conflict", message: "Revision changed; refresh and retry" },
	}, 409);
	await flush();
	assert.match(board.nodes.get("#error").textContent, /Revision changed; refresh and retry/);
	await board.respond(3, state);
	assert.match(board.nodes.get("#error").textContent, /Revision changed; refresh and retry/);
	const [retry] = buttons(board.nodes.get("#tasks"));
	assert.equal(retry.textContent, "Retry");
	retry.click();
	assert.equal(board.confirmations[1], "Retry T-002 with a fresh attempt?");
	assert.deepEqual(posted(board.requests[4]), {
		action: "retry", taskId: "T-002", revision: 1, confirmed: true,
	});
	await board.respond(4, { action: "retry" });
	await board.respond(5, snapshot(2, { approved: true }));
	assert.deepEqual(buttons(board.nodes.get("#tasks")), []);
	assert.equal(board.nodes.get("#error").textContent, "");
});

test("failed native settlements and follow-up read errors remain visible without applying snapshots", async () => {
	const board = await browser();
	await board.respond(0, workflowSnapshot(1));
	const host = board.nodes.get("#workflows");
	buttons(host)[0].click();
	await board.respond(1, {
		action: "resume-workflow", runId: "research-run", status: "error", error: "Native execution failed",
	});
	assert.match(host.textContent, /Native execution failed/);
	board.requests[2].reply({ ok: false, error: { message: "Observation unavailable" } }, 500);
	await flush();
	assert.match(board.nodes.get("#error").textContent, /Observation unavailable/);
	assert.match(host.textContent, /Native execution failed/);
	board.change();
	await board.respond(3, workflowSnapshot(2));
	assert.match(host.textContent, /Native execution failed/);
	assert.equal(board.nodes.get("#error").textContent, "");
});

test("approval still requires an actor and confirmation", async () => {
	const board = await browser();
	await board.respond(0, snapshot(1));
	board.window.prompt = () => "  ";
	await board.nodes.get("#approve-button").click();
	assert.equal(board.requests.length, 1);
	board.window.prompt = () => "tester";
	board.window.confirm = () => false;
	await board.nodes.get("#approve-button").click();
	assert.equal(board.requests.length, 1);
});
