import assert from "node:assert/strict";
import test from "node:test";
import { assessRetention, retentionEvent, retentionManifest, retentionObservation, retentionSubject } from "../../plan/retention.mjs";

const AT = "2026-11-13T00:00:01.000Z";
const scope = { repositoryId: "a".repeat(64), owner: "/fixture/owner", coordinatorSessionId: "owner-session", currentSessionId: "retention-session" };
const subject = { attempt: { repositoryId: scope.repositoryId, owner: scope.owner, planId: "finished-plan", taskId: "T-001", attemptId: "T-001-A001", reservationId: "reservation-1" },
	sessionId: "child-session", coordinatorSessionId: scope.coordinatorSessionId, worktreePath: "/fixture/child" };
/** @returns {import("../../types/retention.js").RetentionEvent} */
const event = () => ({ version: 1, id: "completion-1", subject: structuredClone(subject), revision: 3, sequence: 5,
	sourceCommit: "b".repeat(40), sourceDigest: "c".repeat(64), at: "2026-11-13T00:00:00.000Z", source: "canonical completion receipt" });
/** @returns {import("../../types/retention.js").RetentionObservation} */
function observation() {
	/** @type {import("../../types/retention.js").RetentionInventoryKind[]} */
	const kinds = ["tasks", "attempts", "runs", "sessions", "work", "prs", "merges", "automations", "consumers", "evaluators"];
	return { version: 1, subject: structuredClone(subject), eventId: event().id, eventRevision: 3, eventSequence: 5,
		revision: 1, sequence: 10, capturedAt: AT, validUntil: "2026-11-13T00:01:00.000Z", source: "synthetic exhaustive capture", ownership: "owned",
		inventories: kinds.map(kind => {
			const id = kind === "tasks" ? "T-001" : kind === "attempts" ? "T-001-A001" : kind === "sessions" ? "child-session" : `${kind}-1`;
			return { kind, revision: 1, sequence: 10, source: `${kind} capture`, coverage: "exhaustive", nextCursor: null, knownIds: [id],
				items: [{ id, subject: structuredClone(subject), state: "terminal", revision: 1, sequence: 9, source: `${kind} original receipt`, authority: `${kind} owner` }] };
		}), workspace: { state: "observed", tracked: [], untracked: [], ignored: [] } };
}
/** @returns {import("../../types/retention.js").RetentionManifest} */
function manifest() {
	/** @type {import("../../types/retention.js").RetentionArtifactKind[]} */
	const kinds = ["source", "ref", "context", "decision", "report", "evaluator", "artifact"];
	return { version: 1, subject: structuredClone(subject), sourceCommit: event().sourceCommit, sourceDigest: event().sourceDigest,
		sequence: 10, capturedAt: AT, source: "synthetic artifact inspection; no live retention claimed", retainedRoot: "/fixture/retained",
		required: kinds.map(kind => ({ kind, id: `${kind}-1` })),
		items: kinds.map(kind => ({ kind, id: `${kind}-1`, digest: "d".repeat(64), location: `/fixture/retained/${kind}`, state: "retained", source: "original retained bytes" })) };
}
/** @param {import("../../types/retention.js").RetentionObservation} [observed]
 * @param {import("../../types/retention.js").RetentionManifest | null} [retained] */
const assess = (observed = observation(), retained = manifest()) => assessRetention(scope, event(), observed, retained, AT);
/** @param {ReturnType<typeof assess>} result @param {string} code */
function held(result, code) {
	assert.equal(result.state, "held");
	assert.ok(result.holds.some(hold => hold.code === code), `${code}: ${JSON.stringify(result.holds)}`);
	assert.ok(result.holds.every(hold => hold.reason && hold.authority));
}

test("RET-C01/C02 pure assessment produces a candidate, not an archive grant", () => {
	const result = assess();
	assert.equal(result.state, "candidate");
	assert.deepEqual(result.holds, []);
	assert.deepEqual(Object.keys(result).sort(), ["assessedAt", "event", "holds", "id", "manifest", "observation", "state", "version"]);
	assert.deepEqual(result.observation, observation());
	assert.deepEqual(result.manifest, manifest());
	assert.equal(Object.hasOwn(result, "permission"), false);
});

test("RET-C01 closed decoders reject unknown fields, malformed identities and versions while retaining complete inventories", () => {
	for (const bad of [{ ...event(), complete: true }, { ...event(), version: 2 }, { ...event(), id: " " },
		{ ...event(), subject: { ...subject, owner: true } }, { ...event(), sourceCommit: "ABC" },
		{ ...event(), subject: { ...subject, attempt: { ...subject.attempt, attemptId: "T-002-A001" } } }]) assert.throws(() => retentionEvent(bad));
	for (const bad of [{ ...observation(), complete: true }, { ...observation(), owner: true }, { ...observation(), idle: true },
		{ ...observation(), released: true }, { ...observation(), version: 0 }, { ...observation(), inventories: [...observation().inventories, observation().inventories[0]] }]) assert.throws(() => retentionObservation(bad));
	const complete = observation();
	complete.workspace.ignored = Array.from({ length: 129 }, (_, index) => `file-${index}`);
	assert.deepEqual(retentionObservation(complete).workspace.ignored, complete.workspace.ignored);
	const duplicate = observation();
	duplicate.inventories[0].items.push({ ...duplicate.inventories[0].items[0], state: "active" });
	assert.throws(() => retentionObservation(duplicate), { code: "retention_duplicate" });
	const overflow = observation();
	overflow.inventories[2].knownIds = Array.from({ length: 129 }, (_, index) => `run-${index}`);
	assert.deepEqual(retentionObservation(overflow).inventories[2].knownIds, overflow.inventories[2].knownIds);
	assert.throws(() => retentionManifest({ ...manifest(), items: [...manifest().items, manifest().items[0]] }), { code: "retention_duplicate" });
	assert.throws(() => retentionManifest({ ...manifest(), retained: true }));
	for (const worktreePath of ["/", "/fixture/../child", "/fixture/child/", "relative", "/fixture/\0child"]) {
		assert.throws(() => retentionSubject({ ...subject, worktreePath }), { code: "retention_path_invalid" });
	}
});

test("RET-C01/C02 repository, owner, plan, task, attempt, reservation, session and native run identities stay distinct", () => {
	for (const patch of [
		{ repositoryId: "e".repeat(64) }, { owner: "/foreign" }, { planId: "another-plan" },
		{ taskId: "T-002", attemptId: "T-002-A001" }, { attemptId: "T-001-A002" }, { reservationId: "another-reservation" },
	]) {
		const observed = observation();
		observed.subject.attempt = { ...observed.subject.attempt, ...patch };
		held(assess(observed), "retention_subject_changed");
	}
	for (const sessionId of [scope.currentSessionId, scope.coordinatorSessionId]) {
		const changed = event();
		changed.subject.sessionId = sessionId;
		held(assessRetention(scope, changed, observation(), manifest(), AT), "retention_self");
	}
	for (const patch of [{ sessionId: "foreign-session" }, { coordinatorSessionId: "foreign-owner" }, { worktreePath: "/foreign/worktree" }]) {
		const observed = observation();
		observed.subject = { ...observed.subject, ...patch };
		held(assess(observed), "retention_subject_changed");
	}
	const foreign = event();
	foreign.subject.attempt.owner = "/foreign";
	held(assessRetention(scope, foreign, observation(), manifest(), AT), "retention_foreign");
	const run = observation();
	run.inventories[2].items[0].state = "active";
	held(assess(run), "retention_runs_active");
	run.inventories[2].items[0].id = " ";
	assert.throws(() => retentionObservation(run), { code: "retention_identity_invalid" });
});

test("RET-C02 all actual inventories require terminal owned observations and actionable releasing authorities", () => {
	for (const ownership of /** @type {const} */ (["foreign", "unknown", "ambiguous"])) {
		held(assess({ ...observation(), ownership }), `retention_ownership_${ownership}`);
	}
	for (const inventory of observation().inventories) for (const state of /** @type {const} */ (["active", "unknown", "ambiguous"])) {
		const observed = observation();
		const target = observed.inventories.find(item => item.kind === inventory.kind);
		assert.ok(target);
		target.items[0].state = state;
		const result = assess(observed);
		held(result, `retention_${inventory.kind}_${state}`);
		assert.equal(result.holds.find(hold => hold.code === `retention_${inventory.kind}_${state}`)?.authority, `${inventory.kind} owner`);
	}
	for (const kind of ["tasks", "attempts", "sessions"]) {
		const observed = observation();
		const inventory = observed.inventories.find(item => item.kind === kind);
		assert.ok(inventory);
		inventory.items = []; inventory.knownIds = [];
		held(assess(observed), "retention_terminal_missing");
	}
});

test("RET-C03 each dirt and missing conservation category independently holds cleanup", () => {
	for (const kind of /** @type {const} */ (["tracked", "untracked", "ignored"])) {
		const observed = observation();
		observed.workspace[kind] = ["unique-work"];
		held(assess(observed), `retention_${kind}`);
	}
	held(assess({ ...observation(), workspace: { ...observation().workspace, state: "unknown" } }), "retention_workspace_unknown");
	held(assess(observation(), null), "retention_manifest_missing");
	for (const item of manifest().items) {
		const retained = manifest();
		retained.items = retained.items.filter(entry => entry.kind !== item.kind);
		held(assess(observation(), retained), `retention_${item.kind}_missing`);
		retained.required = retained.required.filter(entry => entry.kind !== item.kind);
		held(assess(observation(), retained), `retention_${item.kind}_unobserved`);
	}
	for (const location of ["/fixture/child/report", "/fixture/retained", "/fixture/retained-sibling/report"]) {
		const retained = manifest();
		retained.items[0].location = location;
		held(assess(observation(), retained), "retention_artifact_unsafe");
	}
	for (const retainedRoot of ["/fixture/child/retained", "/fixture"]) {
		held(assess(observation(), { ...manifest(), retainedRoot }), "retention_root_unsafe");
	}
	held(assess(observation(), { ...manifest(), sourceDigest: "f".repeat(64) }), "retention_manifest_mismatch");
});

test("RET-C04 pagination, stale captures, incomplete causal coverage and conflicts never establish absence", () => {
	for (const mutate of [
		(/** @type {ReturnType<typeof observation>} */ value) => { value.inventories[0].nextCursor = "page-2"; },
		(/** @type {ReturnType<typeof observation>} */ value) => { value.inventories[0].coverage = "partial"; },
		(/** @type {ReturnType<typeof observation>} */ value) => { value.inventories[0].knownIds.push("T-002"); },
	]) {
		const observed = observation(); mutate(observed);
		held(assess(observed), "retention_inventory_incomplete");
	}
	const missing = observation(); missing.inventories.pop();
	held(assess(missing), "retention_inventory_missing");
	for (const patch of [{ sequence: 4 }, { capturedAt: "2026-11-12T00:00:00.000Z" }, { capturedAt: "2026-11-14T00:00:00.000Z" }, { validUntil: "2026-11-13T00:00:00.000Z" }]) {
		held(assess({ ...observation(), ...patch }), "retention_stale");
	}
	const outOfOrder = observation(); outOfOrder.inventories[0].sequence = 11;
	held(assess(outOfOrder), "retention_inventory_stale");
	const conflict = observation(); conflict.source = "same revision, different contents";
	held(assessRetention(scope, event(), conflict, manifest(), AT, [assess()]), "retention_observation_conflict");
	held(assess(observation(), { ...manifest(), sequence: 9 }), "retention_manifest_stale");
});

test("RET-C03/C04 unknown or repeated omissions cannot erase older consumer/evaluator holds", () => {
	const original = observation();
	original.inventories[8].items[0].state = "active";
	const first = assess(original);
	held(first, "retention_consumers_active");
	const omitted = observation();
	omitted.revision = 2; omitted.sequence = 11;
	for (const inventory of omitted.inventories) { inventory.revision = 2; inventory.sequence = 11; }
	omitted.inventories[8].items = []; omitted.inventories[8].knownIds = [];
	const retained = { ...manifest(), sequence: 11 };
	const second = assessRetention(scope, event(), omitted, retained, AT, [first]);
	held(second, "retention_inventory_omission");
	const third = assessRetention(scope, event(), omitted, retained, AT, [first, second]);
	held(third, "retention_inventory_omission");
	const released = observation();
	released.revision = 3; released.sequence = 12;
	for (const inventory of released.inventories) { inventory.revision = 3; inventory.sequence = 12; }
	assert.equal(assessRetention(scope, event(), released, { ...manifest(), sequence: 12 }, AT, [first, second, third]).state, "candidate");
	const reopened = observation();
	reopened.inventories[1].items[0].subject.attempt.attemptId = "T-001-A002";
	reopened.inventories[1].items[0].id = "T-001-A002";
	reopened.inventories[1].knownIds = ["T-001-A002"];
	held(assess(reopened), "retention_subject_changed");
});
