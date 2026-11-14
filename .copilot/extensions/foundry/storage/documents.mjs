import { errorCode, errorMessage, parseJson, property } from "../data.mjs";
import { assertPlanId } from "../plan/fields.mjs";
import { validatePlan } from "../plan/validation.mjs";
import { storageError } from "./errors.mjs";

/** @typedef {{revision: number, document: string}} PlanRecord */
/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */

/** @param {string} document @param {string} id @returns {FoundryPlan} */
export function parsePlanDocument(document, id) {
	let raw;
	try {
		raw = parseJson(document);
	} catch (cause) {
		throw storageError("artifact_invalid", `Plan ${id} contains invalid JSON`, {
			details: { id }, cause,
		});
	}
	let plan;
	try {
		plan = validatePlan(raw);
	} catch (cause) {
		throw storageError("artifact_invalid", `Plan ${id} failed schema validation`, {
			details: {
				id,
				validationCode: errorCode(cause) ?? null,
				validationPath: property(cause, "path") ?? null,
				validationMessage: errorMessage(cause),
			},
			cause,
		});
	}
	if (plan.id !== id) {
		throw storageError("artifact_identity_mismatch", `Plan ${id} declares id ${plan.id}`, {
			details: { expectedId: id, actualId: plan.id },
		});
	}
	return plan;
}

/** @template T @param {T} value @param {string} code @returns {T} */
export function ownSnapshot(value, code) {
	try {
		return structuredClone(value);
	} catch (cause) {
		throw storageError(code, "The plan could not be copied for storage", { cause });
	}
}

/** @param {unknown} snapshot @param {string} code */
export function serializePlan(snapshot, code) {
	try {
		const json = `${JSON.stringify(snapshot, null, 2)}\n`;
		const plan = validatePlan(parseJson(json));
		return { plan, document: json };
	} catch (cause) {
		throw storageError(code, "The serialized plan failed validation", {
			details: {
				validationCode: errorCode(cause) ?? null,
				validationPath: property(cause, "path") ?? null,
				validationMessage: errorMessage(cause),
			},
			cause,
		});
	}

}

/** Exports retain historical receipts, never active native bindings, private
 * references or owner-local publication authority. Apply on import as well.
 * @param {FoundryPlan} plan */
export function transferablePlan(plan) {
	return plan.operating ? { ...plan, operating: { ...plan.operating, local: [] } } : plan;
}

/** @param {import("node:sqlite").DatabaseSync} db @param {string} id @returns {PlanRecord|null} */
export function readRecord(db, id) {
	const row = db.prepare("SELECT document, revision FROM plans WHERE id = ?").get(id);
	if (!row) return null;
	if (typeof row.document !== "string" || typeof row.revision !== "number"
		|| !Number.isSafeInteger(row.revision) || row.revision < 1) {
		throw storageError("database_invalid", "Foundry plan storage has an invalid shape");
	}
	return { document: row.document, revision: row.revision };
}

/** @param {PlanRecord} record @param {string} id */
function validateRecord(record, id) {
	const plan = parsePlanDocument(record.document, id);
	if (record.revision !== plan.revision) {
		throw storageError("artifact_invalid", `Plan ${id} has inconsistent revision metadata`, {
			details: { id, latestRevision: record.revision },
		});
	}
	return plan;
}

/** @param {import("node:sqlite").DatabaseSync} db @param {string} id */
export function readPlan(db, id) {
	const record = readRecord(db, id);
	if (!record) {
		throw storageError("plan_not_found", `Plan ${id} does not exist`, { details: { id } });
	}
	return validateRecord(record, id);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function readActivation(db) {
	const row = db.prepare("SELECT plan_id, activated_at FROM activation WHERE singleton = 1").get();
	if (!row) return null;
	if (typeof row.plan_id !== "string" || typeof row.activated_at !== "string") {
		throw storageError("activation_invalid", "Foundry activation metadata failed validation");
	}
	const marker = { planId: row.plan_id, activatedAt: row.activated_at };
	assertPlanId(marker.planId, "planId");
	const date = new Date(marker.activatedAt);
	if (!Number.isFinite(date.getTime()) || date.toISOString() !== marker.activatedAt
		|| !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(marker.activatedAt)) {
		throw storageError("activation_invalid", "Foundry activation timestamp is invalid");
	}
	return marker;
}
