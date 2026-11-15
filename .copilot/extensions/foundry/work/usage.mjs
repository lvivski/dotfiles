import { FoundryError, digest, natural, number, record, strings, text } from "./values.mjs";

/** @param {unknown} value @returns {import("./model.d.ts").UsageAffinity} */
export function decodeUsageAffinity(value) {
	const row = record(value);
	const startedAt = text(row.startedAt, "native request start");
	if (!Number.isFinite(Date.parse(startedAt))) throw new FoundryError("invalid_field", "Native request start must be an actual timestamp");
	return { id: text(row.id, "affinity id"), groupId: text(row.groupId, "native affinity group"),
		startedAt: new Date(startedAt).toISOString(), nativeId: text(row.nativeId, "native session"),
		attemptIds: strings(row.attemptIds), ...(row.token === undefined ? {} : { token: text(row.token, "assignment token") }) };
}

/** @param {unknown} value @returns {import("./model.d.ts").NativeUsage} */
export function decodeNativeUsage(value) {
	const row = record(value);
	const credits = row.credits === undefined ? undefined : number(row.credits, "observed credits");
	const debitedCredits = row.debitedCredits === undefined ? undefined : number(row.debitedCredits, "debited credits");
	if ((credits !== undefined && credits < 0) || (debitedCredits !== undefined && debitedCredits < 0)) {
		throw new FoundryError("invalid_field", "Native charges cannot be negative or refunded");
	}
	const billing = row.billing;
	if (billing !== "complete" && billing !== "partial" && billing !== "unavailable") throw new FoundryError("invalid_field", "Unknown native billing status");
	return { id: text(row.id, "native usage id"), nativeId: text(row.nativeId, "native session"),
		sourceSessionId: text(row.sourceSessionId, "accounting source"), aliases: strings(row.aliases),
		attemptIds: strings(row.attemptIds), billing,
		...(row.sequence === undefined ? {} : { sequence: natural(row.sequence, "usage sequence") }),
		...(credits === undefined ? {} : { credits }),
		...(debitedCredits === undefined ? {} : { debitedCredits }),
		...(row.token === undefined ? {} : { token: text(row.token, "assignment token") }),
		...(row.attemptId === undefined ? {} : { attemptId: text(row.attemptId, "attempt id") }),
		...(row.goalId === undefined ? {} : { goalId: text(row.goalId, "goal id") }) };
}

/** @param {string} actor @param {unknown} [agentId] */
export function affinityId(actor, agentId) {
	return `affinity:${digest([text(actor, "native session"), agentId === undefined ? null : text(agentId, "agent id")])}`;
}

/** @param {unknown} value @param {string} actor @param {import("./model.d.ts").UsageAffinity|undefined} affinity */
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
