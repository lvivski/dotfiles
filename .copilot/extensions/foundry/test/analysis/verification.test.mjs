import assert from "node:assert/strict";
import test from "node:test";
import { analysisInputDigest } from "../../digest.mjs";
import { FoundryAnalysisError } from "../../errors.mjs";
import { assessDeterministicVerification, evaluateVerification, validateVerificationResult } from "../../analysis/verdicts.mjs";
import { buildVerificationInput, normalizeVerificationInput } from "../../analysis/verification.mjs";
import { completedPlan, produceVerification, verificationFixture } from "./fixture.mjs";

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
				missingEvidence: [],
				integrationFindings: [],
				risks: [],
			},
			{
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
		/input digest|canonical Workflow input/,
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
	const integration = input.verificationReport.evidence.at(-2);
	assert.ok(integration);
	integration.outcome = "failed";
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
				missingEvidence: [],
				integrationFindings: [],
				risks: [],
			},
			{
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
					missingEvidence: [],
					integrationFindings: [],
					risks: [],
				},
				{
					missingEvidence: [],
					integrationFindings: [],
					risks: [],
				},
			],
		}, validInput, reservationId),
		/omits verifier evidence/,
	);
});

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

test("code derives evidence while import rejects contradicted or incomplete verifier evidence", async () => {
	for (const failure of ["failed-check", "omitted-check"]) {
		const { input, reviews, verdict } = verificationFixture();
		if (failure === "failed-check") {
			input.verificationReport.evidence[0].outcome = "failed";
			const { inputDigest: _discarded, ...canonical } = input;
			input.inputDigest = analysisInputDigest(canonical);
		}
		verdict.evidenceIds.shift();
		const produced = await produceVerification(input, reviews, verdict);
		assert.equal(produced.passed, failure === "omitted-check");
		assert.equal(validateVerificationResult(produced, input, "shared-evaluator").passed, produced.passed);
		assert.throws(
			() => validateVerificationResult({ ...produced, passed: true, evidenceIds: verdict.evidenceIds }, input, "shared-evaluator"),
			/omits verifier evidence|contradicts canonical checks/,
		);
	}
});

test("Workflow evidence normalization does not weaken strict verification import", async () => {
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
			assert.equal(produced.passed, malformed === "evidence");
			const imported = validateVerificationResult(produced, input, "shared-evaluator");
			assert.equal(imported.passed, produced.passed);
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
