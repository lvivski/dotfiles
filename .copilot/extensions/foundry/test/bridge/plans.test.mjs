import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildVerificationInput } from "../../analysis/verification.mjs";
import { createFactoryService } from "../../factory.mjs";
import { retryFailedPlan } from "../../plan/lifecycle.mjs";
import { validatePlan } from "../../plan/validation.mjs";
import { createPlanStore } from "../../storage.mjs";
import { must } from "../assertions.mjs";
import { factoryDocument } from "../factory/accessors.mjs";
import { COMMIT, DIGEST, fixture, source } from "./fixture.mjs";
import { canonicalBindings } from "../../plan/packages.mjs";
import { blueprintDigest, evaluationCriterion } from "../../bridge/pinning.mjs";
import { validateTaskTopology } from "../../plan/graph.mjs";
import { createFactoryBridge } from "../../bridge.mjs";

const nativeOwner = { sessionId: "coordinator", toolCallId: "technical-closure" };
const completionReview = "Reviewed the exact independently verified milestone delivery and remaining gates; technical closure only, not design acceptance or deployment.";
const completionAuthority = {
	instruction: "Delegate bounded technical milestone closure after independent verification passes; do not accept design, replace capabilities or deploy.",
	grantedBy: "requesting-user",
	source: { kind: "relayed-user", sessionId: "oversight", messageRef: "explicit-completion-instruction@revision:21", relayedBySessionId: "oversight" },
};

/** @param {Awaited<ReturnType<typeof fixture>>} f
 * @returns {import("../../types/parallel.js").PackageDecomposition} */
function decomposition(f) {
	const generation = f.factory.generation(f.candidate.id);
	const bindings = canonicalBindings({
		authority: "accepted-contract", repositoryId: f.factory.repository.id,
		unit: { id: generation.unit.id, revision: generation.unit.revision },
		contract: { revision: generation.contract.revision, digest: generation.contract.digest },
		requirements: generation.obligations.map(({ id, revision }) => ({ id, revision })),
		evaluators: generation.evaluations.map(({ id, revision, evaluation }) => ({
			id, revision, procedureDigest: evaluation.procedure.digest, requirements: evaluation.obligations,
			independent: evaluation.independent, modality: evaluation.modality,
		})),
		visualEvaluation: generation.unit.visualEvaluation ?? null,
	});
	return {
		format: "foundry-packages-v1", bindings, target: "product",
		packages: [
			{ id: "alpha", title: "Produce alpha", expectedFiles: ["alpha.json"], inputs: [],
				outputs: [{ id: "value", path: "alpha.json" }], requirements: [], evaluators: [] },
			{ id: "beta", title: "Produce beta", expectedFiles: ["beta.json"], inputs: [],
				outputs: [{ id: "value", path: "beta.json" }], requirements: [], evaluators: [] },
			{ id: "product", title: "Combine actual inputs", expectedFiles: ["product.json"],
				inputs: [
					{ producer: "alpha", output: "value", destination: "inputs/alpha.json" },
					{ producer: "beta", output: "value", destination: "inputs/beta.json" },
				], outputs: [{ id: "product", path: "product.json" }], requirements: bindings.requirements,
				evaluators: bindings.evaluators.map(({ id, revision }) => ({ id, revision })) },
		],
	};
}

/** @param {Awaited<ReturnType<typeof fixture>>} f @param {string} [id] */
const packageRequest = (f, id = "packages") => ({
	id, candidateId: f.candidate.id, expectedRevision: 0,
	repository: { workingDirectory: f.repo, baseBranch: "main" },
});

test("PF-PKG-01/02: bound factory plans compile actual package edges and canonical immutable bindings", async (t) => {
	const f = await fixture(t);
	const input = decomposition(f);
	const before = structuredClone(f.factory.generation(f.candidate.id));
	const plan = await f.ops.createFactoryPlan({ ...packageRequest(f), decomposition: input });
	assert.deepEqual(plan.tasks.map(({ id, kind, dependsOn }) => ({ id, kind, dependsOn })), [
		{ id: "T-001", kind: "implement", dependsOn: [] },
		{ id: "T-002", kind: "implement", dependsOn: [] },
		{ id: "T-003", kind: "implement", dependsOn: ["T-001", "T-002"] },
		{ id: "T-004", kind: "verify", dependsOn: ["T-003"] },
	]);
	const { targetTask, verifyTask } = validateTaskTopology(plan.tasks);
	assert.equal(targetTask?.deliveryRequirement, "commit");
	assert.deepEqual(verifyTask.expectedFiles, []);
	assert.deepEqual(verifyTask.acceptanceCriteria, []);
	assert.equal(plan.factory?.blueprintDigest, blueprintDigest(plan));
	assert.equal(plan.factory?.contractDigest, before.contract.digest);
	assert.deepEqual(f.factory.generation(f.candidate.id), before);
	const reordered = structuredClone(input);
	reordered.packages.reverse();
	for (const item of reordered.packages) {
		item.inputs.reverse(); item.outputs.reverse(); item.requirements.reverse(); item.evaluators.reverse();
	}
	reordered.bindings.requirements.reverse(); reordered.bindings.evaluators.reverse();
	const again = await f.ops.createFactoryPlan({ ...packageRequest(f), decomposition: reordered });
	assert.deepEqual(again, plan);
	assert.equal(f.factory.snapshot().bindings.length, 1);
	const changed = structuredClone(input);
	changed.packages[2].inputs[0].destination = "inputs/substituted.json";
	await assert.rejects(f.ops.createFactoryPlan({ ...packageRequest(f), decomposition: changed }), { code: "factory_plan_bound" });
});

test("PF-PKG-03: omitted decomposition preserves legacy tasks and binding; explicit invalid input never falls back", async (t) => {
	const f = await fixture(t);
	const generation = f.factory.generation(f.candidate.id);
	const plan = await f.ops.createFactoryPlan(packageRequest(f, "legacy-recipe"));
	assert.deepEqual(plan.tasks.map(({ id, title, dependsOn, acceptanceCriteria, expectedFiles }) =>
		({ id, title, dependsOn, acceptanceCriteria, expectedFiles })), [
		{ id: "T-001", title: "Produce a fresh candidate", dependsOn: [],
			acceptanceCriteria: generation.evaluations.map(evaluationCriterion), expectedFiles: [] },
		{ id: "T-002", title: "Independently evaluate the candidate", dependsOn: ["T-001"],
			acceptanceCriteria: [], expectedFiles: [] },
	]);
	assert.equal(plan.factory?.blueprintDigest, blueprintDigest(plan));
	assert.equal(plan.factory?.blueprintDigest, blueprintDigest({
		repository: plan.repository, title: `Reconstruct ${generation.unit.name}`, objective: generation.unit.purpose,
		constraints: [
			"Preserve the current accepted implementation until explicit replacement approval.",
			"Do not alter pinned obligations or evaluators to make the candidate pass.",
			"Use shared foundations through their conserved interfaces, not duplicate identity or authority stacks.",
		],
		tasks: [
			{
				id: "T-001", title: "Produce a fresh candidate", kind: "implement",
				description: `Produce candidate ${f.candidate.id} from sealed contract ${f.candidate.contractDigest}. The recovered specification is an input, implementation discoveries are outputs. Capture new observations or proposals without making them authority.`,
				dependsOn: [], acceptanceCriteria: generation.evaluations.map(evaluationCriterion),
				expectedFiles: [], deliveryRequirement: "commit",
			},
			{
				id: "T-002", title: "Independently evaluate the candidate", kind: "verify",
				description: "Evaluate every pinned procedure against the exact delivered commit. Report real output, environmental context, preservation and architectural failures. Do not repair the candidate or weaken the contract.",
				dependsOn: ["T-001"], acceptanceCriteria: [], expectedFiles: [], deliveryRequirement: "commit",
			},
		],
	}));
	const before = f.factory.snapshot().revision;
	for (const value of [null, [], {}, { ...decomposition(f), packages: [] }]) {
		await assert.rejects(f.ops.createFactoryPlan({ ...packageRequest(f, "invalid-packages"), decomposition: value }));
		assert.equal(f.factory.snapshot().revision, before, "Invalid decomposition must not reserve factory intent");
	}
	await assert.rejects(f.ops.createEvaluationPlan({
		...packageRequest(f, "invalid-evaluation-packages"), decomposition: decomposition(f),
	}), { code: "parallel_evaluation_decomposition" });
});

test("PF-PKG-04/05: every bound package plan retains governing evaluators, visual fidelity and separate human decisions", async (t) => {
	const f = await fixture(t, { human: true, visual: true });
	const input = decomposition(f);
	const generation = f.factory.generation(f.candidate.id);
	const plan = await f.ops.createFactoryPlan({ ...packageRequest(f), decomposition: input });
	const target = must(validateTaskTopology(plan.tasks).targetTask);
	const visual = evaluationCriterion(must(generation.evaluations.find((entry) => entry.id === "oracle")));
	assert.ok(target.acceptanceCriteria.includes(visual));
	assert.match(visual, /real output captures and independent reference-to-output assessment/);
	assert.ok(!plan.tasks.flatMap((task) => task.acceptanceCriteria).some((criterion) => criterion.includes("Pass pinned human")));
	assert.ok(plan.tasks.some((task) => task.description.includes("human-rubric")));
	const bridge = createFactoryBridge({
		workspace: () => path.join(f.root, "coordinator"), storeFor: f.ops.storeFor, notify: () => {},
		storageRoot: f.storageRoot,
	});
	for (const replacement of [[], ["Pass control behavior and geometry checks without native output captures."]]) {
		const tasks = plan.tasks.map(({ id, title, kind, description, dependsOn, acceptanceCriteria, expectedFiles, deliveryRequirement }) => ({
			id, title, kind, description, dependsOn, expectedFiles, deliveryRequirement,
			acceptanceCriteria: id === target.id ? acceptanceCriteria.filter((criterion) => criterion !== visual).concat(replacement) : acceptanceCriteria,
		}));
		await assert.rejects(bridge.createBoundDraft({
			...packageRequest(f, "geometry-cannot-replace-visual"),
			blueprint: { title: plan.title, objective: plan.objective, constraints: plan.constraints, tasks },
			factoryContext: bridge.context(f.repo, "unit"),
		}), { code: "factory_visual_required" });
	}
	for (const change of [
		{ visualEvaluation: null },
		{ contract: { revision: 1, digest: "f".repeat(64) } },
		{ evaluators: input.bindings.evaluators.map((entry) => ({ ...entry, procedureDigest: "f".repeat(64) })) },
		{ authority: "discovery-only", contract: null },
	]) {
		await assert.rejects(f.ops.createFactoryPlan({
			...packageRequest(f, "substituted-package"), decomposition: { ...input, bindings: { ...input.bindings, ...change } },
		}), { code: "parallel_binding_mismatch" });
	}
});

test("PF-PKG-04: decomposition cannot write protected evaluator support or consume comparison-only material", async (t) => {
	const f = await fixture(t);
	for (const filename of ["evaluators/check.mjs", "package-lock.json"]) {
		const input = decomposition(f);
		input.packages[0].expectedFiles = [filename];
		input.packages[0].outputs[0].path = filename;
		await assert.rejects(f.ops.createFactoryPlan({ ...packageRequest(f), decomposition: input }), /protected/i);
	}
	const { candidate } = f.mutate("prepareCandidate", {
		id: "comparison-candidate", unitId: "unit", contractRevision: 1, actor: "owner",
		context: { generation: [], comparisonOnly: [{ kind: "implementation", ref: "legacy.mjs", digest: "b".repeat(64) }],
			independence: { method: "fresh-session", reason: "Comparison remains outside generation" } },
	});
	const input = decomposition(f);
	input.packages[0].expectedFiles = ["legacy.mjs"];
	input.packages[0].outputs[0].path = "legacy.mjs";
	await assert.rejects(f.ops.createFactoryPlan({
		...packageRequest(f), candidateId: candidate.id, decomposition: input,
	}), /comparison/i);
	assert.equal(f.factory.snapshot().bindings.length, 0);
});

/** @param {Awaited<ReturnType<typeof fixture>>} f @param {import("../../types/plan.js").FoundryPlan} plan */
const grantCompletion = (f, plan) => f.ops.planApprovalDelegation({
	action: "grant", id: "technical-completion", approvalType: "completion",
	planId: plan.id, expectedRevision: plan.revision, authority: completionAuthority,
}, { invocation: { ...nativeOwner, toolCallId: "completion-grant" } });

test("explicit technical-completion delegation closes only the pinned verified milestone and is not transferable authority", async (t) => {
	const f = await fixture(t);
	let plan = await f.verify(f.ops, await f.implement(await f.generationPlan()));
	({ plan } = await f.finish(f.ops, plan, { complete: false }));
	const grant = must(await grantCompletion(f, plan));
	assert.equal(grant.scope.approvalType, "completion");
	assert.equal(grant.grant.statement, completionAuthority.instruction);
	assert.ok(grant.grant.method === "user-instruction-attestation");
	assert.deepEqual(grant.grant.source, completionAuthority.source);
	assert.equal(grant.grant.attestedBy, "agent-session:coordinator");
	assert.deepEqual(await grantCompletion(f, plan), grant);
	await assert.rejects(f.ops.approve({
		planId: plan.id, expectedRevision: plan.revision, delegationId: grant.id, review: completionReview,
	}, { invocation: nativeOwner }), { code: "delegation_out_of_scope" });
	const verification = structuredClone(plan.verification);
	const decisions = structuredClone(f.factory.snapshot().decisions);
	const request = { planId: plan.id, expectedRevision: plan.revision, approvalType: "completion", delegationId: grant.id, review: completionReview };
	const results = await Promise.allSettled([
		f.ops.approve(request, { invocation: nativeOwner }),
		f.ops.approve(request, { invocation: nativeOwner }),
	]);
	const success = results.find((result) => result.status === "fulfilled");
	assert.ok(success && success.status === "fulfilled");
	assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "revision_conflict").length, 1);
	plan = success.value;
	assert.equal(plan.status, "completed");
	assert.equal(plan.gates.planApprovedBy, "owner");
	assert.equal(plan.gates.completionApprovedBy, "agent-session:coordinator");
	assert.equal(plan.activity.at(-1)?.event, "completion-approved:delegated");
	assert.deepEqual(plan.verification, verification);
	assert.deepEqual(plan.gates.delegatedCompletion, {
		delegation: grant, planId: plan.id, planRevision: request.expectedRevision,
		blueprintDigest: plan.factory?.blueprintDigest, ...nativeOwner, review: completionReview,
		verification: { reservationId: verification.reservationId, runId: verification.runId, inputDigest: verification.inputDigest, targetCommit: COMMIT },
	});
	assert.equal(f.factory.snapshot().candidates[0].completion?.passed, true);
	assert.deepEqual(f.factory.snapshot().decisions, decisions, "Technical closure does not select or replace a capability");
	for (const changed of [{ runId: "another-run" }, { reservationId: "another-reservation" }, { inputDigest: "f".repeat(64) }, { targetCommit: "f".repeat(40) }]) {
		assert.throws(() => validatePlan({
			...plan, gates: { ...plan.gates, delegatedCompletion: {
				...plan.gates.delegatedCompletion, verification: { ...plan.gates.delegatedCompletion?.verification, ...changed },
			} },
		}), { code: "invalid_delegated_completion" });
	}
	await assert.rejects(f.ops.approve({ ...request, expectedRevision: plan.revision }, { invocation: nativeOwner }), { code: "delegation_verified_completion_required" });
	await f.ops.planApprovalDelegation({ action: "revoke", id: grant.id, reason: "Stop future closure" }, { invocation: nativeOwner });
	assert.deepEqual((await f.ops.getPlan({ planId: plan.id })).gates, plan.gates, "Revocation does not rewrite historical decisions");
	const importer = await f.createOps("import-only");
	const restored = await importer.importPlan({ source: await f.ops.exportPlan({ planId: plan.id }), expectedRevision: 0 });
	assert.deepEqual(restored.gates, plan.gates);
	assert.equal(await importer.storeFor().getApprovalDelegation(grant.id), null);
});

test("technical completion requires a separately recorded grant and cannot close incomplete or failed verification", async (t) => {
	const f = await fixture(t);
	let plan = await f.generationPlan();
	const grantRequest = { action: "grant", id: "technical-completion", approvalType: "completion", planId: plan.id, expectedRevision: plan.revision };
	await assert.rejects(f.ops.planApprovalDelegation(grantRequest, { invocation: nativeOwner }), { code: "delegation_instruction_required" });
	await assert.rejects(f.ops.planApprovalDelegation({ ...grantRequest, approvalType: "all", authority: completionAuthority }, { invocation: nativeOwner }), { code: "delegation_approval_type" });
	await assert.rejects(f.ops.planApprovalDelegation({ ...grantRequest, expectedRevision: plan.revision - 1, authority: completionAuthority }, { invocation: nativeOwner }), { code: "revision_conflict" });
	const grant = must(await grantCompletion(f, plan));
	const approve = () => f.ops.approve({ planId: plan.id, expectedRevision: plan.revision, approvalType: "completion", delegationId: grant.id, review: completionReview }, { invocation: nativeOwner });
	await assert.rejects(approve(), { code: "delegation_verified_completion_required" });
	plan = await f.verify(f.ops, await f.implement(plan));
	await assert.rejects(approve(), { code: "delegation_verified_completion_required" });
	({ plan } = await f.finish(f.ops, plan, { failed: true }));
	await assert.rejects(approve(), { code: "delegation_verified_completion_required" });
	assert.equal((await f.ops.getPlan({ planId: plan.id })).status, "failed");
});

test("legacy, revoked, foreign and stale evidence cannot authorize delegated technical completion", async (t) => {
	const f = await fixture(t);
	let plan = await f.generationPlan();
	const initial = must(await f.ops.planApprovalDelegation({
		action: "grant", id: "initial-only", planId: plan.id, expectedRevision: plan.revision, authority: {
			...completionAuthority, instruction: "Approve only initial execution plans.",
		},
	}, { invocation: nativeOwner }));
	const grant = must(await grantCompletion(f, plan));
	plan = await f.verify(f.ops, await f.implement(plan));
	({ plan } = await f.finish(f.ops, plan, { complete: false }));
	const request = { planId: plan.id, expectedRevision: plan.revision, approvalType: "completion", delegationId: grant.id, review: completionReview };
	const approve = () => f.ops.approve(request, { invocation: nativeOwner });
	await assert.rejects(f.ops.approve({ ...request, delegationId: "missing" }, { invocation: nativeOwner }), { code: "delegation_unavailable" });
	await assert.rejects(f.ops.approve({ ...request, expectedRevision: plan.revision - 1 }, { invocation: nativeOwner }), { code: "revision_conflict" });
	await assert.rejects(f.ops.approve(request), { code: "delegation_identity_required" });
	await assert.rejects(f.ops.approve(request, { invocation: { ...nativeOwner, sessionId: "foreign" } }), { code: "delegation_identity_required" });
	await assert.rejects(f.ops.approve({ ...request, review: "" }, { invocation: nativeOwner }), { code: "empty_string" });
	const db = new DatabaseSync(f.ops.storeFor().databasePath);
	try {
		const legacy = structuredClone(initial);
		delete legacy.scope.approvalType;
		db.prepare("UPDATE approval_delegations SET document = ? WHERE id = ?").run(JSON.stringify(legacy), legacy.id);
		await assert.rejects(f.ops.approve({ ...request, delegationId: legacy.id }, { invocation: nativeOwner }), { code: "delegation_out_of_scope" });
		assert.deepEqual(await f.ops.storeFor().getApprovalDelegation(legacy.id), legacy);
		for (const change of [
			{ owner: "foreign-owner" }, { repositoryId: "foreign-repo" }, { repositoryPath: `${f.repo}/other` },
			{ unitId: "another-unit" }, { unitRevision: 2 }, { contractDigest: "f".repeat(64) },
		]) {
			db.prepare("UPDATE approval_delegations SET document = ? WHERE id = ?").run(JSON.stringify({ ...grant, scope: { ...grant.scope, ...change } }), grant.id);
			await assert.rejects(approve(), { code: change.owner ? "delegation_foreign" : "delegation_out_of_scope" });
		}
		db.prepare("UPDATE approval_delegations SET document = ? WHERE id = ?").run(JSON.stringify(grant), grant.id);
		db.prepare("UPDATE plans SET document = ? WHERE id = ?").run(JSON.stringify({
			...plan, verification: { ...plan.verification, runId: null },
		}), plan.id);
		await assert.rejects(approve(), { code: "artifact_invalid" });
		for (const mutation of [
			{ ...plan, verification: { ...plan.verification, inputDigest: "f".repeat(64) } },
			{ ...plan, verification: { ...plan.verification, evidence: plan.verification.evidence.slice(1) } },
		]) {
			db.prepare("UPDATE plans SET document = ? WHERE id = ?").run(JSON.stringify(mutation), plan.id);
			await assert.rejects(approve(), { code: "delegation_verification_mismatch" });
		}
		const failedEvidence = structuredClone(plan);
		const report = must(must(failedEvidence.tasks.find((task) => task.kind === "verify")).attempts.at(-1));
		report.evidence[0].outcome = "failed";
		failedEvidence.verification.evidence = failedEvidence.verification.evidence.filter((id) => id !== report.evidence[0].id);
		failedEvidence.verification.inputDigest = buildVerificationInput(failedEvidence).inputDigest;
		db.prepare("UPDATE plans SET document = ? WHERE id = ?").run(JSON.stringify(failedEvidence), plan.id);
		await assert.rejects(approve(), { code: "delegation_verification_mismatch" });
		const stale = structuredClone(plan);
		must(stale.tasks[0].attempts.at(-1)).resultSummary = "Changed delivery after authoritative verification";
		db.prepare("UPDATE plans SET document = ? WHERE id = ?").run(JSON.stringify(stale), plan.id);
		await assert.rejects(approve(), { code: "factory_receipt_conflict" });
	} finally {
		db.prepare("UPDATE plans SET document = ? WHERE id = ?").run(JSON.stringify(plan), plan.id);
		db.close();
	}
	assert.equal((await f.ops.getPlan({ planId: plan.id })).revision, plan.revision);
	await f.ops.planApprovalDelegation({ action: "revoke", id: grant.id, reason: "Withdraw technical closure" }, { invocation: nativeOwner });
	await assert.rejects(approve(), { code: "delegation_unavailable" });
	await assert.rejects(grantCompletion(f, plan), { code: "delegation_conflict" });
	const manual = await f.ops.approve({ planId: plan.id, expectedRevision: plan.revision, approvalType: "completion", approvedBy: "explicit-human" });
	assert.equal(manual.status, "completed");
	assert.equal(manual.gates.completionApprovedBy, "explicit-human");
	assert.equal(manual.gates.delegatedCompletion, undefined);
});

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
	const draft = await f.ops.createFactoryPlan({
		id: "generate", candidateId: f.candidate.id, expectedRevision: 0, expectedFactoryRevision: f.factory.snapshot().revision,
		repository: { workingDirectory: f.repo, baseBranch: "main" }, expectedFiles: ["candidate/**"],
	});
	let plan = await f.verify(f.ops, await f.implement(await f.approve(f.ops, draft)));
	({ plan } = await f.finish(f.ops, plan, { failed: true }));
	const failed = structuredClone(f.factory.snapshot().candidates[0].completion);
	assert.equal(failed?.passed, false);
	const status = await f.ops.getStatus({ planId: plan.id });
	assert.ok(status.projection.actions.some((entry) => entry.kind === "prepare-fresh-candidate"));
	assert.ok(status.projection.actions.some((entry) => entry.kind === "create-evaluation-plan"));
	assert.equal(status.projection.actions.some((entry) => entry.kind === "approve-correction"), false);
	await assert.rejects(f.ops.approve({ planId: plan.id, expectedRevision: plan.revision, approvalType: "retry", approvedBy: "owner" }), { code: "factory_fresh_candidate_required" });
	const technical = must(await f.ops.planApprovalDelegation({
		action: "grant", id: "discovery-only-retry", approvalType: "technical",
		planId: plan.id, expectedRevision: plan.revision, technical: { kinds: ["retry"], agreement: null },
		authority: { ...completionAuthority, instruction: "Delegate bounded failed discovery corrections only; never retry a delivered candidate or bypass fresh lineage." },
	}, { invocation: nativeOwner }));
	const beforeTechnical = structuredClone(f.factory.snapshot());
	await assert.rejects(f.ops.approve({
		planId: plan.id, expectedRevision: plan.revision, approvalType: "retry", delegationId: technical.id,
		review: "A delivered candidate cannot become discovery merely by acquiring technical authority.",
		technical: { id: "invalid-delivered-retry", failures: [must(plan.verification.runId)] },
	}, { invocation: nativeOwner }), { code: "factory_fresh_candidate_required" });
	assert.deepEqual(f.factory.snapshot(), beforeTechnical);
	assert.deepEqual(await f.ops.getPlan({ planId: plan.id }), plan);
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
