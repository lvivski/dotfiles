import assert from "node:assert/strict";
import { buildVerificationInput } from "../../analysis/verification.mjs";
import { verificationMarker } from "../../marker.mjs";
import { attachTaskAttempt, completeTaskAttempt, reserveTaskAttempt } from "../../plan/execution.mjs";
import { approvePlan, createDraftPlan, transitionPlan } from "../../plan/lifecycle.mjs";
import { reserveVerification } from "../../plan/verification.mjs";
import { createWorkflowAnalysis } from "../../workflow.mjs";
import { must } from "../assertions.mjs";

export function verificationFixture() {
	const at = "2026-11-08T07:00:00.000Z";
	let plan = createDraftPlan({
		id: "native-verification", title: "Native verification", objective: "Verify canonical native ownership",
		repository: { workingDirectory: "/tmp/native-verification", baseBranch: "main" },
		tasks: [
			{
				id: "T-001", title: "Implement", kind: "implement", description: "Implement",
				dependsOn: [], acceptanceCriteria: ["Works"], expectedFiles: ["src/**"], deliveryRequirement: "commit"
			},
			{
				id: "T-002", title: "Verify", kind: "verify", description: "Verify",
				dependsOn: ["T-001"], acceptanceCriteria: [], expectedFiles: [], deliveryRequirement: "commit"
			},
		],
	}, { now: at });
	plan = approvePlan(transitionPlan(plan, "awaiting-approval", { at }), "tester", { at });
	for (const task of plan.tasks) {
		plan = reserveTaskAttempt(plan, task.id, { reservationId: `reservation-${task.id}`, at });
		plan = attachTaskAttempt(plan, task.id, `${task.id}-A001`, {
			sessionId: `session-${task.id}`, branch: `work/${task.id}`, at,
		});
		plan = completeTaskAttempt(plan, task.id, `${task.id}-A001`, "done", {
			resultSummary: "Done", branch: `work/${task.id}`, commit: "a".repeat(40), at,
			evidence: (task.kind === "verify" ? [
				{ checkId: "T-001-C001", type: "test" },
				{ checkId: "final-integration", type: "integration" },
				{ checkId: "workspace-integrity", type: "command" },
			] : [{ type: "test" }])
				.map((check) => ({
					...check, summary: "Passed", source: "node --test", outcome: "passed",
				})),
		});
	}
	const input = buildVerificationInput(plan);
	plan = reserveVerification(plan, { reservationId: "native-reservation", inputDigest: input.inputDigest, at });
	const boundPlan = {
		...plan, verification: {
			...plan.verification,
			reservationId: must(plan.verification.reservationId),
			reservedAt: must(plan.verification.reservedAt),
		}
	};
	const result = {
		kind: "foundry-verification-result", reservationId: plan.verification.reservationId,
		input, inputDigest: input.inputDigest, planId: plan.id, passed: true, summary: "Passed",
		evidenceIds: input.verificationReport.evidence.map(({ id }) => id), missingEvidence: [], correctionTaskIds: [],
		reviews: [
			{
				coverage: [{ criterionId: "T-001-C001", evidenceIds: [input.verificationReport.evidence[0].id] }],
				missingEvidence: [], integrationFindings: [], risks: []
			},
			{ coverage: [], missingEvidence: [], integrationFindings: [], risks: [] },
		],
	};
	const run = { runId: "native-verify", status: "completed", result };
	const detail = {
		runId: run.runId, workflowName: "verify", status: run.status, createdAt: Date.parse(at), revision: 1,
		progress: {
			records: [{ kind: "log", text: verificationMarker(boundPlan.verification.reservationId), seq: 10 }],
			oldestSeq: 10, newestSeq: 10, hasMoreOlder: false, hasMoreNewer: false, revision: 1,
		},
	};
	const api = {
		/** @returns {Promise<{runId: string, status: string, result?: unknown}>} */
		getRun: async () => run,
		getRunDetail: async (/** @type {string} */ _runId) => detail,
		getRunProgress: async () => assert.fail("Canonical completed results do not page corroborating progress"),
		listRuns: async () => ({ runs: [detail], omittedOlder: 0, hasMoreNewer: false }),
		waitForRun: async () => assert.fail("Completed results do not wait"),
	};
	return { plan: boundPlan, run, detail, api, analysis: createWorkflowAnalysis(() => api) };
}
