/** @module workflows.test — saved workflows: parse, meta, and control-flow smoke runs. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runHarness } from "./sandbox.mjs";
import { stripExports, extractMeta } from "./executor.mjs";

const WORKFLOWS = resolve(dirname(fileURLToPath(import.meta.url)), "../../workflows");
const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/workflow/examples");

/** A permissive fake AgentResult. @param {string} content */
const res = (content) => ({ content, ok: true, error: null, sessionId: "s", model: "m", cached: false, skipped: false, label: null, nanoAiu: 0, aic: 0, outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, durationMs: 0, exitCode: 0, warnings: null });

/** Build a minimal object satisfying a shape-schema's declared property types. @param {any} schema */
function fillObject(schema) {
	/** @type {Record<string, any>} */
	const o = {};
	for (const [k, sub] of Object.entries(schema.properties || {})) {
		const s = /** @type {any} */ (sub);
		o[k] = s.enum ? s.enum[0] : s.type === "integer" || s.type === "number" ? 1 : s.type === "boolean" ? false : s.type === "array" ? [] : k === "file" || k === "filePath" ? "src/x.js" : `value-${k}`;
	}
	return o;
}

/**
 * Build a permissive harness API that lets any workflow run its control flow to
 * completion (agents return benign findings; helpers return success shapes). Records call counts.
 * @param {unknown} args
 */
function smokeApi(args) {
	const calls = { agent: 0, structured: 0, verify: 0, consensus: 0, classify: 0, synthesize: 0, tournament: 0, generateAndFilter: 0, worktree: 0 };
	/** @type {any} */
	const worktree = async (/** @type {string} */ name, /** @type {any} */ a, /** @type {any} */ b) => {
		calls.worktree++;
		const cb = typeof a === "function" ? a : b;
		return cb ? await cb("/tmp/cwf-smoke-wt") : { path: "/tmp/cwf-smoke-wt", cleanup: async () => {} };
	};
	worktree.create = async () => ({ path: "/tmp/cwf-smoke-wt", cleanup: async () => {} });
	const api = {
		args,
		budget: { total: null, spent: () => 0, remaining: () => Infinity },
		memory: { enabled: false, read: () => "", write() {}, append() {}, clear() {} },
		agent: async () => (calls.agent++, res("finding at line 1")),
		followUp: async () => res("follow-up"),
		parallel: async (/** @type {(() => any)[]} */ thunks) => Promise.all(thunks.map((t) => t())),
		fanOut: async (/** @type {any[]} */ items, /** @type {(it: any, i: number) => any} */ fn) => Promise.all([...items].map((it, i) => fn(it, i))),
		pipeline: async (/** @type {any[]} */ items, /** @type {any[]} */ ...stages) => {
			if (stages.length && typeof stages[stages.length - 1] !== "function") stages.pop(); // trailing opts
			return Promise.all(
				[...items].map(async (it) => {
					let prev = it;
					for (const s of stages) prev = await s(prev, it, 0);
					return prev;
				}),
			);
		},
		loopUntil: async (/** @type {(i: number) => any} */ step, /** @type {(r: any) => boolean} */ done, /** @type {any} */ opts = {}) => {
			const h = [];
			for (let i = 0; i < (opts.maxIters ?? 10); i++) {
				const r = await step(i);
				h.push(r);
				if (done(r)) break;
			}
			return h;
		},
		quarantine: (/** @type {any} */ o = {}) => {
			const { deny, denyUrl, enableMcp, ...extra } = o;
			return { allowAllTools: true, deny: deny ?? ["shell", "write"], denyUrl: denyUrl ?? ["*"], enableMcp: enableMcp ?? false, ...extra };
		},
		phase() {},
		log() {},
		structured: async (/** @type {string} */ _p, /** @type {any} */ schema) => {
			calls.structured++;
			// Return a value that fits the requested shape (angles array, object verdict, or findings).
			let value = /** @type {any} */ (["angle one", "angle two", "angle three"]);
			if (schema?.type === "object") value = fillObject(schema);
			else if (schema?.type === "array" && schema.items?.type === "object") value = [fillObject(schema.items)];
			return { value, ok: true, error: "", raw: res("{}"), attempts: 1 };
		},
		verify: async () => (calls.verify++, { passed: true, score: 1, reasons: "ok", raw: res("v"), ok: true, error: "" }),
		consensus: async () => (calls.consensus++, { passed: true, passedCount: 1, failedCount: 0, erroredCount: 0, reviewers: 1, reasons: "ok", dissent: "", verdicts: [], ok: true, error: "" }),
		synthesize: async () => (calls.synthesize++, res("SYNTHESIZED REPORT")),
		classify: async (/** @type {any} */ _t, /** @type {string[]} */ classes) => (calls.classify++, classes[0]),
		tournament: async (/** @type {any[]} */ c) => (calls.tournament++, c[0]),
		generateAndFilter: async () => (calls.generateAndFilter++, [res("candidate")]),
		worktree,
	};
	return { api, calls };
}

/** @param {string} dir @param {string} name @param {unknown} args */
async function smoke(dir, name, args) {
	const path = join(dir, `${name}.mjs`);
	assert.ok(existsSync(path), `missing workflow ${name}.mjs`);
	const src = readFileSync(path, "utf8");
	const { api, calls } = smokeApi(args);
	const result = await runHarness(stripExports(src), { api, log: () => {} });
	return { result, calls, meta: extractMeta(src) };
}

test("audit.mjs: verifies findings and synthesizes a report", async () => {
	const { result, calls, meta } = await smoke(WORKFLOWS, "audit", ["a.js", "b.js"]);
	assert.equal(meta.name, "audit");
	assert.equal(result, "SYNTHESIZED REPORT");
	assert.ok(calls.agent >= 2);
	assert.ok(calls.verify >= 1);
	assert.equal(calls.synthesize, 1);
	const empty = await smoke(WORKFLOWS, "audit", []);
	assert.match(/** @type {string} */ (empty.result), /provide files/);
});

test("triage.mjs: classifies then synthesizes", async () => {
	const { result, calls, meta } = await smoke(WORKFLOWS, "triage", ["t1", "t2"]);
	assert.equal(meta.name, "triage");
	assert.equal(result, "SYNTHESIZED REPORT");
	assert.ok(calls.classify >= 2);
	assert.equal(calls.synthesize, 1);
});

test("deep-research.mjs: plans angles, verifies, synthesizes (and default question)", async () => {
	const { result, calls, meta } = await smoke(WORKFLOWS, "deep-research", "What is X?");
	assert.equal(meta.name, "deep-research");
	assert.equal(result, "SYNTHESIZED REPORT");
	assert.equal(calls.structured, 1);
	assert.ok(calls.verify >= 1);
	const dflt = await smoke(WORKFLOWS, "deep-research", null);
	assert.equal(dflt.result, "SYNTHESIZED REPORT");
});

test("review-queue.mjs: diff-only and deep-checkout PRs render a triage table", async () => {
	const prs = [
		{ repo: "o/r", number: 1, title: "diff only", files: ["a.js"], diff: "x", me: "user", my_teams: [], reviewers: [{ required: false }], codeowners: "", coverage: "full diff", platform: "github", url: "http://x/1", updatedAt: "2024-01-01" },
		{ repo: "o/r", number: 2, title: "needs deep", files: ["src/b.js"], diff: "y", me: "user", my_teams: ["team"], reviewers: [{ required: true }], codeowners: "src/* @team", coverage: "partial", clone_url: "https://github.com/o/r.git", pr_ref: "pull/2/head", platform: "github", url: "http://x/2", updatedAt: "2024-02-02" },
	];
	const { result, calls, meta } = await smoke(WORKFLOWS, "review-queue", prs);
	assert.equal(meta.name, "review-queue");
	assert.match(/** @type {string} */ (result), /\| Decision \| Risk \|/);
	assert.match(/** @type {string} */ (result), /o\/r#1/);
	assert.match(/** @type {string} */ (result), /o\/r#2/);
	assert.match(/** @type {string} */ (result), /Reviewed 2 PR\(s\)/);
	assert.ok(calls.structured >= 2, "a decide() per PR");
	assert.ok(calls.worktree >= 1, "deep checkout for the partial-coverage PR");
	// CODEOWNERS attribution: PR #2 matches `src/* @team` and I'm on @team -> codeowner
	assert.match(/** @type {string} */ (result), /CODEOWNERS/);

	const empty = await smoke(WORKFLOWS, "review-queue", []);
	assert.match(/** @type {string} */ (empty.result), /no PRs supplied/);
});

test("security-review.mjs: scans, investigates, verifies, and renders a report", async () => {
	const { result, calls, meta } = await smoke(WORKFLOWS, "security-review", { root: "src/" });
	assert.equal(meta.name, "security-review");
	assert.match(/** @type {string} */ (result), /# Security review/);
	assert.match(/** @type {string} */ (result), /Verified findings:/);
	assert.match(/** @type {string} */ (result), /\| Severity \| Confidence \|/);
	assert.ok(calls.structured >= 2, "scan + at least one investigate");
	assert.ok(calls.verify >= 1, "adversarial verification ran");
	assert.equal(calls.synthesize, 1, "executive summary synthesized");
});

const EXAMPLE_NAMES = ["minimal-review", "pipeline-review", "fanout-synthesize", "classify-route", "tournament", "generate-filter", "loop-until-dry", "loop-memory", "deep-research"];

test("skill examples: each converts, parses (meta), and runs to a non-empty result", async () => {
	for (const name of EXAMPLE_NAMES) {
		const { result, meta } = await smoke(EXAMPLES, name, null);
		assert.equal(meta.name, name, `${name} meta.name`);
		assert.ok(typeof result === "string" && result.length > 0, `${name} produced no result`);
	}
});

test("repo workflow/example harnesses use .mjs names", () => {
	for (const name of ["audit", "triage", "deep-research", "review-queue", "security-review"]) {
		assert.ok(existsSync(join(WORKFLOWS, `${name}.mjs`)), `${name}.mjs exists`);
	}
	for (const name of EXAMPLE_NAMES) {
		assert.ok(existsSync(join(EXAMPLES, `${name}.mjs`)), `${name}.mjs exists`);
	}
});
