import assert from "node:assert/strict";
import test from "node:test";
import { analysisInputDigest } from "../../digest.mjs";
import { FoundryAnalysisError } from "../../errors.mjs";
import { assessDeterministicVerification, evaluateVerification, validateVerificationResult } from "../../analysis/verdicts.mjs";
import { buildVerificationInput, normalizeVerificationInput } from "../../analysis/verification.mjs";
import { evaluationCriterion } from "../../bridge/pinning.mjs";
import { VISUAL_AXES } from "../../factory/visual.mjs";
import { completedPlan, produceVerification, verificationFixture } from "./fixture.mjs";

/** @param {import("../../types/analysis.js").VerificationInput} input */
function redigest(input) {
	const { inputDigest: _discarded, ...canonical } = input;
	input.inputDigest = analysisInputDigest(canonical);
	return input;
}

/** @param {import("../../types/analysis.js").VerificationInput} input */
function reindexReport(input) {
	const report = input.verificationReport;
	const previous = new Map(report.evidence.map((entry) => [entry.checkId, entry]));
	const criteria = input.evaluationTarget
		? input.evaluationTarget.criteria.map((_entry, index) => `${report.taskId}-C${String(index + 1).padStart(3, "0")}`)
		: input.tasks.flatMap((task) => task.criteria.map((criterion) => criterion.id));
	report.evidence = [...criteria, "final-integration", "workspace-integrity"].map((checkId, index) => ({
		...(previous.get(checkId) ?? report.evidence[0]),
		id: `${report.attemptId}-E${String(index + 1).padStart(3, "0")}`,
		checkId,
	}));
	return redigest(input);
}

function pinnedVerificationFixture() {
	const fixture = verificationFixture();
	const { input } = fixture;
	const final = input.tasks[1];
	final.delivery = {
		...final.delivery, branch: "work/combined", commit: "b".repeat(40),
		integrationRequired: [{
			taskId: input.tasks[0].id, attemptId: input.tasks[0].attemptId,
			branch: input.tasks[0].delivery.branch, commit: input.tasks[0].delivery.commit, prUrl: input.tasks[0].delivery.prUrl,
		}],
	};
	input.verificationReport.target = {
		taskId: final.id, attemptId: final.attemptId, branch: final.delivery.branch, commit: final.delivery.commit, prUrl: final.delivery.prUrl,
	};
	input.verificationReport.observedCommit = final.delivery.commit;
	/** @type {NonNullable<import("../../types/analysis.js").VerificationFactory["context"]>} */
	const context = {
		version: 1,
		definitions: {
			unit: {
				id: "combined", revision: 1, name: "Combined fixture", purpose: "Verify the combined delivery",
				boundary: { owns: ["combined result"], exposes: ["result"], consumes: [], preserves: ["accepted behavior"] }, dependencies: [],
			},
			obligations: [{ id: "behavior", revision: 1, kind: "obligation", unitId: "combined", authority: "accepted", statement: "Preserve behavior" }],
			evaluations: [{
				id: "oracle", revision: 1, kind: "evaluation", unitId: "combined", authority: "accepted", statement: "Check combined behavior",
				evaluation: {
					modality: "boundary", procedure: { kind: "command", ref: "node evaluator.mjs", digest: "c".repeat(64) },
					obligations: [{ id: "behavior", revision: 1 }], environment: "fixture-node", workload: "combined-workload",
					independent: true, preservation: true, maxAgeSeconds: 86400,
				},
			}],
			rationale: [],
			contract: {
				digest: "d".repeat(64), unitId: "combined", revision: 1, unitRevision: 1,
				obligations: [{ id: "behavior", revision: 1 }], evaluations: [{ id: "oracle", revision: 1 }],
			},
		},
		humanEvidence: [],
	};
	/** @type {import("../../types/analysis.js").VerificationFactory} */
	const factory = {
		binding: {
			repositoryId: "e".repeat(64), unitId: "combined", unitRevision: 1, candidateId: "candidate",
			contractRevision: 1, contractDigest: "d".repeat(64), contextDigest: "f".repeat(64),
			blueprintDigest: "1".repeat(64), owner: "fixture-owner",
		},
		context,
		evaluations: [{
			evaluation: { id: "oracle", revision: 1 }, procedureDigest: "c".repeat(64), environment: "fixture-node", workload: "combined-workload",
			outcome: "passed", report: "Historical plain-text report remains supported", independenceReason: "Separate verifier session",
		}],
	};
	input.factory = factory;
	final.criteria[0].text = evaluationCriterion({ ...context.definitions.evaluations[0], uncertainty: null, links: [] });
	return { ...fixture, factory, context, input: redigest(input) };
}

test("canonical input rejects duplicate tasks and conflicting or reused producers", () => {
	for (const change of ["duplicate-task", "conflicting-producer", "reused-producer", "first-verifier", "last-verifier"]) {
		const { input } = verificationFixture();
		if (change === "duplicate-task") input.tasks.push(structuredClone(input.tasks[0]));
		else if (change === "conflicting-producer") input.tasks[0].evidence.push({
			...input.tasks[0].evidence[0], id: "T-001-A001-E002", producer: "conflicting-session",
		});
		else if (change === "reused-producer") input.tasks[1].evidence[0].producer = input.tasks[0].evidence[0].producer;
		else {
			input.verificationReport.sessionId = input.tasks[change === "first-verifier" ? 0 : 1].evidence[0].producer;
			input.verificationReport.evidence.forEach((entry) => { entry.producer = input.verificationReport.sessionId; });
		}
		assert.throws(() => normalizeVerificationInput(redigest(input)), { code: "invalid_analysis_input" }, change);
	}
	const { input } = verificationFixture();
	const original = structuredClone(input);
	input.tasks.reverse();
	assert.deepEqual(normalizeVerificationInput(input), original);
});

test("verification input owns its delivery snapshots and binds integration to exact producer attempts", () => {
	const plan = completedPlan();
	const built = buildVerificationInput(plan);
	built.tasks[0].delivery.integrationRequired.push({
		taskId: "T-099", attemptId: "T-099-A001", branch: "other", commit: "9".repeat(40), prUrl: null,
	});
	assert.deepEqual(plan.tasks[0].attempts[0].integrationRequired, []);
	for (const change of ["attempt", "branch", "commit", "pr", "unknown", "self", "duplicate"]) {
		const { input } = pinnedVerificationFixture();
		const entries = input.tasks[1].delivery.integrationRequired;
		if (change === "attempt") entries[0].attemptId = "T-001-A002";
		else if (change === "branch") entries[0].branch = "wrong-branch";
		else if (change === "commit") entries[0].commit = "0".repeat(40);
		else if (change === "pr") entries[0].prUrl = "https://example.invalid/pull/1";
		else if (change === "duplicate") entries.push(structuredClone(entries[0]));
		else {
			entries[0].taskId = change === "self" ? "T-003" : "T-099";
			entries[0].attemptId = `${entries[0].taskId}-A001`;
		}
		assert.throws(() => normalizeVerificationInput(redigest(input)), /unique producer delivery/, change);
	}
	const { input } = pinnedVerificationFixture();
	input.tasks[1].delivery.requirement = "branch";
	assert.throws(() => normalizeVerificationInput(redigest(input)), /must require a commit/);
});

test("factory reports retain pinned environment, workload and accepted evaluator selection", () => {
	const fixture = pinnedVerificationFixture();
	assert.deepEqual(normalizeVerificationInput(fixture.input), fixture.input);
	for (const field of /** @type {const} */ (["environment", "workload"])) {
		const { input, factory } = pinnedVerificationFixture();
		factory.evaluations[0][field] = "different-context";
		assert.throws(() => normalizeVerificationInput(redigest(input)), /pinned procedure, environment and workload/);
		assert.equal(assessDeterministicVerification(input).hardPassed, false);
	}
	const { input, context } = pinnedVerificationFixture();
	assert.ok(context.definitions.contract);
	context.definitions.contract.evaluations.push({ id: "omitted", revision: 1 });
	assert.throws(() => normalizeVerificationInput(redigest(input)), /exact selected accepted revisions/);
	const reference = pinnedVerificationFixture();
	reference.context.definitions.evaluations[0].evaluation.procedure.kind = "reference";
	assert.equal(assessDeterministicVerification(normalizeVerificationInput(redigest(reference.input))).hardPassed, false);
	const discovery = pinnedVerificationFixture();
	discovery.factory.binding.candidateId = null;
	discovery.factory.binding.contextDigest = null;
	discovery.factory.evaluations = [];
	discovery.input.tasks[1].criteria[0].text = "Report discovery findings without claiming candidate assurance";
	assert.equal(assessDeterministicVerification(normalizeVerificationInput(redigest(discovery.input))).hardPassed, true);
});

test("leaf checks cannot substitute for the final combined evaluator requirement", () => {
	for (const change of ["missing", "ambiguous", "contradictory"]) {
		const { input, reviews, verdict } = pinnedVerificationFixture();
		input.tasks[0].criteria[0].text = input.tasks[1].criteria[0].text;
		if (change === "missing") input.tasks[1].criteria[0].text = "Only local integration was checked";
		if (change === "ambiguous") input.tasks[1].criteria.push({ ...input.tasks[1].criteria[0], id: "T-003-C002" });
		if (change === "contradictory") {
			const check = input.verificationReport.evidence.find((entry) => entry.checkId === "T-003-C001");
			assert.ok(check);
			check.outcome = "failed";
		}
		reindexReport(input);
		normalizeVerificationInput(input);
		const assessment = assessDeterministicVerification(input);
		assert.equal(assessment.hardPassed, false, change);
		assert.deepEqual(assessment.correctionTaskIds, ["T-003"]);
		assert.ok(assessment.hardGaps.some((gap) => gap.summary.startsWith("Final delivery lacks")));
		assert.throws(() => validateVerificationResult({
			kind: "foundry-verification-result", reservationId: "combined", input, inputDigest: input.inputDigest, planId: input.planId,
			...verdict, reviews, evidenceIds: assessment.requiredEvidenceIds,
		}, input, "combined"), /contradicts canonical checks/);
	}
	const { input } = pinnedVerificationFixture();
	assert.equal(assessDeterministicVerification(normalizeVerificationInput(input)).hardPassed, true);
});

test("read-only evaluation retains exact selected revisions without requiring implementation tasks", () => {
	const { input, factory, context } = pinnedVerificationFixture();
	const criterion = input.tasks[1].criteria[0].text;
	factory.binding.purpose = "evaluation";
	input.evaluationTarget = {
		candidateId: "candidate", commit: "b".repeat(40), criteria: [criterion], evaluations: [{ id: "oracle", revision: 1 }],
	};
	assert.ok(context.definitions.contract);
	context.definitions.contract.evaluations.push({ id: "not-selected", revision: 1 });
	input.tasks = [];
	input.verificationReport.target = { candidateId: "candidate", taskId: null, attemptId: null, branch: null, commit: "b".repeat(40), prUrl: null };
	reindexReport(input);
	assert.deepEqual(normalizeVerificationInput(input), input);
	assert.equal(assessDeterministicVerification(input).hardPassed, true);
	input.evaluationTarget.evaluations = [{ id: "not-selected", revision: 1 }];
	assert.throws(() => normalizeVerificationInput(redigest(input)), /exact selected accepted revisions/);
});

test("human judgments remain separate from executable checks on the final delivery", () => {
	const { input, factory, context } = pinnedVerificationFixture();
	const human = {
		...context.definitions.evaluations[0], id: "human-rubric",
		evaluation: {
			...context.definitions.evaluations[0].evaluation, modality: /** @type {const} */ ("human"),
			procedure: { kind: /** @type {const} */ ("judgment"), ref: "Human rubric", digest: "2".repeat(64) },
		},
	};
	context.definitions.evaluations.push(human);
	assert.ok(context.definitions.contract);
	context.definitions.contract.evaluations.push({ id: human.id, revision: 1 });
	context.humanEvidence.push({
		evaluation: { id: human.id, revision: 1 }, candidateId: "candidate", contractDigest: "d".repeat(64), contextDigest: "f".repeat(64),
		procedureDigest: "2".repeat(64), outcome: "passed", report: "Explicit fixture human judgment", reportDigest: analysisInputDigest("Explicit fixture human judgment"),
		commit: "b".repeat(40), environment: "fixture-node", workload: "combined-workload", trust: "independent-claim",
		source: { kind: "human", actor: "human-reviewer", ref: "fixture:human-review", at: "2026-08-05T00:10:00.000Z" },
		independence: { method: "human-review" },
	});
	assert.equal(assessDeterministicVerification(normalizeVerificationInput(redigest(input))).hardPassed, true);
	context.humanEvidence = [];
	assert.equal(assessDeterministicVerification(normalizeVerificationInput(redigest(input))).hardPassed, false);
	factory.evaluations.push({ ...factory.evaluations[0], evaluation: { id: human.id, revision: 1 }, procedureDigest: "2".repeat(64) });
	assert.throws(() => normalizeVerificationInput(redigest(input)), /frozen pinned evaluators/);
});

test("declared visual checks stay bound to the final delivery in discovery and accepted plans", () => {
	for (const discovery of [false, true]) {
		const { input, factory, context } = pinnedVerificationFixture();
		const visual = context.definitions.evaluations[0];
		visual.evaluation.procedure.bundle = {
			version: 1, commit: "a".repeat(40), root: "evaluators", entryPoint: "evaluators/visual.mjs", support: [],
			invocation: { argv: ["node", "evaluators/visual.mjs"], cwd: "." },
		};
		visual.evaluation.visual = {
			capture: "Fixture capture protocol",
			states: [{ id: "ordinary", intent: "Fixture state", reference: { path: "reference.svg", digest: "3".repeat(64) } }],
		};
		context.definitions.unit.visualEvaluation = { id: visual.id, revision: visual.revision };
		context.definitions.visualEvaluation = { id: visual.id, revision: visual.revision, statement: visual.statement, evaluation: visual.evaluation };
		input.tasks[1].criteria[0].text = evaluationCriterion({ ...visual, uncertainty: null, links: [] });
		factory.evaluations[0].report = JSON.stringify({
			format: "foundry-visual-report-v1", deliveryCommit: "b".repeat(40), environment: "fixture-node",
			states: [{
				id: "ordinary", referenceDigest: "3".repeat(64),
				capture: { path: "fixture-capture.png", digest: "4".repeat(64), capturedAt: "2026-08-05T00:10:00.000Z", method: "browser-screenshot", viewport: "100x100" },
				assessment: Object.fromEntries(VISUAL_AXES.map((axis) => [axis, { outcome: "passed", finding: "Synthetic fixture assertion, not a real visual assessment" }])),
			}],
		});
		if (discovery) {
			factory.binding.candidateId = null;
			factory.binding.contractDigest = null;
			factory.binding.contractRevision = null;
			factory.binding.contextDigest = null;
			context.definitions.contract = null;
			context.definitions.obligations = [];
			context.definitions.evaluations = [];
		}
		assert.equal(assessDeterministicVerification(normalizeVerificationInput(redigest(input))).hardPassed, true);
		input.tasks[0].criteria[0].text = input.tasks[1].criteria[0].text;
		input.tasks[1].criteria[0].text = "Local output exists";
		assert.equal(assessDeterministicVerification(normalizeVerificationInput(redigest(input))).hardPassed, false);
	}
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
