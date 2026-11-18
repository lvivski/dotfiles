import { randomUUID } from "node:crypto";
import { captureCreation, observePre, prepareDispatch, toolName } from "./native.mjs";
import { FoundryError, digest, json, record, text } from "./values.mjs";

/** @typedef {ReturnType<typeof import("./store.mjs").openWorkStore>} Store */
/** @typedef {import("./model.d.ts").DispatchCall} Call */
/** @typedef {{taskId:string,code:string,message:string}} Blocker */
/** @typedef {{prepared:Call[],blocked:Blocker[]}} DispatchBatch */
/** @typedef {{taskId:string,attemptId:string,nativeId:string}} Started */
/** @typedef {DispatchBatch & {started:Started[],route:"ordinary-native-turn"|"native-pickup"}} Pickup */
/** @typedef {{effectId:string,state:"bound",nativeId:string}|{effectId:string,state:"reconciliation-required",reason:string}} CreationRecovery */
/** @param {unknown} error */
const reason = error => error instanceof Error ? error.message : String(error);

/** Ordinary hooks and extension issuance share the same durable fence. Never
 * return a call for foreground execution after an ambiguous native response.
 * @param {Store} db @param {DispatchBatch} batch @param {string} actor
 * @param {(args:import("./model.d.ts").Json,callId:string)=>Promise<unknown>} [create]
 * @param {()=>void} [disable] @returns {Promise<Pickup>} */
export async function pickupBatch(db, batch, actor, create, disable) {
	const { blocked } = batch;
	/** @type {Call[]} */ const prepared = [];
	/** @type {Started[]} */ const started = [];
	if (!create) return { ...batch, started, route: "ordinary-native-turn" };
	await Promise.all(batch.prepared.map(async call => {
		const { taskId, attemptId, effectId } = call;
		const callId = randomUUID();
		try {
			if (db.getTask(taskId).owner !== actor || db.getAttempt(attemptId).creator !== actor)
				throw new FoundryError("foreign_execution", "Automatic pickup is local to the actual accountable owner");
			observePre(db, "create_session", call.arguments, actor, callId);
			const receipt = await create(call.arguments, callId);
			const envelope = record(receipt);
			if (envelope.resultType === "failure" && envelope.error === "This session management tool is disabled"
				&& !envelope.structuredContent && !envelope.textResultForLlm) {
				disable?.();
				if (db.refuseDisabledDispatch(effectId, actor, json(receipt))) prepared.push(prepareDispatch(db, taskId, actor));
				return;
			}
			if (["denied", "rejected"].includes(String(envelope.resultType))) {
				db.rejectCreation(effectId, actor, json(receipt));
				throw new FoundryError("native_permission_refused", "Native creation was refused; a permission decision is not a retry signal");
			}
			if (envelope.resultType !== "success") throw new FoundryError("creation_identity_pending", "Native creation was not confirmed; inspect the original call before retrying");
			const attempt = captureCreation(db, db.getAttempt(attemptId), receipt, actor);
			started.push({ taskId, attemptId, nativeId: text(attempt.nativeId, "native worker") });
		} catch (error) {
			const effect = db.getEffect(effectId);
			if (effect.state === "issued" && record(effect.request).nativeToolCallId === callId) {
				db.recordEffect({ ...effect, state: "uncertain", result: { error: reason(error) } }, actor);
			}
			blocked.push({ taskId, code: error instanceof FoundryError ? error.code : "native_dispatch_uncertain", message: reason(error) });
		}
	}));
	return { prepared, blocked, started, route: prepared.length ? "ordinary-native-turn" : "native-pickup" };
}

/** @param {Store} db @param {string} actor @param {string|undefined} goalId
 * @param {(actor:string,id:string)=>Promise<import("./recovery.mjs").CommandEvents>} read @returns {Promise<CreationRecovery[]>} */
export async function recoverCreations(db, actor, goalId, read) {
	const pending = db.pendingEffects().filter(effect => effect.kind === "create" && effect.owner === actor
		&& ["issued", "uncertain"].includes(effect.state)
		&& (goalId === undefined || db.getTask(db.getAttempt(effect.attemptId).taskId).goalId === goalId));
	return Promise.all(pending.map(async effect => {
		try {
			const { nativeToolCallId, ...args } = record(effect.request);
			const callId = text(nativeToolCallId, "original creator call ID");
			const { start, completion } = await read(actor, callId);
			const a = record(start), b = record(completion), issued = record(a.data), finished = record(b.data);
			if (a.type !== "tool.execution_start" || b.type !== "tool.execution_complete" || a.agentId || b.agentId
				|| issued.agentId || finished.agentId || issued.toolCallId !== callId || finished.toolCallId !== callId
				|| issued.turnId !== finished.turnId || toolName(text(issued.toolName, "original tool")) !== "create_session"
				|| digest(json(issued.arguments)) !== digest(json(args)) || finished.success !== true)
				throw new FoundryError("native_receipt_mismatch", "Original create start/completion do not match the reserved native assignment");
			const content = record(finished.result).content;
			const result = { resultType: "success", textResultForLlm: text(content, "native creation receipt"),
				eventId: text(b.id, "native completion event") };
			const attempt = captureCreation(db, db.getAttempt(effect.attemptId), result, actor);
			return { effectId: effect.id, state: "bound", nativeId: text(attempt.nativeId, "native worker") };
		} catch (error) {
			return { effectId: effect.id, state: "reconciliation-required", reason: reason(error) };
		}
	}));
}
