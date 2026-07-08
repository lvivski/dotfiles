/**
 * @module fixtures/support
 *
 * Shared helpers for the workflow `*.test.mjs` suites: point the engine at the fake `copilot` backend
 * with an isolated `COPILOT_HOME`, and build throwaway result objects. Not a test file itself.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the mock `copilot` binary. */
export const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fake-copilot.mjs");

/**
 * Run `fn` with the engine pointed at the fake copilot + a fresh isolated `COPILOT_HOME`, then
 * restore env and clean up. `overrides` sets extra env (e.g. `CWF_FAKE_MODE`) for the body.
 * @template T
 * @param {Record<string, string>} overrides
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export function withFakeEnv(overrides, fn) {
	const home = mkdtempSync(join(tmpdir(), "cwf-home-"));
	const saved = { ...process.env };
	process.env.CWF_COPILOT_BIN = FAKE;
	process.env.COPILOT_HOME = home;
	for (const k of ["CWF_FAKE_MODE", "CWF_FAKE_CONTENT", "CWF_FAKE_STDERR", "CWF_MAX_FANOUT", "CWF_MAX_AGENTS"]) delete process.env[k];
	Object.assign(process.env, overrides);
	return Promise.resolve(fn()).finally(() => {
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
		rmSync(home, { recursive: true, force: true });
	});
}

/** @returns {string} a fresh temp directory path. */
export function tmpDir() {
	return mkdtempSync(join(tmpdir(), "cwf-"));
}

/**
 * Build a complete {@link import("../agent.mjs").AgentResult} for store/cache tests.
 * @param {Partial<import("../agent.mjs").AgentResult>} [over]
 * @returns {import("../agent.mjs").AgentResult}
 */
export function mkResult(over = {}) {
	return {
		content: "ok",
		ok: true,
		error: null,
		sessionId: "s",
		model: "m",
		cached: false,
		skipped: false,
		label: "a",
		nanoAiu: 500_000_000,
		aic: 0.5,
		outputTokens: 10,
		inputTokens: 20,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		durationMs: 1,
		exitCode: 0,
		warnings: null,
		...over,
	};
}
