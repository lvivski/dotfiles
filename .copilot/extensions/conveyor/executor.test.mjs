/** @module executor.test — conveyor execution lifecycle and harness source helpers. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { executeConveyor as executeRawConveyor, extractMeta, normalizeBackend, stripExports } from "./executor.mjs";
import { CLI_BACKEND } from "./agent.mjs";
import { sessionStateDir } from "./sessions.mjs";
import { Work } from "./work.mjs";
import { mkResult, withFakeEnv, tmpDir, within } from "./fixtures/support.mjs";

/** @param {any} config */
const executeConveyor = (config) => executeRawConveyor({
	...config,
	limits: {
		...(config.concurrency != null ? { maxConcurrentAgents: config.concurrency } : {}),
		...(config.budget != null ? { maxAiCredits: config.budget } : {}),
		...(config.limits || {}),
	},
	attemptTimeoutSeconds: config.timeoutSec ?? config.attemptTimeoutSeconds,
});

/** Child session ids a run ledger recorded. @param {string} runId @param {string} runDir @returns {string[]} */
function sessionIds(runId, runDir) {
	const ids = readFileSync(join(runDir, "ledger.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line).sessionId)
		.filter((id) => typeof id === "string");
	assert.ok(ids.length, `run ${runId} recorded no child sessions`);
	return ids;
}

test("stripExports removes ESM exports while leaving plain source alone", () => {
	assert.equal(stripExports("export const meta = {}").trim(), "const meta = {}");
	assert.equal(stripExports("export async function main() {}").trim(), "async function main() {}");
	assert.equal(stripExports("export default answer").trim(), "answer");
	assert.equal(stripExports("const x = 1;").trim(), "const x = 1;");
});

test("stripExports preserves line and column positions", () => {
	// Group identities index the stripped source by the line/column V8 reports, so blanking the
	// keyword must never move any other character.
	const source = "export const a = 1;\nexport\nconst b = 2;\nexport default\nfunction c() {}\nconst d = 3;\n";
	const stripped = stripExports(source);
	assert.equal(stripped.length, source.length);
	assert.equal(stripped.split("\n").length, source.split("\n").length);
	for (const [i, line] of stripped.split("\n").entries()) {
		assert.equal(line.length, source.split("\n")[i].length, `line ${i + 1} width`);
	}
	assert.match(stripped, /^\s+const a = 1;$/m);
	assert.match(stripped, /^const b = 2;$/m);
	assert.match(stripped, /^function c\(\) \{\}$/m);
	assert.doesNotMatch(stripped, /\bexport\b/);
	assert.doesNotMatch(stripped, /\bdefault\b/);
});

test("extractMeta reads a literal meta block and ignores dynamic/non-object values", () => {
	const meta = extractMeta(`export const meta = { name: "audit", description: "scan", phases: ["plan"] }\nreturn "ok";`);
	assert.equal(meta.name, "audit");
	assert.equal(meta.description, "scan");
	assert.deepEqual([.../** @type {any[]} */ (meta.phases)], [{ id: "phase:0", ordinal: 0, title: "plan" }]);
	assert.deepEqual(extractMeta(`const meta = { name: someVar }`), {});
	assert.deepEqual(extractMeta(`const meta = null`), {});
	assert.deepEqual(extractMeta(`return "no meta";`), {});
});

test("extractMeta tolerates a harness with no meta block", () => {
	assert.deepEqual(extractMeta(`return "ok";`), {});
});

test("dry-run executes the harness plan without writing run artifacts or spending AIC", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const rec = await executeConveyor({
			source: `export const meta = { name: "preview" };\nawait pipeline([1,2,3], (n) => agent("x" + n)); return "ignored";`,
			runId: "dry",
			runDir,
			budget: 10,
			dryRun: true,
			onLine: () => {},
		});
		assert.equal(rec.status, "complete");
		assert.equal(rec.aic, 0);
		if (typeof rec.result !== "string") throw new Error("expected string dry-run result");
		assert.match(rec.result, /dry-run plan: 3 agent call\(s\) — preview/);
		assert.equal(existsSync(join(runDir, "run.json")), false);
		assert.equal(existsSync(join(runDir, "ledger.jsonl")), false);
		assert.equal(existsSync(join(runDir, ".lock")), false);
		assert.equal(existsSync(join(runDir, "heartbeat.json")), false);
	}));

test("executeConveyor closes only Work that it opens", async () => {
	const runDir = tmpDir();
	const work = Work.open({ runId: "supplied-work", runDir });
	const rec = await executeConveyor({
		source: `return "ok";`,
		runId: "supplied-work",
		runDir,
		budget: 1,
		work,
		onLine: () => {},
	});
	assert.equal(rec.status, "complete");
	assert.equal(Work.find("supplied-work"), work);
	assert.equal(existsSync(join(runDir, ".lock")), true);
	work.close();
	assert.equal(Work.find("supplied-work"), null);
	assert.equal(existsSync(join(runDir, ".lock")), false);
});

test("executeConveyor rejects a supplied Work for a different identity", async () => {
	const work = Work.open({ runId: "actual", runDir: tmpDir() });
	try {
		await assert.rejects(executeConveyor({
			source: `return "ok";`,
			runId: "different",
			runDir: tmpDir(),
			budget: 1,
			work,
			onLine: () => {},
		}), /supplied Work 'actual'.*does not match/);
		assert.equal(Work.find("actual"), work);
	} finally {
		work.close();
	}
});

test("backend ids default to cli and otherwise remain exact", () => {
	assert.equal(normalizeBackend(undefined), CLI_BACKEND);
	assert.equal(normalizeBackend("cli"), CLI_BACKEND);
	assert.equal(normalizeBackend("sdk"), "sdk");
});

test("real runs open and close one run-scoped backend; dry runs do neither", async () => {
	/** @type {any[][]} */
	const calls = [];
	let closed = false;
	const factory = {
		kindFor: () => "test-v1",
		openRun() {
			calls.push(["open"]);
			return {
				kind: "test-v1",
				run: async () => mkResult({ sessionId: null, aic: 0, nanoAiu: 0 }),
				abort: () => calls.push(["abort"]),
				close: async () => {
					if (closed) return;
					closed = true;
					calls.push(["close"]);
				},
			};
		},
	};
	const realDir = tmpDir();
	const real = await executeConveyor({
		source: `return (await agent("x")).content;`,
		runId: "backend-real",
		runDir: realDir,
		budget: 10,
		agentBackend: factory,
		onLine: () => {},
	});
	assert.equal(real.status, "complete");
	assert.deepEqual(calls, [["open"], ["close"]]);
	assert.equal(JSON.parse(readFileSync(join(realDir, "manifest.json"), "utf8")).backend, "test-v1");

	calls.length = 0;
	await executeConveyor({
		source: `await agent("x"); return "preview";`,
		runId: "backend-dry",
		runDir: tmpDir(),
		dryRun: true,
		agentBackend: factory,
		onLine: () => {},
	});
	assert.deepEqual(calls, []);
});

test("real run persists the simplified artifact set", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const rec = await executeConveyor({
			source: `export const meta = { name: "persist" };\nreturn (await agent("hi")).content;`,
			runId: "real",
			runDir,
			budget: 10,
			onLine: () => {},
		});
		assert.equal(rec.status, "complete");
		assert.equal(rec.result, "ECHO: hi");
		for (const file of ["manifest.json", "script.js", "state.json", "ledger.jsonl", "run.json"]) {
			assert.ok(existsSync(join(runDir, file)), `expected ${file}`);
		}
		const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
		assert.equal(manifest.conveyor.name, "persist");
		const result = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
		assert.equal(result.result, "ECHO: hi");
	}));

test("plain object results from the harness VM persist as strict JSON", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const rec = await executeConveyor({
			source: `return { ok: true, values: [0, false, null] };`,
			runId: "json-result",
			runDir,
			budget: 1,
			onLine: () => {},
		});
		assert.equal(rec.status, "complete");
		assert.deepEqual(rec.result, { ok: true, values: [0, false, null] });
		assert.deepEqual(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).result, rec.result);
	}));

test("a complete run leaves no agent sessions behind", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const rec = await executeConveyor({
			source: `return (await parallel([() => agent("a"), () => agent("b")])).map((r) => r.content).join("|");`,
			runId: "clean-sessions",
			runDir,
			budget: 10,
			onLine: () => {},
		});
		assert.equal(rec.status, "complete");
		assert.deepEqual(rec.preservedSessions, []);
		assert.deepEqual(sessionIds(rec.runId, runDir).filter((id) => existsSync(sessionStateDir(id))), [], "every child session directory is gone");
	}));

test("a run that did not complete preserves its agent sessions", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "fail" }, async () => {
		const runDir = tmpDir();
		const rec = await executeConveyor({
			source: `const r = await agent("a"); return r.ok ? "ok" : "";`,
			runId: "keep-sessions",
			runDir,
			budget: 10,
			onLine: () => {},
		});
		assert.notEqual(rec.status, "complete");
		assert.deepEqual(rec.preservedSessions, sessionIds(rec.runId, runDir), "a run that can still be resumed keeps every session it created");
	}));

test("manifest durably pins plan agent ceilings", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		await executeConveyor({
			source: "export const meta = { name: \"planned\", description: \"test conveyor\" };\nreturn \"ok\";",
			runId: "planned",
			runDir,
			budget: 10,
			parentPermissionMode: "auto",
			parentSessionMode: "autopilot",
			permissionMode: "parent-auto-profile-narrowed",
			maxAgents: 3,
			planId: "plan-test",
			onLine: () => {},
		});
		const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
		assert.equal(manifest.maxAgents, 3);
		assert.equal(manifest.planId, "plan-test");
		assert.equal(manifest.parentPermissionMode, "auto");
		assert.equal(manifest.parentSessionMode, "autopilot");
		assert.equal(manifest.permissionMode, "parent-auto-profile-narrowed");
	}));

test("harness failure is persisted as an error record instead of rejecting", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const rec = await executeConveyor({
			source: `throw new Error("boom");`,
			runId: "fail",
			runDir,
			budget: 10,
			onLine: () => {},
		});
		assert.equal(rec.status, "error");
		assert.match(rec.error ?? "", /boom/);
		assert.ok(existsSync(join(runDir, "script.js")));
		assert.equal(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).status, "error");
		const progress = readFileSync(join(runDir, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((record) => record.type === "progress").map((record) => record.record);
		assert.equal(progress.at(-1).ev, "run_end");
		assert.equal(progress.at(-1).status, "error");
	}));

test("run.json remains authoritative when attempt completion fails after terminal persistence", () =>
	withFakeEnv({}, async () => {
		const { Ledger } = await import("./ledger.mjs");
		const original = Ledger.prototype.finishAttempt;
		Ledger.prototype.finishAttempt = function () {
			throw new Error("finish failed");
		};
		const runDir = tmpDir();
		try {
			await assert.rejects(
				executeConveyor({
					source: `return { ok: true };`,
					runId: "terminal-first",
					runDir,
					limits: { maxAiCredits: 1 },
					onLine: () => {},
				}),
				/finish failed/,
			);
			const terminal = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
			assert.equal(terminal.status, "complete");
			assert.deepEqual(terminal.result, { ok: true });
		} finally {
			Ledger.prototype.finishAttempt = original;
		}
	}));

test("a synchronous runaway harness is bounded and persisted as an error", async () => {
	const runDir = tmpDir();
	const rec = await executeConveyor({
		source: `while (true) {}`,
		runId: "runaway",
		runDir,
		budget: 10,
		harnessSyncTimeoutMs: 25,
		onLine: () => {},
	});
	assert.equal(rec.status, "error");
	assert.match(rec.error ?? "", /Script execution timed out after 25ms/);
	assert.equal(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).status, "error");
});

test("reporter closes even when final logging throws", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		await assert.rejects(
			executeConveyor({
				source: `return (await agent("hi")).content;`,
				runId: "log-fail",
				runDir,
				budget: 10,
				onLine: (/** @type {string} */ line) => {
					if (line.startsWith("— conveyor:")) throw new Error("log failed");
				},
			}),
			/log failed/,
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")).status, "complete");
	}));

test("abort finalizes a harness that never resolves", async () => {
	const runDir = tmpDir();
	const ac = new AbortController();
	const pending = executeConveyor({
		source: `await new Promise(() => {}); return "unreached";`,
		runId: "never",
		runDir,
		budget: 10,
		signal: ac.signal,
		onLine: () => {},
	});
	setTimeout(() => ac.abort(), 50);

	const rec = await within(pending, 1500);
	assert.equal(rec.status, "timeout");
	assert.equal(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).status, "timeout");
	assert.equal(JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")).status, "timeout");
});

test("an already-aborted run consumes a later harness rejection", async () => {
	const runDir = tmpDir();
	const ac = new AbortController();
	ac.abort();
	const rec = await executeConveyor({
		source: `await Promise.resolve(); throw new Error("late harness failure");`,
		runId: "already-aborted",
		runDir,
		budget: 10,
		signal: ac.signal,
		onLine: () => {},
	});
	assert.equal(rec.status, "timeout");
	await new Promise((resolve) => setImmediate(resolve));
});

test("abort during fire-and-forget drain records timeout, not complete", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "hang" }, async () => {
		const runDir = tmpDir();
		const ac = new AbortController();
		const pending = executeConveyor({
			source: `agent("orphan", { label: "orphan" }); return "done";`,
			runId: "drain-timeout",
			runDir,
			budget: 10,
			signal: ac.signal,
			onLine: () => {},
		});

		for (let i = 0; i < 100; i++) {
			if (existsSync(join(runDir, "ledger.jsonl")) && readFileSync(join(runDir, "ledger.jsonl"), "utf8").includes('"ev":"start"')) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		ac.abort();

		const rec = await within(pending, 2000);
		assert.equal(rec.status, "timeout");
		assert.equal(rec.result, "done");
		assert.equal(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).status, "timeout");
	}));

test("a run fails when it cannot persist its manifest identity", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		mkdirSync(join(runDir, "manifest.json"), { recursive: true });
		await assert.rejects(
			executeConveyor({
				source: `export const meta = { name: "meta-fail", description: "test conveyor" };\nreturn "done";`,
				runId: "meta-fail",
				runDir,
				budget: 1,
				args: { important: "input" },
				onLine: () => {},
			}),
			/EISDIR|manifest\.json/,
			"a run that cannot persist its identity must fail loudly",
		);
		assert.ok(!existsSync(join(runDir, "run.json")), "no terminal artifact for a failed launch");
	}));

test("host snapshots replace stale target artifacts before execution", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const hostPath = join(tmpDir(), "effects.host.mjs");
		writeFileSync(hostPath, "export async function ping() { return 1; }\n");
		// A stale file at the snapshot root is removed before the complete bundle is written.
		writeFileSync(join(runDir, "host"), "blocked");
		const result = await executeConveyor({
			source: `export const meta = { name: "host-snapshot", description: "test conveyor" };\nreturn String(await host.ping());`,
			runId: "host-snapshot",
			runDir,
			hostPath,
			budget: 1,
			onLine: () => {},
		});
		assert.equal(result.status, "complete");
		assert.ok(existsSync(join(runDir, "host", "manifest.json")));
	}));

test("a bundled host uses the same complete snapshot on initial run and resume", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const hostPath = tmpDir();
		writeFileSync(join(hostPath, "index.mjs"), `import { value } from "./helper.mjs";\nexport const ping = () => value;\n`);
		writeFileSync(join(hostPath, "helper.mjs"), `export const value = "bundled";\n`);
		const source = `export const meta = { name: "bundle" };\nreturn await host.ping();`;
		const first = await executeConveyor({ source, runId: "bundle", runDir, hostPath, budget: 1, onLine: () => {} });
		assert.equal(first.result, "bundled");
		const resumed = await executeConveyor({
			source,
			runId: "bundle",
			runDir,
			hostPath: join(runDir, "host"),
			budget: 1,
			resume: true,
			onLine: () => {},
		});
		assert.equal(resumed.result, "bundled");
	}));

test("a lost lease stops a run from writing artifacts", () =>
	withFakeEnv({}, async () => {
		const { Persistence } = await import("./persistence.mjs");
		const runDir = tmpDir();
		const store = new Persistence(runDir, { runId: "lease-fail" });
		const lease = store.acquire();
		// Another process takes the lock: the original lease is fenced off.
		writeFileSync(store.ownerPath, JSON.stringify({ token: "other", generation: lease.generation + 1 }));
		assert.throws(() => store.writeJson(lease, "manifest.json", { runId: "lease-fail" }), /ownership changed/);
		assert.throws(() => store.writeFile(lease, "host.mjs", "x"), /ownership changed/);
		lease.release();
	}));
