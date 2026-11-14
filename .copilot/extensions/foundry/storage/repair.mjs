import { existsSync } from "node:fs";
import path from "node:path";
import { parseJson, readJsonValue } from "../data.mjs";
import { stableStringify } from "../digest.mjs";
import { closedRepairObject, repairDigest, repairObject, repairSourceSnapshotsEqual, validateRepairPreparation } from "../analysis/repair.mjs";
import { createArtifactDatabase } from "./database.mjs";
import { storageError } from "./errors.mjs";

/** @typedef {import("../types/repair.js").RepairRecord} Record */
/** @typedef {import("../types/repair.js").RepairPreparation} Preparation */
/** @typedef {import("../types/repair.js").RepairState} State */
/** @typedef {import("../types/json.js").JsonValue} Json */

/** Extend only the canonical owner-local plan database. No migrations or permission records.
 * @param {{workspacePath: string, sessionId: string, busyTimeoutMs?: number}} options */
export function createRepairJournal(options) {
	if (!path.isAbsolute(options.workspacePath) || !options.sessionId
		|| !existsSync(path.join(options.workspacePath, "files", "foundry", "foundry.sqlite"))) {
		throw storageError("repair_storage_authority", "Repair requires the existing canonical owner-local plan database");
	}
	const storage = createArtifactDatabase({
		workspacePath: options.workspacePath, busyTimeoutMs: options.busyTimeoutMs, schemaVersion: 3,
		initialize(db) {
			if (db.prepare("PRAGMA user_version").get()?.user_version !== 3
				|| db.prepare("PRAGMA application_id").get()?.application_id !== 0x464e4452) {
				throw storageError("repair_storage_authority", "Repair requires plan schema 3 / application 0x464e4452; unknown authority is not migrated");
			}
		},
	});
	storage.transaction(db => {
		db.exec(`CREATE TABLE IF NOT EXISTS planning_repairs (
			id TEXT PRIMARY KEY NOT NULL, root_id TEXT NOT NULL UNIQUE,
			input_digest TEXT NOT NULL UNIQUE, document TEXT NOT NULL
		) STRICT;
		CREATE TABLE IF NOT EXISTS planning_repair_events (
			seq INTEGER PRIMARY KEY, id TEXT NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL
		) STRICT;
		CREATE TABLE IF NOT EXISTS planning_repair_effects (
			id TEXT PRIMARY KEY NOT NULL, repair_id TEXT NOT NULL, document TEXT NOT NULL
		) STRICT;`);
	}, { write: true });

	/** @param {Preparation} preparation */
	function owner(preparation) {
		if (preparation.owner !== options.workspacePath || preparation.sessionId !== options.sessionId) {
			throw storageError("repair_foreign_owner", "Repair journal belongs to another native owner");
		}
	}
	/** @param {unknown} value @returns {Record} */
	function decode(value) {
		const object = closedRepairObject(value, ["preparation", "state", "runId", "candidate", "result"], "repair journal");
		const preparation = validateRepairPreparation(object.preparation);
		owner(preparation);
		const states = ["prepared", "intent", "admitted", "executing", "completed", "denied", "unavailable", "uncertain"];
		if (typeof object.state !== "string" || !states.includes(object.state)
			|| (object.runId !== null && (typeof object.runId !== "string" || !object.runId))
			|| !Object.hasOwn(object, "candidate") || !Object.hasOwn(object, "result")) {
			throw storageError("repair_journal_invalid", "Stored repair state is invalid");
		}
		let candidate = null;
		if (object.candidate !== null) {
			const raw = closedRepairObject(object.candidate, ["candidate", "issue"], "retained repair candidate");
			if (raw.issue !== null && typeof raw.issue !== "string") throw storageError("repair_journal_invalid", "Invalid retained candidate diagnostic");
			candidate = { candidate: readJsonValue(raw.candidate), issue: raw.issue };
		}
		return {
			preparation, state: /** @type {State} */ (object.state), runId: object.runId,
			candidate, result: object.result === null ? null : repairObject(object.result),
		};
	}
	/** @param {import("node:sqlite").DatabaseSync} db @param {string} id @param {string} digest */
	function read(db, id, digest) {
		repairDigest(id); repairDigest(digest);
		const row = db.prepare("SELECT document FROM planning_repairs WHERE id = ?").get(id);
		if (!row) throw storageError("repair_preparation_missing", "No retained repair preparation");
		const record = decode(parseJson(String(row.document)));
		if (record.preparation.id !== id || record.preparation.digest !== digest) throw storageError("repair_identity_mismatch", "Repair preparation digest differs");
		return record;
	}
	/** @param {import("node:sqlite").DatabaseSync} db @param {Record} record @param {string} event @param {Json} payload */
	function save(db, record, event, payload) {
		db.prepare("UPDATE planning_repairs SET document = ? WHERE id = ?").run(stableStringify(record), record.preparation.id);
		db.prepare("INSERT INTO planning_repair_events (id, event, payload) VALUES (?, ?, ?)")
			.run(record.preparation.id, event, stableStringify(payload));
		return structuredClone(record);
	}
	/** @param {string} id @param {string} digest @param {(record: Record) => {event: string, payload: Json}} mutate */
	function update(id, digest, mutate) {
		return storage.transaction(db => {
			const record = read(db, id, digest);
			const event = mutate(record);
			return save(db, record, event.event, event.payload);
		}, { write: true });
	}
	/** @param {Record} record @param {string} runId */
	function bound(record, runId) {
		if (!runId || record.runId !== runId) throw storageError("repair_run_mismatch", "Repair is bound to another native run");
	}
	return {
		databasePath: storage.databasePath,
		/** A baseline is supplied only for a newly prepared record by the authentic host.
		 * Existing history is never retroactively seeded or reset.
		 * @param {Preparation} value @param {Json} [baseline] */
		prepare(value, baseline) {
			const preparation = validateRepairPreparation(value);
			owner(preparation);
			return storage.transaction(db => {
				const rows = db.prepare("SELECT document FROM planning_repairs WHERE root_id = ? OR input_digest = ? OR id = ?")
					.all(preparation.rootRunId, preparation.inputDigest, preparation.id);
				if (rows.length) {
					const previous = decode(parseJson(String(rows[0].document)));
					const { digest: previousDigest, source: previousSource, ...previousIdentity } = previous.preparation;
					const { digest: proposedDigest, source: proposedSource, ...proposedIdentity } = preparation;
					if (rows.length !== 1 || (stableStringify(previous.preparation) !== stableStringify(preparation)
						&& (stableStringify(previousIdentity) !== stableStringify(proposedIdentity) || !repairSourceSnapshotsEqual(previousSource, proposedSource)))) {
						throw storageError("repair_budget_claimed", "This original lineage or canonical input already has a retained repair claim");
					}
					return previous;
				}
				/** @type {Record} */
				const record = { preparation, state: "prepared", runId: null, candidate: null, result: null };
				db.prepare("INSERT INTO planning_repairs VALUES (?, ?, ?, ?)")
					.run(preparation.id, preparation.rootRunId, preparation.inputDigest, stableStringify(record));
				save(db, record, "prepared", readJsonValue(preparation));
				if (baseline !== undefined) db.prepare("INSERT INTO planning_repair_events (id, event, payload) VALUES (?, ?, ?)")
					.run(preparation.id, "comparison-baseline", stableStringify(baseline));
				return structuredClone(record);
			}, { write: true });
		},
		/** @param {string} id @param {string} digest */
		read: (id, digest) => storage.transaction(db => read(db, id, digest)),
		/** Read historical identity only; this lookup grants no continuation permission.
		 * @param {string} rootRunId */
		findRoot(rootRunId) {
			return storage.transaction(db => {
				const row = db.prepare("SELECT document FROM planning_repairs WHERE root_id=?").get(rootRunId);
				return row ? decode(parseJson(String(row.document))) : null;
			});
		},
		/** Append original evidence before interpreting it. Never mutate an old outcome.
		 * @param {string} id @param {string} digest @param {string} event @param {Json} payload */
		retain(id, digest, event, payload) {
			return storage.transaction(db => {
				read(db, id, digest);
				db.prepare("INSERT INTO planning_repair_events (id, event, payload) VALUES (?, ?, ?)")
					.run(id, event, stableStringify(payload));
			}, { write: true });
		},
		/** @param {string} id @param {string} digest */
		comparisonHistory(id, digest) {
			return storage.transaction(db => {
				read(db, id, digest);
				const rows = db.prepare("SELECT payload FROM planning_repair_events WHERE id = ? AND event IN ('comparison-baseline','comparison-state') ORDER BY seq").all(id);
				return rows.length ? rows.map(row => readJsonValue(parseJson(String(row.payload)))) : [null];
			});
		},
		/** A proposal is not permission; only native admission can consume it.
		 * @param {import("../types/repair.js").RepairEffect} effect */
		proposeEffect(effect) {
			return storage.transaction(db => {
				read(db, effect.preparationId, effect.preparationDigest);
				const previous = db.prepare("SELECT document FROM planning_repair_effects WHERE id=?").get(effect.id);
				if (previous) {
					const retained = repairObject(parseJson(String(previous.document)));
					if (stableStringify(retained.effect) !== stableStringify(effect)) throw storageError("repair_effect_conflict", "Conflicting proposed effect");
					return retained;
				}
				const document = repairObject({ effect, state: "prepared", receipt: null });
				db.prepare("INSERT INTO planning_repair_effects VALUES (?,?,?)").run(effect.id, effect.preparationId, stableStringify(document));
				db.prepare("INSERT INTO planning_repair_events (id,event,payload) VALUES (?,?,?)").run(effect.preparationId, "effect-proposed", stableStringify(effect));
				return document;
			}, { write: true });
		},
		/** Intent is an outbox, never a native consumed resource receipt.
		 * @param {import("../types/repair.js").RepairEffect} effect */
		effectIntent(effect) {
			return storage.transaction(db => {
				read(db, effect.preparationId, effect.preparationDigest);
				const row = db.prepare("SELECT document FROM planning_repair_effects WHERE id = ?").get(effect.id);
				if (row) {
					const retained = repairObject(parseJson(String(row.document)));
					if (stableStringify(retained.effect) !== stableStringify(effect)) throw storageError("repair_effect_conflict", "Effect identity has conflicting content");
					if (retained.state === "prepared") {
						const intent = repairObject({ ...retained, state: "intent" });
						db.prepare("UPDATE planning_repair_effects SET document=? WHERE id=?").run(stableStringify(intent), effect.id);
						db.prepare("INSERT INTO planning_repair_events (id,event,payload) VALUES (?,?,?)").run(effect.preparationId, "effect-intent", stableStringify(effect));
						return intent;
					}
					return retained;
				}
				const document = repairObject({ effect, state: "intent", receipt: null });
				db.prepare("INSERT INTO planning_repair_effects VALUES (?, ?, ?)").run(effect.id, effect.preparationId, stableStringify(document));
				db.prepare("INSERT INTO planning_repair_events (id,event,payload) VALUES (?,?,?)").run(effect.preparationId, "effect-intent", stableStringify(effect));
				return document;
			}, { write: true });
		},
		/** @param {import("../types/repair.js").RepairEffect} effect @param {Json} receipt */
		effectReceipt(effect, receipt) {
			return storage.transaction(db => {
				read(db, effect.preparationId, effect.preparationDigest);
				const row = db.prepare("SELECT document FROM planning_repair_effects WHERE id = ?").get(effect.id);
				if (!row) throw storageError("repair_intent_missing", "Effect receipt requires retained intent");
				const retained = repairObject(parseJson(String(row.document)));
				if (stableStringify(retained.effect) !== stableStringify(effect)) throw storageError("repair_effect_conflict", "Receipt effect changed");
				if (retained.receipt !== null && stableStringify(retained.receipt) !== stableStringify(receipt)) {
					const before = repairObject(retained.receipt);
					const after = repairObject(receipt);
					const fields = ["effectDigest", "transactionId", "nativeRunId", "consumed", "resourceClaims", "budgetClaims", "checks"];
					if (["denied", "unavailable"].includes(String(before.disposition)) || Object.hasOwn(before, "output")
						|| fields.some(field => stableStringify(before[field]) !== stableStringify(after[field]))) {
						throw storageError("repair_receipt_conflict", "Conflicting or denied native consumption cannot be changed by reconciliation");
					}
				}
				const receipts = Array.isArray(retained.receipts) ? retained.receipts : retained.receipt === null ? [] : [retained.receipt];
				const history = receipts.some(value => stableStringify(value) === stableStringify(receipt)) ? receipts : [...receipts, receipt];
				const document = repairObject({ ...retained, state: "settled", receipt, receipts: history });
				db.prepare("UPDATE planning_repair_effects SET document=? WHERE id=?").run(stableStringify(document), effect.id);
				db.prepare("INSERT INTO planning_repair_events (id,event,payload) VALUES (?,?,?)")
					.run(effect.preparationId, "effect-receipt", stableStringify(receipt));
				return document;
			}, { write: true });
		},
		/** @param {string} id @param {string} digest */
		effects(id, digest) {
			return storage.transaction(db => {
				read(db, id, digest);
				return db.prepare("SELECT document FROM planning_repair_effects WHERE repair_id=? ORDER BY rowid").all(id)
					.map(row => repairObject(parseJson(String(row.document))));
			});
		},
		/** @param {string} id @param {string} digest */
		intent(id, digest) {
			return update(id, digest, record => {
				if (record.preparation.mode !== "recovery" || record.state !== "prepared") {
					throw storageError("repair_admission_held", "A repair admission already exists; reconcile it without another launch");
				}
				record.state = "intent";
				return { event: "intent", payload: readJsonValue({ preparationId: id, preparationDigest: digest }) };
			});
		},
		/** Native outcomes append history, including late failures after execution starts.
		 * @param {string} id @param {string} digest @param {"denied"|"unavailable"|"uncertain"|"admitted"} state
		 * @param {string|null} runId @param {Json} evidence */
		outcome(id, digest, state, runId, evidence) {
			return update(id, digest, record => {
				if (record.state === "prepared") throw storageError("repair_intent_missing", "Native outcome has no prior durable intent");
				if (state === "admitted" && ["denied", "unavailable"].includes(record.state)) {
					throw storageError("repair_admission_held", "A denied or unavailable admission cannot be converted into a new permission");
				}
				if (runId !== null && record.runId !== null && runId !== record.runId) throw storageError("repair_run_mismatch", "Conflicting native run observations retain the original claim");
				if (state === "admitted" && !runId) throw storageError("repair_run_mismatch", "Admission requires a native run");
				if (record.runId === null) record.runId = runId;
				if (!["denied", "unavailable"].includes(record.state)
					&& (["denied", "unavailable"].includes(state) || !["executing", "completed"].includes(record.state))) record.state = state;
				return { event: state, payload: readJsonValue({ runId, evidence }) };
			});
		},
		/** Historical replay does not grant another effect.
		 * @param {string} id @param {string} digest @param {string} runId */
		begin(id, digest, runId) {
			return update(id, digest, record => {
				if (!runId || (record.preparation.mode === "inline") !== (record.preparation.rootRunId === runId)) {
					throw storageError("repair_run_mismatch", "Recovery requires a distinct native repair run");
				}
				if (record.runId !== null && record.runId !== runId) throw storageError("repair_budget_spent", "A different run already owns this repair allowance");
				if (record.state === "completed" || (record.state === "executing" && record.candidate !== null)) {
					return { event: "replay", payload: { runId } };
				}
				throw storageError("repair_admission_unavailable", "Legacy journal state is history, not native permission for a fresh generation effect");
			});
		},
		/** @param {string} id @param {string} digest @param {string} runId @param {import("../types/repair.js").RepairCandidate} candidate */
		candidate(id, digest, runId, candidate) {
			return update(id, digest, record => {
				bound(record, runId);
				if (record.state !== "executing" || record.candidate !== null) throw storageError("repair_execution_held", "The repair author output is immutable");
				record.candidate = { candidate: readJsonValue(candidate.candidate), issue: candidate.issue };
				return { event: "candidate", payload: readJsonValue(record.candidate) };
			});
		},
		/** @param {string} id @param {string} digest @param {string} runId @param {Json} result */
		complete(id, digest, runId, result) {
			return update(id, digest, record => {
				bound(record, runId);
				if (record.state === "completed" && stableStringify(record.result) === stableStringify(result)) return { event: "result-replayed", payload: { runId } };
				if (record.state !== "executing" || !record.candidate) throw storageError("repair_execution_held", "A result requires the retained author output");
				record.result = repairObject(result);
				record.state = "completed";
				return { event: "completed", payload: record.result };
			});
		},
		/** @param {string} id @param {string} digest */
		events(id, digest) {
			return storage.transaction(db => {
				read(db, id, digest);
				return db.prepare("SELECT seq, event, payload FROM planning_repair_events WHERE id = ? ORDER BY seq")
					.all(id).map(row => ({ seq: Number(row.seq), event: String(row.event), payload: readJsonValue(parseJson(String(row.payload))) }));
			});
		},
	};
}
