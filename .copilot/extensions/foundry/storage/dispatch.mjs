import { parseJson, readJsonValue } from "../data.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { fail } from "../factory/fields.mjs";
import { attemptIdentity, effectReceipt } from "../plan/parallel-contracts.mjs";
import { assertAdmissionFence, assertEffectTransition } from "./parallel-protocol.mjs";

/** @typedef {import("../types/parallel.js").AttemptIdentity} Attempt */
/** @typedef {import("../types/parallel.js").EffectReceipt} Receipt */
/** @typedef {import("../types/parallel.js").FencedTransaction} Transaction */
/** @typedef {import("../types/json.js").JsonValue} Json */
/** @typedef {<T>(operation: (db: import("node:sqlite").DatabaseSync) => T) => T} ReadDatabase */

/** Called by the admission database's initializer, not a second store.
 * @param {import("node:sqlite").DatabaseSync} db */
export function initializeDispatchJournal(db) {
	db.exec(`CREATE TABLE IF NOT EXISTS dispatch_effects (
		attempt TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
		receipt TEXT NOT NULL, payload TEXT,
		PRIMARY KEY (attempt, kind), UNIQUE (attempt, id)
	);
	CREATE TABLE IF NOT EXISTS dispatch_outcomes (
		attempt TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, outcome TEXT NOT NULL,
		PRIMARY KEY (attempt, id, digest)
	)`);
}

/** @param {Attempt} attempt */
const key = (attempt) => stableStringify(attemptIdentity(attempt));

/** Admission owners hydrate receipts from this table before cancellation/settlement.
 * @param {import("node:sqlite").DatabaseSync} db @param {Attempt} attempt */
export function readDispatchReceipts(db, attempt) {
	return db.prepare("SELECT receipt FROM dispatch_effects WHERE attempt = ? ORDER BY rowid")
		.all(key(attempt)).map(row => effectReceipt(parseJson(String(row.receipt))));
}

/** No claim, capacity, reservation or release mutation is exposed here.
 * @param {{read: ReadDatabase}} options */
export function createDispatchJournal({ read }) {
	/** @param {Transaction} tx @param {Attempt} attempt @param {boolean} settlement */
	function fence(tx, attempt, settlement) {
		if (!tx.db.isTransaction) fail("dispatch_transaction_required", "Journal writes require the admission writer transaction");
		assertAdmissionFence(tx.admission, tx.fence, { settlement });
		if (stableStringify(tx.admission.attempt) !== key(attempt)) fail("parallel_foreign_owner", "Receipt is not for the fenced attempt");
		const ordered = (/** @type {Receipt[]} */ receipts) => [...receipts].sort((a, b) => a.id.localeCompare(b.id));
		if (stableStringify(ordered(tx.admission.receipts)) !== stableStringify(ordered(readDispatchReceipts(tx.db, attempt)))) {
			fail("dispatch_journal_mismatch", "Admission receipts and side-effect journal diverged; reconcile before mutating");
		}
	}
	/** @param {Transaction} tx */
	function hydrate(tx) {
		if (tx.admission.attempt) tx.admission.receipts = readDispatchReceipts(tx.db, tx.admission.attempt);
	}
	/** @param {Transaction} tx @param {Receipt} receipt */
	function intent(tx, receipt) {
		receipt = effectReceipt(receipt);
		fence(tx, receipt.attempt, false);
		if (receipt.state !== "intent" || receipt.epoch !== tx.fence.epoch) fail("dispatch_intent_invalid", "New effects require a current-epoch intent");
		const existing = readDispatchReceipts(tx.db, receipt.attempt).find(item => item.kind === receipt.kind);
		if (existing) {
			if (existing.id !== receipt.id || existing.payloadDigest !== receipt.payloadDigest || existing.epoch !== receipt.epoch) {
				fail("parallel_receipt_identity", "The attempt already has a different prepared effect");
			}
			return existing;
		}
		tx.db.prepare("INSERT INTO dispatch_effects VALUES (?, ?, ?, ?, NULL)")
			.run(key(receipt.attempt), receipt.kind, receipt.id, stableStringify(receipt));
		hydrate(tx);
		return receipt;
	}
	/** @param {Transaction} tx @param {string} id */
	function current(tx, id) {
		if (!tx.admission.attempt) fail("dispatch_attempt_missing", "A reservation is required");
		const receipt = readDispatchReceipts(tx.db, tx.admission.attempt).find(item => item.id === id);
		if (!receipt) fail("dispatch_intent_missing", "Native effect has no durable intent");
		return receipt;
	}
	/** @param {Transaction} tx @param {Receipt} receipt */
	function recordOutcome(tx, receipt) {
		receipt = effectReceipt(receipt);
		fence(tx, receipt.attempt, true);
		const before = current(tx, receipt.id);
		if (receipt.state === "intent" || receipt.state === "in-flight") fail("dispatch_outcome_invalid", "Outcome cannot start a native effect");
		assertEffectTransition(before, receipt);
		tx.db.prepare("UPDATE dispatch_effects SET receipt = ? WHERE attempt = ? AND id = ?")
			.run(stableStringify(receipt), key(receipt.attempt), receipt.id);
		hydrate(tx);
		return receipt;
	}
	return {
		/** @param {Attempt} attempt */
		read: (attempt) => read(db => readDispatchReceipts(db, attempt)),
		intent,
		/** Atomically pins the entire prepared payload, including producer inputs.
		 * @param {Transaction} tx @param {Receipt} receipt @param {Json} payload */
		prepare(tx, receipt, payload) {
			payload = readJsonValue(payload);
			if (analysisInputDigest(payload) !== receipt.payloadDigest) fail("parallel_receipt_identity", "Prepared payload digest differs");
			const result = intent(tx, receipt);
			const row = tx.db.prepare("SELECT payload FROM dispatch_effects WHERE attempt = ? AND id = ?").get(key(receipt.attempt), receipt.id);
			const encoded = stableStringify(payload);
			if (row?.payload !== null && row?.payload !== encoded) fail("parallel_receipt_identity", "Prepared native payload changed");
			tx.db.prepare("UPDATE dispatch_effects SET payload = ? WHERE attempt = ? AND id = ?")
				.run(encoded, key(receipt.attempt), receipt.id);
			return result;
		},
		/** A duplicate start throws: returning an in-flight receipt would grant two callers the slot.
		 * @param {Transaction} tx @param {string} id */
		start(tx, id) {
			const before = current(tx, id);
			fence(tx, before.attempt, false);
			if (before.state !== "intent") fail("dispatch_already_started", "Reconcile the existing effect; do not invoke it again");
			const after = { ...before, state: /** @type {const} */ ("in-flight") };
			assertEffectTransition(before, after);
			tx.db.prepare("UPDATE dispatch_effects SET receipt = ? WHERE attempt = ? AND id = ?")
				.run(stableStringify(after), key(after.attempt), id);
			hydrate(tx);
			return after;
		},
		recordOutcome,
		/** Retain the transport receipt and transition in the same writer transaction.
		 * @param {Transaction} tx @param {Receipt} receipt @param {Json} outcome */
		recordResult(tx, receipt, outcome) {
			const result = recordOutcome(tx, receipt);
			const encoded = stableStringify(readJsonValue(outcome));
			tx.db.prepare("INSERT OR IGNORE INTO dispatch_outcomes VALUES (?, ?, ?, ?)")
				.run(key(receipt.attempt), receipt.id, analysisInputDigest(outcome), encoded);
			return result;
		},
		/** @param {Attempt} attempt @param {Receipt["kind"]} kind */
		payload(attempt, kind) {
			return read(db => {
				const row = db.prepare("SELECT payload FROM dispatch_effects WHERE attempt = ? AND kind = ?").get(key(attempt), kind);
				return row?.payload == null ? null : readJsonValue(parseJson(String(row.payload)));
			});
		},
		/** @param {Attempt} attempt @param {string} id */
		outcomes(attempt, id) {
			return read(db => db.prepare("SELECT outcome FROM dispatch_outcomes WHERE attempt = ? AND id = ? ORDER BY rowid")
				.all(key(attempt), id).map(row => readJsonValue(parseJson(String(row.outcome)))));
		},
	};
}
