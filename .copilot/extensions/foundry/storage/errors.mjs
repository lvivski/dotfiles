import { isRecord } from "../data.mjs";

export class FoundryStorageError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 * @param {{details?: unknown, cause?: unknown}} [options]
	 */
	constructor(code, message, options = {}) {
		super(message);
		this.name = "FoundryStorageError";
		this.code = code;
		this.details = options.details ?? null;
		this.cause = options.cause;
	}

	toJSON() {
		return { code: this.code, message: this.message, details: this.details };
	}
}

/** @param {string} code @param {string} message @param {{details?: unknown, cause?: unknown}} [options] */
export function storageError(code, message, options) {
	return new FoundryStorageError(code, message, options);
}

/** @param {unknown} error */
export function sqliteError(error) {
	if (!isRecord(error) || typeof error.code !== "string" || !error.code.startsWith("ERR_SQLITE")) return error;
	const busy = [5, 6].includes(Number(error.errcode) & 0xff);
	return storageError(busy ? "storage_busy" : "database_error", busy
		? "Foundry storage is busy; retry after the current transaction finishes"
		: "Foundry could not complete its SQLite operation", {
		details: { sqliteCode: error.errcode ?? null, sqliteMessage: error.message },
		cause: error,
	});
}
