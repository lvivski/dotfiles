import assert from "node:assert/strict";
import test from "node:test";
import { verificationFixture } from "./ownership.mjs";

test("completed verification import and discovery use canonical results without progress corroboration", async () => {
	const current = verificationFixture();
	Object.defineProperty(current.detail, "progress", { get() { throw new Error("Progress unavailable"); } });
	const imported = await current.analysis.importVerification(current.run.runId, current.plan);
	assert.ok(!("state" in imported));
	assert.equal(imported.result.passed, true);
	const discovery = await current.analysis.discoverVerificationRun(
		current.plan.verification.reservationId, current.plan.verification.reservedAt,
	);
	assert.equal(discovery.state, "found");
	if (discovery.state === "found") assert.equal(discovery.run.runId, current.run.runId);
});

test("canonical verification ownership still rejects wrong native identities, bindings, and returned input", async () => {
	/** @type {Array<(current: ReturnType<typeof verificationFixture>) => void>} */
	const changes = [
		(current) => { current.run.runId = "foreign"; },
		(current) => { current.detail.runId = "foreign"; },
		(current) => { current.detail.workflowName = "audit"; },
		(current) => { current.detail.createdAt--; },
		(current) => { current.plan.verification.runId = "foreign"; },
		(current) => { current.run.result.reservationId = "foreign"; },
		(current) => { current.run.result.inputDigest = "0".repeat(64); },
		(current) => { current.run.result.input.objective = "Different input"; },
	];
	for (const change of changes) {
		const current = verificationFixture();
		change(current);
		await assert.rejects(current.analysis.importVerification("native-verify", current.plan),
			(error) => error instanceof Error && "code" in error && typeof error.code === "string"
				&& ["workflow_run_identity_mismatch", "analysis_input_mismatch", "invalid_analysis_input"].includes(error.code));
	}
});

test("completed result attribution cannot hide another active launch carrying the same reservation", async () => {
	const current = verificationFixture();
	current.plan.verification.runId = current.run.runId;
	const duplicate = { ...current.detail, runId: "duplicate", status: "running" };
	current.api.listRuns = async () => ({ runs: [current.detail, duplicate], omittedOlder: 0, hasMoreNewer: false });
	current.api.getRunDetail = async (runId) => runId === duplicate.runId ? duplicate : current.detail;
	const discovery = await current.analysis.discoverVerificationRun(
		current.plan.verification.reservationId, current.plan.verification.reservedAt,
	);
	assert.equal(discovery.state, "inconclusive");
	if (discovery.state === "inconclusive") {
		assert.match(discovery.reason, /multiple Workflow runs/);
		assert.deepEqual(discovery.candidates.map(({ runId }) => runId), ["native-verify", "duplicate"]);
	}
});

test("invalid or absent completed results retain marker-based recovery and collision checks", async () => {
	for (const result of [{}, undefined]) {
		const current = verificationFixture();
		current.api.getRun = async () => ({ runId: current.run.runId, status: "completed", result });
		const discovery = await current.analysis.discoverVerificationRun(
			current.plan.verification.reservationId, current.plan.verification.reservedAt,
		);
		assert.equal(discovery.state, "found");
	}
});
