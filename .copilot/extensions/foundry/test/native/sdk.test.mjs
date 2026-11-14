import assert from "node:assert/strict";
import test from "node:test";
import { readString } from "../../data.mjs";
import { LIMITS } from "../../plan/values.mjs";
import { jsonField, jsonResponse } from "../assertions.mjs";
import { fixture, nativeUi, poster, prepareBoardCandidate } from "../server/fixture.mjs";

/** @param {string} field @returns {Array<import("@github/copilot-sdk").ElicitationResult["content"]>} */
function invalidContents(field) {
	return [
		undefined,
		{},
		{ [field]: undefined },
		{ [field]: "" },
		{ [field]: " \t " },
		{ [field]: "x".repeat(LIMITS.actor + 1) },
		{ [field]: 1 },
		{ [field]: true },
		{ [field]: ["owner"] },
	];
}

test("SDK fixture approval rejects absent, undefined and malformed identities, then accepts a valid native actor", async () => {
	/** @type {import("@github/copilot-sdk").ElicitationResult} */
	let result = { action: "accept" };
	/** @type {import("@github/copilot-sdk").ElicitationParams[]} */
	const prompts = [];
	const current = await fixture({
		getUi: () => nativeUi({ elicitation: async (input) => { prompts.push(input); return result; } }),
	});
	try {
		const post = await poster(current);
		const body = {
			action: "approve", approvalType: "plan", revision: current.plan.revision,
			confirmed: true, approvedBy: "untrusted-renderer",
		};
		for (const content of invalidContents("approvedBy")) {
			result = content === undefined ? { action: "accept" } : { action: "accept", content };
			const response = await post(body);
			assert.equal(response.status, 400);
			assert.match(readString(jsonField(await jsonResponse(response), "error", "message")), /approvedBy must be a non-empty string/);
			assert.deepEqual(await current.operations.getPlan({ planId: current.plan.id }), current.plan);
		}
		result = { action: "accept", content: { approvedBy: "  native-user  ", optional: undefined } };
		const response = await post(body);
		assert.equal(response.status, 200);
		assert.deepEqual(await jsonResponse(response), { ok: true, value: { action: "approve" } });
		const saved = await current.operations.getPlan({ planId: current.plan.id });
		assert.equal(saved.gates.planApprovedBy, "native-user");
		assert.equal(saved.revision, current.plan.revision + 1);
		for (const prompt of prompts) assert.deepEqual(prompt.requestedSchema.required, ["approvedBy"]);
	} finally {
		await current.close();
	}
});

test("SDK fixture decline and cancel cannot manufacture approval from native or renderer fields", async () => {
	/** @type {import("@github/copilot-sdk").ElicitationResult} */
	let result = { action: "decline" };
	const current = await fixture({ getUi: () => nativeUi({ elicitation: async () => result }) });
	try {
		const post = await poster(current);
		for (const action of /** @type {const} */ (["decline", "cancel"])) {
			result = { action, content: { approvedBy: "ignored-native-actor" } };
			const response = await post({
				action: "approve", approvalType: "plan", revision: current.plan.revision,
				confirmed: true, approvedBy: "untrusted-renderer",
			});
			assert.equal(response.status, 200);
			assert.deepEqual(await jsonResponse(response), { ok: true, cancelled: true });
			assert.deepEqual(await current.operations.getPlan({ planId: current.plan.id }), current.plan);
		}
	} finally {
		await current.close();
	}
});

test("SDK fixture cancellation validates the native requester without a renderer fallback", async () => {
	/** @type {import("@github/copilot-sdk").ElicitationResult} */
	let result = { action: "accept" };
	const current = await fixture({ getUi: () => nativeUi({ elicitation: async () => result }) });
	try {
		const post = await poster(current);
		const body = {
			action: "cancel", revision: current.plan.revision, requestId: "sdk-cancel",
			confirmed: true, requestedBy: "untrusted-renderer", reason: "Untrusted reason",
		};
		for (const content of invalidContents("requestedBy")) {
			result = content === undefined ? { action: "accept" }
				: { action: "accept", content: { ...content, reason: "Native reason" } };
			const response = await post(body);
			assert.equal(response.status, 400);
			assert.match(readString(jsonField(await jsonResponse(response), "error", "message")), /requestedBy must be a non-empty string/);
			assert.deepEqual(await current.operations.getPlan({ planId: current.plan.id }), current.plan);
		}
		result = { action: "accept", content: { requestedBy: " native-requester ", reason: "Native reason" } };
		const response = await post(body);
		assert.equal(response.status, 200);
		assert.deepEqual(await jsonResponse(response), { ok: true, value: { action: "cancel" } });
		const saved = await current.operations.getPlan({ planId: current.plan.id });
		assert.equal(saved.cancellation?.requestedBy, "native-requester");
		assert.equal(saved.cancellation?.reason, "Native reason");
	} finally {
		await current.close();
	}
});

test("SDK fixture candidate decisions require a valid native actor before repository mutation", async () => {
	/** @type {import("@github/copilot-sdk").ElicitationResult} */
	let result = { action: "accept" };
	const current = await fixture({ getUi: () => nativeUi({ elicitation: async () => result }) });
	try {
		const factory = prepareBoardCandidate(current);
		const original = factory.snapshot();
		const post = await poster(current);
		const body = {
			action: "decide-candidate", candidateId: "board-candidate", decision: "reject",
			expectedIncumbentId: null,
			revision: current.plan.revision, factoryRevision: original.revision,
			confirmed: true, actor: "untrusted-renderer", reason: "Untrusted reason",
		};
		for (const content of invalidContents("actor")) {
			result = content === undefined ? { action: "accept" }
				: { action: "accept", content: { ...content, reason: "Native rejection" } };
			const response = await post(body);
			assert.equal(response.status, 400);
			assert.match(readString(jsonField(await jsonResponse(response), "error", "message")), /actor must be a non-empty string/);
			assert.deepEqual(factory.snapshot(), original);
		}
		result = { action: "accept", content: { actor: " native-reviewer ", reason: "Native rejection" } };
		const response = await post(body);
		assert.equal(response.status, 200);
		assert.deepEqual(await jsonResponse(response), { ok: true, value: { action: "decide-candidate" } });
		const saved = factory.snapshot();
		assert.equal(saved.revision, original.revision + 1);
		const decision = saved.decisions.at(-1);
		assert.ok(decision);
		assert.equal(decision.kind, "reject-candidate");
		assert.equal(decision.actor, "native-reviewer");
		assert.equal(decision.reason, "Native rejection");
	} finally {
		await current.close();
	}
});
