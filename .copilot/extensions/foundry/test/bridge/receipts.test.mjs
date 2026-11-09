import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isList, readRecord } from "../../data.mjs";
import { completeTaskAttempt } from "../../plan/execution.mjs";
import { available, must } from "../assertions.mjs";
import { fixture, source } from "./fixture.mjs";

/** @typedef {import("../../operations.mjs").FoundryOperations} Operations */

test("operation decoding cannot hide fields rejected by closed factory validators", async (t) => {
	const f = await fixture(t);
	const before = f.factory.snapshot().revision;
	await assert.rejects(f.ops.factoryAction({
		repositoryPath: f.repo, action: "inspect", input: { unexpected: true },
	}), { code: "factory_input_invalid" });
	assert.equal(f.factory.snapshot().revision, before);
});

test("wrong-commit verifier completion stays retryable and retains only non-governing rejected learning", async (t) => {
	const f = await fixture(t);
	let plan = await f.implement(await f.generationPlan());
	plan = await f.attach(f.ops, plan, "T-002");
	await assert.rejects(f.ops.completeTask(f.payload(plan, "T-002", { commit: "f".repeat(40) })), { code: "factory_evidence_subject_mismatch" });
	const unchanged = await f.ops.getPlan({ planId: plan.id });
	assert.equal(unchanged.revision, plan.revision);
	assert.equal(unchanged.tasks[1].status, "running");
	assert.equal(f.factory.snapshot().candidates[0].evidence.length, 0);
	assert.ok(f.factory.inspect().knowledge.some((entry) => entry.id.startsWith("rejected-") && entry.authority === "non-governing"));
	plan = await f.ops.completeTask(f.payload(unchanged, "T-002"));
	assert.equal(plan.tasks[1].status, "done");
});

test("cancellation abandons an old invalid terminal report without requiring its publication", async (t) => {
	const f = await fixture(t);
	let plan = await f.implement(await f.generationPlan());
	plan = await f.attach(f.ops, plan, "T-002");
	const invalid = f.payload(plan, "T-002", { commit: "f".repeat(40) });
	plan = await f.ops.storeFor().mutate(plan.id, plan.revision, (current) => completeTaskAttempt(current, "T-002", invalid.attemptId, "done", invalid));
	plan = await f.ops.cancel({ planId: plan.id, expectedRevision: plan.revision, requestId: "cancel-invalid", requestedBy: "owner", reason: "Abandon invalid report" });
	await delay(2);
	plan = await f.ops.finalizeCancellation({
		planId: plan.id, expectedRevision: plan.revision, dispositions: [], finalizedBy: "owner",
		sessionInventory: { complete: true, capturedAt: new Date().toISOString(), sessions: [] }
	});
	assert.equal(plan.status, "cancelled");
	const candidate = f.factory.snapshot().candidates[0];
	assert.equal(candidate.completion?.disposition, "cancelled");
	assert.equal(candidate.evidence.length, 0);
	f.mutate("decideCandidate", { candidateId: candidate.id, action: "reject", expectedIncumbentId: null, actor: "owner", reason: "Invalid report retained as learning only" });
	f.mutate("retire", { type: "candidate", id: candidate.id, actor: "owner", reason: "Abandoned", summary: "Retain the failed provenance lesson" });
});

test("every deterministic learning receipt participates in pending state and dispatch holds", async (t) => {
	const f = await fixture(t);
	let plan = await f.attach(f.ops, await f.generationPlan(), "T-001");
	const db = new DatabaseSync(f.factory.databasePath);
	try {
		db.exec(`CREATE TRIGGER reject_second_learning BEFORE INSERT ON factory_events
			WHEN instr(NEW.document, 'Second retained learning') > 0
			BEGIN SELECT RAISE(FAIL, 'fixture publication failure'); END;`);
		await assert.rejects(f.ops.completeTask(f.payload(plan, "T-001", {
			learning: [
				{ kind: "observation", statement: "First retained learning" }, { kind: "proposal", statement: "Second retained learning" },
			]
		})), { code: "factory_sync_pending" });
		const status = await f.ops.getStatus({ planId: plan.id });
		assert.equal(status.plan.tasks[0].status, "done");
		assert.ok(available(status.factory).synchronization.pending.includes("T-001/T-001-A001: learning 2"));
		assert.deepEqual(status.projection.scheduling.dispatchableTaskIds, []);
		db.exec("DROP TRIGGER reject_second_learning");
		await f.ops.syncFactory({ planId: plan.id });
		assert.deepEqual(available((await f.ops.getStatus({ planId: plan.id })).factory).synchronization.pending, []);
	} finally { db.close(); }
});

test("late older evaluation outbox recovery completes independently without overriding a newer failure or signal", async (t) => {
	const f = await fixture(t);
	let generation = await f.verify(f.ops, await f.implement(await f.generationPlan()));
	({ plan: generation } = await f.finish(f.ops, generation));
	f.mutate("decideCandidate", { candidateId: f.candidate.id, action: "accept", expectedIncumbentId: null, actor: "owner", reason: "Initial supported selection" });
	const original = structuredClone(f.factory.snapshot().candidates[0]);
	/** @param {Operations} operations @param {string} id */
	const createEvaluation = async (operations, id) => f.approve(operations, await operations.createEvaluationPlan({
		id, candidateId: f.candidate.id, expectedRevision: 0, expectedFactoryRevision: f.factory.snapshot().revision,
		repository: { workingDirectory: f.repo, baseBranch: "main" },
	}));
	let older = await f.attach(f.ops, await createEvaluation(f.ops, "older-evaluation"), "T-001");
	const db = new DatabaseSync(f.factory.databasePath);
	try {
		db.exec(`CREATE TRIGGER defer_older_receipt BEFORE INSERT ON factory_events
			WHEN instr(NEW.document, '"action":"recordEvaluation"') > 0 AND instr(NEW.document, '"planId":"older-evaluation"') > 0
			BEGIN SELECT RAISE(FAIL, 'transient publication failure'); END;`);
		await assert.rejects(f.ops.completeTask(f.payload(older, "T-001")), { code: "factory_sync_pending" });
		older = await f.ops.getPlan({ planId: older.id });
		assert.equal(older.tasks[0].status, "done");
		await delay(2);
		const newerOps = await f.createOps("newer-coordinator");
		let newer = await f.attach(newerOps, await createEvaluation(newerOps, "newer-evaluation"), "T-001");
		const failure = f.payload(newer, "T-001");
		failure.factoryEvaluations[0].outcome = "failed";
		failure.factoryEvaluations[0].report = "A newer actual observation failed the boundary";
		assert.ok(isList(failure.evidence));
		readRecord(failure.evidence[0]).outcome = "failed";
		newer = await newerOps.completeTask(failure);
		await f.finish(newerOps, newer, { failed: true });
		const newerEvidence = must(f.factory.snapshot().candidates[0].evidence.find((entry) => entry.source.planId === newer.id));
		await delay(2);
		f.mutate("recordSignal", {
			id: "after-both-observations", kind: "assumption-change", summary: "A later operating-context signal still needs fresh evidence",
			knowledgeRefs: [{ id: "oracle", revision: 1 }], source: { ...source(), kind: "operational" }
		});
		db.exec("DROP TRIGGER defer_older_receipt");
		await f.ops.syncFactory({ planId: older.id });
		const afterRecovery = f.factory.snapshot().revision;
		await f.ops.syncFactory({ planId: older.id });
		assert.equal(f.factory.snapshot().revision, afterRecovery);
		assert.deepEqual(available((await f.ops.getStatus({ planId: older.id })).factory).synchronization.pending, []);
		const olderReceipt = must(f.factory.inspect().candidates[0].evidence.find((entry) => entry.source.planId === older.id));
		assert.equal(olderReceipt.publicationDisposition, "historical");
		const completed = await f.finish(f.ops, older);
		assert.equal(completed.plan.status, "completed");
		assert.equal(must(completed.input.factory.context.observations)[0].disposition, "historical");
		const current = f.factory.inspect().candidates[0];
		assert.equal(current.assurance.evaluationSupport[0].evidenceId, newerEvidence.id);
		assert.ok(current.assurance.evaluationSupport[0].gaps.includes("failed"));
		assert.ok(current.assurance.evaluationSupport[0].gaps.includes("renewal-required"));
		assert.equal(current.assurance.ready, false);
		assert.deepEqual(f.factory.snapshot().candidates[0].completion, original.completion);
		assert.deepEqual(f.factory.snapshot().candidates[0].delivery, original.delivery);
	} finally { db.close(); }
});
