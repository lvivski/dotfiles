import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildVerificationInput } from "../../analysis/verification.mjs";
import { createAuthority } from "../../bridge/authority.mjs";
import { createDispatchBridge } from "../../bridge/dispatch.mjs";
import { errorCode, parseJson, readRecord } from "../../data.mjs";
import { createFoundryOperations } from "../../operations.mjs";
import { verificationCheckIds } from "../../plan/graph.mjs";
import { completed, must } from "../assertions.mjs";
import { analysisStub, completeInventory, createApproved, evidence, runTask, withOperations } from "../application/fixture.mjs";
import { factoryMutator } from "../factory/accessors.mjs";
import { COMMIT, git } from "../git.mjs";
import { fixture } from "./fixture.mjs";

/** @param {string} prompt */
function authorityIn(prompt) {
	return readRecord(parseJson(must(prompt.match(/<UNTRUSTED-FACTORY>\n([\s\S]*?)\n<\/UNTRUSTED-FACTORY>/)?.[1])));
}

for (const acceptance of ["before-verifier", "attached-implementation", "attached-verifier"]) {
	test(`uncontracted discovery finishes across restart with first acceptance ${acceptance}`, () => {
		const analysis = {
			...analysisStub({ discoverVerificationRun: async () => ({ state: "found", run: { runId: "discovery-verification", status: "completed" } }) }),
			/** @param {import("../../types/plan.js").FoundryPlan} plan @param {string} reservationId */
			prepareVerification: async (plan, reservationId) => {
				const input = buildVerificationInput(plan);
				return { workflow: "verify", inputDigest: input.inputDigest, launchSpec: { name: "verify", args: { ...input, reservationId } } };
			},
		};
		return withOperations(async ({ operations, workspacePath }) => {
			let ops = operations;
			const verifierBranch = "fixture/discovery-check";
			const verifierPath = path.join(workspacePath, "verifier");
			const factory = ops.factoryFor(workspacePath);
			const mutate = factoryMutator(factory);
			const boundary = structuredClone(factory.snapshot().units[0]);
			let plan = await createApproved(ops, workspacePath);
			const originalBinding = structuredClone(plan.factory);
			({ plan } = await runTask(ops, plan, "T-001", { commit: COMMIT }));
			if (acceptance !== "attached-implementation") ({ plan } = await runTask(ops, plan, "T-002", { commit: COMMIT }));
			const taskId = acceptance === "attached-implementation" ? "T-002" : "T-003";
			let attached = null;
			if (acceptance !== "before-verifier") {
				attached = await ops.reserveTask({ planId: plan.id, taskId, expectedRevision: plan.revision, reservationId: "attached-before-acceptance" });
				if (taskId === "T-003") git(workspacePath, "worktree", "add", "--quiet", "-b", verifierBranch, verifierPath, COMMIT);
				plan = await ops.attachTask({
					planId: plan.id, taskId, attemptId: attached.attemptId, expectedRevision: attached.plan.revision,
					sessionId: "already-running-discovery", branch: taskId === "T-003" ? verifierBranch : "work/discovery",
				});
				if (taskId === "T-003") git(verifierPath, "checkout", "--quiet", "--detach", COMMIT);
			}
			mutate("createUnit", {
				id: boundary.id, name: boundary.name, purpose: boundary.purpose,
				boundary: { ...boundary.boundary, owns: ["new-accepted-authority"] },
				dependencies: boundary.dependencies, relationshipCoverage: boundary.relationshipCoverage,
				actor: "owner", reason: "A new boundary must not rewrite earlier discovery",
			});
			const source = { kind: "discovery", ref: "fixture:accepted-later", actor: "owner", at: new Date().toISOString() };
			mutate("appendKnowledge", { id: "discovered-obligation", unitId: boundary.id, kind: "obligation", statement: "The newly accepted contract is not this discovery's authority", source });
			mutate("appendKnowledge", {
				id: "discovered-evaluator", unitId: boundary.id, kind: "evaluation", statement: "Independent conserved-boundary rubric", source,
				evaluation: {
					modality: "boundary", procedure: { kind: "reference", ref: "fixture:boundary-rubric", digest: "a".repeat(64) },
					obligations: [{ id: "discovered-obligation", revision: 1 }], environment: "fixture", workload: "discovery",
					maxAgeSeconds: 86400, independent: true, preservation: true,
				},
			});
			mutate("acceptContract", {
				unitId: boundary.id, unitRevision: 2, obligations: [{ id: "discovered-obligation", revision: 1 }],
				evaluations: [{ id: "discovered-evaluator", revision: 1 }], actor: "owner", reason: "Accept initial recovered intent separately from completing discovery",
			});
			ops = createFoundryOperations({ getWorkspacePath: () => workspacePath, factoryStorageRoot: workspacePath, analysis });
			plan = await ops.getPlan({ planId: plan.id });
			assert.deepEqual(plan.factory, originalBinding);
			assert.equal((await ops.getStatus({ planId: plan.id })).projection.factoryHold, undefined);
			if (attached) {
				const recovered = await ops.reserveTask({
					planId: plan.id, taskId, expectedRevision: 0, reservationId: "attached-before-acceptance",
				});
				const context = authorityIn(recovered.delegationPrompt);
				assert.equal(recovered.attemptId, attached.attemptId);
				assert.equal(context.authority, "discovery-only");
				assert.equal(context.contract, null);
				assert.equal(context.governing, null);
				assert.equal(context.proposedUnit, null);
				assert.deepEqual(context.unit, boundary);
				plan = await ops.completeTask({
					planId: plan.id, taskId, attemptId: attached.attemptId, expectedRevision: plan.revision, status: "done",
					resultSummary: "Observed completion of the already-running discovery", commit: COMMIT,
					evidence: taskId === "T-003" ? verificationCheckIds(plan.tasks).map((checkId) => ({ ...evidence("Independent discovery checks")[0], checkId }))
						: evidence("Discovery implementation checks"),
				});
			}
			if (acceptance !== "attached-verifier") {
				assert.deepEqual((await ops.nextTasks({ planId: plan.id })).dispatchableTaskIds, ["T-003"]);
				const verified = await runTask(ops, plan, "T-003", { commit: COMMIT, branch: verifierBranch });
				plan = verified.plan;
				const context = authorityIn(verified.reserved.delegationPrompt);
				assert.equal(context.authority, "discovery-only");
				assert.equal(context.contract, null);
				assert.equal(context.governing, null);
				assert.deepEqual(context.unit, boundary);
				assert.match(verified.reserved.delegationPrompt, /bounded discovery plan/);
			}
			const prepared = await ops.prepareVerification({ planId: plan.id, expectedRevision: plan.revision, reservationId: "finish-discovery" });
			const definitions = readRecord(must(prepared.plan.factoryVerification).definitions);
			assert.equal(definitions.contract, null);
			assert.deepEqual(definitions.unit, boundary);
			assert.deepEqual(definitions.obligations, []);
			assert.deepEqual(definitions.evaluations, []);
			plan = completed(await ops.finishVerification({ planId: plan.id, expectedRevision: prepared.plan.revision, runId: "discovery-verification" }));
			plan = await ops.approve({ planId: plan.id, expectedRevision: plan.revision, approvalType: "completion", approvedBy: "owner" });
			assert.equal(plan.status, "completed");
			assert.deepEqual(plan.factory, originalBinding);
			assert.equal(factory.snapshot().candidates.length, 0);
			assert.equal(factory.inspect().units[0].currentCandidateId, null);
			assert.ok(factory.snapshot().decisions.every((decision) => decision.kind === "accept-contract"));
			if (acceptance === "before-verifier") {
				const foreignWorkspace = path.join(workspacePath, "foreign");
				await mkdir(foreignWorkspace);
				const foreign = createFoundryOperations({ getWorkspacePath: () => foreignWorkspace, factoryStorageRoot: workspacePath, analysis });
				await foreign.importPlan({ source: await ops.exportPlan({ planId: plan.id }), expectedRevision: 0 });
				assert.equal((await foreign.getStatus({ planId: plan.id })).projection.factoryHold?.blocksAllExecution, true);
				await assert.rejects(foreign.reserveTask({
					planId: plan.id, taskId: "T-003", expectedRevision: plan.revision, reservationId: "foreign-discovery",
				}), { code: "factory_execution_foreign" });
				await assert.rejects(foreign.cancel({
					planId: plan.id, expectedRevision: plan.revision, requestId: "foreign-cancel", requestedBy: "foreign", reason: "Must not control another session's completed discovery",
				}), { code: "factory_execution_foreign" });
			}
		}, { analysis });
	});
}

test("contract supersession blocks new generation dispatch, not truthful attached completion or cancellation", async (t) => {
	const f = await fixture(t);
	let plan = await f.attach(f.ops, await f.generationPlan(), "T-001");
	f.mutate("acceptContract", {
		unitId: "unit", unitRevision: 1, obligations: [{ id: "obligation", revision: 1 }], evaluations: [{ id: "oracle", revision: 1 }],
		actor: "owner", reason: "A distinct later acceptance supersedes implementation authority",
	});
	plan = await f.ops.completeTask(f.payload(plan, "T-001"));
	assert.equal(plan.tasks[0].status, "done");
	await assert.rejects(f.ops.reserveTask({
		planId: plan.id, taskId: "T-002", expectedRevision: plan.revision, reservationId: "superseded",
	}), { code: "factory_contract_superseded" });
	assert.equal((await f.ops.getStatus({ planId: plan.id })).projection.factoryHold?.code, "factory_contract_superseded");
	plan = await f.ops.cancel({ planId: plan.id, expectedRevision: plan.revision, requestId: "cancel-superseded", requestedBy: "owner", reason: "Keep the delivered observation, stop superseded work" });
	plan = await f.ops.finalizeCancellation({
		planId: plan.id, expectedRevision: plan.revision, dispositions: [], finalizedBy: "owner", sessionInventory: completeInventory(),
	});
	assert.equal(plan.status, "cancelled");
	assert.ok(f.factory.snapshot().candidates[0].delivery);
});

test("read-only re-evaluation dispatch retains its exact historical contract after supersession", async (t) => {
	const f = await fixture(t);
	const generation = await f.implement(await f.generationPlan());
	const original = f.factory.generation(f.candidate.id);
	f.mutate("acceptContract", {
		unitId: "unit", unitRevision: 1, obligations: [{ id: "obligation", revision: 1 }], evaluations: [{ id: "oracle", revision: 1 }],
		actor: "owner", reason: "Later acceptance does not rewrite a historical evaluation target",
	});
	let plan = await f.approve(f.ops, await f.ops.createEvaluationPlan({
		id: "historical-review", candidateId: f.candidate.id, expectedRevision: 0,
		repository: generation.repository, expectedFactoryRevision: f.factory.snapshot().revision,
	}));
	assert.equal((await f.ops.getStatus({ planId: plan.id })).projection.factoryHold, undefined);
	assert.deepEqual((await f.ops.nextTasks({ planId: plan.id })).dispatchableTaskIds, ["T-001"]);
	plan = await f.attach(f.ops, plan, "T-001");
	const reserved = await f.ops.reserveTask({ planId: plan.id, taskId: "T-001", expectedRevision: plan.revision, reservationId: `${plan.id}-T-001-1` });
	const context = authorityIn(reserved.delegationPrompt);
	assert.equal(readRecord(context.contract).digest, original.contract.digest);
	assert.equal(context.contextDigest, original.contextDigest);
	assert.equal(plan.evaluationTarget?.commit, f.factory.snapshot().candidates[0].delivery?.commit);
	plan = await f.ops.completeTask(f.payload(plan, "T-001"));
	assert.equal(plan.tasks[0].status, "done");
	assert.deepEqual(f.factory.generation(f.candidate.id), original);
});

for (const terminal of ["done", "cancelled"]) {
	test(`a divergent portable head blocks new dispatch but retains owned ${terminal} work across restart`, () => withOperations(async ({ operations, workspacePath }) => {
		let plan = await createApproved(operations, workspacePath);
		const reserved = await operations.reserveTask({
			planId: plan.id, taskId: "T-001", expectedRevision: plan.revision, reservationId: "before-head-conflict",
		});
		plan = await operations.attachTask({
			planId: plan.id, taskId: "T-001", attemptId: reserved.attemptId, expectedRevision: reserved.plan.revision,
			sessionId: "conflicted-child", branch: "fixture/conflicted",
		});
		const originalBinding = structuredClone(plan.factory);
		const factory = operations.factoryFor(workspacePath);
		const manifestPath = path.join(workspacePath, ".foundry/repository.json");
		const previousHead = await readFile(manifestPath, "utf8");
		factory.appendKnowledge({
			expectedRevision: factory.snapshot().revision, id: "later-portable-lesson", unitId: "operation-capability",
			kind: "inference", statement: "Preserve later knowledge when a different branch is checked out",
			source: { kind: "discovery", ref: "fixture:later-head", actor: "owner", at: new Date().toISOString() },
		});
		const currentHead = await readFile(manifestPath, "utf8");
		assert.notEqual(currentHead, previousHead);
		await writeFile(manifestPath, previousHead);
		const authority = createAuthority({ workspace: () => workspacePath, storageRoot: workspacePath, clock: undefined });
		const dispatch = createDispatchBridge(authority.stateFor, authority.context);
		const restarted = createFoundryOperations({ getWorkspacePath: () => workspacePath, factoryStorageRoot: workspacePath, analysis: analysisStub() });
		try {
			assert.throws(() => authority.factoryFor(workspacePath).snapshot(), { code: "factory_knowledge_conflict" });
			assert.equal(authority.stateFor(plan).binding.planId, plan.id);
			assert.throws(() => dispatch.prompt(plan, { kind: "implement" }), { code: "factory_knowledge_conflict" });
			assert.throws(() => authority.context(workspacePath, "operation-capability"), { code: "factory_knowledge_conflict" });
			assert.throws(() => authority.stateFor({ ...plan, factory: { ...must(plan.factory), owner: "foreign-owner" } }), { code: "factory_execution_foreign" });
			assert.throws(() => authority.stateFor({ ...plan, factory: { ...must(plan.factory), unitRevision: 999 } }), { code: "factory_plan_mismatch" });
			if (terminal === "cancelled") {
				plan = await restarted.cancel({
					planId: plan.id, expectedRevision: plan.revision, requestId: "cancel-with-head-conflict",
					requestedBy: "owner", reason: "Stop the owned child without changing portable authority",
				});
				await delay(2);
			}
			try {
				if (terminal === "done") await restarted.completeTask({
					planId: plan.id, taskId: "T-001", attemptId: reserved.attemptId, expectedRevision: plan.revision,
					status: "done", resultSummary: "Observed completion despite the checked-out head conflict",
					evidence: evidence("Owned discovery completion"), commit: COMMIT,
				});
				else await restarted.finalizeCancellation({
					planId: plan.id, expectedRevision: plan.revision, finalizedBy: "owner",
					dispositions: [{ attemptId: reserved.attemptId, disposition: "session-terminated", sessionId: "conflicted-child" }],
					sessionInventory: { complete: true, capturedAt: new Date().toISOString(), sessions: [{ id: "conflicted-child", status: "archived" }] },
				});
			} catch (error) {
				assert.equal(errorCode(error), "factory_sync_pending", "Only publication may remain pending; recording the terminal fact must succeed");
			}
			plan = await restarted.getPlan({ planId: plan.id });
			assert.equal(plan.tasks[0].status, terminal);
			if (terminal === "cancelled") assert.equal(plan.status, "cancelled");
			assert.deepEqual(plan.factory, originalBinding);
			assert.equal(await readFile(manifestPath, "utf8"), previousHead, "Terminal work must not replace the divergent portable head");
		} finally {
			await writeFile(manifestPath, currentHead);
		}
		await restarted.syncFactory({ planId: plan.id });
		const revision = authority.stateFor(plan).state.revision;
		await restarted.syncFactory({ planId: plan.id });
		assert.equal(authority.stateFor(plan).state.revision, revision, "Recovery does not duplicate the retained terminal receipt");
	}));
}
