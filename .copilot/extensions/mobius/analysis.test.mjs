import assert from "node:assert/strict";
import test from "node:test";

import {
    MobiusAnalysisError,
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
        tasks: [{
            id: "T-001",
            title: "Implement",
            description: "Implement the change",
            dependsOn: [],
            acceptanceCriteria: ["Tests pass", "Output is documented"],
            expectedFiles: ["src/change.mjs"],
        }],
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
    return completeTaskAttempt(plan, "T-001", "T-001-A001", ATTEMPT_STATUS.DONE, {
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
        MobiusAnalysisError,
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
        tasks: [{
            id: "T-001",
            title: "Implement",
            kind: "implement",
            description: "Implement",
            dependsOn: [],
            acceptanceCriteria: ["Tests pass"],
            expectedFiles: ["src/change.mjs"],
        }],
    };
    const result = {
		kind: "mobius-plan-result",
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
        1,
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
    const fullCoverage = input.tasks[0].criteria.map((criterion) => ({
        criterionId: criterion.id,
        evidenceIds: ["T-001-A001-E001"],
    }));
    const result = {
		kind: "mobius-verification-result",
		input,
        inputDigest: input.inputDigest,
        planId: input.planId,
        passed: true,
        summary: "Verified",
        evidenceIds: ["T-001-A001-E001"],
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
    assert.equal(validateVerificationResult(result, input).passed, true);
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
		}, input),
		/input digest|canonical Factory input/,
	);
    assert.throws(
        () => validateVerificationResult({
            ...result,
            reviews: [
                {
                    coverage: fullCoverage.slice(0, 1),
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
        }, input),
        /coverage/,
    );
});

test("failed or omitted evidence IDs cannot satisfy passing verification", () => {
    const failedEvidencePlan = completedPlan();
    failedEvidencePlan.tasks[0].attempts[0].evidence[0].outcome = "failed";
    const input = buildVerificationInput(failedEvidencePlan);
    const coverage = input.tasks[0].criteria.map((criterion) => ({
        criterionId: criterion.id,
        evidenceIds: ["T-001-A001-E001"],
    }));
    const result = {
		kind: "mobius-verification-result",
		input,
        inputDigest: input.inputDigest,
        planId: input.planId,
        passed: true,
        summary: "Incorrectly passed",
        evidenceIds: ["T-001-A001-E001"],
        missingEvidence: [],
        correctionTaskIds: [],
        reviews: [
            {
                coverage,
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
        () => validateVerificationResult(result, input),
        /unknown evidence|coverage/,
    );

    const validInput = buildVerificationInput(completedPlan());
    const validCoverage = validInput.tasks[0].criteria.map((criterion) => ({
        criterionId: criterion.id,
        evidenceIds: ["T-001-A001-E001"],
    }));
    assert.throws(
        () => validateVerificationResult({
            ...result,
			input: validInput,
            inputDigest: validInput.inputDigest,
            evidenceIds: [],
            reviews: [
                {
                    coverage: validCoverage,
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
        }, validInput),
        /omits evidence|coverage/,
    );
});
