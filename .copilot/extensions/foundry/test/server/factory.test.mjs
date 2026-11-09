import assert from "node:assert/strict";
import test from "node:test";
import { readString } from "../../data.mjs";
import { startServer } from "../../server.mjs";
import { jsonField, jsonResponse, must } from "../assertions.mjs";
import { fixture, nativeUi, poster, prepareBoardCandidate } from "./fixture.mjs";

test("repository-only board inspects real authority without a plan, native ownership, or writable actions", async () => {
	const current = await fixture();
	const board = await startServer({
		instanceId: "factory-only", repositoryPath: current.workspacePath, workspacePath: current.workspacePath,
		operations: { ...current.operations, getStatus: async () => assert.fail("Repository inspection must not require a plan or native run") },
		subscribe: () => () => { },
	});
	try {
		const response = await jsonResponse(await fetch(new URL("api/plan", board.url)));
		assert.equal(jsonField(response, "value", "plan"), null);
		assert.equal(jsonField(response, "value", "projection"), null);
		assert.equal(jsonField(response, "value", "factory", "units", 0, "id"), "board");
		assert.equal(jsonField(response, "value", "interactions", "readOnly"), true);
		assert.match(readString(jsonField(response, "value", "bindingId")), /^factory-/);
		assert.equal((await fetch(new URL("api/action", board.url), { method: "POST" })).status, 403);
		assert.equal((await fetch(new URL("api/workflow?runId=foreign", board.url))).status, 400);
		assert.deepEqual(current.workflowCalls, []);
	} finally { await board.close(); await current.close(); }
});

test("canvas candidate decisions enforce factory assurance and retain native attribution", async () => {
	const current = await fixture({
		getUi: () => nativeUi({
			elicitation: async () => ({ action: "accept", content: { actor: "native-reviewer", reason: "Insufficient evidence; retain the incumbent" } }),
		})
	});
	try {
		const service = prepareBoardCandidate(current);
		const post = await poster(current);
		const intent = {
			action: "decide-candidate", revision: current.plan.revision, factoryRevision: service.snapshot().revision,
			candidateId: "board-candidate", expectedIncumbentId: null, decision: "accept", actor: "forged-browser", reason: "ignore gaps",
		};
		const rejected = await post(intent);
		assert.equal(rejected.status, 400);
		assert.equal(jsonField(await jsonResponse(rejected), "error", "code"), "factory_assurance_incomplete");
		const accepted = await post({ ...intent, decision: "reject" });
		assert.equal(accepted.status, 200);
		const response = await jsonResponse(accepted);
		assert.equal(jsonField(response, "value", "plan"), undefined, "Mutations acknowledge, never compete with the GET queue");
		const decision = must(service.snapshot().decisions.at(-1));
		assert.equal(decision.actor, "native-reviewer");
		assert.equal(decision.reason, "Insufficient evidence; retain the incumbent");
		assert.equal((await current.operations.getPlan({ planId: current.plan.id })).status, "awaiting-approval");
	} finally { await current.close(); }
});

test("canvas rejects a repository revision changed during a native candidate decision", async () => {
	let duringDecision = () => { };
	const current = await fixture({
		getUi: () => nativeUi({
			elicitation: async () => {
				duringDecision();
				return { action: "accept", content: { actor: "reviewer", reason: "Reject" } };
			},
		})
	});
	try {
		const service = prepareBoardCandidate(current);
		const revision = service.snapshot().revision;
		duringDecision = () => service.appendKnowledge({
			expectedRevision: revision, id: "concurrent-discovery", unitId: "board", kind: "observation",
			statement: "New information arrived", source: { kind: "discovery", ref: "fixture:new", actor: "observer", at: new Date().toISOString() },
		});
		const post = await poster(current);
		const response = await post({
			action: "decide-candidate", revision: current.plan.revision, factoryRevision: revision,
			candidateId: "board-candidate", expectedIncumbentId: null, decision: "reject",
		});
		assert.equal(response.status, 409);
		assert.equal(jsonField(await jsonResponse(response), "error", "code"), "revision_conflict");
		assert.equal(service.snapshot().decisions.some((entry) => entry.kind !== "accept-contract" && entry.candidateId === "board-candidate"), false);
	} finally { await current.close(); }
});
