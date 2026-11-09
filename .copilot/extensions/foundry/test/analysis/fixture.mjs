import { analysisInputDigest } from "../../digest.mjs";
import { buildVerificationInput, normalizeVerificationInput } from "../../analysis/verification.mjs";
import { attachTaskAttempt, completeTaskAttempt, reserveTaskAttempt } from "../../plan/execution.mjs";
import { approvePlan, createDraftPlan, transitionPlan } from "../../plan/lifecycle.mjs";
import { ATTEMPT_STATUS, EVIDENCE_TYPE, PLAN_STATUS } from "../../plan/values.mjs";
import { run as runVerification } from "../../workflows/verify.mjs";

export function completedPlan() {
	let plan = createDraftPlan({
		id: "analysis-plan",
		title: "Analysis plan",
		objective: "Verify canonical analysis inputs",
		constraints: [],
		repository: {
			workingDirectory: "/tmp/analysis-plan",
			baseBranch: "main",
		},
		tasks: [
			{
				id: "T-001",
				title: "Implement",
				kind: "implement",
				description: "Implement the change",
				dependsOn: [],
				acceptanceCriteria: ["Tests pass", "Output is documented"],
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
	}, { now: "2026-08-05T00:00:00.000Z" });
	plan = transitionPlan(plan, PLAN_STATUS.AWAITING_APPROVAL, {
		at: "2026-08-05T00:01:00.000Z",
	});
	plan = approvePlan(plan, "tester", { at: "2026-08-05T00:02:00.000Z" });
	plan = reserveTaskAttempt(plan, "T-001", {
		reservationId: "analysis-reservation",
		at: "2026-08-05T00:03:00.000Z",
	});
	plan = attachTaskAttempt(plan, "T-001", "T-001-A001", {
		sessionId: "session-1",
		branch: "work/analysis",
		at: "2026-08-05T00:04:00.000Z",
	});
	plan = completeTaskAttempt(plan, "T-001", "T-001-A001", ATTEMPT_STATUS.DONE, {
		resultSummary: "Implemented",
		evidence: [{
			type: EVIDENCE_TYPE.TEST,
			summary: "node --test passed",
			source: "node --test",
			outcome: "passed",
		}],
		branch: "work/analysis",
		commit: "a".repeat(40),
		at: "2026-08-05T00:05:00.000Z",
	});
	plan = reserveTaskAttempt(plan, "T-002", {
		reservationId: "analysis-verifier",
		at: "2026-08-05T00:07:00.000Z",
	});
	plan = attachTaskAttempt(plan, "T-002", "T-002-A001", {
		sessionId: "session-2",
		branch: "work/analysis-verifier",
		at: "2026-08-05T00:08:00.000Z",
	});
	return completeTaskAttempt(plan, "T-002", "T-002-A001", ATTEMPT_STATUS.DONE, {
		resultSummary: "Independent report complete",
		evidence: [
			{
				checkId: "T-001-C001",
				type: EVIDENCE_TYPE.TEST,
				summary: "Tests pass",
				source: "node --test",
				outcome: "passed",
			},
			{
				checkId: "T-001-C002",
				type: EVIDENCE_TYPE.MANUAL,
				summary: "Documentation is present",
				source: "README.md",
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
		branch: "work/analysis-verifier",
		commit: "a".repeat(40),
		at: "2026-08-05T00:09:00.000Z",
	});
}

export function verificationFixture() {
	const input = buildVerificationInput(completedPlan());
	const first = input.tasks[0];
	input.tasks.push({
		...structuredClone(first),
		id: "T-003",
		attemptId: "T-003-A001",
		criteria: [{ id: "T-003-C001", text: "Other task is covered" }],
		evidence: first.evidence.map((entry) => ({
			...entry,
			id: entry.id.replace("T-001", "T-003"),
			attemptId: "T-003-A001",
			producer: "session-3",
		})),
	});
	const report = input.verificationReport;
	report.evidence.splice(2, 0, { ...report.evidence[0], checkId: "T-003-C001" });
	report.evidence.forEach((entry, index) => {
		entry.id = `${report.attemptId}-E${String(index + 1).padStart(3, "0")}`;
	});
	const { inputDigest: _discarded, ...canonical } = input;
	input.inputDigest = analysisInputDigest(canonical);
	normalizeVerificationInput(input);
	/** @type {Array<{
	 * missingEvidence: Array<{summary: string, taskIds: string[]}>,
	 * integrationFindings: Array<{summary: string, taskIds: string[], evidenceIds: string[]}>,
	 * risks: string[]
	 * }>} */
	const reviews = Array.from({ length: 2 }, () => ({
		missingEvidence: [], integrationFindings: [], risks: [],
	}));
	/** @type {{
	 * passed: boolean, summary: string, evidenceIds: string[],
	 * missingEvidence: Array<{summary: string, taskIds: string[]}>, correctionTaskIds: string[]
	 * }} */
	const verdict = {
		passed: true,
		summary: "Verification complete",
		evidenceIds: report.evidence.map((entry) => entry.id),
		missingEvidence: [],
		correctionTaskIds: [],
	};
	return { input, reviews, verdict };
}

/** @param {import("../../types/analysis.js").VerificationInput} input
 * @param {Array<ReturnType<typeof verificationFixture>["reviews"][number] | null>} reviews
 * @param {ReturnType<typeof verificationFixture>["verdict"] | null} verdict */
export async function produceVerification(input, reviews, verdict) {
	const responses = [...reviews, verdict];
	return runVerification({
		args: { ...input, reservationId: "shared-evaluator" },
		log() { },
		phase() { },
		parallel: (tasks) => Promise.all(tasks.map((task) => task())),
		agent: async () => responses.shift(),
	});
}
