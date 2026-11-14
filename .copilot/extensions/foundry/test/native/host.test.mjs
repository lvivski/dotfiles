import assert from "node:assert/strict";
import test from "node:test";
import { readRecord, readString } from "../../data.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { createNativeAdmission, createOfferedDispatchTransport, DispatchNativeError } from "../../native/admission.mjs";
import { createNativeDispatch, createdChild, dispatchReservation } from "../../native/dispatch.mjs";
import { createNativeHost, createRpcWorkflowRoute, decodeSessionDetail } from "../../native/host.mjs";
import { approved, claimedEvidence } from "../plan/fixture.mjs";
import { attachTaskAttempt, completeTaskAttempt, reserveTaskAttempt } from "../../plan/execution.mjs";
import { assertOfferedToolArguments } from "../parallel/native-contracts.mjs";

/** @typedef {import("../../native/host.mjs").NativeHostAccess} Access */
/** @typedef {import("../../native/observations.mjs").Context} Context */
const names = /** @type {const} */ (["foundry_get_status", "foundry_reserve_task", "foundry_attach_task", "foundry_complete_task",
	"create_session", "get_session", "list_sessions_and_chats", "send_session_message", "run_dynamic_workflow"]);

/** Recording ports exercise production adapters, not live App capability or permission.
 * @param {Partial<Access>} [overrides] */
function fixture(overrides = {}) {
	/** @type {Context} */
	const current = { workspacePath: "/fixture/owner", sessionId: "owner", projectId: "project", repositoryId: "a".repeat(64), inWorkflow: false };
	const plan = approved({ id: "host-fixture" });
	plan.factory = { repositoryId: current.repositoryId, owner: current.workspacePath, unitId: "unit", unitRevision: 1,
		candidateId: null, contractRevision: null, contractDigest: null, contextDigest: null, blueprintDigest: "b".repeat(64) };
	const attempt = { repositoryId: current.repositoryId, owner: current.workspacePath, planId: plan.id,
		taskId: "T-001", reservationId: "reserved-host", attemptId: "T-001-A001" };
	const child = { sessionId: "child", projectId: current.projectId, creatorSessionId: current.sessionId, branch: "isolated", worktreePath: "/fixture/child" };
	const reservation = dispatchReservation({ attempt, projectId: current.projectId, baseBranch: "base", baseCommit: "c".repeat(40),
		initialization: { acknowledgement: `Foundry setup ready: ${plan.id}/T-001/T-001-A001`, kickoff: { mode: "interactive", prompt: "Setup only.  \n" } },
		delegationPrompt: "Unchanged complete task  \n", inputs: null, requiredInputs: [] });
	/** @type {{name: string, args: unknown, correlation: string}[]} */
	const calls = [];
	/** @type {unknown} */
	let response = { resultType: "success", textResultForLlm: "{}" };
	/** @type {(() => void) | null} */
	let during = null;
	/** @param {string} name @param {unknown} args @param {string} correlation */
	async function record(name, args, correlation) {
		assertOfferedToolArguments(name, args);
		calls.push({ name, args: structuredClone(args), correlation });
		during?.();
		if (response instanceof Error) throw response;
		return structuredClone(response);
	}
	/** @type {Access["primary"]} */
	const primary = {
		foundry_get_status: (args, id) => record("foundry_get_status", args, id),
		foundry_reserve_task: (args, id) => record("foundry_reserve_task", args, id),
		foundry_attach_task: (args, id) => record("foundry_attach_task", args, id),
		foundry_complete_task: (args, id) => record("foundry_complete_task", args, id),
		create_session: (args, id) => record("create_session", args, id),
		get_session: (args, id) => record("get_session", args, id),
		list_sessions_and_chats: (args, id) => record("list_sessions_and_chats", args, id),
		send_session_message: (args, id) => record("send_session_message", args, id),
		run_dynamic_workflow: (args, id) => record("run_dynamic_workflow", args, id),
	};
	/** @type {Access} */
	const access = { current: () => current, route: "primary-app", primary, readPlan: () => plan, taskPolicies: () => ({}),
		decodeCreated: createdChild,
		decodeHandoff: value => ({ sessionId: readString(readRecord(value).sessionId), accepted: readRecord(value).accepted === true }),
		decodeRun: value => readString(readRecord(value).runId), ...overrides };
	const host = createNativeHost(access);
	const transport = createOfferedDispatchTransport({
		owner: current.workspacePath, sessionId: current.sessionId, executor: host.executor, offered: host.offered,
		availability: host.availability, context: () => ({ owner: current.workspacePath, sessionId: current.sessionId, inWorkflow: current.inWorkflow }),
	});
	const native = createNativeDispatch({ transport, ...host });
	return { current, plan, host, transport, native, access, reservation, child, calls,
		/** @param {unknown} value */ respond(value) { response = value; },
		/** @param {() => void} callback */ during(callback) { during = callback; } };
}
/** @param {unknown} value */
const success = value => ({ resultType: "success", textResultForLlm: JSON.stringify(value) });

test("host binds every supported primary operation without manufacturing a metadata-based RPC route", async () => {
	const f = fixture();
	assert.deepEqual([...f.host.offered], [...names]);
	f.respond(success({ plan: f.plan }));
	assert.equal((await createNativeAdmission({ transport: f.transport }).status(f.plan.id)).plan.id, f.plan.id);
	assert.equal(f.calls[0].name, "foundry_get_status");
	await f.transport.call("get_session", { project_session_id: f.child.sessionId });
	await f.transport.call("list_sessions_and_chats", {});
	assert.deepEqual(f.calls.slice(1).map(call => call.name), ["get_session", "list_sessions_and_chats"]);
	const rpc = fixture({ route: "extension-rpc" });
	assert.equal(rpc.host.offered.size, 0, "Primary callbacks do not transfer support to RPC");
	for (const name of names) {
		await assert.rejects(rpc.host.executor.execute({ name, arguments: {}, toolCallId: "held" }), { code: "dispatch_capability_unavailable" });
	}
	assert.equal(rpc.calls.length, 0);
	const absent = fixture({ primary: {} });
	assert.equal(absent.host.availability("create_session"), "unavailable");
});

test("all owner/project/repository/workflow/subagent drift is rejected before native invocation", async () => {
	/** @type {Partial<Context>[]} */
	const changes = [{ workspacePath: "/foreign" }, { sessionId: "foreign" }, { projectId: "foreign" }, { repositoryId: "b".repeat(64) },
		{ inWorkflow: true }, { agentId: "runtime-worker" }];
	for (const change of changes) {
		const f = fixture();
		Object.assign(f.current, change);
		await assert.rejects(f.native.create(f.reservation), { code: "dispatch_invocation_owner" });
		assert.equal(f.calls.length, 0);
	}
	assert.throws(() => fixture({ current: () => null }), { code: "dispatch_identity_unavailable" });
	const f = fixture();
	f.plan.factory = null;
	await assert.rejects(createNativeAdmission({ transport: f.transport }).status(f.plan.id), { code: "dispatch_foreign_plan" });
	assert.equal(f.calls.length, 0);
});

test("asynchronous ownership drift retains uncertainty and prevents dependent native calls", async () => {
	const f = fixture();
	f.respond(success(f.child));
	f.during(() => { f.current.projectId = "changed"; });
	await assert.rejects(f.native.create(f.reservation), error => {
		assert.ok(error instanceof DispatchNativeError);
		assert.equal(error.code, "dispatch_invocation_owner");
		assert.equal(error.disposition, "uncertain");
		assert.deepEqual(readRecord(error.receipt).raw, success(f.child));
		return true;
	});
	assert.deepEqual(f.calls.map(call => call.name), ["create_session"]);
});

test("canonical native errors keep their class identity and rejected/uncertain/malformed results never replay", async () => {
	const original = new DispatchNativeError("dispatch_capability_unavailable", "Unavailable before invocation", "not-started", { source: "provider" });
	const cases = [original, new Error("lost result"), { resultType: "denied", textResultForLlm: "denied" },
		{ resultType: "failure", textResultForLlm: "This session management tool is disabled" }, { id: "successful-looking" }];
	for (const value of cases) {
		const f = fixture(); f.respond(value);
		await assert.rejects(f.native.create(f.reservation), error => {
			assert.ok(error instanceof DispatchNativeError);
			if (value === original) assert.equal(error, original);
			assert.equal(f.native.classifyError(error), error);
			return true;
		});
		assert.deepEqual(f.calls.map(call => call.name), ["create_session"]);
	}
});

test("setup-only creation and complete delegation retain exact payloads without permission overrides", async () => {
	const f = fixture();
	f.respond(success(f.child));
	const creation = await f.native.create(f.reservation, "creation");
	assert.deepEqual(f.native.decodeCreated(creation.value, f.reservation), f.child);
	assert.deepEqual(f.calls[0].args, f.native.createArguments(f.reservation));
	f.respond(success({ sessionId: f.child.sessionId, accepted: true }));
	const handoff = await f.native.handoff(f.reservation, f.child, "handoff");
	assert.equal(f.native.decodeHandoff(handoff.value, f.child.sessionId), f.child.sessionId);
	assert.equal(readRecord(f.calls[1].args).message, f.reservation.delegationPrompt);
	assert.deepEqual(Object.keys(readRecord(f.calls[1].args)), ["session_id", "message", "coordinator_only", "delivery_mode", "mode"]);
	await assert.rejects(f.host.executor.execute({ name: "send_session_message",
		arguments: { ...readRecord(f.calls[1].args), message: "x", coordinator_only: false }, toolCallId: "forbidden" }));
	assert.equal(f.calls.length, 2);
	console.log("host request trace:", JSON.stringify(f.calls));
});

test("public get_session decoder requires both creator identities and does not invent create-result metadata", () => {
	const f = fixture();
	const detail = { id: f.child.sessionId, project_id: f.current.projectId, creator_session_id: f.current.sessionId,
		coordinating_creator_session_id: f.current.sessionId, session_type: "worktree", path: f.child.worktreePath, branch: f.child.branch };
	assert.deepEqual(decodeSessionDetail(detail, f.current), f.child);
	for (const change of [{ coordinating_creator_session_id: "foreign" }, { creator_session_id: "foreign" }, { project_id: "foreign" },
		{ session_type: "branch" }, { path: "relative" }, { id: "" }]) {
		assert.throws(() => decodeSessionDetail({ ...detail, ...change }, f.current));
	}
	assert.throws(() => decodeSessionDetail("Created session 'child' (id: child)", f.current));
	assert.throws(() => f.native.preflight(), { code: "dispatch_observation_unavailable" });
	assert.equal(f.calls.length, 0);
});

test("prepared workflow forwarding preserves nested arguments, limits and their absence on either explicit route", async () => {
	for (const route of ["primary-app", "extension-rpc"]) for (const limits of [undefined, { maxTotalSubagents: 3, maxConcurrentSubagents: 2, timeoutSeconds: 240, maxAiCredits: 1.5 }]) {
		/** @type {unknown[]} */
		const rpcCalls = [];
		const f = fixture(route === "extension-rpc" ? { route, workflow: async (args, correlation) => {
			rpcCalls.push({ args: structuredClone(args), correlation }); return success({ runId: "native-run" });
		} } : {});
		f.respond(success({ runId: "native-run" }));
		const launch = { name: "exact-prepared", args: { input: { complete: ["full", "payload"], whitespace: "  \n" } },
			...(limits ? { limits } : {}) };
		const digest = analysisInputDigest(launch), result = await f.native.launch(launch, "workflow");
		assert.equal(f.native.decodeRun(result.value), "native-run");
		assert.equal(analysisInputDigest(launch), digest);
		const observed = route === "extension-rpc" ? readRecord(rpcCalls[0]).args : f.calls[0].args;
		assert.deepEqual(observed, launch);
		assert.equal(Object.hasOwn(readRecord(observed), "limits"), limits !== undefined);
		assert.equal(f.calls.length + rpcCalls.length, 1);
	}
});

test("policy snapshots use the existing authority and reject stale/foreign plans", () => {
	const f = fixture();
	assert.deepEqual(f.host.taskPolicies(f.plan), {});
	assert.throws(() => f.host.taskPolicies({ ...f.plan, revision: f.plan.revision + 1 }), { code: "dispatch_context_stale" });
	assert.throws(() => f.host.taskPolicies({ ...f.plan, factory: null }), { code: "dispatch_foreign_plan" });
	assert.equal(f.calls.length, 0);
});

test("all four admission routes retain exact request fields and canonical current attempt postconditions", async () => {
	const f = fixture(), admission = createNativeAdmission({ transport: f.transport });
	const { attemptId, ...identity } = f.reservation.attempt;
	const reserved = reserveTaskAttempt(f.plan, identity.taskId, { reservationId: identity.reservationId });
	f.respond(success({ plan: reserved, taskId: identity.taskId, attemptId, baseBranch: reserved.tasks[0].attempts[0].baseBranch }));
	await admission.reserve(identity, f.plan.revision);
	Object.assign(f.plan, reserved);
	const attached = attachTaskAttempt(f.plan, identity.taskId, attemptId, { sessionId: f.child.sessionId, branch: f.child.branch });
	f.respond(success(attached));
	await admission.attach(f.reservation.attempt, reserved.revision, { ...f.child, baseCommit: f.reservation.baseCommit });
	Object.assign(f.plan, attached);
	const completed = completeTaskAttempt(f.plan, identity.taskId, attemptId, "done", { commit: f.reservation.baseCommit,
		branch: f.child.branch, resultSummary: "recording scoped completion", evidence: claimedEvidence() });
	f.respond(success(completed));
	const request = { planId: identity.planId, taskId: identity.taskId, attemptId, expectedRevision: attached.revision,
		status: "done", commit: f.reservation.baseCommit, branch: f.child.branch, resultSummary: "recording scoped completion", evidence: claimedEvidence() };
	await admission.complete(request);
	assert.deepEqual(f.calls[2].args, request, "Absent optional wire fields must remain absent");
	f.respond(success({ plan: completed }));
	await admission.status(identity.planId);
	assert.deepEqual(f.calls.map(call => call.name), ["foundry_reserve_task", "foundry_attach_task", "foundry_complete_task", "foundry_get_status"]);
	await assert.rejects(admission.complete({ ...request, attemptId: "T-001-A999" }), { code: "dispatch_attempt_mismatch" });
	await assert.rejects(f.host.executor.execute({ name: "foundry_get_status", arguments: { planId: identity.planId, owner: "forged" }, toolCallId: "forged" }));
	assert.equal(f.calls.length, 4);
});

test("the public SDK workflow adapter invokes only tools.execute with the unchanged complete launch", async () => {
	/** @type {unknown[]} */
	const calls = [];
	const route = createRpcWorkflowRoute({ rpc: { tools: { async execute(input) {
		calls.push(structuredClone(input)); return success({ runId: "native-run" });
	} } } });
	const launch = { name: "prepared", args: { full: ["payload"], nested: { true: true } } };
	await route(launch, "durable-effect-id");
	assert.deepEqual(calls, [{ name: "run_dynamic_workflow", arguments: launch, toolCallId: "durable-effect-id" }]);
	assert.throws(() => createRpcWorkflowRoute({ rpc: {} }), { code: "dispatch_capability_unavailable" });
});
