import { createWorkflowAnalysis } from "../../workflow.mjs";

/** Unused native operations fail explicitly instead of pretending to succeed.
 * @param {Partial<import("../../types/workflow.js").WorkflowAnalysisPort>} [overrides]
 * @returns {import("../../types/workflow.js").WorkflowAnalysisPort}
 */
export function analysisFixture(overrides = {}) {
	return { ...createWorkflowAnalysis(() => null), ...overrides };
}

/** @param {Partial<import("@github/copilot-sdk").WorkflowRunDetail>} [overrides]
 * @returns {import("@github/copilot-sdk").WorkflowRunDetail} */
export function workflowDetail(overrides = {}) {
	return {
		runId: "fixture-run", workflowName: "plan", description: "Fixture workflow", status: "completed",
		revision: 1, createdAt: 0, startedAt: 0, updatedAt: 0, completedAt: 0,
		currentPhase: null, declaredPhaseCount: 0, liveAgentCount: 0, totalSpawnedAgentCount: 0,
		consumed: { activeMs: 0, subagents: 0, nanoAiu: 0 }, declaredLimits: {}, approved: {},
		observedAt: 0, activeSegmentStartedAt: null, terminal: null, canResume: false,
		phases: [], agents: [],
		progress: { records: [], oldestSeq: null, newestSeq: null, hasMoreOlder: false, hasMoreNewer: false, revision: 1 },
		...overrides,
	};
}
