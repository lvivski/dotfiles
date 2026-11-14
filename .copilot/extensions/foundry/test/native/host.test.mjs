import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseJson, readJsonValue, readRecord, readString } from "../../data.mjs";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { createNativeAdmission, createOfferedDispatchTransport, DispatchNativeError } from "../../native/admission.mjs";
import { createNativeDispatch, createdChild, dispatchReservation } from "../../native/dispatch.mjs";
import { createNativeHost, createRpcWorkflowRoute, decodeSessionDetail } from "../../native/host.mjs";
import { approved, claimedEvidence } from "../plan/fixture.mjs";
import { attachTaskAttempt, completeTaskAttempt, reserveTaskAttempt } from "../../plan/execution.mjs";
import { buildDelegationPrompt, buildTaskInitialization } from "../../plan/prompt.mjs";
import { assignmentDigest, sealTaskStartup, startupInitialization } from "../../plan/startup.mjs";
import { fixtureRoot } from "../git.mjs";
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
/** @param {unknown} value
 * @returns {{resultType: "success", textResultForLlm: string}} */
const success = value => ({ resultType: "success", textResultForLlm: JSON.stringify(value) });

/** @param {boolean} [large] */
function completeKickoffFixture(large = false) {
	const f = fixture(), producer = f.reservation.attempt, commit = "d".repeat(40);
	let plan = reserveTaskAttempt(f.plan, producer.taskId, { reservationId: producer.reservationId });
	plan = attachTaskAttempt(plan, producer.taskId, producer.attemptId, { sessionId: "predecessor", branch: "work/predecessor" });
	plan = completeTaskAttempt(plan, producer.taskId, producer.attemptId, "done", {
		commit, branch: "work/predecessor", resultSummary: "Delivered immutable contract and support helper", evidence: claimedEvidence(),
	});
	plan = reserveTaskAttempt(plan, "T-002", { reservationId: "complete-kickoff" });
	Object.assign(f.plan, plan);
	const task = f.plan.tasks[1], reserved = task.attempts[0];
	assert.ok(reserved);
	const attempt = { ...producer, taskId: task.id, attemptId: reserved.id, reservationId: reserved.reservationId };
	const requiredInputs = [
		{ producer: "contract", output: "schema", destination: "inputs/request.json" },
		{ producer: "contract", output: "helper", destination: "inputs/support.mjs" },
	];
	const outputs = requiredInputs.map((input, index) => ({
		id: input.output, artifact: { repositoryId: attempt.repositoryId, commit, path: `contract/${input.output}.${index ? "mjs" : "json"}`,
			mode: "100644", digest: (index ? "e" : "f").repeat(64) },
	}));
	const inputBody = {
		format: "foundry-reserved-inputs-v1", consumer: attempt,
		bootstrap: { repositoryId: attempt.repositoryId, branch: reserved.baseBranch, commit },
		deliveries: [{ packageId: "contract", attempt: producer, commit, outputs }],
		inputs: requiredInputs.map((input, index) => ({ ...input, artifact: outputs[index].artifact })),
	};
	const inputs = { ...inputBody, digest: analysisInputDigest(inputBody) };
	const details = Array.from({ length: large ? 160 : 1 }, (_, index) =>
		`Scenario ${index + 1}: preserve request identity while implementing the selected package boundary in src/t-002.mjs.\r\n`
		+ "\tExercise reservation, receipt, attachment, cancellation and retry separately; a producer status label never proves consumer authority.  \r\n"
		+ "\tKeep caller-owned input immutable, preserve literal argv and pinned helper paths, and report missing permissions without bypassing them.  \r\n"
		+ "\tUse inputs/request.json with inputs/support.mjs at their recorded producer commit; independently test both valid and malformed records.  \r\n"
		+ "\tReport exact evidence and delivered commit; source forwarding alone is not App installation or native execution. café / cafe\u0301 / Україна / 🧭  \r\n",
	).join("\r\n");
	const context = {
		bindings: f.plan.factory, authority: "accepted-contract", contract: { revision: 1, digest: "b".repeat(64) },
		unit: { id: "unit", revision: 1, owns: ["selection"], exposes: ["select(input)"], preserves: ["input identity"] },
		requirements: Array.from({ length: large ? 64 : 1 }, (_, index) => ({
			id: `preservation-${index + 1}`, revision: 1,
			statement: "Preserve complete caller-owned input and immutable predecessor bindings, including Unicode, CRLF, tabs and trailing whitespace.  \r\n",
			evaluation: { id: `boundary-${index + 1}`, revision: 1, independent: true,
				procedureDigest: "a".repeat(64), report: "Exercise the literal accepted request and compare the final delivered output, not a status-only acknowledgement." },
		})),
	};
	const body = `${buildDelegationPrompt(f.plan, task, reserved)}\r\nDetailed task delegation:\r\n${details}`
		+ `\r\n<UNTRUSTED-FACTORY-CONTEXT>\r\n${stableStringify(context)}\r\n</UNTRUSTED-FACTORY-CONTEXT>\r\n`
		+ `<UNTRUSTED-RESERVED-INPUTS>\r\n${stableStringify(inputs)}\r\n</UNTRUSTED-RESERVED-INPUTS>\r\n`
		+ "End of complete assignment — завершення / 終了 / 🧭\t  \r\n";
	const startup = sealTaskStartup(attempt, body);
	reserved.startup = startup;
	const initialization = buildTaskInitialization(f.plan, task, reserved);
	assert.ok(initialization);
	const reservation = dispatchReservation({ ...f.reservation, attempt, baseBranch: reserved.baseBranch, baseCommit: commit,
		initialization, delegationPrompt: startup.delegationPrompt, inputs, requiredInputs });
	return { ...f, reservation, startup, body };
}

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

test("FK-04 complete >=80000-byte assignment survives sealing, JSON persistence and native host kickoff unchanged", async (t) => {
	const f = completeKickoffFixture(true), prompt = f.startup.delegationPrompt;
	const expectedBytes = Buffer.from(prompt, "utf8");
	const digest = createHash("sha256").update(expectedBytes).digest("hex");
	assert.ok(Buffer.byteLength(f.body, "utf8") >= 80_000);
	assert.ok(prompt.length > 16_000, "The new recipe must not retain the legacy setup-prompt cap");
	assert.deepEqual(Buffer.from(prompt.slice(-f.body.length), "utf8"), Buffer.from(f.body, "utf8"));
	assert.equal(f.startup.assignmentDigest, digest);
	assert.equal(assignmentDigest(prompt), digest);
	assert.ok(prompt.includes(stableStringify(f.reservation.inputs)), "The complete explicit reserved-input descriptor must be sealed before hashing");
	assert.ok(prompt.indexOf("<UNTRUSTED-FACTORY-CONTEXT>") < prompt.indexOf("<UNTRUSTED-RESERVED-INPUTS>"));
	assert.ok(prompt.endsWith("End of complete assignment — завершення / 終了 / 🧭\t  \r\n"));

	const root = await fixtureRoot(t, "complete-kickoff"), filename = path.join(root, "reservation.json");
	await writeFile(filename, JSON.stringify(f.reservation), "utf8");
	const persisted = dispatchReservation(parseJson(await readFile(filename, "utf8")));
	assert.deepEqual(persisted, f.reservation);
	for (const text of [persisted.delegationPrompt, persisted.initialization.kickoff.prompt]) {
		assert.deepEqual(Buffer.from(text, "utf8"), expectedBytes);
		assert.equal(createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"), digest);
	}
	assert.equal(persisted.initialization.assignmentDigest, digest);
	f.respond(success(f.child));
	const creation = await f.native.create(persisted, "fk-04-complete-kickoff");
	assert.deepEqual(f.native.decodeCreated(creation.value, persisted), f.child);
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0].name, "create_session");
	assert.equal(f.calls[0].correlation, "fk-04-complete-kickoff");
	const captured = readRecord(f.calls[0].args), kickoff = readRecord(captured.kickoff);
	assert.deepEqual(captured, {
		project_id: persisted.projectId, base_branch: persisted.baseBranch,
		workspace_type: "worktree", coordinate_with_creator: true, notify_on_idle: "always",
		kickoff: { mode: "interactive", prompt },
	});
	assert.deepEqual(Object.keys(kickoff), ["mode", "prompt"]);
	assert.deepEqual(Buffer.from(readString(kickoff.prompt), "utf8"), expectedBytes);
	assert.equal(createHash("sha256").update(Buffer.from(readString(kickoff.prompt), "utf8")).digest("hex"), digest);
	for (const field of ["model", "limits", "agent", "schedule", "source_user_message", "coordinator_instructions", "attachments",
		"reasoning_effort", "context_tier", "auto_tier", "execution_location", "base_branch"]) {
		assert.equal(Object.hasOwn(kickoff, field), false, `No optional kickoff field ${field}`);
		if (field !== "base_branch") assert.equal(Object.hasOwn(captured, field), false, `No optional creation field ${field}`);
	}
	console.log("FK-04 source-forwarding fixture only:", JSON.stringify({
		bodyBytes: Buffer.byteLength(f.body, "utf8"), kickoffBytes: expectedBytes.length, assignmentDigest: digest,
		seal: "exact UTF-8", persistedReservation: "JSON file decoded", nativeCreateSession: "recording primary route; not live App execution or installation",
	}));
});

test("fresh dispatch rejects altered or contradictory initialization and foreign receipt gates", async (t) => {
	const f = completeKickoffFixture(), value = f.reservation, initialization = value.initialization;
	/** @type {[string, unknown][]} */
	const changes = [
		["appended kickoff body", { ...initialization, kickoff: { ...initialization.kickoff, prompt: `${value.delegationPrompt}Appended context` } }],
		["omitted kickoff body", { ...initialization, kickoff: { ...initialization.kickoff, prompt: value.delegationPrompt.slice(0, -1) } }],
		["altered acknowledgement", { ...initialization, acknowledgement: "Foundry setup ready: host-fixture/T-002/T-002-A001" }],
		["unknown recipe", { ...initialization, recipe: "complete-kickoff-v999" }],
		["contradictory legacy recipe", { ...initialization, recipe: "setup-only" }],
		["null recipe", { ...initialization, recipe: null }],
		["changed digest", { ...initialization, assignmentDigest: "0".repeat(64) }],
		["malformed digest", { ...initialization, assignmentDigest: 1 }],
		["noninteractive mode", { ...initialization, kickoff: { ...initialization.kickoff, mode: "autopilot" } }],
		["added authority", { ...initialization, coordinator_only: true }],
	];
	for (const key of ["recipe", "assignmentDigest", "acknowledgement", "kickoff"]) {
		const omitted = structuredClone(initialization);
		Reflect.deleteProperty(omitted, key);
		changes.push([`omitted ${key}`, omitted]);
	}
	for (const [label, changed] of changes) await t.test(label, () =>
		assert.throws(() => dispatchReservation({ ...value, initialization: changed })));
	for (const delegationPrompt of [`${value.delegationPrompt}Appended input`, value.delegationPrompt.trimEnd()]) {
		assert.throws(() => dispatchReservation({ ...value, delegationPrompt }), { code: "dispatch_startup_invalid" });
	}
	for (const foreign of [
		{ ...value.attempt, planId: "foreign-plan" },
		{ ...value.attempt, taskId: "T-003", attemptId: "T-003-A001" },
		{ ...value.attempt, attemptId: "T-002-A002" },
	]) {
		const substituted = sealTaskStartup(foreign, f.body);
		assert.throws(() => dispatchReservation({ ...value, delegationPrompt: substituted.delegationPrompt,
			initialization: startupInitialization(foreign, substituted) }), { code: "dispatch_startup_invalid" });
	}
	const changedInputs = structuredClone(value.inputs);
	assert.ok(changedInputs);
	changedInputs.inputs[0].destination = "inputs/substituted.json";
	assert.throws(() => dispatchReservation({ ...value, inputs: changedInputs }), { code: "parallel_input_digest" });
	const missingDescriptor = sealTaskStartup(value.attempt, f.body.replace(stableStringify(value.inputs), ""));
	assert.throws(() => dispatchReservation({ ...value, delegationPrompt: missingDescriptor.delegationPrompt,
		initialization: startupInitialization(value.attempt, missingDescriptor) }), { code: "dispatch_inputs_changed" });
	assert.equal(f.calls.length, 0);
});

test("native host rejects malformed/over-limit complete kickoff and extra authority before invocation", async (t) => {
	const f = completeKickoffFixture(), args = f.native.createArguments(f.reservation);
	/** @type {[string, unknown][]} */
	const invalid = [
		["missing kickoff", { ...args, kickoff: null }],
		["foreign project", { ...args, project_id: "foreign" }],
		["uncoordinated child", { ...args, coordinate_with_creator: false }],
		["shared checkout", { ...args, workspace_type: "branch" }],
		["permission override", { ...args, permission: true }],
		["model override", { ...args, model: "unrequested" }],
		["schedule override", { ...args, schedule: { interval: "daily" } }],
		["user authority substitution", { ...args, source_user_message: { id: "not-user-authority", revision: 1 } }],
		["noninteractive kickoff", { ...args, kickoff: { ...args.kickoff, mode: "autopilot" } }],
		["nested agent override", { ...args, kickoff: { ...args.kickoff, agent: "worker" } }],
		["nested limits override", { ...args, kickoff: { ...args.kickoff, limits: {} } }],
	];
	for (const prompt of [null, 1, {}, [], "", " \r\n\t ", "x".repeat(2_000_001)]) {
		invalid.push([`invalid prompt ${typeof prompt === "string" ? `length ${prompt.length}` : typeof prompt}`, {
			...args, kickoff: { mode: "interactive", prompt },
		}]);
	}
	for (const [label, value] of invalid) await t.test(label, async () => {
		await assert.rejects(f.host.executor.execute({ name: "create_session", arguments: readJsonValue(value), toolCallId: "invalid-kickoff" }));
		assert.equal(f.calls.length, 0);
	});
	const legacy = fixture().reservation;
	assert.throws(() => dispatchReservation({ ...legacy, initialization: { ...legacy.initialization,
		kickoff: { mode: "interactive", prompt: "x".repeat(16_001) } } }), { code: "factory_input_invalid" });
});

test("fresh handoff sends only a short identity/digest-bound activation after an explicit attached revision", async () => {
	const f = completeKickoffFixture(), reservation = f.reservation, attachedRevision = f.plan.revision + 1;
	for (const revision of [undefined, 0, -1, 1.5, Number.NaN]) {
		await assert.rejects(f.native.handoff(reservation, f.child, "missing-attachment", revision), { code: "factory_input_invalid" });
	}
	for (const changed of [{ ...f.child, projectId: "foreign" }, { ...f.child, creatorSessionId: "foreign" },
		{ ...f.child, sessionId: f.current.sessionId }]) {
		await assert.rejects(f.native.handoff(reservation, changed, "foreign-activation", attachedRevision), { code: "dispatch_child_mismatch" });
	}
	assert.equal(f.calls.length, 0);
	f.respond(success({ sessionId: f.child.sessionId, accepted: true }));
	const handoff = await f.native.handoff(reservation, f.child, "fresh-activation", attachedRevision);
	assert.equal(f.native.decodeHandoff(handoff.value, f.child.sessionId), f.child.sessionId);
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0].name, "send_session_message");
	assert.equal(f.calls[0].correlation, "fresh-activation");
	const args = readRecord(f.calls[0].args), message = readString(args.message);
	const prefix = "Foundry activate received assignment:\n";
	assert.ok(message.startsWith(prefix));
	assert.ok(message.length < 16_000);
	assert.equal(message.includes(f.body), false);
	assert.equal(message.includes(stableStringify(reservation.inputs)), false);
	assert.deepEqual(parseJson(message.slice(prefix.length)), {
		recipe: "complete-kickoff-v1", attempt: reservation.attempt, projectId: reservation.projectId, child: f.child,
		baseBranch: reservation.baseBranch, baseCommit: reservation.baseCommit,
		assignmentDigest: f.startup.assignmentDigest, attachedRevision,
	});
	assert.deepEqual(args, { session_id: f.child.sessionId, message, coordinator_only: true, delivery_mode: "immediate", mode: "autopilot" });
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
	/** @type {Parameters<typeof createRpcWorkflowRoute>[0]} */
	const session = { rpc: { tools: { async execute(input) {
		calls.push(structuredClone(input)); return success({ runId: "native-run" });
	} } } };
	const route = createRpcWorkflowRoute(session);
	const launch = { name: "prepared", args: { full: ["payload"], nested: { true: true } } };
	await route(launch, "durable-effect-id");
	assert.deepEqual(calls, [{ name: "run_dynamic_workflow", arguments: launch, toolCallId: "durable-effect-id" }]);
	Reflect.deleteProperty(session.rpc, "tools");
	assert.throws(() => createRpcWorkflowRoute(session), { code: "dispatch_capability_unavailable" });
});
