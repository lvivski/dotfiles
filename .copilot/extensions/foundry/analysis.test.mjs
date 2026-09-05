import assert from "node:assert/strict";
import test from "node:test";

import {
    FoundryAnalysisError,
	assessDeterministicVerification,
    analysisInputDigest,
    buildPlanningArgs,
    buildVerificationInput,
	evaluateVerification,
    normalizePlanningInput,
    normalizeVerificationInput,
    validatePlanBlueprint,
	validatePlanningArgs,
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
import { run as runPlanning } from "./factories/plan.mjs";
import { run as runVerification } from "./factories/verify.mjs";

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

test("the planning Factory uses canonical defaults and rejects invalid args before agent work", async () => {
	const minimal = { objective: "Build", repositoryContext: "Node repo" };
	const canonical = buildPlanningArgs(minimal);
	const minimalArgs = { ...minimal, inputDigest: canonical.inputDigest };
	assert.deepEqual(validatePlanningArgs(minimalArgs), canonical);

	let agentCalls = 0;
	const execute = (args) => runPlanning({
		args,
		phase() {},
		async agent() {
			agentCalls += 1;
			return null;
		},
	});
	for (const invalid of [
		{ ...minimalArgs, inputDigest: "0".repeat(64) },
		{ ...minimalArgs, inputDigest: undefined },
		{ ...canonical, objective: "x".repeat(8001) },
		{ ...canonical, constraints: Array(33).fill("constraint") },
		{ ...canonical, constraints: ["x".repeat(1001)] },
		{ ...canonical, repositoryContext: "x".repeat(16001) },
		{ ...canonical, maxTasks: 0 },
		{ ...canonical, maxTasks: 13 },
	]) {
		await assert.rejects(execute(invalid), FoundryAnalysisError);
	}
	assert.equal(agentCalls, 0);
	const result = await execute(minimalArgs);
	assert.deepEqual(result.input, canonical);
	assert.equal(agentCalls, 1);
	for (const maxTasks of [1, 12]) {
		const args = buildPlanningArgs({ ...minimal, maxTasks });
		assert.deepEqual((await execute(args)).input, args);
	}
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
	assert.throws(
		() => validatePlanBlueprint({
			...plan,
			tasks: plan.tasks.map((task) => {
				if (task.id !== "T-001") return task;
				const { deliveryRequirement: _discarded, ...withoutDelivery } = task;
				return withoutDelivery;
			}),
		}, 2),
		/deliveryRequirement/,
	);
	assert.throws(
		() => validatePlanBlueprint({
			...plan,
			tasks: plan.tasks.map((task) => task.id === "T-001"
				? { ...task, dependsOn: ["T-002"] }
				: task),
		}, 2),
		/[Cc]ycle/,
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

test("deterministic verification gaps preserve stable order and attribution", () => {
	const input = buildVerificationInput(completedPlan());
	input.verificationReport.evidence[0].outcome = "failed";
	input.verificationReport.evidence.at(-2).outcome = "failed";
	input.verificationReport.observedCommit = "0".repeat(40);

	assert.deepEqual(assessDeterministicVerification(input), {
		hardPassed: false,
		hardGaps: [
			{
				summary: "Independent check failed for T-001-C001",
				taskIds: ["T-001"],
			},
			{
				summary: "Verifier observed a different target commit",
				taskIds: ["T-001"],
			},
			{
				summary: "Independent check failed for final-integration",
				taskIds: ["T-001"],
			},
		],
		correctionTaskIds: ["T-001"],
		requiredEvidenceIds: input.verificationReport.evidence
			.filter((entry) => entry.outcome === "passed")
			.map((entry) => entry.id),
	});
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

function verificationFixture() {
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
	 * coverage: object[], missingEvidence: Array<{summary: string, taskIds: string[]}>,
	 * integrationFindings: Array<{summary: string, taskIds: string[], evidenceIds: string[]}>,
	 * risks: string[]
	 * }>} */
	const reviews = Array.from({ length: 2 }, () => ({
		coverage: [], missingEvidence: [], integrationFindings: [], risks: [],
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

async function produceVerification(input, reviews, verdict) {
	const responses = [...reviews, verdict];
	return runVerification({
		args: { ...input, reservationId: "shared-evaluator" },
		log() {},
		phase() {},
		parallel: (tasks) => Promise.all(tasks.map((task) => task())),
		agent: async () => responses.shift(),
	});
}

test("verification production and import share gap aggregation without losing attribution", async () => {
	const { input, reviews, verdict } = verificationFixture();
	const summary = "Integration needs correction";
	reviews[0].missingEvidence.push({ summary, taskIds: ["T-001"] });
	reviews[1].integrationFindings.push({
		summary,
		taskIds: ["T-003"],
		evidenceIds: [input.verificationReport.evidence[0].id],
	});
	verdict.passed = false;
	verdict.missingEvidence.push({ summary, taskIds: ["T-001"] });
	const evaluated = evaluateVerification(input, { ...verdict, reviews });
	assert.deepEqual(evaluated.gaps, [{ summary, taskIds: ["T-001", "T-003"] }]);
	assert.deepEqual(evaluated.outcome.correctionTaskIds, ["T-001", "T-003"]);
	const produced = await produceVerification(input, reviews, verdict);
	assert.deepEqual(produced.missingEvidence, evaluated.gaps);
	assert.deepEqual(
		validateVerificationResult(produced, input, "shared-evaluator"),
		evaluated.outcome,
	);
});

test("shared verification keeps conservative correction attribution", async () => {
	for (const gap of [
		{ summary: "Unattributed", taskIds: [] },
		{ summary: "Unknown task", taskIds: ["T-999"] },
		{ summary: "Unknown integration evidence", taskIds: ["T-001"], evidenceIds: ["unknown"] },
	]) {
		const { input, reviews, verdict } = verificationFixture();
		verdict.passed = false;
		if (gap.evidenceIds) reviews[0].integrationFindings.push({ ...gap, evidenceIds: gap.evidenceIds });
		else reviews[0].missingEvidence.push(gap);
		const produced = await produceVerification(input, reviews, verdict);
		const imported = validateVerificationResult(produced, input, "shared-evaluator");
		assert.deepEqual(imported.correctionTaskIds, ["T-001", "T-003"]);
		assert.deepEqual(imported.missingEvidence, [gap.summary]);
	}
	const { input, reviews, verdict } = verificationFixture();
	const unknownCorrection = evaluateVerification(input, {
		...verdict, passed: false, reviews, correctionTaskIds: ["T-999"],
	});
	assert.deepEqual(unknownCorrection.outcome.correctionTaskIds, ["T-001", "T-003"]);
	assert.deepEqual(unknownCorrection.outcome.missingEvidence, [
		"Verification failed without an attributed evidence gap",
	]);
});

test("the shared evaluator cannot promote contradicted or incomplete verifier evidence", async () => {
	for (const failure of ["failed-check", "omitted-check"]) {
		const { input, reviews, verdict } = verificationFixture();
		if (failure === "failed-check") {
			input.verificationReport.evidence[0].outcome = "failed";
			const { inputDigest: _discarded, ...canonical } = input;
			input.inputDigest = analysisInputDigest(canonical);
		}
		verdict.evidenceIds.shift();
		const produced = await produceVerification(input, reviews, verdict);
		assert.equal(produced.passed, false);
		assert.equal(validateVerificationResult(produced, input, "shared-evaluator").passed, false);
		assert.throws(
			() => validateVerificationResult({ ...produced, passed: true }, input, "shared-evaluator"),
			/omits verifier evidence|contradicts canonical checks/,
		);
	}
});

test("Factory evidence normalization does not weaken strict verification import", async () => {
	for (const malformed of ["reviewer", "evidence", "failed-evidence", "gap-limit"]) {
		const { input, reviews, verdict } = verificationFixture();
		const rawReviews = malformed === "reviewer" ? [null, reviews[1]] : reviews;
		if (malformed === "evidence") verdict.evidenceIds = ["unknown"];
		else if (malformed === "failed-evidence") {
			input.verificationReport.evidence[0].outcome = "failed";
			const { inputDigest: _discarded, ...canonical } = input;
			input.inputDigest = analysisInputDigest(canonical);
		} else if (malformed === "gap-limit") {
			verdict.missingEvidence = Array.from({ length: 129 }, (_, index) => ({
				summary: `Gap ${index}`, taskIds: ["T-001"],
			}));
		}
		if (malformed === "reviewer") {
			const produced = await produceVerification(input, rawReviews, verdict);
			assert.equal(produced.passed, false);
			assert.equal(produced.reviews[0], null);
			assert.throws(
				() => validateVerificationResult(produced, input, "shared-evaluator"),
				/Verification reviewer 1 is invalid/,
			);
		} else if (malformed === "gap-limit") {
			await assert.rejects(produceVerification(input, rawReviews, verdict), FoundryAnalysisError);
		} else {
			const produced = await produceVerification(input, rawReviews, verdict);
			assert.equal(produced.passed, false);
			const imported = validateVerificationResult(produced, input, "shared-evaluator");
			assert.equal(imported.passed, false);
			assert.ok(imported.evidence.every((id) => input.verificationReport.evidence
				.some((entry) => entry.id === id && entry.outcome === "passed")));
		}
		assert.throws(() => validateVerificationResult({
			kind: "foundry-verification-result",
			reservationId: "shared-evaluator",
			input,
			inputDigest: input.inputDigest,
			planId: input.planId,
			...verdict,
			reviews: rawReviews,
		}, input, "shared-evaluator"), FoundryAnalysisError);
	}
});

test("verification aggregation stays bounded and retains missing-verdict failure", async () => {
	const { input, reviews, verdict } = verificationFixture();
	verdict.passed = false;
	verdict.missingEvidence = Array.from({ length: 128 }, (_, index) => ({
		summary: `Gap ${index}`, taskIds: ["T-001"],
	}));
	reviews[0].missingEvidence.push({ summary: "Reviewer gap", taskIds: ["T-003"] });
	const produced = await produceVerification(input, reviews, verdict);
	const imported = validateVerificationResult(produced, input, "shared-evaluator");
	assert.equal(produced.missingEvidence.length, 128);
	assert.equal(imported.missingEvidence.length, 128);
	assert.deepEqual(imported.correctionTaskIds, ["T-001", "T-003"]);

	const missingVerdict = await produceVerification(input, reviews, null);
	assert.equal(missingVerdict.passed, false);
	assert.deepEqual(
		validateVerificationResult(missingVerdict, input, "shared-evaluator").correctionTaskIds,
		["T-001", "T-003"],
	);
});
