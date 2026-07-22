/** @module workflows.test — saved workflows: parse, meta, and control-flow smoke runs. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runHarness } from "./sandbox.mjs";
import { stripExports, extractMeta } from "./executor.mjs";
import { tmpDir } from "./fixtures/support.mjs";

const WORKFLOWS = resolve(dirname(fileURLToPath(import.meta.url)), "../../workflows");
const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/workflow/examples");
const SECURITY_HOST = "../../workflows/security-review.host.mjs";
const REVIEW_QUEUE_HOST = "../../workflows/review-queue.host.mjs";
const textDiff = (file = "a.js") => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`;

/**
 * @typedef {object} SmokeBehavior
 * @property {boolean} [dryRun]
 * @property {unknown} [worktreeError]
 * @property {(prompt: string, options: any, index: number) => any} [agent]
 * @property {(prompt: string, schema: any, options: any, index: number) => any} [structured]
 * @property {(subject: any, rubric: any, options: any, index: number) => any} [verify]
 * @property {(inputs: any[], options: any, index: number) => any} [synthesize]
 * @property {{
 *   inspectCheckout?: (input: any, options: any) => any,
 *   discover?: (input: any, options: any) => any,
 *   validateFindings?: (input: any, options: any) => any,
 * }} [host]
 */

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
 * @param {SmokeBehavior} [behavior]
 */
function smokeApi(args, behavior = {}) {
	const calls = {
		agent: 0,
		structured: 0,
		verify: 0,
		consensus: 0,
		classify: 0,
		synthesize: 0,
		tournament: 0,
		generateAndFilter: 0,
		worktree: 0,
		hostDiscover: 0,
		hostValidate: 0,
		hostInspectCheckout: 0,
		agentArgs: /** @type {any[]} */ ([]),
		structuredArgs: /** @type {any[]} */ ([]),
		verifyArgs: /** @type {any[]} */ ([]),
	};
	/** @type {any} */
	const worktree = async (/** @type {string} */ name, /** @type {any} */ a, /** @type {any} */ b) => {
		calls.worktree++;
		if (behavior.worktreeError) throw new Error(String(behavior.worktreeError));
		const cb = typeof a === "function" ? a : b;
		return cb ? await cb("/tmp/cwf-smoke-wt") : { path: "/tmp/cwf-smoke-wt", cleanup: async () => {} };
	};
	worktree.create = async () => ({ path: "/tmp/cwf-smoke-wt", cleanup: async () => {} });
	const api = {
		args,
		dryRun: Boolean(behavior.dryRun),
		budget: { total: null, spent: () => 0, remaining: () => Infinity },
		memory: { enabled: false, read: () => "", write() {}, append() {}, clear() {} },
		host: {
			inspectCheckout: async (/** @type {any} */ input, /** @type {any} */ options) => {
				calls.hostInspectCheckout++;
				if (behavior.host?.inspectCheckout) return behavior.host.inspectCheckout(input, options);
				return { present: [...(input.files || [])], missing: [], uninspectable: [] };
			},
			discover: async (/** @type {any} */ input, /** @type {any} */ options) => {
				calls.hostDiscover++;
				if (behavior.host?.discover) return behavior.host.discover(input, options);
				return {
					root: "/tmp/cwf-smoke",
					source: "test scope",
					direct: true,
					selectedCount: 1,
					preCapRecords: 1,
					records: [{ filePath: "src/x.js", fileHash: "hash", candidates: [{ vulnClass: "test", line: 1, snippet: "x", matchedPattern: "test", noiseTier: "normal" }], reviewMode: "candidate-anchored" }],
					candidateCount: 1,
					preCapCandidateCount: 1,
					unreadable: 0,
					boundaries: [],
				};
			},
			validateFindings: async (/** @type {any} */ input, /** @type {any} */ options) => {
				calls.hostValidate++;
				if (behavior.host?.validateFindings) return behavior.host.validateFindings(input, options);
				return { valid: input.findings.map((/** @type {any} */ finding) => ({ ...finding, evidence: "1: x", fileHash: "hash" })), rejected: [] };
			},
		},
		agent: async (/** @type {string} */ prompt, /** @type {any} */ opts = {}) => {
			const index = calls.agent++;
			calls.agentArgs.push({ prompt, opts });
			return behavior.agent ? behavior.agent(prompt, opts, index) : res("finding at line 1");
		},
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
		structured: async (/** @type {string} */ prompt, /** @type {any} */ schema, /** @type {any} */ options = {}) => {
			const index = calls.structured++;
			calls.structuredArgs.push({ prompt, schema, options });
			if (behavior.structured) return behavior.structured(prompt, schema, options, index);
			// Return a value that fits the requested shape (angles array, object verdict, or findings).
			let value = /** @type {any} */ (["angle one", "angle two", "angle three"]);
			if (schema?.type === "object") value = fillObject(schema);
			else if (schema?.type === "array" && schema.items?.type === "object") value = [fillObject(schema.items)];
			return { value, ok: true, error: "", raw: res("{}"), attempts: 1 };
		},
		verify: async (/** @type {any} */ subject, /** @type {any} */ rubric, /** @type {any} */ options = {}) => {
			const index = calls.verify++;
			calls.verifyArgs.push({ subject, rubric, options });
			return behavior.verify ? behavior.verify(subject, rubric, options, index) : { passed: true, score: 1, reasons: "ok", raw: res("v"), ok: true, error: "" };
		},
		consensus: async () => (calls.consensus++, { passed: true, passedCount: 1, failedCount: 0, erroredCount: 0, reviewers: 1, reasons: "ok", dissent: "", verdicts: [], ok: true, error: "" }),
		synthesize: async (/** @type {any[]} */ inputs, /** @type {any} */ options = {}) => {
			const index = calls.synthesize++;
			return behavior.synthesize ? behavior.synthesize(inputs, options, index) : res("SYNTHESIZED REPORT");
		},
		classify: async (/** @type {any} */ _t, /** @type {string[]} */ classes) => (calls.classify++, classes[0]),
		tournament: async (/** @type {any[]} */ c) => (calls.tournament++, c[0]),
		generateAndFilter: async () => (calls.generateAndFilter++, [res("candidate")]),
		worktree,
	};
	return { api, calls };
}

/** @param {string} dir @param {string} name @param {unknown} args @param {SmokeBehavior} [behavior] */
async function smoke(dir, name, args, behavior = {}) {
	const path = join(dir, `${name}.mjs`);
	assert.ok(existsSync(path), `missing workflow ${name}.mjs`);
	const src = readFileSync(path, "utf8");
	const { api, calls } = smokeApi(args, behavior);
	const result = await runHarness(stripExports(src), { api, log: () => {} });
	return { result, calls, meta: extractMeta(src) };
}

test("audit.mjs: verifies findings and synthesizes a report", async () => {
	const { result, calls, meta } = await smoke(WORKFLOWS, "audit", ["a.js", "b.js"]);
	assert.equal(meta.name, "audit");
	assert.match(/** @type {string} */ (result), /^SYNTHESIZED REPORT/);
	assert.match(/** @type {string} */ (result), /Coverage: 2\/2 files processed/);
	assert.ok(calls.agent >= 2);
	assert.ok(calls.verify >= 1);
	assert.equal(calls.synthesize, 1);
	await assert.rejects(smoke(WORKFLOWS, "audit", []), /provide files/);
});

test("audit.mjs: file/verifier failures stay explicit and verification can read original evidence", async () => {
	const run = await smoke(WORKFLOWS, "audit", ["a.js", "b.js"], {
		agent: (_prompt, _options, index) => (index === 0 ? { ...res(""), ok: false, error: "review unavailable" } : res("issue at line 1")),
	});
	assert.match(String(run.result), /1 failed/);
	assert.match(String(run.result), /Coverage: 2\/2 files processed/);
	assert.equal(run.calls.verify, 1, "healthy sibling still verifies");
	assert.equal(run.calls.verifyArgs[0].options.allowAllTools, true);
	assert.deepEqual(run.calls.verifyArgs[0].options.deny, ["shell", "write"]);
	assert.equal(run.calls.structuredArgs.length, 0);
});

test("triage.mjs: emits structured priority/confidence/action rows", async () => {
	const { result, calls, meta } = await smoke(WORKFLOWS, "triage", ["t1", "t2"]);
	assert.equal(meta.name, "triage");
	assert.match(/** @type {string} */ (result), /\| ID \| Status \| Category \| Priority \| Confidence \|/);
	assert.match(/** @type {string} */ (result), /2\/2 ticket\(s\) processed/);
	assert.equal(calls.structured, 2);
	assert.equal(calls.synthesize, 0);
	await assert.rejects(smoke(WORKFLOWS, "triage", []), /non-empty array/);
});

test("triage.mjs: one malformed classification does not abort healthy siblings", async () => {
	const run = await smoke(WORKFLOWS, "triage", ["bad", "good"], {
		structured: (_prompt, schema, _options, index) =>
			index === 0
				? { value: null, ok: false, error: "classifier malformed", raw: res("bad"), attempts: 3 }
				: { value: fillObject(schema), ok: true, error: "", raw: res("{}"), attempts: 1 },
	});
	assert.match(String(run.result), /\| 1 \| Failed \|/);
	assert.match(String(run.result), /\| 2 \| Triaged \|/);
	assert.match(String(run.result), /1 triaged, 1 failed/);
});

test("deep-research.mjs: plans angles, verifies, and synthesizes only verified research", async () => {
	const { result, calls, meta } = await smoke(WORKFLOWS, "deep-research", "What is X?");
	assert.equal(meta.name, "deep-research");
	assert.match(/** @type {string} */ (result), /^SYNTHESIZED REPORT/);
	assert.match(/** @type {string} */ (result), /Coverage: 3 angle\(s\) researched/);
	assert.equal(calls.structured, 1);
	assert.ok(calls.verify >= 1);
	await assert.rejects(smoke(WORKFLOWS, "deep-research", null), /non-empty question/);
});

test("deep-research.mjs: planner is no-tools, source checks can browse, and rejected research is never synthesized", async () => {
	const run = await smoke(WORKFLOWS, "deep-research", { question: "What is X?", angles: 2 }, {
		verify: () => ({ passed: false, score: 0, reasons: "unsupported", raw: res("v"), ok: true, error: "" }),
	});
	assert.match(String(run.result), /# Research unsupported/);
	assert.equal(run.calls.synthesize, 0);
	assert.equal(run.calls.structuredArgs[0].options.allowAllTools, false);
	assert.ok(run.calls.agentArgs.every(({ opts }) => opts.enableMcp === true));
	assert.ok(run.calls.verifyArgs.every(({ options }) => options.enableMcp === true));
	assert.ok(run.calls.verifyArgs.every(({ options }) => options.deny.includes("shell") && options.deny.includes("write")));
});

test("deep-research.mjs: dry-run estimates requested research and verification arity", async () => {
	const run = await smoke(WORKFLOWS, "deep-research", { question: "What is X?", angles: 5 }, { dryRun: true });
	assert.equal(run.calls.structured, 1);
	assert.equal(run.calls.agent, 5);
	assert.equal(run.calls.verify, 5);
	assert.equal(run.calls.synthesize, 1);
});

test("deep-research: every worker and verifier retains context without duplicating it in the rubric", async () => {
	const url = "https://www.ebay.com/itm/397770308844";
	const question = `Review ${url} and determine whether it is a good deal.`;
	const angles = ["Compare recent sold prices.", "Check condition and missing parts."];
	assert.ok(angles.every((angle) => !angle.includes(url)), "test angles must not carry the original URL");

	const structured = () => ({ value: angles, ok: true, error: "", raw: res("{}"), attempts: 1 });
	for (const [dir, input] of [
		[WORKFLOWS, { question, angles: angles.length }],
		[EXAMPLES, question],
	]) {
		const run = await smoke(dir, "deep-research", input, { structured });
		assert.equal(run.calls.agentArgs.length, angles.length);
		assert.equal(run.calls.verifyArgs.length, angles.length);

		run.calls.agentArgs.forEach(({ prompt }, index) => {
			assert.ok(prompt.includes(question), "research worker lost the original question");
			assert.ok(prompt.includes(`Assigned angle:\n${angles[index]}`), "research worker lost its assigned angle");
		});
		run.calls.verifyArgs.forEach(({ subject, rubric }, index) => {
			assert.ok(String(subject).includes(question), "verifier lost the original question");
			assert.ok(String(subject).includes(`Assigned angle:\n${angles[index]}`), "verifier lost its assigned angle");
			assert.ok(!String(rubric).includes(question), "verifier rubric duplicates the original question");
		});
	}
});

test("review-queue.mjs: diff-only and deep-checkout PRs render a triage table", async () => {
	const prs = [
		{ repo: "o/r", number: 1, title: "diff only", files: ["a.js"], diff: textDiff("a.js"), me: "user", my_teams: [], reviewers: [{ required: false }], codeowners: "", coverage: "full diff", platform: "github", url: "http://x/1", updatedAt: "2024-01-01" },
		{ repo: "o/r", number: 2, title: "needs deep", files: ["src/b.js"], diff: "y", me: "user", my_teams: ["team"], reviewers: [{ required: true }], codeowners: "src/* @team", coverage: "partial", clone_url: "https://github.com/o/r.git", pr_ref: "pull/2/head", platform: "github", url: "http://x/2", updatedAt: "2024-02-02" },
	];
	const { result, calls, meta } = await smoke(WORKFLOWS, "review-queue", prs);
	assert.equal(meta.name, "review-queue");
	assert.match(/** @type {string} */ (result), /\| Decision \| Risk \|/);
	assert.match(/** @type {string} */ (result), /o\/r#1/);
	assert.match(/** @type {string} */ (result), /o\/r#2/);
	assert.match(/** @type {string} */ (result), /Reviewed 2\/2 PR\(s\)/);
	assert.ok(calls.structured >= 2, "at least one bounded review per PR");
	assert.ok(calls.verify >= 2, "independent approval verification per clean evidence chunk");
	assert.ok(calls.worktree >= 1, "deep checkout for the partial-coverage PR");
	// CODEOWNERS attribution: PR #2 matches `src/* @team` and I'm on @team -> codeowner
	assert.match(/** @type {string} */ (result), /CODEOWNERS/);

	const empty = await smoke(WORKFLOWS, "review-queue", []);
	assert.match(/** @type {string} */ (empty.result), /no PRs supplied/);
});

test("review-queue.mjs: diff agents are no-tools while checkout agents are read-only", async () => {
	const prs = [
		{ repo: "o/r", number: 1, files: ["a.js"], diff: textDiff("a.js"), me: "me", coverage: "full diff", platform: "github", reviewers: [], my_teams: [] },
		{
			repo: "o/r",
			number: 2,
			files: ["b.js"],
			diff: "x",
			me: "me",
			coverage: "partial",
			platform: "github",
			reviewers: [],
			my_teams: [],
			clone_url: "https://github.com/o/r.git",
			pr_ref: "pull/2/head",
		},
	];
	const { calls } = await smoke(WORKFLOWS, "review-queue", prs);
	const diff = calls.structuredArgs.find(({ options }) => !options.cwd);
	const checkout = calls.structuredArgs.find(({ options }) => options.cwd);
	assert.equal(diff.options.allowAllTools, false);
	assert.equal(checkout.options.allowAllTools, true);
	assert.deepEqual(checkout.options.deny, ["shell", "write"]);
	assert.ok(calls.verifyArgs.some(({ options }) => options.allowAllTools === false));
	assert.ok(calls.verifyArgs.some(({ options }) => options.cwd && options.deny.includes("write")));
});

test("review-queue.mjs: CODEOWNERS uses documented per-file GitHub semantics", async () => {
	/** @param {number} number @param {string[]} files @param {string} codeowners @param {Record<string, any>} [over] */
	const base = (number, files, codeowners, over = {}) => ({
		repo: "o/r",
		number,
		title: `pr-${number}`,
		files,
		diff: textDiff(files[0] || "a.js"),
		me: "me",
		my_teams: [],
		reviewers: [],
		codeowners,
		coverage: "full diff",
		platform: "github",
		...over,
	});
	const prs = [
		base(1, ["docs/a.md"], "/docs/ @me"),
		base(2, ["nested/docs/a.md"], "/docs/ @me"),
		base(3, ["src/a.js"], "*.js @me"),
		base(4, ["docs/a.md"], "docs/* @me"),
		base(5, ["docs/build/a.md"], "docs/* @me"),
		base(6, ["src/vendor/lib/a.js"], "**/vendor/** @me"),
		base(7, ["src/a.js", "README.md"], "* @me\nsrc/* @other"),
		base(8, ["secret/a.js"], "!secret/** @me"),
		base(9, ["docs/a.md"], "/docs/ @me", { platform: "azure" }),
		base(10, ["a.js"], "", { reviewers: [{ name: "me", required: true }] }),
		base(11, ["a.js"], "", { reviewers: [{ name: "other", required: true }] }),
	];
	const { result } = await smoke(WORKFLOWS, "review-queue", { prs, auto_deep: false });
	const lines = String(result).split("\n");
	/** @param {number} number */
	const why = (number) => lines.find((line) => line.includes(`o/r#${number}`)) || "";
	for (const number of [1, 3, 4, 6, 7]) assert.match(why(number), /\| CODEOWNERS \|/, `PR ${number}`);
	for (const number of [2, 5, 8, 9, 11]) assert.match(why(number), /\| Manual \|/, `PR ${number}`);
	assert.match(why(10), /\| Required policy \|/);
});

test("review-queue.mjs: chunk caps are explicit and block approval", async () => {
	/** @param {string} file @param {string} char */
	const section = (file, char) => {
		const changes = Array.from({ length: 240 }, (_, index) => `-${char}-old-${index}\n+${char}-new-${index}\n`).join("");
		return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,240 +1,240 @@\n${changes}`;
	};
	const pr = {
		repo: "o/r",
		number: 20,
		title: "large",
		files: ["a.js", "b.js"],
		diff: section("a.js", "a") + section("b.js", "b"),
		me: "me",
		my_teams: [],
		reviewers: [],
		codeowners: "",
		coverage: "full diff",
		platform: "github",
	};
	const capped = await smoke(WORKFLOWS, "review-queue", { prs: [pr], auto_deep: false, diff_chunk_chars: 4000, max_chunks: 1 });
	assert.equal(capped.calls.structured, 1);
	assert.equal(capped.calls.verify, 0);
	assert.match(String(capped.result), /Needs review/);
	assert.match(String(capped.result), /Coverage capped at 1\/\d+ chunks/);

	const complete = await smoke(WORKFLOWS, "review-queue", { prs: [pr], auto_deep: false, diff_chunk_chars: 4000, max_chunks: 20 });
	assert.ok(complete.calls.structured > 2);
	assert.equal(complete.calls.verify, complete.calls.structured);
	assert.match(String(complete.result), /\| Approve \|/);
	for (const { prompt } of complete.calls.structuredArgs) {
		assert.match(prompt, /Changed file\(s\): [ab]\.js/);
		assert.match(prompt, /@@ -1,240 \+1,240 @@/);
	}
	for (const { subject } of complete.calls.verifyArgs) {
		assert.match(subject, /Changed file\(s\): [ab]\.js/);
		assert.match(subject, /@@ -1,240 \+1,240 @@/);
	}
});

test("review-queue.mjs: a PR larger than the old 40-chunk limit is fully reviewed", async () => {
	const files = Array.from({ length: 50 }, (_, index) => `src/file-${index}.js`);
	const pr = {
		repo: "o/r",
		number: 23,
		title: "large but reviewable",
		files,
		diff: files.map((file) => textDiff(file)).join(""),
		me: "me",
		my_teams: [],
		reviewers: [],
		coverage: "full diff",
		platform: "github",
	};
	const run = await smoke(WORKFLOWS, "review-queue", { prs: [pr], auto_deep: false });
	assert.equal(run.calls.structured, 50);
	assert.equal(run.calls.verify, 50);
	assert.ok(run.calls.structuredArgs.every(({ options }) => options.retries === 0));
	assert.match(String(run.result), /\| Approve \|/);
	assert.doesNotMatch(String(run.result), /Coverage capped/);
});

test("review-queue.mjs: an unsplittable diff line is explicit and blocks approval", async () => {
	const pr = {
		repo: "o/r",
		number: 21,
		files: ["a.js"],
		diff: `diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+${"x".repeat(5000)}\n`,
		me: "me",
		my_teams: [],
		reviewers: [],
		coverage: "full diff",
		platform: "github",
	};
	const run = await smoke(WORKFLOWS, "review-queue", { prs: [pr], auto_deep: false, diff_chunk_chars: 4000 });
	assert.doesNotMatch(String(run.result), /\| Approve \|/);
	assert.match(String(run.result), /diff line too large/);
});

test("review-queue.mjs: binary or metadata-only diffs cannot approve", async () => {
	const pr = {
		repo: "o/r",
		number: 22,
		files: ["image.png"],
		diff: "diff --git a/image.png b/image.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/image.png differ\n",
		me: "me",
		my_teams: [],
		reviewers: [],
		coverage: "full diff",
		platform: "github",
	};
	const run = await smoke(WORKFLOWS, "review-queue", { prs: [pr], auto_deep: false });
	assert.doesNotMatch(String(run.result), /\| Approve \|/);
	assert.equal(run.calls.verify, 0);
	assert.match(String(run.result), /has no textual diff hunk/);
});

test("review-queue.mjs: review or verifier failures fail closed without aborting siblings", async () => {
	const prs = [1, 2].map((number) => ({
		repo: "o/r",
		number,
		title: `pr-${number}`,
		files: [`${number}.js`],
		diff: textDiff(`${number}.js`),
		me: "me",
		my_teams: [],
		reviewers: [],
		codeowners: "",
		coverage: "full diff",
		platform: "github",
	}));
	const malformed = await smoke(WORKFLOWS, "review-queue", { prs, auto_deep: false }, {
		structured: (_prompt, schema, _options, index) => {
			if (index === 0) return { value: null, ok: false, error: "malformed review", raw: res("bad"), attempts: 3 };
			return { value: fillObject(schema), ok: true, error: "", raw: res("{}"), attempts: 1 };
		},
	});
	assert.match(String(malformed.result), /o\/r#1/);
	assert.match(String(malformed.result), /o\/r#2/);
	assert.match(String(malformed.result), /malformed review/);
	assert.equal(malformed.calls.verify, 1, "only the clean sibling reaches approval verification");

	const rejected = await smoke(WORKFLOWS, "review-queue", { prs: [prs[0]], auto_deep: false }, {
		verify: () => ({ passed: false, score: 0, reasons: "uncertain", raw: res("v"), ok: true, error: "" }),
	});
	assert.doesNotMatch(String(rejected.result), /\| Approve \|/);
	assert.match(String(rejected.result), /Independent approval verification: 0\/1 passed/);
});

test("review-queue.mjs: checkout fallback is degraded and cannot approve", async () => {
	const pr = {
		repo: "o/r",
		number: 30,
		title: "deep requested",
		files: ["a.js"],
		diff: "bounded diff",
		me: "me",
		my_teams: [],
		reviewers: [],
		codeowners: "",
		coverage: "full diff",
		platform: "github",
		clone_url: "https://github.com/o/r.git",
		pr_ref: "pull/30/head",
	};
	const { result } = await smoke(WORKFLOWS, "review-queue", { prs: [pr], deep: true }, { worktreeError: "checkout failed" });
	assert.doesNotMatch(String(result), /\| Approve \|/);
	assert.match(String(result), /Deep checkout unavailable: checkout failed/);
});

test("review-queue.mjs: missing or symlinked checkout files cannot approve", async () => {
	const pr = {
		repo: "o/r",
		number: 31,
		title: "deleted file",
		files: ["deleted.js"],
		diff: "",
		me: "me",
		my_teams: [],
		reviewers: [],
		codeowners: "",
		coverage: "partial",
		platform: "github",
		clone_url: "https://github.com/o/r.git",
		pr_ref: "pull/31/head",
	};
	const run = await smoke(WORKFLOWS, "review-queue", { prs: [pr], deep: true }, {
		host: { inspectCheckout: () => ({ present: [], missing: ["deleted.js"], uninspectable: [] }) },
	});
	assert.doesNotMatch(String(run.result), /\| Approve \|/);
	assert.match(String(run.result), /Missing from PR-head checkout: deleted\.js/);
	assert.equal(run.calls.verify, 0);

	const root = tmpDir();
	writeFileSync(join(root, "present.js"), "ok\n");
	const outside = tmpDir();
	writeFileSync(join(outside, "outside.js"), "secret\n");
	symlinkSync(join(outside, "outside.js"), join(root, "link.js"));
	const { inspectCheckout: inspectReviewCheckout } = await import(REVIEW_QUEUE_HOST);
	const inspected = await inspectReviewCheckout({ root, files: ["present.js", "deleted.js", "link.js"] });
	assert.deepEqual(inspected.present, ["present.js"]);
	assert.deepEqual(inspected.missing, ["deleted.js"]);
	assert.deepEqual(inspected.uninspectable, ["link.js"]);
});

test("review-queue fetcher reads CODEOWNERS from the PR base branch", () => {
	const fetcher = readFileSync(resolve(WORKFLOWS, "../skills/review-queue/scripts/review-queue-fetch.sh"), "utf8");
	assert.match(fetcher, /baseRefName/);
	assert.match(fetcher, /gh_codeowners "\$user" "\$repo" "\$base_ref"/);
	assert.match(fetcher, /-f "ref=\$ref"/);
	assert.match(fetcher, /codeowners_ref:\$base_ref/);
});

test("security-review.mjs: scans, investigates, verifies, and renders a report", async () => {
	const { result, calls, meta } = await smoke(WORKFLOWS, "security-review", { root: "src/" });
	assert.equal(meta.name, "security-review");
	assert.match(/** @type {string} */ (result), /# Security review/);
	assert.match(/** @type {string} */ (result), /Verification: 1 verified/);
	assert.match(/** @type {string} */ (result), /\| Severity \| Confidence \|/);
	assert.equal(calls.hostDiscover, 1, "deterministic host discovery ran");
	assert.equal(calls.hostValidate, 1, "host evidence revalidation ran");
	assert.ok(calls.structured >= 1, "at least one investigation");
	assert.ok(calls.verify >= 1, "adversarial verification ran");
	assert.equal(calls.synthesize, 1, "executive summary synthesized");
	assert.equal(calls.structuredArgs[0].options.allowAllTools, true);
	assert.deepEqual(calls.structuredArgs[0].options.deny, ["shell", "write"]);
	assert.equal(calls.structuredArgs[0].options.enableMcp, false);
	assert.equal(calls.verifyArgs[0].options.enableMcp, false);
});

test("security-review host deterministically scopes, caps, and revalidates evidence", async () => {
	const { discover: discoverSecurity, validateFindings: validateSecurityFindings } = await import(SECURITY_HOST);
	const root = tmpDir();
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "tests"), { recursive: true });
	writeFileSync(join(root, "src/app.js"), "exec(userInput);\nexec(otherInput);\n");
	writeFileSync(join(root, "src/safe.js"), "export const safe = true;\n");
	writeFileSync(join(root, "tests/ignored.js"), "exec(untrusted);\n");
	const outside = tmpDir();
	writeFileSync(join(outside, "secret.js"), "exec(secret);\n");
	symlinkSync(join(outside, "secret.js"), join(root, "src/outside.js"));

	const scan = await discoverSecurity({ root: "src", max_files: 10, max_candidates_per_file: 1 }, { cwd: root });
	assert.equal(scan.selectedCount, 2, "out-of-scope symlink is excluded");
	assert.deepEqual(scan.records.map((/** @type {any} */ record) => record.filePath), ["app.js"]);
	assert.equal(scan.candidateCount, 1);
	assert.ok(scan.boundaries.some((/** @type {string} */ boundary) => /omitted/.test(boundary)));
	const escaped = await discoverSecurity({ files: ["src/outside.js"], max_files: 10 }, { cwd: root });
	assert.equal(escaped.selectedCount, 0);
	assert.equal(escaped.records.length, 0);

	const direct = await discoverSecurity({ files: ["src/safe.js"], max_files: 10 }, { cwd: root });
	assert.equal(direct.records.length, 1, "explicit files are reviewed even without regex candidates");
	const record = direct.records[0];
	const valid = await validateSecurityFindings(
		{
			root,
			records: [record],
			findings: [{ severity: "HIGH", confidence: "high", vulnClass: "test", filePath: "src/safe.js", line: 1, title: "t", description: "d", recommendation: "r" }],
		},
		{ cwd: root },
	);
	assert.equal(valid.valid.length, 1);
	assert.match(valid.valid[0].evidence, /1: export const safe/);

	writeFileSync(join(root, "src/safe.js"), "export const changed = true;\n");
	const stale = await validateSecurityFindings(
		{
			root,
			records: [record],
			findings: [{ severity: "HIGH", confidence: "high", vulnClass: "test", filePath: "src/safe.js", line: 1, title: "t", description: "d", recommendation: "r" }],
		},
		{ cwd: root },
	);
	assert.equal(stale.valid.length, 0);
	assert.match(stale.rejected[0].reason, /changed after discovery/);
});

test("security-review.mjs: uncached host evidence and failures stay explicit", async () => {
	const records = ["src/a.js", "src/b.js"].map((filePath) => ({
		filePath,
		fileHash: filePath,
		candidates: [{ vulnClass: "command-injection", line: 1, snippet: "exec(x)", matchedPattern: "shell", noiseTier: "normal" }],
		reviewMode: "candidate-anchored",
	}));
	/** @type {NonNullable<SmokeBehavior["host"]>} */
	const host = {
		discover: (_input, options) => {
			assert.equal(options.cache, false);
			return {
				root: "/tmp/cwf-smoke",
				source: "test scope",
				direct: true,
				selectedCount: 2,
				preCapRecords: 2,
				records,
				candidateCount: 2,
				preCapCandidateCount: 2,
				unreadable: 0,
				boundaries: ["bounded fixture"],
			};
		},
		validateFindings: (input, options) => {
			assert.equal(options.cache, false);
			return { valid: input.findings, rejected: [] };
		},
	};
	const run = await smoke(WORKFLOWS, "security-review", { root: "src", batch_size: 1 }, {
		host,
		structured: (_prompt, schema, _options, index) =>
			index === 0
				? { value: null, ok: false, error: "malformed investigation", raw: res("bad"), attempts: 3 }
				: { value: [fillObject(schema.items)], ok: true, error: "", raw: res("{}"), attempts: 1 },
		verify: () => ({ passed: false, score: null, reasons: "verifier unavailable", raw: { ...res(""), ok: false, error: "verifier unavailable" }, ok: false, error: "verifier unavailable" }),
	});
	assert.match(String(run.result), /1\/2 batch\(es\) completed; 1 failed/);
	assert.match(String(run.result), /0 verified, 0 rejected, 1 unverified/);
	assert.match(String(run.result), /review was incomplete/);
	assert.match(String(run.result), /bounded fixture/);
});

test("security-review.mjs: dry-run follows discovered batch and verification fan-out", async () => {
	const { calls } = await smoke(WORKFLOWS, "security-review", { root: "src" }, { dryRun: true });
	assert.equal(calls.hostDiscover, 1);
	assert.equal(calls.structured, 1);
	assert.equal(calls.hostValidate, 1);
	assert.equal(calls.verify, 1);
	assert.equal(calls.synthesize, 1);
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
