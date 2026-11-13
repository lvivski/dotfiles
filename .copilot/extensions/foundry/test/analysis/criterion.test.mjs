import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVerificationInput } from "../../analysis/verification.mjs";
import { evaluateVerification } from "../../analysis/verdicts.mjs";
import { evaluationCriterion as bridgeCriterion } from "../../bridge/pinning.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { evaluationCriterion } from "../../factory/criterion.mjs";
import { FoundryFactoryError } from "../../factory/fields.mjs";
import { VISUAL_AXES, visualCriterion } from "../../factory/visual.mjs";
import { verificationFixture } from "./fixture.mjs";

/** @param {boolean} [visual] */
function fixture(visual = false) {
	const { input, reviews, verdict } = verificationFixture();
	/** @type {import("../../types/factory.js").ProjectedEvaluation & { kind: "evaluation", authority: "accepted" }} */
	const entry = {
		id: "oracle", revision: 2, kind: "evaluation", unitId: "combined", authority: "accepted",
		statement: "Check combined output", uncertainty: null, links: [],
		evaluation: {
			modality: "boundary", obligations: [{ id: "behavior", revision: 1 }], environment: "fixture-node", workload: "combined",
			procedure: { kind: "command", ref: "node evaluator.mjs", digest: "c".repeat(64) },
			independent: true, preservation: true, maxAgeSeconds: 86400,
		},
	};
	if (visual) {
		entry.evaluation.visual = {
			capture: "Synthetic fixture only",
			states: [{ id: "ordinary", intent: "Fixture state", reference: { path: "reference.svg", digest: "3".repeat(64) } }],
		};
		entry.evaluation.procedure.bundle = {
			version: 1, commit: "a".repeat(40), root: "evaluators", entryPoint: "evaluators/visual.mjs", support: [],
			invocation: { argv: ["node", "evaluators/visual.mjs"], cwd: "." },
		};
	}
	const final = input.tasks[1];
	final.delivery.commit = "b".repeat(40);
	input.verificationReport.target = {
		taskId: final.id, attemptId: final.attemptId, branch: final.delivery.branch, commit: final.delivery.commit, prUrl: null,
	};
	input.verificationReport.observedCommit = final.delivery.commit;
	final.criteria[0].text = evaluationCriterion(entry);
	/** @type {import("../../types/analysis.js").VerificationFactory} */
	const factory = {
		binding: {
			repositoryId: "e".repeat(64), unitId: "combined", unitRevision: 1, candidateId: "candidate",
			contractRevision: 1, contractDigest: "d".repeat(64), contextDigest: "f".repeat(64),
			blueprintDigest: "1".repeat(64), owner: "fixture-owner",
		},
		context: {
			version: 1,
			definitions: {
				unit: {
					id: "combined", revision: 1, name: "Combined fixture", purpose: "Verify combined output",
					boundary: { owns: ["combined result"], exposes: ["result"], consumes: [], preserves: ["behavior"] }, dependencies: [],
					...(visual ? { visualEvaluation: { id: entry.id, revision: entry.revision } } : {}),
				},
				obligations: [{ id: "behavior", revision: 1, kind: "obligation", unitId: "combined", authority: "accepted", statement: "Preserve behavior" }],
				evaluations: [entry], rationale: [],
				contract: {
					digest: "d".repeat(64), unitId: "combined", revision: 1, unitRevision: 1,
					obligations: [{ id: "behavior", revision: 1 }], evaluations: [{ id: entry.id, revision: entry.revision }],
				},
				...(visual ? { visualEvaluation: { id: entry.id, revision: entry.revision, statement: entry.statement, evaluation: entry.evaluation } } : {}),
			},
			humanEvidence: [],
		},
		evaluations: [{
			evaluation: { id: entry.id, revision: entry.revision }, procedureDigest: entry.evaluation.procedure.digest,
			environment: entry.evaluation.environment, workload: entry.evaluation.workload, outcome: "passed",
			report: visual ? JSON.stringify({
				format: "foundry-visual-report-v1", deliveryCommit: final.delivery.commit, environment: "fixture-node",
				states: [{
					id: "ordinary", referenceDigest: "3".repeat(64),
					capture: { path: "capture.png", digest: "4".repeat(64), capturedAt: "2026-08-05T00:10:00.000Z", method: "browser-screenshot", viewport: "100x100" },
					assessment: Object.fromEntries(VISUAL_AXES.map((axis) => [axis, {
						outcome: "passed", finding: "Synthetic gate fixture, not visual acceptance",
					}])),
				}],
			}) : "Synthetic boundary report",
			independenceReason: "Separately identified fixture verifier",
		}],
	};
	input.factory = factory;
	const { inputDigest: _discarded, ...canonical } = input;
	input.inputDigest = analysisInputDigest(canonical);
	assert.deepEqual(normalizeVerificationInput(input), input);
	return { input, entry, factory, final, aggregate: () => evaluateVerification(input, { ...verdict, reviews }).outcome };
}

test("the shared exact criterion reaches final verdict aggregation through both compatible exports", () => {
	assert.equal(bridgeCriterion, evaluationCriterion);
	for (const visual of [false, true]) {
		const { entry, final, aggregate } = fixture(visual);
		assert.equal(final.criteria[0].text, visual
			? `Pass declared visual fidelity evaluation oracle@2 (${"c".repeat(64)}) using real output captures and independent reference-to-output assessment.`
			: `Pass pinned boundary evaluation oracle@2 (${"c".repeat(64)}).`);
		assert.equal(aggregate().passed, true);
		entry.revision++;
		assert.equal(aggregate().passed, false, "A new evaluator revision cannot reuse a prior criterion/report");
	}
});

test("aggregation rejects missing, ambiguous, stale and mismatched final criterion reports", () => {
	for (const visual of [false, true]) for (const change of ["leaf-only", "duplicate", "missing-report", "revision", "digest", "criterion-digest", "outcome"]) {
		const { input, entry, factory, final, aggregate } = fixture(visual);
		if (change === "leaf-only") {
			input.tasks[0].criteria[0].text = final.criteria[0].text;
			final.criteria[0].text = "Local output exists";
		} else if (change === "duplicate") final.criteria.push({ ...final.criteria[0], id: "T-003-C002" });
		else if (change === "missing-report") factory.evaluations = [];
		else if (change === "revision") factory.evaluations[0].evaluation.revision++;
		else if (change === "digest") factory.evaluations[0].procedureDigest = "0".repeat(64);
		else if (change === "criterion-digest") {
			entry.evaluation.procedure.digest = "0".repeat(64);
			factory.evaluations[0].procedureDigest = entry.evaluation.procedure.digest;
		} else factory.evaluations[0].outcome = "failed";
		assert.equal(aggregate().passed, false, `${visual ? "visual" : "boundary"}: ${change}`);
	}
	for (const report of ["not-json", JSON.stringify({ format: "foundry-visual-report-v1" })]) {
		const { factory, aggregate } = fixture(true);
		factory.evaluations[0].report = report;
		assert.equal(aggregate().passed, false);
	}
});

test("canonical visual validation errors keep their class and details through aggregation", () => {
	const { entry, aggregate } = fixture(true);
	entry.evaluation.procedure.digest = "not-a-digest";
	/** @param {() => unknown} operation */
	const capture = (operation) => {
		try { operation(); }
		catch (error) {
			assert.ok(error instanceof FoundryFactoryError);
			return { code: error.code, message: error.message, details: error.details };
		}
		assert.fail("Expected canonical visual validation to reject");
	};
	const expected = capture(() => visualCriterion(entry));
	assert.equal(expected.code, "factory_input_invalid");
	assert.deepEqual(capture(() => bridgeCriterion(entry)), expected);
	assert.deepEqual(capture(aggregate), expected);
});
