/** Typed failure raised when analysis input or output violates its contract. */
export class FoundryAnalysisError extends Error {
	/**
	 * @param {string} code Stable machine-readable error code.
	 * @param {string} message Human-readable failure summary.
	 * @param {unknown} [details] Structured validation context.
	 */
	constructor(code, message, details = null) {
		super(message);
		this.name = "FoundryAnalysisError";
		this.code = code;
		this.details = details;
	}
}

/**
 * Throws a typed analysis failure.
 *
 * @param {string} code
 * @param {string} message
 * @param {unknown} [details]
 * @returns {never}
 */
export function fail(code, message, details) {
	throw new FoundryAnalysisError(code, message, details);
}
