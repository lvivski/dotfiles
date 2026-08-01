/** @module executor.test — workflow execution lifecycle and harness source helpers. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { executeWorkflow as executeRawWorkflow, extractMeta, normalizeBackend, stripExports } from "./executor.mjs";
import { CLI_BACKEND } from "./agent.mjs";
import { sessionStateDir } from "./sessions.mjs";
import { mkResult, withFakeEnv, tmpDir, within } from "./fixtures/support.mjs";

/** @param {any} config */
const executeWorkflow = (config) => executeRawWorkflow(config);

/** Child session ids a run journaled. @param {string} runId @param {string} runDir @returns {string[]} */
function sessionIds(runId, runDir) {
	const ids = readFileSync(join(runDir, "journal.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line).sessionId)
		.filter((id) => typeof id === "string");
	assert.ok(ids.length, `run ${runId} journaled no child sessions`);
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
	assert.deepEqual([.../** @type {any[]} */ (meta.phases)], ["plan"]);
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
		const rec = await executeWorkflow({
			source: `export const meta = { name: "preview" };\nawait pipeline([1,2,3], (n) => agent("x" + n)); return "ignored";`,
			runId: "dry",
			runDir,
			budget: 10,
			dryRun: true,
			onLine: () => {},
		});
		assert.equal(rec.status, "complete");
		assert.equal(rec.aic, 0);
		assert.match(rec.result, /dry-run plan: 3 agent call\(s\) — preview/);
		assert.equal(existsSync(join(runDir, "run.json")), false);
		assert.equal(existsSync(join(runDir, "journal.jsonl")), false);
	}));

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
	const real = await executeWorkflow({
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
	await executeWorkflow({
		source: `await agent("x"); return "preview";`,
		runId: "backend-dry",
		runDir: tmpDir(),
		dryRun: true,
		agentBackend: factory,
		onLine: () => {},
	});
	assert.deepEqual(calls, []);
});

test("real run persists execution artifacts and a lean result file", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const rec = await executeWorkflow({
			source: `export const meta = { name: "persist" };\nreturn (await agent("hi")).content;`,
			runId: "real",
			runDir,
			budget: 10,
			onLine: () => {},
		});
		assert.equal(rec.status, "complete");
		assert.equal(rec.result, "ECHO: hi");
		for (const file of ["script.js", "meta.json", "state.json", "progress.jsonl", "journal.jsonl", "run.json", "result.json"]) {
			assert.ok(existsSync(join(runDir, file)), `expected ${file}`);
		}
		const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
		assert.equal(meta.workflow.name, "persist");
		const result = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
		assert.deepEqual(Object.keys(result).sort(), ["aic", "result", "runId", "status"]);
		assert.equal(result.result, "ECHO: hi");
	}));

test("a complete run leaves no agent sessions behind", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const rec = await executeWorkflow({
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
	withFakeEnv({ CWF_FAKE_MODE: "fail" }, async () => {
		const runDir = tmpDir();
		const rec = await executeWorkflow({
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
		await executeWorkflow({
			source: "export const meta = { name: \"planned\", description: \"test workflow\" };\nreturn \"ok\";",
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
		const rec = await executeWorkflow({
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
		assert.equal(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")).status, "error");
		const progress = readFileSync(join(runDir, "progress.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(progress.at(-1).ev, "run_end");
		assert.equal(progress.at(-1).status, "error");
	}));

test("a synchronous runaway harness is bounded and persisted as an error", async () => {
	const runDir = tmpDir();
	const rec = await executeWorkflow({
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
	assert.equal(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")).status, "error");
});

test("reporter closes even when final logging throws", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		await assert.rejects(
			executeWorkflow({
				source: `return (await agent("hi")).content;`,
				runId: "log-fail",
				runDir,
				budget: 10,
				onLine: (/** @type {string} */ line) => {
					if (line.startsWith("— workflow:")) throw new Error("log failed");
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
	const pending = executeWorkflow({
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
	const rec = await executeWorkflow({
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
	withFakeEnv({ CWF_FAKE_MODE: "hang" }, async () => {
		const runDir = tmpDir();
		const ac = new AbortController();
		const pending = executeWorkflow({
			source: `agent("orphan", { label: "orphan" }); return "done";`,
			runId: "drain-timeout",
			runDir,
			budget: 10,
			signal: ac.signal,
			onLine: () => {},
		});

		for (let i = 0; i < 100; i++) {
			if (existsSync(join(runDir, "progress.jsonl")) && readFileSync(join(runDir, "progress.jsonl"), "utf8").includes('"ev":"start"')) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		ac.abort();

		const rec = await within(pending, 2000);
		assert.equal(rec.status, "timeout");
		assert.equal(rec.result, "done");
		assert.equal(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")).status, "timeout");
	}));

// A resumed run reads its args from meta.json and its sidecar from host.mjs. If either write fails
// the run must fail loudly: completing would leave a run that reports success but resumes with the
// wrong input, or with no host effects at all.
test("a run fails when it cannot persist the args a resume replays", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		// Make meta.json unwritable by occupying the path with a directory.
		mkdirSync(join(runDir, "meta.json"), { recursive: true });
		await assert.rejects(
			executeWorkflow({
				source: `export const meta = { name: "meta-fail", description: "test workflow" };\nreturn "done";`,
				runId: "meta-fail",
				runDir,
				budget: 1,
				args: { important: "input" },
				onLine: () => {},
			}),
			/EISDIR|meta\.json/,
			"a run that cannot persist its args must fail loudly, not report success",
		);
		assert.ok(!existsSync(join(runDir, "result.json")), "no result artifact for a failed launch");
	}));

test("a run fails when it cannot persist the sidecar a resume loads", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const hostPath = join(tmpDir(), "effects.host.mjs");
		writeFileSync(hostPath, "export async function ping() { return 1; }\n");
		// Make host.mjs unwritable by occupying the path with a directory.
		mkdirSync(join(runDir, "host.mjs"), { recursive: true });
		await assert.rejects(
			executeWorkflow({
				source: `export const meta = { name: "host-fail", description: "test workflow" };\nreturn String(await host.ping());`,
				runId: "host-fail",
				runDir,
				hostPath,
				budget: 1,
				onLine: () => {},
			}),
			/EISDIR|host\.mjs/,
			"a run that cannot persist its sidecar must fail loudly, not report success",
		);
		assert.ok(!existsSync(join(runDir, "result.json")), "no result artifact for a failed launch");
	}));

test("a lost lease stops a run from writing artifacts", () =>
	withFakeEnv({}, async () => {
		const { Persistence } = await import("./persistence.mjs");
		const runDir = tmpDir();
		const store = new Persistence(runDir, { runId: "lease-fail" });
		const lease = store.acquire();
		// Another process takes the lock: the original lease is fenced off.
		writeFileSync(store.ownerPath, JSON.stringify({ token: "other", generation: lease.generation + 1 }));
		assert.throws(() => store.writeJson(lease, "meta.json", { runId: "lease-fail" }), /ownership changed/);
		assert.throws(() => store.writeFile(lease, "host.mjs", "x"), /ownership changed/);
		lease.release();
	}));
