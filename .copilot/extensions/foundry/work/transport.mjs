import { FoundryError, digest, json, record, text } from "./values.mjs";

/** @typedef {ReturnType<typeof import("./store.mjs").openWorkStore>} Store */
/** @typedef {{deliveryId:string,state:"queue-confirmed"}|{deliveryId:string,state:"reconciliation-required",reason:string}} WakeRecovery */
/** @param {import("./model.d.ts").Wake} wake @returns {{session_id:string,delivery_mode:"immediate",message:string}} */
export function wakeRequest(wake) {
	return {
		session_id: wake.owner, delivery_mode: "immediate",
		message: `Foundry wake: ${wake.id}:${wake.generation}\n${wake.reason}. Use foundry_advance for ${wake.goalId} to see discovery actions or remaining prepared calls. Native factory pickup runs on the owner's turn; do not duplicate started workers.`,
	};
}

/** @param {unknown} args */
const marker = args => {
	const message = record(args).message;
	return typeof message === "string" && /^Foundry wake: ([^:\s]+):([0-9]+)\n/u.exec(message);
};

/** @param {Store} db @param {unknown} args @param {string} actor @param {string|undefined} callId @returns {void} */
export function issueWake(db, args, actor, callId) {
	const match = marker(args);
	if (!match) return;
	text(callId, "native message call ID");
	const [ , id, generation ] = match;
	const pending = db.pendingDeliveries(actor).find(delivery => delivery.wakeId === id);
	if (pending) {
		const { nativeToolCallId, ...expected } = record(pending.request);
		if (nativeToolCallId === callId && pending.generation === Number(generation) && digest(json(args)) === digest(json(expected))) return;
		throw new FoundryError("wake_delivery_pending", "This wake is already issued. Reconcile its native receipt or await owner receipt; never replay it.");
	}
	const wake = db.outgoingWakes(actor, true).find(wake => wake.id === id && wake.generation === Number(generation));
	if (!wake || digest(json(args)) !== digest(json(wakeRequest(wake)))
		|| !db.claimWakeDelivery(id, wake.generation, undefined, json({ ...record(args), nativeToolCallId: callId }), actor)) {
		throw new FoundryError("wake_changed", "This is no longer an eligible addressed notification; refresh owner context before sending.");
	}
}

/** @param {Store} db @param {unknown} args @param {unknown} result @param {string} actor @param {string|undefined} callId @returns {import("./model.d.ts").Wake|undefined} */
export function observeWake(db, args, result, actor, callId) {
	const match = marker(args);
	if (!match || !callId) return;
	const delivery = db.pendingDeliveries(actor).find(item => item.wakeId === match[1] && item.generation === Number(match[2]));
	if (!delivery) return;
	const { nativeToolCallId, ...expected } = record(delivery.request);
	if (nativeToolCallId !== callId || digest(json(expected)) !== digest(json(args)) || record(result).resultType !== "success") return;
	return db.settleWakeDelivery(delivery.wakeId, delivery.id, delivery.generation, json(result), true, actor);
}

/** @param {Store} db @param {string} actor @param {string|undefined} goalId
 * @param {(actor:string,id:string)=>Promise<import("./recovery.mjs").CommandEvents>} read @returns {Promise<WakeRecovery[]>} */
export async function recoverDeliveries(db, actor, goalId, read) {
	const pending = db.pendingDeliveries(actor, goalId);
	return Promise.all(pending.map(async delivery => {
		try {
			const { nativeToolCallId, ...args } = record(delivery.request);
			const callId = text(nativeToolCallId, "original sender call ID");
			const events = await read(actor, callId);
			const a = record(events.start), b = record(events.completion), issued = record(a.data), finished = record(b.data);
			if (a.type !== "tool.execution_start" || b.type !== "tool.execution_complete" || a.agentId || b.agentId
				|| issued.agentId || finished.agentId || issued.toolCallId !== callId || finished.toolCallId !== callId
				|| issued.turnId !== finished.turnId || !["send_session_message","functions.send_session_message"].includes(String(issued.toolName))
				|| digest(json(issued.arguments)) !== digest(json(args)) || finished.success !== true)
				throw new FoundryError("native_receipt_mismatch", "Native history does not establish queue admission; wait for recipient or exact original receipt.");
			// A generic successful event with a missing or unrelated result is
			// not a queue receipt. The request match above pins its recipient.
			const content = record(finished.result).content;
			if (typeof content !== "string" || !/^Message accepted for priority delivery to session '[^\n]+'\./u.test(content))
				throw new FoundryError("native_receipt_mismatch", "Original sender history has no recognized native queue-admission receipt.");
			const receipt = json({ resultType: "success", source: "session.eventLog.read", eventId: text(b.id, "native completion event"),
				sessionId: actor, startId: text(a.id, "native start event"), nativeResult: finished.result ?? null });
			if (db.getDelivery(delivery.id).state === "issued")
				db.settleWakeDelivery(delivery.wakeId, delivery.id, delivery.generation, receipt, true, actor);
			return { deliveryId: delivery.id, state: "queue-confirmed" };
		} catch (error) {
			return { deliveryId: delivery.id, state: "reconciliation-required", reason: error instanceof Error ? error.message : String(error) };
		}
	}));
}
