import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanningArgs, validatePlanningResult } from "../../analysis/planning.mjs";
import { buildRepairPreparation, repairMaterial } from "../../analysis/repair.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { createPlanStore } from "../../storage.mjs";
import { createRepairJournal } from "../../storage/repair.mjs";
import { run as runPlan } from "../../workflows/plan.mjs";
import { executeRepair } from "../../workflows/repair.mjs";
import { planningResult, withPlanningOwner } from "../native/plans.mjs";
import { readRecord } from "../../data.mjs";
import { createWorkflowContext, workflowWithResponses } from "./runtime.mjs";

function fixture() {
	const input = buildPlanningArgs({
		objective: "Produce the implementation and preserve independent final confirmation",
		constraints: ["Only src/change.mjs may change. Local commits only; no merges.", "A support matrix artifact is permitted."],
		repositoryContext: "Support matrix: macOS, Linux, Windows; test output for each platform and unchanged data.",
		maxTasks: 1,
		factoryContext: { owner: "synthetic-owner", contract: null, governing: null, authority: "discovery-only", rationale: [{ kind: "proposal", statement: "not authority" }] },
	});
	const original = planningResult(input);
	original.plan.tasks[0].acceptanceCriteria = ["Producer completion requires T-002 confirmation of all platform tests and unchanged data."];
	original.plan.tasks[1].description = "After producer delivery, independently confirm all platform tests and unchanged data at the exact commit.";
	const repaired = structuredClone(original.plan);
	repaired.tasks[0].acceptanceCriteria = ["Producer supplies passing platform tests and unchanged-data evidence; T-002 independently confirms them after delivery."];
	const failure = { passed: false, issues: ["Producer acceptance depends on its dependent final verifier, creating an execution deadlock."] };
	const responses = {
		"plan:decomposer": original.plan, "plan:synthesizer": original.plan,
		"plan:architecture-critic": original.critiques[0], "plan:delivery-risk-critic": original.critiques[1],
		"plan:verifier": failure, "plan:semantic-repair": repaired, "plan:conservation-review": { passed: true, issues: [] },
	};
	return { input, original, repaired, failure, responses };
}

test("SPR-02/04/05/06: ordinary semantic failure gets one bounded repair and a distinct conservation reviewer", async () => {
	const f = fixture();
	const workflow = withPlanningOwner(workflowWithResponses(f.input, f.responses));
	const result = await runPlan(workflow);
	assert.equal(result.status, "ready");
	assert.deepEqual(validatePlanningResult(result, f.input, 1), f.repaired);
	assert.deepEqual(result.synthesisRepair?.originalVerification, f.failure);
	assert.deepEqual(workflow.calls.map(call => call.options.label), [
		"plan:decomposer", "plan:architecture-critic", "plan:delivery-risk-critic", "plan:synthesizer",
		"plan:verifier", "plan:semantic-repair", "plan:conservation-review",
	]);
	for (const { prompt } of workflow.calls.slice(-2)) {
		for (const input of [f.input.objective, f.input.repositoryContext, ...f.input.constraints, ...f.failure.issues]) assert.ok(prompt.includes(input));
		assert.ok(prompt.includes("CANONICAL-INPUT") && prompt.includes("ORIGINAL-VERIFICATION") && prompt.includes("CRITIQUES"));
		assert.match(prompt, /existing later independent final verification/);
		assert.match(prompt, /never require a downstream task before producer completion/);
	}
	assert.match(workflow.calls.at(-1)?.prompt ?? "", /fresh-context conservation reviewer, not the repair author/);
});

test("SPR-02/03/18: successful planning skips repair; structural repair consumes the same allowance", async () => {
	const f = fixture();
	const success = withPlanningOwner(workflowWithResponses(f.input, { ...f.responses, "plan:verifier": { passed: true, issues: [] } }));
	assert.equal((await runPlan(success)).status, "ready");
	assert.equal(success.calls.length, 5);
	const oversized = structuredClone(f.original.plan);
	oversized.tasks[0].acceptanceCriteria = ["Conserve data. ".repeat(200)];
	const workflow = withPlanningOwner(workflowWithResponses(f.input, {
		...f.responses, "plan:synthesizer": oversized, "plan:synthesis-repair": f.repaired,
	}));
	const result = await runPlan(workflow);
	assert.equal(result.status, "needs-review");
	assert.equal(result.synthesisRepair?.stage, "structural");
	assert.equal(workflow.calls.filter(call => call.options.label.includes("repair")).length, 1);
	assert.equal(workflow.calls.some(call => call.options.label === "plan:conservation-review"), false);
	const journal = createRepairJournal({ workspacePath: workflow.session.workspacePath, sessionId: workflow.session.sessionId });
	assert.ok("repairBudget" in result && result.repairBudget && "preparationId" in result.repairBudget);
	assert.equal(journal.read(result.repairBudget.preparationId, result.repairBudget.preparationDigest).state, "completed");
});

test("SPR-05/06/07/18: structural invariants and independent semantic negatives remain needs-review", async () => {
	const f = fixture();
	const removedConfirmation = structuredClone(f.repaired);
	removedConfirmation.tasks[1].description = "Repeat the producer's report without independent confirmation.";
	const weakenedChecks = structuredClone(f.repaired);
	weakenedChecks.tasks[0].acceptanceCriteria = ["Skip platform tests and unchanged-data checks; a producer assertion is enough."];
	const inventedPermission = structuredClone(f.repaired);
	inventedPermission.tasks[0].acceptanceCriteria = ["Merge to the main branch to satisfy this criterion without further authorization."];
	for (const mutation of [
		(plan = structuredClone(f.repaired)) => { plan.tasks.push(structuredClone(plan.tasks[0])); return plan; },
		(plan = structuredClone(f.repaired)) => { plan.tasks[0].expectedFiles = ["src/change.mjs", "docs/matrix.md"]; return plan; },
		(plan = structuredClone(f.repaired)) => { plan.tasks[0].deliveryRequirement = "branch"; return plan; },
		(plan = structuredClone(f.repaired)) => { plan.tasks[1].dependsOn = []; return plan; },
	]) {
		const workflow = withPlanningOwner(workflowWithResponses(f.input, { ...f.responses, "plan:semantic-repair": mutation() }));
		const result = await runPlan(workflow);
		assert.equal(result.status, "needs-review", "Even a positive semantic verdict cannot override deterministic invariants");
		assert.match(result.issues.join("\n"), /conservation rejected/);
	}
	for (const [candidate, verdict] of [
		[null, { passed: true, issues: [] }],
		[{}, { passed: true, issues: [] }],
		[f.repaired, null],
		[f.repaired, { passed: "yes", issues: [] }],
		[f.repaired, { passed: false, issues: [] }],
		[removedConfirmation, { passed: false, issues: ["Independent confirmation was removed"] }],
		[weakenedChecks, { passed: false, issues: ["Substantive platform and data checks were weakened"] }],
		[f.original.plan, { passed: false, issues: ["Producer still waits for the final verifier"] }],
		[inventedPermission, { passed: false, issues: ["Repair invents Git merge permission"] }],
		[f.repaired, { passed: false, issues: ["Uncertain conservation of platform/data checks"] }],
	]) {
		const workflow = withPlanningOwner(workflowWithResponses(f.input, { ...f.responses, "plan:semantic-repair": candidate, "plan:conservation-review": verdict }));
		assert.equal((await runPlan(workflow)).status, "needs-review");
		assert.equal(workflow.calls.filter(call => call.options.label === "plan:semantic-repair").length, 1);
	}
});

test("SPR-07: support matrix is conserved only as an already-authorized artifact", async () => {
	const f = fixture();
	const original = structuredClone(f.original.plan);
	original.tasks[0].acceptanceCriteria = ["Write docs/matrix.md with macOS, Linux, Windows support and all platform/data checks."];
	const repaired = structuredClone(original);
	repaired.tasks[0].acceptanceCriteria = ["Deliver the authorized support matrix artifact with macOS, Linux, Windows support and all platform/data checks."];
	for (const authorized of [true, false]) {
		const input = buildPlanningArgs({ ...f.input, constraints: authorized ? f.input.constraints : [f.input.constraints[0]] });
		const workflow = withPlanningOwner(workflowWithResponses(input, {
			...f.responses, "plan:decomposer": original, "plan:synthesizer": original,
			"plan:verifier": { passed: false, issues: ["docs/matrix.md is outside the original source scope"] },
			"plan:semantic-repair": { ...repaired, constraints: input.constraints },
			"plan:conservation-review": authorized ? { passed: true, issues: [] } : { passed: false, issues: ["No originally authorized artifact disposition exists"] },
		}));
		const result = await runPlan(workflow);
		assert.equal(result.status, authorized ? "ready" : "needs-review");
		assert.deepEqual(readRecord(result.plan).tasks, repaired.tasks);
		assert.match(workflow.calls.at(-1)?.prompt ?? "", /ORIGINAL authority already permits/);
	}
});

test("SPR-03/04/18: repair-only engine reuses exact material; failure, fresh IDs and replays cannot regenerate", async () => {
	const f = fixture();
	const workflow = withPlanningOwner(workflowWithResponses(f.input, f.responses));
	await createPlanStore({ workspacePath: workflow.session.workspacePath }).list();
	const journal = createRepairJournal({ workspacePath: workflow.session.workspacePath, sessionId: workflow.session.sessionId });
	const material = repairMaterial({
		input: f.input, candidate: f.original.plan, critiques: f.original.critiques, diagnostics: f.failure.issues,
		verification: f.failure, decomposition: null, stage: "semantic",
	});
	const preparation = buildRepairPreparation({
		owner: workflow.session.workspacePath, sessionId: workflow.session.sessionId, rootRunId: "original-native-plan",
		sourceDigest: analysisInputDigest(f.original), material, mode: "recovery",
		repositoryPath: null, authority: null, source: null,
	});
	journal.prepare(preparation);
	journal.intent(preparation.id, preparation.digest);
	const result = await executeRepair(workflow, preparation, journal);
	assert.equal(result.verification?.passed, true);
	assert.deepEqual(workflow.calls.map(call => call.options.label), ["plan:semantic-repair", "plan:conservation-review"]);
	assert.deepEqual(journal.read(preparation.id, preparation.digest).preparation.material, material);
	await executeRepair(workflow, preparation, journal);
	assert.equal(workflow.calls.length, 2, "Completed execution replays retained output");
	await assert.rejects(executeRepair({ ...workflow, runId: "fresh-id" }, preparation, journal), { code: "repair_budget_spent" });
	assert.throws(() => journal.prepare(buildRepairPreparation({ ...preparation, rootRunId: "new-root" })), { code: "repair_budget_claimed" });

	const fatal = withPlanningOwner(createWorkflowContext(f.input, () => { throw new Error("Synthetic author failure"); }));
	await createPlanStore({ workspacePath: fatal.session.workspacePath }).list();
	const failedJournal = createRepairJournal({ workspacePath: fatal.session.workspacePath, sessionId: fatal.session.sessionId });
	const failed = buildRepairPreparation({ ...preparation, owner: fatal.session.workspacePath, mode: "inline", rootRunId: fatal.runId });
	failedJournal.prepare(failed);
	await assert.rejects(executeRepair(fatal, failed, failedJournal), /Synthetic author failure/);
	await assert.rejects(executeRepair(fatal, failed, failedJournal), { code: "repair_execution_held" });
	assert.equal(fatal.calls.length, 1);

	const interrupted = withPlanningOwner(createWorkflowContext(f.input, (_prompt, options) => {
		if (options.label === "plan:semantic-repair") return f.repaired;
		throw new Error("Synthetic reviewer interruption after retaining candidate");
	}));
	await createPlanStore({ workspacePath: interrupted.session.workspacePath }).list();
	const resumedJournal = createRepairJournal({ workspacePath: interrupted.session.workspacePath, sessionId: interrupted.session.sessionId });
	const resumable = buildRepairPreparation({ ...preparation, owner: interrupted.session.workspacePath, mode: "inline", rootRunId: interrupted.runId });
	resumedJournal.prepare(resumable);
	await assert.rejects(executeRepair(interrupted, resumable, resumedJournal), /Synthetic reviewer interruption/);
	assert.equal(resumedJournal.read(resumable.id, resumable.digest).state, "executing");
	const resumed = withPlanningOwner(workflowWithResponses(f.input, { "plan:conservation-review": { passed: true, issues: [] } }), interrupted.session.workspacePath);
	assert.equal((await executeRepair(resumed, resumable, resumedJournal)).verification?.passed, true);
	assert.deepEqual(resumed.calls.map(call => call.options.label), ["plan:conservation-review"]);
});
