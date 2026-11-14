import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdir
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createFoundryOperations } from "../../operations.mjs";
import { parseJson, readRecord } from "../../data.mjs";
import { verificationCheckIds } from "../../plan/graph.mjs";
import { buildFoundryTools } from "../../tools.mjs";
import { available, must } from "../assertions.mjs";
import { factoryMutator } from "../factory/accessors.mjs";
import { analysisFixture } from "../native/fixture.mjs";
import { analysisStub, createApproved, evidence, technicalFixture, technicalOwner, technicalReason, withOperations } from "./fixture.mjs";
import { COMMIT, DIGEST, PROCEDURE, git } from "../git.mjs";

test("TA-07/08/09/18: public acceptance tool executes old failing/new passing immutable bundles and records exact authority without elicitation", async (t) => {
	const f = await technicalFixture(t);
	const grant = must(await f.grant());
	assert.equal(grant.scope.approvalType, "technical");
	assert.deepEqual(await f.grant(), grant);
	assert.deepEqual(await f.operations.planApprovalDelegation({ action: "inspect", id: grant.id }, { invocation: technicalOwner }), grant);
	const before = f.factory.snapshot();
	const request = await f.request();
	const tool = must(buildFoundryTools(f.operations).find((entry) => entry.name === "foundry_accept_contract"));
	assert.equal(tool.skipPermission, undefined, "Technical authority never bypasses native tool/resource permission");
	const args = { repositoryPath: request.repositoryPath, ...request.input };
	const result = await tool.handler(args, { ...technicalOwner, toolName: tool.name, arguments: args });
	assert.equal(result.resultType, "success", result.textResultForLlm);
	assert.equal(readRecord(parseJson(result.textResultForLlm)).ok, true);
	const plan = await f.operations.getPlan({ planId: f.plan.id });
	const decision = must(plan.technicalDecisions?.[0]);
	assert.equal(decision.reason, technicalReason);
	assert.equal(decision.planRevision, f.plan.revision);
	assert.equal(decision.factoryRevision, before.revision);
	assert.equal(decision.sessionId, technicalOwner.sessionId);
	assert.equal(decision.toolCallId, technicalOwner.toolCallId);
	assert.deepEqual(decision.delegation, grant);
	assert.deepEqual(decision.oldScope, ["src/foundation.mjs", "src/integration.mjs"]);
	assert.deepEqual(decision.newScope, decision.oldScope);
	assert.equal(decision.verification, null);
	assert.equal(f.executions.length, 2);
	assert.equal(f.executions[0].exitCode, 1);
	assert.match(f.executions[0].stderr, /"outcome":"denied".*"actual":\{"outcome":"cancelled"/);
	assert.equal(f.executions[1].exitCode, 0);
	assert.equal(f.executions[1].stderr, "");
	assert.deepEqual(JSON.parse(f.executions[0].stdout), JSON.parse(f.executions[1].stdout));
	assert.equal(JSON.parse(f.executions[0].stdout).length, 4, "Both actual executions retain all control traces");
	assert.deepEqual(decision.renewal?.before.cases, f.beforeCases);
	assert.deepEqual(decision.renewal?.after.cases, f.afterCases);
	const after = f.factory.snapshot();
	assert.equal(after.contracts.length, before.contracts.length + 1);
	const next = must(after.contracts.at(-1));
	assert.deepEqual(next.obligations, f.contract.obligations);
	assert.deepEqual(next.rationale, f.contract.rationale);
	assert.deepEqual(next.dependencies, f.contract.dependencies);
	assert.equal(next.previousDigest, f.contract.digest);
	assert.equal(next.revision, f.contract.revision + 1);
	assert.notEqual(next.digest, f.contract.digest);
	assert.deepEqual(next.evaluations, request.input.evaluations);
	assert.equal(after.candidates.length, 0, "Renewal itself is not a delivered, independently verified or selected candidate");
	const published = must(after.decisions.find((entry) => entry.kind === "accept-contract" && entry.technical));
	assert.equal(published.kind, "accept-contract");
	if (published.kind !== "accept-contract") assert.fail("Expected the technical acceptance decision");
	assert.equal(published.actor, `agent-session:${technicalOwner.sessionId}`);
	assert.deepEqual(published.technical, decision);
	const priorDecision = must(before.decisions.find((entry) => entry.id === f.contract.decisionId));
	assert.equal(priorDecision.kind, "accept-contract");
	if (priorDecision.kind !== "accept-contract") assert.fail("Expected prior contract acceptance");
	assert.deepEqual(published.resolutions, priorDecision.resolutions);
	assert.deepEqual(published.renewalSignalIds, priorDecision.renewalSignalIds);
	assert.deepEqual((await f.reopen().getPlan({ planId: f.plan.id })).technicalDecisions, plan.technicalDecisions);
	const revision = after.revision;
	await f.operations.syncFactory({ planId: f.plan.id });
	assert.equal(f.factory.snapshot().revision, revision);
	assert.equal(f.ui.calls, 0);
});

test("TA-10/11/12: real changed artifacts cannot reverse cancellation or weaken access, controls, semantic identity, UI or evaluator gates", async (t) => {
	/** @type {[string, Parameters<typeof technicalFixture>[1]][]} */
	const changes = [
		["reverse precedence", { changeFiles: (files) => { files["technical/reference.mjs"] = files["technical/reference.mjs"].replace('input.cancelled ? "cancelled" : input.lateResult', 'input.lateResult === "denied" ? "denied" : input.cancelled ? "cancelled" : input.lateResult'); } }],
		["revoke granted access", { changeFiles: (files) => { files["technical/reference.mjs"] = files["technical/reference.mjs"].replace("input.cancelled ? input.access : input.lateResult", "input.lateResult"); } }],
		["change granted access assertion", { changeCases: (cases) => { cases[0].expected.access = "denied"; } }],
		["remove denial control", { changeCases: (cases) => { cases.splice(1, 1); } }],
		["remove caller data assertion", { changeCases: (cases) => { cases[0].expected.data = []; } }],
		["remove focus assertion", { changeCases: (cases) => { cases[0].expected.focus = "#elsewhere"; } }],
		["remove unrelated control", { changeCases: (cases) => { cases.pop(); } }],
		["same IDs and count but changed semantics", { changeCases: (cases) => { cases[1].input.cancelled = true; cases[1].expected.outcome = "cancelled"; } }],
		["weaken independence into an implementation-only check", { changeDefinition: (definition) => {
			definition.independent = false; definition.modality = "implementation-test"; definition.preservation = false; delete definition.visual;
		} }],
		["weaken preservation", { changeDefinition: (definition) => { definition.preservation = false; } }],
		["weaken freshness", { changeDefinition: (definition) => { definition.maxAgeSeconds *= 10; } }],
		["change workload", { changeDefinition: (definition) => { definition.workload = "easier"; } }],
		["drop UI coverage", { changeDefinition: (definition) => { delete definition.visual; } }],
		["weaken native reference", { changeDefinition: (definition) => { must(definition.visual).capture = "Agent prose replaces native screenshot"; } }],
		["edit native reference bytes", {
			changeFiles: (files) => { files["technical/native-reference.svg"] = '<svg xmlns="http://www.w3.org/2000/svg"><text>Allow data loss</text></svg>\n'; },
			changeDefinition: (definition) => { must(definition.visual).states[0].reference.digest = createHash("sha256").update('<svg xmlns="http://www.w3.org/2000/svg"><text>Allow data loss</text></svg>\n').digest("hex"); },
		}],
		["change evaluator statement", { changeKnowledge: (knowledge) => { knowledge.statement = "Check fewer controls"; } }],
		["change evaluator uncertainty", { changeKnowledge: (knowledge) => { knowledge.uncertainty = "New unresolved uncertainty"; } }],
		["invalid supersedes lineage", { changeKnowledge: (knowledge) => {
			knowledge.links = [{ relation: "supersedes", target: { id: "cancellation-oracle", revision: 1 } },
				{ relation: "supersedes", target: { id: "human-rubric", revision: 1 } }];
		} }],
	];
	for (const [name, options] of changes) await t.test(name, async (t) => {
		const f = await technicalFixture(t, options);
		await f.grant();
		const before = f.factory.snapshot();
		await assert.rejects(f.operations.factoryAction(await f.request(), { invocation: technicalOwner }));
		assert.deepEqual(f.factory.snapshot(), before, "Rejected material must not publish a successor contract");
		assert.deepEqual((await f.operations.getPlan({ planId: f.plan.id })).technicalDecisions ?? [], []);
		assert.equal(f.ui.calls, 0);
	});
});

test("TA-04/08/13: missing executor, native denial, caller identity and stale authority hold publication without granting new resources", async (t) => {
	for (const mode of ["missing", "denied"]) await t.test(mode, async (t) => {
		const denied = new Error("Native resource permission denied");
		const f = await technicalFixture(t, { executeTechnical: mode === "missing" ? null : async () => { throw denied; } });
		await f.grant();
		const before = f.factory.snapshot();
		await assert.rejects(f.operations.factoryAction(await f.request(), { invocation: technicalOwner }),
			mode === "missing" ? { code: "technical_execution_unavailable" } : denied);
		assert.deepEqual(f.factory.snapshot(), before);
		assert.deepEqual((await f.operations.getPlan({ planId: f.plan.id })).technicalDecisions ?? [], []);
		assert.equal(f.executions.length, 0);
		assert.equal(f.ui.calls, 0);
	});
	const f = await technicalFixture(t);
	await f.grant();
	const request = await f.request();
	const before = f.factory.snapshot();
	for (const invocation of [undefined, { ...technicalOwner, sessionId: "foreign" }, { ...technicalOwner, agentId: "child" }]) {
		await assert.rejects(f.operations.factoryAction(request, { invocation }));
	}
	for (const input of [
		{ ...request.input, actor: "caller-forged-human" },
		{ ...request.input, expectedRevision: request.input.expectedRevision - 1 },
		{ ...request.input, technical: { ...request.input.technical, expectedPlanRevision: f.plan.revision - 1 } },
		{ ...request.input, technical: { ...request.input.technical, delegationId: "missing" } },
		{ ...request.input, technical: { ...request.input.technical, failures: [] } },
		{ ...request.input, evaluations: [{ id: "cancellation-oracle", revision: 2 }] },
		{ ...request.input, rationale: [] },
		{ ...request.input, resolutions: [] },
		{ ...request.input, renewalSignalIds: [] },
		{ ...request.input, technical: { ...request.input.technical, execution: { beforeExitCode: 1, afterExitCode: 0 } } },
	]) {
		await assert.rejects(f.operations.factoryAction({ ...request, input }, { invocation: technicalOwner }));
	}
	assert.deepEqual(f.factory.snapshot(), before);
	assert.deepEqual((await f.operations.getPlan({ planId: f.plan.id })).technicalDecisions ?? [], []);
	assert.equal(f.ui.calls, 0);
});

test("TA-07: unsupported assertion syntax and extra executable material expose explicit holds", async t => {
	/** @type {[string, string, (files: Record<string, string>) => void][]} */
	const changes = [
		["unknown assertion field", "factory_input_invalid", files => {
			files["technical/cases.json"] = files["technical/cases.json"].replace('"outcome": "cancelled"', '"result": "cancelled"');
		}],
		["noncanonical consumer material", "technical_assertion_unsupported", files => { files["technical/cases.json"] += " "; }],
		["additional executable file", "technical_extra_edit", files => { files["technical/extra.mjs"] = 'throw new Error("Unreviewed consumer logic");\n'; }],
	];
	for (const [name, code, changeFiles] of changes) await t.test(name, async t => {
		const f = await technicalFixture(t, { changeFiles });
		await f.grant();
		const before = f.factory.snapshot();
		await assert.rejects(f.operations.factoryAction(await f.request(), { invocation: technicalOwner }), { code });
		assert.deepEqual(f.factory.snapshot(), before);
		assert.deepEqual((await f.operations.getPlan({ planId: f.plan.id })).technicalDecisions ?? [], []);
		assert.equal(f.executions.length, 0);
		assert.equal(f.ui.calls, 0);
	});
});

test("TA-14/17: renewal leaves delivered lineage, human judgment, independent evaluation and replacement approval unsatisfied", async (t) => {
	const f = await technicalFixture(t);
	const context = { generation: [], comparisonOnly: [], independence: { method: "fresh-session", reason: "Synthetic fresh App generation only" } };
	const old = f.mutate("prepareCandidate", { id: "old-candidate", unitId: "technical-unit", contractRevision: 1, actor: "fixture", context }).candidate;
	const oldPlan = await f.operations.createFactoryPlan({
		id: "old-candidate-plan", expectedRevision: 0, expectedFactoryRevision: f.factory.snapshot().revision, candidateId: old.id,
		repository: { workingDirectory: f.repositoryPath, baseBranch: "main" },
	});
	const boundOld = structuredClone(f.factory.snapshot().candidates.find((entry) => entry.id === old.id));
	await f.grant();
	await f.operations.factoryAction(await f.request(), { invocation: technicalOwner });
	assert.deepEqual(f.factory.snapshot().candidates.find((entry) => entry.id === old.id), boundOld);
	assert.deepEqual(await f.operations.getPlan({ planId: oldPlan.id }), oldPlan);
	await assert.rejects(f.operations.reserveTask({
		planId: oldPlan.id, expectedRevision: oldPlan.revision, taskId: "T-001", reservationId: "cannot-reuse-superseded-plan",
	}), { code: "factory_contract_superseded" });
	const successor = f.mutate("prepareCandidate", {
		id: "new-candidate", unitId: "technical-unit", contractRevision: 2, actor: "fixture", context,
	}).candidate;
	assert.notEqual(successor.contextDigest, old.contextDigest);
	const fresh = await f.operations.createFactoryPlan({
		id: "fresh-candidate-plan", expectedRevision: 0, expectedFactoryRevision: f.factory.snapshot().revision, candidateId: successor.id,
		repository: { workingDirectory: f.repositoryPath, baseBranch: "main" },
	});
	assert.equal(fresh.status, "draft");
	assert.equal(fresh.gates.planApprovedAt, null);
	assert.equal(fresh.gates.completionApprovedAt, null);
	assert.ok(fresh.tasks.some((task) => task.kind === "verify"));
	const human = must(f.factory.generation(successor.id).evaluations.find((entry) => entry.id === "human-rubric"));
	assert.equal(human.evaluation.modality, "human");
	const support = must(f.factory.inspect().candidates.find((entry) => entry.id === successor.id)?.assurance.evaluationSupport
		.find((entry) => entry.evaluation.id === human.id));
	assert.equal(support.evidenceId, null);
	assert.ok(support.gaps.length > 0, "Renewal cannot fabricate the still-required human judgment");
	await assert.rejects(f.operations.approve({
		planId: fresh.id, expectedRevision: fresh.revision, approvalType: "completion", delegationId: "technical-grant",
		review: "Renewal is not independent evaluation or human acceptance",
	}, { invocation: technicalOwner }));
	await assert.rejects(f.operations.factoryAction({
		repositoryPath: f.repositoryPath, action: "decideCandidate",
		input: { expectedRevision: f.factory.snapshot().revision, candidateId: successor.id, action: "accept", expectedIncumbentId: null, actor: "fixture", reason: "Renewal is not replacement approval" },
	}), { code: "factory_assurance_incomplete" });
	assert.equal(f.factory.inspect().units[0].currentCandidateId, null);
	assert.equal(f.factory.snapshot().candidates.find((entry) => entry.id === successor.id)?.delivery, null);
});

test("TA-04/12: identical agreement bytes do not transfer a grant between accepted evaluator identities", async (t) => {
	const f = await technicalFixture(t, { secondaryEvaluator: true });
	const pin = f.grantInput.technical.agreement;
	await f.operations.planApprovalDelegation({
		...f.grantInput, technical: { ...f.grantInput.technical,
			agreement: { ...pin, evaluation: { id: "secondary-cancellation-oracle", revision: 1 } } },
	}, { invocation: technicalOwner });
	const before = f.factory.snapshot();
	await assert.rejects(f.operations.factoryAction(await f.request(), { invocation: technicalOwner }), { code: "technical_lineage_invalid" });
	assert.deepEqual(f.factory.snapshot(), before);
	assert.deepEqual((await f.operations.getPlan({ planId: f.plan.id })).technicalDecisions ?? [], []);
	assert.equal(f.executions.length, 0, "Wrong evaluator identity fails before privileged execution");
});

test("TA-04/08: stale evaluator revisions and substituted agreement bytes cannot authorize executable alignment", async (t) => {
	for (const changed of [{ digest: "f".repeat(64) }, { evaluation: { id: "cancellation-oracle", revision: 2 } }]) {
		await t.test("agreement " + JSON.stringify(changed), async (t) => {
			const f = await technicalFixture(t);
			await f.operations.planApprovalDelegation({
				...f.grantInput, technical: { ...f.grantInput.technical, agreement: { ...f.grantInput.technical.agreement, ...changed } },
			}, { invocation: technicalOwner });
			const before = f.factory.snapshot();
			await assert.rejects(f.operations.factoryAction(await f.request(), { invocation: technicalOwner }));
			assert.deepEqual(f.factory.snapshot(), before);
			assert.equal(f.executions.length, 0);
			assert.deepEqual((await f.operations.getPlan({ planId: f.plan.id })).technicalDecisions ?? [], []);
		});
	}
});

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
		const finished = await operations.finishVerification({ planId: plan.id, expectedRevision: prepared.plan.revision, runId: "factory-verification" });
		assert.ok(!("state" in finished));
		plan = finished;
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
	assert.ok(!("state" in captured));
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
