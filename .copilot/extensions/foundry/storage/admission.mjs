import { constants } from "node:sqlite";
import { stableStringify } from "../digest.mjs";
import { parseJson } from "../data.mjs";
import { digest, fail, integer, object, strings, text, timestamp } from "../factory/fields.mjs";
import { claimHolds, validateClaims } from "../plan/admission.mjs";
import { admissionIdentity, admissionRecord, attemptIdentity, cancellationObligation, deliveryReceipt } from "../plan/parallel-contracts.mjs";
import { PLAN_ID_PATTERN } from "../plan/values.mjs";
import { createArtifactDatabase } from "./database.mjs";
import { assertAdmissionFence, assertEffectTransition, synchronousTransition } from "./parallel-protocol.mjs";

/** @typedef {import("../types/parallel.js").AdmissionIdentity} Identity */
/** @typedef {import("../types/parallel.js").AdmissionRecord} Record */
/** @typedef {import("../types/parallel.js").Fence} Fence */
/** @typedef {import("../types/parallel.js").CancellationObligation} Obligation */
/** @typedef {import("node:sqlite").DatabaseSync} Database */
/** @typedef {Pick<Identity, "repositoryId" | "owner" | "planId">} PlanIdentity */
/** @typedef {{
 * attempt: import("../types/parallel.js").AttemptIdentity, sessionIds: string[], runIds: string[],
 * source: string, capturedAt: string
 * }} AdmissionObservation */
const TABLE = "parallel_admissions";
const OBSERVATIONS = "parallel_admission_observations";
const OBSERVATION_SCHEMA = `CREATE TABLE ${OBSERVATIONS} (
	id INTEGER PRIMARY KEY, identity TEXT NOT NULL, document TEXT NOT NULL,
	UNIQUE(identity, document)
) STRICT;`;
const CANCELLATIONS = "parallel_plan_cancellations";
const CANCELLATION_SCHEMA = `CREATE TABLE ${CANCELLATIONS} (
	identity TEXT PRIMARY KEY NOT NULL, cancelled_at TEXT NOT NULL
) STRICT;`;
const VERSION = 3;
const APPLICATION = 0x464e4144;
/** @param {unknown} a @param {unknown} b */
const same = (a, b) => stableStringify(a) === stableStringify(b);
/** @param {Identity} identity */
const key = (identity) => stableStringify(identity);
/** @param {Record} record @returns {Fence} */
export const admissionFence = (record) => ({ admission: record.identity, revision: record.revision, epoch: record.epoch });

/** @param {Database} db */
function initialize(db) {
	const version = db.prepare("PRAGMA user_version").get()?.user_version;
	const application = db.prepare("PRAGMA application_id").get()?.application_id;
	if (version === VERSION && application === APPLICATION) return;
	if ((version === 1 || version === 2) && application === APPLICATION) {
		db.exec(`${version === 1 ? OBSERVATION_SCHEMA : ""} ${CANCELLATION_SCHEMA} PRAGMA user_version = ${VERSION};`);
		return;
	}
	if (version !== 0 || application !== 0 || db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
		fail("parallel_database_version", "Unknown admission database owner or version");
	}
	db.exec(`CREATE TABLE ${TABLE} (
		identity TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL,
		document TEXT NOT NULL, updated_at TEXT NOT NULL
	) STRICT; ${OBSERVATION_SCHEMA} ${CANCELLATION_SCHEMA} PRAGMA application_id = ${APPLICATION}; PRAGMA user_version = ${VERSION};`);
}

/** @param {Database} db @param {PlanIdentity} identity */
function cancellationFor(db, identity) {
	const row = db.prepare(`SELECT cancelled_at FROM ${CANCELLATIONS} WHERE identity = ?`).get(stableStringify(identity));
	return row ? { identity, cancelledAt: timestamp(row.cancelled_at, "plan cancellation time") } : null;
}

/** @param {Database} db @param {Identity} identity */
function load(db, identity) {
	const row = db.prepare(`SELECT revision, document FROM ${TABLE} WHERE identity = ?`).get(key(identity));
	if (!row) return null;
	if (typeof row.document !== "string") fail("parallel_database_invalid", "Admission document is not JSON");
	const record = admissionRecord(parseJson(row.document));
	if (!same(record.identity, identity) || record.revision !== row.revision) fail("parallel_identity_mismatch", "Stored admission identity or revision changed");
	return record;
}

/** @param {Database} db @returns {Record[]} */
function records(db) {
	return db.prepare(`SELECT identity, revision, document FROM ${TABLE} ORDER BY identity`).all().map(row => {
		if (typeof row.document !== "string") fail("parallel_database_invalid", "Admission document is not JSON");
		const record = admissionRecord(parseJson(row.document));
		if (key(record.identity) !== row.identity || record.revision !== row.revision) fail("parallel_database_invalid", "Stored admission index changed");
		return record;
	});
}

/** Positive ownership observations are retained evidence, not imported authority.
 * The recovery owner supplies corroborated identities through this write port.
 * @param {unknown} value @returns {AdmissionObservation} */
function observation(value) {
	object(value, ["attempt", "sessionIds", "runIds", "source", "capturedAt"], "admission observation");
	return {
		attempt: attemptIdentity(value.attempt), sessionIds: strings(value.sessionIds, "observed sessions", Number.MAX_SAFE_INTEGER).sort(),
		runIds: strings(value.runIds, "observed runs", Number.MAX_SAFE_INTEGER).sort(), source: text(value.source, "observation source", 4096),
		capturedAt: timestamp(value.capturedAt, "observation time"),
	};
}

/** @param {Database} db @param {Record} record */
function observationsFor(db, record) {
	return db.prepare(`SELECT document FROM ${OBSERVATIONS} WHERE identity = ? ORDER BY id`).all(key(record.identity)).map(row => {
		if (typeof row.document !== "string") fail("parallel_database_invalid", "Retained observation is not JSON");
		const retained = observation(parseJson(row.document));
		if (!same(retained.attempt, record.attempt)) fail("parallel_identity_mismatch", "Retained observation belongs to another attempt");
		return retained;
	});
}

/** @param {Database} db @param {Record} record */
function nativeIdentities(db, record) {
	const retained = observationsFor(db, record);
	return {
		retained,
		sessionIds: [...new Set([
			...record.receipts.flatMap(receipt => receipt.sessionId ? [receipt.sessionId] : []),
			...record.obligations.flatMap(obligation => obligation.sessionId ? [obligation.sessionId] : []),
			...retained.flatMap(item => item.sessionIds),
		])].sort(),
		runIds: [...new Set([
			...record.receipts.flatMap(receipt => receipt.runId ? [receipt.runId] : []),
			...record.obligations.flatMap(obligation => obligation.runIds),
			...retained.flatMap(item => item.runIds),
		])].sort(),
	};
}

/** @param {ReturnType<typeof nativeIdentities>} identities */
const quarantined = (identities) => identities.sessionIds.length > 1 || identities.runIds.length > 128;

/** The frozen record can name only one child. Additional observed children remain in
 * durable evidence and quarantine release; this snapshot never claims to settle them.
 * @param {Database} db @param {Record} record @returns {Obligation[]} */
function obligationsFor(db, record) {
	if (!record.attempt) return [];
	const { sessionIds, runIds } = nativeIdentities(db, record);
	return [{
		attempt: record.attempt, sessionId: record.obligations[0]?.sessionId ?? sessionIds[0] ?? null,
		// The frozen obligation bounds runs at 128. Keep overflow evidence in the
		// sidecar and quarantine; never reject its retention or claim it settled.
		runIds: runIds.length > 128 ? record.obligations[0]?.runIds ?? runIds.slice(0, 128) : runIds,
		pendingEffectIds: record.receipts.filter(receipt => ["intent", "in-flight", "uncertain"].includes(receipt.state)).map(receipt => receipt.id).sort(),
		disposition: "unresolved", inventory: null, terminatedRunIds: [],
	}];
}

/** Owner-scoped authority over one shared anchored database. Sharing a database permits
 * observation of competing claims, never mutation of another owner's admissions.
 * The constructor is an application composition seam, not an import/grant endpoint.
 * @param {{
 * workspacePath: string, repositoryId: string, owner: string, directoryParts?: string[],
 * busyTimeoutMs?: number, clock?: () => string
 * }} options */
export function createAdmissionStore(options) {
	const repositoryId = digest(options.repositoryId, "repositoryId");
	const owner = text(options.owner, "owner", 4096);
	const clock = () => timestamp(options.clock?.() ?? new Date().toISOString(), "admission time");
	const storage = createArtifactDatabase({
		workspacePath: options.workspacePath, busyTimeoutMs: options.busyTimeoutMs,
		directoryParts: options.directoryParts ?? ["files", "foundry-admission"],
		initialize, schemaVersion: VERSION,
	});
	/** @param {Identity} value */
	function owned(value) {
		const identity = admissionIdentity(value);
		if (identity.repositoryId !== repositoryId || identity.owner !== owner) fail("parallel_foreign_owner", "Admission is outside this writer's owner/repository scope");
		return identity;
	}
	/** @param {PlanIdentity} value */
	function ownedPlan(value) {
		object(value, ["repositoryId", "owner", "planId"], "plan cancellation identity");
		const identity = {
			repositoryId: digest(value.repositoryId, "repositoryId"), owner: text(value.owner, "owner", 4096),
			planId: text(value.planId, "planId", 64),
		};
		if (!new RegExp(PLAN_ID_PATTERN).test(identity.planId)) fail("parallel_identity_invalid", "Invalid planId");
		if (identity.repositoryId !== repositoryId || identity.owner !== owner) fail("parallel_foreign_owner", "Plan is outside this writer's owner/repository scope");
		return identity;
	}
	/** This is a consistent recovery snapshot, not a native termination verdict.
	 * @param {Database} db @param {PlanIdentity} identity */
	function cancellationState(db, identity) {
		return {
			identity, fence: cancellationFor(db, identity),
			admissions: records(db).filter(record => record.identity.repositoryId === repositoryId
				&& record.identity.owner === owner && record.identity.planId === identity.planId)
				.map(admission => ({ admission, observations: observationsFor(db, admission) })),
		};
	}
	/** @param {Database} db @param {Fence} fence */
	function current(db, fence) {
		const identity = owned(fence.admission);
		integer(fence.revision, "expected revision");
		integer(fence.epoch, "expected epoch", 0);
		const record = load(db, identity);
		if (!record) fail("parallel_admission_missing", "No authoritative admission exists");
		return record;
	}
	/** @param {Record} record @param {Fence} fence */
	function check(record, fence) {
		if (record.revision !== fence.revision || record.epoch !== fence.epoch) fail("revision_conflict", "Admission revision or epoch changed; reread authoritative state");
	}
	/** @param {Database} db @param {Record} before @param {Record} after @param {boolean} [changedEvidence] */
	function save(db, before, after, changedEvidence = false) {
		if (same(before, after) && !changedEvidence) return before;
		const candidate = admissionRecord({ ...after, revision: before.revision + 1 });
		const previousAt = db.prepare(`SELECT updated_at FROM ${TABLE} WHERE identity = ?`).get(key(before.identity))?.updated_at;
		if (typeof previousAt !== "string") fail("parallel_database_invalid", "Admission transition timestamp is missing");
		const updatedAt = new Date(Math.max(Date.parse(previousAt), Date.parse(clock()))).toISOString();
		const result = db.prepare(`UPDATE ${TABLE} SET document = ?, revision = ?, updated_at = ? WHERE identity = ? AND revision = ?`)
			.run(stableStringify(candidate), candidate.revision, updatedAt, key(before.identity), before.revision);
		if (result.changes !== 1) fail("revision_conflict", "Admission changed during its transition");
		return candidate;
	}
	/** @param {Identity} identity */
	const read = (identity) => storage.transaction(db => load(db, owned(identity)));
	const list = () => storage.transaction(db => records(db).filter(record => record.identity.repositoryId === repositoryId));
	/** @param {Identity} identity */
	const readObservations = (identity) => storage.transaction(db => {
		const record = load(db, owned(identity));
		return record ? observationsFor(db, record) : [];
	});
	/** Includes released history and positive ownership evidence; a null fence means
	 * plan-wide cancellation has not been installed, even for an empty census.
	 * @param {PlanIdentity} identity */
	const readCancellation = (identity) => storage.transaction(db => cancellationState(db, ownedPlan(identity)));

	/** @type {import("../types/parallel.js").AdmissionPort["claim"]} */
	const claim = ({ identity: value, expectedRevision, resources, team }) => storage.transaction(db => {
		const identity = owned(value);
		const { repositoryId, owner, planId } = identity;
		if (cancellationFor(db, { repositoryId, owner, planId })) fail("parallel_fenced", "Plan cancellation forbids claims, including replays");
		integer(expectedRevision, "expected revision", 0);
		({ resources, team } = validateClaims(resources, team));
		const all = records(db);
		const existing = load(db, identity);
		if (existing) {
			if (!same(existing.resources, resources) || !same(existing.team, team)) fail("parallel_claim_mismatch", "Idempotent claim payload changed");
			if (["settled", "released", "cancelling"].includes(existing.phase)) fail("parallel_fenced", "Terminal or cancelling admission cannot be reacquired");
			return existing;
		}
		if (expectedRevision !== 0) fail("revision_conflict", "New admission requires expected revision zero");
		if (all.some(record => record.identity.repositoryId === repositoryId && record.identity.owner === owner
			&& record.identity.planId === identity.planId && record.identity.reservationId === identity.reservationId)) {
			fail("parallel_identity_mismatch", "Reservation correlation belongs to another task");
		}
		if (all.some(record => record.identity.repositoryId === repositoryId && record.identity.owner === owner
			&& record.identity.planId === identity.planId && record.identity.taskId === identity.taskId && record.phase !== "released")) {
			fail("parallel_claim_held", "Task already has an unresolved admission; reconcile the same reservation");
		}
		const holds = claimHolds(repositoryId, resources, team, all);
		if (holds.length) fail("parallel_capacity_held", "Declared capacity or resources are unavailable", { holds });
		const record = admissionRecord({
			format: "foundry-admission-v1", identity, revision: 1, epoch: 0, phase: "claim-held",
			attempt: null, resources, team, obligations: [], receipts: [], delivery: null, reservationFailure: null,
		});
		db.prepare(`INSERT INTO ${TABLE} VALUES (?, ?, ?, ?)`).run(key(identity), record.revision, stableStringify(record), clock());
		return record;
	}, { write: true });

	/** @type {import("../types/parallel.js").AdmissionPort["bindReservation"]} */
	const bindReservation = (fence, value) => storage.transaction(db => {
		const before = current(db, fence);
		const attempt = attemptIdentity(value);
		const { attemptId, ...identity } = attempt;
		if (!same(identity, before.identity)) fail("parallel_identity_mismatch", "Reservation belongs to another admission");
		if (before.attempt) {
			if (!same(before.attempt, attempt)) fail("parallel_identity_mismatch", "Admission already binds another attempt");
			if (!["reserved", "cancelling"].includes(before.phase)) fail("parallel_fenced", "Cannot bind a terminal admission");
			return before;
		}
		check(before, fence);
		if (!["claim-held", "cancelling"].includes(before.phase)) fail("parallel_fenced", "Reservation cannot reopen a settled claim");
		const after = { ...before, attempt, phase: before.phase === "cancelling" ? "cancelling" : /** @type {const} */ ("reserved") };
		const candidate = admissionRecord(after);
		if (candidate.phase === "cancelling") candidate.obligations = obligationsFor(db, candidate);
		return save(db, before, candidate);
	}, { write: true });

	/** The journal may change only receipts. Cancellation allows late outcomes, not starts.
	 * @type {import("../types/parallel.js").AdmissionPort["withFence"]} */
	const withFence = (fence, operation) => storage.transaction(db => {
		const before = current(db, fence);
		assertAdmissionFence(before, fence, { settlement: true });
		if (operation.constructor?.name === "AsyncFunction") fail("parallel_async_transaction", "Native calls must stay outside the synchronous writer transaction");
		const after = structuredClone(before);
		if (typeof db.setAuthorizer !== "function") fail("parallel_authorizer_unavailable", "Fenced journal transactions require SQLite authorizer support");
		db.setAuthorizer((action, table) =>
			[TABLE, OBSERVATIONS, CANCELLATIONS].includes(table ?? "") && action !== constants.SQLITE_READ
				|| [constants.SQLITE_TRANSACTION, constants.SQLITE_SAVEPOINT, constants.SQLITE_ATTACH, constants.SQLITE_DETACH, constants.SQLITE_PRAGMA].includes(action)
				? constants.SQLITE_DENY : constants.SQLITE_OK);
		let result;
		try {
			result = synchronousTransition(() => operation({ db, admission: after, fence: structuredClone(fence) }));
		} finally {
			db.setAuthorizer(null);
		}
		const { receipts: oldReceipts, ...oldFields } = before;
		const { receipts: newReceipts, ...newFields } = after;
		if (!same(oldFields, newFields)) fail("parallel_transition_authority", "Journal callbacks cannot change admission identity, claims, phase or disposition");
		for (const receipt of oldReceipts) {
			const next = newReceipts.find(item => item.id === receipt.id);
			if (!next) fail("parallel_receipt_identity", "Journal cannot remove prior receipts");
			assertEffectTransition(receipt, next);
			if (before.phase === "cancelling" && next.state === "in-flight" && receipt.state !== "in-flight") fail("parallel_fenced", "Cancellation forbids new starts");
		}
		for (const receipt of newReceipts.filter(item => !oldReceipts.some(old => old.id === item.id))) {
			if (before.phase !== "reserved" || receipt.state !== "intent" || receipt.epoch !== before.epoch) fail("parallel_fenced", "Only an active reservation can create a new intent");
		}
		if (after.phase === "cancelling") after.obligations = obligationsFor(db, after);
		save(db, before, after);
		return result;
	}, { write: true });

	/** @param {Database} db @param {Record} before */
	function cancelRecord(db, before) {
		const after = admissionRecord({ ...before, phase: "cancelling", epoch: before.epoch + 1 });
		// The journal closes unstarted intents through withFence so its receipt rows
		// and this authoritative snapshot advance in the same writer transaction.
		after.obligations = obligationsFor(db, after);
		return save(db, before, after);
	}

	/** @type {import("../types/parallel.js").AdmissionPort["cancel"]} */
	const cancel = (fence) => storage.transaction(db => {
		const before = current(db, fence);
		if (before.phase === "cancelling") return before;
		check(before, fence);
		if (!["claim-held", "reserved"].includes(before.phase)) fail("parallel_fenced", "Only an active claim can be cancelled");
		return cancelRecord(db, before);
	}, { write: true });

	/** Atomically fences future claims and the current owned census, never releasing
	 * capacity or certifying termination. Retry returns retained state without
	 * advancing epochs again. No caller-supplied census can miss a competing claim.
	 * @param {PlanIdentity} value */
	const cancelPlan = (value) => storage.transaction(db => {
		const identity = ownedPlan(value);
		if (!cancellationFor(db, identity)) {
			db.prepare(`INSERT INTO ${CANCELLATIONS} (identity, cancelled_at) VALUES (?, ?)`)
				.run(stableStringify(identity), clock());
		}
		for (const record of records(db)) {
			if (record.identity.repositoryId === repositoryId && record.identity.owner === owner
				&& record.identity.planId === identity.planId && ["claim-held", "reserved"].includes(record.phase)) {
				cancelRecord(db, record);
			}
		}
		return cancellationState(db, identity);
	}, { write: true });

	/** Retain inventory-only ownership before a recovery decision. Omission or restart
	 * never removes positive evidence. Multiple children require a new explicit
	 * settlement contract; the scalar v1 obligation cannot safely release them.
	 * Retain an entire native capture atomically, not separately committed pages.
	 * @param {Fence} fence @param {AdmissionObservation} value */
	const retainObservation = (fence, value) => storage.transaction(db => {
		const before = current(db, fence);
		check(before, fence);
		if (before.phase !== "cancelling" || !before.attempt) fail("parallel_fenced", "Ownership observations require an exact bound cancelling attempt");
		const retained = observation(value);
		if (!same(retained.attempt, before.attempt)) fail("parallel_identity_mismatch", "Observation cannot transfer attempt or native run ownership");
		const inserted = db.prepare(`INSERT OR IGNORE INTO ${OBSERVATIONS} (identity, document) VALUES (?, ?)`)
			.run(key(before.identity), stableStringify(retained)).changes === 1;
		const after = { ...before, obligations: obligationsFor(db, before) };
		return save(db, before, after, inserted);
	}, { write: true });

	/** @type {import("../types/parallel.js").AdmissionPort["settle"]} */
	const settle = (fence, values) => storage.transaction(db => {
		const before = current(db, fence);
		const obligations = values.map(cancellationObligation);
		if (["settled", "released"].includes(before.phase) && same(before.obligations, obligations)) return before;
		check(before, fence);
		if (before.phase !== "cancelling" || !before.attempt) fail("parallel_fenced", "Settlement requires a bound cancelling attempt");
		const identities = nativeIdentities(db, before);
		if (quarantined(identities)) fail("parallel_observation_quarantine", "Retained native identities exceed the frozen settlement contract; claims remain held");
		const expected = obligationsFor(db, before)[0];
		const actual = obligations[0];
		const updatedAt = db.prepare(`SELECT updated_at FROM ${TABLE} WHERE identity = ?`).get(key(before.identity))?.updated_at;
		if (obligations.length !== 1 || !actual || !same(actual.attempt, before.attempt)
			|| actual.sessionId !== expected.sessionId || !same([...actual.runIds].sort(), expected.runIds)
			|| actual.disposition === "unresolved" || expected.pendingEffectIds.length
			|| !actual.inventory?.complete || typeof updatedAt !== "string"
			|| Date.parse(actual.inventory.capturedAt) <= Math.max(Date.parse(updatedAt),
				...before.receipts.map(receipt => Date.parse(receipt.at)), ...identities.retained.map(item => Date.parse(item.capturedAt)))) {
			fail("parallel_unsafe_release", "Settlement requires a causally newer complete inventory and every exact owned effect/session/run");
		}
		return save(db, before, { ...before, phase: "settled", obligations });
	}, { write: true });

	/** Only a definitive failed reservation response can close the unbound gap. A read
	 * showing no attempt, timeout or missing child is not such a response.
	 * @param {Fence} fence @param {{source: string, at: string}} failure */
	const failReservation = (fence, failure) => storage.transaction(db => {
		const before = current(db, fence);
		if (["settled", "released"].includes(before.phase) && same(before.reservationFailure, failure)) return before;
		check(before, fence);
		if (before.attempt || !["claim-held", "cancelling"].includes(before.phase)) fail("parallel_fenced", "Only an unbound reservation failure may close this gap");
		return save(db, before, { ...before, phase: "settled", reservationFailure: failure });
	}, { write: true });

	/** @type {import("../types/parallel.js").AdmissionPort["deliver"]} */
	const deliver = (fence, value) => storage.transaction(db => {
		const before = current(db, fence);
		const delivery = deliveryReceipt(value);
		if (["settled", "released"].includes(before.phase) && same(before.delivery, delivery)) return before;
		check(before, fence);
		if (before.phase !== "reserved") fail("parallel_fenced", "Delivery cannot override cancellation");
		const runs = new Set(before.receipts.flatMap(receipt => receipt.runId ? [receipt.runId] : []));
		if (delivery.terminalRunIds.some(id => !runs.has(id))) fail("parallel_foreign_run", "Delivery cannot claim termination of an unrelated native run");
		return save(db, before, { ...before, phase: "settled", delivery });
	}, { write: true });

	/** @type {import("../types/parallel.js").AdmissionPort["release"]} */
	const release = (fence) => storage.transaction(db => {
		const before = current(db, fence);
		if (before.phase === "released" && before.epoch === fence.epoch) return before;
		check(before, fence);
		if (quarantined(nativeIdentities(db, before))) fail("parallel_observation_quarantine", "Retained native identities require an explicit settlement contract; claims remain held");
		if (before.phase !== "settled") fail("parallel_unsafe_release", "Unsettled claims retain all capacity");
		return save(db, before, { ...before, phase: "released" });
	}, { write: true });

	return Object.freeze({ read, list, claim, bindReservation, withFence, cancel, cancelPlan, readCancellation, settle, deliver, release, failReservation, retainObservation, readObservations, databasePath: storage.databasePath });
}
