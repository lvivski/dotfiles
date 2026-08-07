/**
 * @module fixtures/support
 *
 * Shared temporary-directory and environment helpers for Conveyor tests.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Run `fn` with temporary environment overrides, then restore the original environment.
 * @template T
 * @param {Record<string, string>} overrides
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export function withFakeEnv(overrides, fn) {
	const saved = { ...process.env };
	Object.assign(process.env, overrides);
	return Promise.resolve(fn()).finally(() => {
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
	});
}

/** @returns {string} a fresh temp directory path. */
export function tmpDir() {
	return mkdtempSync(join(tmpdir(), "conveyor-"));
}
