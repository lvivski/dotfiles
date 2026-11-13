import { stableStringify } from "../digest.mjs";
import { fail, integer } from "../factory/fields.mjs";
import { admissionIdentity, admissionRecord, effectReceipt } from "../plan/parallel-contracts.mjs";

/** Called only on a record loaded by T-003 inside its anchored synchronous transaction.
 * Imported documents and caller-supplied records are not authority.
 * @param {import("../types/parallel.js").AdmissionRecord} current
 * @param {import("../types/parallel.js").Fence} expected
 * @param {{settlement?: boolean}} [options] */
export function assertAdmissionFence(current, expected, { settlement = false } = {}) {
	admissionRecord(current);
	admissionIdentity(expected.admission);
	integer(expected.revision, "expected revision");
	integer(expected.epoch, "expected epoch", 0);
	if (stableStringify(current.identity) !== stableStringify(expected.admission)) fail("parallel_foreign_owner", "Admission fence belongs to another owner or attempt");
	if (current.revision !== expected.revision || current.epoch !== expected.epoch) fail("revision_conflict", "Admission revision or cancellation epoch changed; reread authoritative state");
	if (current.phase !== "reserved" && !(settlement && current.phase === "cancelling")) fail("parallel_fenced", "No new native effects after cancellation or before reservation");
}

/** Closed receipt transitions preserve immutable identities. Intent/start linearize before
 * asynchronous native effects. Outcomes may arrive after cancellation, never initiate work.
 * @param {import("../types/parallel.js").EffectReceipt} before
 * @param {import("../types/parallel.js").EffectReceipt} after */
export function assertEffectTransition(before, after) {
	effectReceipt(before); effectReceipt(after);
	const immutable = (/** @type {import("../types/parallel.js").EffectReceipt} */ receipt) => ({
		id: receipt.id, attempt: receipt.attempt, kind: receipt.kind, epoch: receipt.epoch, payloadDigest: receipt.payloadDigest,
	});
	if (stableStringify(immutable(before)) !== stableStringify(immutable(after))) fail("parallel_receipt_identity", "Effect identity or reserved payload changed");
	if (stableStringify(before) === stableStringify(after)) return;
	/** @type {Record<import("../types/parallel.js").EffectReceipt["state"], string[]>} */
	const allowed = {
		intent: ["in-flight", "cancelled-before-start"], "in-flight": ["succeeded", "definitive-failure", "uncertain"],
		uncertain: ["succeeded", "definitive-failure"], succeeded: [], "definitive-failure": [], "cancelled-before-start": [],
	};
	if (!allowed[before.state].includes(after.state) || Date.parse(after.at) < Date.parse(before.at)) fail("parallel_effect_transition", "Illegal or retroactive effect transition");
	if (before.sessionId && before.sessionId !== after.sessionId || before.runId && before.runId !== after.runId) fail("parallel_receipt_identity", "Native returned identity cannot change");
}

/** Reject asynchronous work while the SQLite writer lock is held.
 * @template T @param {() => T} operation @returns {T} */
export function synchronousTransition(operation) {
	const result = operation();
	if (result && (typeof result === "object" || typeof result === "function") && "then" in result) {
		fail("parallel_async_transaction", "Native calls must follow a committed intent, outside the writer transaction");
	}
	return result;
}
