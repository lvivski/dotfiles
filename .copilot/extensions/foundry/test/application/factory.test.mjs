import assert from "node:assert/strict";
import {
	mkdir
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createFoundryOperations } from "../../operations.mjs";
import { verificationCheckIds } from "../../plan/graph.mjs";
import { available } from "../assertions.mjs";
import { factoryMutator } from "../factory/accessors.mjs";
import { analysisFixture } from "../native/fixture.mjs";
import { analysisStub, createApproved, evidence, withOperations } from "./fixture.mjs";
import { COMMIT, DIGEST, PROCEDURE, git } from "../git.mjs";

test("sealed candidates use normal App dispatch, capture learning, bind independent evidence and require separate replacement approval", async () => {
	const analysis = analysisStub({
		discoverVerificationRun: async () => ({ state: "found", run: { runId: "factory-verification", status: "completed" } }),
		verificationResult: {
			passed: true, summary: "Pinned checks passed",
			evidence: ["T-002-A001-E001", "T-002-A001-E002", "T-002-A001-E003"], missingEvidence: [], correctionTaskIds: [],
		},
	});
	await withOperations(async ({ operations, workspacePath }) => {
		const factory = operations.factoryFor(workspacePath);
		const mutation = factoryMutator(factory);
		const source = { kind: "discovery", ref: "fixture:recovered-contract", actor: "owner", at: new Date().toISOString() };
		mutation("appendKnowledge", { id: "obligation", unitId: "operation-capability", kind: "obligation", statement: "Preserve the boundary and caller data", source });
		mutation("appendKnowledge", {
			id: "oracle", unitId: "operation-capability", kind: "evaluation", statement: "Run the independent boundary oracle", source,
			evaluation: {
				modality: "boundary", procedure: structuredClone(PROCEDURE),
				obligations: [{ id: "obligation", revision: 1 }], environment: "node-fixture", workload: "fixture",
				maxAgeSeconds: 86400, independent: true, preservation: true,
			},
		});
		mutation("acceptContract", {
			unitId: "operation-capability", unitRevision: 1, obligations: [{ id: "obligation", revision: 1 }],
			evaluations: [{ id: "oracle", revision: 1 }], actor: "owner", reason: "Accept recovered intent",
		});
		const planning = { repositoryPath: workspacePath, unitId: "operation-capability", objective: "Explore a boundary", repositoryContext: "Fixture" };
		await assert.rejects(operations.preparePlan(planning), { code: "factory_candidate_required" });
		assert.equal((await operations.preparePlan({ ...planning, intent: "discovery" })).workflow, "plan");
		mutation("prepareCandidate", {
			id: "fresh", unitId: "operation-capability", contractRevision: 1, actor: "owner",
			context: { generation: [], comparisonOnly: [{ kind: "implementation", ref: "comparison-only-prior-source", digest: "b".repeat(64) }], independence: { method: "fresh-session", reason: "New App child with sealed inputs" } },
		});
		const input = {
			id: "factory-plan", expectedRevision: 0, expectedFactoryRevision: factory.snapshot().revision,
			repository: { workingDirectory: workspacePath, baseBranch: "main" }, candidateId: "fresh", expectedFiles: ["candidate/**"],
		};
		let plan = await operations.createFactoryPlan(input);
		assert.equal(plan.status, "draft");
		assert.equal(plan.planning, null);
		assert.equal(plan.factory?.candidateId, "fresh");
		assert.deepEqual(await operations.createFactoryPlan(input), plan, "recover after either cross-store commit");
		plan = await operations.submitPlan({ planId: plan.id, expectedRevision: plan.revision });
		plan = await operations.approve({ planId: plan.id, expectedRevision: plan.revision, approvedBy: "owner" });
		for (const [taskId, sessionId] of [["T-001", "fresh-implementation"], ["T-002", "separate-evaluator"]]) {
			const reservation = await operations.reserveTask({ planId: plan.id, expectedRevision: plan.revision, taskId, reservationId: `reserve-${taskId}` });
			assert.match(reservation.delegationPrompt, /pinned|sealed/i);
			assert.equal(reservation.delegationPrompt.includes("comparison-only-prior-source"), taskId === "T-002");
			const worktree = path.join(workspacePath, "verifier");
			if (taskId === "T-002") git(workspacePath, "worktree", "add", "--quiet", "-b", `fixture/${taskId}`, worktree, COMMIT);
			plan = await operations.attachTask({
				planId: plan.id, expectedRevision: reservation.plan.revision, taskId, attemptId: reservation.attemptId,
				sessionId, branch: `fixture/${taskId}`,
			});
			if (taskId === "T-002") git(worktree, "checkout", "--quiet", "--detach", COMMIT);
			const reports = taskId === "T-002" ? [{
				evaluation: { id: "oracle", revision: 1 }, procedureDigest: DIGEST,
				environment: "node-fixture", workload: "fixture", outcome: "passed", report: "Boundary and conservation assertions passed",
				independenceReason: "Read-only App child is distinct from the implementation child",
			}] : [];
			const payload = {
				planId: plan.id, expectedRevision: plan.revision, taskId, attemptId: reservation.attemptId,
				status: "done", commit: COMMIT, resultSummary: "Delivered exact fixture commit",
				learning: [{ kind: "observation", statement: "Discovered a caller-owned input boundary", uncertainty: "Needs explicit obligation review" }],
				evidence: taskId === "T-002" ? verificationCheckIds(plan.tasks).map((checkId) => ({
					checkId, type: "test", summary: "Passed", source: "node --test boundary.test.mjs", outcome: "passed",
				})) : evidence("Implementation checks"),
				factoryEvaluations: reports,
			};
			if (taskId === "T-002") {
				await assert.rejects(operations.completeTask({ ...payload, factoryEvaluations: [] }), { code: "factory_evaluation_coverage" });
				await assert.rejects(operations.completeTask({ ...payload, factoryEvaluations: [{ ...reports[0], outcome: "failed" }] }), { code: "factory_evidence_contradiction" });
			}
			plan = await operations.completeTask(payload);
		}
		const captured = factory.snapshot();
		assert.ok(captured.knowledge.some((entry) => entry.statement === "Discovered a caller-owned input boundary"));
		assert.equal(captured.candidates[0].delivery?.source.attemptId, "T-001-A001");
		assert.equal(captured.candidates[0].evidence[0].source.sessionId, "separate-evaluator");
		assert.equal(captured.candidates[0].evidence[0].trust, "independent-claim");
		await assert.rejects(operations.factoryAction({
			repositoryPath: workspacePath, action: "recordEvaluation",
			input: { candidateId: "fresh" },
		}), { code: "factory_bound_evidence" });
		const prepared = await operations.prepareVerification({ planId: plan.id, expectedRevision: plan.revision, reservationId: "factory-verification-reservation" });
		plan = await operations.finishVerification({ planId: plan.id, expectedRevision: prepared.plan.revision, runId: "factory-verification" });
		assert.throws(() => mutation("decideCandidate", {
			candidateId: "fresh", action: "accept", expectedIncumbentId: null, actor: "owner", reason: "Not yet completed",
		}), { code: "factory_assurance_incomplete" });
		plan = await operations.approve({ planId: plan.id, expectedRevision: plan.revision, approvalType: "completion", approvedBy: "owner" });
		assert.equal(factory.snapshot().candidates[0].completion?.source.runId, "factory-verification");
		assert.equal(factory.inspect().units[0].currentCandidateId, null);
		await operations.factoryAction({
			repositoryPath: workspacePath, action: "decideCandidate",
			input: { expectedRevision: factory.snapshot().revision, candidateId: "fresh", action: "accept", expectedIncumbentId: null, actor: "owner", reason: "Select the independently supported replacement" },
		});
		assert.equal(factory.inspect().units[0].currentCandidateId, "fresh");
		const siblingWorkspace = path.join(workspacePath, "sibling-session");
		await mkdir(siblingWorkspace);
		const sibling = createFoundryOperations({
			getWorkspacePath: () => siblingWorkspace, factoryStorageRoot: workspacePath,
			analysis: analysisFixture({ listWorkflowRuns: () => assert.fail("Foreign native ownership must not be used") }),
		});
		const exported = await operations.exportPlan({ planId: plan.id });
		await sibling.importPlan({ source: exported, expectedRevision: 0 });
		const inspected = await sibling.getStatus({ planId: plan.id, includeWorkflows: true });
		assert.equal(available(inspected.factory).units[0].currentCandidateId, "fresh");
		assert.equal(inspected.workflows?.state, "unavailable");
		await assert.rejects(sibling.reserveTask({ planId: plan.id, taskId: "T-001", expectedRevision: plan.revision, reservationId: "foreign" }), { code: "factory_execution_foreign" });
	}, { analysis });
});

test("unreadable factory authority blocks unvalidated completion and permits the repaired report", () => withOperations(async ({ operations, workspacePath }) => {
	let plan = await createApproved(operations, workspacePath);
	const reserved = await operations.reserveTask({ planId: plan.id, taskId: "T-001", expectedRevision: plan.revision, reservationId: "sync-recovery" });
	plan = await operations.attachTask({ planId: plan.id, taskId: "T-001", attemptId: reserved.attemptId, expectedRevision: reserved.plan.revision, sessionId: "sync-child", branch: "fixture/sync" });
	const factory = operations.factoryFor(workspacePath);
	const db = new DatabaseSync(factory.databasePath);
	const saved = db.prepare("SELECT document FROM factory WHERE singleton=1").get()?.document;
	assert.ok(typeof saved === "string");
	try {
		db.prepare("UPDATE factory SET document = ? WHERE singleton = 1").run("{bad-json");
		await assert.rejects(operations.completeTask({
			planId: plan.id, taskId: "T-001", attemptId: reserved.attemptId, expectedRevision: plan.revision,
			status: "done", resultSummary: "Completed before authority failure", evidence: evidence("Passed"),
		}), { code: "factory_document_invalid" });
		assert.equal((await operations.getPlan({ planId: plan.id })).tasks[0].status, "running");
		db.prepare("UPDATE factory SET document = ? WHERE singleton = 1").run(saved);
	} finally {
		db.close();
	}
	plan = await operations.completeTask({
		planId: plan.id, taskId: "T-001", attemptId: reserved.attemptId, expectedRevision: plan.revision,
		status: "done", resultSummary: "Completed after authority repair", evidence: evidence("Passed"),
	});
	assert.equal(plan.tasks[0].status, "done");
	await operations.syncFactory({ planId: plan.id });
	const revision = factory.snapshot().revision;
	await operations.syncFactory({ planId: plan.id });
	assert.equal(factory.snapshot().revision, revision);
	assert.deepEqual(available((await operations.getStatus({ planId: plan.id })).factory).synchronization.pending, []);
}));

test("native analysis capture retains exact scoped findings without promoting them or importing foreign run ownership", () => withOperations(async ({ operations, workspacePath }) => {
	const factory = operations.factoryFor(workspacePath);
	const captured = await operations.captureAnalysis({
		repositoryPath: workspacePath, unitId: "operation-capability", runId: "audit-run",
		expectedRevision: factory.snapshot().revision, actor: "coordinator",
	});
	assert.equal(captured.knowledge[0].statement, "Observed a boundary gap; source coverage is incomplete.");
	assert.equal(captured.knowledge[0].source.runId, "audit-run");
	assert.equal(factory.inspect().knowledge[0].authority, "non-governing");
	assert.equal(factory.snapshot().contracts.length, 0);
}, {
	analysis: {
		...analysisStub(), importAnalysis: async () => ({
			report: "Observed a boundary gap; source coverage is incomplete.", workflowName: "audit", completedAt: Date.now(), runId: "audit-run",
		})
	}
}));
