import { buildVerificationInput } from "../../analysis/verification.mjs";
import { attachTaskAttempt, completeTaskAttempt, reserveTaskAttempt } from "../../plan/execution.mjs";
import { approvePlan, createDraftPlan, transitionPlan } from "../../plan/lifecycle.mjs";
import { ATTEMPT_STATUS, EVIDENCE_TYPE, PLAN_STATUS } from "../../plan/values.mjs";
import { reserveVerification } from "../../plan/verification.mjs";
import { must } from "../assertions.mjs";

/** @param {import("../../analysis/planning.mjs").PlanningArgs} input */
export function planningResult(input) {
	return {
		kind: "foundry-plan-result",
		inputDigest: input.inputDigest,
		input,
		status: "ready",
		plan: {
			title: "Plan",
			objective: input.objective,
			constraints: input.constraints,
			tasks: [
				{
					id: "T-001",
					title: "Implement",
					kind: "implement",
					description: "Implement",
					dependsOn: [],
					acceptanceCriteria: ["Tests pass"],
					expectedFiles: ["src/change.mjs"],
					deliveryRequirement: "commit",
				},
				{
					id: "T-002",
					title: "Verify",
					kind: "verify",
					description: "Verify the final delivery",
					dependsOn: ["T-001"],
					acceptanceCriteria: [],
					expectedFiles: [],
					deliveryRequirement: "commit",
				},
			],
		},
		critiques: [
			{ verdict: "accept", risks: [], requiredChanges: [] },
			{ verdict: "accept", risks: [], requiredChanges: [] },
		],
		verification: { passed: true, issues: [] },
		missingPerspectives: [],
		issues: [],
	};
}

export function completedPlan() {
	let plan = createDraftPlan({
		id: "workflow-plan",
		title: "Workflow plan",
		objective: "Validate native Workflow integration",
		constraints: [],
		repository: { workingDirectory: "/tmp/workflow-plan", baseBranch: "main" },
		tasks: [
			{
				id: "T-001",
				title: "Implement",
				kind: "implement",
				description: "Implement",
				dependsOn: [],
				acceptanceCriteria: ["Tests pass"],
				expectedFiles: ["src/change.mjs"],
				deliveryRequirement: "commit",
			},
			{
				id: "T-002",
				title: "Verify",
				kind: "verify",
				description: "Verify",
				dependsOn: ["T-001"],
				acceptanceCriteria: [],
				expectedFiles: [],
				deliveryRequirement: "commit",
			},
		],
	}, { now: "2026-08-07T00:00:00.000Z" });
	plan = transitionPlan(plan, PLAN_STATUS.AWAITING_APPROVAL, {
		at: "2026-08-07T00:01:00.000Z",
	});
	plan = approvePlan(plan, "tester", { at: "2026-08-07T00:02:00.000Z" });
	plan = reserveTaskAttempt(plan, "T-001", {
		reservationId: "workflow-reservation",
		at: "2026-08-07T00:03:00.000Z",
	});
	plan = attachTaskAttempt(plan, "T-001", "T-001-A001", {
		sessionId: "session-1",
		branch: "work/workflow",
		at: "2026-08-07T00:04:00.000Z",
	});
	plan = completeTaskAttempt(plan, "T-001", "T-001-A001", ATTEMPT_STATUS.DONE, {
		resultSummary: "Implemented",
		evidence: [{
			type: EVIDENCE_TYPE.TEST,
			summary: "Tests pass",
			source: "node --test",
			outcome: "passed",
		}],
		branch: "work/workflow",
		commit: "a".repeat(40),
		at: "2026-08-07T00:05:00.000Z",
	});
	plan = reserveTaskAttempt(plan, "T-002", {
		reservationId: "workflow-verifier",
		at: "2026-08-07T00:07:00.000Z",
	});
	plan = attachTaskAttempt(plan, "T-002", "T-002-A001", {
		sessionId: "session-2",
		branch: "work/workflow-verifier",
		at: "2026-08-07T00:08:00.000Z",
	});
	return completeTaskAttempt(plan, "T-002", "T-002-A001", ATTEMPT_STATUS.DONE, {
		resultSummary: "Independent report",
		evidence: [
			{
				checkId: "T-001-C001",
				type: EVIDENCE_TYPE.TEST,
				summary: "Tests pass",
				source: "node --test",
				outcome: "passed",
			},
			{
				checkId: "final-integration",
				type: EVIDENCE_TYPE.INTEGRATION,
				summary: "Integration passes",
				source: "node --test",
				outcome: "passed",
			},
			{
				checkId: "workspace-integrity",
				type: EVIDENCE_TYPE.COMMAND,
				summary: "Workspace is clean",
				source: "git status --porcelain",
				outcome: "passed",
			},
		],
		branch: "work/workflow-verifier",
		commit: "a".repeat(40),
		at: "2026-08-07T00:09:00.000Z",
	});
}

export function reservedPlan(reservationId = "verification-reservation") {
	const plan = completedPlan();
	const input = buildVerificationInput(plan);
	const reserved = reserveVerification(plan, {
		reservationId,
		inputDigest: input.inputDigest,
		at: "2026-08-07T00:06:00.000Z",
	});
	return {
		...reserved,
		verification: {
			...reserved.verification,
			reservationId: must(reserved.verification.reservationId),
			reservedAt: must(reserved.verification.reservedAt),
			inputDigest: must(reserved.verification.inputDigest),
		},
	};
}
