import assert from "node:assert/strict";
import test from "node:test";

import {
    FoundryAnalysisError,
    analysisInputDigest,
    buildPlanningArgs,
    buildVerificationInput,
    normalizePlanningInput,
    normalizeVerificationInput,
    validatePlanBlueprint,
    validatePlanningResult,
    validateVerificationResult,
} from "./analysis.mjs";
import {
    ATTEMPT_STATUS,
    EVIDENCE_TYPE,
    PLAN_STATUS,
    approvePlan,
    attachTaskAttempt,
    completeTaskAttempt,
    createDraftPlan,
	reconcileTaskReadiness,
    reserveTaskAttempt,
    transitionPlan,
} from "./domain.mjs";

function completedPlan() {
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
	plan = reconcileTaskReadiness(plan, { at: "2026-08-05T00:06:00.000Z" });
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

test("planning arguments are bounded and digested canonically", () => {
    const normalized = normalizePlanningInput({
        objective: "Build a reviewed feature",
        repositoryContext: "Node extension with no dependencies",
    });
    assert.equal(normalized.maxTasks, 6);
    assert.deepEqual(normalized.constraints, []);
    const args = buildPlanningArgs(normalized);
    assert.match(args.inputDigest, /^[a-f0-9]{64}$/);
    assert.equal(
        analysisInputDigest({ z: 1, a: 2 }),
        analysisInputDigest({ a: 2, z: 1 }),
    );
    assert.throws(
        () => normalizePlanningInput({
            objective: "Build",
            repositoryContext: "Repo",
            maxTasks: 13,
        }),
        FoundryAnalysisError,
    );
});

test("planning results reuse the strict domain validator and fail closed", () => {
    const input = buildPlanningArgs({
        objective: "Build",
        constraints: [],
        repositoryContext: "Node repo",
        maxTasks: 2,
    });
    const plan = {
        title: "Plan",
        objective: input.objective,
        constraints: [],
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
    };
    const result = {
		kind: "foundry-plan-result",
        inputDigest: input.inputDigest,
        status: "ready",
        plan,
        critiques: [
            { verdict: "accept", risks: [], requiredChanges: [] },
            { verdict: "accept", risks: [], requiredChanges: [] },
        ],
        verification: { passed: true, issues: [] },
        missingPerspectives: [],
        issues: [],
    };
    assert.deepEqual(
        validatePlanningResult(result, input, 2),
        validatePlanBlueprint(plan, 2),
    );
    assert.throws(
        () => validatePlanningResult({
            ...result,
            critiques: [null, result.critiques[1]],
        }, input, 2),
        /two complete critic perspectives/,
    );
    assert.equal(
        validatePlanningResult({
            ...result,
            critiques: [
                {
                    verdict: "revise",
                    risks: ["Initial risk addressed by synthesis"],
                    requiredChanges: ["Clarify the output"],
                },
                result.critiques[1],
            ],
        }, input, 2).tasks.length,
		2,
    );
    assert.throws(
        () => validatePlanningResult({
            ...result,
            plan: { ...plan, objective: "Drifted objective" },
        }, input, 2),
        /canonical objective/,
    );
});

test("verification inputs use stable criterion IDs and exact digests", () => {
    const input = buildVerificationInput(completedPlan());
    assert.deepEqual(
        input.tasks[0].criteria.map((criterion) => criterion.id),
        ["T-001-C001", "T-001-C002"],
    );
    assert.equal(input.tasks[0].evidence[0].id, "T-001-A001-E001");
    assert.deepEqual(normalizeVerificationInput(input), input);
    assert.throws(
        () => normalizeVerificationInput({
            ...input,
            inputDigest: "0".repeat(64),
        }),
        /digest/,
    );
});

test("verification result requires every criterion ID to have evidence", () => {
    const input = buildVerificationInput(completedPlan());
    const reservationId = "verification-reservation";
	const fullCoverage = input.tasks[0].criteria.map((criterion, index) => ({
        criterionId: criterion.id,
		evidenceIds: [input.verificationReport.evidence[index].id],
    }));
    const result = {
		kind: "foundry-verification-result",
		reservationId,
		input,
        inputDigest: input.inputDigest,
        planId: input.planId,
        passed: true,
        summary: "Verified",
		evidenceIds: input.verificationReport.evidence.map((entry) => entry.id),
        missingEvidence: [],
        correctionTaskIds: [],
        reviews: [
            {
                coverage: fullCoverage,
                missingEvidence: [],
                integrationFindings: [],
                risks: [],
            },
            {
                coverage: [],
                missingEvidence: [],
                integrationFindings: [],
                risks: [],
            },
        ],
    };
    assert.equal(validateVerificationResult(result, input, reservationId).passed, true);
	assert.throws(
		() => validateVerificationResult(
			{ ...result, reservationId: "other-reservation" },
			input,
			reservationId,
		),
		/match its run/,
	);
	assert.throws(
		() => validateVerificationResult({
			...result,
			input: {
				...input,
				tasks: input.tasks.map((task) => ({
					...task,
					criteria: task.criteria.map((criterion) => ({
						...criterion,
						text: "weakened criterion",
					})),
				})),
			},
		}, input, reservationId),
		/input digest|canonical Factory input/,
	);
	assert.throws(
		() => validateVerificationResult({
			...result,
			evidenceIds: [],
		}, input, reservationId),
		/omits verifier evidence/,
	);
});

test("failed or omitted evidence IDs cannot satisfy passing verification", () => {
	const input = buildVerificationInput(completedPlan());
	input.verificationReport.evidence[0].outcome = "failed";
	const { inputDigest: _discarded, ...canonical } = input;
	input.inputDigest = analysisInputDigest(canonical);
    const reservationId = "failed-evidence-reservation";
    const result = {
		kind: "foundry-verification-result",
		reservationId,
		input,
        inputDigest: input.inputDigest,
        planId: input.planId,
        passed: true,
        summary: "Incorrectly passed",
		evidenceIds: input.verificationReport.evidence
			.filter((entry) => entry.outcome === "passed")
			.map((entry) => entry.id),
        missingEvidence: [],
        correctionTaskIds: [],
        reviews: [
            {
				coverage: [],
                missingEvidence: [],
                integrationFindings: [],
                risks: [],
            },
            {
                coverage: [],
                missingEvidence: [],
                integrationFindings: [],
                risks: [],
            },
        ],
    };
    assert.throws(
		() => validateVerificationResult(result, input, reservationId),
		/canonical checks/,
    );

    const validInput = buildVerificationInput(completedPlan());
    assert.throws(
        () => validateVerificationResult({
            ...result,
			input: validInput,
            inputDigest: validInput.inputDigest,
            evidenceIds: [],
            reviews: [
                {
					coverage: [],
                    missingEvidence: [],
                    integrationFindings: [],
                    risks: [],
                },
                {
                    coverage: [],
                    missingEvidence: [],
                    integrationFindings: [],
                    risks: [],
                },
            ],
		}, validInput, reservationId),
		/omits verifier evidence/,
    );
});
