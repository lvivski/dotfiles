import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildPlanningArgs, validatePlanBlueprint } from "../../analysis/planning.mjs";
import { assessDeterministicVerification, evaluateVerification } from "../../analysis/verdicts.mjs";
import { createFactoryBridge } from "../../bridge.mjs";
import { evaluationCheckId, evaluationCriterion } from "../../bridge/pinning.mjs";
import { visualCriterion } from "../../factory/visual.mjs";
import { isList, isRecord } from "../../data.mjs";
import { must } from "../assertions.mjs";
import { git } from "../git.mjs";
import { planningResult } from "../native/plans.mjs";
import { fixture, source } from "./fixture.mjs";

/** @param {Awaited<ReturnType<typeof fixture>>} f */
const bridgeFor = (f) => createFactoryBridge({
	workspace: () => path.join(f.root, "coordinator"), storeFor: () => f.ops.storeFor(), notify() {}, storageRoot: f.storageRoot,
});

test("capture framing retains every byte beyond the former image cap without claiming decoding or live perception", async (t) => {
	const f = await fixture(t, { visual: true });
	const original = await readFile(f.capturePath);
	const large = Buffer.concat([original, Buffer.alloc(8 * 1024 * 1024 + 1, 23)]);
	await writeFile(f.capturePath, large);
	let plan = await f.implement(await f.generationPlan());
	plan = await f.attach(f.ops, plan, "T-002");
	const payload = f.payload(plan, "T-002");
	const report = f.visualResult();
	report.states[0].capture.digest = createHash("sha256").update(large).digest("hex");
	payload.factoryEvaluations[0].report = JSON.stringify(report);
	plan = await f.ops.completeTask(payload);
	assert.equal(must(plan.tasks.find((task) => task.id === "T-002")).status, "done");
	assert.deepEqual(await readFile(f.capturePath), large);
	await writeFile(f.capturePath, Buffer.concat([large, Buffer.from([0])]));
	await assert.rejects(f.ops.approve({
		planId: plan.id, expectedRevision: plan.revision, approvalType: "completion", approvedBy: "owner",
	}), { code: "factory_visual_mismatch" });
});

test("multi-producer assurance uses the final governing criterion, never a passing producer check or package visual capture", async (t) => {
	for (const visual of [false, true]) await t.test(visual ? "synthetic visual gate only, not live perception" : "boundary evaluator", async (t) => {
		const f = await fixture(t, { visual });
		const bridge = bridgeFor(f);
		const entry = f.factory.generation(f.candidate.id).evaluations[0];
		const criterion = evaluationCriterion(entry);
		/** @param {string} id @param {string[]} dependsOn @param {string[]} acceptanceCriteria
		 * @param {"implement" | "verify"} [kind] @returns {import("../../types/plan.js").BlueprintTask} */
		const task = (id, dependsOn, acceptanceCriteria, kind = "implement") => ({
			id, title: `Gate-only fixture ${id}`, kind, description: "Synthetic multi-producer assurance routing; no live perception or native session execution is claimed.",
			dependsOn, acceptanceCriteria, expectedFiles: [], deliveryRequirement: "commit",
		});
		let plan = await f.approve(f.ops, await bridge.createBoundDraft({
			id: "combined-gate", repository: { workingDirectory: f.repo, baseBranch: "main" },
			blueprint: {
				title: "Multi-producer final assurance", objective: "Conserve the evaluator on the combined target", constraints: [],
				tasks: [
					task("T-001", [], [criterion]),
					task("T-002", [], ["Preserve the other producer input"]),
					task("T-003", ["T-001", "T-002"], ["Combine both producer deliveries", criterion]),
					task("T-004", ["T-003"], [], "verify"),
				],
			},
			factoryContext: bridge.context(f.repo, "unit"), candidateId: f.candidate.id, expectedRevision: 0,
		}));
		assert.equal(evaluationCheckId(plan, entry), "T-003-C002");
		for (const id of ["T-001", "T-002"]) {
			plan = await f.attach(f.ops, plan, id);
			plan = await f.ops.completeTask(f.payload(plan, id));
		}
		await writeFile(path.join(f.repo, "implementation.mjs"), "export const preserve = (input) => input.map(value => Object.assign({}, value));\n");
		git(f.repo, "add", "--", "implementation.mjs");
		git(f.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Isolated combined target");
		const finalCommit = git(f.repo, "rev-parse", "HEAD");
		assert.notEqual(finalCommit, f.commit);
		plan = await f.attach(f.ops, plan, "T-003");
		plan = await f.ops.completeTask(f.payload(plan, "T-003", { commit: finalCommit, evidence: [{
			type: "integration", summary: "Gate-only fixture combines both pinned producer commits",
			source: "isolated combined Git commit", outcome: "passed",
		}] }));
		plan = await f.attach(f.ops, plan, "T-004");
		const request = f.payload(plan, "T-004", { commit: finalCommit });
		if (visual) {
			assert.equal(f.visualResult().deliveryCommit, f.commit, "The synthetic package capture belongs to the predecessor commit");
			await assert.rejects(f.ops.completeTask(request), { code: "factory_visual_mismatch" });
			request.factoryEvaluations[0].report = JSON.stringify({ ...f.visualResult(), deliveryCommit: finalCommit });
		}
		const checks = request.evidence;
		assert.ok(isList(checks));
		const finalCheck = must(checks.find((check) => isRecord(check) && check.checkId === "T-003-C002"));
		const producerCheck = must(checks.find((check) => isRecord(check) && check.checkId === "T-001-C001"));
		assert.ok(isRecord(finalCheck) && isRecord(producerCheck));
		finalCheck.outcome = "failed";
		assert.throws(() => bridge.validateReports(plan, "T-004", request.factoryEvaluations, checks, finalCommit), { code: "factory_evidence_contradiction" });
		finalCheck.outcome = "passed";
		producerCheck.outcome = "failed";
		assert.doesNotThrow(() => bridge.validateReports(plan, "T-004", request.factoryEvaluations, checks, finalCommit),
			"The governing evaluator outcome follows the final criterion, not the first producer's claim");
		producerCheck.outcome = "passed";
		for (const criteria of [["Combine both producer deliveries"], [criterion, criterion]]) {
			const changed = structuredClone(plan);
			must(changed.tasks.find((task) => task.id === "T-003")).acceptanceCriteria = criteria;
			assert.throws(() => evaluationCheckId(changed, entry), { code: "factory_evaluation_coverage" });
		}
		const readOnly = {
			...plan, tasks: [{ ...must(plan.tasks.find((task) => task.id === "T-004")), dependsOn: [] }],
			evaluationTarget: { candidateId: f.candidate.id, commit: finalCommit,
				criteria: ["Retain the read-only delivery", criterion], evaluations: [{ id: entry.id, revision: entry.revision }] },
		};
		assert.equal(evaluationCheckId(readOnly, entry), "T-004-C002");
		plan = await f.ops.completeTask(request);
		assert.equal(must(plan.tasks.find((task) => task.id === "T-004")).status, "done");
		assert.equal(f.factory.snapshot().candidates[0].delivery?.commit, finalCommit);
	});
});

test("UI discovery without an accepted contract conserves the declared gate through generation, delivery and completion", async (t) => {
	const f = await fixture(t, { visual: true });
	const base = f.factory.snapshot().units[0];
	f.mutate("createUnit", { id: "initial-ui", name: "Initial UI", purpose: base.purpose, boundary: base.boundary,
		dependencies: [], relationshipCoverage: "complete", actor: "owner" });
	f.mutate("appendKnowledge", { id: "initial-intent", unitId: "initial-ui", kind: "obligation", statement: "Preserve the provided ordinary UI intent", source: source() });
	f.mutate("appendKnowledge", {
		id: "initial-visual", unitId: "initial-ui", kind: "evaluation", statement: "Compare actual rendered output, not controls", source: source(),
		evaluation: { ...must(f.factory.snapshot().knowledge.find((entry) => entry.id === "oracle")?.evaluation),
			obligations: [{ id: "initial-intent", revision: 1 }] },
	});
	f.mutate("createUnit", { id: "initial-ui", name: "Initial UI", purpose: base.purpose, boundary: base.boundary,
		dependencies: [], relationshipCoverage: "complete", actor: "owner", reason: "Explicitly declare UI output",
		visualEvaluation: { id: "initial-visual", revision: 1 } });
	const bridge = bridgeFor(f);
	const context = bridge.context(f.repo, "initial-ui");
	assert.equal(context.contract, null);
	const gate = must(context.visualEvaluation);
	const args = buildPlanningArgs({ objective: base.purpose, repositoryContext: "UI discovery", factoryContext: context, maxTasks: 2 });
	const blueprint = validatePlanBlueprint(planningResult(args).plan, 2);
	assert.throws(() => validatePlanBlueprint(blueprint, 2, gate), /exact declared visual fidelity criterion/);
	const create = () => bridge.createBoundDraft({
		id: "initial-visual-plan", repository: { workingDirectory: f.repo, baseBranch: "main" },
		blueprint, factoryContext: context, expectedRevision: 0,
	});
	await assert.rejects(create(), { code: "factory_visual_required" });
	blueprint.tasks[0].acceptanceCriteria.push(visualCriterion(gate));
	assert.deepEqual(validatePlanBlueprint(blueprint, 2, gate), blueprint);
	let plan = await f.approve(f.ops, await create());
	assert.equal(plan.factory?.candidateId, null);
	assert.equal(plan.factory?.contractDigest, null);
	const prompt = bridge.prompt(plan, plan.tasks[0]);
	assert.ok(prompt.includes(f.commit) && prompt.includes("evaluators/reference.svg"));
	assert.match(prompt, /Open\/render every actual reference/);
	assert.match(prompt, /Before implementation, preflight/);
	plan = await f.implement(plan);
	plan = await f.attach(f.ops, plan, "T-002");
	await assert.rejects(f.ops.completeTask(f.payload(plan, "T-002", { factoryEvaluations: [] })), { code: "factory_visual_required" });
	const payload = f.payload(plan, "T-002");
	payload.factoryEvaluations[0].evaluation.id = "initial-visual";
	plan = await f.ops.completeTask(payload);
	const finished = await f.finish(f.ops, plan);
	assert.equal(finished.plan.status, "completed");
	assert.equal(finished.input.factory.context.definitions.visualEvaluation?.id, gate.id);
	assert.equal(assessDeterministicVerification(finished.input).hardPassed, true);
	assert.equal(f.factory.snapshot().contracts.some((entry) => entry.unitId === "initial-ui"), false);
});

test("accepted reconstruction retains visual references and cannot omit the visual evaluator or satisfy it with geometry", async (t) => {
	const f = await fixture(t, { visual: true });
	const bridge = bridgeFor(f);
	let plan = await f.generationPlan();
	const gate = must(bridge.context(f.repo, "unit").visualEvaluation);
	assert.ok(plan.tasks[0].acceptanceCriteria.includes(visualCriterion(gate)));
	assert.deepEqual(f.factory.generation(f.candidate.id).evaluations[0].evaluation.visual, f.visualSpec);
	f.mutate("appendKnowledge", { id: "nonvisual", unitId: "unit", kind: "evaluation", statement: "Nonvisual boundary", source: source(),
		evaluation: { ...must(f.factory.snapshot().knowledge.find((entry) => entry.id === "oracle")?.evaluation), visual: undefined } });
	assert.throws(() => f.mutate("acceptContract", {
		unitId: "unit", unitRevision: 2, obligations: [{ id: "obligation", revision: 1 }],
		evaluations: [{ id: "nonvisual", revision: 1 }], actor: "owner", reason: "Attempt to omit declared UI gate",
	}), { code: "factory_visual_required" });
	plan = await f.implement(plan);
	plan = await f.attach(f.ops, plan, "T-002");
	const request = f.payload(plan, "T-002");
	const report = request.factoryEvaluations[0];
	await assert.rejects(f.ops.completeTask({ ...request, factoryEvaluations: [] }), { code: "factory_evaluation_coverage" });
	await assert.rejects(f.ops.completeTask({ ...request, factoryEvaluations: [{ ...report, report: "Palette, geometry and controls pass; screenshot permission denied." }] }), { code: "factory_visual_required" });
	assert.ok(f.factory.snapshot().knowledge.some((entry) => entry.statement.includes("Rejected task report (factory_visual_required)")));
	for (const change of [
		{ deliveryCommit: "f".repeat(40) }, { environment: "different-platform" }, { states: [] },
		{ states: [{ ...f.visualResult().states[0], referenceDigest: "f".repeat(64) }] },
		{ states: [{ ...f.visualResult().states[0], capture: { ...f.visualResult().states[0].capture, digest: "f".repeat(64) } }] },
		{ states: [{ ...f.visualResult().states[0], capture: { ...f.visualResult().states[0].capture, digest: f.visualSpec.states[0].reference.digest } }] },
		{ states: [{ ...f.visualResult().states[0], capture: { ...f.visualResult().states[0].capture, path: `${f.capturePath}.missing` } }] },
		{ states: [{ ...f.visualResult().states[0], capture: null, blocker: "OS screenshot permission denied" }] },
	]) {
		await assert.rejects(f.ops.completeTask({ ...request, factoryEvaluations: [{
			...report, report: JSON.stringify({ ...f.visualResult(), ...change }),
		}] }));
	}
	const bytes = await readFile(f.capturePath);
	await writeFile(f.capturePath, "controls and geometry: passed");
	const counterfeit = f.visualResult();
	counterfeit.states[0].capture.digest = createHash("sha256").update("controls and geometry: passed").digest("hex");
	await assert.rejects(f.ops.completeTask({ ...request, factoryEvaluations: [{ ...report, report: JSON.stringify(counterfeit) }] }), { code: "factory_visual_artifact" });
	await writeFile(f.capturePath, bytes);
	plan = await f.ops.completeTask(request);
	const finished = await f.finish(f.ops, plan, { complete: false });
	const invocation = { sessionId: "coordinator", toolCallId: "visual-technical-closure" };
	const grant = must(await f.ops.planApprovalDelegation({
		action: "grant", id: "visual-completion", approvalType: "completion", planId: plan.id, expectedRevision: finished.plan.revision,
		authority: { instruction: "Delegate technical closure after the declared visual and independent evidence gates pass.", grantedBy: "requesting-user",
			source: { kind: "direct-user", sessionId: "coordinator", messageRef: "fixture-explicit-visual-completion" } },
	}, { invocation }));
	const delegated = { planId: plan.id, expectedRevision: finished.plan.revision, approvalType: "completion", delegationId: grant.id,
		review: "Reviewed the exact independently verified delivery and all visual findings; technical closure, not human design acceptance." };
	await writeFile(f.capturePath, "changed after independent verification");
	await assert.rejects(f.ops.approve({ planId: plan.id, expectedRevision: finished.plan.revision, approvalType: "completion", approvedBy: "owner" }), { code: "factory_visual_artifact" });
	await assert.rejects(f.ops.approve(delegated, { invocation }), { code: "factory_visual_artifact" });
	await writeFile(f.capturePath, bytes);
	assert.equal((await f.ops.approve(delegated, { invocation })).status, "completed");
	await writeFile(f.capturePath, "missing original evidence at replacement decision");
	assert.throws(() => f.mutate("decideCandidate", {
		candidateId: f.candidate.id, action: "accept", expectedIncumbentId: null, actor: "owner", reason: "Cannot accept changed visual artifacts",
	}), { code: "factory_visual_artifact" });
});

test("independent visual failures and blocked captures remain failed evidence, never completion or replacement", async (t) => {
	for (const blocked of [false, true]) await t.test(blocked ? "permission-blocked capture" : "reference mismatch", async (t) => {
		const f = await fixture(t, { visual: true });
		let plan = await f.implement(await f.generationPlan());
		plan = await f.attach(f.ops, plan, "T-002");
		const payload = f.payload(plan, "T-002");
		const result = f.visualResult();
		result.states[0].assessment.composition = { outcome: "failed", finding: "Output has two header rows and simultaneous lists; the reference has one navigation row and a single main pane." };
		const failed = blocked ? { ...result, states: [{ ...result.states[0], capture: null, blocker: "Native screenshot permission denied; no bypass attempted" }] } : result;
		payload.factoryEvaluations[0] = { ...payload.factoryEvaluations[0], outcome: "failed", report: JSON.stringify(failed) };
		assert.ok(isList(payload.evidence));
		const visualCheck = must(payload.evidence.find((entry) => isRecord(entry) && entry.checkId === "T-001-C001"));
		assert.ok(isRecord(visualCheck));
		visualCheck.outcome = "failed";
		plan = await f.ops.completeTask(payload);
		const finished = await f.finish(f.ops, plan, { failed: true });
		assert.equal(finished.plan.status, "failed");
		assert.equal(assessDeterministicVerification(finished.input).hardPassed, false);
		assert.ok(assessDeterministicVerification(finished.input).hardGaps.some((gap) => gap.summary.includes("visual")));
		assert.equal(evaluateVerification(finished.input, {
			passed: true, summary: "Functional controls pass", missingEvidence: [], correctionTaskIds: [],
			evidenceIds: finished.input.verificationReport.evidence.filter((entry) => entry.outcome === "passed").map((entry) => entry.id),
			reviews: [{ missingEvidence: [], integrationFindings: [] }, { missingEvidence: [], integrationFindings: [] }],
		}).outcome.passed, false);
		assert.ok(f.factory.inspect().candidates[0].assurance.missing.some((gap) => gap.includes("failed")));
		await assert.rejects(f.ops.approve({ planId: plan.id, expectedRevision: finished.plan.revision, approvalType: "completion", approvedBy: "owner" }));
		assert.throws(() => f.mutate("decideCandidate", {
			candidateId: f.candidate.id, action: "accept", expectedIncumbentId: null, actor: "owner", reason: "Cannot ignore a visual failure",
		}));
	});
});

test("reference bytes are checked at declaration and legacy/backend authority is not inferred as UI", async (t) => {
	const f = await fixture(t, { visual: true });
	const definition = must(f.factory.snapshot().knowledge.find((entry) => entry.id === "oracle")?.evaluation);
	for (const reference of [
		{ path: "evaluators/reference.svg", digest: "f".repeat(64) },
		{ path: "evaluators/check.mjs", digest: createHash("sha256").update(await readFile(path.join(f.repo, "evaluators/check.mjs"))).digest("hex") },
		{ path: "unpreserved/reference.svg", digest: f.visualSpec.states[0].reference.digest },
	]) assert.throws(() => f.mutate("appendKnowledge", {
		id: "invalid-visual", unitId: "unit", kind: "evaluation", statement: "Invalid reference", source: source(),
		evaluation: { ...definition, visual: { ...f.visualSpec, states: [{ ...f.visualSpec.states[0], reference }] } },
	}));
	assert.equal(f.factory.snapshot().units[0].visualEvaluation, undefined, "Historical unit revision is not retroactively made visual");
	const backend = await fixture(t);
	const plan = await backend.generationPlan();
	assert.equal(bridgeFor(backend).context(backend.repo, "unit").visualEvaluation, undefined);
	assert.doesNotMatch(bridgeFor(backend).prompt(plan, plan.tasks[0]), /DECLARED-VISUAL-GATE/);
	assert.equal((await backend.finish(backend.ops, await backend.verify(backend.ops, await backend.implement(plan)))).plan.status, "completed");
});
