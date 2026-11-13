import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isList, readRecord } from "../../data.mjs";
import { completeTaskAttempt } from "../../plan/execution.mjs";
import { available, must } from "../assertions.mjs";
import { fixture, source } from "./fixture.mjs";
import { technicalFixture, technicalOwner } from "../application/fixture.mjs";
import { createPlanStore } from "../../storage.mjs";
import { createFoundryOperations } from "../../operations.mjs";
import { analysisStub } from "../application/fixture.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/** @typedef {import("../../operations.mjs").FoundryOperations} Operations */

test("TA-19: interrupted owner SQLite writes roll back both decision and authorization before revocation", async t => {
	for (const boundary of ["before-plan-write", "after-marker-write-before-commit"]) await t.test(boundary, async t => {
		const f = await technicalFixture(t);
		await f.grant();
		const original = await f.operations.exportPlan({ planId: f.plan.id });
		const db = new DatabaseSync(f.operations.storeFor().databasePath);
		try {
			db.exec(boundary === "before-plan-write"
				? `CREATE TRIGGER interrupt_authorization BEFORE UPDATE ON plans
					WHEN json_array_length(json_extract(NEW.document, '$.technicalDecisions')) > 0
					BEGIN SELECT RAISE(ABORT, 'before authorization commit'); END;`
				: `CREATE TRIGGER interrupt_authorization AFTER INSERT ON technical_authorizations
					BEGIN SELECT RAISE(ABORT, 'before authorization commit'); END;`);
			await assert.rejects(f.operations.factoryAction(await f.request(), { invocation: technicalOwner }), { code: "database_error" });
			assert.equal(db.prepare("SELECT count(*) AS count FROM technical_authorizations").get()?.count, 0);
			db.exec("DROP TRIGGER interrupt_authorization");
			const restarted = f.reopen();
			assert.equal(await restarted.exportPlan({ planId: f.plan.id }), original);
			await restarted.planApprovalDelegation({ action: "revoke", id: "technical-grant", reason: "Revoke after the interrupted uncommitted request." },
				{ invocation: technicalOwner });
			await assert.rejects(restarted.factoryAction(await f.request(restarted), { invocation: technicalOwner }), { code: "delegation_unavailable" });
			await restarted.syncFactory({ planId: f.plan.id });
			assert.equal(f.factory.snapshot().contracts.length, 1);
			assert.equal(f.executions.length, 2, "Recovery of an uncommitted request cannot re-execute after revocation");
			assert.equal(f.ui.calls, 0);
		} finally { db.close(); }
	});
});

test("TA-19: owner-commit interruption survives restart/revocation and reconciles the exact immutable renewal once", async (t) => {
	const f = await technicalFixture(t);
	await f.grant();
	const interrupted = new Error("Crash after owner authorization commit, before factory receipt application");
	const crashing = f.reopen({ notify: () => { throw interrupted; } });
	await assert.rejects(crashing.factoryAction(await f.request(crashing), { invocation: technicalOwner }), (error) => error === interrupted);
	const persisted = await createPlanStore({ workspacePath: f.workspacePath }).read(f.plan.id);
	assert.equal(persisted.technicalDecisions?.length, 1);
	assert.equal(f.factory.snapshot().contracts.length, 1);
	assert.equal(f.executions.length, 2);
	const receipt = structuredClone(persisted.technicalDecisions);
	const restarted = f.reopen();
	await restarted.planApprovalDelegation({ action: "revoke", id: "technical-grant", reason: "Revoked after persisted authorization" }, { invocation: technicalOwner });
	assert.equal(f.factory.snapshot().contracts.length, 1);
	await restarted.syncFactory({ planId: f.plan.id });
	const published = f.factory.snapshot();
	assert.equal(published.contracts.length, 2);
	assert.deepEqual((await restarted.getPlan({ planId: f.plan.id })).technicalDecisions, receipt);
	assert.ok(published.decisions.some((entry) => entry.kind === "accept-contract" && entry.technical?.id === receipt?.[0].id));
	const again = f.reopen();
	await again.syncFactory({ planId: f.plan.id });
	await again.factoryAction(await f.request(again), { invocation: technicalOwner });
	assert.deepEqual(f.factory.snapshot(), published, "Exact receipt recovery after revocation is not a new authorization");
	assert.equal(f.executions.length, 2, "Historical reconciliation must not rerun or reauthorize the evaluator");
	const conflicting = await f.request(again);
	conflicting.input.technical.failures.push("a different unapproved failure");
	await assert.rejects(again.factoryAction(conflicting, { invocation: technicalOwner }));
	assert.deepEqual(f.factory.snapshot(), published);
	assert.equal(f.ui.calls, 0);
});

test("TA-19: revocation, abort and native owner loss during actual execution block owner authorization", async (t) => {
	for (const boundary of ["revocation", "abort", "owner-loss", "factory-revision"]) await t.test(boundary, async (t) => {
		const f = await technicalFixture(t);
		await f.grant();
		const controller = new AbortController();
		const reopened = f.reopen({
			executeTechnical: async (input, signal) => {
				const execution = await f.executor(input, signal);
				if (boundary === "revocation") await f.operations.planApprovalDelegation({
					action: "revoke", id: "technical-grant", reason: "Withdraw before atomic owner authorization",
				}, { invocation: technicalOwner });
				if (boundary === "abort") controller.abort(new Error("Stopped before authorization"));
				if (boundary === "owner-loss") f.session.sessionId = "foreign-owner";
				if (boundary === "factory-revision") f.mutate("appendKnowledge", {
					id: "concurrent-observation", unitId: "technical-unit", kind: "observation",
					statement: "Authority changed while execution was in flight", source: source(),
				});
				return execution;
			},
		});
		await assert.rejects(reopened.factoryAction(await f.request(reopened), { invocation: technicalOwner, signal: controller.signal }));
		assert.equal(f.executions.length, 2);
		assert.equal(f.factory.snapshot().contracts.length, 1);
		const persisted = await createPlanStore({ workspacePath: f.workspacePath }).read(f.plan.id);
		assert.deepEqual(persisted.technicalDecisions ?? [], []);
		f.session.sessionId = technicalOwner.sessionId;
		await f.reopen().syncFactory({ planId: f.plan.id });
		assert.equal(f.factory.snapshot().contracts.length, 1);
		assert.equal(f.ui.calls, 0);
	});
});

test("TA-19: failed real SQLite receipt append retains pending authority and resumes exactly once after revocation", async (t) => {
	const f = await technicalFixture(t);
	await f.grant();
	const db = new DatabaseSync(f.factory.databasePath);
	try {
		const beforeEvents = db.prepare("SELECT COUNT(*) AS count FROM factory_events").get()?.count;
		assert.equal(typeof beforeEvents, "number");
		db.exec(`CREATE TRIGGER reject_technical_receipt BEFORE INSERT ON factory_events
			WHEN instr(NEW.document, '"action":"acceptContract"') > 0 AND instr(NEW.document, '"technical"') > 0
			BEGIN SELECT RAISE(FAIL, 'fixture crash before factory receipt append'); END;`);
		await assert.rejects(f.operations.factoryAction(await f.request(), { invocation: technicalOwner }), (error) => {
			assert.match(JSON.stringify(error), /"cause":\{"code":"database_error"/);
			return true;
		});
		assert.equal(db.prepare("SELECT COUNT(*) AS count FROM factory_events").get()?.count, beforeEvents);
		const restarted = f.reopen();
		const plan = await restarted.getPlan({ planId: f.plan.id });
		assert.equal(plan.technicalDecisions?.length, 1);
		assert.equal(f.factory.snapshot().contracts.length, 1);
		await restarted.planApprovalDelegation({ action: "revoke", id: "technical-grant", reason: "After committed owner receipt" }, { invocation: technicalOwner });
		await assert.rejects(restarted.syncFactory({ planId: f.plan.id }));
		assert.deepEqual((await restarted.getPlan({ planId: f.plan.id })).technicalDecisions, plan.technicalDecisions);
		db.exec("DROP TRIGGER reject_technical_receipt");
		await f.reopen().syncFactory({ planId: f.plan.id });
		const revision = f.factory.snapshot().revision;
		await f.reopen().syncFactory({ planId: f.plan.id });
		assert.equal(f.factory.snapshot().revision, revision);
		assert.equal(f.factory.snapshot().contracts.length, 2);
		assert.equal(f.executions.length, 2);
		assert.equal(db.prepare("SELECT COUNT(*) AS count FROM factory_events").get()?.count, Number(beforeEvents) + 1);
	} finally { db.close(); }
});

test("TA-16/19: exporting a pending owner receipt imports neither active grants nor local publication authority", async (t) => {
	const f = await technicalFixture(t);
	await f.grant();
	const crashing = f.reopen({ notify: () => { throw new Error("Owner committed before publication"); } });
	await assert.rejects(crashing.factoryAction(await f.request(crashing), { invocation: technicalOwner }), /Owner committed/);
	const exported = await f.operations.exportPlan({ planId: f.plan.id });
	const importedWorkspace = path.join(f.root, "import-only");
	await mkdir(importedWorkspace);
	const imported = createFoundryOperations({
		getWorkspacePath: () => importedWorkspace, factoryStorageRoot: f.storageRoot, analysis: analysisStub(),
		getSession: () => ({ sessionId: "importer", workspacePath: importedWorkspace }),
	});
	const restored = await imported.importPlan({ source: exported, expectedRevision: 0 });
	assert.equal(restored.technicalDecisions?.length, 1);
	assert.equal(await imported.storeFor().getApprovalDelegation("technical-grant"), null);
	assert.equal(await imported.getActivation(), null);
	await assert.rejects(imported.syncFactory({ planId: restored.id }));
	assert.equal(f.factory.snapshot().contracts.length, 1);
	// Re-import into the original path after loss of the owner database distinguishes
	// local authorization from mere owner-path equality in a portable JSON receipt.
	const ownerDatabase = new DatabaseSync(f.operations.storeFor().databasePath);
	try {
		ownerDatabase.prepare("DELETE FROM plans WHERE id = ?").run(f.plan.id);
		ownerDatabase.prepare("DELETE FROM technical_authorizations WHERE plan_id = ?").run(f.plan.id);
	} finally { ownerDatabase.close(); }
	const samePathImport = f.reopen();
	await samePathImport.importPlan({ source: exported, expectedRevision: 0 });
	await assert.rejects(samePathImport.syncFactory({ planId: f.plan.id }), (error) => {
		assert.match(JSON.stringify(error), /technical_authorization_missing/);
		return true;
	});
	assert.equal(f.factory.snapshot().contracts.length, 1);
});

test("TA-19: a changed factory postcondition after owner commit holds instead of authorizing a different successor", async (t) => {
	const f = await technicalFixture(t);
	await f.grant();
	const crashing = f.reopen({ notify: () => { throw new Error("Stop before factory application"); } });
	await assert.rejects(crashing.factoryAction(await f.request(crashing), { invocation: technicalOwner }), /Stop before/);
	const receipt = (await f.operations.getPlan({ planId: f.plan.id })).technicalDecisions;
	f.mutate("appendKnowledge", {
		id: "intervening-meaning", unitId: "technical-unit", kind: "proposal",
		statement: "A distinct proposed meaning must not be accepted by stale technical recovery", source: source(),
	});
	const restarted = f.reopen();
	await restarted.planApprovalDelegation({ action: "revoke", id: "technical-grant", reason: "Withdraw before any new interpretation" }, { invocation: technicalOwner });
	await assert.rejects(restarted.syncFactory({ planId: f.plan.id }));
	assert.equal(f.factory.snapshot().contracts.length, 1);
	assert.deepEqual((await restarted.getPlan({ planId: f.plan.id })).technicalDecisions, receipt);
	assert.equal(f.factory.snapshot().candidates.length, 0);
});

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
