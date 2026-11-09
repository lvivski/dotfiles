import assert from "node:assert/strict";
import test from "node:test";
import { must } from "../assertions.mjs";
import { browser, buttons, disclosures, flush, posted } from "./browser.mjs";
import { snapshot, workflowDetail, workflowSnapshot } from "./fixture.mjs";

test("native budgets use credits and active time without hiding excess or missing data", async () => {
	const board = await browser();
	await board.respond(0, workflowSnapshot(1));
	const host = board.nodes.get("#workflows");
	assert.match(host.textContent, /AI credits: 2.5 \/ 2 \(limit exceeded\)/);
	assert.match(host.textContent, /Active time: 1m 1s \/ 2m 0s/);
	assert.match(host.textContent, /Concurrency limit: 5/);
	const unknown = workflowSnapshot(2);
	const run = unknown.workflows.runs[0];
	const incomplete = {
		...unknown, workflows: {
			...unknown.workflows, runs: [{
				...run, consumed: undefined, approved: null,
				terminal: { ...run.terminal, failure: { type: "workflow_accounting_incomplete" } },
			}]
		},
	};
	board.change();
	await board.respond(1, incomplete);
	assert.match(host.textContent, /AI credits: Unavailable \/ not yet approved/);
	assert.match(host.textContent, /Usage accounting is incomplete/);
	assert.doesNotMatch(host.textContent, /AI credits: 0/);
	const unbounded = workflowSnapshot(3);
	board.change();
	await board.respond(2, {
		...unbounded, workflows: { ...unbounded.workflows, runs: [{ ...unbounded.workflows.runs[0], approved: {} }] },
	});
	assert.match(host.textContent, /AI credits: 2.5 \/ unbounded/);
	assert.match(host.textContent, /Concurrency limit: Unbounded/);
	disclosures(host)[0].toggle(true);
	const detail = { ...workflowDetail(unbounded), approved: {} };
	detail.declaredLimits.maxAiCredits = 10;
	await board.respond(3, detail);
	assert.match(host.textContent, /Declared limitsAI credits: 10Active time: 2m 0sAdmissions: 5Concurrency limit: 5/);
	assert.doesNotMatch(host.textContent, /maxAiCredits/);
});

test("equal-revision observations advance without letting delayed responses roll back live data", async () => {
	const board = await browser();
	const newer = workflowSnapshot(4);
	newer.workflows.runs[0].observedAt = 9000;
	newer.workflows.runs[0].liveAgentCount = 3;
	await board.respond(0, newer);
	const older = workflowSnapshot(4);
	older.workflows.runs[0].observedAt = 1000;
	board.change();
	await board.respond(1, older);
	assert.match(board.nodes.get("#workflows").textContent, /Live agents \(direct\): 3/);
	newer.workflows.runs[0].observedAt = 10000;
	newer.workflows.runs[0].liveAgentCount = 4;
	board.change();
	await board.respond(2, newer);
	assert.match(board.nodes.get("#workflows").textContent, /Live agents \(direct\): 4/);
});

test("expanded diagnostics load lazily and retain their disclosure, controls, and historical page", async () => {
	const board = await browser();
	const initial = workflowSnapshot(1);
	await board.respond(0, initial);
	assert.equal(board.requests.length, 1);
	const host = board.nodes.get("#workflows");
	const disclosure = disclosures(host)[0];
	const resume = buttons(host)[0];
	disclosure.toggle(true);
	assert.equal(board.requests[1].url, "api/workflow?runId=research-run");
	await board.respond(1, workflowDetail(initial));
	assert.match(host.textContent, /resolved-model/);
	assert.match(host.textContent, /Requested model: auto/);
	assert.match(host.textContent, /Reading sources/);
	const progress = must(disclosure.children.find((node) => node.tagName === "pre"));
	progress.scrollTop = 42;
	resume.focus();

	const next = workflowSnapshot(2);
	board.change();
	await board.respond(2, next);
	assert.equal(disclosures(host)[0], disclosure);
	assert.equal(disclosure.open, true);
	assert.equal(buttons(host)[0], resume);
	assert.equal(board.document.activeElement, resume);
	assert.equal(board.requests[3].url, "api/workflow?runId=research-run");
	await board.respond(3, workflowDetail(next));
	assert.equal(progress.scrollTop, 42);
	must(buttons(host).find((button) => button.textContent === "Older progress")).click();
	assert.equal(board.requests[4].url, "api/workflow?runId=research-run&beforeSeq=10");
	const oldPage = workflowDetail(next);
	oldPage.progress = {
		...oldPage.progress,
		records: [{ ...oldPage.progress.records[0], seq: 9, text: "Older scope" }],
		oldestSeq: 9, newestSeq: 9, hasMoreOlder: false, hasMoreNewer: true,
	};
	await board.respond(4, oldPage);
	assert.equal(progress.scrollTop, 0);
	assert.match(host.textContent, /Older scope/);
	board.change();
	await board.respond(5, next);
	await board.respond(6, workflowDetail(next));
	assert.match(host.textContent, /Older scope/);
	assert.doesNotMatch(host.textContent, /Prepared scope: <unsafe-markup>/);
	must(buttons(host).find((button) => button.textContent === "Latest progress")).click();
	await board.respond(7, workflowDetail(next));
	assert.match(host.textContent, /Prepared scope: <unsafe-markup>/);
	disclosure.toggle(false);
	board.change();
	await board.respond(8, next);
	assert.equal(board.requests.length, 9);
});

test("detail failures stay explicit without removing workflow controls", async () => {
	const board = await browser();
	await board.respond(0, workflowSnapshot(1));
	const host = board.nodes.get("#workflows");
	disclosures(host)[0].toggle(true);
	board.requests[1].reply({ ok: false, error: { message: "Native storage unavailable" } }, 400);
	await flush();
	assert.match(host.textContent, /Native storage unavailable.*retry/);
	assert.equal(buttons(host)[0].textContent, "Resume");
});

test("one live refresh timer stops when hidden, inactive, or closed", async () => {
	const board = await browser();
	await board.respond(0, workflowSnapshot(1, "running"));
	assert.equal(board.timers.size, 1);
	assert.equal([...board.timers.values()][0].delay, 10000);
	const tick = board.tick();
	assert.equal(board.requests[1].url, "api/plan");
	await board.respond(1, workflowSnapshot(2, "running"));
	await tick;
	assert.equal(board.timers.size, 1);
	board.setHidden(true);
	assert.equal(board.timers.size, 0);
	board.setHidden(false);
	assert.equal(board.requests[2].url, "api/plan");
	await board.respond(2, workflowSnapshot(3));
	assert.equal(board.timers.size, 0);
	board.change();
	await board.respond(3, workflowSnapshot(4, "running"));
	assert.equal(board.timers.size, 1);
	board.hidePage();
	assert.equal(board.timers.size, 0);
	assert.equal(board.events.closeCount, 1);
	board.change();
	assert.equal(board.requests.length, 4);
	board.showPage();
	assert.equal(board.requests[4].url, "api/plan");
	await board.respond(4, workflowSnapshot(5, "running"));
	assert.equal(board.timers.size, 1);
});

test("one read queue serializes detail and plan invalidations without regressing observations", async () => {
	const board = await browser();
	const state = workflowSnapshot(4);
	await board.respond(0, state);
	const host = board.nodes.get("#workflows");
	disclosures(host)[0].toggle(true);
	board.change();
	board.change();
	assert.equal(board.requests.length, 2);
	const newest = workflowDetail(state);
	newest.observedAt = 9000;
	newest.agents[0].resolvedModel = "newer-model";
	newest.progress = {
		...newest.progress, records: [{ ...newest.progress.records[0], text: "Newest progress observation" }],
	};
	await board.respond(1, newest);
	assert.equal(board.requests[2].url, "api/plan");
	board.change();
	board.change();
	await board.respond(2, state);
	assert.equal(board.requests[3].url, "api/plan");
	await board.respond(3, state);
	assert.equal(board.requests.length, 5);
	assert.equal(board.requests[4].url, "api/workflow?runId=research-run");
	await board.respond(4, workflowDetail(state));
	assert.equal(board.requests.length, 5);
	assert.match(host.textContent, /newer-model/);
	assert.match(host.textContent, /Newest progress observation/);
});

test("native lifecycle changes transfer keyboard focus to the replacement control", async () => {
	const board = await browser();
	await board.respond(0, workflowSnapshot(1));
	const host = board.nodes.get("#workflows");
	buttons(host)[0].focus();
	board.change();
	await board.respond(1, workflowSnapshot(2, "running"));
	const pause = buttons(host)[0];
	assert.equal(pause.textContent, "Pause");
	assert.equal(board.document.activeElement === pause, true, "Focus should follow the replacement control");
	const terminal = workflowSnapshot(3);
	terminal.workflows.runs[0].actions = [];
	board.change();
	await board.respond(2, terminal);
	assert.equal(board.document.activeElement?.tagName, "summary");
});

test("native progress and Pause stay live while Resume awaits settlement", async () => {
	const board = await browser();
	await board.respond(0, workflowSnapshot(4));
	const host = board.nodes.get("#workflows");
	assert.match(host.textContent, /research-scope:v1/);
	assert.match(host.textContent, /Progress has not been loaded/);
	buttons(host)[0].click();
	assert.deepEqual(posted(board.requests[1]), {
		action: "resume-workflow", runId: "research-run", revision: 1, confirmed: true,
	});
	assert.match(board.confirmations[0], /existing journal and limits/);
	assert.equal(buttons(host)[0].attributes.disabled, "");
	assert.equal(buttons(host)[0].textContent, "Resuming...");
	buttons(host)[0].click();
	assert.equal(board.requests.length, 2);
	board.change();
	await board.respond(2, workflowSnapshot(5, "running"));
	assert.equal(buttons(host)[0].textContent, "Pause");
	buttons(host)[0].click();
	assert.equal(posted(board.requests[3]).action, "pause-workflow");
	await board.respond(3, { action: "pause-workflow", runId: "research-run", status: "paused" });
	await board.respond(4, workflowSnapshot(6));
	await board.respond(1, { action: "resume-workflow", runId: "research-run", status: "paused" });
	assert.match(host.textContent, /paused/);
	assert.equal(buttons(host)[0].textContent, "Resume");
	assert.equal(board.nodes.get("#approve-button").hidden, false);
	await board.respond(5, workflowSnapshot(6));
	board.ready();
	assert.equal(board.requests[6].url, "api/plan");
	await board.respond(6, workflowSnapshot(6));
});

test("workflow errors survive native events and unavailable state grants no controls", async () => {
	const board = await browser();
	await board.respond(0, workflowSnapshot(1));
	buttons(board.nodes.get("#workflows"))[0].click();
	board.requests[1].reply({ ok: false, error: { message: "Run is no longer resumable" } }, 400);
	await flush();
	assert.match(board.nodes.get("#workflows").textContent, /no longer resumable/);
	await board.respond(2, workflowSnapshot(2, "running"));
	board.change();
	await board.respond(3, workflowSnapshot(3, "running"));
	assert.match(board.nodes.get("#workflows").textContent, /no longer resumable/);
	board.nodes.get("#refresh-button").click();
	const unavailable = { ...snapshot(1), workflows: { state: "unavailable", error: "Backend offline" } };
	await board.respond(4, unavailable);
	assert.match(board.nodes.get("#workflows").textContent, /Backend offline.*Refresh/);
	assert.deepEqual(buttons(board.nodes.get("#workflows")), []);
	assert.equal(board.nodes.get("#approve-button").hidden, false);
});
