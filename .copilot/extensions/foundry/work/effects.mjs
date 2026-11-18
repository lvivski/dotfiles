import { parkPausedExecution, releaseSlot } from "./attempts.mjs";
import { authorized, current, requireAdmission, requireOwner, requireReporter } from "./policy.mjs";
import { decodeEffect } from "./records.mjs";
import { admitEffectEvidence } from "./results.mjs";
import { FoundryError, decodeEvidence, digest, json, record, text } from "./values.mjs";
import { notifyOutcome } from "./wakes.mjs";

/** @typedef {import("./model.d.ts").Json} Json */
/** @typedef {import("./model.d.ts").Attempt} Attempt */
/** @typedef {import("./model.d.ts").Effect} Effect */

/** @param {Json} before @param {Json} after @param {boolean} [issuing] @returns {boolean} */
export function sameRequest(before, after, issuing = false) {
	if (digest(before) === digest(after)) return true;
	if (!issuing || before === null || after === null || typeof before !== "object" || typeof after !== "object"
		|| Array.isArray(before) || Array.isArray(after)) return false;
	const { nativeToolCallId: oldCallId, ...oldRequest } = before;
	const { nativeToolCallId: newCallId, ...newRequest } = after;
	return oldCallId === undefined && (newCallId === null || (typeof newCallId === "string" && newCallId.length > 0))
		&& digest(oldRequest) === digest(newRequest);
}

/** @param {import("./database.mjs").Transaction} tx @param {Attempt} attempt @param {boolean} [substantive] @returns {boolean} */
export function outstanding(tx, attempt, substantive = false) {
	return effectsForAttempt(tx, attempt.id, "AND state IN ('issued','uncertain')")
		.some((effect) => !substantive || effect.kind === "command" || effect.kind === "create");
}

/** @param {import("./database.mjs").Transaction} tx @param {string} attemptId @param {string} [where] @returns {Effect[]} */
export function effectsForAttempt(tx, attemptId, where = "") {
	return tx.list("effects", `WHERE (attempt_id=? OR EXISTS (
		SELECT 1 FROM json_each(document,'$.relatedAttemptIds') WHERE value=?)) ${where}`, [attemptId, attemptId]);
}

/** @param {import("./database.mjs").Transaction} tx @param {Attempt} attempt @param {string} reason @returns {void} */
export function retirePrepared(tx, attempt, reason) {
	for (const effect of tx.list("effects", "WHERE attempt_id=? AND state='prepared' AND kind IN ('create','command')", [attempt.id])) {
		effect.state = "settled";
		effect.result = { neverIssued: true, reason };
		tx.put("effects", effect);
	}
}

/** @param {import("./database.mjs").Transaction} tx @param {Attempt} attempt @param {string} actor @param {string} [reason] @returns {void} */
export function scheduleStop(tx, attempt, actor, reason = "cancelled") {
	if (!attempt.nativeId) return;
	const local = tx.db.prepare("SELECT attempt_id FROM local_attempts WHERE attempt_id=?").get(attempt.id) !== undefined;
	const commands = effectsForAttempt(tx, attempt.id, "AND kind='command' AND state IN ('issued','uncertain')");
	if (local && !commands.length && attempt.nativeId === actor) return;
	const id = `stop:${attempt.id}:${attempt.nativeId}`;
	if (!tx.optional("effects", id)) tx.put("effects", {
		id, attemptId: attempt.id, kind: "stop", state: "prepared",
		owner: actor,
		request: { nativeId: attempt.nativeId, reason,
			effectIds: commands.map((effect) => effect.id) },
	});
}

/** @param {import("./database.mjs").Transaction} tx @param {string} shellId @param {string} actor @returns {Effect|undefined} */
export function commandForShell(tx, shellId, actor) {
	const effects = tx.list("effects", "WHERE kind='command' AND owner=? AND json_extract(document,'$.request.shellId')=?", [actor, shellId]);
	if (effects.length > 1) throw new FoundryError("effect_identity_conflict", "A command shell cannot identify multiple native operations");
	return effects[0];
}

/** @param {import("./database.mjs").Transaction} tx @returns {Effect[]} */
export function pendingEffects(tx) {
	return tx.list("effects", "WHERE state IN ('prepared','issued','uncertain')");
}

/** @param {import("./database.mjs").Transaction} tx @param {string} callId @param {boolean} [includeSettled] @returns {Effect|undefined} */
export function effectByNativeCall(tx, callId, includeSettled = false) {
	const effects = tx.list("effects", `WHERE ${includeSettled ? "" : "state IN ('issued','uncertain') AND "}(json_extract(document,'$.request.nativeToolCallId')=?
	OR (state IN ('issued','uncertain') AND EXISTS (
		SELECT 1 FROM json_each(document,'$.result.followUpCallIds') WHERE value=?
	)))`, [callId, callId]);
	return effects.length === 1 ? effects[0] : undefined;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} attemptId @param {string} actor @param {string} effectId @param {Json} request @returns {Effect} */
export function issueAttempt(tx, attemptId, actor, effectId, request) {
	const attempt = tx.get("attempts", attemptId);
	const task = current(tx, attempt);
	requireOwner(tx, task, actor);
	text(effectId, "effectId");
	const existing = tx.optional("effects", effectId);
	const factory = requireAdmission(tx, task, existing?.factoryGeneration);
	const safeRequest = json(request);
	if (existing) {
		if (existing.attemptId !== attemptId || existing.kind !== "create"
			|| !sameRequest(existing.request, safeRequest, existing.state === "prepared")) {
			throw new FoundryError("effect_identity_conflict", "Effect identity is already used for another request");
		}
		if (existing.state !== "prepared") return existing;
	}
	if (!attempt.slot || attempt.nativeId || attempt.state !== "prepared"
		|| tx.list("effects", "WHERE attempt_id=? AND kind='create' AND state<>'prepared'", [attemptId]).length) {
		throw new FoundryError("already_issued", "Creation may already have happened; reconcile it, never issue another create");
	}
	const other = tx.list("effects", "WHERE attempt_id=? AND kind='create'", [attemptId]).find((effect) => effect.id !== effectId);
	if (other) throw new FoundryError("already_issued", "This attempt already has a creation identity");
	const effect = decodeEffect({ id: effectId, attemptId, kind: "create", state: "issued", owner: actor, request: safeRequest,
		...(factory === undefined ? {} : { factoryGeneration: factory.generation }) });
	attempt.state = "issued";
	tx.put("effects", effect);
	tx.put("attempts", attempt);
	return effect;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} effectId @param {string} actor @param {Json} receipt @returns {Effect} */
export function rejectCreation(tx, effectId, actor, receipt) {
	const effect = tx.get("effects", effectId);
	const attempt = tx.get("attempts", effect.attemptId);
	const task = tx.get("tasks", attempt.taskId);
	if (effect.kind !== "create" || effect.owner !== actor || attempt.nativeId !== undefined
		|| !["issued", "uncertain"].includes(effect.state)) throw new FoundryError("refusal_mismatch", "A pre-start refusal must match the actual issued creation and its creator");
	effect.state = "settled";
	effect.result = json({ neverIssued: true, nativeRefusal: receipt });
	tx.put("effects", effect);
	if (attempt.state !== "cancelled") attempt.state = "failed";
	attempt.endedBy = actor;
	if (task.currentAttemptId === attempt.id && task.version === attempt.taskVersion && task.state !== "cancelled") {
		task.state = "blocked";
		tx.put("tasks", task);
		notifyOutcome(tx, task);
	}
	tx.put("attempts", attempt);
	releaseSlot(tx, attempt);
	return effect;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} effectId @param {string} actor @param {Json} receipt @returns {boolean} */
export function refuseDisabledDispatch(tx, effectId, actor, receipt) {
	const envelope = record(receipt);
	if (envelope.resultType !== "failure" || envelope.error !== "This session management tool is disabled"
		|| envelope.structuredContent || envelope.textResultForLlm) throw new FoundryError("refusal_mismatch", "No definite pre-start route refusal");
	const effect = rejectCreation(tx, effectId, actor, receipt);
	const attempt = tx.get("attempts", effect.attemptId), task = tx.get("tasks", attempt.taskId);
	if (task.state !== "blocked" || task.currentAttemptId !== attempt.id || task.version !== attempt.taskVersion
		|| task.owner !== actor) return false;
	// No worker ran. Keep the immutable refusal and allow an ordinary native
	// call with a new token, not another issuance of the first call.
	task.state = "ready";
	tx.put("tasks", task);
	return true;
}

/** @param {import("./database.mjs").Transaction} tx @param {{id: string, attemptId: string, kind: Effect["kind"], state: Effect["state"], request: Json, result?: Json, factoryGeneration?:number, relatedAttemptIds?:string[]}} input @param {string} actor @returns {Effect} */
export function recordEffect(tx, input, actor) {
	if (input.kind === "archive") throw new FoundryError("archive_receipt_required", "Use the owner-bound native retirement protocol");
	const attempt = tx.get("attempts", input.attemptId);
	requireReporter(tx, attempt, text(actor, "actor"));
	const existing = tx.optional("effects", input.id);
	const effect = decodeEffect({ ...record(input), owner: existing?.owner ?? actor });
	if (["command", "create"].includes(effect.kind) && (!existing || existing.state === "prepared")
		&& effect.state !== "settled") {
		const factory = requireAdmission(tx, tx.get("tasks", attempt.taskId), existing?.factoryGeneration);
		if (factory) effect.factoryGeneration = factory.generation;
	} else if (existing?.factoryGeneration !== undefined) effect.factoryGeneration = existing.factoryGeneration;
	if (existing && digest(json(existing.relatedAttemptIds ?? [])) !== digest(json(effect.relatedAttemptIds ?? []))) {
		throw new FoundryError("effect_identity_conflict", "Shared command attribution is immutable");
	}
	if (effect.relatedAttemptIds?.length) {
		if (effect.kind !== "command" || existing && digest(json(existing.relatedAttemptIds ?? [])) !== digest(json(effect.relatedAttemptIds))) {
			throw new FoundryError("effect_identity_conflict", "Shared command attribution is immutable");
		}
		for (const id of effect.relatedAttemptIds) {
			const related = tx.get("attempts", id);
			if (related.nativeId !== attempt.nativeId || related.nativeId !== actor) {
				throw new FoundryError("foreign_execution", "A shared native command can only belong to this caller's actual attempts");
			}
			if (!existing || existing.state === "prepared" && effect.state === "issued") {
				requireAdmission(tx, current(tx, related));
				if (!related.slot) throw new FoundryError("capacity_required", "Every possible executing unit requires a slot");
			}
		}
	}
	if (existing && (existing.attemptId !== effect.attemptId || existing.kind !== effect.kind
		|| !sameRequest(existing.request, effect.request, existing.state === "prepared" && effect.state === "issued"))) {
		throw new FoundryError("effect_identity_conflict", "An effect identity cannot change its attempt or request");
	}
	if (existing?.state === "settled") {
		if (effect.state !== "settled" || digest(json(existing.result ?? null)) !== digest(json(effect.result ?? null))) {
			throw new FoundryError("effect_already_settled", "Settled effects are immutable");
		}
		return existing;
	}
	if (existing && existing.state !== "prepared" && effect.state === "prepared") {
		throw new FoundryError("invalid_transition", "An issued effect cannot become unissued");
	}
	if (effect.kind === "create" && (!existing || existing.state === "prepared") && effect.state !== "prepared") {
		throw new FoundryError("issuance_required", "Creation issuance must use issueAttempt at the native call boundary");
	}
	if (effect.kind === "create" && !existing && tx.list("effects", "WHERE attempt_id=? AND kind='create'", [attempt.id]).length) {
		throw new FoundryError("already_issued", "Attempt already has a creation identity");
	}
	if ((effect.state === "issued" || effect.state === "uncertain") && (!existing || existing.state === "prepared")
		&& effect.kind !== "stop") {
		const task = current(tx, attempt);
		if (effect.kind !== "command" || attempt.nativeId !== actor) requireOwner(tx, task, actor);
		if ((effect.kind === "command" || effect.kind === "create") && (!attempt.slot || !["prepared", "issued", "running"].includes(attempt.state))) {
			throw new FoundryError("capacity_required", "Substantive execution requires an active worker slot");
		}
	}
	if (effect.kind === "command" && effect.state === "settled" && effect.result !== null
		&& typeof effect.result === "object" && !Array.isArray(effect.result) && effect.result.evidence !== undefined) {
		if (!existing || !["issued", "uncertain"].includes(existing.state)) {
			throw new FoundryError("unissued_evidence", "Check evidence must settle a known issued native operation");
		}
		const observations = Array.isArray(effect.result.evidence) ? effect.result.evidence : [effect.result.evidence];
		for (const value of observations) {
			const evidence = decodeEvidence(value);
			const check = attempt.checks.find((item) => item.id === evidence.checkId && item.version === evidence.checkVersion);
			if (evidence.attemptId !== attempt.id || !check) {
				throw new FoundryError("evidence_mismatch", "Admitted evidence must match this operation's assigned attempt and evaluator");
			}
		}
	}
	tx.put("effects", effect);
	admitEffectEvidence(tx, effect);
	if (effect.kind === "command" && effect.state === "settled") {
		for (const id of [attempt.id, ...effect.relatedAttemptIds ?? []]) parkPausedExecution(tx, tx.get("attempts", id));
	}
	if (effect.kind === "create" && effect.state === "uncertain" && !attempt.nativeId
		&& !["done", "failed", "cancelled"].includes(attempt.state)) {
		attempt.state = "uncertain";
		tx.put("attempts", attempt);
	}
	releaseSlot(tx, attempt);
	for (const id of effect.relatedAttemptIds ?? []) releaseSlot(tx, tx.get("attempts", id));
	return effect;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor @param {string} [goalId] @returns {void} */
export function retryFailedStops(tx, actor, goalId) {
	for (const failed of tx.list("effects", `WHERE kind='stop' AND state='settled' AND json_extract(document,'$.result.accepted')=0
		AND attempt_id IN (SELECT id FROM attempts WHERE state='cancelled')`)) {
		if (failed.result === undefined || failed.result === null
			|| typeof failed.result !== "object" || Array.isArray(failed.result)) continue;
		const result = record(failed.result);
		if (result.accepted !== false || result.unavailable === true) continue;
		const attempt = tx.get("attempts", failed.attemptId);
		const task = tx.get("tasks", attempt.taskId);
		if ((goalId !== undefined && task.goalId !== goalId) || !authorized(tx, task, actor) || attempt.state !== "cancelled") continue;
		const stops = tx.list("effects", "WHERE attempt_id=? AND kind='stop'", [attempt.id]);
		if (stops.some(stop => stop.result !== undefined && stop.result !== null
			&& typeof stop.result === "object" && !Array.isArray(stop.result) && stop.result.unavailable === true)) continue;
		if (stops.some(stop => stop.state !== "settled" || (stop.result !== undefined && stop.result !== null
			&& typeof stop.result === "object" && !Array.isArray(stop.result) && stop.result.accepted === true))) continue;
		tx.put("effects", decodeEffect({ ...failed, id: `${failed.id}:retry:${stops.length}`,
			state: "prepared", owner: actor, result: undefined }));
	}
}
