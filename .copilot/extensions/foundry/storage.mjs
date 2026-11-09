import { randomUUID } from "node:crypto";
import { errorCode, errorMessage, parseJson, property } from "./data.mjs";
import { assertPlanId } from "./plan/fields.mjs";
import { summarizePlan } from "./plan/queries.mjs";
import { PLAN_STATUS } from "./plan/values.mjs";
import { createArtifactDatabase } from "./storage/database.mjs";
import { ownSnapshot, parsePlanDocument, readActivation, readPlan, readRecord, serializePlan } from "./storage/documents.mjs";
import { storageError } from "./storage/errors.mjs";

/**
 * @typedef {object} PlanStoreOptions
 * @property {string} [workspacePath]
 * @property {() => Date|string|number} [clock]
 * @property {number} [busyTimeoutMs]
 */
/** @typedef {import("./types/plan.js").FoundryPlan} FoundryPlan */

const SCHEMA_VERSION = 1;

const APPLICATION_ID = 0x464e4452;

const DEFAULT_LIST_LIMIT = 50;

const MAX_LIST_LIMIT = 100;

/** @param {() => Date|string|number} clock */
function resolveTimestamp(clock) {
	const value = clock();
	const date = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(date.getTime())) {
		throw storageError("invalid_clock", "The storage clock returned an invalid timestamp");
	}
	return date.toISOString();
}

/** @param {number} expectedRevision */
function validateExpectedRevision(expectedRevision) {
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
		throw storageError("invalid_expected_revision", "expectedRevision must be a positive safe integer", {
			details: { expectedRevision },
		});
	}
}

/** @param {unknown} expectedRevision */
function validateCreateRevision(expectedRevision) {
	if (expectedRevision !== 0) {
		throw storageError("invalid_expected_revision", "Creating or importing a plan requires expectedRevision 0", {
			details: { expectedRevision },
		});
	}
}

/** @param {string} id @param {number} expectedRevision @param {number} latestRevision */
function revisionConflict(id, expectedRevision, latestRevision) {
	return storageError("revision_conflict", `Plan ${id} has changed`, {
		details: { id, expectedRevision, latestRevision },
	});
}

/** @param {import("node:sqlite").DatabaseSync} db */
function initialize(db) {
	const version = db.prepare("PRAGMA user_version").get()?.user_version;
	const application = db.prepare("PRAGMA application_id").get()?.application_id;
	if (version === SCHEMA_VERSION && application === APPLICATION_ID) return;
	if (version !== 0 || application !== 0
		|| db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
		throw storageError("database_version_unsupported", "The Foundry database has an unknown schema or owner", {
			details: { version, application },
		});
	}
	db.exec(`
		CREATE TABLE plans (
			id TEXT PRIMARY KEY NOT NULL,
			revision INTEGER NOT NULL CHECK (revision > 0),
			document TEXT NOT NULL
		) STRICT;
		CREATE TABLE activation (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			plan_id TEXT NOT NULL,
			activated_at TEXT NOT NULL
		) STRICT;
		CREATE TABLE quarantine (
			id TEXT PRIMARY KEY NOT NULL,
			plan_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			document TEXT NOT NULL,
			reason TEXT NOT NULL,
			requested_by TEXT NOT NULL,
			quarantined_at TEXT NOT NULL
		) STRICT;
		PRAGMA application_id = ${APPLICATION_ID};
		PRAGMA user_version = ${SCHEMA_VERSION};
	`);
}

/** @param {PlanStoreOptions} [options] */
export function createPlanStore(options = {}) {
	const clock = options.clock ?? (() => new Date());
	if (typeof clock !== "function") throw storageError("invalid_clock", "clock must be a function");
	const { transaction, directory, databasePath, verifyFiles } = createArtifactDatabase({
		...options, initialize, schemaVersion: SCHEMA_VERSION,
	});

	/** @param {{plan: FoundryPlan, document: string}} persisted */
	const insertPlan = (persisted) => transaction((db) => {
		if (readRecord(db, persisted.plan.id)) {
			const current = readPlan(db, persisted.plan.id);
			throw storageError("plan_exists", `Plan ${persisted.plan.id} already exists`, {
				details: { id: persisted.plan.id, latestRevision: current.revision },
			});
		}
		db.prepare("INSERT INTO plans (id, revision, document) VALUES (?, ?, ?)")
			.run(persisted.plan.id, persisted.plan.revision, persisted.document);
		return persisted.plan;
	}, { write: true });

	/** @param {unknown} plan @param {0} [expectedRevision] */
	const create = async (plan, expectedRevision) => {
		validateCreateRevision(expectedRevision);
		const persisted = serializePlan(ownSnapshot(plan, "invalid_new_plan"), "invalid_new_plan");
		if (persisted.plan.revision !== 1 || persisted.plan.status !== PLAN_STATUS.DRAFT) {
			throw storageError("invalid_new_plan", "A new plan must be a draft at revision 1", {
				details: { revision: persisted.plan.revision, status: persisted.plan.status },
			});
		}
		return insertPlan(persisted);
	};

	/** @param {string} id */
	const read = async (id) => {
		assertPlanId(id);
		return transaction((db) => readPlan(db, id));
	};

	/**
	 * Receives an owned, validated snapshot and commits exactly one candidate.
	 * Async/thenable results are rejected, and every failure rolls back.
	 *
	 * @param {string} id
	 * @param {number} expectedRevision
	 * @param {(current: FoundryPlan) => unknown} mutate
	 */
	const mutatePlan = async (id, expectedRevision, mutate) => {
		assertPlanId(id);
		validateExpectedRevision(expectedRevision);
		if (typeof mutate !== "function" || mutate.constructor?.name === "AsyncFunction") {
			throw storageError("invalid_mutation", "mutate must be a synchronous function");
		}
		return transaction((db) => {
			const current = readPlan(db, id);
			if (current.revision !== expectedRevision) throw revisionConflict(id, expectedRevision, current.revision);
			const createdAt = current.createdAt;
			const candidate = mutate(current);
			if (candidate && (typeof candidate === "object" || typeof candidate === "function")
				&& "then" in candidate && typeof candidate.then === "function") {
				// Observe a rejected Promise without allowing it to outlive a commit.
				Promise.resolve(candidate).catch(() => { });
				throw storageError("invalid_mutation", "mutate must return a candidate synchronously, not a Promise");
			}
			const snapshot = ownSnapshot(candidate, "candidate_invalid");
			if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
				throw storageError("candidate_invalid", "mutate must return a plan document");
			}
			const persisted = serializePlan({
				...snapshot,
				revision: expectedRevision + 1,
				updatedAt: resolveTimestamp(clock),
			}, "candidate_invalid");
			if (persisted.plan.id !== id || persisted.plan.createdAt !== createdAt) {
				throw storageError("immutable_plan_identity", "An update cannot change id or createdAt", {
					details: { id },
				});
			}
			verifyFiles();
			const result = db.prepare(
				"UPDATE plans SET document = ?, revision = ? WHERE id = ? AND revision = ?",
			).run(persisted.document, persisted.plan.revision, id, expectedRevision);
			if (result.changes !== 1) throw revisionConflict(id, expectedRevision, readPlan(db, id).revision);
			return persisted.plan;
		}, { write: true });
	};

	/** @param {string} id @param {number} expectedRevision @param {unknown} candidate */
	const update = async (id, expectedRevision, candidate) => mutatePlan(id, expectedRevision, () => candidate);

	/** @param {{limit?: number}} [listOptions] */
	const list = async (listOptions = {}) => {
		const limit = listOptions.limit ?? DEFAULT_LIST_LIMIT;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
			throw storageError("invalid_list_limit", `limit must be an integer from 1 through ${MAX_LIST_LIMIT}`, {
				details: { limit },
			});
		}
		return transaction((db) => {
			const rows = db.prepare(
				"SELECT id FROM plans ORDER BY id LIMIT ?",
			).all(limit + 1);
			const plans = [];
			const invalid = [];
			for (const row of rows.slice(0, limit)) {
				const id = row.id;
				if (typeof id !== "string") throw storageError("database_invalid", "A stored plan ID is not a string");
				try {
					assertPlanId(id);
					const summary = summarizePlan(readPlan(db, id));
					plans.push({
						...summary,
						objective: summary.objective.length > 240
							? `${summary.objective.slice(0, 237)}...` : summary.objective,
					});
				} catch (error) {
					const code = errorCode(error);
					if (!code || !["invalid_plan_id", "artifact_invalid", "artifact_identity_mismatch"].includes(code)) {
						throw error;
					}
					invalid.push({
						id,
						code,
						message: errorMessage(error),
						details: property(error, "details") ?? null,
					});
				}
			}
			return { plans, invalid, truncated: rows.length > limit };
		});
	};

	/** @param {string} id @param {{reason: string, requestedBy: string}} quarantineOptions */
	const quarantineInvalidPlan = async (id, quarantineOptions) => {
		assertPlanId(id);
		const reason = String(quarantineOptions?.reason ?? "").trim();
		const requestedBy = String(quarantineOptions?.requestedBy ?? "").trim();
		if (!reason || !requestedBy) {
			throw storageError("invalid_quarantine_request", "Quarantining a plan requires reason and requestedBy", {
				details: { id },
			});
		}
		return transaction((db) => {
			const record = readRecord(db, id);
			if (!record) throw storageError("plan_not_found", `Plan ${id} does not exist`, { details: { id } });
			let invalid = false;
			try {
				parsePlanDocument(record.document, id);
			} catch (error) {
				if (!["artifact_invalid", "artifact_identity_mismatch"].includes(errorCode(error) ?? "")) throw error;
				invalid = true;
			}
			if (!invalid) throw storageError("artifact_valid", `Plan ${id} is valid and cannot be quarantined`);
			const quarantinedAt = resolveTimestamp(clock);
			const quarantineId = randomUUID();
			verifyFiles();
			db.prepare(
				"INSERT INTO quarantine (id, plan_id, revision, document, reason, requested_by, quarantined_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(quarantineId, id, record.revision, record.document, reason, requestedBy, quarantinedAt);
			db.prepare("DELETE FROM plans WHERE id = ?").run(id);
			return { planId: id, quarantineId, reason, requestedBy, quarantinedAt };
		}, { write: true });
	};

	/** @param {string} planId @param {number} expectedRevision */
	const activate = async (planId, expectedRevision) => {
		assertPlanId(planId);
		validateExpectedRevision(expectedRevision);
		return transaction((db) => {
			const plan = readPlan(db, planId);
			if (plan.revision !== expectedRevision) throw revisionConflict(planId, expectedRevision, plan.revision);
			const marker = { planId, activatedAt: resolveTimestamp(clock) };
			verifyFiles();
			db.prepare(
				"INSERT INTO activation (singleton, plan_id, activated_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET plan_id = excluded.plan_id, activated_at = excluded.activated_at",
			).run(planId, marker.activatedAt);
			return marker;
		}, { write: true });
	};

	const getActivation = async () => transaction((db) => readActivation(db));
	const getActive = async () => transaction((db) => {
		const marker = readActivation(db);
		return marker ? { ...marker, plan: readPlan(db, marker.planId) } : null;
	});

	const deactivate = async () => transaction((db) => {
		/** @type {ReturnType<typeof readActivation>} */
		let marker = null;
		let repaired = false;
		try {
			marker = readActivation(db);
		} catch (error) {
			if (!["activation_invalid", "invalid_plan_id"].includes(errorCode(error) ?? "")) throw error;
			repaired = true;
		}
		if (!marker && !repaired) return { deactivated: false, planId: null, repaired: false };
		db.prepare("DELETE FROM activation WHERE singleton = 1").run();
		return { deactivated: true, planId: marker?.planId ?? null, repaired };
	}, { write: true });

	/** @param {unknown} source @param {{expectedRevision: 0}} importOptions */
	const importPlan = async (source, importOptions) => {
		validateCreateRevision(importOptions?.expectedRevision);
		let plan = source;
		if (typeof source === "string") {
			try {
				plan = parseJson(source);
			} catch (cause) {
				throw storageError("import_invalid", "The imported plan contains invalid JSON", { cause });
			}
		}
		return insertPlan(serializePlan(ownSnapshot(plan, "import_invalid"), "import_invalid"));
	};

	/** @param {string} id */
	const exportPlan = async (id) => `${JSON.stringify(await read(id), null, 2)}\n`;

	return Object.freeze({
		create,
		read,
		update,
		mutate: mutatePlan,
		list,
		quarantineInvalidPlan,
		activate,
		getActivation,
		getActive,
		deactivate,
		importPlan,
		exportPlan,
		directory,
		databasePath,
	});
}
