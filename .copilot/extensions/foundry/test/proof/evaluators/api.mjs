import assert from "node:assert/strict";

/** @param {(policy: import("../types.js").AdmissionPolicy<unknown, unknown>) => import("../types.js").AdmissionPolicy<unknown, unknown>} createAdmissionApi */
export function evaluateApi(createAdmissionApi) {
	const requests = Object.freeze([{ id: "request" }]);
	const sentinel = Object.freeze({ result: Symbol("policy-result") });
	/** @type {Array<{tasks: unknown, capacity: number}>} */
	const calls = [];
	const policy = Object.freeze({
		/** @param {unknown} tasks @param {number} capacity */
		schedule(tasks, capacity) {
			assert.equal(this, policy);
			calls.push({ tasks, capacity });
			return sentinel;
		},
	});
	const api = createAdmissionApi(policy);
	assert.equal(api.schedule(requests, 3), sentinel);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].tasks, requests);
	assert.equal(calls[0].capacity, 3);
	return { evaluationId: "api-delegation", outcome: "passed", detail: "Policy authority, request identity, and result identity are conserved" };
}
