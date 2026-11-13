import assert from "node:assert/strict";
import test from "node:test";
import { projectAdmission, observationHolds } from "../../plan/admission.mjs";
import { reserveTaskAttempt } from "../../plan/execution.mjs";
import { dependencyObservation } from "../../plan/parallel-contracts.mjs";
import { projectPlan } from "../../projection.mjs";
import { createAdmissionStore, admissionFence } from "../../storage/admission.mjs";
import { createParallelFixture, assertExclusiveClaims } from "../parallel/fixture.mjs";
import { approved, task, completeTask } from "./fixture.mjs";

const REPO = "a".repeat(64), OWNER = "/fixture/owner", NOW = "2026-11-13T00:00:00.000Z";
/** @param {import("../../types/plan.js").FoundryPlan} plan */
function bind(plan) {
	plan.factory = { repositoryId: REPO, owner: OWNER, unitId: "parallel-test", unitRevision: 1, candidateId: null,
		contractRevision: null, contractDigest: null, contextDigest: null, blueprintDigest: "b".repeat(64) };
	return plan;
}
/** @param {import("../../types/plan.js").FoundryPlan} plan @returns {import("../../plan/admission.mjs").AdmissionContext} */
function context(plan) {
	return { repositoryId: REPO, owner: OWNER, authorized: true, now: NOW, claims: [],
		tasks: Object.fromEntries(plan.tasks.map(task => [task.id, { resources: [], team: null, dependencies: [] }])) };
}
/** @param {string} scope @param {import("../../types/parallel.js").ResourceClaim["kind"]} [kind] @returns {import("../../types/parallel.js").ResourceClaim} */
const exclusive = (scope, kind = "shared-write") => ({ id: `resource-${kind}`, kind, scope, mode: "exclusive", capacity: 1, units: 1 });
/** @returns {import("../../plan/admission.mjs").ExternalDependency} */
function external() {
	return { repositoryId: REPO, owner: "/other/owner", planId: "other-plan", taskId: "T-001", minimumRevision: 7,
		observation: { authority: "observation-only", repositoryId: REPO, owner: "/other/owner", planId: "other-plan", taskId: "T-001",
			revision: 7, source: "exact foreign status snapshot", capturedAt: "2026-11-12T23:59:00.000Z",
			validUntil: "2026-11-13T00:01:00.000Z", complete: true, status: "available", commit: "c".repeat(40) } };
}

/** @param {import("../../types/parallel.js").ResourceClaim} left
 * @param {import("../../types/parallel.js").ResourceClaim} right @param {boolean} overlap */
function assertResourceAdmission(left, right, overlap) {
	const fixture = createParallelFixture({ name: "resource-path-overlap" });
	try {
		const plan = bind(approved({ tasks: [task("T-002"), task("T-001")] }));
		const input = context(plan);
		input.tasks["T-001"].resources = [{ ...left, id: "first-label" }];
		input.tasks["T-002"].resources = [{ ...right, id: "different-label" }];
		const description = `${left.kind}:${left.scope} versus ${right.kind}:${right.scope}`;
		const projected = projectAdmission(plan, input);
		assert.deepEqual(projected.dispatchableTaskIds, overlap ? ["T-001"] : ["T-001", "T-002"], description);
		if (overlap) assert.ok(projected.holds[0].reasons.some(reason => reason.kind === "resource"), description);
		const store = createAdmissionStore({ workspacePath: fixture.workspacePath, repositoryId: REPO, owner: OWNER });
		/** @param {string} taskId */
		const request = taskId => ({
			identity: { repositoryId: REPO, owner: OWNER, planId: plan.id, taskId, reservationId: `reserve-${taskId}` },
			expectedRevision: 0, resources: input.tasks[taskId].resources, team: null,
		});
		store.claim(request("T-001"));
		input.claims = store.list();
		assert.deepEqual(projectAdmission(plan, input).dispatchableTaskIds, overlap ? [] : ["T-002"], description);
		const reopened = createAdmissionStore({ workspacePath: fixture.workspacePath, repositoryId: REPO, owner: OWNER });
		if (overlap) {
			assert.throws(() => reopened.claim(request("T-002")), { code: "parallel_capacity_held" }, description);
			assert.equal(reopened.read(request("T-002").identity), null, description);
			assert.equal(reopened.list().length, 1, description);
		} else {
			reopened.claim(request("T-002"));
			assert.equal(reopened.list().length, 2, description);
		}
	} finally { fixture.dispose(); }
}

test("PF-ADM-01/02 distinct deterministic holds preserve observation-only provenance", () => {
	const plan = bind(approved({ tasks: Array.from({ length: 7 }, (_, index) => task(`T-00${index + 1}`)) }));
	plan.tasks[1].dependsOn = ["T-001"];
	plan.tasks[2].expectedFiles = [...plan.tasks[0].expectedFiles];
	const input = context(plan);
	input.tasks["T-001"].resources = [exclusive("host-input", "foreground-input")];
	input.tasks["T-004"].resources = [exclusive("host-input", "foreground-input")];
	input.tasks["T-001"].team = { id: "explicit-team", capacity: 1, units: 1 };
	input.tasks["T-005"].team = { id: "explicit-team", capacity: 1, units: 1 };
	input.tasks["T-006"].dependencies = [{ ...external(), observation: null }];
	delete input.tasks["T-007"];
	const before = structuredClone({ plan, input });
	const projection = projectAdmission(plan, input);
	assert.deepEqual(projection.dispatchableTaskIds, ["T-001"]);
	for (const [taskId, kind] of [["T-002", "dependency"], ["T-003", "scope"], ["T-004", "resource"], ["T-005", "team"], ["T-006", "observation-completeness"], ["T-007", "authority"]]) {
		assert.ok(projection.holds.find(hold => hold.taskId === taskId)?.reasons.some(reason => reason.kind === kind), `${taskId}: ${kind}`);
	}
	assert.deepEqual({ plan, input }, before);
	const foreign = external();
	assert.deepEqual(observationHolds([foreign], NOW), []);
	assert.ok(foreign.observation);
	const observation = foreign.observation;
	/** @type {Partial<import("../../types/parallel.js").DependencyObservation>[]} */
	const changes = [
		{ complete: false }, { revision: 6 }, { owner: OWNER }, { status: "unknown" }, { validUntil: NOW }, { capturedAt: "2026-11-13T00:00:30.000Z" },
	];
	for (const changed of changes) {
		/** @type {import("../../types/parallel.js").DependencyObservation} */
		const observed = { ...observation, ...changed };
		assert.equal(observationHolds([{ ...foreign, observation: observed }], NOW).length, 1);
	}
	assert.throws(() => dependencyObservation({ ...observation, authority: "execution" }), { code: "parallel_observation_authority" });
	input.tasks["T-002"].dependencies = [external()];
	assert.ok(projectAdmission(plan, input).holds.find(hold => hold.taskId === "T-002")?.reasons.some(reason => reason.kind === "dependency"));
	assert.deepEqual(projectAdmission(plan, { ...input, owner: "/foreign/owner" }).dispatchableTaskIds, []);
	assert.deepEqual(projectAdmission(plan, { ...input, authorized: false }).dispatchableTaskIds, []);
});

test("PF-ADM-05 independent outputs admit concurrently; disjoint files do not imply shared-resource freedom", () => {
	const plan = bind(approved({ tasks: [task("T-002"), task("T-001")] }));
	const input = context(plan);
	input.tasks["T-001"].resources = [exclusive("/worktree-one/output", "worktree-build")];
	input.tasks["T-002"].resources = [exclusive("/worktree-two/output", "worktree-build")];
	assert.deepEqual(projectAdmission(plan, input).dispatchableTaskIds, ["T-001", "T-002"]);
	for (const kind of /** @type {const} */ (["foreground-input", "shared-write", "exact-package"])) {
		input.tasks["T-001"].resources = [exclusive("same-physical-resource", kind)];
		input.tasks["T-002"].resources = [exclusive("same-physical-resource", kind)];
		assert.deepEqual(projectAdmission(plan, input).dispatchableTaskIds, ["T-001"]);
	}
	input.tasks["T-001"].resources = [];
	input.tasks["T-002"].resources = [];
	input.tasks["T-001"].team = { id: "explicit-two", capacity: 2, units: 1 };
	input.tasks["T-002"].team = { id: "explicit-two", capacity: 2, units: 1 };
	assert.equal(projectAdmission(plan, input).dispatchableTaskIds.length, 2);
	input.tasks["T-002"].team.capacity = 3;
	assert.ok(projectAdmission(plan, input).holds.find(hold => hold.taskId === "T-002")?.reasons.some(reason => reason.code === "team-configuration-conflict"));
});

test("PF-ADM-05 path resources conservatively exclude ancestors, aliases and ambiguous scopes", () => {
	for (const kind of /** @type {const} */ (["shared-write", "worktree-build"])) {
		for (const [left, right] of [
			["/cache", "/cache/subdir"],
			["/CACHE/./", "/cache/subdir/output"],
			["/cache/", "/cache"],
			["cache", "cache/subdir"],
			["/", "/separate/output"],
			[".", "/separate/output"],
			["cache/../output", "/separate/output"],
			["cache/nested/..", "separate/output"],
			["/cache/*", "/separate/output"],
			["C:cache", "/separate/output"],
			["//host/cache", "/separate/output"],
			["~/cache", "/separate/output"],
			["cache", "/separate/output"],
		]) {
			assertResourceAdmission(exclusive(left, kind), exclusive(right, kind), true);
			assertResourceAdmission(exclusive(right, kind), exclusive(left, kind), true);
		}
	}
});

test("PF-ADM-05 independent paths retain kind separation, exact identities and explicit shared capacity", () => {
	for (const kind of /** @type {const} */ (["shared-write", "worktree-build"])) {
		for (const [left, right] of [
			["/cache", "/cache-other"],
			["/cache/one", "/cache/two"],
			["/worktree-one/output", "/worktree-two/output"],
			["cache/one", "cache/two"],
		]) assertResourceAdmission(exclusive(left, kind), exclusive(right, kind), false);
	}
	for (const kind of /** @type {const} */ (["foreground-input", "exact-package"])) {
		assertResourceAdmission(exclusive("/cache", kind), exclusive("/cache/subdir", kind), false);
		assertResourceAdmission(exclusive("/", kind), exclusive("/cache", kind), false);
		assertResourceAdmission(exclusive("/cache", kind), exclusive("/CACHE/./output/..", kind), true);
	}
	assertResourceAdmission(exclusive("/cache", "shared-write"), exclusive("/cache", "worktree-build"), false);
	const shared = { ...exclusive("/cache", "worktree-build"), mode: /** @type {const} */ ("shared"), capacity: 2 };
	assertResourceAdmission(shared, { ...shared, scope: "/CACHE/./" }, false);
	assertResourceAdmission(shared, { ...shared, scope: "/cache/subdir", capacity: 3 }, true);
});

test("PF-ADM-05 completed tasks retain their file scope until pending workflows settle and claims release", () => {
	const fixture = createParallelFixture({ name: "completed-scope-retained" });
	try {
		const first = task("T-001"), second = { ...task("T-002", ["T-001"]), expectedFiles: [...first.expectedFiles] };
		let plan = bind(approved({ tasks: [first, second] }));
		const store = createAdmissionStore({ workspacePath: fixture.workspacePath, repositoryId: REPO, owner: OWNER, clock: () => NOW });
		const identity = { repositoryId: REPO, owner: OWNER, planId: plan.id, taskId: first.id, reservationId: "retained-reservation" };
		const claimed = store.claim({ identity, expectedRevision: 0, resources: [], team: null });
		const completed = completeTask(plan, first.id, { reservationId: identity.reservationId });
		const bound = store.bindReservation(admissionFence(claimed), { ...identity, attemptId: completed.attemptId });
		assert.ok(bound.attempt);
		const attempt = bound.attempt;
		/** @type {import("../../types/parallel.js").EffectReceipt} */
		const workflow = {
			id: "pending-workflow", attempt, kind: "workflow", epoch: bound.epoch, payloadDigest: "b".repeat(64),
			state: "intent", sessionId: null, runId: null, source: "owned workflow invocation", at: NOW,
		};
		store.withFence(admissionFence(bound), ({ admission }) => { admission.receipts.push(workflow); });
		const read = () => {
			const record = store.read(identity);
			assert.ok(record);
			return record;
		};
		store.withFence(admissionFence(read()), ({ admission }) => { admission.receipts[0].state = "in-flight"; });
		plan = completed.plan;
		const input = context(plan);
		const assertHeld = () => {
			input.claims = store.list();
			const projection = projectPlan(plan, { admission: input });
			assert.deepEqual(projection.scheduling.readyTaskIds, ["T-002"]);
			assert.deepEqual(projection.scheduling.occupiedTaskIds, ["T-001"]);
			assert.deepEqual(projection.scheduling.dispatchableTaskIds, []);
			assert.ok(projection.scheduling.holds.find(hold => hold.taskId === "T-002")?.reasons.some(reason => reason.kind === "scope"));
			assert.ok(!projection.actions.some(action => action.kind === "reserve-task"));
		};
		const delivery = {
			attempt, sessionId: `session-${completed.attemptId}`, commit: "a".repeat(40),
			planRevision: plan.revision, source: "recorded successful plan delivery", terminalRunIds: [],
		};
		assert.throws(() => store.deliver(admissionFence(read()), delivery), { code: "parallel_unsafe_release" });
		assertHeld();
		store.withFence(admissionFence(read()), ({ admission }) => {
			admission.receipts[0] = { ...admission.receipts[0], state: "succeeded", runId: "owned-workflow" };
		});
		assert.throws(() => store.deliver(admissionFence(read()), delivery), { code: "parallel_unsafe_release" });
		assertHeld();
		const settled = store.deliver(admissionFence(read()), { ...delivery, terminalRunIds: ["owned-workflow"] });
		assert.equal(settled.phase, "settled");
		assertHeld();
		store.release(admissionFence(settled));
		input.claims = store.list();
		const projection = projectPlan(plan, { admission: input });
		assert.deepEqual(projection.scheduling.occupiedTaskIds, []);
		assert.deepEqual(projection.scheduling.dispatchableTaskIds, ["T-002"]);
		assert.ok(projection.actions.some(action => action.kind === "reserve-task" && action.taskId === "T-002"));
	} finally { fixture.dispose(); }
});

test("PF-ADM-05 retained file scopes require the exact repository, owner, plan and task", () => {
	const fixture = createParallelFixture({ name: "retained-scope-identity" });
	try {
		const first = task("T-001"), second = { ...task("T-002", ["T-001"]), expectedFiles: [...first.expectedFiles] };
		const plan = completeTask(bind(approved({ tasks: [first, second] })), first.id).plan;
		const input = context(plan);
		const identity = { repositoryId: REPO, owner: OWNER, planId: plan.id, taskId: first.id, reservationId: "foreign-reservation" };
		for (const changed of [{ repositoryId: "c".repeat(64) }, { owner: "/other/owner" }, { planId: "other-plan" }, { taskId: "T-099" }]) {
			const foreign = { ...identity, ...changed };
			const store = createAdmissionStore({ workspacePath: fixture.workspacePath, repositoryId: foreign.repositoryId, owner: foreign.owner });
			const claim = store.claim({ identity: foreign, expectedRevision: 0, resources: [], team: null });
			input.claims.push(claim);
		}
		const projection = projectAdmission(plan, input);
		assert.deepEqual(projection.occupiedTaskIds, []);
		assert.deepEqual(projection.dispatchableTaskIds, ["T-002"]);
	} finally { fixture.dispose(); }
});

test("PF-ADM-05 candidate-only selection skips speculation but retains actual occupancy and all readiness checks", () => {
	const fixture = createParallelFixture({ name: "candidate-only-readiness" });
	try {
		const first = task("T-001"), second = { ...task("T-002"), expectedFiles: [...first.expectedFiles] };
		const plan = bind(approved({ tasks: [second, first, task("T-003", ["T-001"])] }));
		const input = context(plan);
		input.tasks["T-001"].resources = [exclusive("/shared-output")];
		input.tasks["T-002"].resources = [exclusive("/shared-output")];
		const options = { candidateTaskIds: ["T-002"] };
		assert.deepEqual(projectAdmission(plan, input).dispatchableTaskIds, ["T-001"]);
		assert.deepEqual(projectAdmission(plan, input, options).dispatchableTaskIds, ["T-002"]);
		assert.deepEqual(projectAdmission(plan, input, { candidateTaskIds: [] }).dispatchableTaskIds, []);
		assert.deepEqual(projectAdmission(plan, input, { candidateTaskIds: ["T-002", "T-001", "T-002"] }).dispatchableTaskIds, ["T-001"]);
		assert.ok(projectAdmission(plan, input, { candidateTaskIds: ["T-003"] }).holds[0].reasons.some(reason => reason.kind === "dependency"));
		assert.ok(projectAdmission(plan, { ...input, authorized: false }, options).holds[0].reasons.some(reason => reason.kind === "authority"));
		const running = reserveTaskAttempt(plan, first.id, { reservationId: "running-scope" });
		assert.ok(projectAdmission(running, input, options).holds[0].reasons.some(reason => reason.kind === "scope"));
		input.tasks["T-002"].dependencies = [{ ...external(), observation: null }];
		assert.ok(projectAdmission(plan, input, options).holds[0].reasons.some(reason => reason.kind === "observation-completeness"));
		input.tasks["T-002"].dependencies = [];
		const store = createAdmissionStore({ workspacePath: fixture.workspacePath, repositoryId: REPO, owner: OWNER });
		const identity = { repositoryId: REPO, owner: OWNER, planId: plan.id, taskId: second.id, reservationId: "resume-exact-claim" };
		const held = store.claim({ identity, expectedRevision: 0, resources: input.tasks["T-002"].resources, team: null });
		input.claims = store.list();
		const retained = projectAdmission(plan, input, options);
		assert.deepEqual(retained.dispatchableTaskIds, []);
		assert.ok(retained.holds[0].reasons.some(reason => reason.code === "reservation-reconciliation-required"));
		assert.deepEqual(projectAdmission(plan, input, { candidateTaskIds: ["T-001"] }).dispatchableTaskIds, []);
		assert.deepEqual(store.read(identity), held);
		const verifiedResume = { ...input, claims: input.claims.filter(record => record.identity.reservationId !== identity.reservationId) };
		assert.deepEqual(projectAdmission(plan, verifiedResume, options).dispatchableTaskIds, ["T-002"]);
		assert.deepEqual(projectAdmission(plan, verifiedResume).dispatchableTaskIds, ["T-001"]);
		const foreignStore = createAdmissionStore({ workspacePath: fixture.workspacePath, repositoryId: REPO, owner: "/other/owner" });
		const foreign = foreignStore.claim({
			identity: { ...identity, owner: "/other/owner", reservationId: "foreign-team" }, expectedRevision: 0,
			resources: [], team: { id: "team", capacity: 1, units: 1 },
		});
		const teamInput = structuredClone(verifiedResume);
		teamInput.claims = [foreign];
		teamInput.tasks["T-002"].team = foreign.team;
		const teamHolds = projectAdmission(plan, teamInput, options).holds[0].reasons;
		assert.ok(teamHolds.some(reason => reason.kind === "team"));
		assert.ok(!teamHolds.some(reason => reason.kind === "scope"));
	} finally { fixture.dispose(); }
});

for (const size of [32, 128]) {
	test(`PF-ADM-06 deterministic ${size} logical packages execute production selection and claims in bounded batches`, () => {
		const fixture = createParallelFixture({ name: `logical-${size}` });
		try {
			const store = createAdmissionStore({ workspacePath: fixture.workspacePath, repositoryId: REPO, owner: OWNER });
			/** @type {string[]} */
			const sequence = [];
			let peak = 0;
			// Four lanes, eight packages per bounded valid plan. No executable-plan cap changes.
			for (let batch = 0; batch < size / 8; batch += 1) {
				let plan = bind(approved({ id: `batch-${batch}`, tasks: Array.from({ length: 8 }, (_, index) =>
					task(`T-${String(index + 1).padStart(3, "0")}`, index < 4 ? [] : [`T-${String(index - 3).padStart(3, "0")}`])) }));
				const input = context(plan);
				for (const [id, policy] of Object.entries(input.tasks)) {
					policy.resources = [exclusive(`/batch-${batch}/lane-${(Number(id.slice(2)) - 1) % 4}`, "worktree-build")];
					policy.team = { id: "explicit-four-lanes", capacity: 4, units: 1 };
				}
				let done = 0;
				while (done < 8) {
					input.claims = store.list();
					const selected = projectAdmission(plan, input).dispatchableTaskIds.filter(id => Number(id.slice(2)) <= 8);
					assert.ok(selected.length > 0, "safe release makes progress");
					assert.ok(selected.length <= 4, "explicit team capacity is bounded");
					const active = selected.map(id => {
						const identity = { repositoryId: REPO, owner: OWNER, planId: plan.id, taskId: id, reservationId: `${plan.id}-${id}` };
						const policy = input.tasks[id];
						return store.claim({ identity, expectedRevision: 0, resources: policy.resources, team: policy.team });
					});
					peak = Math.max(peak, store.list().filter(record => record.phase !== "released").length);
					assertExclusiveClaims(store.list());
					assert.equal(projectAdmission(plan, { ...input, claims: store.list() }).dispatchableTaskIds.length, 0);
					for (const claimed of active) {
						const id = claimed.identity.taskId;
						assert.ok(plan.tasks.find(task => task.id === id)?.dependsOn.every(parent => sequence.includes(`${batch}/${parent}`)));
						const completed = completeTask(plan, id);
						plan = completed.plan;
						const bound = store.bindReservation(admissionFence(claimed), { ...claimed.identity, attemptId: completed.attemptId });
						assert.ok(bound.attempt);
						const settled = store.deliver(admissionFence(bound), {
							attempt: bound.attempt, sessionId: `session-${completed.attemptId}`, commit: "a".repeat(40),
							planRevision: plan.revision, source: "bounded plan successful delivery", terminalRunIds: [],
						});
						store.release(admissionFence(settled));
						sequence.push(`${batch}/${id}`);
						done++;
					}
				}
			}
			assert.equal(sequence.length, size);
			assert.equal(new Set(sequence).size, size);
			assert.equal(peak, 4);
			assert.equal(store.list().filter(record => record.phase !== "released").length, 0);
			console.log(JSON.stringify({ dataset: "four-lanes-eight-package-batches-v1", packages: size, peakClaims: peak, completed: sequence.length, sequence }));
		} finally { fixture.dispose(); }
	});
}
