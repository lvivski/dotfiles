import { fail, integer } from "../factory/fields.mjs";
import { retentionArchiveRequest, retentionEvent, retentionId, retentionIntent, retentionIntentId, retentionOutcome, retentionScope, sameRetention } from "../plan/retention.mjs";
import { synchronousTransition } from "./parallel-protocol.mjs";

/** @typedef {import("../types/retention.js").RetentionIntent} Intent */
/** @typedef {import("../types/retention.js").RetentionEvent} Event */
/** @typedef {import("../types/retention.js").RetentionTransaction} Transaction */

/** No schema, connection, claims or permission authority lives here. The baseline has
 * no archive outbox binding; supplying its dispatch journal cannot enable this adapter.
 * @param {{scope: import("../types/retention.js").RetentionScope, canonical?: import("../types/retention.js").RetentionCanonicalPort}} options
 * @returns {import("../types/retention.js").RetentionPersistencePort} */
export function createRetentionPersistence({ scope: inputScope, canonical }) {
	const scope = retentionScope(inputScope);
	function binding() {
		if (!canonical || typeof canonical.read !== "function" || typeof canonical.transaction !== "function") {
			fail("retention_persistence_unsupported", "Canonical archive transaction/outbox binding is unavailable; integration must supply it without reusing dispatch effects");
		}
		return canonical;
	}
	/** @param {Event} value */
	function owned(value) {
		const event = retentionEvent(value), subject = event.subject;
		if (subject.attempt.repositoryId !== scope.repositoryId || subject.attempt.owner !== scope.owner
			|| subject.coordinatorSessionId !== scope.coordinatorSessionId || [scope.currentSessionId, scope.coordinatorSessionId].includes(subject.sessionId)) {
			fail("retention_foreign", "The intent is not a distinct owned subject in this canonical writer scope");
		}
		return event;
	}
	/** @param {unknown} value @param {string} id */
	function decoded(value, id) {
		const intent = retentionIntent(value);
		owned(intent.event);
		if (intent.id !== id) fail("retention_intent_mismatch", "Canonical read returned another intent");
		return intent;
	}
	/** @param {string} id */
	function read(id) {
		id = retentionId(id, "intentId");
		const value = binding().read(id);
		return value === null ? null : decoded(value, id);
	}
	/** @template T @param {Event} event @param {(tx: Transaction) => T} operation */
	const transaction = (event, operation) => synchronousTransition(() => binding().transaction(owned(event), tx => synchronousTransition(() => operation(tx))));
	/** @param {Transaction} tx @param {Intent} after @param {number} revision */
	function save(tx, after, revision) {
		const checked = retentionIntent(after);
		if (revision === 0) tx.insert(structuredClone(checked));
		else tx.replace(structuredClone(checked), revision);
		return checked;
	}
	/** @param {Transaction} tx @param {string} id */
	function current(tx, id) {
		const value = tx.read(id);
		if (value === null) fail("retention_intent_missing", "No durable archive assessment intent exists");
		return decoded(value, id);
	}
	return {
		read,
		assess(eventValue, assessment) {
			const event = owned(eventValue), id = retentionIntentId(event);
			// Validate the full assessment and immutable bindings before entering the writer.
			const initial = retentionIntent({ version: 1, id, event, revision: 1, assessments: [assessment], start: null, outcomes: [] });
			return transaction(event, tx => {
				tx.assertCurrent(event, null, "assess");
				const value = tx.read(id);
				if (value === null) return save(tx, initial, 0);
				const before = decoded(value, id);
				if (!sameRetention(before.event, event)) fail("retention_event_conflict", "Completion identity/revision/payload cannot reuse an intent");
				if (before.assessments.some(entry => sameRetention(entry, assessment))) return before;
				if (before.start) fail("retention_already_started", "Started intents admit only original outcome reconciliation");
				const latest = before.assessments.at(-1);
				if (!latest || assessment.assessedAt < latest.assessedAt) fail("retention_assessment_stale", "Assessment time regressed");
				return save(tx, { ...before, revision: before.revision + 1, assessments: [...before.assessments, assessment] }, before.revision);
			});
		},
		start(id, expectedRevision, assessmentId) {
			const retained = read(id);
			if (!retained) fail("retention_intent_missing", "Archive cannot start without a durable intent");
			integer(expectedRevision, "expected intent revision");
			retentionId(assessmentId, "assessmentId");
			return transaction(retained.event, tx => {
				const before = current(tx, id);
				if (before.revision !== expectedRevision) fail("revision_conflict", "Intent changed before start admission");
				if (before.start) fail("retention_already_started", "An admitted operation is never invoked twice; reconcile its original result");
				const assessment = before.assessments.at(-1);
				if (!assessment || assessment.id !== assessmentId) fail("retention_assessment_stale", "Only the latest exact assessment may start");
				const start = retentionArchiveRequest(before, assessment);
				tx.assertCurrent(before.event, assessment, "start");
				return save(tx, { ...before, revision: before.revision + 1, start }, before.revision);
			});
		},
		outcome(id, outcomeValue) {
			const outcome = retentionOutcome(outcomeValue), retained = read(id);
			if (!retained) fail("retention_intent_missing", "Outcome cannot invent an intent");
			return transaction(retained.event, tx => {
				const before = current(tx, id);
				if (!before.start || before.start.operationId !== outcome.operationId || !sameRetention(before.event.subject, outcome.subject)) {
					fail("retention_outcome_mismatch", "Original outcome must name the exact admitted operation and subject");
				}
				if (before.outcomes.some(entry => sameRetention(entry, outcome))) return before;
				// No current/released assertion here: late evidence must survive reopening/cancellation.
				return save(tx, { ...before, revision: before.revision + 1, outcomes: [...before.outcomes, outcome] }, before.revision);
			});
		},
	};
}
