import assert from "node:assert/strict";
import test from "node:test";
import { validateVerificationResult } from "../../analysis/verdicts.mjs";
import { buildVerificationInput } from "../../analysis/verification.mjs";
import { verificationMarker } from "../../marker.mjs";
import { run as runVerify, meta as verifyMeta } from "../../workflows/verify.mjs";
import { must } from "../assertions.mjs";
import { completedPlan } from "../native/plans.mjs";
import { assertOutputSchemas } from "./assertions.mjs";
import { workflowWithResponses } from "./runtime.mjs";

test("bundled verification workflow echoes its complete native input", async () => {
	const args = buildVerificationInput(completedPlan());
	const reservationId = "verification-reservation";
	const evidenceIds = args.verificationReport.evidence.map((entry) => entry.id);
	assert.equal(verifyMeta.name, "verify");
	const workflow = workflowWithResponses({ ...args, reservationId }, {
		"verify:coverage-reviewer": {
			missingEvidence: [],
			integrationFindings: [],
			risks: [],
		},
		"verify:integration-skeptic": {
			missingEvidence: [],
			integrationFindings: [],
			risks: [],
		},
		"verify:verifier": {
			summary: "Verified",
			missingEvidence: [],
		},
	});
	const result = await runVerify(workflow);
	assert.equal(workflow.logs[0], verificationMarker(reservationId));
	assert.deepEqual(result.input, args);
	assert.equal(result.reservationId, reservationId);
	assert.deepEqual(result.evidenceIds, evidenceIds);
	assert.ok(result.reviews.every((review) => review !== null && !Object.hasOwn(review, "coverage")));
	assert.equal(validateVerificationResult(result, args, reservationId).passed, true);
	assert.equal(workflow.calls.length, 3);
	assert.deepEqual(must(workflow.calls[0].options.schema).required, ["missingEvidence", "integrationFindings", "risks"]);
	assert.deepEqual(must(workflow.calls[2].options.schema).required, ["summary", "missingEvidence"]);
	assertOutputSchemas(workflow);
});

test("verification workflow emits its marker before full input validation", async () => {
	const reservationId = "invalid-input-reservation";
	const workflow = workflowWithResponses({ reservationId }, {});
	await assert.rejects(runVerify(workflow), /planId must be a non-empty string/);
	assert.equal(workflow.logs[0], verificationMarker(reservationId));
});
