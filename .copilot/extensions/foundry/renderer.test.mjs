import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { approvePlan, createDraftPlan, transitionPlan } from "./domain.mjs";
import { projectPlan } from "./projection.mjs";

const script = await readFile(new URL("./renderer/app.js", import.meta.url), "utf8");
const template = await readFile(new URL("./renderer/index.html", import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Only the DOM operations used by app.js; no layout, selector engine, or browser dependency.
class Element {
	constructor(tag = "div") {
		this.tagName = tag;
		this.childNodes = [];
		this.hidden = false;
		this.content = "";
		this.attributes = {};
		this.listeners = new Map();
	}
	set textContent(value) { this.replaceChildren(String(value)); }
	get textContent() {
		return this.childNodes.map((child) => typeof child === "string" ? child : child.textContent).join("");
	}
	append(...children) { this.childNodes.push(...children); }
	replaceChildren(...children) { this.childNodes = children; }
	setAttribute(name, value) { this.attributes[name] = value; }
	addEventListener(name, listener) { this.listeners.set(name, listener); }
	click() { return this.listeners.get("click")?.({ currentTarget: this }); }
}

function browser(planId = "renderer-plan") {
	const elements = new Map([...template.matchAll(/id="([^"]+)"/g)]
		.map((match) => [`#${match[1]}`, new Element()]));
	for (const [name, content] of [["plan-id", planId], ["token", `token-${planId}`]]) {
		const meta = new Element("meta");
		meta.content = content;
		elements.set(`meta[name="foundry-${name}"]`, meta);
	}
	const nodes = {
		get(selector) {
			const node = elements.get(selector);
			assert.ok(node, `Missing test element ${selector}`);
			return node;
		},
	};
	nodes.get("#approve-button").hidden = true;
	nodes.get("#cancel-plan-button").hidden = true;
	const requests = [];
	const listeners = new Map();
	const confirmations = [];
	const prompts = [];
	const window = {
		prompt: (message) => { prompts.push(message); return "  tester  "; },
		confirm: (message) => { confirmations.push(message); return true; },
	};
	const events = {
		addEventListener: (name, listener) => listeners.set(name, listener),
		onerror: () => {},
	};
	runInNewContext(script, {
		HTMLElement: Element,
		HTMLMetaElement: Element,
		document: {
			querySelector: (selector) => nodes.get(selector),
			createElement: (tag) => new Element(tag),
			createTextNode: (text) => text,
		},
		window,
		crypto: { randomUUID: () => "cancel-request" },
		EventSource: class {
			constructor(url) { assert.equal(url, "/events"); return events; }
		},
		fetch: (url, options = {}) => new Promise((resolve, reject) => {
			requests.push({
				url, options, reject,
				reply: (payload, status = 200) => resolve({
					ok: status === 200, status, json: async () => structuredClone(payload),
				}),
			});
		}),
	});
	return {
		nodes, requests, window, events, confirmations, prompts,
		change: () => listeners.get("change")({ data: JSON.stringify({ planId }) }),
		async respond(index, value) {
			requests[index].reply({ ok: true, value });
			await flush();
		},
	};
}

function snapshot(revision, { id = "renderer-plan", approved = false } = {}) {
	let plan = createDraftPlan({
		id,
		title: `Revision ${revision}`,
		objective: "Exercise the real renderer",
		repository: { workingDirectory: "/tmp/renderer", baseBranch: "main" },
		tasks: [
			{
				id: "T-001", title: "Implement", kind: "implement", description: "Build",
				dependsOn: [], acceptanceCriteria: ["Works"], expectedFiles: ["src/**"],
				deliveryRequirement: "commit",
			},
			{
				id: "T-002", title: "Verify", kind: "verify", description: "Verify",
				dependsOn: ["T-001"], acceptanceCriteria: [], expectedFiles: [],
				deliveryRequirement: "commit",
			},
		],
	});
	plan = transitionPlan(plan, "awaiting-approval");
	if (approved) plan = approvePlan(plan, "tester");
	plan.revision = revision;
	return { plan, projection: projectPlan(plan) };
}

function buttons(node) {
	return node.childNodes.flatMap((child) => typeof child === "string"
		? [] : [...(child.tagName === "button" ? [child] : []), ...buttons(child)]);
}

test("a delayed GET cannot undo a newer action or restore approval controls", async () => {
	const board = browser();
	await board.respond(0, snapshot(1));
	board.nodes.get("#refresh-button").click();
	board.nodes.get("#approve-button").click();
	assert.equal(board.requests[1].url, "/api/plan");
	assert.equal(board.requests[2].url, "/api/action");
	assert.equal(board.requests[2].options.headers["x-foundry-token"], "token-renderer-plan");
	assert.deepEqual(JSON.parse(board.requests[2].options.body), {
		action: "approve", revision: 1, approvalType: "plan", approvedBy: "tester", confirmed: true,
	});
	await board.respond(2, snapshot(2, { approved: true }));
	await board.respond(1, snapshot(1));
	assert.equal(board.nodes.get("#plan-title").textContent, "Revision 2");
	assert.equal(board.nodes.get("#approve-button").hidden, true);
	assert.match(board.confirmations[0], /dependency-ready/);

	// Cancellation still uses confirmation, attribution, and the accepted revision.
	board.nodes.get("#cancel-plan-button").click();
	assert.deepEqual(JSON.parse(board.requests[3].options.body), {
		action: "cancel", revision: 2, requestId: "cancel-request",
		reason: "  tester  ", requestedBy: "tester", confirmed: true,
	});
	await board.respond(3, snapshot(3, { approved: true }));
	assert.equal(board.nodes.get("#plan-title").textContent, "Revision 3");
});

test("a delayed action cannot replace a newer refresh", async () => {
	const board = browser();
	await board.respond(0, snapshot(1));
	board.nodes.get("#approve-button").click();
	board.change();
	await board.respond(2, snapshot(3, { approved: true }));
	await board.respond(1, snapshot(2));
	assert.equal(board.nodes.get("#plan-title").textContent, "Revision 3");
	assert.equal(board.nodes.get("#approve-button").hidden, true);
});

test("refresh bursts coalesce without losing invalidations and accept equal-revision projections", async () => {
	const board = browser();
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
	const board = browser();
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
	const oldBoard = browser("old-plan");
	await oldBoard.respond(0, snapshot(9, { id: "old-plan", approved: true }));
	oldBoard.nodes.get("#refresh-button").click();
	oldBoard.change();
	const rebound = browser("new-plan");
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
	rebound.change();
	await rebound.respond(3, snapshot(2, { id: "new-plan", approved: true }));
	assert.equal(rebound.nodes.get("#plan-title").textContent, "Revision 2");
});

test("controls map only supported semantic actions, not raw statuses or recovery guidance", async () => {
	const board = browser();
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
	assert.deepEqual(JSON.parse(board.requests[2].options.body), {
		action: "approve", revision: 1, approvalType: "completion", approvedBy: "tester", confirmed: true,
	});
	board.requests[2].reply({
		ok: false, error: { code: "revision_conflict", message: "Revision changed; refresh and retry" },
	}, 409);
	await flush();
	assert.match(board.nodes.get("#error").textContent, /Revision changed; refresh and retry/);
	const [retry] = buttons(board.nodes.get("#tasks"));
	assert.equal(retry.textContent, "Retry");
	retry.click();
	assert.equal(board.confirmations[1], "Retry T-002 with a fresh attempt?");
	assert.deepEqual(JSON.parse(board.requests[3].options.body), {
		action: "retry", taskId: "T-002", revision: 1, confirmed: true,
	});
	await board.respond(3, snapshot(2, { approved: true }));
	assert.deepEqual(buttons(board.nodes.get("#tasks")), []);
	assert.equal(board.nodes.get("#error").textContent, "");
});

test("approval still requires an actor and confirmation", async () => {
	const board = browser();
	await board.respond(0, snapshot(1));
	board.window.prompt = () => "  ";
	await board.nodes.get("#approve-button").click();
	assert.equal(board.requests.length, 1);
	board.window.prompt = () => "tester";
	board.window.confirm = () => false;
	await board.nodes.get("#approve-button").click();
	assert.equal(board.requests.length, 1);
});
