import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createFactoryService } from "../../factory.mjs";
import { retryFailedPlan } from "../../plan/lifecycle.mjs";
import { createPlanStore } from "../../storage.mjs";
import { must } from "../assertions.mjs";
import { factoryDocument } from "../factory/accessors.mjs";
import { COMMIT, DIGEST, fixture, source } from "./fixture.mjs";

test("fresh-process generation is rejected before an App plan binding exists", async (t) => {
	const f = await fixture(t);
	f.mutate("prepareCandidate", {
		id: "process-only", unitId: "unit", contractRevision: 1, actor: "owner",
		context: { generation: [], comparisonOnly: [], independence: { method: "fresh-process", reason: "An actual external process is required" } }
	});
	const before = f.factory.snapshot().revision;
	await assert.rejects(f.ops.createFactoryPlan({
		id: "invalid-process-plan", candidateId: "process-only", expectedRevision: 0, expectedFactoryRevision: before,
		repository: { workingDirectory: f.repo, baseBranch: "main" }
	}), { code: "factory_app_generation_origin" });
	assert.equal(f.factory.snapshot().revision, before);
	assert.equal(f.factory.snapshot().bindings.length, 0);
});

test("an older incomplete fresh-process App binding remains inspectable and abandonable, not proof of generation", async (t) => {
	const f = await fixture(t);
	const { candidate } = f.mutate("prepareCandidate", {
		id: "old-process", unitId: "unit", contractRevision: 1, actor: "owner",
		context: { generation: [], comparisonOnly: [], independence: { method: "fresh-process", reason: "Historical incomplete setup" } }
	});
	const document = factoryDocument(f.factory.exportFactory());
	const owner = path.join(f.root, "historical-owner");
	document.events.push({
		revision: ++document.revision, at: new Date().toISOString(), action: "bindPlan", input: {
			unitId: "unit", unitRevision: 1, contractRevision: 1, contractDigest: candidate.contractDigest, contextDigest: candidate.contextDigest,
			candidateId: candidate.id, planId: "old-process-plan", owner, blueprintDigest: DIGEST,
		}
	});
	const restoredRoot = path.join(f.root, "old-binding");
	await mkdir(restoredRoot);
	const restored = createFactoryService({ repositoryPath: f.repo, storageRoot: restoredRoot });
	restored.importFactory({ source: JSON.stringify(document), expectedRevision: 0 });
	assert.equal(restored.inspect({ candidateId: candidate.id }).candidates[0].assurance.ready, false);
	restored.abandonPlan({
		expectedRevision: restored.snapshot().revision, candidateId: candidate.id, reason: "Historical setup had no process provenance",
		source: { kind: "human", ref: "fixture:historical-cancellation", actor: "owner", at: new Date().toISOString(), owner, planId: "old-process-plan" }
	});
	assert.equal(restored.snapshot().candidates.find((entry) => entry.id === candidate.id)?.completion?.disposition, "cancelled");
	assert.equal(restored.snapshot().candidates.find((entry) => entry.id === candidate.id)?.delivery, null);
});

test("another coordinator re-evaluates an immutable delivery with a verifier-only plan and preserves generation history", async (t) => {
	const f = await fixture(t);
	let plan = await f.verify(f.ops, await f.implement(await f.generationPlan()));
	({ plan } = await f.finish(f.ops, plan));
	f.mutate("decideCandidate", { candidateId: f.candidate.id, action: "accept", expectedIncumbentId: null, actor: "owner", reason: "Initial supported selection" });
	const original = structuredClone(f.factory.snapshot().candidates[0]);
	const selected = structuredClone(must(f.factory.snapshot().decisions.at(-1)));
	const sealed = f.factory.generation(f.candidate.id);
	f.mutate("recordSignal", {
		id: "new-context", kind: "assumption-change", summary: "Refresh the affected boundary evidence",
		knowledgeRefs: [{ id: "obligation", revision: 1 }], source: { ...source(), kind: "operational" }
	});
	const second = await f.createOps("second-coordinator");
	let evaluationPlan = await second.createEvaluationPlan({
		id: "reevaluate", candidateId: f.candidate.id, expectedRevision: 0, expectedFactoryRevision: f.factory.snapshot().revision,
		repository: { workingDirectory: f.repo, baseBranch: "main" }, evaluations: [{ id: "oracle", revision: 1 }],
	});

	assert.deepEqual(evaluationPlan.tasks.map((task) => task.kind), ["verify"]);
	assert.equal(evaluationPlan.evaluationTarget?.commit, COMMIT);
	evaluationPlan = await f.approve(second, evaluationPlan);
	evaluationPlan = await f.verify(second, evaluationPlan);
	assert.match(f.factory.inspect().candidates[0].assurance.missing.join(), /evaluation-plan-pending/);
	const evaluated = await f.finish(second, evaluationPlan);
	assert.deepEqual(evaluated.input.tasks, []);
	assert.equal(evaluated.input.evaluationTarget?.commit, COMMIT);
	const after = f.factory.snapshot().candidates[0];
	assert.deepEqual(after.binding, original.binding);
	assert.deepEqual(after.delivery, original.delivery);
	assert.deepEqual(after.completion, original.completion);
	assert.deepEqual(f.factory.snapshot().decisions.find((entry) => entry.id === selected.id), selected);
	assert.deepEqual(f.factory.generation(f.candidate.id), sealed);
	assert.equal(f.factory.inspect().candidates[0].assurance.ready, true);
	assert.equal((await f.ops.getPlan({ planId: plan.id })).status, "completed");
});

test("failed generation verification routes to fresh implementation or read-only repair, never generation retry", async (t) => {
	const f = await fixture(t);
	let plan = await f.verify(f.ops, await f.implement(await f.generationPlan()));
	({ plan } = await f.finish(f.ops, plan, { failed: true }));
	const failed = structuredClone(f.factory.snapshot().candidates[0].completion);
	assert.equal(failed?.passed, false);
	const status = await f.ops.getStatus({ planId: plan.id });
	assert.ok(status.projection.actions.some((entry) => entry.kind === "prepare-fresh-candidate"));
	assert.ok(status.projection.actions.some((entry) => entry.kind === "create-evaluation-plan"));
	assert.equal(status.projection.actions.some((entry) => entry.kind === "approve-correction"), false);
	await assert.rejects(f.ops.approve({ planId: plan.id, expectedRevision: plan.revision, approvalType: "retry", approvedBy: "owner" }), { code: "factory_fresh_candidate_required" });
	let repair = await f.ops.createEvaluationPlan({
		id: "repair-assurance", candidateId: f.candidate.id, expectedRevision: 0, expectedFactoryRevision: f.factory.snapshot().revision,
		repository: { workingDirectory: f.repo, baseBranch: "main" },
	});
	repair = await f.verify(f.ops, await f.approve(f.ops, repair));
	await f.finish(f.ops, repair);
	assert.deepEqual(f.factory.snapshot().candidates[0].completion, failed);
	assert.equal((await f.ops.getPlan({ planId: plan.id })).status, "failed");
	assert.equal(f.factory.inspect().candidates[0].assurance.ready, true);
});

test("retirement holds all evaluation work and releases after completion or retry abandonment", async (t) => {
	for (const terminate of ["complete", "retry-then-abandon", "recovered-retry-then-abandon"]) await t.test(terminate, async (t) => {
		const f = await fixture(t);
		let generation = await f.verify(f.ops, await f.implement(await f.generationPlan()));
		({ plan: generation } = await f.finish(f.ops, generation));
		f.mutate("decideCandidate", { candidateId: f.candidate.id, action: "reject", expectedIncumbentId: null, actor: "owner", reason: "Retain this alternative for investigation" });
		const retire = () => f.mutate("retire", { type: "candidate", id: f.candidate.id, actor: "owner", reason: "Finished alternative", summary: "Preserve evidence and lineage" });
		let evaluation = await f.approve(f.ops, await f.ops.createEvaluationPlan({
			id: "active-evaluation", candidateId: f.candidate.id, expectedRevision: 0, expectedFactoryRevision: f.factory.snapshot().revision,
			repository: { workingDirectory: f.repo, baseBranch: "main" },
		}));
		evaluation = await f.attach(f.ops, evaluation, "T-001");
		assert.throws(retire, { code: "factory_retirement_unsafe" });
		assert.equal(f.factory.inspect().candidates[0].retirementHoldCount, 1);
		evaluation = await f.ops.completeTask(f.payload(evaluation, "T-001"));
		if (terminate === "retry-then-abandon") {
			const db = new DatabaseSync(f.factory.databasePath);
			try {
				db.exec(`CREATE TRIGGER defer_completion BEFORE INSERT ON factory_events
					WHEN instr(NEW.document, '"action":"recordEvaluationCompletion"') > 0
					BEGIN SELECT RAISE(FAIL, 'transient completion publication failure'); END;`);
				await assert.rejects(f.finish(f.ops, evaluation, { failed: true }), { code: "factory_sync_pending" });
				evaluation = await f.ops.getPlan({ planId: evaluation.id });
				await assert.rejects(f.ops.approve({ planId: evaluation.id, expectedRevision: evaluation.revision, approvalType: "retry", approvedBy: "owner" }), { code: "factory_sync_pending" });
				assert.equal((await f.ops.getPlan({ planId: evaluation.id })).status, "failed");
				db.exec("DROP TRIGGER defer_completion");
				await f.ops.syncFactory({ planId: evaluation.id });
			} finally { db.close(); }
		} else ({ plan: evaluation } = await f.finish(f.ops, evaluation, { failed: terminate !== "complete" }));
		assert.equal(f.factory.inspect().candidates[0].retirementHoldCount, 0);
		if (terminate !== "complete") {
			const completedBinding = structuredClone(must(f.factory.snapshot().bindings.find((entry) => entry.planId === evaluation.id)));
			const priorCompletion = must(completedBinding.completion);
			if (terminate === "recovered-retry-then-abandon") {
				const store = createPlanStore({ workspacePath: path.join(f.root, "coordinator") });
				evaluation = await store.mutate(evaluation.id, evaluation.revision, (plan) => retryFailedPlan(plan, "owner"));
				await f.ops.syncFactory({ planId: evaluation.id });
			} else evaluation = await f.ops.approve({ planId: evaluation.id, expectedRevision: evaluation.revision, approvalType: "retry", approvedBy: "owner" });
			assert.throws(retire, { code: "factory_retirement_unsafe" });
			f.mutate("recordEvaluationCompletion", {
				candidateId: f.candidate.id, source: priorCompletion.source,
				passed: priorCompletion.passed, commit: COMMIT, evidenceIds: priorCompletion.evidenceIds
			});
			assert.equal(f.factory.inspect().candidates[0].retirementHoldCount, 1, "Replaying an old completion cannot release new work");
			if (terminate === "retry-then-abandon") {
				evaluation = await f.verify(f.ops, evaluation);
				({ plan: evaluation } = await f.finish(f.ops, evaluation, { failed: true }));
				const secondCompletion = structuredClone(must(f.factory.snapshot().bindings.find((entry) => entry.planId === evaluation.id)).completion);
				evaluation = await f.ops.approve({ planId: evaluation.id, expectedRevision: evaluation.revision, approvalType: "retry", approvedBy: "owner" });
				f.mutate("recordEvaluationCompletion", {
					candidateId: f.candidate.id, source: priorCompletion.source,
					passed: priorCompletion.passed, commit: COMMIT, evidenceIds: priorCompletion.evidenceIds
				});
				assert.deepEqual(must(f.factory.snapshot().bindings.find((entry) => entry.planId === evaluation.id)).completion, secondCompletion);
				assert.equal(f.factory.inspect().candidates[0].retirementHoldCount, 1, "An older non-latest completion cannot release a subsequent retry");
			}
			evaluation = await f.attach(f.ops, evaluation, "T-001");
			const attempt = must(evaluation.tasks[0].attempts.at(-1));
			evaluation = await f.ops.cancel({ planId: evaluation.id, expectedRevision: evaluation.revision, requestId: "abandon-retry", requestedBy: "owner", reason: "Stop read-only investigation" });
			await delay(2);
			evaluation = await f.ops.finalizeCancellation({
				planId: evaluation.id, expectedRevision: evaluation.revision,
				dispositions: [{ attemptId: attempt.id, disposition: "session-terminated", sessionId: attempt.sessionId }], finalizedBy: "owner",
				sessionInventory: { complete: true, capturedAt: new Date().toISOString(), sessions: [{ id: attempt.sessionId, status: "archived" }] }
			});
			assert.equal(evaluation.status, "cancelled");
			const binding = must(f.factory.snapshot().bindings.find((entry) => entry.planId === evaluation.id));
			assert.deepEqual(must(binding.completions)[0], priorCompletion);
			assert.equal(binding.completion?.disposition, "cancelled");
		}
		assert.equal(f.factory.inspect().candidates[0].retirementHoldCount, 0);
		retire();
		assert.equal(f.factory.inspect({ includeRetired: true }).candidates[0].selection?.kind, "reject-candidate");
		assert.equal((await f.ops.getPlan({ planId: generation.id })).status, "completed");
	});
});
