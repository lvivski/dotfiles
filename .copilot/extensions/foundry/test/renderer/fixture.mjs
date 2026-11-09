import { approvePlan, createDraftPlan, transitionPlan } from "../../plan/lifecycle.mjs";
import { projectPlan } from "../../projection.mjs";
import { workflowDetail as nativeDetail } from "../native/fixture.mjs";

/** @param {number} revision @param {{id?: string, approved?: boolean}} [options] */
export function snapshot(revision, { id = "renderer-plan", approved = false } = {}) {
	let plan = createDraftPlan({
		id,
		title: `Revision ${revision}`,
		objective: "Exercise the real renderer",
		repository: { workingDirectory: "/tmp/renderer", baseBranch: "main" },
		tasks: [
			{
				id: "T-001", title: "Implement", kind: "implement", description: "Build",
				dependsOn: [], acceptanceCriteria: ["Works"], expectedFiles: ["src/**"],
				deliveryRequirement: "commit",
			},
			{
				id: "T-002", title: "Verify", kind: "verify", description: "Verify",
				dependsOn: ["T-001"], acceptanceCriteria: [], expectedFiles: [],
				deliveryRequirement: "commit",
			},
		],
	});
	plan = transitionPlan(plan, "awaiting-approval");
	if (approved) plan = approvePlan(plan, "tester");
	plan.revision = revision;
	return { plan, projection: projectPlan(plan) };
}

/** @param {number} revision @param {import("@github/copilot-sdk").WorkflowRunStatus} [status] */
export function workflowSnapshot(revision, status = "paused") {
	return {
		...snapshot(1),
		workflows: {
			state: "available", omittedOlder: 1,
			runs: [{
				...nativeDetail(),
				runId: "research-run", workflowName: "deep-research", revision, status,
				createdAt: 1000, completedAt: null, observedAt: revision * 1000,
				canResume: status === "paused", currentPhase: { id: "plan", ordinal: 0 }, liveAgentCount: 0,
				totalSpawnedAgentCount: 1,
				consumed: { activeMs: 61_000, subagents: 1, nanoAiu: 2_500_000_000 },
				approved: { maxAiCredits: 2, maxTotalSubagents: 5, timeoutSeconds: 120 },
				declaredLimits: { maxAiCredits: 2, maxTotalSubagents: 5, timeoutSeconds: 120 },
				terminal: status === "paused"
					? { pauseInfo: { type: /** @type {const} */ ("checkpoint"), key: "research-scope:v1" } } : null,
				actions: [status === "paused" ? "resume" : "pause"],
			}],
		},
	};
}

/** @param {ReturnType<typeof workflowSnapshot>} state @returns {import("@github/copilot-sdk").WorkflowRunDetail} */
export function workflowDetail(state) {
	return {
		...state.workflows.runs[0],
		phases: [{ id: "research", ordinal: 1, lastEnteredRunAttempt: 1, entryCount: 1, title: "Research", status: "active", accumulatedActiveMs: 1000, currentActiveMs: 2000, totalAgentCount: 1, liveAgentCount: 1 }],
		agents: [{
			agentId: "native-agent", toolCallId: "native-call", runId: state.workflows.runs[0].runId, phaseId: "research", label: "Research one", agentType: "research", status: "running",
			requestedModel: "auto", resolvedModel: "resolved-model", activeMs: 3000, activity: "Reading sources",
		}],
		progress: {
			records: [{ seq: 10, attempt: 1, text: "Prepared scope: <unsafe-markup>", kind: "log", recordedAt: 1000, phaseId: null }],
			oldestSeq: 10, newestSeq: 10, hasMoreOlder: true, hasMoreNewer: false, revision: state.workflows.runs[0].revision,
		},
	};
}

/** @param {number} [revision] @param {string[]} [missing]
 * @returns {ReturnType<typeof snapshot> & {factory: Extract<NonNullable<ReturnType<typeof import("../../renderer/contracts.mjs").FoundryWire.snapshot>["factory"]>, {state: "available"}>}} */
export function factorySnapshot(revision = 1, missing = []) {
	return {
		...snapshot(1),
		factory: {
			state: "available", revision, observedAt: new Date(1000 * revision).toISOString(),
			units: [{
				id: "ledger", name: "Ledger", purpose: "Preserve identity", revision: 1, acceptedUnitRevision: 1, currentCandidateId: "incumbent",
				boundary: { owns: ["ledger writes"], exposes: ["debit"], consumes: ["identity foundation"], preserves: ["caller input"] }, dependencies: [], relationshipCoverage: "partial"
			}],
			knowledge: [{
				id: "discovery", revision: 1, authority: "non-governing", kind: "observation", statement: "<script>Not authority</script>", uncertainty: "More data required",
				source: { kind: "audit", ref: "fixture:evidence", actor: "observer", at: "2026-01-01T00:00:00.000Z" }, links: []
			}],
			contracts: [], decisions: [],
			candidates: [{
				id: "fresh", unitId: "ledger", mode: "reconstruction", selection: null, isCurrent: false, contractRevision: 1,
				contractDigest: "a".repeat(64), contextDigest: "b".repeat(64), incumbentId: "incumbent", actor: "producer", createdAt: "2026-01-01T00:00:00.000Z",
				delivery: { commit: "c".repeat(40) }, binding: null, evidence: [],
				context: { generation: [], comparisonOnly: [], independence: { method: "fresh-session", reason: "Separate context claim" } },
				assurance: { ready: missing.length === 0, missing }
			}],
			renewals: [{
				id: "renewal-incident", signalId: "incident", status: "proposed", affectedUnitIds: ["ledger"], uncertainUnitIds: ["reporting"],
				localization: "uncertain", proposal: "Re-evaluate boundary obligations first"
			}],
			signals: [{ id: "incident", summary: "Changed workload", source: { ref: "fixture:incident", actor: "operator", at: "2026-01-01T00:00:00.000Z" } }],
			retirements: [], truncated: {}, synchronization: { owned: true, pending: [] },
		},
	};
}
