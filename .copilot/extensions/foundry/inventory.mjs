/** @module inventory — validation and causal interpretation of App session inventories. */
import { isList, isRecord } from "./data.mjs";

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
	return state === "absent" || TERMINAL_SESSION_STATUSES.has(state);
}
