import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRecoveryOperations } from "../../application/recovery.mjs";
import { normalizeRecoveryObservation } from "../../inventory.mjs";
import { admissionRecord, effectReceipt } from "../../plan/parallel-contracts.mjs";
import { assertAdmissionFence, assertEffectTransition, synchronousTransition } from "../../storage/parallel-protocol.mjs";
import { createParallelFixture, assertExclusiveClaims, assertUncertainEffectsRetained } from "./fixture.mjs";

/** @typedef {import("../../types/parallel.js").AdmissionIdentity} AdmissionIdentity */
/** @typedef {import("../../types/parallel.js").AttemptIdentity} AttemptIdentity */
/** @typedef {import("../../types/parallel.js").AdmissionRecord} AdmissionRecord */
/** @typedef {import("../../types/parallel.js").EffectReceipt} EffectReceipt */
/** @typedef {import("../../types/parallel.js").Fence} Fence */
/** @typedef {import("../../types/parallel.js").ResourceClaim} ResourceClaim */
/** @typedef {import("../../types/parallel.js").FencedTransaction} FencedTransaction */
/** @typedef {import("../../inventory.mjs").RecoveryObservation} Observation */
/** @typedef {{complete: boolean, capturedAt: string, source: string, sessions: {id: string, status: string, attempt: AttemptIdentity}[], runs: {id: string, status: string, attempt: AttemptIdentity}[]}} Inventory */
/** @typedef {"terminal" | "partial" | "missing-session" | "missing-run" | "live-run" | "idle-session" | "stale" | "foreign-binding" | "multiple-sessions" | "observed-run" | "observed-run-terminal"} InventoryView */
/** @typedef {"ordinary" | "partial" | "missing-session" | "missing-run" | "uncertain" | "intent" | "before-commit" | "after-commit" | "foreign-binding" | "live-run" | "stale" | "observed-run" | "idle-session" | "in-flight"} Scenario */
/** @typedef {{id: string, index: number, dependencies: string[], resources: ResourceClaim[], scenario: Scenario, rank: number}} LogicalPackage */
/** @typedef {{format: "foundry-logical-workload-v1", size: 32 | 128, seed: number, repositoryId: string, owner: string, packages: LogicalPackage[]}} Workload */
/** @typedef {{kind: "admitted" | "started" | "fenced" | "released" | "completed" | "restart", packageId?: string, effectId?: string, identity?: AdmissionIdentity, resources?: ResourceClaim[]}} TraceEvent */
/** @typedef {{records: AdmissionRecord[], events: TraceEvent[], observations: {identity: AdmissionIdentity, entries: Observation[]}[], foreign: unknown}} WorkloadSnapshot */
/**
 * Adapters must report committed admission/start/release events, not requests. A composed
 * adapter owns all real readiness, native binding, delivery and persistence decisions.
 * complete must retain authoritative predecessor completion; the built-in adapter uses
 * a synthetic terminal barrier and does not attest production delivery correctness.
 * The runner supplies only synthetic inputs; it never creates an executable plan.
 * @typedef {object} WorkloadAdapter
 * @property {"adapter-based-simulation" | "integrated"} label
 * @property {(pkg: LogicalPackage) => Promise<"started" | "existing" | "held"> | "started" | "existing" | "held"} request
 * @property {(pkg: LogicalPackage) => void | Promise<void>} cancel
 * @property {(pkg: LogicalPackage, view: InventoryView) => void | Promise<void>} inventory
 * @property {(pkg: LogicalPackage) => Promise<{state: "held" | "released", record: AdmissionRecord, holds: string[]}>} reconcile
 * @property {(pkg: LogicalPackage) => void | Promise<void>} outcome
 * @property {(point: "before-commit" | "after-commit") => void} fault Arm a one-shot outcome error with code injected_persistence_fault.
 * @property {() => void | Promise<void>} restart
 * @property {(pkg: LogicalPackage) => void | Promise<void>} complete
 * @property {() => WorkloadSnapshot} snapshot
 */

const clone = structuredClone;
/** @template T @param {T} value @returns {T} */
function freeze(value) {
	if (value && typeof value === "object") {
		for (const entry of Object.values(value)) freeze(entry);
		Object.freeze(value);
	}
	return value;
}
/** @param {unknown} value */
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** @param {AdmissionIdentity} identity */
const key = identity => JSON.stringify([identity.repositoryId, identity.owner, identity.planId, identity.taskId, identity.reservationId]);
/** @param {AdmissionRecord} record @returns {Fence} */
export const recoveryFence = record => ({ admission: clone(record.identity), revision: record.revision, epoch: record.epoch });
/** @param {string} code @param {string} message */
const failure = (code, message) => Object.assign(new Error(message), { code });
/** @param {number} seed */
function randomSource(seed) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	};
}

/**
 * Eight independent roots followed by multi-predecessor layers. Resource names identify
 * shared physical scopes, even when claim labels differ. These are logical packages,
 * not a 32/128-task executable plan or a throughput benchmark.
 * @param {{size?: 32 | 128, seed?: number}} [options]
 * @returns {Workload}
 */
export function generateWorkload({ size = 32, seed = 6206 } = {}) {
	assert.ok(size === 32 || size === 128, "Use a bounded 32- or 128-package dataset");
	assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, "Seed must be an unsigned 32-bit integer");
	const random = randomSource(seed);
	/** @type {Scenario[]} */
	const scenarios = ["ordinary", "partial", "missing-session", "missing-run", "uncertain", "intent",
		"before-commit", "after-commit", "foreign-binding", "live-run", "stale", "observed-run", "idle-session", "in-flight"];
	/** @param {number} index */
	const id = index => `package-${String(index + 1).padStart(3, "0")}`;
	const packages = Array.from({ length: size }, (_, index) => {
		const lane = index % 8, layer = Math.floor(index / 8);
		/** @type {ResourceClaim[]} */
		const resources = [
			{ id: `build-${index}`, kind: "worktree-build", scope: "synthetic-build-pool", mode: "shared", capacity: 4, units: 1 },
			{ id: `write-${index}`, kind: "shared-write", scope: `synthetic-output-${lane % 4}`, mode: "exclusive", capacity: 1, units: 1 },
		];
		return { id: id(index), index, resources, scenario: scenarios[index % scenarios.length], rank: random(),
			dependencies: layer === 0 ? [] : [id(index - 8), id((layer - 1) * 8 + (lane + 3) % 8)] };
	});
	return freeze({ format: "foundry-logical-workload-v1", size, seed, repositoryId: digest("synthetic-workload-repository"),
		owner: "synthetic-workload-owner", packages });
}

/**
 * Test-only admission/journal/observation ports on isolated SQLite tables. Restart switches
 * to the other connection and rebuilds production recovery. This proves recovery decisions
 * against deterministic adapters, NOT the production admission/dispatch implementation.
 * @param {{records?: AdmissionRecord[], inventory?: Inventory, repositoryId?: string, owner?: string}} [options]
 */
export function createRecoveryAdapter(options = {}) {
	const fixture = createParallelFixture({
		name: "recovery-workload",
		initialize: db => db.exec(`
			CREATE TABLE IF NOT EXISTS workload_admissions (identity TEXT PRIMARY KEY, document TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS workload_observations (
				identity TEXT NOT NULL, fingerprint TEXT NOT NULL, document TEXT NOT NULL,
				PRIMARY KEY (identity, fingerprint)
			);
		`),
	});
	let connection = fixture.left;
	let sequence = 0;
	const clock = () => new Date(Date.UTC(2030, 0, 1) + ++sequence * 1000).toISOString();
	const repositoryId = options.repositoryId ?? options.records?.[0]?.identity.repositoryId ?? digest("synthetic-workload-repository");
	const owner = options.owner ?? options.records?.[0]?.identity.owner ?? "synthetic-workload-owner";
	/** @type {Inventory | null} */
	let observed = options.inventory ? clone(options.inventory) : null;
	/** @type {((input: {identity: AdmissionIdentity, after: string}) => Promise<Inventory>) | null} */
	let observer = null;
	/** @type {{point: string, code: string} | null} */
	let armed = null;
	/** @type {FencedTransaction | null} */
	let active = null;
	let transactionKind = "";
	/** @type {{operation: string, identity: AdmissionIdentity}[]} */
	const calls = [];
	/** @param {AdmissionIdentity} identity @returns {AdmissionRecord | null} */
	function read(identity) {
		const row = connection.db.prepare("SELECT document FROM workload_admissions WHERE identity = ?").get(key(identity));
		return row ? admissionRecord(JSON.parse(String(row.document))) : null;
	}
	/** @param {AdmissionRecord} record */
	function write(record) {
		const valid = admissionRecord(record);
		connection.db.prepare("INSERT INTO workload_admissions VALUES (?, ?) ON CONFLICT(identity) DO UPDATE SET document = excluded.document")
			.run(key(valid.identity), JSON.stringify(valid));
		return clone(valid);
	}
	for (const record of options.records ?? []) write(record);
	/** @param {string} point */
	function checkpoint(point) {
		if (armed?.point !== point) return;
		const { code } = armed;
		armed = null;
		throw failure(code, `Injected ${point}`);
	}
	/** @template T @param {string} operation @param {() => T} action @returns {T} */
	function transaction(operation, action) {
		connection.db.exec("BEGIN IMMEDIATE");
		transactionKind = operation;
		try {
			const result = synchronousTransition(action);
			checkpoint(`${transactionKind}:before-commit`);
			connection.db.exec("COMMIT");
			checkpoint(`${transactionKind}:after-commit`);
			return result;
		} catch (error) {
			if (connection.db.isTransaction) connection.db.exec("ROLLBACK");
			throw error;
		} finally {
			active = null;
		}
	}
	/** @param {Fence} fence */
	function current(fence) {
		const record = read(fence.admission);
		assert.ok(record, "Admission must exist");
		assert.deepEqual(record.identity, fence.admission);
		if (record.revision !== fence.revision || record.epoch !== fence.epoch) throw failure("revision_conflict", "Stale synthetic fence");
		return record;
	}
	/** @param {AdmissionIdentity} identity @returns {Observation[]} */
	function readObservations(identity) {
		return connection.db.prepare("SELECT document FROM workload_observations WHERE identity = ? ORDER BY rowid")
			.all(key(identity)).map(row => JSON.parse(String(row.document)));
	}
	/** @param {AdmissionRecord} record */
	function knownIds(record) {
		const retained = readObservations(record.identity);
		for (const entry of retained) assert.deepEqual(entry.attempt, record.attempt);
		return {
			sessionIds: [...new Set([
				...retained.flatMap(entry => entry.sessionIds),
				...record.receipts.flatMap(receipt => receipt.sessionId ? [receipt.sessionId] : []),
				...record.obligations.flatMap(obligation => obligation.sessionId ? [obligation.sessionId] : []),
				...(record.delivery ? [record.delivery.sessionId] : []),
			])].sort(),
			runIds: [...new Set([
				...retained.flatMap(entry => entry.runIds),
				...record.receipts.flatMap(receipt => receipt.runId ? [receipt.runId] : []),
				...record.obligations.flatMap(obligation => obligation.runIds),
				...(record.delivery?.terminalRunIds ?? []),
			])].sort(),
		};
	}
	/** @param {AdmissionRecord} record @param {AdmissionRecord["obligations"]} obligations */
	function assertObservedSettlement(record, obligations) {
		const known = knownIds(record);
		const delivered = record.epoch === 0 ? record.delivery : null;
		if (known.sessionIds.length > 1) throw failure("parallel_observation_conflict", "Multiple observed sessions quarantine the admission");
		if (known.sessionIds.some(id => delivered?.sessionId !== id
			&& !obligations.some(obligation => obligation.sessionId === id && obligation.disposition === "session-terminated"))
			|| known.runIds.some(id => !delivered?.terminalRunIds.includes(id)
				&& !obligations.some(obligation => obligation.runIds.includes(id) && obligation.terminatedRunIds.includes(id)))) {
			throw failure("parallel_unsafe_release", "Every retained native identity needs an explicit terminal obligation");
		}
	}
	/** @type {import("../../application/recovery.mjs").RecoveryObservationPort} */
	const observations = {
		readObservations,
		/** @param {Fence} fence @param {Observation} observation */
		retainObservation(fence, observation) {
			return transaction("retainObservation", () => {
				const record = current(fence);
				const valid = normalizeRecoveryObservation(observation);
				assert.deepEqual(valid.attempt, record.attempt);
				const entry = { ...valid, sessionIds: [...new Set(valid.sessionIds)].sort(), runIds: [...new Set(valid.runIds)].sort() };
				const fingerprint = digest(entry);
				const duplicate = connection.db.prepare("SELECT 1 FROM workload_observations WHERE identity = ? AND fingerprint = ?")
					.get(key(record.identity), fingerprint);
				if (duplicate) return record;
				assertAdmissionFence(record, fence, { settlement: true });
				connection.db.prepare("INSERT INTO workload_observations VALUES (?, ?, ?)")
					.run(key(record.identity), fingerprint, JSON.stringify(entry));
				calls.push({ operation: "retainObservation", identity: clone(record.identity) });
				return write({ ...record, revision: record.revision + 1 });
			});
		},
	};
	/** @type {import("../../types/parallel.js").AdmissionPort} */
	const admission = {
		read,
		claim(input) {
			return transaction("claim", () => {
				const prior = read(input.identity);
				if (prior) return prior;
				assert.equal(input.expectedRevision, 0);
				const records = allRecords().filter(record => record.phase !== "released");
				for (const resource of input.resources) {
					const held = records.filter(record => record.identity.repositoryId === input.identity.repositoryId)
						.flatMap(record => record.resources).filter(other => other.kind === resource.kind && other.scope === resource.scope);
					if (held.length && (resource.mode === "exclusive" || held.some(other => other.mode === "exclusive"))
						|| held.reduce((total, other) => total + other.units, resource.units) > resource.capacity) {
						throw failure("resource_busy", "Synthetic resource held");
					}
				}
				calls.push({ operation: "claim", identity: clone(input.identity) });
				return write({ format: "foundry-admission-v1", identity: input.identity, revision: 1, epoch: 0,
					phase: "claim-held", attempt: null, resources: input.resources, team: input.team,
					obligations: [], receipts: [], delivery: null, reservationFailure: null });
			});
		},
		bindReservation(fence, attempt) {
			return transaction("bindReservation", () => {
				const record = current(fence);
				assert.equal(record.phase, "claim-held");
				return write({ ...record, attempt, phase: "reserved", revision: record.revision + 1 });
			});
		},
		withFence(fence, operation) {
			return transaction("withFence", () => {
				const record = current(fence);
				assertAdmissionFence(record, fence, { settlement: true });
				active = { admission: record, fence, db: connection.db };
				return operation(active);
			});
		},
		cancel(fence) {
			return transaction("cancel", () => {
				const record = current(fence);
				if (["cancelling", "settled", "released"].includes(record.phase)) return record;
				calls.push({ operation: "cancel", identity: clone(record.identity) });
				const receipts = record.receipts;
				return write({ ...record, phase: "cancelling", revision: record.revision + 1, epoch: record.epoch + 1,
					obligations: record.attempt ? [{ attempt: record.attempt,
						sessionId: receipts.find(receipt => receipt.sessionId)?.sessionId ?? null,
						runIds: [...new Set(receipts.flatMap(receipt => receipt.runId ? [receipt.runId] : []))],
						pendingEffectIds: receipts.filter(receipt => ["intent", "in-flight", "uncertain"].includes(receipt.state)).map(receipt => receipt.id),
						disposition: "unresolved", inventory: null, terminatedRunIds: [],
					}] : [] });
			});
		},
		settle(fence, obligations) {
			return transaction("settle", () => {
				const record = current(fence);
				assertObservedSettlement(record, obligations);
				assert.equal(record.phase, "cancelling");
				calls.push({ operation: "settle", identity: clone(record.identity) });
				return write({ ...record, phase: "settled", obligations, revision: record.revision + 1 });
			});
		},
		deliver() { throw failure("unsupported_fixture_operation", "Recovery must not deliver work"); },
		release(fence) {
			return transaction("release", () => {
				const record = current(fence);
				assertObservedSettlement(record, record.obligations);
				if (record.phase === "released") return record;
				assert.equal(record.phase, "settled");
				calls.push({ operation: "release", identity: clone(record.identity) });
				return write({ ...record, phase: "released", revision: record.revision + 1 });
			});
		},
	};
	/** @param {FencedTransaction} tx @param {EffectReceipt} receipt */
	function persist(tx, receipt) {
		assert.equal(tx, active, "Journal requires the admission transaction");
		assert.ok(connection.db.isTransaction);
		const record = current(tx.fence);
		assert.deepEqual(receipt.attempt, record.attempt);
		const valid = effectReceipt(receipt);
		write({ ...record, revision: record.revision + 1, receipts: [...record.receipts.filter(item => item.id !== valid.id), valid] });
		return clone(valid);
	}
	/** @type {import("../../types/parallel.js").DispatchJournalPort} */
	const journal = {
		read(attempt) { return read(attempt)?.receipts.filter(receipt => JSON.stringify(receipt.attempt) === JSON.stringify(attempt)) ?? []; },
		intent(tx, receipt) {
			assert.equal(tx.admission.phase, "reserved");
			assert.equal(receipt.state, "intent");
			const existing = journal.read(receipt.attempt).find(item => item.id === receipt.id);
			if (existing) { assert.deepEqual(existing, receipt); return existing; }
			return persist(tx, receipt);
		},
		start(tx, receiptId) {
			assert.equal(tx.admission.phase, "reserved");
			const before = tx.admission.receipts.find(receipt => receipt.id === receiptId);
			assert.ok(before);
			const after = { ...before, state: /** @type {const} */ ("in-flight"), at: clock() };
			assertEffectTransition(before, after);
			return persist(tx, after);
		},
		recordOutcome(tx, receipt) {
			transactionKind = "recordOutcome";
			const before = journal.read(receipt.attempt).find(item => item.id === receipt.id);
			assert.ok(before, "Outcomes cannot create effects");
			assertEffectTransition(before, receipt);
			return persist(tx, receipt);
		},
	};
	function allRecords() {
		return connection.db.prepare("SELECT document FROM workload_admissions ORDER BY identity").all()
			.map(row => admissionRecord(JSON.parse(String(row.document))));
	}
	/** @param {{identity: AdmissionIdentity, after: string}} input */
	const observe = async input => observer ? observer(input) : clone(observed ?? {
		complete: true, capturedAt: clock(), source: "synthetic-authoritative-inventory", sessions: [], runs: [],
	});
	const build = () => createRecoveryOperations({ admission, journal, observations, repositoryId, owner, clock, observe });
	let recovery = build();
	return {
		label: /** @type {const} */ ("adapter-based-simulation"),
		fixture, admission, journal, observations, clock, allRecords, calls,
		get recovery() { return recovery; },
		/** @param {Inventory | null} inventory */
		setInventory(inventory) { observer = null; observed = clone(inventory); },
		/** @param {(input: {identity: AdmissionIdentity, after: string}) => Promise<Inventory>} observe */
		setObserver(observe) { observer = observe; },
		/** @param {string} point @param {string} [code] */
		fault(point, code = "injected_persistence_fault") {
			assert.equal(armed, null, "Consume the previous fault before arming another");
			armed = { point, code };
		},
		restart() { connection = connection === fixture.left ? fixture.right : fixture.left; recovery = build(); },
		dispose() { fixture.dispose(); },
	};
}

/** @param {Workload} workload @param {LogicalPackage} pkg @returns {AdmissionIdentity} */
function packageIdentity(workload, pkg) {
	return { repositoryId: workload.repositoryId, owner: workload.owner,
		planId: `logical-batch-${Math.floor(pkg.index / 8)}`, taskId: `T-${String(pkg.index % 8 + 1).padStart(3, "0")}`,
		reservationId: `synthetic-${workload.seed}-${pkg.id}` };
}

/** Built-in simulation adapter; T007 supplies its composed adapter to runWorkload instead.
 * @param {Workload} workload */
export function createWorkloadAdapter(workload) {
	const fixture = createRecoveryAdapter({ repositoryId: workload.repositoryId, owner: workload.owner });
	/** @type {TraceEvent[]} */
	const events = [];
	const completed = new Set();
	/** @type {Map<string, EffectReceipt>} */
	const lateOutcomes = new Map();
	/** @type {Map<string, InventoryView>} */
	const views = new Map();
	const foreignIdentity = { repositoryId: workload.repositoryId, owner: "unrelated-owner",
		planId: "unrelated-plan", taskId: "T-001", reservationId: "unrelated-reservation" };
	const foreignClaim = fixture.admission.claim({ identity: foreignIdentity, expectedRevision: 0,
		resources: [{ id: "foreign-write", kind: "shared-write", scope: "foreign-output", mode: "exclusive", capacity: 1, units: 1 }], team: null });
	const foreign = fixture.admission.bindReservation(recoveryFence(foreignClaim), { ...foreignIdentity, attemptId: "T-001-A001" });
	assert.ok(foreign.attempt);
	const foreignSession = { id: "unrelated-session", status: "running", attempt: foreign.attempt };
	const foreignRun = { id: "unrelated-run", status: "running", attempt: foreign.attempt };
	/** @param {LogicalPackage} pkg */
	function record(pkg) {
		const result = fixture.admission.read(packageIdentity(workload, pkg));
		assert.ok(result);
		return result;
	}
	/** @param {LogicalPackage} pkg @param {"creation" | "workflow"} kind @param {boolean} pending */
	function effect(pkg, kind, pending) {
		const current = record(pkg);
		assert.ok(current.attempt);
		const receipt = effectReceipt({ id: `${kind}-${pkg.id}`, attempt: current.attempt, kind, epoch: 0,
			payloadDigest: digest([kind, pkg.id, workload.seed]), state: "intent", sessionId: null, runId: null,
			source: "synthetic-native-adapter", at: fixture.clock() });
		fixture.admission.withFence(recoveryFence(current), tx => fixture.journal.intent(tx, receipt));
		if (pkg.scenario === "intent") return;
		const started = fixture.admission.withFence(recoveryFence(record(pkg)), tx => fixture.journal.start(tx, receipt.id));
		events.push({ kind: "started", packageId: pkg.id, effectId: receipt.id });
		const outcome = effectReceipt({ ...started, state: "succeeded",
			sessionId: kind === "creation" ? `session-${pkg.id}` : null,
			runId: kind === "workflow" ? `run-${pkg.id}` : null, at: fixture.clock(), source: "retained-authoritative-native-outcome" });
		if (pending) {
			if (pkg.scenario !== "in-flight") {
				const uncertain = effectReceipt({ ...started, state: "uncertain", source: "synthetic-response-loss", at: fixture.clock() });
				fixture.recovery.recordOutcome(current.identity, uncertain);
			}
			lateOutcomes.set(pkg.id, { ...outcome, at: fixture.clock() });
		} else fixture.recovery.recordOutcome(current.identity, outcome);
	}
	/** @param {LogicalPackage} pkg @param {InventoryView} view @returns {Inventory} */
	function inventory(pkg, view) {
		const current = record(pkg);
		assert.ok(current.attempt);
		const attempt = current.attempt;
		const noSession = pkg.scenario === "intent";
		/** @type {Inventory} */
		const result = { complete: view !== "partial", capturedAt: view === "stale" ? "2000-01-01T00:00:00.000Z" : fixture.clock(),
			source: "synthetic-authoritative-inventory", sessions: [clone(foreignSession)], runs: [clone(foreignRun)] };
		if (!noSession && view !== "missing-session") result.sessions.push({ id: `session-${pkg.id}`,
			status: view === "idle-session" ? "idle" : "completed",
			attempt: view === "foreign-binding" ? foreignSession.attempt : attempt });
		if (!noSession && view !== "missing-run") result.runs.push({ id: `run-${pkg.id}`,
			status: view === "live-run" ? "running" : "completed", attempt });
		if (view === "observed-run" || view === "observed-run-terminal") result.runs.push({
			id: `observed-run-${pkg.id}`, status: view === "observed-run" ? "running" : "completed", attempt,
		});
		if (view === "multiple-sessions") result.sessions.push({ id: `extra-session-${pkg.id}`, status: "completed", attempt });
		return result;
	}
	/** @type {WorkloadAdapter} */
	const adapter = {
		label: "adapter-based-simulation",
		request(pkg) {
			const identity = packageIdentity(workload, pkg);
			if (fixture.admission.read(identity)) return "existing";
			if (pkg.dependencies.some(id => !completed.has(id))) return "held";
			let claimed;
			try {
				claimed = fixture.admission.claim({ identity, expectedRevision: 0, resources: pkg.resources, team: null });
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "resource_busy") return "held";
				throw error;
			}
			events.push({ kind: "admitted", packageId: pkg.id, identity, resources: clone(pkg.resources) });
			fixture.admission.bindReservation(recoveryFence(claimed), { ...identity, attemptId: `${identity.taskId}-A001` });
			const uncertain = ["uncertain", "in-flight", "before-commit", "after-commit"].includes(pkg.scenario);
			effect(pkg, "creation", uncertain);
			if (pkg.scenario !== "intent") effect(pkg, "workflow", false);
			return "started";
		},
		cancel(pkg) {
			const before = record(pkg);
			fixture.recovery.cancel(before.identity);
			if (before.phase !== "cancelling") events.push({ kind: "fenced", packageId: pkg.id });
		},
		inventory(pkg, view) { views.set(pkg.id, view); },
		async reconcile(pkg) {
			// Capture happens inside observe, after recovery's fence/receipt writes.
			const view = views.get(pkg.id) ?? "terminal";
			fixture.setObserver(async () => inventory(pkg, view));
			const wasReleased = record(pkg).phase === "released";
			const result = await fixture.recovery.reconcile(record(pkg).identity);
			if (!wasReleased && result.record.phase === "released") events.push({ kind: "released", packageId: pkg.id });
			return result;
		},
		outcome(pkg) {
			const receipt = lateOutcomes.get(pkg.id);
			assert.ok(receipt, "Provide the retained native response, not an inventory inference");
			fixture.recovery.recordOutcome(record(pkg).identity, receipt);
		},
		fault(point) { fixture.fault(`recordOutcome:${point}`); },
		restart() { fixture.restart(); events.push({ kind: "restart" }); },
		complete(pkg) {
			assert.equal(record(pkg).phase, "released");
			if (completed.has(pkg.id)) return;
			completed.add(pkg.id);
			events.push({ kind: "completed", packageId: pkg.id });
		},
		snapshot() {
			const records = fixture.allRecords();
			return { records, events: clone(events),
				observations: records.map(record => ({ identity: record.identity, entries: fixture.observations.readObservations(record.identity) })),
				foreign: {
				admission: fixture.admission.read(foreignIdentity), session: clone(foreignSession), run: clone(foreignRun),
				observations: fixture.observations.readObservations(foreignIdentity),
			} };
		},
	};
	return Object.assign(adapter, { fixture, dispose: () => fixture.dispose() });
}

/**
 * Independent replay oracle; it uses actual adapter events and immutable package inputs,
 * never the scheduler's ready queue. Released claims alone free a physical resource.
 * @param {Workload} workload @param {WorkloadSnapshot} snapshot @param {boolean} [complete]
 */
export function assertWorkloadTrace(workload, snapshot, complete = true) {
	const packages = new Map(workload.packages.map(pkg => [pkg.id, pkg]));
	const admitted = new Set(), started = new Set(), fenced = new Set(), released = new Set(), completed = new Set();
	/** @type {Map<string, {identity: AdmissionIdentity, resources: ResourceClaim[]}>} */
	const active = new Map();
	for (const event of snapshot.events) {
		if (event.kind === "restart") continue;
		assert.ok(event.packageId);
		const pkg = packages.get(event.packageId);
		assert.ok(pkg, `Unknown package ${event.packageId}`);
		if (event.kind === "admitted") {
			assert.ok(!admitted.has(pkg.id), `Duplicate admission: ${pkg.id}`);
			assert.ok(pkg.dependencies.every(id => completed.has(id)), `Unmet dependency at admission: ${pkg.id}`);
			assert.ok(event.identity && event.resources);
			assert.equal(event.identity.owner, workload.owner);
			assert.equal(event.identity.repositoryId, workload.repositoryId);
			assert.deepEqual(event.resources, pkg.resources, "Admission changed package claims");
			for (const resource of event.resources) {
				const others = [...active.values()].flatMap(value => value.resources)
					.filter(other => other.kind === resource.kind && other.scope === resource.scope);
				assert.ok(!others.length || resource.mode !== "exclusive" && others.every(other => other.mode !== "exclusive"),
					`Exclusive overlap: ${resource.scope}`);
				assert.ok(others.reduce((sum, other) => sum + other.units, resource.units) <= resource.capacity, `Capacity exceeded: ${resource.scope}`);
			}
			active.set(pkg.id, { identity: event.identity, resources: event.resources });
			admitted.add(pkg.id);
		} else if (event.kind === "started") {
			const nativeKey = JSON.stringify([pkg.id, event.effectId ?? pkg.id]);
			assert.ok(admitted.has(pkg.id) && !released.has(pkg.id), "Start needs an active admission");
			assert.ok(!started.has(nativeKey), `Duplicate native start: ${pkg.id}`);
			assert.ok(!fenced.has(pkg.id), `Native start after cancellation: ${pkg.id}`);
			assert.ok(pkg.dependencies.every(id => completed.has(id)), `Unmet dependency at start: ${pkg.id}`);
			started.add(nativeKey);
		} else if (event.kind === "fenced") {
			assert.ok(admitted.has(pkg.id));
			fenced.add(pkg.id);
		} else if (event.kind === "released") {
			assert.ok(active.has(pkg.id) && !released.has(pkg.id), "Release must settle one active admission exactly once");
			active.delete(pkg.id);
			released.add(pkg.id);
		} else {
			assert.ok(released.has(pkg.id), "Completion cannot bypass settlement");
			assert.ok(!completed.has(pkg.id), "Duplicate completion");
			completed.add(pkg.id);
		}
	}
	assertExclusiveClaims(snapshot.records);
	if (complete) {
		assert.equal(admitted.size, workload.size, "Every logical package must be admitted");
		assert.equal(completed.size, workload.size, "Every logical package must settle");
		assert.equal(active.size, 0);
		const own = snapshot.records.filter(record => record.identity.owner === workload.owner);
		assert.equal(own.length, workload.size);
		assert.ok(own.every(record => record.phase === "released"));
	}
	return { admitted: admitted.size, completed: completed.size, started: started.size };
}

/**
 * Shared integration entry point. The same schedule and independent invariants apply to
 * adapter-based simulation and composed production adapters; the returned label is explicit.
 * No wall-clock measurements, native App calls, polling, or oversized plans are involved.
 * @param {Workload} workload @param {WorkloadAdapter} adapter
 */
export async function runWorkload(workload, adapter) {
	assert.ok(["adapter-based-simulation", "integrated"].includes(adapter.label));
	const foreign = clone(adapter.snapshot().foreign);
	const completed = new Set();
	const offered = [...workload.packages].sort((a, b) => b.rank - a.rank);
	let reconciliations = 0, holds = 0, restarts = 0;
	const check = () => {
		const snapshot = adapter.snapshot();
		assert.deepEqual(snapshot.foreign, foreign, "Recovery changed unrelated owner work");
		assertWorkloadTrace(workload, snapshot, false);
	};
	/** @param {LogicalPackage} pkg */
	const currentRecord = pkg => {
		const snapshot = adapter.snapshot();
		const event = snapshot.events.find(event => event.kind === "admitted" && event.packageId === pkg.id);
		assert.ok(event?.identity);
		const identityKey = key(event.identity);
		const record = snapshot.records.find(record => key(record.identity) === identityKey);
		assert.ok(record, "Committed admission event needs a durable record");
		return record;
	};
	/** @param {LogicalPackage} pkg */
	const currentObservations = pkg => {
		const identityKey = key(currentRecord(pkg).identity);
		const retained = adapter.snapshot().observations.find(entry => key(entry.identity) === identityKey);
		assert.ok(retained, "Expose durable observations for each admitted package");
		return retained.entries;
	};
	/** @param {LogicalPackage} pkg @param {"held" | "released"} expected */
	async function reconcile(pkg, expected) {
		const before = adapter.snapshot().records;
		const result = await adapter.reconcile(pkg);
		reconciliations++;
		assert.equal(result.state, expected, `${pkg.id}: ${pkg.scenario}`);
		if (expected === "held") {
			holds++;
			assert.ok(result.holds.length > 0, "Held recovery needs an explicit reason");
			assert.notEqual(result.record.phase, "released");
			const prior = before.find(record => key(record.identity) === key(result.record.identity));
			assert.ok(prior);
			assert.deepEqual(result.record.resources, prior.resources, "A hold must retain all resources");
			assert.deepEqual(result.record.team, prior.team, "A hold must retain team capacity");
			if (prior.receipts.some(receipt => receipt.state === "in-flight" || receipt.state === "uncertain")) {
				assertUncertainEffectsRetained(prior, result.record);
			}
		}
		check();
		return result;
	}
	for (let round = 0; completed.size < workload.size; round++) {
		assert.ok(round < workload.size * 2, "Bounded schedule stalled");
		/** @type {LogicalPackage[]} */
		const batch = [];
		for (const pkg of offered) {
			if (completed.has(pkg.id)) continue;
			const result = await adapter.request(pkg);
			if (result !== "started") { assert.equal(result, "held", "No untracked admission may survive a batch"); continue; }
			batch.push(pkg);
			assert.equal(await adapter.request(pkg), "existing", "Duplicate request must reuse its admission");
			check();
		}
		assert.ok(batch.length > 0, "Ready work must eventually be admitted");
		const ordered = batch.sort((a, b) => round % 2 ? a.rank - b.rank : b.index - a.index);
		for (const pkg of ordered) {
			await adapter.cancel(pkg);
			await adapter.cancel(pkg);
			await adapter.inventory(pkg, "terminal");
			if (pkg.scenario === "observed-run") {
				const before = currentRecord(pkg);
				const knownRuns = new Set([...before.receipts.flatMap(receipt => receipt.runId ? [receipt.runId] : []),
					...before.obligations.flatMap(obligation => obligation.runIds)]);
				await adapter.inventory(pkg, "observed-run");
				const discovery = await reconcile(pkg, "held");
				assert.ok(discovery.holds.includes("native-observations-retained"), "A pre-retention capture cannot authorize settlement");
				const retained = clone(currentObservations(pkg));
				const discovered = [...new Set(retained.flatMap(entry => entry.runIds))].filter(id => !knownRuns.has(id));
				assert.equal(discovered.length, 1, "The synthetic inventory must discover one previously unknown owned run");
				assert.deepEqual(currentRecord(pkg).receipts, before.receipts, "Observation must not manufacture a native effect receipt");
				await adapter.restart(); restarts++;
				assert.deepEqual(currentObservations(pkg), retained, "Restart must preserve the observation sidecar");
				await adapter.inventory(pkg, "terminal");
				await reconcile(pkg, "held");
				assert.ok(discovered.every(id => currentObservations(pkg).some(entry => entry.runIds.includes(id))),
					"An omitted run must remain a durable obligation");
				await adapter.inventory(pkg, "observed-run-terminal");
			} else if (["uncertain", "in-flight", "before-commit", "after-commit"].includes(pkg.scenario)) {
				await reconcile(pkg, "held");
				await adapter.restart(); restarts++;
				await reconcile(pkg, "held");
				if (pkg.scenario === "before-commit" || pkg.scenario === "after-commit") {
					const point = pkg.scenario === "before-commit" ? "before-commit" : "after-commit";
					const pending = currentRecord(pkg).receipts.filter(receipt => receipt.state === "uncertain");
					assert.ok(pending.length > 0, "Fault must exercise a retained uncertain effect");
					adapter.fault(point);
					await assert.rejects(async () => adapter.outcome(pkg), error =>
						error instanceof Error && "code" in error && error.code === "injected_persistence_fault");
					await adapter.restart(); restarts++;
					for (const before of pending) {
						const retained = currentRecord(pkg).receipts.find(receipt => receipt.id === before.id);
						assert.ok(retained);
						if (point === "before-commit") assert.deepEqual(retained, before, "Failed commit must roll back the outcome");
						else assert.equal(retained.state, "succeeded", "Lost commit acknowledgement must not erase the durable outcome");
					}
					if (point === "before-commit") await reconcile(pkg, "held");
				}
				await adapter.outcome(pkg);
				const retained = currentRecord(pkg);
				await adapter.outcome(pkg);
				assert.deepEqual(currentRecord(pkg), retained, "Duplicate authoritative receipt must be an exact no-op");
			} else if (pkg.scenario !== "ordinary" && pkg.scenario !== "intent") {
				await adapter.inventory(pkg, /** @type {InventoryView} */ (pkg.scenario));
				await reconcile(pkg, "held");
				await adapter.restart(); restarts++;
				await reconcile(pkg, "held");
				await adapter.inventory(pkg, "terminal");
			}
			await reconcile(pkg, "released");
			await reconcile(pkg, "released");
			await adapter.complete(pkg);
			await adapter.complete(pkg);
			completed.add(pkg.id);
			check();
		}
	}
	const snapshot = adapter.snapshot();
	const assertions = assertWorkloadTrace(workload, snapshot);
	assert.deepEqual(snapshot.foreign, foreign);
	return { label: adapter.label, datasetDigest: digest(workload), size: workload.size, seed: workload.seed,
		assertions, reconciliations, holds, restarts, snapshot };
}
