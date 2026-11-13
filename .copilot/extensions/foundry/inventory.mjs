/** @module inventory — validation and causal interpretation of App session inventories. */
import { isList, isRecord } from "./data.mjs";
import { object, strings, text, timestamp } from "./factory/fields.mjs";
import { attemptIdentity } from "./plan/parallel-contracts.mjs";

/** @typedef {{complete: boolean, capturedAt?: string | null, sessions: {id: string, status: string}[]}} SessionInventory */
/** @typedef {{supplied: boolean, complete: boolean, capturedAt: string | null, sessions: Map<string, string>}} NormalizedInventory */

/** App session states that imply result collection rather than continued work. */
export const TERMINAL_SESSION_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"archived",
]);

/** Typed validation error for host session inventories. */
export class FoundryInventoryError extends TypeError {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "FoundryInventoryError";
		this.code = "invalid_session_inventory";
	}
}

/** Validate and index an optional host session inventory. @param {unknown} inventory @returns {NormalizedInventory} */
export function normalizeInventory(inventory) {
	if (inventory === undefined || inventory === null) {
		return {
			supplied: false,
			complete: false,
			capturedAt: null,
			sessions: new Map(),
		};
	}
	if (!isRecord(inventory)
		|| typeof inventory.complete !== "boolean"
		|| !isList(inventory.sessions)) {
		throw new FoundryInventoryError("sessionInventory must contain complete and sessions");
	}
	/** @type {string | null} */
	let capturedAt = null;
	const suppliedCapturedAt = inventory.capturedAt ?? null;
	try {
		capturedAt = typeof suppliedCapturedAt === "string"
			? new Date(suppliedCapturedAt).toISOString()
			: null;
	} catch {
		capturedAt = null;
	}
	if (capturedAt !== suppliedCapturedAt) {
		throw new FoundryInventoryError(
			"sessionInventory.capturedAt must be a canonical timestamp",
		);
	}
	/** @type {Map<string, string>} */
	const sessions = new Map();
	for (const entry of inventory.sessions) {
		if (!isRecord(entry)
			|| typeof entry.id !== "string"
			|| !entry.id.trim()
			|| typeof entry.status !== "string"
			|| !entry.status.trim()
			|| sessions.has(entry.id)) {
			throw new FoundryInventoryError(
				"sessionInventory contains an invalid or duplicate session",
			);
		}
		sessions.set(entry.id, entry.status);
	}
	return {
		supplied: true,
		complete: inventory.complete,
		capturedAt,
		sessions,
	};
}

/** Resolve the best-known App session state for an attempt.
 * @param {Pick<import("./types/plan.js").FoundryAttempt, "sessionId" | "startedAt" | "reservedAt">} attempt
 * @param {NormalizedInventory} inventory
 */
export function sessionState(attempt, inventory) {
	if (attempt.sessionId === null) return "unattached";
	if (!inventory.supplied) return "unknown";
	const status = inventory.sessions.get(attempt.sessionId);
	if (status !== undefined) return status;
	const attemptObservedAt = attempt.startedAt ?? attempt.reservedAt;
	return inventory.complete
		&& inventory.capturedAt !== null
		&& Date.parse(inventory.capturedAt) > Date.parse(attemptObservedAt)
		? "absent"
		: "unknown";
}

/** Whether an observed session state is terminal enough for cancellation finalization. @param {string} state */
export function isTerminatedSessionState(state) {
	return TERMINAL_SESSION_STATUSES.has(state);
}

/** @typedef {{id: string, status: string, attempt: import("./types/parallel.js").AttemptIdentity}} OwnedNativeEntry */
/** @typedef {{complete: boolean, capturedAt: string, source: string, sessions: OwnedNativeEntry[], runs: OwnedNativeEntry[]}} RecoveryInventory */
/** @typedef {{attempt: import("./types/parallel.js").AttemptIdentity, sessionIds: string[], runIds: string[], source: string, capturedAt: string}} RecoveryObservation */

/** @param {unknown} value @returns {RecoveryObservation} */
export function normalizeRecoveryObservation(value) {
	object(value, ["attempt", "sessionIds", "runIds", "source", "capturedAt"], "recovery observation");
	return {
		attempt: attemptIdentity(value.attempt),
		sessionIds: strings(value.sessionIds, "observed sessions", Number.MAX_SAFE_INTEGER),
		runIds: strings(value.runIds, "observed runs", Number.MAX_SAFE_INTEGER),
		source: text(value.source, "observation source", 4096),
		capturedAt: timestamp(value.capturedAt, "observation time"),
	};
}

/** Correlation is supplied by the owning native adapter, never inferred from names,
 * branch labels, imported history, or a missing row.
 * @param {unknown} value @returns {RecoveryInventory} */
export function normalizeRecoveryInventory(value) {
	if (!isRecord(value) || typeof value.source !== "string" || !value.source.trim()
		|| !isList(value.runs) || !isList(value.sessions)
		|| Object.keys(value).some(key => !["complete", "capturedAt", "source", "sessions", "runs"].includes(key))) {
		throw new FoundryInventoryError("Recovery requires a sourced native session and run inventory");
	}
	const normalized = normalizeInventory(value);
	if (normalized.capturedAt === null) throw new FoundryInventoryError("Recovery requires an inventory capture time");
	normalizeInventory({ complete: value.complete, capturedAt: value.capturedAt, sessions: value.runs });
	/** @param {unknown[]} entries @returns {OwnedNativeEntry[]} */
	const owned = entries => entries.map(entry => {
		if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.status !== "string"
			|| Object.keys(entry).some(key => !["id", "status", "attempt"].includes(key))) {
			throw new FoundryInventoryError("Recovery entries require exact native identity and attempt correlation");
		}
		return { id: entry.id, status: entry.status, attempt: attemptIdentity(entry.attempt) };
	});
	return {
		complete: normalized.complete, capturedAt: normalized.capturedAt, source: value.source,
		sessions: owned(value.sessions), runs: owned(value.runs),
	};
}
