import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanningArgs } from "../../analysis/planning.mjs";
import { buildRepairEffect, buildRepairPreparation, compareRepairProgress, planningVerdict, repairComparisonState, repairMaterial } from "../../analysis/repair.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { createRepairJournal } from "../../storage/repair.mjs";
import { admitRepairEffect } from "../../native/repair.mjs";
import { run as runPlan } from "../../workflows/plan.mjs";
import { executeRepair, planningSchema } from "../../workflows/repair.mjs";
import { planningResult, repairWorkflowHost, withPlanningOwner } from "../native/plans.mjs";
import { workflowWithResponses } from "./runtime.mjs";
import { readJsonValue, readRecord } from "../../data.mjs";
import { deferred } from "../promises.mjs";
/** @typedef {import("../../types/repair.js").RepairComparisonState} Comparison */

function fixture() {
	const input = buildPlanningArgs({
		objective: "Preserve platform checks, data, and independent final confirmation",
		constraints: ["Only src/change.mjs may change. Local commits only; no merges."],
		repositoryContext: "Support macOS/Linux/Windows and unchanged data.", maxTasks: 1,
	});
	const original = planningResult(input);
	original.plan.tasks[0].acceptanceCriteria = ["T-002 confirms all platform checks and conserved data before T-001 completes."];
	const repaired = structuredClone(original.plan);
	repaired.tasks[0].acceptanceCriteria = ["Producer supplies platform/data evidence; T-002 independently confirms after delivery."];
	const failure = { passed: false, issues: ["Producer waits for its dependent verifier."] };
	const responses = {
		"plan:decomposer": original.plan, "plan:synthesizer": original.plan,
		"plan:architecture-critic": original.critiques[0], "plan:delivery-risk-critic": original.critiques[1],
		"plan:verifier": failure, "plan:semantic-repair": repaired, "plan:conservation-review": { passed: true, issues: [] },
	};
	return { input, original, repaired, failure, responses };
}

/** @param {string} id */
function identity(id) { return { agentId: `${id}-agent`, toolCallId: `${id}-call`, runId: `${id}-run` }; }
/** @param {("unresolved"|"supported"|"uncertain")[]} statuses @param {string} label @returns {Comparison} */
function comparison(statuses, label) {
	return {
		format: "foundry-repair-comparison-v1", protected: { evaluator: "frozen", input: "frozen" },
		candidateDigest: analysisInputDigest(label), diagnosticsDigest: "d".repeat(64),
		contributors: [identity("author")], reviewer: identity(`review-${label}`),
		obligations: statuses.map((status, index) => ({
			id: `O-${index}`, evaluatorId: `E-${index}`, evaluatorDigest: "e".repeat(64), inputDigest: "f".repeat(64),
			status, evidence: status === "supported" ? [{
				id: `evidence-${index}`, digest: analysisInputDigest(index), evaluatorId: `E-${index}`, inputDigest: "f".repeat(64),
				producer: identity(`independent-${index}`), causalFor: [`O-${index}`],
			}] : [],
		})),
	};
}

test("LP08/09: substantive comparator progresses against every retained state without a universal repair count", () => {
	const first = comparison(["unresolved", "unresolved"], "first");
	const second = comparison(["supported", "unresolved"], "second");
	const third = comparison(["supported", "supported"], "third");
	assert.equal(compareRepairProgress(second, [first]).passed, true);
	assert.equal(compareRepairProgress(third, [first, second]).passed, true);
	assert.deepEqual(compareRepairProgress(third, [first, second]).resolved, ["O-1"]);
	assert.equal(compareRepairProgress(second, [first, second, third]).passed, false);
	const cosmetic = structuredClone(second);
	cosmetic.candidateDigest = analysisInputDigest("rewritten prose/new effect ID/timestamps");
	cosmetic.obligations.reverse();
	cosmetic.reviewer = identity("new-review");
	assert.equal(compareRepairProgress(cosmetic, [first, second]).passed, false);
	second.obligations[0].evidence[0].causalFor = ["O-0", "O-1"];
	third.obligations[0].evidence[0].causalFor = ["O-1", "O-0"];
	assert.equal(compareRepairProgress(third, [first, second]).passed, true);
});

test("LP08/09: evidence-only growth cannot renew a resolution already supported in the latest predecessor", () => {
	const baseline = comparison(["unresolved", "unresolved"], "baseline");
	const latest = comparison(["supported", "unresolved"], "latest");
	const next = structuredClone(latest);
	next.candidateDigest = analysisInputDigest("additional evidence, same outstanding obligation");
	next.reviewer = identity("new-evidence-review");
	next.obligations[0].evidence.push({
		...next.obligations[0].evidence[0],
		id: "additional-supported-evidence", digest: analysisInputDigest("additional independent evidence"),
		producer: identity("additional-independent"),
	});
	assert.equal(compareRepairProgress(next, [baseline, latest]).passed, false);
	assert.deepEqual(compareRepairProgress(next, [baseline, latest]).resolved, []);
});

test("LP08/09/15: regression, substitutions, missing/uncertain evidence and contributor reviewers hold", () => {
	const first = comparison(["unresolved", "unresolved"], "first");
	const second = comparison(["supported", "unresolved"], "second");
	/** @type {Array<(state: Comparison) => void>} */
	const changes = [
		state => { state.protected.evaluator = "replacement"; },
		state => { state.obligations[0].evaluatorId = "replacement"; },
		state => { state.obligations[0].inputDigest = "a".repeat(64); },
		state => { state.obligations[0].status = "unresolved"; state.obligations[0].evidence = []; },
		state => { state.obligations[0].evidence = []; },
		state => { state.obligations[1].status = "uncertain"; },
		state => { state.obligations.pop(); },
		state => { state.reviewer = identity("author"); },
		state => { state.reviewer = first.reviewer; },
		state => { state.obligations[1].evidence[0].producer = identity("author"); },
		state => { state.obligations[1].evidence[0].causalFor = ["unrelated"]; },
		state => { state.obligations[1].evidence[0].id = state.obligations[0].evidence[0].id; },
	];
	for (const mutate of changes) {
		const next = comparison(["supported", "supported"], "next");
		mutate(next);
		assert.equal(compareRepairProgress(next, [first, second]).passed, false);
	}
	assert.equal(compareRepairProgress(comparison(["supported", "supported"], "next"), [null, first]).passed, false);
	assert.equal(compareRepairProgress(comparison(["supported"], "next"), []).passed, false);
});

test("LP08/15: planning and review prose/collections retain complete former-overflow evidence", () => {
	const issues = Array.from({ length: 140 }, (_, i) => `${i}: ${"full evidence ".repeat(1600)}`);
	assert.deepEqual(planningVerdict({ passed: false, issues }).issues, issues);
	const schema = planningSchema();
	assert.equal(Object.hasOwn(schema.properties.title, "maxLength"), false);
	assert.equal(Object.hasOwn(schema.properties.tasks, "maxItems"), false);
	const fields = schema.properties.tasks.items.properties;
	for (const key of /** @type {const} */ (["dependsOn", "acceptanceCriteria", "expectedFiles"])) assert.equal(Object.hasOwn(fields[key], "maxItems"), false);
	assert.equal(planningSchema(1).properties.tasks.maxItems, 2);
});

test("LP10/11/16: default unavailable provider holds before author or SDK fallback", async () => {
	const f = fixture();
	const workflow = withPlanningOwner(workflowWithResponses(f.input, f.responses));
	const result = await runPlan(workflow);
	assert.equal(result.status, "needs-review");
	assert.equal(result.synthesisRepair, null);
	assert.match(result.issues.join("\n"), /authentic atomic native admission/);
	assert.equal(workflow.calls.length, 5);
});

test("LP08-12/15/16: production execution seam uses reviewed proposed effects, durable native claims and exact replay", async t => {
	const f = fixture();
	const workflow = withPlanningOwner(workflowWithResponses(f.input, f.responses));
	const native = await repairWorkflowHost(workflow);
	t.after(native.close);
	const result = await runPlan(workflow, native.host);
	assert.equal(result.status, "ready");
	assert.ok(result.synthesisRepair);
	assert.deepEqual(result.synthesisRepair.originalVerification, f.failure);
	assert.equal(native.remaining(), 18);
	assert.deepEqual(workflow.calls.slice(-2).map(call => call.options.label), ["plan:semantic-repair", "plan:conservation-review"]);
	for (const { prompt } of workflow.calls.slice(-2)) {
		for (const value of [f.input.objective, f.input.repositoryContext, ...f.failure.issues]) assert.ok(prompt.includes(value));
		assert.match(prompt, /never require a downstream task before producer completion/);
	}
	assert.ok("repairBudget" in result);
	const budget = /** @type {import("../../types/repair.js").RepairOutcome["repairBudget"]} */ (result.repairBudget);
	const journal = createRepairJournal({ workspacePath: workflow.session.workspacePath, sessionId: workflow.session.sessionId });
	const preparation = journal.read(budget.preparationId, budget.preparationDigest).preparation;
	const replay = await executeRepair(workflow, preparation, journal, "", native.host);
	assert.deepEqual(replay.recovery, readRecord(result).recovery);
	assert.equal(native.remaining(), 18);
	assert.equal(workflow.calls.length, 7);
	assert.equal(journal.events(preparation.id, preparation.digest).filter(event => event.event === "effect-review").length, 2);
});

test("LP09/15: an authentic comparison still holds when its reviewer substitutes the admitted native identity", async t => {
	const f = fixture();
	const workflow = withPlanningOwner(workflowWithResponses(f.input, f.responses));
	const native = await repairWorkflowHost(workflow);
	t.after(native.close);
	/** @type {import("../../types/repair.js").RepairHostPort} */
	const host = {
		...native.host,
		async observeCandidate(...args) {
			const state = repairComparisonState(await native.host.observeCandidate(...args));
			state.reviewer = identity("substituted-native-review");
			return native.attest(state);
		},
	};
	const result = await runPlan(workflow, host);
	assert.equal(result.status, "needs-review");
	assert.match(JSON.stringify(result), /substituted admitted native contributor\/reviewer identities/);
	assert.equal(native.remaining(), 18);
	assert.equal(workflow.calls.length, 7);
});

/** @param {import("node:test").TestContext} t */
async function admissionFixture(t) {
	const f = fixture();
	const workflow = withPlanningOwner(workflowWithResponses(f.input, f.responses));
	const native = await repairWorkflowHost(workflow);
	t.after(native.close);
	const material = repairMaterial({ input: f.input, candidate: f.original.plan, critiques: f.original.critiques,
		diagnostics: f.failure.issues, verification: f.failure, stage: "semantic", decomposition: null });
	const preparation = buildRepairPreparation({ owner: workflow.session.workspacePath, sessionId: workflow.session.sessionId,
		rootRunId: "source", sourceDigest: analysisInputDigest(f.original), mode: "recovery", repositoryPath: null,
		authority: null, source: null, material });
	const baseline = await native.host.prepare(preparation);
	const journal = createRepairJournal({ workspacePath: workflow.session.workspacePath, sessionId: workflow.session.sessionId });
	journal.prepare(preparation, readJsonValue(baseline));
	const history = journal.comparisonHistory(preparation.id, preparation.digest);
	const effect = buildRepairEffect(preparation, "author", history, material.candidate, material.diagnostics, workflow.runId, { label: "plan:semantic-repair" });
	return { native, journal, effect, history, preparation };
}

test("LP10-12: concurrent duplicate effects receive the matching once receipt without duplicate native execution", async t => {
	const f = await admissionFixture(t);
	let calls = 0;
	const admitted = deferred();
	const output = deferred();
	const first = admitRepairEffect(f.native.host, f.journal, f.effect, f.history, async () => { calls++; admitted.resolve(undefined); return output.promise; });
	await admitted.promise;
	const second = admitRepairEffect(f.native.host, f.journal, f.effect, f.history, async () => { calls++; return {}; });
	output.resolve({ complete: true });
	assert.deepEqual(await first, await second);
	assert.equal(calls, 1);
	assert.equal(f.native.remaining(), 19);
});

test("LP10/11/16: action-time revocation, cancellation, provider or approval drift denies before invocation", async t => {
	for (const key of /** @type {const} */ (["revocation", "cancellation", "provider", "approval", "revision", "authority", "budgets", "resources"])) {
		const f = await admissionFixture(t);
		const originalReview = f.native.host.review;
		f.native.host.review = async (...args) => {
			const result = await originalReview(...args);
			f.native.checks[key] = false;
			return result;
		};
		let invoked = false;
		await assert.rejects(admitRepairEffect(f.native.host, f.journal, f.effect, f.history, async () => { invoked = true; return {}; }), { code: "repair_admission_held" });
		assert.equal(invoked, false);
		assert.equal(f.native.remaining(), 20);
	}
});
