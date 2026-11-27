import { indexBudgetError } from "./pages.mjs";
import { digest, fail, record, text } from "./values.mjs";

/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {Parameters<import("@github/copilot-sdk").CopilotSession["rpc"]["eventLog"]["read"]>[0]} Page */
/** @typedef {import("@github/copilot-sdk").CopilotSession["rpc"]["eventLog"]["read"]} Reader */
/** @param {Reader} read @param {NonNullable<Page["types"]>} types */
export async function* history(read, types) {
	const seen = new Set();
	let cursor;
	for (;;) {
		const page = await read({ view: "history", direction: "forward", includeEphemeral: false, agentScope: "primary", types, cursor, max: 256 });
		if (page.cursorStatus !== "ok") fail("missing_history", "Original native history is unavailable");
		for (const event of page.events) {
			const d = record(event.data);
			if (!event.agentId && !event.checkpoint && !d.agentId && !d.parentToolCallId) yield event;
		}
		if (!page.hasMore) return;
		if (seen.has(page.cursor)) fail("missing_history", "Original native history cursor did not advance");
		seen.add(page.cursor); cursor = page.cursor;
	}
}
/** Workflow agents soft-fail to null. Recover only this direct call's native failure,
 * never a sibling's error or an inference from an empty structured response.
 * @param {import("@github/copilot-sdk").CopilotSession} session @param {string} id @param {string} label */
export async function scoutFailure(session, id, label) {
	const detail = await session.workflow.getRunDetail(id);
	if (detail.runId !== id || detail.workflowName !== "foundry-scout") return;
	const agents = detail.agents.filter(a => a.runId === id && a.label === label);
	if (agents.length !== 1 || !agents[0].toolCallId) return;
	const call = agents[0].toolCallId, seen = new Set();
	let cursor;
	for (;;) {
		const page = await session.rpc.eventLog.read({ direction: "backward", cursor, types: ["subagent.failed"],
			view: "history", includeEphemeral: false, agentScope: "primary" });
		if (page.cursorStatus !== "ok") return;
		for (const e of page.events.toReversed()) if (e.type === "subagent.failed" && e.data.toolCallId === call) return e.data.error;
		if (!page.hasMore || seen.has(page.cursor)) return;
		cursor = page.cursor; seen.add(cursor);
	}
}

/** A null result alone cannot distinguish a refusal from input too large for
 * the model. Legacy ledgers have only the generic missing-report diagnostic.
 * @param {import("@github/copilot-sdk").CopilotSession} session @param {import("./model.js").Review} review */
export async function confirmNoReport(session, review) {
	const id = text(review.workflowId, "bound workflow");
	const [run, detail] = await Promise.all([session.workflow.getRun(id), session.workflow.getRunDetail(id)]);
	if (run.runId !== id || detail.runId !== id || detail.workflowName !== "foundry-scout" ||
		run.status !== "completed" || detail.status !== "completed" || run.failure)
		fail("not_terminal", "The original scout workflow has no successful terminal envelope");
	const result = record(run.result), label = `scout:${review.squad}:${review.id}@${review.base}`;
	if (review.error === indexBudgetError) {
		if (!Array.isArray(detail.agents) || detail.agents.length || result.reported !== 0 || !Array.isArray(result.failed) || result.failed.length)
			fail("not_recoverable", "The original workflow did not confirm a zero-agent batch");
		return;
	}
	const agents = detail.agents.filter(a => a.runId === id && a.label === label);
	if (!Number.isSafeInteger(result.reported) || Number(result.reported) < 0 || !Array.isArray(result.failed) ||
		result.failed.filter(key => key === review.id).length !== 1 || agents.length !== 1 || agents[0].status !== "failed" || !agents[0].toolCallId ||
		detail.agents.filter(a => a.toolCallId === agents[0].toolCallId).length !== 1)
		fail("missing_report_evidence", "The terminal result and direct failed scout do not identify this exact no-report review");
	const call = agents[0].toolCallId, seen = new Set();
	let cursor, diagnostic;
	for (;;) {
		const page = await session.rpc.eventLog.read({ direction: "backward", cursor, view: "history", includeEphemeral: false,
			types: ["subagent.failed", "subagent.completed", "permission.completed", "tool.execution_complete"], agentScope: "primary" });
		if (page.cursorStatus !== "ok") fail("missing_history", "Original scout history is unavailable");
		for (const ev of page.events) {
			if (ev.type === "subagent.failed" && ev.data.toolCallId === call) {
				if (diagnostic || ev.data.totalToolCalls !== 0 || ev.agentId && ev.agentId !== agents[0].agentId ||
					!/^Request exceeds the model's prompt budget after reserving output \(\d+ tokens; limit \d+\)\. Reduce context or compact before continuing\.$/.test(ev.data.error))
					fail("not_recoverable", "Not a unique pre-tool prompt-budget failure");
				diagnostic = ev.data.error;
			} else if (ev.type === "subagent.completed" && ev.data.toolCallId === call || refusedCall(ev) === call)
				fail("conflicting_receipt", "Conflicting scout completion or refusal");
		}
		if (!page.hasMore) break;
		if (seen.has(page.cursor)) fail("missing_history", "Original scout history cursor did not advance");
		seen.add(page.cursor); cursor = page.cursor;
	}
	if (!diagnostic || review.error !== "Invalid scout result: No structured scout report was returned" &&
		review.error !== `Invalid scout result: ${diagnostic}`)
		fail("missing_report_evidence", "No matching recoverable no-report diagnostic in native history and ledger");
}
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

/** @typedef {(page:Page)=>Promise<{events:unknown[],cursor:string,cursorStatus:string,hasMore:boolean}>} HistoryPage */
/** @typedef {{effect:Effect,start?:Record<string,unknown>,end?:Record<string,unknown>,denied?:boolean,error?:Error}} Trace */
/** Keep one backward scan per sampled issuer, not one copy of every (potentially large) SDK page per call.
 * Match only original top-level IDs. Each trace closes at its own issuing turn boundary.
 * @param {HistoryPage} read @param {Effect[]} effects @param {(e:Effect,result:unknown)=>void} publish */
export async function recoveredCalls(read,effects,publish) {
	/** @type {Map<string,Trace>} */ const active=new Map();
	for(const e of effects){
		if(!e.callId || active.has(e.callId))fail("receipt_unavailable","Expected unique original native call identities");
		active.set(e.callId,{effect:e});
	}
	let cursor;
	const cursors = new Set();
	/** @param {string} id @param {Trace} t */
	const finish=(id,t)=>{
		active.delete(id);
		let value;
		try{if(t.error)fail("ambiguous_receipt",t.error.message);value=matched(t);}
		catch(e){value=e;}
		publish(t.effect,value);
	};
	try{while(active.size){
		const page = await read({
			cursor, direction: "backward", view: "history", agentScope: "primary", includeEphemeral: false,
			types: ["assistant.turn_start", "tool.execution_start", "tool.execution_complete", "permission.completed"], max: 256
		});
		if (page.cursorStatus !== "ok")
			fail("receipt_unavailable", "Original native history is no longer available");
		// Backward pages arrive newest first, but each page is in chronological order.
		for(let i=page.events.length-1;i>=0;i--){
			const value=page.events[i];
			const e = record(value), d = record(e.data);
			if (e.agentId || d.agentId || d.parentToolCallId) continue;
			if(e.type==="assistant.turn_start"){
				for(const [id,t] of active)if(t.start && d.turnId===record(t.start.data).turnId)finish(id,t);
				continue;
			}
			const t=typeof d.toolCallId==="string" && active.get(d.toolCallId);if(!t)continue;
			if(refusedCall(e)===d.toolCallId)t.denied=true;
			if (e.type === "tool.execution_start") {
				if(t.start && t.start.id!==e.id)t.error=new Error("Ambiguous native start");
				t.start=e;
			}
			if (e.type === "tool.execution_complete") {
				if(t.start || t.end && t.end.id!==e.id)t.error=new Error("Conflicting or out-of-order native completion");
				t.end=e;
			}
		}
		if (!page.hasMore || !active.size) break;
		if (cursors.has(page.cursor))
			fail("receipt_unavailable", "Original native history cursor did not advance");
		cursors.add(page.cursor);
		cursor = page.cursor;
	}}catch(e){for(const t of active.values())publish(t.effect,e);return;}
	for(const [id,t] of active)finish(id,t);
}
/** @param {Trace} trace */
function matched({effect,start,end,denied}){
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
			if (effect.tool === "bash") return { resultType: "success", toolTelemetry: b.toolTelemetry };
			const result = record(b.result);
			return { resultType: "success", structuredContent: result.structuredContent, textResultForLlm: result.content };
		}
	}
	fail("receipt_unavailable", "Original call is not confirmed; it will not be replayed");
}

/** @param {HistoryPage} read @param {Effect} effect */
export async function recover(read,effect){
	/** @type {unknown} */let result;
	await recoveredCalls(read,[effect],(_,value)=>{result=value;});
	if(result instanceof Error)throw result;
	return /** @type {ReturnType<typeof matched>} */(result);
}
