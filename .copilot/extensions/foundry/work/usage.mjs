import { randomUUID } from "node:crypto";
import { observeExecutionBase } from "./attempts.mjs";
import { goalMember, requireReporter } from "./policy.mjs";
import { decodeNativeUsage, decodeUsageAffinity } from "./records.mjs";
import { FoundryError, digest, natural, number, record, text } from "./values.mjs";

/** @typedef {import("./model.d.ts").Goal} Goal */

/** @param {import("./database.mjs").Transaction} tx @param {string[]} identities @returns {import("./model.d.ts").NativeUsage|undefined} */
export function usageReceipts(tx, identities) {
	const matches = tx.list("native_usage", `WHERE id IN (SELECT receipt_id FROM usage_aliases
		WHERE alias IN (SELECT value FROM json_each(?)))`, [JSON.stringify(identities)]);
	if (matches.length > 1) throw new FoundryError("usage_identity_conflict", "Multiple prior receipts share one actual native billing identity");
	return matches[0];
}

/** @param {import("./database.mjs").Transaction} tx @param {import("./model.d.ts").NativeUsage} observation @returns {import("./model.d.ts").NativeUsage} */
export function settleUsage(tx, observation) {
	let attempts = observation.attemptIds.map(id => tx.get("attempts", id));
	if (!attempts.length && observation.token) {
		const candidate = tx.list("attempts", "WHERE json_extract(document,'$.token')=? AND native_id=?",
			[observation.token, observation.nativeId])[0];
		if (candidate) attempts = [candidate];
	}
	if (attempts.some(attempt => attempt.nativeId !== observation.nativeId)) {
		throw new FoundryError("foreign_usage", "Usage can only debit its actual native execution");
	}
	const goalIds = [...new Set(attempts.map(attempt => tx.get("tasks", attempt.taskId).goalId))];
	if (goalIds.length === 1) {
		observation.goalId = goalIds[0];
		observation.attemptIds = attempts.map(attempt => attempt.id);
		if (attempts.length === 1) observation.attemptId = attempts[0].id;
	}
	if (observation.goalId && observation.credits !== undefined && observation.debitedCredits === undefined) {
		const manual = tx.db.prepare("SELECT attempt_id,credits FROM usage WHERE event_id IN (SELECT value FROM json_each(?))")
			.all(JSON.stringify(observation.aliases));
		if (manual.length > 1 || manual.some(row => row.credits !== observation.credits
			|| !observation.attemptIds.includes(text(row.attempt_id, "usage attempt")))) {
			throw new FoundryError("usage_identity_conflict", "The same native charge has conflicting manual observations");
		}
		if (!manual.length) {
			const goal = tx.get("goals", observation.goalId);
			goal.credits = number(goal.credits + observation.credits, "total observed credits");
			tx.put("goals", goal);
		}
		observation.debitedCredits = observation.credits;
	}
	tx.put("native_usage", observation);
	return observation;
}

/** @param {string} actor @param {unknown} [agentId] @returns {string} */
export function affinityId(actor, agentId) {
	return `affinity:${digest([text(actor, "native session"), agentId === undefined ? null : text(agentId, "agent id")])}`;
}

/** @param {unknown} value @param {string} actor @param {import("./model.d.ts").UsageAffinity|undefined} affinity @returns {import("./model.d.ts").NativeUsage} */
export function nativeUsage(value, actor, affinity) {
	const event = record(value);
	if (event.type !== "assistant.usage") throw new FoundryError("invalid_field", "Expected an actual native assistant.usage event");
	const data = record(event.data);
	const accounting = data.accounting === undefined ? undefined : record(data.accounting);
	const sourceSessionId = accounting === undefined ? actor : text(accounting.sourceSessionId, "accounting source");
	const sequence = accounting === undefined ? undefined : natural(accounting.sequence, "usage sequence");
	const apiIdentity = data.apiCallId === undefined ? undefined : `usage:${digest([sourceSessionId, text(data.apiCallId, "API call identity")])}`;
	const eventId = text(event.id, "native event id");
	const id = sequence === undefined ? apiIdentity ?? `usage:${eventId}` : `usage:${sourceSessionId}:${sequence}`;
	const aliases = [...new Set([id, eventId, ...(apiIdentity ? [apiIdentity] : []),
		...(accounting ? [`usage:${digest([sourceSessionId, text(accounting.usageId, "usage identity")])}`] : [])])];
	const nano = data.copilotUsage === undefined ? undefined : number(record(data.copilotUsage).totalNanoAiu, "native nano-AI units");
	return decodeNativeUsage({ id, nativeId: actor, sourceSessionId, aliases, sequence,
		attemptIds: affinity?.attemptIds ?? [], token: affinity?.token,
		credits: nano === undefined ? undefined : nano / 1_000_000_000,
		billing: nano === undefined ? "unavailable" : data.aiCreditsStatus === "complete" ? "complete" : "partial" });
}

/** @param {import("./database.mjs").Transaction} tx @param {string} id @param {string} observedAt
 * @returns {import("./model.d.ts").UsageAffinity|undefined} */
export function usageAffinity(tx, id, observedAt) {
	const observed = Date.parse(text(observedAt, "native event timestamp"));
	if (!Number.isFinite(observed)) throw new FoundryError("invalid_field", "Native usage must retain its actual timestamp");
	return tx.list("usage_affinity", `WHERE id=(SELECT id FROM usage_affinity
	WHERE json_extract(document,'$.groupId')=? AND json_extract(document,'$.startedAt')<=?
	ORDER BY json_extract(document,'$.startedAt') DESC,rowid DESC LIMIT 1)`,
	[text(id, "affinity group"), new Date(observed).toISOString()])[0];
}

/** @param {import("./database.mjs").Transaction} tx @param {string} id @param {string} actor @param {string} [token] @param {{id: string,timestamp: string}} [request] @returns {import("./model.d.ts").UsageAffinity} */
export function captureUsageAffinity(tx, id, actor, token, request) {
	const attempts = tx.list("attempts", "WHERE native_id=? AND state IN ('prepared','issued','running','waiting','uncertain')", [text(actor, "native session")])
		.filter(attempt => {
			const task = tx.get("tasks", attempt.taskId);
			return task.currentAttemptId === attempt.id && task.version === attempt.taskVersion;
		});
	for (const attempt of attempts) observeExecutionBase(tx, attempt);
	const assignment = token ? tx.list("attempts", "WHERE json_extract(document,'$.token')=?", [token])[0] : undefined;
	const activeToken = token && (!assignment || (!assignment.nativeId || assignment.nativeId === actor)
		&& !["done", "failed", "cancelled"].includes(assignment.state)
		&& tx.get("tasks", assignment.taskId).currentAttemptId === assignment.id) ? token : undefined;
	if (!attempts.length && !activeToken) {
		const previous = tx.list("usage_affinity", `WHERE id=(SELECT id FROM usage_affinity
			WHERE json_extract(document,'$.groupId')=? ORDER BY json_extract(document,'$.startedAt') DESC,rowid DESC LIMIT 1)`, [id])[0];
		if (previous && !previous.attemptIds.length && !previous.token) return previous;
	}
	const affinity = decodeUsageAffinity({ id: `${id}:${request ? text(request.id, "native turn event") : randomUUID()}`,
		groupId: id, startedAt: request?.timestamp ?? tx.timestamp(),
		nativeId: actor, attemptIds: attempts.map(attempt => attempt.id), token: activeToken });
	const existing = tx.optional("usage_affinity", affinity.id);
	if (existing) {
		if (existing.nativeId !== actor || existing.groupId !== affinity.groupId || existing.startedAt !== affinity.startedAt) {
			throw new FoundryError("usage_identity_conflict", "A captured native request cannot change its execution identity");
		}
		return existing;
	}
	tx.put("usage_affinity", affinity);
	return affinity;
}

/** @param {import("./database.mjs").Transaction} tx @param {import("./model.d.ts").NativeUsage} input @param {string} actor @param {boolean} [idle] @returns {import("./model.d.ts").NativeUsage|undefined} */
export function recordNativeUsage(tx, input, actor, idle = false) {
	const incoming = decodeNativeUsage(input);
	if (incoming.nativeId !== actor) throw new FoundryError("foreign_usage", "Only the actual native session can observe its usage");
	delete incoming.goalId;
	delete incoming.attemptId;
	delete incoming.debitedCredits;
	const existing = usageReceipts(tx, [incoming.id, ...incoming.aliases]);
	if (!existing && idle) return;
	if (!existing) return settleUsage(tx, incoming);
	if (existing.nativeId !== incoming.nativeId || existing.sourceSessionId !== incoming.sourceSessionId
		|| existing.sequence !== undefined && incoming.sequence !== undefined && existing.sequence !== incoming.sequence
		|| existing.credits !== undefined && incoming.credits !== undefined && existing.credits !== incoming.credits) {
		throw new FoundryError("usage_identity_conflict", "An actual native receipt cannot change its source, sequence or amount");
	}
	const observation = decodeNativeUsage({ ...existing,
		sequence: existing.sequence ?? incoming.sequence,
		aliases: [...new Set([...existing.aliases, ...incoming.aliases])],
		credits: existing.credits ?? incoming.credits,
		billing: existing.billing === "complete" ? "complete" : incoming.billing === "unavailable" ? existing.billing : incoming.billing });
	return settleUsage(tx, observation);
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor @param {string[]} goalIds */
export function accounting(tx, actor, goalIds) {
	const ids = goalIds.filter(id => goalMember(tx, tx.get("goals", id), actor));
	const totals = tx.db.prepare(`SELECT count(*) AS receipts,
		COALESCE(sum(json_extract(document,'$.billing')<>'complete'),0) AS missing,
		COALESCE(sum(goal_id IS NULL),0) AS unallocated,
		COALESCE(sum(goal_id IS NULL AND json_extract(document,'$.credits') IS NOT NULL),0) AS unallocated_known,
		COALESCE(sum(CASE WHEN goal_id IS NULL THEN json_extract(document,'$.credits') ELSE 0 END),0) AS unallocated_credits
		FROM native_usage WHERE goal_id IN (SELECT value FROM json_each(?))
			OR (goal_id IS NULL AND EXISTS (SELECT 1 FROM json_each(native_usage.document,'$.attemptIds') ids
				JOIN attempts a ON a.id=ids.value JOIN tasks t ON t.id=a.task_id
				WHERE t.goal_id IN (SELECT value FROM json_each(?))))
			OR (goal_id IS NULL AND EXISTS (SELECT 1 FROM attempts a JOIN tasks t ON t.id=a.task_id
				WHERE json_extract(a.document,'$.token')=json_extract(native_usage.document,'$.token')
					AND (a.native_id IS NULL OR a.native_id=native_usage.native_id)
					AND t.goal_id IN (SELECT value FROM json_each(?))))`)
		.get(JSON.stringify(ids), JSON.stringify(ids), JSON.stringify(ids));
	if (!totals) throw new FoundryError("accounting_invariant", "Native accounting totals are unavailable");
	return { unit: "observed native AI credits", complete: false, captureComplete: false,
		capturedReceipts: natural(totals.receipts, "native receipts"), missingBilling: natural(totals.missing, "missing billing"),
		unallocatedReceipts: natural(totals.unallocated, "unallocated receipts"),
		unallocatedCredits: natural(totals.unallocated_known, "known unallocated charges") > 0
			? number(totals.unallocated_credits, "unallocated credits") : null,
		byGoal: ids.map(goalId => {
			const receipts = tx.db.prepare(`SELECT count(json_extract(document,'$.credits')) AS known,
				COALESCE(sum(json_extract(document,'$.billing')<>'complete'),0) AS missing
				FROM native_usage WHERE goal_id=?`).get(goalId);
			if (!receipts) throw new FoundryError("accounting_invariant", "Goal accounting totals are unavailable");
			const manual = tx.db.prepare("SELECT count(*) AS n FROM usage WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id IN (SELECT id FROM tasks WHERE goal_id=?))").get(goalId)?.n;
			const known = natural(receipts.known, "known native charges") > 0 || natural(manual, "manual observations") > 0;
			return { goalId, reportedCredits: known ? tx.get("goals", goalId).credits : null,
				billing: !known ? "unavailable" : natural(receipts.missing, "missing goal billing") === 0 ? "complete" : "partial" };
		}),
		note: "Totals cover the requested goals and their correlated ambiguous receipts, not unrelated session spend. Unobserved restart/history gaps and uncorrelated charges stay incomplete; recorded workers and post-paid credits are not hard model/spend limits." };
}

/** @param {import("./database.mjs").Transaction} tx @param {string} attemptId @param {number} credits @param {string} eventId @param {string} actor @returns {Goal} */
export function recordUsage(tx, attemptId, credits, eventId, actor) {
	const attempt = tx.get("attempts", attemptId);
	requireReporter(tx, attempt, text(actor, "actor"));
	const amount = number(credits, "credits");
	if (amount < 0) throw new FoundryError("invalid_field", "Observed spending cannot be negative or refunded");
	text(eventId, "eventId");
	const goal = tx.get("goals", tx.get("tasks", attempt.taskId).goalId);
	const native = usageReceipts(tx, [eventId]);
	if (native?.credits !== undefined) {
		if (native.credits !== amount || !native.attemptIds.includes(attemptId)) {
			throw new FoundryError("usage_identity_conflict", "The manual observation conflicts with this actual native charge");
		}
		if (native.debitedCredits !== undefined) return goal;
		const recorded = settleUsage(tx, native);
		if (recorded.debitedCredits !== undefined) return tx.get("goals", goal.id);
	}
	const existing = tx.db.prepare("SELECT attempt_id,credits FROM usage WHERE event_id=?").get(eventId);
	if (existing) {
		if (existing.attempt_id !== attemptId || existing.credits !== amount) {
			throw new FoundryError("usage_identity_conflict", "Usage event identity cannot change its attempt or observed amount");
		}
		return goal;
	}
	tx.db.prepare("INSERT INTO usage(event_id,attempt_id,credits) VALUES(?,?,?)").run(eventId, attemptId, amount);
	goal.credits = number(goal.credits + amount, "total credits");
	tx.put("goals", goal);
	return goal;
}
