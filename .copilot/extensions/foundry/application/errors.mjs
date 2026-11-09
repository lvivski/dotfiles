import { FoundryStorageError } from "../storage/errors.mjs";

/** Typed operation-layer error for failures outside pure domain transitions. */
export class FoundryOperationError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 * @param {unknown} [details]
	 */
	constructor(code, message, details = null) {
		super(message);
		this.name = "FoundryOperationError";
		this.code = code;
		this.details = details;
	}
}

/**
 * Creates the standard stale-revision storage error.
 *
 * @param {string} planId
 * @param {number} expectedRevision
 * @param {number} latestRevision
 * @returns {FoundryStorageError}
 */
export function revisionConflict(planId, expectedRevision, latestRevision) {
	return new FoundryStorageError("revision_conflict", `Plan ${planId} has changed`, {
		details: { planId, expectedRevision, latestRevision },
	});
}
