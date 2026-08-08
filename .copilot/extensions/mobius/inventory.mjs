/** @module inventory — validation and causal interpretation of App session inventories. */

/** App session states that imply result collection rather than continued work. */
export const TERMINAL_SESSION_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"archived",
]);

/** Typed validation error for host session inventories. */
export class MobiusInventoryError extends TypeError {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "MobiusInventoryError";
		this.code = "invalid_session_inventory";
	}
}

/** Validate and index an optional host session inventory. */
export function normalizeInventory(inventory) {
	if (inventory === undefined || inventory === null) {
		return {
			supplied: false,
			complete: false,
			capturedAt: null,
			sessions: new Map(),
		};
	}
	if (typeof inventory !== "object"
		|| Array.isArray(inventory)
		|| typeof inventory.complete !== "boolean"
		|| !Array.isArray(inventory.sessions)) {
		throw new MobiusInventoryError("sessionInventory must contain complete and sessions");
	}
	let capturedAt = null;
	try {
		capturedAt = typeof inventory.capturedAt === "string"
			? new Date(inventory.capturedAt).toISOString()
			: null;
	} catch {
		capturedAt = null;
	}
	if (capturedAt !== inventory.capturedAt) {
		throw new MobiusInventoryError(
			"sessionInventory.capturedAt must be a canonical timestamp",
		);
	}
	const sessions = new Map();
	for (const entry of inventory.sessions) {
		if (!entry
			|| typeof entry !== "object"
			|| Array.isArray(entry)
			|| typeof entry.id !== "string"
			|| !entry.id.trim()
			|| typeof entry.status !== "string"
			|| !entry.status.trim()
			|| sessions.has(entry.id)) {
			throw new MobiusInventoryError(
				"sessionInventory contains an invalid or duplicate session",
			);
		}
		sessions.set(entry.id, entry.status);
	}
	return {
		supplied: true,
		complete: inventory.complete,
		capturedAt: inventory.capturedAt,
		sessions,
	};
}

/** Resolve the best-known App session state for an attempt. */
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

/** Whether an observed session state is terminal enough for cancellation finalization. */
export function isTerminatedSessionState(state) {
	return state === "absent" || TERMINAL_SESSION_STATUSES.has(state);
}
