import assert from "node:assert/strict";
import test from "node:test";

import { isRecord } from "../../data.mjs";
import { run } from "../../workflows/review.mjs";

/** @typedef {import("./types.js").ReviewFixture} ReviewFixture */

/** @param {Partial<ReviewFixture>} [overrides] @returns {ReviewFixture} */
function pullRequest(overrides = {}) {
	return {
		repo: "owner/repo", number: 1, title: "Change",
		platform: "github", url: "https://github.com/owner/repo/pull/1",
		me: "reviewer", my_teams: ["owner/team"], reviewers: [],
		codeowners: "", files: ["src/a.js"],
		diff: "--- /dev/null\n+++ b/src/a.js\n@@ -0,0 +1 @@\n+const answer = 42;\n",
		coverage: "full diff", updatedAt: "2026-11-08T00:00:00Z",
		assignments: [{ account: "reviewer", reviewer: "reviewer", kind: "user" }],
		evidence: {
			version: 1,
			source: {
				platform: "github", host: "github.com", repository: "owner/repo", number: 1,
				account: "reviewer", baseRevision: "a".repeat(40), headRevision: "b".repeat(40),
			},
			completeness: { files: true, diff: true, assignments: true },
			failures: [],
		},
		...overrides,
	};
}

/** @param {import("@github/copilot-sdk").JsonValue} pr @param {import("@github/copilot-sdk").JsonValue | null} [prepared] */
async function review(pr, prepared = null) {
	/** @type {import("@github/copilot-sdk").WorkflowJsonSchema[]} */
	const calls = [];
	/** @type {Parameters<typeof run>[0]} */
	const context = {
		args: { prs: [pr], fetch: { version: 1, complete: true, failures: [] }, approve_only_low_risk_manual: true },
		log() { }, phase() { }, pause: async () => assert.fail("This fixture never requests a checkpoint"),
		step: async (_key, produce) => prepared ?? await produce(),
		parallel: (thunks) => Promise.all(thunks.map((thunk) => thunk())),
		pipeline: (items, ...stages) => Promise.all(items.map(async (item, index) => {
			const original = item;
			for (const stage of stages) item = await stage(item, original, index);
			return item;
		})),
		agent: async (_prompt, { schema } = {}) => {
			assert.ok(schema && isRecord(schema.properties));
			calls.push(schema);
			return schema.properties.risk
				? { risk: "low", issues: [], missingTests: [], maintainability: [], uncertainty: [], summary: "Clean" }
				: { passed: true, reasons: "Independently checked" };
		},
	};
	return { report: await run(context), calls };
}

test("CODEOWNERS preserves root anchoring, directory-only patterns, and glob depth", async (t) => {
	for (const [pattern, file, owned] of /** @type {const} */ ([
		["/src/", "src/a.js", true],
		["/src/", "src/deep/a.js", true],
		["/src/", "packages/example/src/a.js", false],
		["/src/", "src", false],
		["/src/", "src-other/a.js", false],
		["src/", "packages/example/src/a.js", true],
		["src/", "src", false],
		["docs/src/", "docs/src/a.js", true],
		["docs/src/", "packages/docs/src/a.js", false],
		["/src", "src", true],
		["/src", "src/a.js", true],
		["/src", "nested/src/a.js", false],
		["docs/*", "docs/guide.md", true],
		["docs/*", "docs/nested/guide.md", false],
		["/src/**", "src/deep/a.js", true],
		["**/logs", "deep/logs/a.txt", true],
		["*.js", "deep/a.js", true],
		["/src/", "SRC/a.js", false],
	])) {
		await t.test(`${pattern}: ${file}`, async () => {
			const { report, calls } = await review(pullRequest({ codeowners: `${pattern} @reviewer`, files: [file] }));
			assert.match(report, owned ? /\| CODEOWNERS \|/ : /\| Manual \|/);
			assert.match(report, owned ? /\| Needs review \|/ : /\| Approve \|/);
			assert.equal(calls.length, owned ? 1 : 2);
		});
	}
});

test("CODEOWNERS keeps last-match precedence, empty owners, and team ownership", async () => {
	for (const [codeowners, file, owned] of /** @type {const} */ ([
		["* @reviewer\n/src/ @other", "src/a.js", false],
		["* @other\n/src/ @owner/team", "src/a.js", true],
		["/src/ @reviewer\n/src/private/", "src/private/a.js", false],
		["src/ @reviewer\n/src/ @other", "nested/src/a.js", true],
		["/src/ @other\n/src/a.js @reviewer", "src/a.js", true],
	])) {
		const { report } = await review(pullRequest({ codeowners, files: [file] }));
		assert.match(report, owned ? /\| CODEOWNERS \|/ : /\| Manual \|/);
	}
	const { report } = await review(pullRequest({ reviewers: [{ name: "reviewer", required: true }] }));
	assert.match(report, /\| Required policy \|/);
});

test("Azure required-policy attribution uses actual assignment records, not display-name coincidences", async () => {
	const pr = pullRequest({ platform: "azure", reviewers: [{ name: "reviewer", required: true }] });
	pr.evidence.source.platform = "azure";
	pr.evidence.source.iteration = 2;
	pr.assignments = [{ account: "reviewer", reviewer: "Group", kind: "team", reviewerId: "group-id", required: false }];
	assert.match((await review(pr)).report, /\| Manual \|/);
	pr.assignments[0].required = true;
	assert.match((await review(pr)).report, /\| Required policy \|/);
	pr.assignments[0].required = false;
	pr.evidence.completeness.assignments = false;
	assert.match((await review(pr)).report, /\| Unknown \|/);
	pr.assignments = [];
	assert.match((await review(pr)).report, /\| Unknown \|/);
});

test("Azure freshness reports its iteration meaning and never falls back to PR creation", async () => {
	const pr = pullRequest({ platform: "azure", updatedAt: "2000-01-01T00:00:00Z" });
	for (const [freshness, expected] of [
		[null, "Unknown (iteration freshness)"],
		[{ timestamp: null, source: null }, "Unknown (iteration freshness)"],
		[{ timestamp: "2026-11-08T00:00:00Z", source: "iteration.updatedDate" }, "2026-11-08 (iteration updated)"],
		[{ timestamp: "2026-11-07T00:00:00Z", source: "iteration.createdDate" }, "2026-11-07 (iteration created)"],
	]) {
		const { report } = await review({ ...pr, freshness });
		assert.ok(typeof expected === "string");
		assert.ok(report.includes(expected));
		assert.ok(!report.includes("2000-01-01"));
		assert.match(report, /not the last comment, review, or general PR metadata update/);
	}
});

test("CODEOWNERS policy is rederived rather than replaying a cached matching error", async () => {
	const pr = pullRequest({ codeowners: "/src/ @reviewer", files: ["packages/example/src/a.js"] });
	const { diff, ...metadata } = pr;
	const { report, calls } = await review(pr, {
		prs: [{
			...metadata, myTeams: pr.my_teams, evidenceComplete: true, evidenceFailures: [],
			freshness: null, sourceKey: "github:github.com:owner/repo#1:reviewer",
			lineChanges: { additions: 1, deletions: 0, net: 1, incomplete: false },
			units: [{ id: "1", content: diff }], reason: "codeowner",
		}],
		evidenceCount: 1, approveOnlyLowRiskManual: true, freshness: "saved queue",
		fetchComplete: true, fetchFailures: [],
	});
	assert.match(report, /\| Manual \|/);
	assert.match(report, /\| Approve \|/);
	assert.equal(calls.length, 2);
});
