import { FoundryWire } from "./contracts.mjs";
/** Error returned by a failed loopback API envelope. */
class FoundryRequestError extends Error {
	/**
	 * @param {string} message
	 * @param {string | undefined} code
	 */
	constructor(message, code) {
		super(message);
		this.name = "FoundryRequestError";
		this.code = code;
	}
}

/**
 * Calls a loopback API endpoint and unwraps the Foundry response envelope.
 *
 * @param {string} path
 * @param {RequestInit} [options]
 * @returns {Promise<unknown>}
 * @throws {Error} When the server returns a failed Foundry envelope.
 */
async function request(path, options) {
	const response = await fetch(path, options);
	const payload = FoundryWire.record(await response.json());
	if (!response.ok || payload.ok !== true) {
		const error = payload.error && typeof payload.error === "object" ? FoundryWire.record(payload.error) : {};
		throw new FoundryRequestError(
			typeof error.message === "string" ? error.message : `Request failed with ${response.status}`,
			typeof error.code === "string" ? error.code : undefined,
		);
	}
	return payload.value;
}

export async function readSnapshot() {
	return FoundryWire.snapshot(await request("api/plan"));
}

/** @param {string} runId @param {number} [beforeSeq] */
export async function readWorkflowDetail(runId, beforeSeq) {
	const query = new URLSearchParams({ runId });
	if (beforeSeq !== undefined) query.set("beforeSeq", String(beforeSeq));
	return FoundryWire.workflowDetail(await request(`api/workflow?${query}`));
}

export { request };
