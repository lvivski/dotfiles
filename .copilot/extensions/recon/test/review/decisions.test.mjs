import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { isList, parseJson, readRecord } from "../../data.mjs";
import { must } from "../assertions.mjs";
import { createWorkflowContext, FatalWorkflowFailure } from "../workflows/runtime.mjs";
import { ADDITIONAL_WORKFLOWS } from "../workflows/registry.mjs";
import { addedReviewDiff, completeFetch, reviewPullRequest, reviewQueueRows } from "./fixture.mjs";

test("review queue preserves coverage, policy, and failed-evidence decisions", async (t) => {
	for (const manualOnly of [false, true]) {
		await t.test(`manual-only policy: ${manualOnly}`, async () => {
			const prs = [
				reviewPullRequest(1),
				reviewPullRequest(2, { codeowners: "* @octocat" }),
				reviewPullRequest(3, { reviewers: [{ name: "octocat", required: true }] }),
				reviewPullRequest(4, { coverage: "partial diff" }),
				reviewPullRequest(5, { coverage: "" }),
				reviewPullRequest(6, { diff: "" }),
				reviewPullRequest(7, { diff: addedReviewDiff(Array(600).fill("change")) }),
				...Array.from({ length: 6 }, (_, index) => reviewPullRequest(index + 8)),
			];
			const workflow = createWorkflowContext({
				prs,
				fetch: completeFetch(),
				diff_chunk_chars: 4000,
				approve_only_low_risk_manual: manualOnly,
			}, (_prompt, options) => {
				if (["owner/repo#8:review:1", "owner/repo#9:verify:1"].includes(options.label)) {
					return null;
				}
				if (options.label === "owner/repo#10:review:1") {
					return {
						risk: "high",
						issues: ["Concrete regression"],
						missingTests: ["Regression coverage"],
						maintainability: [],
						uncertainty: ["Unclear compatibility"],
						summary: "Needs review",
					};
				}
				if (["owner/repo#11:review:1", "owner/repo#13:verify:1"].includes(options.label)) {
					throw new Error("ordinary agent failure");
				}
				if (options.label === "owner/repo#12:verify:1") {
					return { passed: false, reasons: "Unresolved issue" };
				}
				return undefined;
			});
			const report = await ADDITIONAL_WORKFLOWS.reviewQueue.run(workflow);
			const rows = reviewQueueRows(report);
			const approved = manualOnly ? [1, 7] : [1, 2, 3, 7];
			const needsReview = prs.map((pr) => pr.number).filter((number) => !approved.includes(number));
			assert.deepEqual(
				rows.map((row) => row.match(/\[owner\/repo#(\d+)\]/)?.[1]),
				[...needsReview, ...approved].map(String),
			);
			/** @param {number} number */
			const rowFor = (number) => {
				const row = rows.find((entry) => entry.includes(`[owner/repo#${number}]`));
				assert.ok(row);
				return row;
			};
			for (const pr of prs) {
				assert.ok(rowFor(pr.number).startsWith(
					approved.includes(pr.number) ? "| Approve |" : "| Needs review |",
				));
			}
			assert.match(rowFor(2), /\| CODEOWNERS \|/);
			assert.match(rowFor(3), /\| Required policy \|/);
			assert.match(rowFor(4), /\| high \|.*1\/1 diff chunks; partial diff/);
			assert.match(rowFor(5), /\| high \|.*coverage unknown/);
			assert.match(rowFor(6), /\| high \|.*0\/0 diff chunks/);
			assert.match(rowFor(7), /2\/2 diff chunks/);
			assert.match(rowFor(7), /\+600\/-0; net \+600/);
			assert.match(rowFor(8), /\| high \|.*0\/1 diff chunks/);
			assert.match(rowFor(9), /\| medium \|.*0\/1 passed/);
			assert.match(rowFor(10), /Concrete regression.*Missing test: Regression coverage/);
			assert.match(rowFor(11), /\| high \|.*0\/1 diff chunks/);
			assert.match(rowFor(12), /\| medium \|.*0\/1 passed/);
			assert.match(rowFor(13), /\| medium \|.*0\/1 passed/);
			assert.equal(workflow.calls.length, manualOnly ? 19 : 21);
			assert.equal(new Set(workflow.calls.map((call) => call.options.label)).size, workflow.calls.length);
			assert.deepEqual(workflow.pipelineBatches, [prs.length]);
			assert.deepEqual(workflow.phases, ["Review and verify", "Report"]);
		});
	}
});

test("review queue measures supplied text hunks without inventing source metrics", async (t) => {
	const cases = [
		{
			name: "GitHub headers, context, marker-like code, blank lines, and CRLF",
			overrides: {
				diff: [
					"diff --git a/src/a.js b/src/a.js",
					"index 1234567..abcdef0 100644",
					"--- a/src/a.js",
					"+++ b/src/a.js",
					"@@ -10,3 +10,5 @@ function execute() {",
					" context",
					"---old-marker",
					"+++new-marker",
					"+",
					"+return next;",
					" tail",
					"\\ No newline at end of file",
					"@@ -30 +32 @@",
					"-before",
					"+after",
					"",
				].join("\r\n"),
			},
			expected: "+4/-2; net +2",
			approve: true,
		},
		{
			name: "Azure multi-file unified diff ignores placeholder API counts",
			overrides: {
				platform: "azure",
				additions: 0,
				deletions: 0,
				files: ["src/a.js", "docs/guide.md"],
				diff: "--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1 @@\n-old1\n-old2\n+new\n" +
					"--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -0,0 +1,2 @@\n+first\n+second\n",
			},
			expected: "+3/-2; net +1",
			approve: true,
		},
		{
			name: "deleted file",
			overrides: { diff: "--- a/src/a.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-old1\n-old2\n" },
			expected: "+0/-2; net -2",
			approve: true,
		},
		{
			name: "observed context is a measured zero, not unavailable",
			overrides: { diff: "@@ -1 +1 @@\n unchanged\n" },
			expected: "+0/-0; net 0",
			approve: true,
		},
		{
			name: "explicit partial coverage",
			overrides: { coverage: "partial diff" },
			expected: "+1/-0; net +1; partial",
			approve: false,
		},
		{
			name: "truncated hunk cannot claim full coverage",
			overrides: { diff: "@@ -0,0 +1,2 @@\n+observed\n" },
			expected: "+1/-0; net +1; partial",
			approve: false,
		},
		{
			name: "unexpected content interrupts a hunk",
			overrides: { diff: "@@ -1 +1 @@\n-old\nunavailable\n" },
			expected: "+0/-1; net -1; partial",
			approve: false,
		},
		{
			name: "binary-only evidence is not zero line growth",
			overrides: { diff: "diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n" },
			expected: "Unavailable (no text hunks)",
			approve: false,
		},
		{
			name: "Git binary patch is opaque",
			overrides: { diff: "diff --git a/image.png b/image.png\nGIT binary patch\nliteral 3\nabc\n" },
			expected: "Unavailable (no text hunks)",
			approve: false,
		},
		{
			name: "mixed text and binary evidence reports only observed text",
			overrides: {
				diff: addedReviewDiff(["const answer = 42;"]) +
					"diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n",
			},
			expected: "+1/-0; net +1; partial",
			approve: false,
		},
		{
			name: "Azure missing content is partial even when mislabeled",
			overrides: {
				platform: "azure",
				diff: "Azure content unavailable for base: src/a.js\n" + addedReviewDiff(["const answer = 42;"]),
			},
			expected: "+1/-0; net +1; partial",
			approve: false,
		},
		{
			name: "summary-only file listings are not deletions",
			overrides: { coverage: "summary only", diff: "Azure DevOps changed files (summary only):\n- edit src/a.js\n" },
			expected: "Unavailable (no text hunks)",
			approve: false,
		},
		{
			name: "missing evidence",
			overrides: { diff: "" },
			expected: "Unavailable (no text hunks)",
			approve: false,
		},
		{
			name: "unmeasured metrics alone do not block a metadata-only change",
			overrides: { diff: "diff --git a/src/a.js b/src/a.js\nold mode 100644\nnew mode 100755\n" },
			expected: "Unavailable (no text hunks)",
			approve: true,
		},
	];
	for (const { name, overrides, expected, approve } of cases) {
		await t.test(name, async () => {
			const workflow = createWorkflowContext({ prs: [reviewPullRequest(1, overrides)], fetch: completeFetch() });
			const report = await ADDITIONAL_WORKFLOWS.reviewQueue.run(workflow);
			assert.ok(typeof report === "string");
			const [row] = reviewQueueRows(report);
			assert.ok(row.includes(`| ${expected} |`), row);
			assert.ok(row.startsWith(approve ? "| Approve | low |" : "| Needs review | high |"), row);
			assert.equal(workflow.calls.some((call) => call.options.label.includes(":verify:")), approve);
			assert.match(report, /Verbosity and erosion: not measured/);
			assert.match(report, /not source LOC or an approval threshold/);
			assert.match(report, /Independent model agreement is not proof of quality/);
		});
	}
});

test("review queue gates material maintainability concerns even with low correctness risk", async () => {
	const finding = {
		category: "duplication",
		location: "src/a.js:1-2",
		evidence: "validUser and validAdmin both repeat value.id && value.active",
		impact: "Changes to eligibility must be kept in sync in both implementations.",
		simplification: "Reuse one eligibility predicate while preserving both entry points.",
	};
	const workflow = createWorkflowContext({
		fetch: completeFetch(),
		prs: [reviewPullRequest(1, {
			diff: addedReviewDiff([
				"const validUser = value => value.id && value.active;",
				"const validAdmin = value => value.id && value.active;",
			]),
		})],
	}, (_prompt, options) => options.label.includes(":review:") ? {
		risk: "low",
		issues: [],
		missingTests: [],
		maintainability: [finding],
		uncertainty: [],
		summary: "Correct behavior with duplicated eligibility logic",
	} : undefined);
	const [row] = reviewQueueRows(await ADDITIONAL_WORKFLOWS.reviewQueue.run(workflow));
	assert.match(row, /^\| Needs review \| medium \|/);
	for (const detail of Object.values(finding)) assert.ok(row.includes(detail), detail);
	assert.match(row, /Maintainability \(duplication\)/);
	assert.equal(workflow.calls.length, 1);
	const schema = must(workflow.calls[0].options.schema);
	assert.ok(isList(schema.required) && schema.required.includes("maintainability"));
	assert.deepEqual(
		readRecord(readRecord(readRecord(schema.properties).maintainability).items).required,
		["category", "location", "evidence", "impact", "simplification"],
	);
});

test("review queue requires complete versioned source and assignment evidence", async (t) => {
	/** @type {Array<(pr: import("./types.js").ReviewFixture) => void>} */
	const changes = [
		// @ts-expect-error Removing required provenance is the malformed-wire case under test.
		(pr) => { delete pr.evidence; },
		(pr) => { pr.evidence.source.headRevision = "mutable-branch"; },
		(pr) => { pr.evidence.source.account = "different-account"; },
		(pr) => { pr.evidence.source.repository = "other/repo"; },
		(pr) => { pr.evidence.source.number = 999; },
		(pr) => { pr.evidence.source.host = "other.test"; },
		(pr) => { pr.evidence.completeness.files = false; },
		(pr) => { pr.evidence.completeness.diff = false; },
		(pr) => { pr.evidence.completeness.assignments = false; },
		(pr) => { pr.evidence.failures.push({ stage: "codeowners", message: "Authorization failed" }); },
		(pr) => { pr.assignments = []; },
		(pr) => { pr.assignments[0].account = "different-account"; },
	];
	for (const change of changes) {
		await t.test(String(change), async () => {
			const pr = reviewPullRequest(1);
			change(pr);
			const workflow = createWorkflowContext({ prs: [pr], fetch: completeFetch() });
			const [row] = reviewQueueRows(await ADDITIONAL_WORKFLOWS.reviewQueue.run(workflow));
			assert.match(row, /^\| Needs review \| high/);
			assert.match(row, /unverified provenance/);
			assert.ok(workflow.calls.every((call) => !call.options.label.includes(":verify:")));
		});
	}
});

test("review queue exposes failed fetches even when no PRs were returned", async () => {
	const fetch = {
		version: 1, complete: false, failures: [
			{ platform: "github", account: "octocat", stage: "teams", message: "Team discovery failed" },
		]
	};
	const empty = await ADDITIONAL_WORKFLOWS.reviewQueue.run(createWorkflowContext({ prs: [], fetch }));
	assert.ok(typeof empty === "string");
	assert.match(empty, /Review queue incomplete/);
	assert.match(empty, /octocat.*Team discovery failed/);
	const workflow = createWorkflowContext({ prs: [reviewPullRequest(1)], fetch });
	const [row] = reviewQueueRows(await ADDITIONAL_WORKFLOWS.reviewQueue.run(workflow));
	assert.match(row, /^\| Needs review \| high/);
	assert.match(row, /queue fetch incomplete.*Team discovery failed/);
	assert.equal(workflow.calls.length, 1);
	for (const args of [{ prs: [reviewPullRequest(1)] }, [reviewPullRequest(1)]]) {
		const missing = createWorkflowContext(args);
		assert.match(reviewQueueRows(await ADDITIONAL_WORKFLOWS.reviewQueue.run(missing))[0], /^\| Needs review \| high/);
		assert.equal(missing.calls.length, 1, "Dropping the manifest must not admit independent approval verification");
	}
});

test("review queue preserves all account/team assignments without sharing agent identity", async () => {
	const alpha = reviewPullRequest(1, { me: "alpha" });
	alpha.assignments.push({ account: "alpha", kind: "team", reviewer: "owner/platform" });
	alpha.my_teams = ["owner/platform"];
	alpha.codeowners = "* @owner/platform";
	const beta = reviewPullRequest(1, { me: "beta" });
	const workflow = createWorkflowContext({ prs: [alpha, beta], fetch: completeFetch(), approve_only_low_risk_manual: true });
	const rows = reviewQueueRows(await ADDITIONAL_WORKFLOWS.reviewQueue.run(workflow));
	assert.equal(rows.length, 2);
	assert.match(rows[0], /^\| Needs review.*alpha.*team: owner\/platform.*CODEOWNERS/);
	assert.match(rows[1], /^\| Approve.*beta.*Manual/);
	assert.equal(new Set(workflow.calls.map((call) => call.options.label)).size, 3);
	assert.ok(workflow.calls.every((call) => call.prompt.includes('"source"')));
});

test("review queue applies the structural rubric independently and preserves rejection evidence", async () => {
	const reason = "src/a.js:1: a single-use wrapper adds another API to maintain; call the existing helper directly.";
	const diff = addedReviewDiff(["const wrapper = value => existingHelper(value);"]);
	const workflow = createWorkflowContext({
		prs: [reviewPullRequest(1, { diff })],
		fetch: completeFetch(),
	}, (_prompt, options) => options.label.includes(":verify:") ? {
		passed: false,
		reasons: reason,
	} : undefined);
	const [row] = reviewQueueRows(await ADDITIONAL_WORKFLOWS.reviewQueue.run(workflow));
	assert.match(row, /^\| Needs review \| medium \|/);
	assert.ok(row.includes(`Chunk 1: ${reason}`));
	assert.equal(workflow.calls.length, 2);
	for (const { prompt } of workflow.calls) {
		assert.match(prompt, /Assess maintainability separately from correctness/);
		assert.match(prompt, /introduced or worsened duplication, unnecessary abstractions/);
		assert.match(prompt, /complex branching/);
		assert.match(prompt, /simpler behavior-preserving approach/);
		assert.match(prompt, /not a quality score or an approval threshold/);
		assert.match(prompt, /tests, documentation, generated code, lockfiles/);
		assert.match(prompt, /Never invent numeric sloppiness scores, verbosity ratios, or erosion values/);
		assert.match(prompt, /unavailable metrics alone are not a concern/);
		assert.match(prompt, /Do not infer AI authorship/);
		const block = /<UNTRUSTED-PULL-REQUEST-DIFF>\n([\s\S]+?)\n<\/UNTRUSTED-PULL-REQUEST-DIFF>/.exec(prompt);
		assert.ok(block);
		const evidence = readRecord(parseJson(block[1]));
		assert.equal(evidence.content, diff);
		assert.deepEqual(evidence.observedLineChanges, {
			additions: 1,
			deletions: 0,
			net: 1,
			incomplete: false,
		});
	}
});

test("review queue requires a verdict for every reviewed chunk", async () => {
	const workflow = createWorkflowContext({ prs: [reviewPullRequest(1)], fetch: completeFetch() });
	const parallel = workflow.parallel;
	let batches = 0;
	workflow.parallel = async (thunks) => ++batches === 2 ? [] : parallel(thunks);
	const [row] = reviewQueueRows(await ADDITIONAL_WORKFLOWS.reviewQueue.run(workflow));
	assert.match(row, /^\| Needs review \| medium \|/);
	assert.match(row, /Independent verification was incomplete/);
	assert.match(row, /0\/1 passed/);
});

test("review queue verifies ready PRs while waiting for every chunk of slower PRs", {
	timeout: 5000,
}, async (t) => {
	const events = new EventEmitter();
	const releaseSlowReview = once(events, "release", { signal: t.signal });
	const fastVerification = once(events, "fast-verification", { signal: t.signal });
	t.after(() => events.emit("release"));
	const workflow = createWorkflowContext({
		prs: [
			reviewPullRequest(1, { diff: addedReviewDiff(Array(600).fill("change")) }),
			reviewPullRequest(2),
		],
		fetch: completeFetch(),
		diff_chunk_chars: 4000,
	}, async (_prompt, options) => {
		if (options.label === "owner/repo#1:review:2") await releaseSlowReview;
		if (options.label === "owner/repo#2:verify:1") events.emit("fast-verification");
		return undefined;
	});
	const pending = ADDITIONAL_WORKFLOWS.reviewQueue.run(workflow);
	try {
		await Promise.race([
			fastVerification,
			pending.then(() => assert.fail("Report finished before the ready PR was verified")),
		]);
		assert.ok(workflow.calls.some((call) => call.options.label === "owner/repo#1:review:2"));
		assert.equal(workflow.calls.some((call) => call.options.label.startsWith("owner/repo#1:verify:")), false);
		assert.deepEqual(workflow.phases, ["Review and verify"]);
	} finally {
		events.emit("release");
	}
	const rows = reviewQueueRows(await pending);
	assert.equal(rows.length, 2);
	assert.match(rows[0], /^\| Approve \|.*\[owner\/repo#1\]/);
	assert.match(rows[1], /^\| Approve \|.*\[owner\/repo#2\]/);
	assert.equal(workflow.calls.length, 6);
	assert.deepEqual(workflow.pipelineBatches, [2]);
});

test("review queue completes when agent admissions are serialized", async () => {
	let active = 0;
	let peak = 0;
	const workflow = createWorkflowContext({
		prs: [reviewPullRequest(1), reviewPullRequest(2), reviewPullRequest(3)],
		fetch: completeFetch(),
	}, async () => {
		active += 1;
		peak = Math.max(peak, active);
		await Promise.resolve();
		active -= 1;
		return undefined;
	});
	const agent = workflow.agent;
	let tail = Promise.resolve();
	workflow.agent = (prompt, options) => {
		const result = tail.then(() => agent(prompt, options));
		tail = result.then(() => { });
		return result;
	};
	const rows = reviewQueueRows(await ADDITIONAL_WORKFLOWS.reviewQueue.run(workflow));
	assert.equal(peak, 1);
	assert.equal(rows.length, 3);
	assert.ok(rows.every((row) => row.startsWith("| Approve |")));
	assert.equal(workflow.calls.length, 6);
	assert.deepEqual(workflow.pipelineBatches, [3]);
});

test("review queue keeps a report row when either pipeline stage fails", async (t) => {
	for (const failedStage of [0, 1]) {
		await t.test(`failed stage ${failedStage}`, async () => {
			const workflow = createWorkflowContext({
				prs: [reviewPullRequest(1), reviewPullRequest(2)],
				fetch: completeFetch(),
			});
			const pipeline = workflow.pipeline;
			workflow.pipeline = (items, ...stages) => pipeline(
				items,
				...stages.map((stage, stageIndex) => (/** @type {unknown} */ previous, /** @type {unknown} */ item, /** @type {number} */ itemIndex) => {
					if (stageIndex === failedStage && itemIndex === 0) {
						throw new Error("ordinary stage failure");
					}
					return stage(previous, item, itemIndex);
				}),
			);
			const rows = reviewQueueRows(await ADDITIONAL_WORKFLOWS.reviewQueue.run(workflow));
			assert.equal(rows.length, 2);
			assert.match(rows[0], /^\| Needs review \| high \|.*\[owner\/repo#1\].*branch failed/);
			assert.match(rows[1], /^\| Approve \| low \|.*\[owner\/repo#2\]/);
			assert.equal(workflow.calls.some((call) => call.options.label === "owner/repo#1:verify:1"), false);
			assert.equal(workflow.calls.length, failedStage === 0 ? 2 : 3);
			assert.deepEqual(workflow.pipelineBatches, [2]);
		});
	}
});

test("review queue propagates simulated cancellation and hard runtime failures", async (t) => {
	for (const stage of ["review", "verify"]) {
		for (const message of ["cancelled", "connection lost", "limit reached"]) {
			await t.test(`${stage}: ${message}`, async () => {
				const failure = new FatalWorkflowFailure(message);
				const workflow = createWorkflowContext({
					prs: [reviewPullRequest(1)],
					fetch: completeFetch(),
				}, (_prompt, options) => {
					if (options.label === `owner/repo#1:${stage}:1`) throw failure;
					return undefined;
				});
				await assert.rejects(
					ADDITIONAL_WORKFLOWS.reviewQueue.run(workflow),
					(error) => error === failure,
				);
				assert.equal(workflow.phases.includes("Report"), false);
			});
		}
	}
});
