/** @module tools.test — run_workflow / list_workflow_runs handlers via an injected fake ctx. */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { runWorkflow, listWorkflowRuns, resolveSource, ValidationError, buildTools, isNested, workflowCommand, buildCommands, abortRun } from "./tools.mjs";
import { withFakeEnv, tmpDir } from "./fixtures/support.mjs";

/** A fake {@link import("./tools.mjs").ToolCtx} that captures logs/sends. @param {string} cwd */
function fakeCtx(cwd) {
	const logs = /** @type {string[]} */ ([]);
	const sends = /** @type {string[]} */ ([]);
	return { logs, sends, log: (/** @type {string} */ m) => logs.push(String(m)), send: (/** @type {string} */ p) => sends.push(String(p)), getWorkspaceCwd: async () => cwd };
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
			for (let i = 0; i < 100 && abortRun("abort-me"); i++) await new Promise((r) => setTimeout(r, 20));
			assert.equal(abortRun("abort-me"), false); // aborted run settled + deregistered
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

test("legacy .cwf.py workflows are rejected with a clear message", () =>
	withTool(async ({ wf }) => {
		writeFileSync(join(wf, "old.cwf.py"), "wf.agent('x')", "utf8");
		assert.throws(() => resolveSource({ name: "old" }), (e) => e instanceof ValidationError && /legacy Python workflow/.test(e.message));
		assert.throws(() => resolveSource({ scriptPath: join(wf, "old.cwf.py") }), /no longer supported/);
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

test("background run returns immediately and wakes the agent on completion", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		const out = await runWorkflow({ script: `return (await agent("bg")).content;`, background: true, budget: 1 }, ctx);
		assert.match(/** @type {string} */ (out), /started in background/);
		// wait (bounded) for the completion notification to fire
		for (let i = 0; i < 50 && ctx.sends.length === 0; i++) await new Promise((r) => setTimeout(r, 40));
		assert.equal(ctx.sends.length, 1);
		assert.match(ctx.sends[0], /complete/);
	}));

test("buildTools registers run_workflow + list_workflow_runs with a valid schema", () => {
	const tools = buildTools(fakeCtx("/"));
	assert.deepEqual(tools.map((t) => t.name).sort(), ["list_workflow_runs", "run_workflow"]);
	const rw = tools.find((t) => t.name === "run_workflow");
	assert.equal(rw.defer, "never");
	assert.equal(rw.parameters.type, "object");
	assert.ok(rw.parameters.properties.script && rw.parameters.properties.budget && rw.parameters.properties.dryRun);
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
		assert.match(ctx.logs.at(-1) ?? "", /workflow run .*\n?status: complete/s);

		workflowCommand(runId, ctx);
		assert.match(ctx.logs.at(-1) ?? "", new RegExp(`workflow run ${runId}`));

		workflowCommand(`result ${runId}`, ctx);
		assert.equal(ctx.logs.at(-1), "ECHO: hi");

		workflowCommand(`artifacts ${runId}`, ctx);
		assert.match(ctx.logs.at(-1) ?? "", /result\.json/);

		workflowCommand("no-such-run", ctx);
		assert.match(ctx.logs.at(-1) ?? "", /no run found/);
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
