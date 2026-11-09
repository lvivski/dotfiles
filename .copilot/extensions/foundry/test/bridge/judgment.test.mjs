import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { must } from "../assertions.mjs";
import { COMMIT, fixture, source } from "./fixture.mjs";

test("bound human evaluators wait for an explicitly attributed human, never an App agent verdict", async (t) => {
	const f = await fixture(t, { human: true });
	let plan = await f.implement(await f.generationPlan());
	plan = await f.attach(f.ops, plan, "T-002");
	const payload = f.payload(plan, "T-002");
	await assert.rejects(f.ops.completeTask({
		...payload, factoryEvaluations: [...payload.factoryEvaluations, {
			...payload.factoryEvaluations[0], evaluation: { id: "human-rubric", revision: 1 }, procedureDigest: "a".repeat(64),
		}]
	}), { code: "factory_evaluation_coverage" });
	plan = await f.ops.completeTask(payload);
	assert.equal((await f.ops.getStatus({ planId: plan.id })).projection.nextAction.kind, "collect-human-judgment");
	await assert.rejects(f.ops.prepareVerification({ planId: plan.id, expectedRevision: plan.revision, reservationId: "too-early" }), { code: "factory_human_judgment_pending" });
	await f.ops.recordHumanJudgment({
		repositoryPath: f.repo, expectedRevision: f.factory.snapshot().revision, id: "human-review-1", candidateId: f.candidate.id,
		evaluation: { id: "human-rubric", revision: 1 }, contractDigest: f.candidate.contractDigest, contextDigest: f.candidate.contextDigest,
		commit: COMMIT, procedureDigest: "a".repeat(64), outcome: "passed", environment: "fixture-node", workload: "fixture-workload",
		report: "The human reviewer assessed the published explanation rubric", actor: "human-reviewer",
		reason: "Separate explicit human judgment", sourceRef: "fixture:human-review",
		judgmentId: "actual-human-review-1", performedAt: new Date().toISOString(),
	});
	const finished = await f.finish(f.ops, plan);
	assert.equal(finished.input.factory.context.humanEvidence[0].source.kind, "human");
	assert.equal(finished.input.factory.context.humanEvidence[0].source.actor, "human-reviewer");
	assert.equal(finished.input.factory.context.definitions.evaluations.find((entry) => entry.id === "human-rubric")?.authority, "accepted");
	assert.equal(f.factory.inspect().candidates[0].assurance.ready, true);
});

test("human judgment identity and observation time are independent of renamed or retimed publication receipts", async (t) => {
	const f = await fixture(t, { human: true });
	let plan = await f.verify(f.ops, await f.implement(await f.generationPlan()));
	const judgment = {
		repositoryPath: f.repo, id: "human-receipt-1", candidateId: f.candidate.id,
		evaluation: { id: "human-rubric", revision: 1 }, contractDigest: f.candidate.contractDigest, contextDigest: f.candidate.contextDigest,
		commit: COMMIT, procedureDigest: "a".repeat(64), outcome: "passed", environment: "fixture-node", workload: "fixture-workload",
		report: "The human explicitly reviewed this rubric", actor: "human-reviewer", reason: "Independent human assessment",
		sourceRef: "fixture:human/message-1", judgmentId: "human-message-1", performedAt: new Date().toISOString(),
	};
	await f.ops.recordHumanJudgment({ expectedRevision: f.factory.snapshot().revision, ...judgment });
	({ plan } = await f.finish(f.ops, plan));
	f.mutate("decideCandidate", { candidateId: f.candidate.id, action: "accept", expectedIncumbentId: null, actor: "owner", reason: "Initial human and executable support" });
	const originalSelection = structuredClone(must(f.factory.snapshot().decisions.at(-1)));
	await delay(2);
	f.mutate("recordSignal", {
		id: "human-renewal", kind: "assumption-change", summary: "The human rubric needs a new assessment",
		knowledgeRefs: [{ id: "human-rubric", revision: 1 }], source: { ...source(), kind: "operational" }
	});
	const { judgmentId: _sourceId, performedAt: _observedAt, ...withoutIdentity } = judgment;
	await assert.rejects(f.ops.recordHumanJudgment({ expectedRevision: f.factory.snapshot().revision, ...withoutIdentity, id: "renamed" }), { code: "factory_human_source_required" });
	for (const change of [
		{ id: "renamed" },
		{ id: "retimed", performedAt: new Date().toISOString() },
		{ id: "changed-judgment-id", judgmentId: "different-id", performedAt: new Date().toISOString() },
		{ id: "changed-reference", sourceRef: "fixture:human/renamed-reference", performedAt: new Date().toISOString() },
	]) {
		await assert.rejects(f.ops.recordHumanJudgment({ expectedRevision: f.factory.snapshot().revision, ...judgment, ...change }), { code: "factory_evaluation_origin_reused" });
	}
	assert.equal(f.factory.inspect().candidates[0].assurance.ready, false);
	await delay(2);
	await f.ops.recordHumanJudgment({
		expectedRevision: f.factory.snapshot().revision, ...judgment, id: "new-publication",
		judgmentId: "human-message-2", sourceRef: "fixture:human/message-2", performedAt: new Date().toISOString(),
	});
	const candidate = f.factory.inspect().candidates[0];
	assert.equal(candidate.assurance.ready, true);
	assert.equal(candidate.evidence.find((entry) => entry.id === judgment.id)?.source.at, judgment.performedAt);
	assert.equal(candidate.evidence.find((entry) => entry.id === "new-publication")?.source.judgmentId, "human-message-2");
	assert.deepEqual(f.factory.snapshot().decisions.find((entry) => entry.id === originalSelection.id), originalSelection);
});
