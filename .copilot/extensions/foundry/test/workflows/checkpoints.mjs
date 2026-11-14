import { mixedResearchResponse } from "../research/fixture.mjs";
import { addedReviewDiff, completeFetch, reviewPullRequest } from "../review/fixture.mjs";
import { securityFinding } from "../security/fixture.mjs";

/** @typedef {AgentOptions & {label: string}} NamedAgentOptions */
/** @typedef {NonNullable<Parameters<import("@github/copilot-sdk").WorkflowContext["agent"]>[1]>} AgentOptions */

/** @type {Array<{key: string, name?: string, args: import("@github/copilot-sdk").WorkflowJsonSchema,
 * step: string, checkpoint: string, earlyLabels: string[], phase: string, scope: RegExp,
 * response?: (prompt: string, options: NamedAgentOptions) => unknown}>} */
export const CHECKPOINT_CASES = [
	{
		key: "audit",
		args: { paths: [" src/a.js ", "src/a.js", ""], concern: " error handling " },
		step: "audit:prepared-scope:v2",
		checkpoint: "audit:before-audit:v1",
		earlyLabels: [],
		phase: "Audit",
		scope: /prepared scope.*"paths":\[" src\/a\.js ","src\/a\.js"\].*"concern":" error handling "/,
		response: (_prompt, options) => options.label.startsWith("review:") ? "Concrete issue" : undefined,
	},
	{
		key: "deepResearch",
		args: { q: "Compare evidence", angles: 2 },
		step: "deep-research:prepared-angles:v2",
		checkpoint: "deep-research:before-research:v1",
		earlyLabels: ["plan"],
		phase: "Research",
		scope: /prepared scope.*"question":"Compare evidence".*"angles":\[" Evidence "," Costs "\]/,
		response: (_prompt, options) => options.label === "plan" ? [" Evidence ", "EVIDENCE", " Costs "] : undefined,
	},
	{
		key: "deepResearch",
		name: "saved research",
		args: {
			question: "Recover evidence",
			drafts: [{ angle: " Saved angle ", text: " Saved draft ", feedback: " Edition mismatch " }],
		},
		step: "deep-research:prepared-angles:v2",
		checkpoint: "deep-research:before-research:v1",
		earlyLabels: [],
		phase: "Research",
		scope: /prepared scope.*"angles":\[" Saved angle "\].*"savedDrafts":true/,
		response: mixedResearchResponse,
	},
	{
		key: "reviewQueue",
		args: {
			prs: [reviewPullRequest(7, { diff: addedReviewDiff(["x".repeat(4100)]) })],
			fetch: completeFetch(),
			diff_chunk_chars: 4000,
			max_total_chunks: 2,
			approve_only_low_risk_manual: true,
			freshness: "saved queue",
		},
		step: "review-queue:prepared-queue:v3",
		checkpoint: "review-queue:before-review:v2",
		earlyLabels: [],
		phase: "Review and verify",
		scope: /prepared queue.*"repo":"owner\/repo","number":7.*"chunks":2.*"freshness":"saved queue"/,
	},
	{
		key: "securityReview",
		args: { root: "src", perspectives: 2, context: " App context ", model: " review-model " },
		step: "security-review:prepared-scope:v2",
		checkpoint: "security-review:before-investigate:v1",
		earlyLabels: ["orientation"],
		phase: "Investigate",
		scope: /prepared investigation.*repository subtree src.*"model":"review-model".*"lenses":.*"threatModel":/,
		response: (_prompt, options) => options.label.startsWith("investigate:") ? [securityFinding()] : undefined,
	},
	{
		key: "triage",
		args: {
			tickets: [
				{ id: " duplicate ", summary: " Crash ", description: "x".repeat(8100) },
				{ id: "duplicate", title: "Other ticket" },
			]
		},
		step: "triage:prepared-tickets:v2",
		checkpoint: "triage:before-triage:v1",
		earlyLabels: [],
		phase: "Triage",
		scope: /prepared tickets.*"id":" duplicate ","preview":" Crash .*"truncated":false/,
	},
];
