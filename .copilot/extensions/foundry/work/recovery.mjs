import { FoundryError, digest, json, record, text } from "./values.mjs";
import { nativeObject, observeCompletion, toolName } from "./native.mjs";

/** @typedef {ReturnType<typeof import("./store.mjs").openWorkStore>} Store */
/** @typedef {{start: unknown, completion: unknown}} CommandEvents */

/** @param {(args:Parameters<import("@github/copilot-sdk").CopilotSession["rpc"]["eventLog"]["read"]>[0])=>Promise<{events:unknown[],cursor:string,cursorStatus:string,hasMore:boolean}>} readPage @param {string} toolCallId @returns {Promise<CommandEvents>} */
export async function readCommandEvents(readPage, toolCallId) {
	/** @type {Record<string, unknown> | undefined} */
	let start, completion;
	/** @type {string | undefined} */
	let cursor;
	const cursors = new Set();
	for (;;) {
		const page = await readPage({ ...(cursor === undefined ? {} : { cursor }), direction: "backward",
			view: "history", types: ["tool.execution_start", "tool.execution_complete"],
			agentScope: "primary", includeEphemeral: false, max: 1000 });
		if (page.cursorStatus !== "ok") throw new FoundryError("native_history_expired", "Native history changed; no command settlement was inferred");
		for (const value of page.events) {
			const event = record(value);
			if (record(event.data).toolCallId !== toolCallId) continue;
			if (event.type === "tool.execution_start") {
				if (start && start.id !== event.id) throw new FoundryError("ambiguous_native_receipt", "Multiple native starts share this call identity");
				start = event;
			} else if (event.type === "tool.execution_complete") {
				if (completion && completion.id !== event.id) throw new FoundryError("ambiguous_native_receipt", "Multiple native completions share this call identity");
				completion = event;
			}
		}
		if (start && completion) return { start, completion };
		if (!page.hasMore) throw new FoundryError("native_receipt_unavailable", "The original native start and completion are not both retained");
		if (cursors.has(page.cursor)) throw new FoundryError("native_history_stalled", "Native history cursor made no progress");
		cursors.add(page.cursor);
		cursor = page.cursor;
	}
}

/** @param {Store} store @param {string} toolCallId @param {string} actor */
export function commandForRecovery(store, toolCallId, actor) {
	const effect = store.effectByNativeCall(toolCallId, true);
	if (!effect || effect.kind !== "command" || !["issued", "uncertain", "settled"].includes(effect.state)
		|| record(effect.request).nativeToolCallId !== toolCallId) {
		throw new FoundryError("unissued_command", "Recovery requires the ordinary command's original issued native call");
	}
	if (store.getAttempt(effect.attemptId).nativeId !== actor) throw new FoundryError("foreign_execution", "Recover commands only in their actual native worker");
	if (typeof record(effect.request).checkId === "string") throw new FoundryError("assigned_check", "Assigned checks recover through their exclusive runner receipts");
	return effect;
}

/** @param {Store} store @param {string} toolCallId @param {string} actor @param {unknown} detail @param {CommandEvents} events @param {(effect:import("./model.js").Effect)=>void} [settled] */
export function reconcileCommand(store, toolCallId, actor, detail, events, settled) {
	const effect = commandForRecovery(store, toolCallId, actor);
	const goal = store.getGoal(store.getTask(store.getAttempt(effect.attemptId).taskId).goalId);
	const native = nativeObject(detail);
	if (native?.id !== actor || goal.projectId !== undefined && native.project_id !== goal.projectId) {
		throw new FoundryError("native_identity_mismatch", "Command recovery requires its actual native session and project");
	}
	const start = record(events.start), completion = record(events.completion);
	const issued = record(start.data), finished = record(completion.data);
	const args = record(issued.arguments), request = record(effect.request);
	if (start.type !== "tool.execution_start" || completion.type !== "tool.execution_complete"
		|| issued.toolCallId !== toolCallId || finished.toolCallId !== toolCallId
		|| !["bash", "shell"].includes(toolName(text(issued.toolName, "original native tool")))
		|| args.command !== request.command || args.shellId !== request.shellId
		|| start.agentId !== undefined || completion.agentId !== undefined
		|| issued.parentToolCallId !== undefined || finished.parentToolCallId !== undefined
		|| issued.turnId !== finished.turnId) {
		throw new FoundryError("native_receipt_mismatch", "The retained native events do not match this original issued command");
	}
	const startedAt = Date.parse(text(start.timestamp, "native start time"));
	const completedAt = Date.parse(text(completion.timestamp, "native completion time"));
	const shell = finished.shellExecution === undefined ? undefined : record(finished.shellExecution);
	if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt
		|| typeof finished.success !== "boolean" || !Number.isInteger(shell?.exitCode)) {
		throw new FoundryError("native_completion_pending", "Only an actual final native shell exit can settle the command");
	}
	const receipt = json({ source: "session.eventLog.read", sessionId: actor,
		startEventId: text(start.id, "native start event"), startSha256: digest(json(start)),
		completionEventId: text(completion.id, "native completion event"), completionSha256: digest(json(completion)) });
	observeCompletion(store, finished, actor, settled, receipt);
	const recovered = store.getEffect(effect.id);
	return { effectId: recovered.id, attemptId: recovered.attemptId, state: recovered.state,
		nativeRecovery: recovered.result === undefined ? undefined : record(recovered.result).nativeRecovery };
}
