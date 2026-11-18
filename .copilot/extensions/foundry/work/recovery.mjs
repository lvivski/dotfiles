import { FoundryError, digest, json, record, text } from "./values.mjs";
import { continuedShell, effectShell, nativeObject, observeCompletion, toolName } from "./native.mjs";

/** @typedef {ReturnType<typeof import("./store.mjs").openWorkStore>} Store */
/** @typedef {{start: unknown, completion: unknown, following?: Record<string, unknown>[]}} CommandEvents */
const boundaries = ["session.start", "session.resume", "session.shutdown"];
/** @param {Record<string, unknown>} event */
const data = event => record(event.data ?? {});
/** @param {Record<string, unknown>} event */
const primary = event => event.agentId === undefined && data(event).agentId === undefined && data(event).parentToolCallId === undefined;
/** @param {Record<string, unknown>} event */
const eventTime = event => typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
/** @param {Record<string, unknown>} event */
const finalExit = event => typeof event.success === "boolean" && Number.isInteger(record(event.shellExecution ?? {}).exitCode);

/** @param {(args:Parameters<import("@github/copilot-sdk").CopilotSession["rpc"]["eventLog"]["read"]>[0])=>Promise<{events:unknown[],cursor:string,cursorStatus:string,hasMore:boolean}>} readPage @param {string} toolCallId @returns {Promise<CommandEvents>} */
export async function readCommandEvents(readPage, toolCallId) {
	/** @type {Record<string, unknown> | undefined} */
	let start, completion;
	/** @type {string | undefined} */
	let cursor;
	const cursors = new Set();
	/** @type {Record<string, unknown>[]} */
	const newer = [];
	for (;;) {
		const page = await readPage({ ...(cursor === undefined ? {} : { cursor }), direction: "backward",
			view: "history", types: ["tool.execution_start", "tool.execution_complete", ...boundaries],
			agentScope: "primary", includeEphemeral: false, max: 1000 });
		if (page.cursorStatus !== "ok") throw new FoundryError("native_history_expired", "Native history changed; no command settlement was inferred");
		for (const value of page.events.slice().reverse()) {
			const event = record(value);
			const current = data(event);
			if (!completion && current.toolCallId !== toolCallId) {
				if (typeof event.type === "string" && boundaries.includes(event.type)
					|| event.type === "tool.execution_start" && ["bash", "shell", "read_bash", "stop_bash"].includes(toolName(String(current.toolName)))
					|| event.type === "tool.execution_complete" && (finalExit(current) || continuedShell(current))) newer.push(event);
			}
			if (current.toolCallId !== toolCallId) continue;
			if (event.type === "tool.execution_start") {
				if (start && start.id !== event.id) throw new FoundryError("ambiguous_native_receipt", "Multiple native starts share this call identity");
				start = event;
			} else if (event.type === "tool.execution_complete") {
				if (completion && completion.id !== event.id) throw new FoundryError("ambiguous_native_receipt", "Multiple native completions share this call identity");
				completion = event;
			}
		}
		if (start && completion) return { start, completion, ...(continuedShell(data(completion)) ? { following: newer.reverse() } : {}) };
		if (!page.hasMore) throw new FoundryError("native_receipt_unavailable", "The original native start and completion are not both retained");
		if (cursors.has(page.cursor)) throw new FoundryError("native_history_stalled", "Native history cursor made no progress");
		cursors.add(page.cursor);
		cursor = page.cursor;
	}
}

/** @param {Record<string, unknown>[]} following @param {Record<string, unknown>} timeout @param {string} shellId */
function continuedRead(following, timeout, shellId) {
	const after = eventTime(timeout);
	const mode = record(record(data(timeout).toolTelemetry ?? {}).properties ?? {}).executionMode;
	const starts = new Map();
	for (const event of following) {
		const current = data(event);
		if (typeof event.type === "string" && boundaries.includes(event.type)) return;
		if (event.type === "tool.execution_start") {
			if (record(current.arguments ?? {}).shellId !== shellId) continue;
			// A new command or stop of the same handle ends the unambiguous recovery interval.
			if (toolName(String(current.toolName)) !== "read_bash") return;
			if (!primary(event) || typeof current.toolCallId !== "string" || !(eventTime(event) >= after)) continue;
			if (starts.has(current.toolCallId)) throw new FoundryError("ambiguous_native_receipt", "Multiple native reads share this call identity");
			starts.set(current.toolCallId, event);
		} else if (event.type === "tool.execution_complete") {
			if (continuedShell(current) === shellId) return;
			const start = starts.get(current.toolCallId);
			if (!start || !primary(event) || data(start).turnId !== current.turnId || !(eventTime(event) >= eventTime(start))) continue;
			const properties = record(record(current.toolTelemetry ?? {}).properties ?? {});
			if (typeof mode === "string" && typeof properties.read_target_original_mode === "string"
				&& properties.read_target_original_mode !== mode) return;
			if (current.success === true && finalExit(current) && properties.read_target_state === "active") return { start, completion: event };
		}
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
		|| !primary(start) || !primary(completion)
		|| issued.turnId !== finished.turnId) {
		throw new FoundryError("native_receipt_mismatch", "The retained native events do not match this original issued command");
	}
	const startedAt = eventTime(start), completedAt = eventTime(completion);
	const shellId = continuedShell(finished);
	const knownShell = effectShell(effect);
	const follow = shellId !== undefined && (knownShell === undefined || knownShell === shellId)
		? continuedRead(events.following ?? [], completion, shellId) : undefined;
	if (!(completedAt >= startedAt) || !finalExit(finished) && !follow) {
		throw new FoundryError("native_completion_pending", "Only an actual final native shell exit can settle the command");
	}
	const final = follow?.completion ?? completion;
	const receipt = json({ source: "session.eventLog.read", sessionId: actor,
		startEventId: text(start.id, "native start event"), startSha256: digest(json(start)),
		completionEventId: text(final.id, "native completion event"), completionSha256: digest(json(final)),
		...(follow ? { continuationEventId: text(completion.id, "native timeout event"), continuationSha256: digest(json(completion)),
			readStartEventId: text(follow.start.id, "native read start event"), readStartSha256: digest(json(follow.start)) } : {}) });
	observeCompletion(store, data(final), actor, settled, { effectId: effect.id, receipt, ...(follow ? { shellId } : {}) });
	const recovered = store.getEffect(effect.id);
	if (recovered.state !== "settled") throw new FoundryError("native_receipt_mismatch", "The retained final exit does not match the recorded shell");
	return { effectId: recovered.id, attemptId: recovered.attemptId, state: recovered.state,
		nativeRecovery: recovered.result === undefined ? undefined : record(recovered.result).nativeRecovery };
}
