import { digest, fail, record, text } from "./values.mjs";

/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {Parameters<import("@github/copilot-sdk").CopilotSession["rpc"]["eventLog"]["read"]>[0]} Page */
/** @param {{type?:unknown,agentId?:unknown,data?:unknown}} event */
export function refusedCall(event) {
	const d = record(event.data);
	if (event.agentId || d.agentId || d.parentToolCallId || typeof d.toolCallId !== "string")
		return;
	if (event.type === "permission.completed" && String(record(d.result).kind).startsWith("denied-") ||
		event.type === "tool.execution_complete" && d.success === false &&
		["denied", "rejected", "permission_denied"].includes(String(record(d.error ?? {}).code).toLowerCase()))
		return d.toolCallId;
}

/** Recover only the issuing session's original top-level call, never a similarly named worker.
 * @param {(page:Page)=>Promise<{events:unknown[],cursor:string,cursorStatus:string,hasMore:boolean}>} read @param {Effect} effect */
export async function recover(read, effect) {
	if (!effect.callId)
		fail("receipt_unavailable", "No original native call identity");
	let cursor, start, end, denied = false;
	const cursors = new Set();
	for (;;) {
		const page = await read({
			cursor, direction: "backward", view: "history", agentScope: "primary", includeEphemeral: false,
			types: ["tool.execution_start", "tool.execution_complete", "permission.completed"], max: 256
		});
		if (page.cursorStatus !== "ok")
			fail("receipt_unavailable", "Original native history is no longer available");
		for (const value of page.events) {
			const e = record(value), d = record(e.data);
			if (e.agentId || d.agentId || d.parentToolCallId || d.toolCallId !== effect.callId)
				continue;
			if (refusedCall(e) === effect.callId)
				denied = true;
			if (e.type === "tool.execution_start") {
				if (start && start.id !== e.id)
					fail("ambiguous_receipt", "Ambiguous native start");
				start = e;
			}
			if (e.type === "tool.execution_complete") {
				if (end && end.id !== e.id)
					fail("ambiguous_receipt", "Ambiguous native completion");
				end = e;
			}
		}
		if (start && (end || denied)) {
			const a = record(start.data), b = end && record(end.data);
			if (!start.id || !a.turnId || end && (!end.id || a.turnId !== b?.turnId) || text(a.toolName, "native tool").split(".").at(-1) !== effect.tool ||
				digest(a.arguments) !== digest(effect.args))
				fail("native_receipt_mismatch", "No matching original native completion");
			if (denied) {
				if (b?.success === true) fail("ambiguous_receipt", "Conflicting native permission and completion receipts");
				return { resultType: "denied" };
			}
			if (b?.success === true) {
				const result = record(b.result);
				return { resultType: "success", structuredContent: result.structuredContent, textResultForLlm: result.content };
			}
		}
		if (!page.hasMore || cursors.has(page.cursor))
			fail("receipt_unavailable", "Original call is not confirmed; it will not be replayed");
		cursors.add(page.cursor);
		cursor = page.cursor;
	}
}
