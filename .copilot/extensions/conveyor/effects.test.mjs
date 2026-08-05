/** @module effects.test — host effects: sidecar load, canonical keying, proxy, and checkpoint replay. */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadHost, buildHostProxy, sidecarPathFor } from "./effects.mjs";
import { Runtime } from "./runtime.mjs";
import { executeConveyor } from "./executor.mjs";
import { CheckpointStore } from "./checkpoint.mjs";
import { mkResult, tmpDir, withFakeEnv } from "./fixtures/support.mjs";

/** @param {string} body @returns {string} path to a temp sidecar module. */
function sidecar(body) {
	const p = join(tmpDir(), "cap.host.mjs");
	writeFileSync(p, body);
	return p;
}

// ---- pure glue ------------------------------------------------------------

test("sidecarPathFor maps <harness>.mjs → <harness>.host.mjs", () => {
	assert.equal(sidecarPathFor("/x/foo.mjs"), "/x/foo.host.mjs");
});

test("loadHost collects fn exports and mutates (meta list + fn tag)", async () => {
	const p = sidecar(`
export const meta = { mutates: ["w"] };
export async function r() { return 1; }
export async function w() { return 2; }
export function tagged() { return 3; }
tagged.mutates = true;
`);
	const h = await loadHost(p);
	assert.deepEqual(h.names.sort(), ["r", "tagged", "w"]);
	assert.ok(h.mutates.has("w") && h.mutates.has("tagged") && !h.mutates.has("r"));
});

test("loadHost rejects a sidecar with no effect functions", async () => {
	await assert.rejects(loadHost(sidecar("export const x = 1;")), /exports no effect functions/);
});

test("buildHostProxy: restricted and missing-sidecar throw only when called", () => {
	const restricted = buildHostProxy({ restricted: true });
	assert.equal(typeof restricted.anything, "function"); // access is safe
	assert.throws(() => restricted.anything(), /forbidden in restricted mode/);
	const none = buildHostProxy({ hasSidecar: false });
	assert.throws(() => none.foo(), /no host sidecar loaded/);
});

test("buildHostProxy routes known names and rejects unknown ones", async () => {
	const seen = /** @type {any[]} */ ([]);
	const proxy = buildHostProxy({ names: ["mine"], hasSidecar: true, invoke: async (n, i) => (seen.push([n, i]), "ok") });
	assert.equal(await proxy.mine({ a: 1 }), "ok");
	assert.deepEqual(seen, [["mine", { a: 1 }]]);
	assert.throws(() => proxy.nope(), /no host effect 'nope'/);
});

// ---- runtime wiring -------------------------------------------------------

/** @param {[string, (input?: any, ctx?: any) => any][]} entries @param {string[]} [mutates] */
const fakeHost = (entries, mutates = []) => {
	const fns = new Map(entries);
	return { fns, mutates: new Set(mutates), names: [...fns.keys()], hash: "fake-host-hash" };
};

test("effects are checkpointed and replayed on resume (not re-run)", async () => {
	const runDir = tmpDir();
	let calls = 0;
	const host = fakeHost([["ping", async (input) => ({ n: ++calls, input })]]);

	const rt1 = new Runtime({ checkpoints: new CheckpointStore(runDir), cwd: tmpDir() });
	rt1.setHost(host);
	const api1 = /** @type {any} */ (rt1.buildApi(null));
	const a = await api1.host.ping({ x: 1 });
	const b = await api1.host.ping({ x: 1 }); // same input, 2nd occurrence → runs again
	assert.deepEqual([a.n, b.n], [1, 2]);
	assert.equal(calls, 2);

	// resume: same call order replays recorded results without invoking the effect
	const rt2 = new Runtime({ checkpoints: new CheckpointStore(runDir, { resume: true }), cwd: tmpDir() });
	rt2.setHost(host);
	const api2 = /** @type {any} */ (rt2.buildApi(null));
	assert.deepEqual([(await api2.host.ping({ x: 1 })).n, (await api2.host.ping({ x: 1 })).n], [1, 2]);
	assert.equal(calls, 2); // NOT re-run
});

test("cached mutating effects restore the branch epoch before later checkpoint lookups", async () => {
	const runDir = tmpDir();
	let effects = 0;
	let agents = 0;
	const cwd = tmpDir();
	const host = fakeHost([["mutate", async () => ++effects]], ["mutate"]);
	const backend = { kind: "test", run: async (/** @type {import("./agent.mjs").AgentSpec} */ spec) => (agents++, mkResult({ content: spec.prompt, label: spec.label })) };

	const run = async (/** @type {boolean} */ resume, invalidate = false) => {
		const checkpoints = new CheckpointStore(runDir, { resume });
		if (invalidate) checkpoints.invalidate([[]]);
		const rt = new Runtime({ parentPermissionMode: "on", checkpoints, cwd, agentBackend: backend });
		rt.setHost(host);
		const api = /** @type {any} */ (rt.buildApi(null));
		await api.agent("before");
		await api.host.mutate({});
		await api.agent("after");
	};
	await run(false);
	await run(true);
	assert.equal(effects, 1);
	assert.equal(agents, 2);
	await run(true, true);
	assert.equal(effects, 2);
	assert.equal(agents, 4);
});

test("effect cache keys keep the journal-compatible tuple shape", async () => {
	const runDir = tmpDir();
	const rt = new Runtime({ checkpoints: new CheckpointStore(runDir), cwd: tmpDir() });
	rt.setHost(fakeHost([["ping", async (input) => input]]));
	await /** @type {any} */ (rt.buildApi(null)).host.ping({ b: 2, a: 1 });
	const key = JSON.parse(readFileSync(join(runDir, "journal.jsonl"), "utf8").trim()).key;
	assert.equal(key, JSON.stringify(["fx", [], 0, "fake-host-hash", "ping", "{\"a\":1,\"b\":2}", 0]));
});

test("dry-run runs read-only effects but skips mutating ones", async () => {
	let reads = 0;
	let writes = 0;
	const host = fakeHost(
		[
			["load", async () => (reads++, 42)],
			["save", async () => (writes++, "ok")],
		],
		["save"],
	);
	const rt = new Runtime({ dryRun: true, cwd: tmpDir() });
	rt.setHost(host);
	const api = /** @type {any} */ (rt.buildApi(null));
	assert.equal(await api.host.load({}), 42);
	assert.equal(await api.host.save({}), undefined); // skipped
	assert.deepEqual([reads, writes], [1, 0]);
});

test("effects receive the minimal ctx (cwd/dryRun/restricted/signal/log)", async () => {
	const dir = tmpDir();
	const host = fakeHost([["probe", async (_i, ctx) => ({ cwd: ctx.cwd, dryRun: ctx.dryRun, restricted: ctx.restricted, log: typeof ctx.log, signal: ctx.signal instanceof AbortSignal })]]);
	const rt = new Runtime({ cwd: dir });
	rt.setHost(host);
	const out = await /** @type {any} */ (rt.buildApi(null)).host.probe({});
	assert.deepEqual(out, { cwd: dir, dryRun: false, restricted: false, log: "function", signal: true });
});

test("restricted mode and missing sidecar reject host calls", () => {
	const restricted = new Runtime({ restricted: true, cwd: tmpDir() });
	restricted.setHost(fakeHost([["ping", async () => 1]]));
	assert.throws(() => /** @type {any} */ (restricted.buildApi(null)).host.ping({}), /forbidden in restricted mode/);
	const noHost = new Runtime({ cwd: tmpDir() });
	assert.throws(() => /** @type {any} */ (noHost.buildApi(null)).host.ping({}), /no host sidecar loaded/);
});

test("a non-JSON effect result is rejected (must be checkpointable)", async () => {
	const rt = new Runtime({ checkpoints: new CheckpointStore(tmpDir()), cwd: tmpDir() });
	rt.setHost(fakeHost([["bad", async () => ({ fn: () => 1, circular: undefined })]]));
	// a function value survives JSON round-trip as undefined → fine; force a real failure with a BigInt
	rt.setHost(fakeHost([["bad", async () => ({ big: 1n })]]));
	await assert.rejects(/** @type {any} */ (rt.buildApi(null)).host.bad({}), /JSON-serializable/);
});

test("drain() awaits a fire-and-forget effect (bounded + tracked)", async () => {
	let done = false;
	const rt = new Runtime({ checkpoints: new CheckpointStore(tmpDir()), cwd: tmpDir() });
	rt.setHost(fakeHost([["slow", async () => (await new Promise((r) => setTimeout(r, 20)), (done = true), 1)]]));
	/** @type {any} */ (rt.buildApi(null)).host.slow({}); // NOT awaited
	assert.equal(done, false);
	await rt.drain();
	assert.equal(done, true);
});

test("restricted mode never imports the sidecar (no top-level side effects)", async () => {
	const marker = join(tmpDir(), "loaded.marker");
	const sidecarPath = join(tmpDir(), "probe.host.mjs");
	writeFileSync(sidecarPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "1");\nexport const noop = () => 1;\n`);
	const base = { source: "export const meta = { name: \"test\", description: \"test conveyor\" };\nreturn \"ok\";", hostPath: sidecarPath, budget: 10, onLine: () => {} };
	await withFakeEnv({}, () => executeConveyor({ ...base, runId: "r-restricted", runDir: tmpDir(), restricted: true }));
	assert.equal(existsSync(marker), false, "restricted run must not import the sidecar");
	await withFakeEnv({}, () => executeConveyor({ ...base, runId: "r-normal", runDir: tmpDir() }));
	assert.equal(existsSync(marker), true, "non-restricted run imports the sidecar");
});
