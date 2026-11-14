import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parseJson } from "../../data.mjs";
import { stableStringify } from "../../digest.mjs";
import { fail } from "../../factory/fields.mjs";
import { assessRetention, retentionIntentId } from "../../plan/retention.mjs";
import { effectReceipt } from "../../plan/parallel-contracts.mjs";
import { createAdmissionStore, admissionFence } from "../../storage/admission.mjs";
import { createRetentionPersistence } from "../../storage/retention.mjs";
import { createParallelFixture } from "../parallel/fixture.mjs";

const AT = "2026-11-13T00:00:01.000Z";
const scope = { repositoryId: "a".repeat(64), owner: "/fixture/owner", coordinatorSessionId: "owner-session", currentSessionId: "retention-session" };
const identity = { repositoryId: scope.repositoryId, owner: scope.owner, planId: "finished-plan", taskId: "T-001", reservationId: "reservation-1" };
const subject = { attempt: { ...identity, attemptId: "T-001-A001" }, sessionId: "child-session", coordinatorSessionId: scope.coordinatorSessionId, worktreePath: "/fixture/child" };
/** @type {import("../../types/retention.js").RetentionEvent} */
const event = { version: 1, id: "completion-1", subject, revision: 3, sequence: 5,
	sourceCommit: "b".repeat(40), sourceDigest: "c".repeat(64), at: "2026-11-13T00:00:00.000Z", source: "synthetic canonical completion" };
/** @returns {import("../../types/retention.js").RetentionAssessment} */
function candidate() {
	/** @type {import("../../types/retention.js").RetentionInventoryKind[]} */
	const inventories = ["tasks", "attempts", "runs", "sessions", "work", "prs", "merges", "automations", "consumers", "evaluators"];
	/** @type {import("../../types/retention.js").RetentionArtifactKind[]} */
	const kinds = ["source", "ref", "context", "decision", "report", "evaluator", "artifact"];
	return assessRetention(scope, event, {
		version: 1, subject, eventId: event.id, eventRevision: event.revision, eventSequence: event.sequence, revision: 1, sequence: 10,
		capturedAt: AT, validUntil: "2026-11-13T00:01:00.000Z", source: "synthetic capture", ownership: "owned",
		inventories: inventories.map(kind => {
			const id = kind === "tasks" ? "T-001" : kind === "attempts" ? "T-001-A001" : kind === "sessions" ? "child-session" : null;
			return { kind, revision: 1, sequence: 10, source: "synthetic authority", coverage: "exhaustive", nextCursor: null,
				knownIds: id ? [id] : [], items: id ? [{ id, subject, state: "terminal", revision: 1, sequence: 9, source: "original receipt", authority: "canonical owner" }] : [] };
		}), workspace: { state: "observed", tracked: [], untracked: [], ignored: [] },
	}, {
		version: 1, subject, sourceCommit: event.sourceCommit, sourceDigest: event.sourceDigest, sequence: 10, capturedAt: AT, source: "synthetic artifacts", retainedRoot: "/fixture/retained",
		required: kinds.map(kind => ({ kind, id: kind })),
		items: kinds.map(kind => ({ kind, id: kind, digest: "d".repeat(64), location: `/fixture/retained/${kind}`, state: "retained", source: "original bytes" })),
	}, AT);
}
/** Real production admission fences; the auxiliary table is explicitly a synthetic,
 * unwired outbox harness, not a production archive schema or terminal-archive capability. */
function harness() {
	const fixture = createParallelFixture({ name: "retention-fences" });
	const admissions = createAdmissionStore({ workspacePath: fixture.workspacePath, repositoryId: scope.repositoryId, owner: scope.owner,
		directoryParts: ["files", "admission"], busyTimeoutMs: 1, clock: () => AT });
	const claim = admissions.claim({ identity, expectedRevision: 0, resources: [], team: null });
	admissions.bindReservation(admissionFence(claim), subject.attempt);
	const current = () => { const row = admissions.read(identity); assert.ok(row); return row; };
	admissions.withFence(admissionFence(current()), ({ db }) => {
		db.exec("CREATE TABLE retention_outbox_fixture (id TEXT PRIMARY KEY, revision INTEGER, document TEXT)");
	});
	/** @param {DatabaseSync} db @param {string} id */
	const read = (db, id) => {
		const row = db.prepare("SELECT document FROM retention_outbox_fixture WHERE id = ?").get(id);
		return row ? parseJson(String(row.document)) : null;
	};
	/** @type {import("../../types/retention.js").RetentionCanonicalPort} */
	const canonical = {
		read(id) {
			const db = new DatabaseSync(admissions.databasePath, { readOnly: true });
			try { return read(db, id); } finally { db.close(); }
		},
		transaction(expected, operation) {
			return admissions.withFence(admissionFence(current()), ({ db, admission }) => operation({
				assertCurrent(actual, _assessment, mode) {
					assert.deepEqual(actual, expected);
					if (mode === "start" && admission.phase !== "reserved") fail("parallel_fenced", "Cancelled before synthetic archive admission");
					assert.deepEqual(actual, event);
				},
				read: id => read(db, id),
				insert(value) {
					db.prepare("INSERT INTO retention_outbox_fixture VALUES (?, ?, ?)").run(value.id, value.revision, stableStringify(value));
				},
				replace(value, revision) {
					const changed = db.prepare("UPDATE retention_outbox_fixture SET revision = ?, document = ? WHERE id = ? AND revision = ?")
						.run(value.revision, stableStringify(value), value.id, revision);
					if (changed.changes !== 1) fail("revision_conflict", "Synthetic outbox CAS lost");
				},
			}));
		},
	};
	const store = createRetentionPersistence({ scope, canonical });
	return { fixture, admissions, current, canonical, store };
}
/** @param {import("../../types/retention.js").RetentionIntent} intent
 * @param {import("../../types/retention.js").RetentionOutcome["disposition"]} [disposition]
 * @returns {import("../../types/retention.js").RetentionOutcome} */
function outcome(intent, disposition = "uncertain") {
	assert.ok(intent.start);
	return { version: 1, operationId: intent.start.operationId, subject, disposition, source: "original synthetic native receipt", at: AT,
		receipt: { original: disposition }, error: disposition === "archived" ? null : { code: "fixture", message: "original failure" } };
}

test("RET-C06 baseline omission explicitly holds; the existing journal cannot manufacture archive persistence", () => {
	const store = createRetentionPersistence({ scope });
	assert.throws(() => store.assess(event, candidate()), { code: "retention_persistence_unsupported" });
	assert.throws(() => store.read(retentionIntentId(event)), { code: "retention_persistence_unsupported" });
	assert.throws(() => effectReceipt({ id: "archive-effect", attempt: subject.attempt, kind: "archive", epoch: 0,
		payloadDigest: event.sourceDigest, state: "intent", sessionId: null, runId: null, source: "unsupported archive", at: AT }),
		{ code: "factory_input_invalid" });
});

test("RET-C05/C07 exact intents replay after restart and reject changed completion identity/payload", () => {
	const h = harness();
	try {
		const assessment = candidate(), first = h.store.assess(event, assessment);
		assert.equal(first.start, null);
		assert.equal(first.outcomes.length, 0);
		assert.deepEqual(h.store.assess(event, assessment), first);
		const restarted = createRetentionPersistence({ scope, canonical: h.canonical });
		assert.deepEqual(restarted.read(first.id), first);
		for (const changed of [{ ...event, revision: 4 }, { ...event, sourceDigest: "e".repeat(64) }, { ...event, subject: { ...subject, sessionId: "different-child" } }]) {
			assert.throws(() => restarted.assess(changed, assessment));
		}
		assert.deepEqual(restarted.read(first.id), first);
		assert.throws(() => restarted.assess({ ...event, subject: { ...subject, attempt: { ...subject.attempt, owner: "/foreign" } } }, assessment), { code: "retention_foreign" });
	} finally { h.fixture.dispose(); }
});

test("RET-C06/C07 single-start CAS uses real confined SQLite admission fences and preserves immutable request", () => {
	const h = harness();
	try {
		const prepared = h.store.assess(event, candidate());
		const other = createRetentionPersistence({ scope, canonical: h.canonical });
		const started = h.store.start(prepared.id, prepared.revision, prepared.assessments[0].id);
		assert.ok(started.start);
		assert.equal(started.start.sourceDigest, event.sourceDigest);
		assert.equal(started.start.completionRevision, event.revision);
		assert.equal(started.start.subject.attempt.reservationId, identity.reservationId);
		assert.throws(() => other.start(prepared.id, prepared.revision, prepared.assessments[0].id), { code: "revision_conflict" });
		assert.throws(() => other.start(prepared.id, started.revision, prepared.assessments[0].id), { code: "retention_already_started" });
		assert.deepEqual(other.read(prepared.id), started);
		const fence = admissionFence(h.current());
		const competitor = createAdmissionStore({ workspacePath: h.fixture.workspacePath, repositoryId: scope.repositoryId, owner: scope.owner,
			directoryParts: ["files", "admission"], busyTimeoutMs: 1, clock: () => AT });
		h.admissions.withFence(fence, () => {
			assert.throws(() => competitor.cancel(fence), { code: "storage_busy" });
		});
	} finally { h.fixture.dispose(); }
});

test("RET-C06/C08 cancellation fences starts and baseline settled admission cannot act as an archive binding", () => {
	const h = harness();
	try {
		const prepared = h.store.assess(event, candidate());
		h.admissions.cancel(admissionFence(h.current()));
		assert.throws(() => h.store.start(prepared.id, prepared.revision, prepared.assessments[0].id), { code: "parallel_fenced" });
		assert.equal(h.store.read(prepared.id)?.start, null);
	} finally { h.fixture.dispose(); }
	const terminal = harness();
	try {
		const prepared = terminal.store.assess(event, candidate());
		terminal.admissions.deliver(admissionFence(terminal.current()), {
			attempt: subject.attempt, sessionId: subject.sessionId, commit: event.sourceCommit, planRevision: event.revision, source: "synthetic delivery", terminalRunIds: [],
		});
		assert.throws(() => terminal.store.start(prepared.id, prepared.revision, prepared.assessments[0].id), { code: "parallel_fenced" });
	} finally { terminal.fixture.dispose(); }
});

test("RET-C07 append-only outcomes preserve raw failures and exact idempotency, including after cancellation", () => {
	const h = harness();
	try {
		const prepared = h.store.assess(event, candidate());
		const started = h.store.start(prepared.id, prepared.revision, prepared.assessments[0].id);
		const failure = outcome(started);
		assert.throws(() => h.store.outcome(started.id, { ...failure, at: event.at }), { code: "retention_outcome_stale" });
		const failed = h.store.outcome(started.id, failure);
		assert.deepEqual(h.store.outcome(started.id, failure), failed);
		h.admissions.cancel(admissionFence(h.current()));
		const success = { ...outcome(started, "archived"), at: "2026-11-13T00:00:02.000Z" };
		const recovered = h.store.outcome(started.id, success);
		assert.deepEqual(recovered.outcomes, [failure, success]);
		assert.deepEqual(h.store.outcome(started.id, failure), recovered, "Replayed original failure cannot overwrite the later exact outcome");
		assert.throws(() => h.store.outcome(started.id, { ...failure, receipt: { changed: true } }), { code: "retention_outcome_conflict" });
		assert.throws(() => h.store.outcome(started.id, { ...failure, operationId: "foreign-operation" }), { code: "retention_outcome_mismatch" });
		assert.throws(() => h.store.outcome(started.id, { ...failure, receipt: "x".repeat(65537) }), { code: "retention_outcome_overflow" });
		assert.deepEqual(h.store.read(started.id), recovered);
	} finally { h.fixture.dispose(); }
});
