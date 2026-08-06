/** @module schema — canonical Conveyor run values, limits, statuses, and failures. */

export const TERMINAL_STATUSES = new Set(["complete", "partial", "failed", "error", "paused", "cancelled", "timeout", "interrupted"]);
export const LIMIT_KEYS = ["maxConcurrentAgents", "maxTotalAgents", "timeoutSeconds", "maxAiCredits"];

export class LimitError extends Error {
	constructor(kind, value, consumed) {
		super(`Conveyor limit ${kind} reached (${consumed}/${value})`);
		this.kind = kind;
		this.value = value;
		this.consumed = consumed;
	}
}

export class AccountingError extends Error {}

/** @param {unknown} status */
export function isTerminalStatus(status) {
	return TERMINAL_STATUSES.has(String(status));
}

/** Normalize and validate a partial limits object. @param {unknown} value */
export function normalizeLimits(value) {
	if (value == null) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("limits must be an object");
	const input = /** @type {Record<string, unknown>} */ (value);
	for (const key of Object.keys(input)) if (!LIMIT_KEYS.includes(key)) throw new TypeError(`unknown Conveyor limit '${key}'`);
	/** @type {Record<string, number>} */
	const limits = {};
	for (const key of LIMIT_KEYS) {
		const raw = input[key];
		if (raw == null) continue;
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) throw new TypeError(`${key} must be a positive finite number`);
		if (key !== "timeoutSeconds" && key !== "maxAiCredits" && !Number.isInteger(raw)) throw new TypeError(`${key} must be a positive integer`);
		limits[key] = raw;
	}
	return limits;
}

/** Normalize unique declared phase metadata. @param {unknown} value */
export function normalizePhases(value) {
	if (value == null) return [];
	if (!Array.isArray(value)) throw new TypeError("meta.phases must be an array");
	const titles = new Set();
	return value.map((entry, ordinal) => {
		const phase = typeof entry === "string" ? { title: entry } : entry;
		if (!phase || typeof phase !== "object" || Array.isArray(phase) || typeof phase.title !== "string" || !phase.title.trim()) {
			throw new TypeError(`meta.phases[${ordinal}] must be a title string or { title, detail? }`);
		}
		const title = phase.title.trim();
		if (titles.has(title)) throw new TypeError(`meta phase '${title}' is declared more than once`);
		titles.add(title);
		return {
			id: `phase:${ordinal}`,
			ordinal,
			title,
			...(typeof phase.detail === "string" && phase.detail.trim() ? { detail: phase.detail.trim() } : {}),
		};
	});
}

/** Apply approved overrides; limits may never be lowered below declared or consumed values. */
export function approveLimits(declared, priorApproved, requested, consumed = {}) {
	const base = { ...normalizeLimits(declared), ...normalizeLimits(priorApproved) };
	const next = normalizeLimits(requested);
	for (const key of LIMIT_KEYS) {
		if (next[key] == null) continue;
		if (key === "maxConcurrentAgents") {
			base[key] = next[key];
			continue;
		}
		const floor = Math.max(Number(base[key] || 0), consumedFor(key, consumed));
		if (next[key] < floor) throw new TypeError(`${key} cannot be lowered below ${floor}`);
		base[key] = next[key];
	}
	return base;
}

/** @param {string} kind @param {number} value @param {number} consumed */
export function limitFailure(kind, value, consumed) {
	return { type: "limit_reached", kind, value, consumed };
}

/** @param {string} operation @param {unknown} error */
export function durableFailure(operation, error) {
	const value = /** @type {NodeJS.ErrnoException} */ (error);
	return {
		type: "durable_failure",
		operation,
		code: typeof value?.code === "string" ? value.code : "unknown",
		message: error instanceof Error ? error.message : String(error),
	};
}

/** @param {unknown} error */
export function harnessFailure(error) {
	return { type: "harness_failure", message: error instanceof Error ? error.message : String(error) };
}

/** @param {unknown} reason */
export function interruptionFailure(reason) {
	const kind = reason && typeof reason === "object" ? /** @type {any} */ (reason).kind : reason;
	return { type: "interrupted", reason: String(kind || "interrupted") };
}

/**
 * Validate a strict JSON value. `undefined` is accepted only when explicitly allowed.
 * @param {unknown} value
 * @param {{ allowUndefined?: boolean, label?: string }} [options]
 */
export function assertJson(value, options = {}) {
	const label = options.label || "value";
	const ancestors = new Set();
	const visit = (current, path, top) => {
		if (current === undefined) {
			if (top && options.allowUndefined) return;
			throw new TypeError(`${label} contains undefined at ${path}`);
		}
		if (current === null || typeof current === "string" || typeof current === "boolean") return;
		if (typeof current === "number") {
			if (!Number.isFinite(current)) throw new TypeError(`${label} contains a non-finite number at ${path}`);
			return;
		}
		if (typeof current !== "object") throw new TypeError(`${label} contains a non-JSON value at ${path}`);
		if (ancestors.has(current)) throw new TypeError(`${label} contains a cycle at ${path}`);
		ancestors.add(current);
		try {
			if (Array.isArray(current)) {
				for (let index = 0; index < current.length; index++) visit(current[index], `${path}[${index}]`, false);
				return;
			}
			const prototype = Object.getPrototypeOf(current);
			const crossRealmPlain =
				prototype !== null &&
				Object.getPrototypeOf(prototype) === null &&
				typeof prototype.constructor === "function" &&
				prototype.constructor.name === "Object";
			if (prototype !== Object.prototype && prototype !== null && !crossRealmPlain) {
				throw new TypeError(`${label} contains a non-plain object at ${path}`);
			}
			for (const key of Reflect.ownKeys(current)) {
				if (typeof key === "symbol") throw new TypeError(`${label} contains symbol properties at ${path}`);
				const descriptor = Object.getOwnPropertyDescriptor(current, key);
				if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError(`${label} contains an accessor or non-enumerable property at ${path}.${key}`);
				visit(descriptor.value, `${path}.${key}`, false);
			}
		} finally {
			ancestors.delete(current);
		}
	};
	visit(value, "$", true);
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Build the canonical persisted run envelope. */
export function runEnvelope(input) {
	const envelope = {
		runId: String(input.runId),
		status: String(input.status),
		revision: Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
		...(input.conveyor ? { conveyor: assertJson(input.conveyor, { label: "Conveyor metadata" }) } : {}),
		...(input.startedAt ? { startedAt: String(input.startedAt) } : {}),
		...(input.finishedAt ? { finishedAt: String(input.finishedAt) } : {}),
		...(Number.isFinite(input.durationMs) ? { durationMs: input.durationMs } : {}),
		...(input.budget ? { budget: assertJson(input.budget, { label: "Conveyor budget" }) } : {}),
		...(Number.isFinite(input.aic) ? { aic: input.aic } : {}),
		...(input.counts ? { counts: assertJson(input.counts, { label: "Conveyor counts" }) } : {}),
		...(Array.isArray(input.preservedWorktrees) ? { preservedWorktrees: assertJson(input.preservedWorktrees) } : {}),
		...(Array.isArray(input.preservedSessions) ? { preservedSessions: assertJson(input.preservedSessions) } : {}),
		...(Number.isFinite(input.plannedMaxAgents) ? { plannedMaxAgents: input.plannedMaxAgents } : {}),
		...(input.result !== undefined ? { result: assertJson(input.result, { label: "Conveyor result" }) } : {}),
		...(input.error ? { error: String(input.error) } : {}),
		...(input.failure ? { failure: assertJson(input.failure, { label: "Conveyor failure" }) } : {}),
	};
	return envelope;
}

/** @param {string} key @param {Record<string, unknown>} consumed */
function consumedFor(key, consumed) {
	if (key === "timeoutSeconds") return Number(consumed.activeMs || 0) / 1000;
	if (key === "maxTotalAgents") return Number(consumed.spawnedAgents || 0);
	if (key === "maxAiCredits") return Number(consumed.nanoAiu || 0) / 1_000_000_000;
	return 0;
}
