import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowContext } from "../workflows/runtime.mjs";
import { ADDITIONAL_WORKFLOWS } from "../workflows/registry.mjs";
import { securityFinding } from "./fixture.mjs";

test("security review reports failed coverage instead of a clean result", async () => {
	const orientationFailure = createWorkflowContext(
		{ root: "src", perspectives: 1 },
		(_prompt, options) => options.label === "orientation" ? null : undefined,
	);
	const orientationResult =
		await ADDITIONAL_WORKFLOWS.securityReview.run(orientationFailure);
	assert.ok(typeof orientationResult === "string");
	assert.match(orientationResult, /Security review incomplete/);
	assert.equal(orientationFailure.calls.length, 1);

	const investigationFailure = createWorkflowContext(
		{ root: "src", perspectives: 1 },
		(_prompt, options) => options.label.startsWith("investigate:") ? null : undefined,
	);
	const investigationResult =
		await ADDITIONAL_WORKFLOWS.securityReview.run(investigationFailure);
	assert.ok(typeof investigationResult === "string");
	assert.match(investigationResult, /Coverage incomplete/);
	assert.match(investigationResult, /must not be interpreted as a clean security review/);

	const finding = securityFinding();
	const verificationFailure = createWorkflowContext(
		{ root: "src", perspectives: 1 },
		(_prompt, options) => {
			if (options.label.startsWith("investigate:")) return [finding];
			if (options.label.startsWith("verify:")) return null;
			return undefined;
		},
	);
	const verificationResult =
		await ADDITIONAL_WORKFLOWS.securityReview.run(verificationFailure);
	assert.ok(typeof verificationResult === "string");
	assert.match(verificationResult, /1 verification branch\(es\) failed/);
	assert.match(verificationResult, /must not be interpreted as a clean security review/);
});
