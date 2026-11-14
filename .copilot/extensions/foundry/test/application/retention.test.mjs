import assert from "node:assert/strict";
import test from "node:test";
import { createRetentionOperations } from "../../application/retention.mjs";
import { parseJson } from "../../data.mjs";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { fail } from "../../factory/fields.mjs";
import { createPlanStore } from "../../storage.mjs";
import { createRetentionPersistence } from "../../storage/retention.mjs";
import { createParallelFixture } from "../parallel/fixture.mjs";
import { createApproved, evidence, runTask, withOperations } from "./fixture.mjs";

const AT = "2026-11-13T00:00:01.000Z";
const scope = { repositoryId: "a".repeat(64), owner: "/fixture/owner", coordinatorSessionId: "owner-session", currentSessionId: "retention-session" };
const subject = { attempt: { repositoryId: scope.repositoryId, owner: scope.owner, planId: "finished-plan", taskId: "T-001", attemptId: "T-001-A001", reservationId: "reservation-1" },
	sessionId: "child-session", coordinatorSessionId: scope.coordinatorSessionId, worktreePath: "/fixture/child" };
/** @type {import("../../types/retention.js").RetentionEvent} */
const originalEvent = { version: 1, id: "completion-1", subject, revision: 3, sequence: 5, sourceCommit: "b".repeat(40),
	sourceDigest: "c".repeat(64), at: "2026-11-13T00:00:00.000Z", source: "synthetic canonical completion" };

/** Durable SQLite outbox but synthetic event/hold/host authorities: never a live archive.
 * @param {import("../../types/retention.js").RetentionEvent} [completion]
 * @param {import("../../types/retention.js").RetentionScope} [ownerScope] */
function harness(completion = originalEvent, ownerScope = scope) {
	const scope = ownerScope, subject = completion.subject;
	const fixture = createParallelFixture({ name: "retention-lifecycle", initialize(db) {
		db.exec("CREATE TABLE IF NOT EXISTS retention_fixture (id TEXT PRIMARY KEY, revision INTEGER, document TEXT)");
	} });
	const counts = { invocations: 0, guards: 0, reconciliations: 0, captures: 0, completions: 0, cancellations: 0, releases: 0, routes: 0 };
	const state = {
		event: structuredClone(completion), cancelled: false, failOutcome: false, throwInvocation: false,
		/** @type {import("../../types/retention.js").RetentionInventoryKind | null} */
		active: null,
		/** @type {import("../../types/retention.js").RetentionOutcome["disposition"]} */
		disposition: "archived",
		/** @type {import("../../types/retention.js").RetentionOutcome | null} */
		nativeOutcome: null,
		/** @type {(() => void) | null} */
		beforeStart: null,
		/** @type {((value: import("../../types/retention.js").RetentionObservation) => void) | null} */
		mutateCapture: null,
		/** @type {(() => Promise<void>) | null} */
		beforeInvoke: null,
	};
	/** @param {import("node:sqlite").DatabaseSync} db @param {string} id */
	const read = (db, id) => {
		const row = db.prepare("SELECT document FROM retention_fixture WHERE id = ?").get(id);
		return row ? parseJson(String(row.document)) : null;
	};
	/** @type {import("../../types/retention.js").RetentionCanonicalPort} */
	const canonical = {
		read: id => read(fixture.left.db, id),
		transaction(event, operation) {
			return fixture.left.storage.transaction(db => operation({
				assertCurrent(actual, assessment, mode) {
					assert.deepEqual(actual, event);
					if (mode === "start") state.beforeStart?.();
					if (stableStringify(actual) !== stableStringify(state.event)) fail("retention_event_changed", "Canonical retry/reopening superseded the old completion");
					if (state.cancelled) fail("retention_cancelled", "Canonical cancellation fence is active");
					if (mode === "start" && assessment?.observation.sequence !== counts.captures + 10) fail("revision_conflict", "Another capture superseded start");
				},
				read: id => read(db, id),
				insert(value) {
					db.prepare("INSERT INTO retention_fixture VALUES (?, ?, ?)").run(value.id, value.revision, stableStringify(value));
				},
				replace(value, revision) {
					if (state.failOutcome && value.outcomes.length) fail("retention_write_failed", "Synthetic result persistence failure");
					const changed = db.prepare("UPDATE retention_fixture SET revision = ?, document = ? WHERE id = ? AND revision = ?")
						.run(value.revision, stableStringify(value), value.id, revision);
					if (changed.changes !== 1) fail("revision_conflict", "Outbox revision changed");
				},
			}), { write: true });
		},
	};
	const persistence = createRetentionPersistence({ scope, canonical });
	/** @type {import("../../types/retention.js").RetentionObservationPort} */
	const observations = {
		async completion() { counts.completions++; return structuredClone(state.event); },
		async capture() {
			counts.captures++;
			const revision = counts.captures, sequence = counts.captures + 10;
			/** @type {import("../../types/retention.js").RetentionInventoryKind[]} */
			const kinds = ["tasks", "attempts", "runs", "sessions", "work", "prs", "merges", "automations", "consumers", "evaluators"];
			/** @type {import("../../types/retention.js").RetentionObservation} */
			const value = { version: 1, subject, eventId: state.event.id, eventRevision: state.event.revision, eventSequence: state.event.sequence,
				revision, sequence, capturedAt: AT, validUntil: "2026-11-13T00:01:00.000Z", source: "synthetic exhaustive capture", ownership: "owned",
				inventories: kinds.map(kind => {
					const id = kind === "tasks" ? "T-001" : kind === "attempts" ? "T-001-A001" : kind === "sessions" ? "child-session" : `${kind}-1`;
					return { kind, revision, sequence, source: "synthetic inventory authority", coverage: "exhaustive", nextCursor: null, knownIds: [id],
						items: [{ id, subject, state: state.active === kind ? "active" : "terminal", revision, sequence, source: "original synthetic state", authority: `${kind} owner` }] };
				}), workspace: { state: "observed", tracked: [], untracked: [], ignored: [] } };
			state.mutateCapture?.(value);
			return value;
		},
	};
	/** @type {import("../../types/retention.js").RetentionArtifactPort} */
	const artifacts = {
		async inspect(_event, observation) {
			/** @type {import("../../types/retention.js").RetentionArtifactKind[]} */
			const kinds = ["source", "ref", "context", "decision", "report", "evaluator", "artifact"];
			return { version: 1, subject, sourceCommit: completion.sourceCommit, sourceDigest: completion.sourceDigest, sequence: observation.sequence,
				capturedAt: AT, source: "synthetic retained bytes", retainedRoot: "/fixture/retained", required: kinds.map(kind => ({ kind, id: kind })),
				items: kinds.map(kind => ({ kind, id: kind, digest: "d".repeat(64), location: `/fixture/retained/${kind}`, state: "retained", source: "synthetic artifact receipt" })) };
		},
	};
	/** @type {import("../../types/retention.js").RetentionArchivePort} */
	const archive = {
		async withSubjectGuard(value, action) {
			assert.deepEqual(value, subject);
			counts.guards++;
			return action(async request => {
				counts.invocations++; counts.routes++;
				await state.beforeInvoke?.();
				state.nativeOutcome = { version: 1, operationId: request.operationId, subject, disposition: state.disposition,
					source: "original synthetic archive route", at: AT, receipt: { operation: request.operationId, disposition: state.disposition },
					error: state.disposition === "archived" ? null : { code: state.disposition, message: "original native error" } };
				if (state.throwInvocation) throw new Error("transport lost after possible invocation");
				return state.nativeOutcome;
			});
		},
		async reconcile(request) {
			counts.reconciliations++;
			assert.equal(request.operationId, state.nativeOutcome?.operationId ?? request.operationId);
			return state.nativeOutcome;
		},
	};
	const make = (host = archive) => createRetentionOperations({ scope, persistence, observations, artifacts, archive: host, clock: () => AT });
	const withoutHost = () => createRetentionOperations({ scope, persistence, observations, artifacts, clock: () => AT });
	return { fixture, counts, state, persistence, canonical, observations, artifacts, archive, make, withoutHost };
}
/** @param {import("../../types/retention.js").RetentionResult} result */
function intentId(result) { assert.ok(result.intent); return result.intent.id; }
/** @param {import("../../types/retention.js").RetentionResult} result @param {string} code */
function held(result, code) {
	assert.equal(result.state, "held");
	assert.ok(result.holds.some(hold => hold.code === code), `${code}: ${JSON.stringify(result.holds)}`);
}

test("RET-C05 completion is one durable assessment only; duplicate/reordered delivery and restart do not start effects", async () => {
	const h = harness();
	try {
		const first = await h.make().completionEvent({ eventId: originalEvent.id });
		assert.equal(first.state, "candidate");
		assert.deepEqual(await h.make().completionEvent({ eventId: originalEvent.id }), first);
		assert.equal(h.counts.captures, 1);
		assert.equal(h.counts.invocations + h.counts.guards + h.counts.cancellations + h.counts.releases, 0);
		assert.deepEqual(h.persistence.read(intentId(first)), first.intent);
		h.state.event.revision--;
		held(await h.make().completionEvent({ eventId: originalEvent.id }), "retention_event_conflict");
		h.state.event = { ...originalEvent, sourceDigest: "e".repeat(64) };
		held(await h.make().completionEvent({ eventId: originalEvent.id }), "retention_event_conflict");
		h.state.event = { ...originalEvent, subject: { ...subject, sessionId: "other-session" } };
		held(await h.make().completionEvent({ eventId: originalEvent.id }), "retention_event_conflict");
		assert.equal(h.persistence.read(intentId(first))?.revision, 1);
	} finally { h.fixture.dispose(); }
});

test("RET-C05 completion, replay and restart cannot complete a different running canonical task", () => (
	withOperations(async ({ operations, workspacePath, notifications }) => {
		const approved = await createApproved(operations, workspacePath);
		const { plan: completed } = await runTask(operations, approved, "T-001", { sessionId: subject.sessionId });
		const finished = completed.tasks.find(task => task.id === "T-001"), attempt = finished?.attempts.at(-1);
		assert.ok(completed.factory && finished && attempt?.commit && attempt.sessionId);
		assert.equal(finished.status, "done");
		const reserved = await operations.reserveTask({
			planId: completed.id, expectedRevision: completed.revision, taskId: "T-002", reservationId: "still-running",
		});
		const before = await operations.attachTask({
			planId: completed.id, expectedRevision: reserved.plan.revision, taskId: "T-002",
			attemptId: reserved.attemptId, sessionId: "running-child", branch: "work/still-running",
		});
		const other = before.tasks.find(task => task.id === "T-002");
		assert.ok(other);
		assert.equal(other.status, "running");
		assert.equal(other.attempts.at(-1)?.status, "running");
		const notificationCount = notifications.length;
		const event = { ...originalEvent, revision: completed.revision, sequence: completed.revision,
			sourceCommit: attempt.commit, sourceDigest: analysisInputDigest(finished),
			subject: { ...subject, sessionId: attempt.sessionId, attempt: {
				repositoryId: completed.factory.repositoryId, owner: completed.factory.owner, planId: completed.id,
				taskId: finished.id, attemptId: attempt.id, reservationId: attempt.reservationId,
			} } };
		const h = harness(event, { ...scope, repositoryId: completed.factory.repositoryId, owner: completed.factory.owner });
		// Fresh canonical reads observe durable task/attempt changes, not a detached copy.
		const readPlan = () => createPlanStore({ workspacePath }).read(completed.id);
		const completion = h.observations.completion;
		h.observations.completion = async id => {
			assert.deepEqual((await readPlan()).tasks.find(task => task.id === finished.id), finished);
			return completion(id);
		};
		const assertOtherTaskUnchanged = async () => {
			const after = await readPlan();
			assert.deepEqual(after.tasks.find(task => task.id === other.id), other,
				"Retention must not complete another task or alter its attempts, evidence or delivery");
			assert.deepEqual(after, before, "Completion assessment must not mutate the canonical plan");
			assert.equal(notifications.length, notificationCount, "No canonical task mutation was emitted");
		};
		try {
			const app = h.make(), first = await app.completionEvent({ eventId: event.id });
			assert.equal(first.state, "candidate");
			await assertOtherTaskUnchanged();
			assert.deepEqual(await app.completionEvent({ eventId: event.id }), first);
			await assertOtherTaskUnchanged();
			assert.deepEqual(await h.make().completionEvent({ eventId: event.id }), first);
			await assertOtherTaskUnchanged();
			h.state.event.revision--;
			held(await h.make().completionEvent({ eventId: event.id }), "retention_event_conflict");
			await assertOtherTaskUnchanged();
			assert.equal(h.counts.completions, 4, "These are read-side completion observations, not task mutations");
			assert.equal(h.counts.invocations + h.counts.guards + h.counts.cancellations + h.counts.releases, 0);
		} finally { h.fixture.dispose(); }
		// Positive control: an actual task completion must trip the same state assertion.
		await operations.completeTask({
			planId: before.id, expectedRevision: before.revision, taskId: other.id, attemptId: reserved.attemptId,
			status: "done", resultSummary: "Synthetic observer positive control", evidence: evidence("Positive control"),
			branch: "work/still-running", commit: attempt.commit,
		});
		assert.equal((await readPlan()).tasks.find(task => task.id === other.id)?.status, "done");
		await assert.rejects(assertOtherTaskUnchanged, { code: "ERR_ASSERTION" });
	})
));

test("RET-C03/C08 held completion needs a genuine observed release; cleanup flags and replay cannot release holds", async () => {
	const h = harness();
	try {
		h.state.active = "consumers";
		const app = h.make(), first = await app.completionEvent({ eventId: originalEvent.id });
		held(first, "retention_consumers_active");
		held(await app.reassess({ eventId: originalEvent.id, subject, released: true }), "factory_input_invalid");
		assert.deepEqual(await app.completionEvent({ eventId: originalEvent.id }), first);
		held(await app.execute({ intentId: intentId(first) }), "retention_consumers_active");
		assert.equal(h.counts.invocations, 0);
		h.state.active = "evaluators";
		held(await app.reassess({ eventId: originalEvent.id, subject }), "retention_evaluators_active");
		h.state.active = null;
		const released = await app.reassess({ eventId: originalEvent.id, subject });
		assert.equal(released.state, "candidate");
		assert.equal(h.counts.invocations, 0, "Authority release schedules no implicit archive");
		const archived = await app.execute({ intentId: intentId(first) });
		assert.equal(archived.state, "archived");
		assert.equal(h.counts.invocations, 1);
		assert.ok(archived.intent?.assessments.some(entry => entry.holds.some(hold => hold.code === "retention_consumers_active")));
		assert.equal(h.counts.cancellations + h.counts.releases, 0);
	} finally { h.fixture.dispose(); }
});

test("RET-C08 reopening, new attempts, and cancellation between observation and admission produce zero invocations", async () => {
	for (const change of ["reopen", "retry", "cancel"]) {
		const h = harness();
		try {
			const app = h.make(), first = await app.completionEvent({ eventId: originalEvent.id });
			h.state.beforeStart = () => {
				if (change === "cancel") h.state.cancelled = true;
				else if (change === "reopen") h.state.event.revision++;
				else h.state.event.subject.attempt.attemptId = "T-001-A002";
			};
			held(await app.execute({ intentId: intentId(first) }), change === "cancel" ? "retention_cancelled" : "retention_event_changed");
			assert.equal(h.counts.invocations, 0);
			assert.equal(h.persistence.read(intentId(first))?.start, null);
		} finally { h.fixture.dispose(); }
	}
});

test("RET-C08 competing starts and restart during invocation never invoke the original operation twice", async () => {
	const h = harness();
	try {
		const app = h.make(), first = await app.completionEvent({ eventId: originalEvent.id }), id = intentId(first);
		/** @type {(() => void) | undefined} */
		let release;
		/** @type {(() => void) | undefined} */
		let signal;
		const entered = new Promise(resolve => { signal = () => resolve(null); });
		const gate = new Promise(resolve => { release = () => resolve(null); });
		h.state.beforeInvoke = async () => { signal?.(); await gate; };
		const executing = app.execute({ intentId: id });
		await entered;
		held(await h.make().execute({ intentId: id }), "retention_in_flight");
		held(await h.make().reconcile({ intentId: id }), "retention_in_flight");
		assert.equal(h.counts.invocations, 1);
		release?.();
		assert.equal((await executing).state, "archived");
		assert.equal((await h.make().execute({ intentId: id })).state, "archived");
		assert.equal(h.counts.invocations, 1);
	} finally { h.fixture.dispose(); }
});

test("RET-C08 restart after durable start but before invocation reconciles uncertainty, never blindly retries", async () => {
	const h = harness();
	try {
		const first = await h.make().completionEvent({ eventId: originalEvent.id });
		assert.ok(first.intent);
		const started = h.persistence.start(first.intent.id, first.intent.revision, first.intent.assessments[0].id);
		held(await h.make().execute({ intentId: started.id }), "retention_in_flight");
		held(await h.make().reconcile({ intentId: started.id }), "retention_in_flight");
		assert.equal(h.counts.invocations, 0);
		assert.equal(h.counts.reconciliations, 1);
	} finally { h.fixture.dispose(); }
});

test("RET-C07/C08 uncertain invocation and durable-write failures retain original results for read-only reconciliation", async () => {
	for (const failure of ["uncertain", "persistence"]) {
		const h = harness();
		try {
			const first = await h.make().completionEvent({ eventId: originalEvent.id }), id = intentId(first);
			h.state.throwInvocation = failure === "uncertain";
			h.state.failOutcome = failure === "persistence";
			const attempted = await h.make().execute({ intentId: id });
			held(attempted, failure === "uncertain" ? "retention_uncertain" : "retention_write_failed");
			if (failure === "persistence") assert.deepEqual(attempted.unpersisted, h.state.nativeOutcome);
			else assert.match(attempted.intent?.outcomes[0].error?.message ?? "", /transport lost/);
			await h.make().execute({ intentId: id });
			assert.equal(h.counts.invocations, 1);
			h.state.failOutcome = false;
			assert.equal((await h.make().reconcile({ intentId: id })).state, "archived");
			assert.equal(h.counts.invocations, 1);
			assert.equal(h.counts.routes, 1);
			const outcomes = h.persistence.read(id)?.outcomes;
			assert.equal(outcomes?.length, failure === "uncertain" ? 2 : 1);
			assert.deepEqual(outcomes?.at(-1), h.state.nativeOutcome);
		} finally { h.fixture.dispose(); }
	}
});

test("RET-C08 denied, unavailable and definitive failed outcomes are terminal without fallback or automatic retry", async () => {
	for (const disposition of /** @type {const} */ (["denied", "unavailable", "failed"])) {
		const h = harness();
		try {
			h.state.disposition = disposition;
			const app = h.make(), first = await app.completionEvent({ eventId: originalEvent.id }), id = intentId(first);
			const attempted = await app.execute({ intentId: id });
			held(attempted, `retention_${disposition}`);
			assert.deepEqual(attempted.intent?.outcomes[0], h.state.nativeOutcome);
			await h.make().execute({ intentId: id });
			await h.make().reconcile({ intentId: id });
			assert.equal(h.counts.invocations, 1);
			assert.equal(h.counts.reconciliations, 0);
			assert.equal(h.counts.routes, 1);
		} finally { h.fixture.dispose(); }
	}
});

test("RET-C09 policy/persistence/delegation are not action-time host permission; JSON cannot supply capabilities", async () => {
	const h = harness();
	try {
		const first = await h.withoutHost().completionEvent({ eventId: originalEvent.id }), id = intentId(first);
		assert.equal(first.state, "candidate");
		held(await h.withoutHost().execute({ intentId: id }), "retention_action_time_unsupported");
		for (const injected of [{ allowed: true }, { token: "granted" }, { digest: "e".repeat(64) }, { archive: { raceSafe: true } }, { completionDelegation: true }]) {
			held(await h.make().execute({ intentId: id, ...injected }), "factory_input_invalid");
		}
		for (const descriptor of [true, "e".repeat(64), { withSubjectGuard: "native-token", reconcile: "trusted" }, { raceSafe: true, permission: true }]) {
			// @ts-expect-error Negative boundary: JSON cannot implement the constructor-only host port.
			const app = createRetentionOperations({ scope, persistence: h.persistence, observations: h.observations, artifacts: h.artifacts, archive: descriptor, clock: () => AT });
			held(await app.execute({ intentId: id }), "retention_action_time_unsupported");
		}
		held(await h.make().completionEvent({ eventId: originalEvent.id, observation: { complete: true, owner: true } }), "factory_input_invalid");
		assert.equal(h.counts.invocations + h.counts.guards, 0);
		assert.equal(h.persistence.read(id)?.start, null);
	} finally { h.fixture.dispose(); }
});

test("RET-C08/C09 fresh guarded inspection catches newly active work; a prior candidate is not enough", async () => {
	const h = harness();
	try {
		const first = await h.make().completionEvent({ eventId: originalEvent.id });
		h.state.active = "runs";
		const attempted = await h.make().execute({ intentId: intentId(first) });
		held(attempted, "retention_runs_active");
		assert.equal(h.counts.invocations, 0);
		assert.equal(attempted.intent?.start, null);
	} finally { h.fixture.dispose(); }
});

test("RET-C07/C08 malformed or foreign native results remain original uncertain evidence without retry", async () => {
	for (const raw of [{ success: true, token: "permission" }, { version: 99 }, null]) {
		const h = harness();
		try {
			const host = { ...h.archive,
				/** @type {import("../../types/retention.js").RetentionArchivePort["withSubjectGuard"]} */
				async withSubjectGuard(value, action) {
					return h.archive.withSubjectGuard(value, invoke => action(async request => { await invoke(request); return raw; }));
				} };
			const first = await h.make(host).completionEvent({ eventId: originalEvent.id }), id = intentId(first);
			const attempted = await h.make(host).execute({ intentId: id });
			held(attempted, "retention_uncertain");
			assert.deepEqual(attempted.intent?.outcomes[0].receipt, raw);
			await h.make(host).execute({ intentId: id });
			assert.equal(h.counts.invocations, 1);
		} finally { h.fixture.dispose(); }
	}
});

test("RET-C06 unsupported canonical persistence holds before any host action", async () => {
	const h = harness();
	try {
		const app = createRetentionOperations({ scope, persistence: createRetentionPersistence({ scope }), observations: h.observations,
			artifacts: h.artifacts, archive: h.archive, clock: () => AT });
		held(await app.completionEvent({ eventId: originalEvent.id }), "retention_persistence_unsupported");
		assert.equal(h.counts.captures + h.counts.guards + h.counts.invocations, 0);
	} finally { h.fixture.dispose(); }
});
