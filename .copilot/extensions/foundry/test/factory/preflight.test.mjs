import assert from "node:assert/strict";
import test from "node:test";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { fixture, source } from "../bridge/fixture.mjs";

test("acceptance preview uses the same v3 private-context normalization as persistence", async (t) => {
	const f = await fixture(t);
	const previous = f.factory.snapshot().contracts[0];
	assert.ok(previous);
	const rationale = [];
	for (let index = 0; index < 3; index++) {
		const report = String(index).repeat(48000);
		const result = f.factory.ingestAnalysis({
			expectedRevision: f.factory.snapshot().revision, unitId: previous.unitId, report,
			source: {
				...source(), kind: "audit", ref: `fixture:large-report-${index}`,
				runId: `large-report-${index}`, owner: f.root, digest: analysisInputDigest(report),
			},
		});
		const last = result.knowledge.at(-1);
		assert.ok(last);
		rationale.push({ id: last.id, revision: last.revision });
	}
	const accepted = f.factory.acceptContract({
		expectedRevision: f.factory.snapshot().revision, unitId: previous.unitId, unitRevision: previous.unitRevision,
		obligations: previous.obligations, evaluations: previous.evaluations, rationale,
		actor: "owner", reason: "Accept the bounded portable rationale, retaining raw reports locally",
	}).contract;
	assert.equal(accepted.sealVersion, 3);
	const context = stableStringify(f.factory.contractContext(previous.unitId, accepted.revision));
	assert.ok(Buffer.byteLength(context) < 128 * 1024);
	assert.ok(!context.includes("0".repeat(1000)));
	assert.ok(f.factory.snapshot().knowledge.some((entry) => entry.statement.length === 7500));
});
