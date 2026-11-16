import assert from "node:assert/strict";

/** @param {string[]} lines @param {string} [file] */
export function addedReviewDiff(lines, file = "src/a.js") {
	return [
		`diff --git a/${file} b/${file}`,
		"--- /dev/null",
		`+++ b/${file}`,
		`@@ -0,0 +1,${lines.length} @@`,
		...lines.map((line) => `+${line}`),
		"",
	].join("\n");
}

/** @param {number} number @param {Partial<import("./types.js").ReviewFixture>} [overrides] @returns {import("./types.js").ReviewFixture} */
export function reviewPullRequest(number, overrides = {}) {
	const pr = {
		repo: "owner/repo",
		number,
		title: `Change ${number}`,
		diff: addedReviewDiff(["const answer = 42;"]),
		files: ["src/a.js"],
		me: "octocat",
		my_teams: [],
		reviewers: [],
		codeowners: "",
		coverage: "full diff",
		platform: "github",
		url: `https://example.test/owner/repo/pull/${number}`,
		updatedAt: "2026-08-11T00:00:00Z",
		...overrides,
	};
	return {
		...pr,
		evidence: {
			version: 1,
			source: {
				platform: pr.platform, host: new URL(pr.url).host, repository: pr.repo,
				number, account: pr.me, baseRevision: "a".repeat(40), headRevision: "b".repeat(40),
				...(pr.platform === "azure" ? { iteration: 2 } : {}),
			},
			completeness: { files: true, diff: pr.coverage === "full diff", assignments: true },
			failures: [],
		},
		assignments: [{ account: pr.me, kind: "user", reviewer: pr.me }],
		...overrides,
	};
}

export function completeFetch() {
	return { version: 1, complete: true, failures: [] };
}

/** @param {unknown} report */
export function reviewQueueRows(report) {
	assert.ok(typeof report === "string");
	return report.split("\n").filter((line) => /^\| (Approve|Needs review) \|/.test(line));
}
