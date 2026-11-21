import { createHash } from "node:crypto";
import { qualifiedProduct } from "./evidence.mjs";

/** @param {unknown} value @returns {number|null} */
export function instant(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/** @param {number|null} start @param {number|null} end */
const elapsed = (start, end) => start !== null && end !== null && end >= start ? end - start : null;
/** @param {import("./model.js").Effect} e */
const creation = e => e.kind === "writer" && e.tool === "create_session";
/** @param {import("./model.js").Effect} e */
const pendingBinding = e => e.state === "issued" || e.state === "uncertain";

/** Timing does not read kickoffs or assemble usage identities. Retired bindings still count.
 * @param {import("./model.js").Run} run */
export function timingFacts(run) {
	const activatedAt = instant(run.activatedAt), qualified = qualifiedProduct(run), qualifiedAt = instant(qualified?.qualifiedAt);
	const baseline = !!run.goal && !!qualified && qualified.commit === qualified.target && !Object.keys(qualified.outputs).length;
	let boundAt = null, bound = false, unknownClock = false, unconfirmed = false;
	for (const e of run.effects) {
		if (!creation(e)) continue;
		if (pendingBinding(e)) unconfirmed = true;
		if (e.state !== "done" || !e.nativeId) continue;
		bound = true;
		const at = instant(e.boundAt);
		if (at === null) unknownClock = true;
		else if (boundAt === null || at < boundAt) boundAt = at;
	}
	if (unknownClock) boundAt = null;
	return {
		run: run.id, activatedAt,
		firstWriter: { state: bound ? "bound" : unconfirmed ? "unconfirmed" : baseline ? "not-applicable" : "not-bound",
			boundAt, elapsedMs: elapsed(activatedAt, boundAt) },
		qualified: { commit: qualified?.commit ?? null, qualifiedAt, elapsedMs: elapsed(activatedAt, qualifiedAt), baseline },
	};
}

/** Private input to the separately requested attribution query, never part of a portable record.
 * @param {import("./model.js").Run} run */
export function metricsFacts(run) {
	const timing = timingFacts(run), { boundAt } = timing.firstWriter;
	const creates = run.effects.filter(creation);
	const writers = creates.flatMap(e => {
		if (e.state !== "done" || !e.nativeId) return [];
		const k = e.args.kickoff;
		const prompt = k && typeof k === "object" && !Array.isArray(k) && k.prompt;
		return [{ nativeId: e.nativeId, boundAt: instant(e.boundAt),
			kickoffHash: typeof prompt === "string" && prompt.length ? createHash("sha256").update(prompt).digest("hex") : null }];
	});
	return {
		...timing,
		firstWriter: { ...timing.firstWriter, nativeIds: boundAt === null ? [] : [...new Set(writers.filter(w => w.boundAt === boundAt).map(w => w.nativeId))] },
		history: { owner: run.owner, writers, hasUnconfirmedWriters: creates.some(pendingBinding), workflowIds: [...new Set(run.effects.flatMap(e =>
			e.kind === "scout" && e.tool === "workflow" && e.workflowId ? [e.workflowId] : []))] },
	};
}
