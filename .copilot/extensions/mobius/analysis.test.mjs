import assert from "node:assert/strict";
import test from "node:test";

import {
    MobiusAnalysisError,
    analysisInputDigest,
    buildPlanningArgs,
    buildVerificationInput,
    canonicalEvidenceDigest,
    canonicalEvidenceStringify,
    normalizePlanningInput,
    normalizeVerificationInput,
    stableStringify,
    validateCanonicalEvidenceValue,
    validatePlanBlueprint,
    validatePlanningResult,
    validateVerificationResult,
} from "./analysis.mjs";
import {
    PLAN_STATUS,
    TASK_STATUS,
    approvePlan,
    createDraftPlan,
    transitionPlan,
    transitionTask,
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
    plan = transitionPlan(plan, PLAN_STATUS.RUNNING, {
        at: "2026-08-05T00:03:00.000Z",
    });
    plan = transitionTask(plan, "T-001", TASK_STATUS.RUNNING, {
        sessionId: "session-1",
        at: "2026-08-05T00:04:00.000Z",
    });
    return transitionTask(plan, "T-001", TASK_STATUS.DONE, {
        resultSummary: "Implemented",
        evidence: ["node --test passed"],
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

test("canonical evidence values accept JSON data and reject lossy or cyclic values", () => {
    const nullPrototype = Object.create(null);
    nullPrototype.answer = 42;
    for (const value of [
        null,
        true,
        false,
        "text",
        0,
        -1.25,
        [null, true, "text", 3],
        { nested: { ok: true } },
        nullPrototype,
    ]) {
        assert.equal(validateCanonicalEvidenceValue(value), value);
    }

    const cycle = {};
    cycle.self = cycle;
    for (const value of [
        undefined,
        1n,
        new Date("2026-08-05T00:00:00.000Z"),
        new Map(),
        Number.NaN,
        Number.POSITIVE_INFINITY,
        () => {},
        Symbol("evidence"),
        { missing: undefined },
        cycle,
    ]) {
        assert.throws(
            () => validateCanonicalEvidenceValue(value),
            (error) => error.code === "invalid_evidence",
        );
    }
});

test("canonical evidence strings pin key ordering, UTF-8 bytes, and digest", () => {
    const value = {
        z: [3, { b: false, a: null }],
        a: "é",
    };
    const canonical = "{\"a\":\"é\",\"z\":[3,{\"a\":null,\"b\":false}]}";
    assert.equal(canonicalEvidenceStringify(value), canonical);
    assert.equal(
        Buffer.from(canonical, "utf8").toString("hex"),
        "7b2261223a22c3a9222c227a223a5b332c7b2261223a6e756c6c2c2262223a66616c73657d5d7d",
    );
    assert.equal(
        canonicalEvidenceDigest(value),
        "de7f2d136d2317b1ef5e7aa2f1b9dc86567d436fd7571bf94b35aa2446fadcaa",
    );

    assert.equal(stableStringify(undefined), "null");
    assert.equal(stableStringify(new Date("2026-08-05T00:00:00.000Z")), "{}");
    assert.equal(stableStringify(["second", "first"]), "[\"second\",\"first\"]");
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
        kind: "mobius-plan-result-v1",
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
        evidence: "node --test passed",
    }));
    const result = {
        kind: "mobius-verification-result-v1",
        inputDigest: input.inputDigest,
        planId: input.planId,
        passed: true,
        summary: "Verified",
        evidence: ["node --test passed"],
        missingEvidence: [],
        reviews: [
            { coverage: fullCoverage, missingEvidence: [], risks: [] },
            { coverage: [], missingEvidence: [], risks: [] },
        ],
    };
    assert.equal(validateVerificationResult(result, input).passed, true);
    assert.throws(
        () => validateVerificationResult({
            ...result,
            reviews: [
                { coverage: fullCoverage.slice(0, 1), missingEvidence: [], risks: [] },
                { coverage: [], missingEvidence: [], risks: [] },
            ],
        }, input),
        /coverage/,
    );
});
