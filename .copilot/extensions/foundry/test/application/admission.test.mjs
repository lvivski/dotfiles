import assert from "node:assert/strict";
import test from "node:test";
import { createPlanMutations } from "../../application/mutation.mjs";
import { createRepositoryOperations } from "../../application/repository.mjs";
import { createStatusOperations } from "../../application/status.mjs";
import { createTaskOperations } from "../../application/tasks.mjs";
import { createFactoryBridge } from "../../bridge.mjs";
import { completeTaskAttempt, reserveTaskAttempt, retryTask } from "../../plan/execution.mjs";
import { LIMITS } from "../../plan/values.mjs";
import { admissionFence, createAdmissionStore } from "../../storage/admission.mjs";
import { must } from "../assertions.mjs";
import { COMMIT, git } from "../git.mjs";
import { analysisStub, createApproved, evidence, planBlueprint, withOperations } from "./fixture.mjs";

/** @typedef {import("../../types/plan.js").FoundryPlan} Plan */
/** @typedef {import("../../plan/admission.mjs").AdmissionContext} Context */
/** @typedef {import("../../application/tasks.mjs").AdmissionBinding["store"]} AdmissionStore */
/** @typedef {ReturnType<typeof createPlanMutations>["persist"]} Persist */
/** @typedef {import("./fixture.mjs").OperationsFixture} Fixture */
const NOW = "2026-11-13T06:00:00.000Z";
/** @type {import("../../types/parallel.js").ResourceClaim} */
const RESOURCE = { id: "output", kind: "shared-write", scope: "/fixture/shared-output", mode: "exclusive", capacity: 1, units: 1 };
const TEAM = { id: "implementers", capacity: 1, units: 1 };

/** @param {Fixture} fixture @param {Context} context
 * @param {{store?: AdmissionStore, persist?: Persist, owner?: string}} [options] */
function integrate(fixture, context, options = {}) {
	const { operations, workspacePath, notifications } = fixture;
	const workspace = () => options.owner ?? workspacePath;
	const notify = (/** @type {import("../../types/plan.js").ChangeEvent} */ event) => notifications.push(event);
	const store = options.store ?? createAdmissionStore({
		workspacePath, repositoryId: context.repositoryId, owner: context.owner,
		directoryParts: ["files", "application-admission"], clock: () => NOW,
	});
	const factory = createFactoryBridge({ workspace, storeFor: operations.storeFor, notify, storageRoot: workspacePath });
	const { persist } = createPlanMutations({ workspace, storeFor: operations.storeFor, notify, factory });
	const { syncFactoryPlan } = createRepositoryOperations({
		workspace, storeFor: operations.storeFor, notify, factory, analysis: analysisStub(),
	});
	const admissionFor = () => ({ store, context });
	return {
		store, persist,
		...createTaskOperations({ storeFor: operations.storeFor, persist: options.persist ?? persist, factory, syncFactoryPlan, admissionFor }),
		...createStatusOperations({
			storeFor: operations.storeFor, workspace, factory, admissionFor,
			workflowStatus: async () => { throw new Error("No live workflow inspection is authorized"); },
		}),
	};
}

/** @param {Plan} plan @param {string} [taskId] @param {string} [reservationId] */
const request = (plan, taskId = "T-001", reservationId = "application-reservation") => ({
	planId: plan.id, taskId, reservationId, expectedRevision: plan.revision,
});
/** @param {Context} context @param {ReturnType<typeof request>} input */
const identity = (context, input) => ({
	repositoryId: context.repositoryId, owner: context.owner,
	planId: input.planId, taskId: input.taskId, reservationId: input.reservationId,
});
/** @param {AdmissionStore} store @param {Context} context @param {ReturnType<typeof request>} input */
const record = (store, context, input) => must(store.read(identity(context, input)));

/** @template T
 * @param {(fixture: Fixture & {plan: Plan, context: Context, app: ReturnType<typeof integrate>}) => Promise<T>} operation
 * @param {import("../../types/plan.js").PlanBlueprint} [blueprint] */
const withAdmission = (operation, blueprint = planBlueprint()) => withOperations(async fixture => {
	const plan = await createApproved(fixture.operations, fixture.workspacePath);
	const authority = must(plan.factory);
	/** @type {Context} */
	const context = {
		repositoryId: authority.repositoryId, owner: authority.owner, authorized: true, now: NOW, claims: [],
		tasks: Object.fromEntries(plan.tasks.map(task => [task.id, { resources: [], team: null, dependencies: [] }])),
	};
	return operation({ ...fixture, plan, context, app: integrate(fixture, context) });
}, { analysis: analysisStub({ plan: blueprint }) });

test("application status and reservations agree on resource, team and observation holds", async t => {
	for (const kind of ["resource", "team", "observation"]) await t.test(kind, () => withAdmission(async fixture => {
		const { app, plan, context, workspacePath, operations } = fixture;
		const input = request(plan);
		const policy = context.tasks[input.taskId];
		assert.deepEqual((await app.nextTasks({ planId: plan.id })).tasks.map(task => task.id), ["T-001"]);
		if (kind === "observation") {
			policy.dependencies = [{
				repositoryId: context.repositoryId, owner: "/other-owner", planId: "producer", taskId: "T-001",
				minimumRevision: 2, observation: null,
			}];
		} else {
			policy.resources = kind === "resource" ? [RESOURCE] : [];
			policy.team = kind === "team" ? TEAM : null;
			const other = createAdmissionStore({
				workspacePath, repositoryId: context.repositoryId, owner: "/other-owner",
				directoryParts: ["files", "application-admission"], clock: () => NOW,
			});
			other.claim({
				identity: { ...identity(context, input), owner: "/other-owner", planId: "competing-plan" },
				expectedRevision: 0, resources: policy.resources, team: policy.team,
			});
		}
		const status = await app.getStatus({ planId: plan.id });
		const next = await app.nextTasks({ planId: plan.id });
		assert.deepEqual(status.projection.scheduling.dispatchableTaskIds, []);
		assert.deepEqual(next.dispatchableTaskIds, []);
		assert.deepEqual(next.tasks, [], "Held tasks must not be presented as launchable");
		assert.ok(status.projection.scheduling.holds.some(hold => hold.taskId === "T-001"
			&& hold.reasons.some(reason => reason.kind === (kind === "observation" ? "observation-completeness" : kind))));
		assert.equal(status.projection.actions.some(action => action.kind === "reserve-task"), false);
		const before = app.store.list();
		await assert.rejects(app.reserveTask(input), { code: "parallel_admission_held" });
		assert.deepEqual(app.store.list(), before);
		assert.equal((await operations.getPlan({ planId: plan.id })).revision, plan.revision);
		if (kind !== "observation") return;
		const dependency = policy.dependencies[0];
		dependency.observation = {
			authority: "observation-only", repositoryId: dependency.repositoryId, owner: dependency.owner,
			planId: dependency.planId, taskId: dependency.taskId, revision: 2, source: "fixture producer receipt",
			capturedAt: "2026-11-13T05:59:00.000Z", validUntil: "2026-11-13T06:01:00.000Z",
			complete: true, status: "available", commit: COMMIT,
		};
		const available = structuredClone(dependency.observation);
		for (const change of [{ complete: false }, { revision: 1 }, { validUntil: NOW }, { owner: "/wrong-owner" }]) {
			Object.assign(dependency.observation, available, change);
			assert.deepEqual((await app.nextTasks({ planId: plan.id })).tasks, []);
			await assert.rejects(app.reserveTask(input), { code: "parallel_admission_held" });
		}
		dependency.observation = available;
		assert.deepEqual((await app.nextTasks({ planId: plan.id })).tasks.map(task => task.id), ["T-001"]);
		const reserved = await app.reserveTask(input);
		assert.equal(reserved.plan.tasks[0].attempts.length, 1);
		assert.equal(record(app.store, context, input).attempt?.attemptId, reserved.attemptId);
	}));
});

test("application admission cannot borrow owner authority or imported claim state", () => withAdmission(async fixture => {
	const { app, plan, context, operations } = fixture;
	const input = request(plan);
	for (const change of [{ authorized: false }, { owner: "/foreign-owner" }, { repositoryId: "f".repeat(64) }]) {
		const foreign = integrate(fixture, { ...context, ...change }, { store: app.store });
		assert.deepEqual((await foreign.nextTasks({ planId: plan.id })).tasks, []);
		await assert.rejects(foreign.reserveTask(input), { code: "parallel_foreign_owner" });
	}
	const foreign = integrate(fixture, context, { store: app.store, owner: "/foreign-owner" });
	assert.equal((await foreign.getStatus({ planId: plan.id })).projection.factoryHold?.code, "factory_execution_foreign");
	await assert.rejects(foreign.reserveTask(input), { code: "factory_execution_foreign" });
	assert.equal(app.store.list().length, 0);
	const held = app.store.claim({ identity: identity(context, input), expectedRevision: 0, resources: [], team: null });
	context.claims = [{ ...held, phase: "released", revision: held.revision + 1 }];
	assert.deepEqual((await app.nextTasks({ planId: plan.id })).tasks, [], "Context history cannot overwrite live claim occupancy");
	assert.equal((await operations.getPlan({ planId: plan.id })).revision, plan.revision);
}));

test("matching reservations replay their exact claim and reject changed correlations or policy", () => withAdmission(async fixture => {
	const { app, plan, context, operations } = fixture;
	const input = request(plan);
	context.tasks["T-001"].resources = [RESOURCE];
	await assert.rejects(app.reserveTask({ ...input, expectedRevision: plan.revision - 1 }), { code: "revision_conflict" });
	assert.equal(app.store.list().length, 0);
	const reserved = await app.reserveTask(input);
	const held = record(app.store, context, input);
	const replay = await app.reserveTask(input);
	assert.deepEqual(replay, reserved);
	assert.deepEqual(record(app.store, context, input), held);
	await assert.rejects(app.reserveTask({ ...input, taskId: "T-002" }), { code: "duplicate_request_id" });
	await assert.rejects(app.reserveTask({ ...input, scopeOverride: { approvedBy: "owner", reason: "Changed approval" } }), { code: "parallel_claim_mismatch" });
	context.tasks["T-001"].resources = [];
	await assert.rejects(app.reserveTask(input), { code: "parallel_claim_mismatch" });
	assert.deepEqual(record(app.store, context, input), held);
	assert.equal((await operations.getPlan({ planId: plan.id })).tasks[0].attempts.length, 1);
}));

test("native reservation feasibility is checked before acquiring any fresh claim", async t => {
	await t.test("invalid override, running and terminal tasks", () => withAdmission(async fixture => {
		const { app, plan, operations } = fixture;
		await assert.rejects(app.reserveTask({
			...request(plan), scopeOverride: { approvedBy: "", reason: "Invalid approval" },
		}), /scopeOverride.approvedBy/);
		assert.equal(app.store.list().length, 0);
		const legacy = await operations.reserveTask(request(plan, "T-001", "legacy-reservation"));
		await assert.rejects(app.reserveTask(request(legacy.plan)), { code: "invalid_task_transition" });
		assert.equal(app.store.list().length, 0);
		const attached = await operations.attachTask({
			planId: plan.id, taskId: "T-001", attemptId: legacy.attemptId, expectedRevision: legacy.plan.revision,
			sessionId: "legacy-child", branch: "work/legacy",
		});
		const completed = await operations.completeTask({
			planId: plan.id, taskId: "T-001", attemptId: legacy.attemptId, expectedRevision: attached.revision,
			status: "done", resultSummary: "Branch delivered", evidence: evidence("Passed"),
		});
		await assert.rejects(app.reserveTask(request(completed)), { code: "invalid_task_transition" });
		assert.equal(app.store.list().length, 0);
		assert.equal((await operations.getPlan({ planId: plan.id })).revision, completed.revision);
	}));
	await t.test("attempt limit", () => withAdmission(async ({ app, plan }) => {
		const exhausted = await app.persist(plan.id, plan.revision, current => {
			for (let index = 0; index < LIMITS.attempts; index++) {
				current = reserveTaskAttempt(current, "T-001", { reservationId: `failed-reservation-${index}` });
				const attempt = must(current.tasks[0].attempts.at(-1));
				current = completeTaskAttempt(current, "T-001", attempt.id, "failed", { error: "Definitive failure before creating a child" });
				current = retryTask(current, "T-001");
			}
			return current;
		}, "exhausted-attempt-history");
		await assert.rejects(app.reserveTask(request(exhausted)), { code: "attempt_limit_reached" });
		assert.equal(app.store.list().length, 0);
	}));
});

test("reservation faults retain claims and reconcile the same durable attempt after reopening", async t => {
	for (const fault of ["before-commit", "revision-conflict", "after-commit"]) await t.test(fault, () => withAdmission(async fixture => {
		const { app, context, plan, operations } = fixture;
		const input = request(plan);
		context.tasks["T-001"].resources = [RESOURCE];
		let writes = 0;
		/** @type {Persist} */
		const persist = async (...args) => {
			writes++;
			if (fault === "before-commit") {
				const [planId, revision, change, event, settings] = args;
				return app.persist(planId, revision, (current, delegation) => {
					change(current, delegation);
					throw new Error("injected before plan commit");
				}, event, settings);
			}
			if (fault === "revision-conflict") await app.persist(plan.id, plan.revision, current => current, "concurrent-plan-write");
			const result = await app.persist(...args);
			if (fault === "after-commit") throw new Error("injected after plan commit before bind");
			return result;
		};
		const interrupted = integrate(fixture, context, { store: app.store, persist });
		await assert.rejects(interrupted.reserveTask(input), fault === "revision-conflict" ? { code: "revision_conflict" } : /injected/);
		const held = record(app.store, context, input);
		assert.equal(held.phase, "claim-held");
		assert.equal(held.attempt, null);
		let durable = await operations.getPlan({ planId: plan.id });
		assert.equal(durable.tasks[0].attempts.length, fault === "after-commit" ? 1 : 0);
		const reopened = integrate(fixture, context);
		assert.deepEqual(record(reopened.store, context, input), held);
		assert.deepEqual((await reopened.nextTasks({ planId: plan.id })).tasks, []);
		assert.equal((await reopened.getStatus({ planId: plan.id })).projection.actions.some(action => action.kind === "create-or-attach-session"), false);
		await assert.rejects(reopened.reserveTask(request(durable, "T-001", "replacement")), {
			code: fault === "after-commit" ? "invalid_task_transition" : "scope_overlap_requires_approval",
		});
		const replay = await reopened.reserveTask({ ...input, expectedRevision: durable.revision });
		durable = await operations.getPlan({ planId: plan.id });
		assert.equal(durable.tasks[0].attempts.length, 1);
		assert.equal(record(reopened.store, context, input).attempt?.attemptId, replay.attemptId);
		assert.equal(durable.tasks[0].attempts[0].reservationId, input.reservationId);
		assert.equal(durable.revision, replay.plan.revision);
		assert.equal(writes, 1);
	}));
});

test("an existing held claim resumes ahead of newly-ready prospective competitors", () => withAdmission(async fixture => {
	const { app, context, plan, operations, workspacePath } = fixture;
	context.tasks["T-001"].resources = [RESOURCE];
	context.tasks["T-002"].resources = [RESOURCE];
	context.tasks["T-003"].resources = [RESOURCE];
	await assert.rejects(app.reserveTask(request(plan, "T-003", "fresh-later-candidate")), { code: "parallel_admission_held" });
	assert.equal(app.store.list().length, 0, "Fresh requests still obey the full greedy selection");
	context.tasks["T-003"].resources = [];
	const input = request(plan, "T-002", "held-before-prerequisite");
	/** @type {Persist} */
	const persist = (planId, revision, change, event, settings) => app.persist(planId, revision, (current, delegation) => {
		change(current, delegation);
		throw new Error("injected before T-002 plan commit");
	}, event, settings);
	const interrupted = integrate(fixture, context, { store: app.store, persist });
	await assert.rejects(interrupted.reserveTask(input), /injected before T-002 plan commit/);
	const held = record(app.store, context, input);
	assert.equal(held.phase, "claim-held");
	assert.equal((await operations.getPlan({ planId: plan.id })).tasks[1].attempts.length, 0);
	const producer = await app.reserveTask(request(plan, "T-003", "prerequisite-completion"));
	const branch = "work/prerequisite-completion";
	git(workspacePath, "update-ref", `refs/heads/${branch}`, COMMIT);
	const attached = await app.attachTask({
		planId: plan.id, taskId: "T-003", attemptId: producer.attemptId, expectedRevision: producer.plan.revision,
		sessionId: "prerequisite-child", branch,
	});
	const completed = await app.completeTask({
		planId: plan.id, taskId: "T-003", attemptId: producer.attemptId, expectedRevision: attached.revision,
		status: "done", resultSummary: "Prerequisite complete", evidence: evidence("Passed"), commit: COMMIT,
	});
	const reopened = integrate(fixture, context);
	const status = await reopened.getStatus({ planId: plan.id });
	assert.ok(status.projection.scheduling.readyTaskIds.includes("T-001"));
	assert.deepEqual(status.projection.scheduling.dispatchableTaskIds, []);
	assert.equal(completed.tasks[2].status, "done");
	const replayInput = { ...input, expectedRevision: completed.revision };
	await assert.rejects(reopened.reserveTask({ ...replayInput, reservationId: "different-correlation" }), { code: "scope_overlap_requires_approval" });
	context.authorized = false;
	await assert.rejects(reopened.reserveTask(replayInput), { code: "parallel_foreign_owner" });
	context.authorized = true;
	context.tasks["T-002"].dependencies = [{
		repositoryId: context.repositoryId, owner: "/producer", planId: "external-dependency",
		taskId: "T-001", minimumRevision: 1, observation: null,
	}];
	await assert.rejects(reopened.reserveTask(replayInput), { code: "parallel_admission_held" });
	context.tasks["T-002"].dependencies = [];
	context.tasks["T-002"].resources = [];
	await assert.rejects(reopened.reserveTask(replayInput), { code: "parallel_claim_mismatch" });
	context.tasks["T-002"].resources = [RESOURCE];
	assert.deepEqual(record(reopened.store, context, input), held);
	assert.equal((await operations.getPlan({ planId: plan.id })).revision, completed.revision);
	const resumed = await reopened.reserveTask(replayInput);
	assert.equal(resumed.plan.tasks[1].attempts.length, 1);
	assert.equal(resumed.plan.tasks[1].attempts[0].reservationId, input.reservationId);
	assert.equal(record(reopened.store, context, input).attempt?.attemptId, resumed.attemptId);
	const after = await reopened.getStatus({ planId: plan.id });
	assert.deepEqual(after.projection.scheduling.dispatchableTaskIds, []);
	assert.ok(after.projection.scheduling.holds.some(hold => hold.taskId === "T-001"
		&& hold.reasons.some(reason => reason.code === "resource-claimed")));
	await assert.rejects(reopened.reserveTask(request(resumed.plan, "T-001", "prospective-competitor")), { code: "parallel_admission_held" });
	assert.deepEqual(await reopened.reserveTask(replayInput), resumed);
	assert.equal((await operations.getPlan({ planId: plan.id })).tasks[1].attempts.length, 1);
}, {
	...planBlueprint(),
	tasks: [
		{ ...planBlueprint().tasks[0], dependsOn: ["T-003"] },
		{ ...planBlueprint().tasks[1], dependsOn: [] },
		{ ...planBlueprint().tasks[0], id: "T-003", title: "Prerequisite", expectedFiles: ["src/prerequisite.mjs"] },
		{
			...planBlueprint().tasks[1], id: "T-004", title: "Final integration",
			dependsOn: ["T-001", "T-002"], expectedFiles: ["src/final-integration.mjs"],
		},
		{ ...planBlueprint().tasks[2], id: "T-005", dependsOn: ["T-004"] },
	],
}));

test("cancellation during the reservation gap retains the exact attempt and authorizes no new work", () => withAdmission(async fixture => {
	const { app, plan, context, operations } = fixture;
	const input = request(plan);
	/** @type {Persist} */
	const persist = async (...args) => {
		const result = await app.persist(...args);
		app.store.cancel(admissionFence(record(app.store, context, input)));
		return result;
	};
	const interrupted = integrate(fixture, context, { store: app.store, persist });
	await assert.rejects(interrupted.reserveTask(input), { code: "parallel_fenced" });
	const held = record(app.store, context, input);
	assert.equal(held.phase, "cancelling");
	assert.equal(held.attempt?.attemptId, "T-001-A001");
	await assert.rejects(app.reserveTask(input), { code: "parallel_fenced" });
	assert.equal((await app.getStatus({ planId: plan.id })).projection.actions.some(action => action.kind === "create-or-attach-session"), false);
	const durable = await operations.getPlan({ planId: plan.id });
	const cancelled = await operations.cancel({
		planId: plan.id, expectedRevision: durable.revision, requestId: "cancel-admission",
		requestedBy: "fixture-owner", reason: "Stop the reserved attempt",
	});
	assert.deepEqual((await app.nextTasks({ planId: plan.id })).tasks, []);
	await assert.rejects(app.reserveTask(request(cancelled, "T-002", "after-cancellation")), { code: "parallel_admission_held" });
	assert.equal((await operations.getPlan({ planId: plan.id })).tasks[0].attempts.length, 1);
	assert.deepEqual(record(app.store, context, input), held);
	assert.throws(() => app.store.release(admissionFence(held)), { code: "parallel_unsafe_release" });
}));

test("native plan cancellation prevents replay from authorizing a still-held admission", () => withAdmission(async ({ app, plan, operations, context }) => {
	const input = request(plan);
	const reserved = await app.reserveTask(input);
	const held = record(app.store, context, input);
	const cancelled = await operations.cancel({
		planId: plan.id, expectedRevision: reserved.plan.revision, requestId: "native-cancel",
		requestedBy: "fixture-owner", reason: "Stop before admission reconciliation",
	});
	await assert.rejects(app.reserveTask(input), { code: "parallel_fenced" });
	await assert.rejects(app.reserveTask(request(cancelled, "T-002", "no-new-work")), { code: "parallel_admission_held" });
	assert.deepEqual(record(app.store, context, input), held);
	assert.deepEqual((await app.nextTasks({ planId: plan.id })).tasks, []);
	assert.equal((await operations.getPlan({ planId: plan.id })).revision, cancelled.revision);
}));

test("only successful recorded full delivery releases capacity and unblocks dependent reservations", () => withAdmission(async fixture => {
	const { app, plan, context, operations, workspacePath } = fixture;
	const input = request(plan);
	context.tasks["T-001"].resources = [RESOURCE];
	context.tasks["T-002"].resources = [RESOURCE];
	const reserved = await app.reserveTask(input);
	const branch = "work/application-delivery";
	git(workspacePath, "update-ref", `refs/heads/${branch}`, COMMIT);
	const attached = await app.attachTask({
		planId: plan.id, taskId: input.taskId, attemptId: reserved.attemptId,
		expectedRevision: reserved.plan.revision, sessionId: "application-child", branch,
	});
	const completion = {
		planId: plan.id, taskId: input.taskId, attemptId: reserved.attemptId, expectedRevision: attached.revision,
		status: /** @type {const} */ ("done"), resultSummary: "Delivered", evidence: evidence("Passed"), branch, commit: COMMIT,
	};
	const held = record(app.store, context, input);
	for (const change of [{ commit: undefined }, { commit: "abcdef0" }, { evidence: [] }]) {
		await assert.rejects(app.completeTask({ ...completion, ...change }), { code: "task_completion_incomplete" });
		assert.equal((await operations.getPlan({ planId: plan.id })).revision, attached.revision);
		assert.deepEqual(record(app.store, context, input), held);
	}
	/** @type {Persist} */
	const failingPersist = (planId, revision, change, event, settings) => app.persist(planId, revision, (current, delegation) => {
		const candidate = change(current, delegation);
		assert.equal(candidate.tasks[0].status, "done");
		throw new Error("injected before completion commit");
	}, event, settings);
	const interrupted = integrate(fixture, context, { store: app.store, persist: failingPersist });
	await assert.rejects(interrupted.completeTask(completion), /injected before completion commit/);
	assert.equal((await operations.getPlan({ planId: plan.id })).revision, attached.revision);
	assert.deepEqual(record(app.store, context, input), held);
	let committed = false;
	let deliveries = 0;
	/** @type {Persist} */
	const persist = async (...args) => {
		assert.equal(record(app.store, context, input).delivery, null);
		assert.deepEqual((await app.nextTasks({ planId: plan.id })).tasks, []);
		const updated = await app.persist(...args);
		const durable = await operations.getPlan({ planId: plan.id });
		assert.deepEqual(durable, updated);
		assert.equal(durable.tasks[0].status, "done");
		committed = true;
		return updated;
	};
	const deliveryStore = {
		...app.store,
		deliver(/** @type {import("../../types/parallel.js").Fence} */ fence, /** @type {import("../../types/parallel.js").DeliveryReceipt} */ receipt) {
			assert.equal(committed, true, "Delivery must follow the committed terminal plan");
			deliveries++;
			return app.store.deliver(fence, receipt);
		},
	};
	const finishing = integrate(fixture, context, { store: deliveryStore, persist });
	const done = await finishing.completeTask(completion);
	const released = record(app.store, context, input);
	assert.equal(released.phase, "released");
	assert.equal(released.delivery?.commit, COMMIT);
	assert.equal(released.delivery?.planRevision, done.revision);
	assert.equal(released.delivery?.attempt.attemptId, reserved.attemptId);
	assert.equal(deliveries, 1);
	assert.deepEqual((await app.nextTasks({ planId: plan.id })).tasks.map(task => task.id), ["T-002"]);
	const next = await app.reserveTask(request(done, "T-002", "dependent"));
	assert.equal(next.plan.tasks[1].attempts.length, 1);
	assert.deepEqual(record(app.store, context, input), released);
}, {
	...planBlueprint(),
	tasks: planBlueprint().tasks.map(task => ({ ...task, deliveryRequirement: "commit" })),
}));

test("branch-only results, failed attempts and unresolved native workflows retain their claims", async t => {
	for (const result of ["branch-only", "failed", "workflow-in-flight", "workflow-succeeded"]) {
		await t.test(result, child => withAdmission(async fixture => {
			const { app, plan, context, operations, workspacePath } = fixture;
			const input = request(plan);
			context.tasks["T-001"].resources = [RESOURCE];
			context.tasks["T-002"].resources = [RESOURCE];
			const reserved = await app.reserveTask(input);
			const branch = "work/held-result";
			git(workspacePath, "update-ref", `refs/heads/${branch}`, COMMIT);
			const attached = await app.attachTask({
				planId: plan.id, taskId: input.taskId, attemptId: reserved.attemptId,
				expectedRevision: reserved.plan.revision, sessionId: "held-result-child", branch,
			});
			if (result === "failed") child.mock.timers.enable({ apis: ["Date"], now: Date.now() + 1 });
			if (result.startsWith("workflow")) {
				const held = record(app.store, context, input);
				app.store.withFence(admissionFence(held), ({ admission }) => admission.receipts.push({
					id: "native-workflow", attempt: must(admission.attempt), kind: "workflow", epoch: admission.epoch,
					payloadDigest: "b".repeat(64), state: "intent", sessionId: null, runId: null, source: "fixture workflow intent", at: NOW,
				}));
				app.store.withFence(admissionFence(record(app.store, context, input)), ({ admission }) => {
					admission.receipts[0].state = "in-flight";
				});
				if (result === "workflow-succeeded") app.store.withFence(admissionFence(record(app.store, context, input)), ({ admission }) => {
					admission.receipts[0] = { ...admission.receipts[0], state: "succeeded", runId: "actual-native-run" };
				});
			}
			const completion = {
				planId: plan.id, taskId: input.taskId, attemptId: reserved.attemptId, expectedRevision: attached.revision,
				status: result === "failed" ? /** @type {const} */ ("failed") : /** @type {const} */ ("done"),
				resultSummary: "Recorded result", evidence: evidence("Passed"), branch,
				commit: result === "branch-only" ? undefined : COMMIT,
				error: result === "failed" ? "Worker failed" : undefined,
				sessionInventory: {
					complete: true, capturedAt: new Date().toISOString(),
					sessions: [{ id: "held-result-child", status: "archived" }],
				},
			};
			const before = record(app.store, context, input);
			if (result.startsWith("workflow")) await assert.rejects(app.completeTask(completion), { code: "parallel_unsafe_release" });
			else await app.completeTask(completion);
			const durable = await operations.getPlan({ planId: plan.id });
			assert.equal(durable.tasks[0].status, completion.status);
			assert.deepEqual(record(app.store, context, input), before);
			assert.deepEqual((await app.nextTasks({ planId: plan.id })).tasks, []);
			assert.throws(() => app.store.release(admissionFence(before)), { code: "parallel_unsafe_release" });
		}));
	}
});

test("branch-only done labels do not free an unreleased admission's overlapping file scope", () => withAdmission(async ({ app, plan, context, operations }) => {
	const input = request(plan);
	const reserved = await app.reserveTask(input);
	const attached = await app.attachTask({
		planId: plan.id, taskId: input.taskId, attemptId: reserved.attemptId, expectedRevision: reserved.plan.revision,
		sessionId: "scope-held-child", branch: "work/scope-held",
	});
	const done = await app.completeTask({
		planId: plan.id, taskId: input.taskId, attemptId: reserved.attemptId, expectedRevision: attached.revision,
		status: "done", resultSummary: "Branch delivered; admission not settled", evidence: evidence("Passed"),
	});
	const held = record(app.store, context, input);
	assert.equal(held.phase, "reserved");
	assert.equal(held.delivery, null);
	assert.deepEqual(held.resources, []);
	const next = await app.nextTasks({ planId: plan.id });
	assert.deepEqual(next.dispatchableTaskIds, []);
	assert.deepEqual(next.tasks, []);
	assert.ok(next.holds.some(hold => hold.taskId === "T-002" && hold.reasons.some(reason => reason.kind === "scope")));
	await assert.rejects(app.reserveTask(request(done, "T-002", "overlapping-successor")), { code: "scope_overlap_requires_approval" });
	assert.deepEqual(record(app.store, context, input), held);
	assert.equal(app.store.list().length, 1);
	assert.equal((await operations.getPlan({ planId: plan.id })).revision, done.revision);
}, {
	...planBlueprint(),
	tasks: planBlueprint().tasks.map(task => task.kind === "implement" ? { ...task, expectedFiles: ["src/shared.mjs"] } : task),
}));

test("recorded completion reconciles a delivery or release fault without a second plan mutation", async t => {
	for (const fault of ["deliver", "release"]) await t.test(fault, () => withAdmission(async fixture => {
		const { app, plan, context, operations, workspacePath } = fixture;
		const input = request(plan);
		context.tasks["T-001"].resources = [RESOURCE];
		context.tasks["T-002"].resources = [RESOURCE];
		const reserved = await app.reserveTask(input);
		const branch = "work/delivery-gap";
		git(workspacePath, "update-ref", `refs/heads/${branch}`, COMMIT);
		const attached = await app.attachTask({
			planId: plan.id, taskId: input.taskId, attemptId: reserved.attemptId,
			expectedRevision: reserved.plan.revision, sessionId: "delivery-gap-child", branch,
		});
		const completion = {
			planId: plan.id, taskId: input.taskId, attemptId: reserved.attemptId, expectedRevision: attached.revision,
			status: /** @type {const} */ ("done"), resultSummary: "Delivered once", evidence: evidence("Passed"), branch, commit: COMMIT,
		};
		const interrupted = integrate(fixture, context, {
			store: { ...app.store, [fault]: () => { throw new Error(`injected ${fault} gap`); } },
		});
		await assert.rejects(interrupted.completeTask(completion), /injected/);
		const durable = await operations.getPlan({ planId: plan.id });
		assert.equal(durable.tasks[0].status, "done");
		assert.equal(record(app.store, context, input).phase, fault === "deliver" ? "reserved" : "settled");
		assert.deepEqual((await app.nextTasks({ planId: plan.id })).tasks, []);
		const latest = await app.persist(plan.id, durable.revision, current => current, "later-observation");
		const reopened = integrate(fixture, context);
		await assert.rejects(reopened.completeTask({ ...completion, commit: "f".repeat(40) }), { code: "parallel_delivery_mismatch" });
		await assert.rejects(reopened.completeTask({ ...completion, evidence: evidence("Changed evidence") }), { code: "parallel_delivery_mismatch" });
		const replay = await reopened.completeTask(completion);
		assert.deepEqual(replay, latest);
		assert.equal(record(reopened.store, context, input).phase, "released");
		assert.equal(record(reopened.store, context, input).delivery?.planRevision, durable.revision);
		assert.deepEqual(await reopened.completeTask(completion), latest);
		assert.equal((await operations.getPlan({ planId: plan.id })).revision, latest.revision);
	}));
});
