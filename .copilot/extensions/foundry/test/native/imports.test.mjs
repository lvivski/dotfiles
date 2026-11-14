import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildPlanningArgs } from "../../analysis/planning.mjs";
import { buildVerificationInput } from "../../analysis/verification.mjs";
import { verificationMarker } from "../../marker.mjs";
import { FoundryWorkflowError } from "../../native/guards.mjs";
import { createWorkflowAnalysis } from "../../workflow.mjs";
import { fakeApi } from "./api.mjs";
import { completedPlan, planningResult, repairNativeFixture, reservedPlan } from "./plans.mjs";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { readJsonValue, readRecord } from "../../data.mjs";
import { repairMarker } from "../../native/repair.mjs";
import { run as runPlan } from "../../workflows/plan.mjs";
import { workflowWithResponses } from "../workflows/runtime.mjs";
import { buildRepairPreparation, repairAuthority, repairObject } from "../../analysis/repair.mjs";

test("SPR-02/03/16/19: ordinary structural and semantic repairs import only with their original owner journal", async t => {
	for (const structural of [false, true]) {
		await t.test(structural ? "structural" : "semantic", async t => {
			const f = await repairNativeFixture(t);
			const original = structuredClone(f.original.plan);
			if (structural) original.title = "";
			const workflow = workflowWithResponses(f.input, {
				"plan:decomposer": f.original.plan, "plan:synthesizer": original,
				"plan:architecture-critic": f.original.critiques[0], "plan:delivery-risk-critic": f.original.critiques[1],
				"plan:verifier": structural ? { passed: true, issues: [] } : f.original.verification,
				"plan:synthesis-repair": f.repaired, "plan:semantic-repair": f.repaired,
				"plan:conservation-review": { passed: true, issues: [] },
			});
			const result = await runPlan({ ...workflow, runId: "source", session: f.session }, f.nativeHost.host);
			assert.equal(result.status, "ready");
			f.records.source.run.result = result;
			f.labels.source = workflow.calls.map(call => call.options.label);
			const request = { id: "ordinary-repaired", expectedRevision: 0, repository: { workingDirectory: f.repositoryPath, baseBranch: "main" }, runId: "source" };
			const draft = await f.createOps(false).createPlan(request, f.context);
			assert.equal(draft.status, "draft");
			assert.equal(draft.gates.planApprovedBy, null);
			assert.equal(draft.factory?.owner, f.owner);
			assert.equal(f.launches.length, 0);
			await assert.rejects(f.prepare(), { code: "repair_source_ineligible" });
			const budget = readRecord(readRecord(result).repairBudget);
			f.records.source.run.result = { ...result, repairBudget: { ...budget, rootRunId: "forged" } };
			await assert.rejects(f.ops.createPlan({ ...request, id: "forged-repair" }, f.context), { code: "repair_native_identity" });
			f.records.source.run.result = { ...result, synthesisRepair: { ...readRecord(result.synthesisRepair), diagnostic: "Substituted history" } };
			await assert.rejects(f.ops.createPlan({ ...request, id: "substituted-repair" }, f.context), { code: "repair_import_held" });
		});
	}
});

test("SPR-08/09/13/15/16/19: legacy semantic recovery binds native source, exact launch and ordinary draft gates", async t => {
	const f = await repairNativeFixture(t);
	const before = structuredClone(f.records.source);
	await assert.rejects(f.ops.createPlan({ id: "original-rejected", expectedRevision: 0, repository: { workingDirectory: f.repositoryPath, baseBranch: "main" }, runId: "source" }), { code: "analysis_needs_review" });
	const prepared = await f.prepare();
	assert.equal(prepared.state, "prepared");
	assert.equal(f.launches.length, 0);
	assert.deepEqual(await f.prepare(), prepared);
	const retained = f.journal().read(prepared.preparationId, prepared.preparationDigest).preparation;
	assert.equal(retained.sourceDigest, analysisInputDigest(f.original));
	assert.equal(retained.inputDigest, f.input.inputDigest);
	assert.deepEqual(retained.material.input, f.input);
	assert.deepEqual(retained.material.critiques, f.original.critiques);
	await f.ops.launchPlanRepair(prepared.launchSpec.args, f.context);
	assert.equal(f.launches.length, 1);
	assert.equal(f.launches[0].name, "run_dynamic_workflow");
	assert.deepEqual(f.launches[0].arguments, prepared.launchSpec);
	assert.match(f.launches[0].toolCallId ?? "", /^repair-[a-f0-9]{64}$/);
	assert.equal(Object.hasOwn(prepared.launchSpec, "limits"), false);
	const executed = await f.execute(prepared);
	assert.equal(executed.result.status, "ready");
	assert.deepEqual(executed.workflow.calls.map(call => call.options.label), ["plan:semantic-repair", "plan:conservation-review"]);
	await assert.rejects(f.ops.importPlanRepair({
		...prepared.launchSpec.args, effectId: "f".repeat(64), id: "repaired-draft",
		repository: { workingDirectory: f.repositoryPath, baseBranch: "main" },
		runId: "repair-native-run", expectedRevision: 0,
	}, f.context), { code: "repair_effect_conflict" });
	const draft = await f.ops.importPlanRepair({
		...prepared.launchSpec.args, id: "repaired-draft", repository: { workingDirectory: f.repositoryPath, baseBranch: "main" },
		runId: "repair-native-run", expectedRevision: 0,
	}, f.context);
	assert.equal(draft.status, "draft");
	assert.equal(draft.revision, 1);
	assert.equal(draft.gates.planApprovedBy, null);
	assert.equal((await f.ops.submitPlan({ planId: draft.id, expectedRevision: draft.revision })).status, "awaiting-approval");
	assert.deepEqual(f.records.source, before, "All original status, input, critics and failed-verifier output remain immutable");
	assert.equal(f.launches.length, 1);
	await assert.rejects(f.analysis.controlWorkflow("repair-native-run", "resume"), { code: "workflow_not_resumable" });
	await assert.rejects(f.analysis.importAnalysis("repair-native-run"), { code: "workflow_analysis_required" });
});

test("SPR-10/13/20: current owner, canonical path, digest and authority guard admission", async t => {
	const f = await repairNativeFixture(t);
	const foreignInput = buildPlanningArgs({ ...f.input, factoryContext: { ...f.input.factoryContext, owner: "foreign-owner" } });
	f.records.source.run.result = { ...f.original, input: foreignInput, inputDigest: foreignInput.inputDigest };
	await assert.rejects(f.prepare(), { code: "repair_foreign_owner" });
	f.records.source.run.result = f.original;
	await assert.rejects(f.ops.preparePlanRepair({ runId: "source", repositoryPath: `${f.repositoryPath}/.` }, f.context), { code: "repair_repository_changed" });
	const prepared = await f.prepare();
	await assert.rejects(f.ops.launchPlanRepair({ ...prepared.launchSpec.args, preparationDigest: "f".repeat(64) }, f.context), { code: "repair_identity_mismatch" });
	const controller = new AbortController();
	controller.abort(new Error("Synthetic pre-admission interruption"));
	await assert.rejects(f.ops.launchPlanRepair(prepared.launchSpec.args, { ...f.context, signal: controller.signal }), /Synthetic pre-admission interruption/);
	assert.equal(f.journal().read(prepared.preparationId, prepared.preparationDigest).state, "prepared");
	const unit = f.factory.snapshot().units[0];
	f.mutate("createUnit", { id: unit.id, name: unit.name, purpose: `${unit.purpose}; revised`, boundary: unit.boundary, dependencies: [], relationshipCoverage: "complete", actor: "synthetic-owner", reason: "Synthetic pre-admission drift" });
	await assert.rejects(f.ops.launchPlanRepair(prepared.launchSpec.args, f.context), { code: "repair_authority_stale" });
	assert.equal(f.launches.length, 0);
});

test("SPR-13/20: a missing offered executor holds the claim without fallback or invented permission", async t => {
	const f = await repairNativeFixture(t);
	const prepared = await f.prepare();
	await assert.rejects(f.createOps(false).launchPlanRepair(prepared.launchSpec.args, f.context), { code: "repair_invocation_unavailable" });
	assert.equal(f.journal().read(prepared.preparationId, prepared.preparationDigest).state, "unavailable");
	assert.equal(f.launches.length, 0);
	await assert.rejects(f.ops.launchPlanRepair(prepared.launchSpec.args, f.context), { code: "repair_admission_held" });
	assert.throws(() => f.journal().outcome(prepared.preparationId, prepared.preparationDigest, "admitted", "unapproved", { claim: "manual replacement" }), { code: "repair_admission_held" });
});

test("SPR-13/15/20: a contradictory late denial preserves completed output but blocks import and reconciliation", async t => {
	const f = await repairNativeFixture(t);
	const prepared = await f.prepare();
	await f.ops.launchPlanRepair(prepared.launchSpec.args, f.context);
	await f.execute(prepared);
	f.journal().outcome(prepared.preparationId, prepared.preparationDigest, "denied", "repair-native-run",
		{ resultType: "denied", textResultForLlm: "Synthetic contradictory late denial" });
	const held = f.journal().read(prepared.preparationId, prepared.preparationDigest);
	assert.equal(held.state, "denied");
	const output = f.journal().events(prepared.preparationId, prepared.preparationDigest).find(event => event.event === "recovery-result");
	assert.ok(output, "Full candidate/review output survives the contradictory native outcome");
	f.journal().outcome(prepared.preparationId, prepared.preparationDigest, "uncertain", null, { error: "Later synthetic transport uncertainty" });
	assert.equal(f.journal().read(prepared.preparationId, prepared.preparationDigest).state, "denied");
	await assert.rejects(f.ops.reconcilePlanRepair(prepared.launchSpec.args, f.context), { code: "repair_admission_held" });
	await assert.rejects(f.ops.importPlanRepair({
		...prepared.launchSpec.args, id: "denied-draft", runId: "repair-native-run", expectedRevision: 0,
		repository: { workingDirectory: f.repositoryPath, baseBranch: "main" },
	}, f.context), { code: "repair_import_held" });
	assert.deepEqual(f.journal().events(prepared.preparationId, prepared.preparationDigest).find(event => event.event === "recovery-result"), output);
	assert.equal(f.launches.length, 1);
});

test("SPR-12/14/20: lost admission receipt reconciles only unique native observation and never relaunches", async t => {
	const f = await repairNativeFixture(t);
	const prepared = await f.prepare();
	const preparation = f.journal().read(prepared.preparationId, prepared.preparationDigest).preparation;
	f.setExecutor(async () => {
		f.records["repair-native-run"] = {
			workflowName: "plan-repair", run: { runId: "repair-native-run", status: "running" }, createdAt: 2000, completedAt: null,
			progress: [repairMarker(preparation)],
		};
		throw new Error("Synthetic transport loss after native admission");
	});
	await assert.rejects(f.ops.launchPlanRepair(prepared.launchSpec.args, f.context), { code: "repair_admission_uncertain" });
	const events = f.journal().events(prepared.preparationId, prepared.preparationDigest);
	assert.equal(events.at(-1)?.event, "uncertain");
	const restarted = f.createOps();
	await assert.rejects(restarted.reconcilePlanRepair(prepared.launchSpec.args, f.context), { code: "repair_admission_held" });
	await assert.rejects(restarted.launchPlanRepair(prepared.launchSpec.args, f.context));
	assert.equal(f.launches.length, 1);
	assert.deepEqual(f.journal().events(prepared.preparationId, prepared.preparationDigest).slice(0, events.length), events);
});

test("SPR-12/14/20: failed post-admission recording rolls back atomically and is recoverable without another launch", async t => {
	const f = await repairNativeFixture(t);
	const prepared = await f.prepare();
	const journal = f.journal();
	const db = new DatabaseSync(journal.databasePath);
	try {
		db.exec("CREATE TRIGGER reject_admission BEFORE INSERT ON planning_repair_events WHEN NEW.event = 'admitted' BEGIN SELECT RAISE(ABORT, 'Synthetic receipt failure'); END");
		await assert.rejects(f.ops.launchPlanRepair(prepared.launchSpec.args, f.context), error => {
			assert.equal(readRecord(error).code, "database_error");
			assert.equal(readRecord(readRecord(error).details).sqliteMessage, "Synthetic receipt failure");
			return true;
		});
		assert.equal(journal.read(prepared.preparationId, prepared.preparationDigest).state, "intent");
		assert.ok(journal.events(prepared.preparationId, prepared.preparationDigest).some(event => event.event === "effect-receipt"));
		db.exec("DROP TRIGGER reject_admission");
	} finally { db.close(); }
	await f.execute(prepared);
	assert.equal((await f.createOps().reconcilePlanRepair(prepared.launchSpec.args, f.context)).state, "admitted");
	assert.equal(f.launches.length, 1);
});

test("SPR-08/09/19: malformed, foreign, renamed, forged and spent sources fail closed", async t => {
	const f = await repairNativeFixture(t);
	const saved = structuredClone(f.records.source);
	const savedLabels = [...f.labels.source];
	/** @type {Array<(f: Awaited<ReturnType<typeof repairNativeFixture>>) => void>} */
	const changes = [
		f => { f.records.source.workflowName = "renamed-custom-plan"; },
		f => { f.records.source.run.runId = "foreign-id"; },
		f => { f.records.source.run.status = "running"; },
		f => { f.records.source.completedAt = null; },
		f => { readRecord(f.records.source.run.result).synthesisRepair = {}; },
		f => { delete readRecord(f.records.source.run.result).synthesisRepair; },
		f => { readRecord(f.records.source.run.result).repairBudget = { rootRunId: "ancestor", used: false }; },
		f => { readRecord(f.records.source.run.result).repairBudget = { rootRunId: "source", used: true }; },
		f => { readRecord(f.records.source.run.result).critiques = [null, f.original.critiques[1]]; },
		f => { readRecord(f.records.source.run.result).critiques = [{ ...f.original.critiques[0], fabricated: true }, f.original.critiques[1]]; },
		f => { readRecord(f.records.source.run.result).missingPerspectives = ["architecture-critic"]; },
		f => { readRecord(f.records.source.run.result).issues = ["unrelated structural failure"]; },
		f => { readRecord(readRecord(f.records.source.run.result).verification).passed = true; },
		f => { readRecord(f.records.source.run.result).inputDigest = "0".repeat(64); },
		f => { f.labels.source = f.labels.source.slice(1); },
	];
	for (const change of changes) {
		f.records.source = structuredClone(saved);
		f.labels.source = [...savedLabels];
		change(f);
		await assert.rejects(f.prepare());
		assert.equal(f.launches.length, 0);
	}
	f.records.source = structuredClone(saved); f.labels.source = savedLabels;
	for (const unexpected of ["result", "critiques", "owner", "sessionId", "repairBudget", "invocation", "source"]) {
		await assert.rejects(f.ops.preparePlanRepair({ runId: "source", repositoryPath: f.repositoryPath, [unexpected]: f.original }, f.context));
	}
	await assert.rejects(f.ops.preparePlanRepair({ runId: "source", repositoryPath: f.repositoryPath }, { invocation: { sessionId: "foreign", toolCallId: "native" } }), { code: "delegation_identity_required" });
	await assert.rejects(f.ops.preparePlanRepair({ runId: "source", repositoryPath: f.repositoryPath }, { invocation: { ...f.context.invocation, agentId: "child" } }), { code: "delegation_identity_required" });
	const getDetail = f.api.getRunDetail.bind(f.api);
	f.api.getRunDetail = async id => ({ ...readRecord(await getDetail(id)), runId: "foreign-detail" });
	await assert.rejects(f.prepare(), { code: "repair_native_identity" });
});

test("SPR-10/12/14/19/20: restart, concurrent admission and unique reconciliation never allocate another launch", async t => {
	const f = await repairNativeFixture(t);
	const [one, two] = await Promise.all([f.prepare(), f.prepare()]);
	assert.deepEqual(one, two);
	const admissions = await Promise.allSettled([f.ops.launchPlanRepair(one.launchSpec.args, f.context), f.createOps().launchPlanRepair(two.launchSpec.args, f.context)]);
	assert.ok(admissions.some(value => value.status === "fulfilled"));
	assert.equal(f.launches.length, 1);
	await f.execute(one);
	const restarted = f.createOps();
	assert.equal((await restarted.reconcilePlanRepair(one.launchSpec.args, f.context)).runId, "repair-native-run");
	assert.equal((await restarted.launchPlanRepair(one.launchSpec.args, f.context)).runId, "repair-native-run");
	const duplicate = structuredClone(f.records["repair-native-run"]);
	duplicate.run.runId = "duplicate";
	f.records.duplicate = duplicate;
	f.labels.duplicate = ["plan:semantic-repair", "plan:conservation-review"];
	assert.equal((await restarted.reconcilePlanRepair(one.launchSpec.args, f.context)).runId, "repair-native-run", "Native once receipt is authoritative; unrelated duplicate observations cannot create an extra effect");
	assert.equal(f.launches.length, 1);
	const sourceAlias = structuredClone(f.records.source);
	sourceAlias.run.runId = "source-alias";
	f.records["source-alias"] = sourceAlias;
	f.labels["source-alias"] = [...f.labels.source];
	await assert.rejects(f.ops.preparePlanRepair({ runId: "source-alias", repositoryPath: f.repositoryPath }, f.context), { code: "repair_budget_claimed" });
	await assert.rejects(f.ops.preparePlanRepair({ runId: "repair-native-run", repositoryPath: f.repositoryPath }, f.context), { code: "repair_native_identity" });
});

test("SPR-13/14/20: denial and uncertain native admission retain history and require observation rather than retry", async t => {
	for (const kind of ["denied", "unavailable", "uncertain", "malformed"]) {
		await t.test(kind, async t => {
			const f = await repairNativeFixture(t);
			const prepared = await f.prepare();
			f.setExecutor(async () => {
				if (kind === "uncertain") throw new Error("Synthetic transport disconnected after possible admission");
				if (kind === "malformed") return { resultType: "success", textResultForLlm: "{}" };
				return { resultType: kind === "denied" ? "denied" : "failure", error: "Synthetic native route unavailable", textResultForLlm: "not admitted" };
			});
			await assert.rejects(f.ops.launchPlanRepair(prepared.launchSpec.args, f.context));
			const state = f.journal().read(prepared.preparationId, prepared.preparationDigest);
			assert.ok(["denied", "uncertain"].includes(state.state));
			const events = f.journal().events(prepared.preparationId, prepared.preparationDigest);
			assert.equal(events[0].event, "prepared");
			assert.ok(events.some(event => event.event === "intent"));
			await assert.rejects(f.createOps().launchPlanRepair(prepared.launchSpec.args, f.context));
			await assert.rejects(f.ops.reconcilePlanRepair(prepared.launchSpec.args, f.context), { code: "repair_admission_held" });
			assert.equal(f.launches.length, 1);
			assert.deepEqual(f.journal().events(prepared.preparationId, prepared.preparationDigest).slice(0, events.length), events);
		});
	}
});

test("SPR-10/15/16/19: source/result substitution and authority drift block admission or import", async t => {
	const f = await repairNativeFixture(t);
	const prepared = await f.prepare();
	const before = structuredClone(f.original);
	readRecord(f.records.source.run.result).critiques = [{ verdict: "accept", risks: ["substituted"], requiredChanges: [] }, before.critiques[1]];
	await assert.rejects(f.ops.launchPlanRepair(prepared.launchSpec.args, f.context), { code: "repair_source_changed" });
	assert.equal(f.launches.length, 0);
	f.records.source.run.result = before;
	await f.ops.launchPlanRepair(prepared.launchSpec.args, f.context);
	const { result } = await f.execute(prepared);
	const request = { ...prepared.launchSpec.args, id: "substitution", repository: { workingDirectory: f.repositoryPath, baseBranch: "main" }, runId: "repair-native-run", expectedRevision: 0 };
	for (const change of [
		{ status: "needs-review" }, { preparationDigest: "f".repeat(64) }, { sourceDigest: "f".repeat(64) },
		{ sourceRunId: "foreign" }, { critiques: [] }, { verification: { passed: false, issues: ["not conserved"] } },
		{ plan: { ...readRecord(result.plan), title: "Native result substitution" } },
	]) {
		f.records["repair-native-run"].run.result = { ...result, ...change };
		await assert.rejects(f.ops.importPlanRepair(request, f.context));
	}
	f.records["repair-native-run"].run.result = result;
	const unit = f.factory.snapshot().units[0];
	f.mutate("createUnit", { id: unit.id, name: unit.name, purpose: `${unit.purpose}; changed authority`, boundary: unit.boundary, dependencies: [], relationshipCoverage: "complete", actor: "synthetic-owner", reason: "Synthetic revision drift" });
	await assert.rejects(f.ops.importPlanRepair(request, f.context), { code: "repair_authority_stale" });
	assert.equal(stableStringify(f.records.source.run.result), stableStringify(before));
});

test("LP08-12/15/16: explicit multi-effect recovery conserves all history and does not reset the legacy lineage claim", async t => {
	const f = await repairNativeFixture(t);
	const first = await f.prepare();
	const observe = f.nativeHost.host.observeCandidate;
	let partial = true;
	f.nativeHost.host.observeCandidate = async (...args) => {
		const value = readRecord(await observe(...args));
		if (partial) {
			const obligations = value.obligations;
			assert.ok(Array.isArray(obligations));
			const remaining = readRecord(obligations[1]);
			remaining.status = "unresolved"; remaining.evidence = [];
			return f.nativeHost.attest(value);
		}
		return value;
	};
	await f.ops.launchPlanRepair(first.launchSpec.args, f.context);
	const initial = await f.execute(first);
	assert.equal(initial.result.status, "needs-review");
	const originalRecord = f.journal().read(first.preparationId, first.preparationDigest);
	const originalEvents = f.journal().events(first.preparationId, first.preparationDigest);
	partial = false;
	const continuation = await f.ops.preparePlanRepair({ runId: "source", repositoryPath: f.repositoryPath, continuationOf: "repair-native-run" }, f.context);
	assert.ok(continuation.launchSpec.args.effectId);
	f.setRunId("second-recovery-run");
	await f.ops.launchPlanRepair(continuation.launchSpec.args, f.context);
	const final = await f.execute(continuation);
	assert.equal(final.result.status, "ready");
	assert.equal(f.launches.length, 2);
	assert.equal(f.nativeHost.remaining(), 14);
	assert.deepEqual(f.journal().read(first.preparationId, first.preparationDigest).preparation, originalRecord.preparation);
	assert.deepEqual(f.journal().events(first.preparationId, first.preparationDigest).slice(0, originalEvents.length), originalEvents);
	assert.equal(f.journal().comparisonHistory(first.preparationId, first.preparationDigest).length, 3);
	const firstLaunch = f.journal().effects(first.preparationId, first.preparationDigest).find(row => {
		const effect = readRecord(row.effect);
		return effect.kind === "launch" && readRecord(row.receipt).nativeRunId === "repair-native-run";
	});
	assert.ok(firstLaunch);
	const firstEffectId = readRecord(firstLaunch.effect).id;
	const secondEffectId = continuation.launchSpec.args.effectId;
	assert.ok(typeof firstEffectId === "string");
	assert.ok(secondEffectId);
	assert.notEqual(firstEffectId, secondEffectId);
	/** @type {Array<[string, string]>} */
	const mismatches = [[firstEffectId, "second-recovery-run"], [secondEffectId, "repair-native-run"]];
	for (const [effectId, runId] of mismatches) {
		await assert.rejects(f.ops.importPlanRepair({
			...continuation.launchSpec.args, effectId, runId, id: "continued-draft", expectedRevision: 0,
			repository: { workingDirectory: f.repositoryPath, baseBranch: "main" },
		}, f.context), { code: "repair_effect_conflict" });
	}
	const draft = await f.ops.importPlanRepair({ ...continuation.launchSpec.args, id: "continued-draft", runId: "second-recovery-run", expectedRevision: 0,
		repository: { workingDirectory: f.repositoryPath, baseBranch: "main" } }, f.context);
	assert.equal(draft.status, "draft");
	await assert.rejects(f.ops.preparePlanRepair({ runId: "source", repositoryPath: f.repositoryPath, continuationOf: "second-recovery-run" }, f.context), { code: "repair_continuation_held" });
});

test("LP10/11/16: a callable SDK route without the authentic host is precisely held before any native effect", async t => {
	const f = await repairNativeFixture(t);
	const prepared = await f.prepare();
	await assert.rejects(f.createOps(true, false).launchPlanRepair(prepared.launchSpec.args, f.context), { code: "repair_admission_unavailable" });
	assert.equal(f.launches.length, 0);
	assert.equal(f.nativeHost.remaining(), 20);
});

test("LP12: recovery inventory exhausts finite cursor pages beyond the old window and honors cancellation", async t => {
	const f = await repairNativeFixture(t);
	const prepared = await f.prepare();
	const preparation = f.journal().read(prepared.preparationId, prepared.preparationDigest).preparation;
	await f.ops.launchPlanRepair(prepared.launchSpec.args, f.context);
	f.records["repair-native-run"].progress = [repairMarker(preparation)];
	let page = 0;
	f.api.listRuns = async () => {
		page++;
		return {
			runs: [{ runId: `old-run-${page}`, workflowName: "plan", status: "completed", createdAt: 1000 },
				{ runId: "repair-native-run", workflowName: "plan-repair", status: "running", createdAt: 2000 }],
			omittedOlder: page < 18 ? 1 : 0, oldestSeq: 100 - page,
		};
	};
	const observation = await f.analysis.reconcilePlanningRepair(preparation);
	assert.equal(observation.runId, "repair-native-run");
	assert.equal(page, 18);
	const controller = new AbortController();
	controller.abort(new Error("explicit cancellation"));
	await assert.rejects(f.analysis.reconcilePlanningRepair(preparation, { signal: controller.signal }), /explicit cancellation/);
	assert.equal(page, 18);
});

test("LP09/12/15: legacy native projections reconcile without rewriting history or acquiring a comparator baseline", async t => {
	const f = await repairNativeFixture(t);
	const source = await f.analysis.readPlanningRepairSource("source");
	const native = Object.fromEntries(["runId", "workflowName", "createdAt", "completedAt", "agents"].map(key => [key, source.native[key]]));
	const preparation = buildRepairPreparation({
		owner: f.owner, sessionId: f.sessionId, rootRunId: "source", sourceDigest: source.resultDigest, mode: "recovery",
		repositoryPath: f.repositoryPath, authority: repairAuthority(source.material.input.factoryContext), material: source.material,
		source: repairObject({ result: source.result, native }),
	});

	test("LP08-12/15/16: modern inline recovery can explicitly continue without converting or resetting its original claim", async t => {
		const f = await repairNativeFixture(t);
		const observe = f.nativeHost.host.observeCandidate;
		let partial = true;
		f.nativeHost.host.observeCandidate = async (...args) => {
			const value = readRecord(await observe(...args));
			if (partial) {
				assert.ok(Array.isArray(value.obligations));
				const remaining = readRecord(value.obligations[1]);
				remaining.status = "unresolved"; remaining.evidence = [];
				return f.nativeHost.attest(value);
			}
			return value;
		};
		const workflow = workflowWithResponses(f.input, {
			"plan:decomposer": f.original.plan, "plan:synthesizer": f.original.plan,
			"plan:architecture-critic": f.original.critiques[0], "plan:delivery-risk-critic": f.original.critiques[1],
			"plan:verifier": f.original.verification, "plan:semantic-repair": f.repaired, "plan:conservation-review": { passed: true, issues: [] },
		});
		const initial = await runPlan({ ...workflow, runId: "source", session: f.session }, f.nativeHost.host);
		assert.equal(initial.status, "needs-review");
		f.records.source.run.result = initial;
		f.labels.source = workflow.calls.map(call => call.options.label);
		const original = f.journal().findRoot("source");
		assert.ok(original);
		assert.equal(original.preparation.mode, "inline");
		const events = f.journal().events(original.preparation.id, original.preparation.digest);
		const source = structuredClone(f.records.source);
		partial = false;
		const continuation = await f.ops.preparePlanRepair({ runId: "source", repositoryPath: f.repositoryPath, continuationOf: "source" }, f.context);
		f.setRunId("inline-continuation-run");
		await f.ops.launchPlanRepair(continuation.launchSpec.args, f.context);
		assert.equal((await f.execute(continuation)).result.status, "ready");
		const draft = await f.ops.importPlanRepair({ ...continuation.launchSpec.args, id: "inline-continued-draft", runId: "inline-continuation-run", expectedRevision: 0,
			repository: { workingDirectory: f.repositoryPath, baseBranch: "main" } }, f.context);
		assert.equal(draft.status, "draft");
		assert.deepEqual(f.journal().findRoot("source")?.preparation, original.preparation);
		assert.deepEqual(f.journal().events(original.preparation.id, original.preparation.digest).slice(0, events.length), events);
		assert.deepEqual(f.records.source, source);
		assert.equal(f.nativeHost.remaining(), 15);
	});
	f.journal().prepare(preparation);
	const before = f.journal().events(preparation.id, preparation.digest);
	const prepared = await f.prepare();
	assert.equal(prepared.preparationDigest, preparation.digest);
	assert.deepEqual(f.journal().events(preparation.id, preparation.digest), before);
	assert.deepEqual(f.journal().comparisonHistory(preparation.id, preparation.digest), [null]);
	await assert.rejects(f.ops.launchPlanRepair(prepared.launchSpec.args, f.context), { code: "repair_comparison_missing" });
	assert.equal(f.launches.length, 0);
	assert.equal(f.nativeHost.remaining(), 20);
});

test("prepare operations return native run_dynamic_workflow launch specs", async () => {
	const analysis = createWorkflowAnalysis(() => fakeApi());
	const planning = await analysis.preparePlanning({
		objective: "Build",
		constraints: [],
		repositoryContext: "Node repository",
		maxTasks: 2,
	});

	assert.equal(planning.workflow, "plan");
	assert.equal(planning.launchSpec.name, planning.workflow);
	assert.equal(Object.hasOwn(planning.launchSpec, "limits"), false);

	const verification = await analysis.prepareVerification(
		completedPlan(),
		"verification-reservation",
	);
	assert.equal(verification.workflow, "verify");
	assert.equal(verification.launchSpec.name, verification.workflow);
	assert.equal(verification.launchSpec.args.planId, "workflow-plan");
	assert.equal(
		verification.launchSpec.args.reservationId,
		"verification-reservation",
	);
	assert.equal(Object.hasOwn(verification.launchSpec, "limits"), false);
});

test("planning imports use native settlement without resuming or cancelling runs", async () => {
	const input = buildPlanningArgs({
		objective: "Build",
		constraints: [],
		repositoryContext: "Node repository",
		maxTasks: 2,
	});
	for (const outcome of ["completed", "pending", "running", "paused", "error", "interrupted"]) {
		const controller = new AbortController();
		const interrupted = new Error("Import interrupted");
		/** @type {import("@github/copilot-sdk").WorkflowRunResult} */
		const run = {
			runId: "planning",
			status: outcome === "completed" ? "completed" : outcome === "pending" ? "pending" : "running",
		};
		if (outcome === "completed") run.result = planningResult(input);
		let waits = 0;
		const api = Object.assign(fakeApi({ planning: { workflowName: "plan", run } }), {
			/** @param {string} runId @param {{signal: AbortSignal}} options */
			async waitForRun(runId, { signal }) {
				assert.equal(runId, run.runId);
				assert.equal(signal, controller.signal);
				waits++;
				await new Promise((resolve) => setImmediate(resolve));
				if (outcome === "interrupted") {
					controller.abort(interrupted);
					signal.throwIfAborted();
				}
				run.status = outcome === "paused" ? "paused" : outcome === "error" ? "error" : "completed";
				if (run.status === "completed") run.result = planningResult(input);
				return run;
			},
		});
		const analysis = createWorkflowAnalysis(() => api);
		const importing = analysis.importPlanning("planning", { signal: controller.signal });
		if (outcome === "interrupted") {
			await assert.rejects(importing, (error) => error === interrupted);
			assert.equal(run.status, "running");
		} else if (outcome === "paused" || outcome === "error") {
			await assert.rejects(importing, {
				code: "workflow_result_unavailable",
				details: { status: outcome, failure: null },
			});
		} else {
			const imported = await importing;
			assert.equal(imported.plan.objective, "Build");
			assert.equal(imported.inputDigest, input.inputDigest);
		}
		assert.equal(waits, outcome === "completed" ? 0 : 1);
		assert.deepEqual(api.cancelCalls, []);
	}
});

test("rejects a run owned by the wrong Workflow", async () => {
	const analysis = createWorkflowAnalysis(() => fakeApi({
		wrong: {
			workflowName: "other",
			run: { runId: "wrong", status: "running" },
		},
	}));
	await assert.rejects(
		analysis.importPlanning("wrong"),
		(error) => error instanceof FoundryWorkflowError && error.code === "workflow_run_identity_mismatch",
	);
});

test("fails clearly when native Workflow inspection is unavailable", async () => {
	const analysis = createWorkflowAnalysis(() => ({}));
	await assert.rejects(
		analysis.importPlanning("run"),
		(error) =>
			error instanceof FoundryWorkflowError &&
			error.code === "workflow_backend_unavailable",
	);
});

test("native workflow failures retain their structured recovery metadata", async () => {
	/** @type {NonNullable<import("@github/copilot-sdk").WorkflowRunResult["failure"]>[]} */
	const failures = [
		{
			type: "workflow_limit_reached",
			runId: "failed",
			kind: "maxAiCredits",
			value: 10,
			suggestedValue: 20,
		},
		{ type: "workflow_resume_declined", runId: "failed", reason: "User declined" },
		{
			type: "workflow_durable_failure",
			runId: "failed",
			code: "workflow_storage_unavailable",
			operation: "journalGet",
		},
		{ type: "workflow_accounting_incomplete", runId: "failed", drainedNanoAiu: 100 },
		{ type: "workflow_provider_disconnected", runId: "failed" },
	];
	for (const failure of failures) {
		const analysis = createWorkflowAnalysis(() => fakeApi({
			failed: {
				workflowName: "plan",
				run: { runId: "failed", status: "error", failure },
			},
		}));
		await assert.rejects(analysis.importPlanning("failed"), {
			code: "workflow_result_unavailable",
			details: { status: "error", failure },
		});
	}
});

test("pause metadata is preserved without treating a settled attempt as cancelled", async () => {
	/** @type {NonNullable<import("@github/copilot-sdk").WorkflowRunResult["pauseInfo"]>[]} */
	const pauses = [{ type: "user" }, { type: "checkpoint", key: "review-ready" }];
	for (const pauseInfo of pauses) {
		const run = { runId: "paused", status: "paused", attempt: 2, pauseInfo };
		const analysis = createWorkflowAnalysis(() => fakeApi({
			paused: { workflowName: "verify", run },
		}));
		// @ts-expect-error A paused native run must be classified before consulting a plan.
		assert.deepEqual(await analysis.assessVerificationRun("paused", null), {
			state: "paused",
			run,
		});
		assert.equal(await analysis.verificationRunIsTerminal("paused"), false);
	}
});

test("verification import validates the terminal result and reservation", async () => {
	const plan = reservedPlan();
	const args = buildVerificationInput(plan);
	const reservationId = plan.verification.reservationId;
	const marker = verificationMarker(reservationId);
	const result = {
		kind: "foundry-verification-result",
		reservationId,
		input: args,
		inputDigest: args.inputDigest,
		planId: plan.id,
		passed: true,
		summary: "Passed",
		evidenceIds: args.verificationReport.evidence.map((entry) => entry.id),
		missingEvidence: [],
		correctionTaskIds: [],
		reviews: [
			{
				missingEvidence: [],
				integrationFindings: [],
				risks: [],
			},
			{
				missingEvidence: [],
				integrationFindings: [],
				risks: [],
			},
		],
	};
	const records = {
		complete: {
			workflowName: "verify",
			run: { runId: "complete", status: "completed", result },
			progressUnavailable: true,
		},
		unknownTimestamp: {
			workflowName: "verify",
			run: { runId: "unknownTimestamp", status: "completed", result },
			createdAt: "2026-08-07T00:10:00.000Z",
			progress: [],
		},
		active: {
			workflowName: "verify",
			run: { runId: "active", status: "running", result },
			completedAt: /** @type {number | null} */ (null),
			progress: [marker],
		},
	};
	const completedAt = Date.parse("2026-08-07T00:11:00.000Z");
	const api = Object.assign(fakeApi(records), {
		async waitForRun(/** @type {string} */ runId) {
			assert.equal(runId, "active");
			await new Promise((resolve) => setImmediate(resolve));
			records.active.run.status = "completed";
			records.active.completedAt = completedAt;
			return records.active.run;
		},
	});
	const getRunDetail = api.getRunDetail.bind(api);
	let detailReads = 0;
	api.getRunDetail = async (runId) => {
		detailReads++;
		return getRunDetail(runId);
	};
	const analysis = createWorkflowAnalysis(() => api);
	const complete = await analysis.importVerification("complete", plan);
	assert.equal(complete.result.passed, true);
	assert.equal(detailReads, 1);
	assert.equal(
		(await analysis.importVerification("unknownTimestamp", plan)).result.passed,
		true,
	);
	assert.equal(await analysis.verificationRunIsTerminal("complete"), true);
	const active = await analysis.importVerification("active", plan);
	assert.equal(active.result.passed, true);
	assert.equal(active.detail.completedAt, completedAt);
	assert.equal(detailReads, 4);
	records.complete.run.result = { ...result, reservationId: "foreign-reservation" };
	await assert.rejects(analysis.importVerification("complete", plan), /does not match its run/);
});

test("verification import rejects stale and foreign runs before waiting", async () => {
	const plan = reservedPlan("expected-reservation");
	const marker = verificationMarker(plan.verification.reservationId);
	const records = {
		stale: {
			workflowName: "verify",
			run: { runId: "stale", status: "running" },
			createdAt: Date.parse("2026-08-07T00:05:00.000Z"),
			progress: [marker],
		},
		foreign: {
			workflowName: "verify",
			run: { runId: "foreign", status: "running" },
			progress: [verificationMarker("other-reservation")],
		},
		late: {
			workflowName: "verify",
			run: { runId: "late", status: "completed", result: {} },
			progress: ["other progress", marker],
		},
	};
	const analysis = createWorkflowAnalysis(() => fakeApi(records));
	await assert.rejects(
		analysis.importVerification("stale", plan),
		/predates verification reservation/,
	);
	await assert.rejects(
		analysis.importVerification("foreign", plan),
		/does not carry verification reservation/,
	);
});

test("malformed completed factory output falls back to its valid marker and permits explicit replacement", async () => {
	const plan = reservedPlan("malformed-factory-result");
	const input = buildVerificationInput(plan);
	const result = {
		kind: "foundry-verification-result", reservationId: plan.verification.reservationId, planId: plan.id,
		inputDigest: input.inputDigest, input: { ...input, factory: { binding: { repositoryId: "not-a-digest" }, evaluations: [] } },
		passed: true, summary: "Malformed report must not become permanently unobservable",
		evidenceIds: input.verificationReport.evidence.map((entry) => entry.id),
		missingEvidence: [], correctionTaskIds: [],
		reviews: [{ missingEvidence: [], integrationFindings: [], risks: [] }, { missingEvidence: [], integrationFindings: [], risks: [] }],
	};
	const api = fakeApi({
		malformed: {
			workflowName: "verify", run: { runId: "malformed", status: "completed", result },
			progress: [verificationMarker(plan.verification.reservationId)]
		},
	});
	const analysis = createWorkflowAnalysis(() => api);
	const discovery = await analysis.discoverVerificationRun(plan.verification.reservationId, plan.verification.reservedAt);
	assert.equal(discovery.state, "found");
	assert.equal(discovery.run.runId, "malformed");
	assert.equal((await analysis.assessVerificationRun("malformed", plan)).state, "terminal-nonimportable");
	const failure = new Error("Native storage is unavailable");
	api.getRun = async () => { throw failure; };
	assert.equal((await analysis.discoverVerificationRun(plan.verification.reservationId, plan.verification.reservedAt)).state, "inconclusive");
	await assert.rejects(analysis.assessVerificationRun("malformed", plan), (error) => error === failure);
});
