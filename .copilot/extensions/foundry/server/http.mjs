import { timingSafeEqual } from "node:crypto";
import { constants as bufferConstants } from "node:buffer";
import { errorCode, errorMessage, parseJson, property } from "../data.mjs";

/** HTTP-aware error for request validation failures. */
export class FoundryHttpError extends Error {
	/**
	 * @param {number} statusCode
	 * @param {string} message
	 * @param {string} [code]
	 */
	constructor(statusCode, message, code = "foundry_canvas_error") {
		super(message);
		this.name = "FoundryHttpError";
		this.statusCode = statusCode;
		this.code = code;
	}
}

/**
 * Sends a non-cacheable JSON response.
 *
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {unknown} value
 * @returns {void}
 */
export function json(response, status, value) {
	if (response.destroyed) return;
	response.writeHead(status, {
		"Cache-Control": "no-store",
		"Content-Type": "application/json; charset=utf-8",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(value));
}

/**
 * Sends a CSP-protected static text response.
 *
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {string} contentType
 * @param {string} value
 * @returns {void}
 */
export function text(response, status, contentType, value) {
	response.writeHead(status, {
		"Cache-Control": "no-store",
		"Content-Type": contentType,
		"Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(value);
}

/**
 * Reads and parses a complete JSON request body.
 *
 * @param {import("node:http").IncomingMessage} request
 * @returns {Promise<unknown>}
 * @throws {Error} With an HTTP-compatible `statusCode` for invalid input.
 */
export async function readJson(request) {
	const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim();
	if (contentType !== "application/json") {
		throw new FoundryHttpError(415, "Content-Type must be application/json");
	}
	let size = 0;
	/** @type {Buffer[]} */
	const chunks = [];
	for await (const chunk of request) {
		if (!Buffer.isBuffer(chunk)) throw new FoundryHttpError(400, "Request body must contain bytes");
		size += chunk.length;
		if (size > bufferConstants.MAX_LENGTH) {
			throw new FoundryHttpError(413, "Request body exceeds the native buffer capacity");
		}
		chunks.push(chunk);
	}
	const content = Buffer.concat(chunks).toString("utf8");
	try {
		return parseJson(content);
	} catch {
		throw new FoundryHttpError(400, "Request body must contain valid JSON");
	}
}

/**
 * Compares action tokens without leaking a length-matched timing signal.
 *
 * @param {string} expected
 * @param {unknown} actual
 * @returns {boolean}
 */
export function tokenMatches(expected, actual) {
	if (typeof actual !== "string") {
		return false;
	}
	const expectedBuffer = Buffer.from(expected);
	const actualBuffer = Buffer.from(actual);
	return expectedBuffer.length === actualBuffer.length
		&& timingSafeEqual(expectedBuffer, actualBuffer);
}

/**
 * Maps Foundry failures to HTTP response status codes.
 *
 * @param {unknown} error
 * @returns {number}
 */
export function statusFor(error) {
	const statusCode = property(error, "statusCode");
	if (typeof statusCode === "number" && Number.isInteger(statusCode)) {
		return statusCode;
	}
	if (errorCode(error) === "revision_conflict") {
		return 409;
	}
	if (errorCode(error) === "plan_not_found") {
		return 404;
	}
	if (errorCode(error)) {
		return 400;
	}
	return 500;
}

/**
 * Redacts an error to the stable canvas error envelope.
 *
 * @param {unknown} error
 * @returns {{code: string, message: string, path: unknown, details: unknown}}
 */
export function publicError(error) {
	return {
		code: errorCode(error) ?? "foundry_canvas_error",
		message: errorMessage(error),
		path: property(error, "path") ?? null,
		details: property(error, "details") ?? null,
	};
}
