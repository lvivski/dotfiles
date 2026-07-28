/** @module sandbox.test — deterministic VM: return value, console routing, blocked nondeterminism. */
import test from "node:test";
import assert from "node:assert/strict";

import { runHarness, DEFAULT_SYNC_TIMEOUT_MS } from "./sandbox.mjs";

/** @param {string} src @param {Record<string, unknown>} [api] */
const run = (src, api = {}) => runHarness(src, { api, log: () => {} });

test("returns the harness's final value (async body)", async () => {
	assert.equal(await run(`return 1 + 2;`), 3);
	assert.equal(await run(`const x = await Promise.resolve("hi"); return x + "!";`), "hi!");
});

test("injected API globals are visible to the harness", async () => {
	const api = { greet: (/** @type {string} */ n) => `hi ${n}`, args: { name: "cwf" } };
	assert.equal(await run(`return greet(args.name);`, api), "hi cwf");
});

test("console.log is routed to the log sink, not stdout", async () => {
	const lines = /** @type {string[]} */ ([]);
	await runHarness(`console.log("a", 1); return null;`, { api: {}, log: (m) => lines.push(m) });
	assert.deepEqual(lines, ["a 1"]);
});

test("Math.random is removed", async () => {
	await assert.rejects(run(`return Math.random();`), /not a function/);
	assert.equal(await run(`return "random" in Math;`), false);
});

test("a stray prototype write stays inside the run that made it", async () => {
	await run(`Object.prototype.strayWrite = 1; return 1;`);
	assert.equal(/** @type {any} */ ({}).strayWrite, undefined, "reached the extension's own realm");
	assert.equal(await run(`return ({}).strayWrite;`), undefined, "reached the next run");
});

test("Error identity is shared with the host, so `instanceof Error` holds across the boundary", async () => {
	const api = {
		boom() {
			throw new TypeError("from the host");
		},
	};
	assert.equal(
		await runHarness(`try { boom(); } catch (e) { return (e instanceof Error) + "|" + (e instanceof TypeError) + "|" + e.message; }`, { api, log: () => {} }),
		"true|true|from the host",
	);
});

test("deterministic web globals a bare vm context lacks are still available", async () => {
	assert.equal(await run(`return new URL("https://x.dev/a?b=1").host;`), "x.dev");
	assert.equal(await run(`return new TextEncoder().encode("hi").length;`), 2);
	assert.equal(await run(`return structuredClone({ a: [1] }).a[0];`), 1);
	assert.equal(await run(`return typeof Intl + "|" + btoa("hi");`), "object|aGk=");
});

test("dynamic import() is unavailable", async () => {
	await assert.rejects(run(`return await import("node:fs");`), /dynamic import|not available|not supported/i);
});

test("Date.now() and argless new Date() are blocked; new Date(ms) works", async () => {
	await assert.rejects(run(`return Date.now();`), /Date\.now\(\).*nondeterministic/);
	await assert.rejects(run(`return new Date();`), /new Date\(\).*nondeterministic/);
	await assert.rejects(run(`return Date();`), /Date\(\).*nondeterministic/);
	assert.equal(await run(`return new Date(0).toISOString();`), "1970-01-01T00:00:00.000Z");
});

test("eval and new Function are disabled (codeGeneration off)", async () => {
	await assert.rejects(run(`return eval("1+1");`), /EvalError|Code generation/);
	await assert.rejects(run(`return (new Function("return 1"))();`), /EvalError|Code generation/);
});

test("a compile error is reported clearly (plain-JS hint)", async () => {
	await assert.rejects(run(`return function (x: number) { return x; };`), /plain JavaScript|failed to parse/);
});

test("harness has no access to process / require / fs (sandbox isolation)", async () => {
	assert.equal(await run(`return typeof process + "|" + typeof require + "|" + typeof globalThis.process;`), "undefined|undefined|undefined");
	await assert.rejects(run(`return process.env.HOME;`), /process is not defined/);
});

test("a synchronous runaway harness is bounded by the VM timeout", async () => {
	assert.equal(DEFAULT_SYNC_TIMEOUT_MS, 5000);
	await assert.rejects(
		runHarness(`while (true) {}`, { api: {}, syncTimeoutMs: 25 }),
		/Script execution timed out after 25ms/,
	);
});
