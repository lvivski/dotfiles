import { prepareQueue } from "../review/preparation.mjs";
import { renderQueue } from "../review/report.mjs";
import { createReviewStages } from "../review/stages.mjs";

const PR_SCHEMA = {
	type: "object",
	required: ["repo", "number"],
	properties: {
		repo: { type: "string" },
		number: { type: "integer" },
		title: { type: "string" },
		diff: { type: "string" },
		files: { type: "array", items: { type: "string" } },
		me: { type: "string" },
		my_teams: { type: "array", items: { type: "string" } },
		reviewers: { type: "array", items: { type: "object" } },
		codeowners: { type: "string" },
		coverage: { type: "string" },
		platform: { type: "string" },
		url: { type: "string" },
		updatedAt: { type: "string" },
		freshness: { type: "object" },
		evidence: { type: "object" },
		assignments: { type: "array", items: { type: "object" } },
	},
};

const PRS_SCHEMA = {
	type: "array",
	items: PR_SCHEMA,
};

/** @type {import("@github/copilot-sdk").WorkflowMeta & {limits: Required<import("@github/copilot-sdk").WorkflowLimits>}} */
export const meta = {
	name: "review-queue",
	description:
		"Review supplied PR diffs for correctness and maintainability, measure line changes, " +
		"verify low-risk candidates, and render a triage queue. " +
		"Pass the fetcher's complete {prs, fetch} manifest; missing manifests cannot support approval triage. " +
		"Args: { prs: object[], fetch: object, diff_chunk_chars?: number, max_total_chunks?: number, " +
		"approve_only_low_risk_manual?: boolean, freshness?: string, pauseBeforeWork?: boolean }.",
	phases: [{ title: "Review and verify" }, { title: "Report" }],
	argsSchema: {
		anyOf: [
			PRS_SCHEMA,
			{
				type: "object",
				required: ["prs"],
				properties: {
					prs: PRS_SCHEMA,
					diff_chunk_chars: { type: "integer" },
					max_total_chunks: { type: "integer" },
					approve_only_low_risk_manual: { type: "boolean" },
					freshness: { type: "string" },
					fetch: { type: "object" },
					pauseBeforeWork: { type: "boolean" },
				},
			},
		],
	},
	limits: {
		maxConcurrentSubagents: 8,
		maxTotalSubagents: 700,
		timeoutSeconds: 3600,
		maxAiCredits: 10000,
	},
};

/** @param {Pick<import("@github/copilot-sdk").WorkflowContext, "args" | "phase" | "agent" | "pipeline" | "parallel" | "step" | "log" | "pause">} workflow */
export async function run(workflow) {
	const prepared = await prepareQueue(workflow, meta.limits.maxTotalSubagents);
	if (typeof prepared === "string") return prepared;
	const { prs, evidenceCount, freshness } = prepared;
	const { reviewPullRequest, verifyPullRequest } = createReviewStages(workflow, prepared);

	workflow.phase("Review and verify");
	/** @type {Map<number, Awaited<ReturnType<typeof reviewPullRequest>>>} */
	const reviewedRows = new Map();
	/** @type {Map<number, Awaited<ReturnType<typeof verifyPullRequest>>>} */
	const decidedRows = new Map();
	const results = await workflow.pipeline(prs,
		async (_pr, _original, index) => {
			const reviewed = await reviewPullRequest(prs[index]);
			reviewedRows.set(index, reviewed);
			return reviewed;
		},
		async (_row, _original, index) => {
			const reviewed = reviewedRows.get(index);
			if (!reviewed) throw new Error("review-queue: missing completed primary review");
			const decided = await verifyPullRequest(reviewed);
			decidedRows.set(index, decided);
			return decided;
		});
	// Failed pipeline items skip later stages, so restore their report rows here.
	const rows = results.map((row, index) => row === null ? ({
		pr: prs[index],
		reason: prs[index].reason,
		decision: "needs_review",
		risk: "high",
		coverage: "review branch failed",
		justification: "The review branch failed.",
		focus: ["Retry the review"],
	}) : (() => {
		const decided = decidedRows.get(index);
		if (!decided) throw new Error("review-queue: missing completed verification");
		return decided;
	})());
	workflow.phase("Report");
	return renderQueue({ rows, prs, evidenceCount, freshness });

}
