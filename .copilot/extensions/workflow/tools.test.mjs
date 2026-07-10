/** @module tools.test — run_workflow / list_workflow_runs handlers via an injected fake ctx. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runWorkflow, resolveSource, buildTools, isNested, buildCommands, abortRun } from "./tools.mjs";
import { listWorkflowRuns, workflowCommand } from "./runs.mjs";
import { withFakeEnv, tmpDir, waitFor } from "./fixtures/support.mjs";

/** A fake {@link import("./tools.mjs").ToolCtx} that captures logs/sends. @param {string} cwd */
function fakeCtx(cwd) {
	const logs = /** @type {string[]} */ ([]);
	const metas = /** @type {({ ephemeral?: boolean }|undefined)[]} */ ([]);
	const sends = /** @type {string[]} */ ([]);
	return { logs, metas, sends, log: (/** @type {string} */ m, /** @type {boolean|undefined} */ ephemeral) => (logs.push(String(m)), metas.push({ ephemeral })), send: (/** @type {string} */ p) => sends.push(String(p)), getWorkspaceCwd: async () => cwd };
}

/**
 * Run a tool-handler body with temp runs/workflows dirs + the fake backend.
 * @param {(dirs: { runs: string, wf: string }) => Promise<void> | void} fn
 * @param {Record<string, string>} [extraEnv]
 */
function withTool(fn, extraEnv = {}) {
	const runs = tmpDir();
	const wf = tmpDir();
	return withFakeEnv({ CWF_RUNS_DIR: runs, CWF_WORKFLOWS_DIR: wf, ...extraEnv }, () => fn({ runs, wf }));
}

test("foreground inline run returns the workflow result", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		const out = await runWorkflow({ script: `return (await agent("hi")).content;`, background: false, budget: 1 }, ctx);
		assert.equal(typeof out, "string");
		assert.match(/** @type {string} */ (out), /workflow result/);
		assert.match(/** @type {string} */ (out), /ECHO: hi/);
		assert.ok(ctx.logs.some((l) => /┌─ workflow:/.test(l)), "default progress emits dashboard snapshots");
		assert.ok(ctx.metas.some((m) => m?.ephemeral === false), "final summary is durable");
	}));

test("abortRun returns false for an unknown run id", () => {
	assert.equal(abortRun("no-such-run"), false);
});

test("abortRun aborts a live background run and clears it once settled", () =>
	withTool(
		async ({ wf }) => {
			const ctx = fakeCtx(tmpDir());
			const path = join(wf, "h.mjs");
			writeFileSync(path, `await agent("x"); return "done";`);
			const out = await runWorkflow({ scriptPath: path, runId: "abort-me", budget: 1, timeoutSec: 30 }, ctx);
			assert.match(String(out), /started in background/);
			assert.equal(abortRun("abort-me"), true); // registered while running
			await waitFor(() => !abortRun("abort-me"), 2000);
			assert.equal(abortRun("abort-me"), false); // aborted run settled + deregistered
		},
		{ CWF_FAKE_MODE: "hang" },
	));

test("duplicate live run ids are rejected without replacing the active run", () =>
	withTool(
		async ({ wf }) => {
			const ctx = fakeCtx(tmpDir());
			const path = join(wf, "h.mjs");
			writeFileSync(path, `await agent("x"); return "done";`);
			await runWorkflow({ scriptPath: path, runId: "same-id", budget: 1, timeoutSec: 30 }, ctx);
			const duplicate = await runWorkflow({ scriptPath: path, runId: "same-id", budget: 1, timeoutSec: 30 }, ctx);
			assert.match(JSON.stringify(duplicate), /already active/);
			assert.equal(abortRun("same-id"), true);
			await waitFor(() => !abortRun("same-id"), 2000);
		},
		{ CWF_FAKE_MODE: "hang" },
	));

test("dryRun returns a plan and spends nothing", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		const out = await runWorkflow({ script: `await fanOut([1,2], (n) => agent("x"+n)); return "z";`, dryRun: true }, ctx);
		assert.match(/** @type {string} */ (out), /dry-run complete/);
		assert.match(/** @type {string} */ (out), /AIC used: 0\.0/);
	}));

test("resume of a nonexistent run id is refused", () =>
	withTool(async ({ wf }) => {
		const ctx = fakeCtx(tmpDir());
		const path = join(wf, "w.mjs");
		writeFileSync(path, "return 1;");
		const out = await runWorkflow({ scriptPath: path, background: false, budget: 1, resume: "does-not-exist" }, ctx);
		assert.match(JSON.stringify(out), /no such run to resume/);
	}));

test("validation: exactly one source, and a positive budget for non-dry", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		const both = await runWorkflow({ script: "return 1;", name: "x", background: false }, ctx);
		assert.match(JSON.stringify(both), /EXACTLY ONE/);
		const none = await runWorkflow({ background: false }, ctx);
		assert.match(JSON.stringify(none), /EXACTLY ONE/);
		const badBudget = await runWorkflow({ script: "return 1;", background: false, budget: 0 }, ctx);
		assert.match(JSON.stringify(badBudget), /budget must be a positive/);
	}));

test("saved .mjs workflow resolves and runs by name", () =>
	withTool(async ({ wf }) => {
		writeFileSync(join(wf, "greet.mjs"), `return (await agent("named")).content;`, "utf8");
		const { source, label } = resolveSource({ name: "greet" });
		assert.match(source, /agent\("named"\)/);
		assert.equal(label, "greet");
		const ctx = fakeCtx(tmpDir());
		const out = await runWorkflow({ name: "greet", background: false, budget: 1 }, ctx);
		assert.match(/** @type {string} */ (out), /ECHO: named/);
	}));

test("scriptPath must point to a .mjs workflow", () =>
	withTool(async ({ wf }) => {
		const path = join(wf, "plain.js");
		writeFileSync(path, "return 1;", "utf8");
		const ctx = fakeCtx(tmpDir());
		const out = await runWorkflow({ scriptPath: path, background: false, budget: 1 }, ctx);
		assert.match(JSON.stringify(out), /scriptPath must point to a .mjs workflow/);
	}));

test("Python workflows are rejected with conversion guidance", () =>
	withTool(async ({ wf }) => {
		const path = join(wf, "old.cwf.py");
		writeFileSync(path, "wf.agent('x')", "utf8");
		const ctx = fakeCtx(tmpDir());
		const scriptPath = await runWorkflow({ scriptPath: path, background: false, budget: 1 }, ctx);
		assert.match(JSON.stringify(scriptPath), /Convert it to .mjs/);
		writeFileSync(join(wf, "old.py"), "wf.agent('x')", "utf8");
		const named = await runWorkflow({ name: "old", background: false, budget: 1 }, ctx);
		assert.match(JSON.stringify(named), /Convert it to old.mjs/);
	}));

test("unknown saved workflow name errors clearly", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		const out = await runWorkflow({ name: "does-not-exist", background: false }, ctx);
		assert.match(JSON.stringify(out), /no saved workflow named/);
	}));

test("list_workflow_runs reads persisted artifacts newest-first", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		await runWorkflow({ script: `return (await agent("hi")).content;`, background: false, budget: 1, name: undefined }, ctx);
		const listing = listWorkflowRuns();
		assert.match(listing, /RUN ID/);
		assert.match(listing, /complete/);
	}));

test("list_workflow_runs names old harness-only run artifacts", () =>
	withTool(({ runs }) => {
		const dir = join(runs, "old-run");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "meta.json"), JSON.stringify({ harness: "/tmp/mobius_deep_audit.cwf.py", updated_at: "2026-01-01T00:00:00" }));
		writeFileSync(join(dir, "progress.jsonl"), JSON.stringify({ ev: "run_start", harness: "/tmp/mobius_deep_audit.cwf.py", meta: {} }) + "\n" + JSON.stringify({ ev: "run_end", agents: 1, launched: 1, cached: 0, skipped: 0, failed: 0, nano_aiu: 500_000_000, t: 1783308171 }) + "\n");
		const listing = listWorkflowRuns();
		assert.match(listing, /old-run/);
		assert.match(listing, /mobius_deep_aud/);
		assert.match(listing, /\s+0\.5\s+/);
	}));

test("list_workflow_runs caps output to newest runs before parsing metadata", () =>
	withTool(async ({ runs }) => {
		for (let i = 0; i < 55; i++) {
			const id = `run-${String(i).padStart(2, "0")}`;
			const dir = join(runs, id);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "meta.json"), JSON.stringify({ workflow: { name: id }, updatedAt: `2024-01-01T00:00:${String(i).padStart(2, "0")}Z` }));
		}
		const listing = listWorkflowRuns();
		assert.match(listing, /showing newest 50 of 55 runs/);
		assert.doesNotMatch(listing, /run-00/);
	}));

test("background run returns immediately and wakes the agent on completion", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		const out = await runWorkflow({ script: `return (await agent("bg")).content;`, background: true, budget: 1 }, ctx);
		assert.match(/** @type {string} */ (out), /started in background/);
		await waitFor(() => ctx.sends.length > 0, 2000, 40);
		assert.equal(ctx.sends.length, 1);
		assert.match(ctx.sends[0], /complete/);
	}));

test("background run timeout settles, persists timeout, and clears the live registry", () =>
	withTool(
		async ({ runs }) => {
			const ctx = fakeCtx(tmpDir());
			const out = await runWorkflow({
				script: `await agent("hang"); return "unreached";`,
				runId: "timer-timeout",
				background: true,
				budget: 1,
				timeoutSec: 1,
			}, ctx);
			assert.match(/** @type {string} */ (out), /started in background/);

			await waitFor(() => ctx.sends.length > 0, 3000, 30);
			assert.equal(ctx.sends.length, 1);
			assert.match(ctx.sends[0], /timer-timeout timeout/);
			assert.equal(abortRun("timer-timeout"), false);

			const resultPath = join(runs, "timer-timeout", "result.json");
			assert.equal(existsSync(resultPath), true);
			assert.equal(JSON.parse(readFileSync(resultPath, "utf8")).status, "timeout");
		},
		{ CWF_FAKE_MODE: "hang" },
	));

test("aborting one concurrent workflow does not terminate another run's agent", () =>
	withTool(
		async ({ runs }) => {
			const pidDir = tmpDir();
			const firstPid = join(pidDir, "first.pid");
			const secondPid = join(pidDir, "second.pid");
			const firstCtx = fakeCtx(tmpDir());
			const secondCtx = fakeCtx(tmpDir());
			try {
				process.env.CWF_FAKE_PID_FILE = firstPid;
				await runWorkflow({
					script: `const r = await agent("hang"); if (!r.ok) throw new Error(r.error); return r.content;`,
					runId: "isolation-first",
					background: true,
					budget: 1,
					timeoutSec: 30,
				}, firstCtx);
				await waitFor(() => existsSync(firstPid));

				process.env.CWF_FAKE_MODE = "ok";
				process.env.CWF_FAKE_DELAY_MS = "500";
				process.env.CWF_FAKE_PID_FILE = secondPid;
				await runWorkflow({
					script: `const r = await agent("healthy"); if (!r.ok) throw new Error(r.error); return r.content;`,
					runId: "isolation-second",
					background: true,
					budget: 1,
					timeoutSec: 30,
				}, secondCtx);
				await waitFor(() => existsSync(secondPid));

				assert.equal(abortRun("isolation-first"), true);
				await waitFor(() => firstCtx.sends.some((line) => /isolation-first timeout/.test(line)));
				await waitFor(() => secondCtx.sends.some((line) => /isolation-second complete/.test(line)));

				assert.equal(JSON.parse(readFileSync(join(runs, "isolation-first", "result.json"), "utf8")).status, "timeout");
				assert.equal(JSON.parse(readFileSync(join(runs, "isolation-second", "result.json"), "utf8")).status, "complete");
				assert.equal(abortRun("isolation-second"), false);
			} finally {
				abortRun("isolation-first");
				abortRun("isolation-second");
				rmSync(pidDir, { recursive: true, force: true });
			}
		},
		{ CWF_FAKE_MODE: "hang" },
	));

test("buildTools registers run_workflow + list_workflow_runs with a valid schema", () => {
	const tools = buildTools(fakeCtx("/"));
	assert.deepEqual(tools.map((t) => t.name).sort(), ["list_workflow_runs", "run_workflow"]);
	const rw = tools.find((t) => t.name === "run_workflow");
	assert.equal(rw.defer, "never");
	assert.equal(rw.parameters.type, "object");
	assert.ok(rw.parameters.properties.script && rw.parameters.properties.budget && rw.parameters.properties.dryRun && rw.parameters.properties.progress);
	assert.equal(typeof rw.handler, "function");
	const list = tools.find((t) => t.name === "list_workflow_runs");
	assert.equal(list.skipPermission, true);
});

test("recursion guard: nested subagents get no run_workflow tool", () => {
	const saved = process.env.CWF_DISABLE_WORKFLOW_TOOLS;
	process.env.CWF_DISABLE_WORKFLOW_TOOLS = "1";
	try {
		assert.equal(isNested(), true);
		assert.deepEqual(buildTools(fakeCtx("/")).map((t) => t.name), ["list_workflow_runs"]);
	} finally {
		if (saved === undefined) delete process.env.CWF_DISABLE_WORKFLOW_TOOLS;
		else process.env.CWF_DISABLE_WORKFLOW_TOOLS = saved;
	}
});

test("/workflow slash command: inspection dispatches (runs/latest/result/artifacts/unknown)", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		workflowCommand("", ctx);
		assert.match(ctx.logs.at(-1) ?? "", /no workflow runs yet/);

		const out = await runWorkflow({ script: `return (await agent("hi")).content;`, background: false, budget: 1 }, ctx);
		const runId = /** @type {string} */ (out).match(/runId: (\S+)/)?.[1];
		assert.ok(runId);

		workflowCommand("runs", ctx);
		assert.match(ctx.logs.at(-1) ?? "", /RUN ID/);

		workflowCommand("latest", ctx);
		assert.match(ctx.logs.at(-1) ?? "", /┌─ workflow:/);

		workflowCommand(runId, ctx);
		assert.match(ctx.logs.at(-1) ?? "", new RegExp(`inspect: /wf ${runId}`));

		workflowCommand(`result ${runId}`, ctx);
		assert.equal(ctx.logs.at(-1), "ECHO: hi");

		workflowCommand(`artifacts ${runId}`, ctx);
		assert.match(ctx.logs.at(-1) ?? "", /result\.json/);

		workflowCommand("no-such-run", ctx);
		assert.match(ctx.logs.at(-1) ?? "", /no run found/);
	}));

test("/workflow falls back to summary when state.json is absent", () =>
	withTool(({ runs }) => {
		const ctx = fakeCtx(tmpDir());
		const runId = "summary-only";
		const dir = join(runs, runId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "run.json"), JSON.stringify({ status: "complete", counts: { agents: 1, done: 1, cached: 0, skipped: 0, failed: 0 }, aic: 0.5 }));
		workflowCommand(runId, ctx);
		assert.match(ctx.logs.at(-1) ?? "", /workflow run summary-only/);
	}));

test("buildCommands registers 'workflow' and 'wf' commands", () => {
	const cmds = buildCommands(fakeCtx("/"));
	assert.deepEqual(cmds.map((c) => c.name), ["workflow", "wf"]);
	assert.equal(typeof cmds[0].handler, "function");
	assert.equal(typeof cmds[1].handler, "function");
	assert.match(cmds[0].description, /\/workflow/);
	assert.match(cmds[1].description, /\/wf/);
});

test("recursion guard: nested by CWF_DEPTH >= CWF_MAX_DEPTH", () => {
	const saved = { d: process.env.CWF_DEPTH, m: process.env.CWF_MAX_DEPTH, x: process.env.CWF_DISABLE_WORKFLOW_TOOLS };
	delete process.env.CWF_DISABLE_WORKFLOW_TOOLS;
	process.env.CWF_DEPTH = "1";
	process.env.CWF_MAX_DEPTH = "1";
	try {
		assert.equal(isNested(), true);
		process.env.CWF_MAX_DEPTH = "2";
		assert.equal(isNested(), false);
	} finally {
		const restore = (/** @type {string} */ k, /** @type {string|undefined} */ v) => {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		};
		restore("CWF_DEPTH", saved.d);
		restore("CWF_MAX_DEPTH", saved.m);
		restore("CWF_DISABLE_WORKFLOW_TOOLS", saved.x);
	}
});
