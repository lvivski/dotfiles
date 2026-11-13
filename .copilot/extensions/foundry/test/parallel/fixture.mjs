import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createArtifactDatabase } from "../../storage/database.mjs";

/** @typedef {import("../../types/parallel.js").AdmissionIdentity} AdmissionIdentity */
/** @typedef {import("../../types/parallel.js").AdmissionRecord} AdmissionRecord */
/** @typedef {import("../../types/parallel.js").EffectReceipt} EffectReceipt */
/** @typedef {ReturnType<typeof createArtifactDatabase>} ArtifactDatabase */
/**
 * @typedef {object} FixtureConnection
 * @property {"left" | "right"} actor
 * @property {DatabaseSync} db
 * @property {ArtifactDatabase} storage
 * @property {string} workspacePath
 * @property {string} databasePath
 */
/**
 * @typedef {object} FaultStep
 * @property {string} checkpoint
 * @property {() => void} [action] Synchronous injected action, such as a competing cancellation.
 * @property {Error} [fault] Thrown after the action; the step remains consumed.
 */
/** @typedef {{type: "fence", admission: AdmissionIdentity, epoch: number} | {type: "native-start", receipt: EffectReceipt}} EffectObservation */

const scratch = fileURLToPath(new URL("../../../../skills/foundry/.parallel-check", import.meta.url));

/** @param {AdmissionIdentity} identity */
const admissionKey = (identity) => JSON.stringify([
	identity.repositoryId, identity.owner, identity.planId, identity.taskId, identity.reservationId,
]);

/**
 * An isolated workspace with two simultaneously open connections to one anchored database.
 * Factories may return production AdmissionPort/DispatchJournalPort implementations, or adapt
 * their constructors using workspacePath/storage. This fixture allocates no business claims.
 * Run under test/parallel/run.mjs so legacy helpers also inherit a scratch-local cwd.
 *
 * @param {{
 *   name?: string,
 *   initialize?: (db: DatabaseSync) => void,
 *   schemaVersion?: number,
 *   directoryParts?: string[]
 * }} [options]
 */
export function createParallelFixture(options = {}) {
	const root = realpathSync(scratch);
	const base = realpathSync(process.env.FOUNDRY_PARALLEL_SCRATCH ?? root);
	assert.ok(base === root || base.startsWith(`${root}${path.sep}`), "Fixture root must be inside .parallel-check");
	const name = options.name ?? "scenario";
	assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/, "Use a simple fixture name");
	const workspacePath = path.join(base, `${name}-${randomUUID()}`);
	mkdirSync(workspacePath, { mode: 0o700 });
	/** @type {DatabaseSync[]} */
	const opened = [];
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		for (const db of opened) {
			if (db.isOpen) {
				if (db.isTransaction) db.exec("ROLLBACK");
				db.close();
			}
		}
		rmSync(workspacePath, { recursive: true, force: true });
		disposed = true;
	};
	try {
		const settings = {
			workspacePath,
			schemaVersion: options.schemaVersion ?? 0,
			initialize: options.initialize ?? (() => {}),
			directoryParts: options.directoryParts,
		};
		const leftStorage = createArtifactDatabase(settings);
		const rightStorage = createArtifactDatabase(settings);
		leftStorage.transaction(() => {});
		rightStorage.transaction(() => {});
		const databasePath = leftStorage.databasePath;
		assert.equal(rightStorage.databasePath, databasePath);
		/** @param {"left" | "right"} actor @param {ArtifactDatabase} storage @returns {FixtureConnection} */
		const open = (actor, storage) => {
			storage.verifyFiles();
			const db = new DatabaseSync(databasePath);
			opened.push(db);
			db.exec("PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;");
			const main = db.prepare("PRAGMA database_list").all().find(row => row.name === "main");
			assert.equal(main?.file, databasePath, "Both connections must address the same on-disk database");
			return Object.freeze({ actor, db, storage, workspacePath, databasePath });
		};
		const left = open("left", leftStorage);
		const right = open("right", rightStorage);
		assert.notEqual(left.db, right.db, "Participants must not share a connection");
		return Object.freeze({
			workspacePath, databasePath, left, right, dispose,
			/**
			 * Adapters, not the harness, own admission/dispatch/recovery decisions.
			 * @template T
			 * @param {(connection: FixtureConnection) => T} factory
			 * @returns {[T, T]}
			 */
			adapters(factory) { return [factory(left), factory(right)]; },
		});
	} catch (error) {
		dispose();
		throw error;
	}
}

/**
 * Real SQLite writer overlap, rollback visibility and stale-revision compare-and-swap.
 * The diagnostic table is not an admission implementation or production-concurrency evidence.
 * There are no waits, latency assertions, background workers or timing-dependent schedules.
 *
 * @param {ReturnType<typeof createParallelFixture>} fixture
 */
export function assertSqliteWriterIsolation(fixture) {
	const a = fixture.left.db, b = fixture.right.db;
	assert.notEqual(a, b);
	assert.ok(!a.isTransaction && !b.isTransaction, "Isolation probe requires idle connections");
	a.exec("CREATE TABLE parallel_fixture_writer_probe (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL)");
	try {
		a.prepare("INSERT INTO parallel_fixture_writer_probe VALUES (1, 1, ?)").run("original");
		a.exec("BEGIN IMMEDIATE");
		a.prepare("UPDATE parallel_fixture_writer_probe SET revision = 2, value = ? WHERE id = 1").run("uncommitted");
		assert.equal(b.prepare("SELECT value FROM parallel_fixture_writer_probe WHERE id = 1").get()?.value, "original");
		assert.throws(() => b.exec("BEGIN IMMEDIATE"), (error) =>
			error instanceof Error && "errcode" in error && error.errcode === 5,
		"The second connection must encounter SQLITE_BUSY while the first holds the writer lock");
		assert.equal(b.isTransaction, false);
		a.exec("ROLLBACK");
		assert.equal(b.prepare("SELECT revision FROM parallel_fixture_writer_probe WHERE id = 1").get()?.revision, 1);
		b.exec("BEGIN IMMEDIATE");
		assert.equal(b.prepare("UPDATE parallel_fixture_writer_probe SET revision = revision + 1, value = ? WHERE id = 1 AND revision = 1").run("committed").changes, 1);
		b.exec("COMMIT");
		a.exec("BEGIN IMMEDIATE");
		assert.equal(a.prepare("UPDATE parallel_fixture_writer_probe SET revision = revision + 1, value = ? WHERE id = 1 AND revision = 1").run("stale").changes, 0,
			"A stale revision must not overwrite the winning committed revision");
		a.exec("ROLLBACK");
		const winner = a.prepare("SELECT revision, value FROM parallel_fixture_writer_probe WHERE id = 1").get();
		assert.equal(winner?.revision, 2);
		assert.equal(winner?.value, "committed");
		return Object.freeze({ overlappingWriterRejected: true, rollbackObserved: true, staleRevisionRejected: true });
	} finally {
		if (a.isTransaction) a.exec("ROLLBACK");
		if (b.isTransaction) b.exec("ROLLBACK");
		a.exec("DROP TABLE parallel_fixture_writer_probe");
	}
}

/**
 * Adapters call checkpoints at their own boundaries, including inside synchronous transactions.
 * A checkpoint can run a competitor or throw a response-loss fault; it never polls or schedules.
 * @param {readonly FaultStep[]} steps
 */
export function createFaultSchedule(steps) {
	const pending = steps.map(step => ({ ...step }));
	/** @type {string[]} */
	const visited = [];
	return Object.freeze({
		/** @param {string} checkpoint */
		checkpoint(checkpoint) {
			const step = pending[visited.length];
			assert.ok(step, `Unexpected checkpoint: ${checkpoint}`);
			assert.equal(checkpoint, step.checkpoint, `Out-of-order checkpoint at step ${visited.length}`);
			visited.push(checkpoint);
			const result = step.action?.();
			assert.equal(result, undefined, "Checkpoint actions must finish synchronously without returning work");
			if (step.fault) throw step.fault;
		},
		assertComplete() { assert.equal(visited.length, pending.length, "Fault schedule has unconsumed checkpoints"); },
		get visited() { return [...visited]; },
	});
}

/**
 * Observation only: call at the cancellation commit and at a native invocation boundary.
 * No native API is called, and no policy decision is made on the adapter's behalf.
 */
export function createEffectProbe() {
	/** @type {EffectObservation[]} */
	const observations = [];
	return Object.freeze({
		/** @param {AdmissionRecord} record */
		fence(record) {
			assert.equal(record.phase, "cancelling", "Observe the committed cancellation, not its request");
			observations.push({ type: "fence", admission: structuredClone(record.identity), epoch: record.epoch });
		},
		/** @param {EffectReceipt} receipt */
		nativeStart(receipt) {
			observations.push({ type: "native-start", receipt: structuredClone(receipt) });
		},
		get observations() { return structuredClone(observations); },
	});
}

/**
 * Independent oracle: physical kind/scope, not a caller-chosen claim label, identifies an
 * exclusive resource within a repository. Settled-but-unreleased admissions still hold claims.
 * @param {readonly AdmissionRecord[]} records
 */
export function assertExclusiveClaims(records) {
	/** @type {Map<string, {admission: AdmissionIdentity, mode: "shared" | "exclusive"}[]>} */
	const holders = new Map();
	for (const record of records) {
		if (record.phase === "released") continue;
		for (const resource of record.resources) {
			const key = JSON.stringify([record.identity.repositoryId, resource.kind, resource.scope]);
			const existing = holders.get(key) ?? [];
			for (const holder of existing) {
				if (admissionKey(holder.admission) === admissionKey(record.identity)) continue;
				assert.ok(holder.mode !== "exclusive" && resource.mode !== "exclusive",
					`Duplicate exclusive claim for ${resource.kind}:${resource.scope}`);
			}
			existing.push({ admission: record.identity, mode: resource.mode });
			holders.set(key, existing);
		}
	}
}

/** Outcomes may arrive after cancellation; new invocations may not.
 * @param {readonly EffectObservation[]} observations */
export function assertNoEffectsAfterFence(observations) {
	const fenced = new Set();
	const started = new Set();
	for (const observation of observations) {
		if (observation.type === "fence") {
			fenced.add(admissionKey(observation.admission));
			continue;
		}
		const receipt = observation.receipt;
		assert.ok(!fenced.has(admissionKey(receipt.attempt)), `Native ${receipt.kind} started after cancellation fence`);
		assert.equal(receipt.state, "in-flight", "Native effects require a started receipt");
		const key = JSON.stringify([admissionKey(receipt.attempt), receipt.attempt.attemptId, receipt.id]);
		assert.ok(!started.has(key), `Native effect started twice: ${receipt.id}`);
		started.add(key);
	}
}

/**
 * Independent cancellation-checkpoint oracle, before any definitive native reconciliation.
 * Previously observed in-flight/uncertain effects must survive in durable receipts and pending
 * obligations, with all claims and known native identities retained. It does not settle them.
 * @param {AdmissionRecord} before
 * @param {AdmissionRecord} after
 */
export function assertUncertainEffectsRetained(before, after) {
	const pending = before.receipts.filter(receipt => receipt.state === "in-flight" || receipt.state === "uncertain");
	assert.ok(pending.length > 0, "Provide an independently observed unresolved effect");
	assert.deepEqual(after.identity, before.identity);
	assert.deepEqual(after.attempt, before.attempt);
	assert.equal(after.phase, "cancelling", "Uncertain native effects must keep the admission cancelling");
	assert.deepEqual(after.team, before.team, "Cancellation must retain team capacity");
	for (const resource of before.resources) {
		assert.ok(after.resources.some(retained => retained.id === resource.id), `Cancellation lost resource ${resource.id}`);
		assert.deepEqual(after.resources.find(retained => retained.id === resource.id), resource, "Cancellation changed a retained claim");
	}
	for (const receipt of pending) {
		const retained = after.receipts.find(item => item.id === receipt.id);
		assert.ok(retained, `Cancellation lost unresolved receipt ${receipt.id}`);
		assert.deepEqual(retained.attempt, receipt.attempt);
		assert.equal(retained.kind, receipt.kind);
		assert.equal(retained.epoch, receipt.epoch);
		assert.equal(retained.payloadDigest, receipt.payloadDigest);
		assert.ok(retained.state === "in-flight" || retained.state === "uncertain", "Uncertain effects require definitive evidence before resolution");
		const obligation = after.obligations.find(item => item.attempt.attemptId === receipt.attempt.attemptId);
		assert.ok(obligation, `Cancellation lost obligation for ${receipt.attempt.attemptId}`);
		assert.deepEqual(obligation.attempt, receipt.attempt);
		assert.equal(obligation.disposition, "unresolved", "Uncertainty cannot have a terminal disposition");
		assert.ok(obligation.pendingEffectIds.includes(receipt.id), `Cancellation lost pending effect ${receipt.id}`);
		for (const observed of [...before.receipts, retained]) {
			if (observed.sessionId) assert.equal(obligation.sessionId, observed.sessionId, "Cancellation lost the known native session");
			if (observed.runId) assert.ok(obligation.runIds.includes(observed.runId), "Cancellation lost a known native run");
		}
	}
}
