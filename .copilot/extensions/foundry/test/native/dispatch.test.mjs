import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseJson, readJsonValue, readRecord, readString } from "../../data.mjs";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { createNativeAdmission, createOfferedDispatchTransport, DispatchNativeError } from "../../native/admission.mjs";
import { createNativeDispatch, createdChild, dispatchReservation } from "../../native/dispatch.mjs";
import { attachTaskAttempt, completeTaskAttempt, reserveTaskAttempt } from "../../plan/execution.mjs";
import { approved, claimedEvidence } from "../plan/fixture.mjs";
import { assertOfferedToolArguments } from "../parallel/native-contracts.mjs";

/** @typedef {import("../../types/json.js").JsonValue} Json */
/** @typedef {import("../../types/parallel.js").OfferedToolExecutor} Executor */
/** @typedef {Parameters<Executor["execute"]>[0]} Call */
/** @typedef {{name: string, result: unknown} | {name: string, fault: Error}} Step */
/** @typedef {Parameters<typeof createOfferedDispatchTransport>[0]} TransportOptions */
/** @typedef {Omit<Parameters<typeof createNativeDispatch>[0], "transport">} DispatchPorts */
/** @typedef {ReturnType<typeof dispatchReservation>} Reservation */
/** @typedef {ReturnType<typeof createdChild>} Child */

const capabilities = readRecord(parseJson(readFileSync(new URL("../parallel/fixtures/native-capabilities.json", import.meta.url), "utf8")));
const rpcFailure = readRecord(parseJson(readFileSync(new URL("../parallel/fixtures/native-rpc-failure.json", import.meta.url), "utf8")));
const owner = readString(capabilities.invocationOwner);
const sessionId = "fixture-owning-coordinator";
const repositoryId = "a".repeat(64);
const baseCommit = "b".repeat(40);
const before = "2026-11-13T06:00:00.000Z";
const acknowledgedAt = "2026-11-13T06:00:01.000Z";
const capturedAt = "2026-11-13T06:00:02.000Z";
const offered = new Set([
	"foundry_get_status", "foundry_reserve_task", "foundry_attach_task", "foundry_complete_task",
	"create_session", "get_session", "list_sessions_and_chats", "send_session_message", "run_dynamic_workflow",
]);

/** @param {unknown} value @returns {Json} */
const success = (value) => ({ resultType: "success", textResultForLlm: JSON.stringify(value) });

/**
 * Request conformance uses captured offered schemas. Responses and route support are injected:
 * this executor never calls the App and is not live permission or successful RPC evidence.
 * @param {Step[]} steps
 * @param {Partial<Pick<TransportOptions, "offered" | "availability">>} [options]
 */
function recording(steps, options = {}) {
	/** @type {Call[]} */
	const calls = [];
	const context = { owner, sessionId, inWorkflow: false };
	/** @type {Executor} */
	const executor = {
		async execute(call) {
			calls.push(structuredClone(call));
			assertOfferedToolArguments(call.name, call.arguments);
			assert.equal(typeof call.toolCallId, "string");
			assert.ok(call.toolCallId);
			const step = steps[calls.length - 1];
			assert.ok(step, `Unexpected native invocation: ${call.name}`);
			assert.equal(call.name, step.name);
			if ("fault" in step) throw step.fault;
			return structuredClone(step.result);
		},
	};
	const transport = createOfferedDispatchTransport({
		owner, sessionId, context: () => context, executor, offered,
		availability: () => "supported", ...options,
	});
	return {
		transport, calls, context,
		assertComplete() {
			assert.equal(calls.length, steps.length);
			assert.equal(new Set(calls.map(call => call.toolCallId)).size, calls.length);
		},
	};
}

/** @returns {Reservation} */
function reservation() {
	const attempt = { repositoryId, owner, planId: "native-dispatch", taskId: "T-001", reservationId: "native-reservation", attemptId: "T-001-A001" };
	const acknowledgement = `Foundry setup ready: ${attempt.planId}/${attempt.taskId}/${attempt.attemptId}`;
	return dispatchReservation({
		attempt, projectId: "fixture-project", baseBranch: "reserved/bootstrap-base", baseCommit,
		initialization: {
			acknowledgement,
			kickoff: { mode: "interactive", prompt: `Setup only. Do not start implementation.\nReply exactly: ${acknowledgement}` },
		},
		delegationPrompt: "Implement only the reserved package.\nKeep this delegation unchanged.  \n",
		inputs: null, requiredInputs: [],
	});
}

/** @returns {Child} */
const child = () => ({
	sessionId: "fixture-child", projectId: "fixture-project", creatorSessionId: sessionId,
	worktreePath: fileURLToPath(new URL("../../injected-worktree", import.meta.url)), branch: "work/generated-child",
});

/**
 * These decoders and observations are explicit host-composition test ports, NOT captured
 * App output schemas. In particular, idle notifications never supply setup confirmation.
 * @param {Step[]} [steps]
 * @param {DispatchPorts} [overrides]
 */
function dispatchFixture(steps = [], overrides = {}) {
	const recorded = recording(steps);
	const prepared = reservation(), created = child();
	const acknowledgement = {
		sessionId: created.sessionId, message: prepared.initialization.acknowledgement,
		at: acknowledgedAt, source: "injected exact child transcript",
	};
	const observation = {
		child: { ...created }, capturedAt, source: "injected canonical host observation",
		complete: true, aliases: [created.sessionId], baseBranch: prepared.baseBranch, baseCommit,
		head: baseCommit, clean: true,
	};
	/** @type {string[]} */
	const events = [];
	const native = createNativeDispatch({
		transport: recorded.transport,
		decodeCreated: value => readRecord(value).hostCreated,
		decodeHandoff: value => readRecord(value).hostAdmission,
		decodeRun: value => readRecord(value).hostRunId,
		async observeSetup(actualChild, actualReservation) {
			events.push("setup");
			assert.deepEqual(actualChild, created);
			assert.deepEqual(actualReservation, prepared);
			assert.equal(recorded.calls.length, 0, "Fresh reads must follow the actual acknowledgement");
			return acknowledgement;
		},
		async observeChild(input) {
			events.push("canonical");
			assert.deepEqual(input.child, created);
			assert.equal(input.after, acknowledgement.at);
			assert.deepEqual(recorded.calls.map(call => call.name), ["get_session", "list_sessions_and_chats"]);
			assert.deepEqual(input.detail.value, { hostDetail: "fresh-detail" });
			assert.deepEqual(input.inventory.value, { hostInventory: "complete-listing" });
			assert.ok(input.detail.source.includes("/get_session/"));
			assert.ok(input.inventory.source.includes("/list_sessions_and_chats/"));
			return observation;
		},
		...overrides,
	});
	return { ...recorded, native, prepared, created, acknowledgement, observation, events };
}

/** @returns {{name: string, result: Json}[]} */
const freshReads = () => [
	{ name: "get_session", result: success({ hostDetail: "fresh-detail" }) },
	{ name: "list_sessions_and_chats", result: success({ hostInventory: "complete-listing" }) },
];

test("offered SDK string and expanded envelopes retain raw receipts and unwrap successful values", async () => {
	for (const [raw, expected] of [
		[JSON.stringify({ plan: "string-result" }), { plan: "string-result" }],
		[JSON.stringify({ ok: true, value: { plan: "wrapped-string" } }), { plan: "wrapped-string" }],
		[success({ plan: "expanded-result" }), { plan: "expanded-result" }],
		[success({ ok: true, value: { plan: "wrapped-expanded" } }), { plan: "wrapped-expanded" }],
		["plain SDK string result", "plain SDK string result"],
		[{ resultType: "success", textResultForLlm: "plain text for host decoder" }, "plain text for host decoder"],
	]) {
		const fixture = recording([{ name: "foundry_get_status", result: raw }]);
		const result = await fixture.transport.call("foundry_get_status", { planId: "native-dispatch" });
		assert.deepEqual(result.value, expected);
		assert.deepEqual(result.raw, raw);
		assert.equal(result.source, `${sessionId}/foundry_get_status/${fixture.calls[0].toolCallId}`);
		fixture.assertComplete();
	}
});

test("permission rejection is definitive, while recorded disabled RPC and lost responses stay uncertain without fallback", async () => {
	/** @type {{step: Step, code: string, disposition: DispatchNativeError["disposition"]}[]} */
	const cases = [
		...["denied", "rejected"].map(resultType => ({
			step: { name: "create_session", result: { resultType, textResultForLlm: "Permission not granted" } },
			code: "dispatch_permission_rejected", disposition: /** @type {const} */ ("definitive-failure"),
		})),
		{ step: { name: "create_session", result: rpcFailure.result }, code: "dispatch_native_failure", disposition: "uncertain" },
		{ step: { name: "create_session", fault: new Error("response lost after invocation") }, code: "dispatch_transport_uncertain", disposition: "uncertain" },
		{ step: { name: "create_session", result: { sessionId: "not-an-SDK-envelope" } }, code: "dispatch_result_unsupported", disposition: "uncertain" },
		{ step: { name: "create_session", result: success({ ok: false, error: { code: "revision_conflict", message: "stale native revision" } }) },
			code: "revision_conflict", disposition: "uncertain" },
	];
	for (const { step, code, disposition } of cases) {
		const fixture = dispatchFixture([step]);
		await assert.rejects(fixture.native.create(fixture.prepared), error => {
			assert.ok(error instanceof DispatchNativeError);
			assert.equal(error.code, code);
			assert.equal(error.disposition, disposition);
			const receipt = readRecord(error.receipt);
			assert.equal(receipt.source, `${sessionId}/create_session/${fixture.calls[0].toolCallId}`);
			if ("result" in step) assert.deepEqual(receipt.raw, step.result);
			else assert.match(readString(receipt.error), /response lost after invocation/);
			return true;
		});
		fixture.assertComplete();
		assert.deepEqual(fixture.calls.map(call => call.name), ["create_session"]);
	}
});

test("each invocation rechecks the owning coordinator and forbids dispatch from a workflow", async () => {
	const fixture = dispatchFixture();
	for (const change of [{ owner: "foreign-owner" }, { sessionId: "foreign-session" }, { inWorkflow: true }]) {
		Object.assign(fixture.context, { owner, sessionId, inWorkflow: false }, change);
		assert.throws(() => fixture.native.preflight(), { code: "dispatch_invocation_owner", disposition: "not-started" });
		await assert.rejects(fixture.native.create(fixture.prepared), { code: "dispatch_invocation_owner", disposition: "not-started" });
		await assert.rejects(fixture.native.launch({ name: "prepared", args: null }), { code: "dispatch_invocation_owner", disposition: "not-started" });
	}
	assert.deepEqual(fixture.calls, []);
});

test("missing and unproven invocation routes hold preflight without an alternate executor", () => {
	const required = ["create_session", "get_session", "list_sessions_and_chats", "foundry_get_status", "foundry_attach_task", "send_session_message"];
	for (const name of required) {
		for (const availability of ["missing", "unavailable", "unproven"]) {
			const fixture = recording([], {
				offered: availability === "missing" ? new Set([...offered].filter(item => item !== name)) : offered,
				availability: tool => tool === name && availability !== "missing"
					? availability === "unavailable" ? "unavailable" : "unproven" : "supported",
			});
			const native = createNativeDispatch({ transport: fixture.transport });
			assert.throws(() => native.preflight(), { code: "dispatch_capability_unavailable", disposition: "not-started" });
			assert.deepEqual(fixture.calls, []);
		}
	}
});

test("missing host result or observation ports hold before creation", async () => {
	/** @type {(keyof DispatchPorts)[]} */
	const ports = ["decodeCreated", "decodeHandoff", "observeSetup", "observeChild"];
	for (const port of ports) {
		const fixture = dispatchFixture([], { [port]: undefined });
		assert.throws(() => fixture.native.preflight(), { code: "dispatch_observation_unavailable" });
		assert.deepEqual(fixture.calls, []);
	}
	const fixture = dispatchFixture([], { decodeRun: undefined });
	await assert.rejects(fixture.native.launch({ name: "prepared" }), { code: "dispatch_result_unsupported" });
	assert.deepEqual(fixture.calls, []);
});

test("create forwards the reserved base and setup-only kickoff without implementation or source-user grants", async () => {
	const fixture = dispatchFixture([{ name: "create_session", result: success({ hostCreated: child() }) }]);
	fixture.native.preflight();
	const beforeReservation = structuredClone(fixture.prepared);
	const result = await fixture.native.create(fixture.prepared);
	assert.deepEqual(fixture.calls[0].arguments, {
		project_id: fixture.prepared.projectId, base_branch: fixture.prepared.baseBranch,
		workspace_type: "worktree", coordinate_with_creator: true, notify_on_idle: "always",
		kickoff: fixture.prepared.initialization.kickoff,
	});
	assert.deepEqual(fixture.prepared, beforeReservation);
	assert.deepEqual(fixture.native.decodeCreated(result.value, fixture.prepared), fixture.created);
	fixture.assertComplete();
});

test("host creation decoder rejects foreign project, creator and noncanonical worktrees", () => {
	const fixture = dispatchFixture();
	for (const change of [{ projectId: "other-project" }, { creatorSessionId: "other-coordinator" }]) {
		assert.throws(() => fixture.native.decodeCreated({ hostCreated: { ...fixture.created, ...change } }, fixture.prepared), { code: "dispatch_child_mismatch" });
	}
	for (const worktreePath of ["relative/worktree", `${fixture.created.worktreePath}/../alias`]) {
		assert.throws(() => fixture.native.decodeCreated({ hostCreated: { ...fixture.created, worktreePath } }, fixture.prepared), { code: "dispatch_child_invalid" });
	}
});

test("exact setup acknowledgement precedes fresh canonical detail and complete inventory, allowing branch rename", async () => {
	const fixture = dispatchFixture(freshReads());
	fixture.observation.child.branch = "work/renamed-by-child";
	const result = await fixture.native.corroborate(fixture.created, fixture.prepared, before);
	assert.deepEqual(fixture.events, ["setup", "canonical"]);
	assert.deepEqual(fixture.calls.map(call => ({ name: call.name, arguments: call.arguments })), [
		{ name: "get_session", arguments: { project_session_id: fixture.created.sessionId } },
		{ name: "list_sessions_and_chats", arguments: {} },
	]);
	assert.equal(result.child.branch, "work/renamed-by-child");
	assert.equal(result.child.sessionId, fixture.created.sessionId);
	assert.equal(result.child.worktreePath, fixture.created.worktreePath);
	assert.deepEqual(result.acknowledgement, fixture.acknowledgement);
	assert.deepEqual(result.observation, fixture.observation);
	assert.deepEqual(result.detail, freshReads()[0].result);
	assert.deepEqual(result.inventory, freshReads()[1].result);
	fixture.assertComplete();
});

test("idle, inexact, foreign or stale setup acknowledgements cannot authorize fresh reads or attachment", async () => {
	for (const change of [
		{ message: "session.idle" },
		{ message: `${reservation().initialization.acknowledgement}\n` },
		{ sessionId: "other-child" },
		{ at: "2026-11-13T05:59:59.000Z" },
	]) {
		const fixture = dispatchFixture();
		Object.assign(fixture.acknowledgement, change);
		await assert.rejects(fixture.native.corroborate(fixture.created, fixture.prepared, before), { code: "dispatch_setup_unconfirmed" });
		assert.deepEqual(fixture.events, ["setup"]);
		assert.deepEqual(fixture.calls, []);
	}
});

test("ambiguous aliases, incomplete or stale inventory and substituted canonical identities hold attachment", async () => {
	/** @type {Partial<ReturnType<typeof dispatchFixture>["observation"]>[]} */
	const changes = [
		{ aliases: [] }, { aliases: [child().sessionId, "other-alias"] },
		{ aliases: [child().sessionId, child().sessionId] }, { aliases: ["other-child"] },
		{ complete: false }, { capturedAt: before },
		{ capturedAt: "2026-11-13T06:00:00.500Z" },
		...[{ sessionId: "other-child" }, { projectId: "other-project" }, { creatorSessionId: "other-coordinator" },
			{ worktreePath: `${child().worktreePath}/other-worktree` }].map(change => ({ child: { ...child(), ...change } })),
	];
	for (const change of changes) {
		const fixture = dispatchFixture(freshReads());
		Object.assign(fixture.observation, change);
		await assert.rejects(fixture.native.corroborate(fixture.created, fixture.prepared, before), { code: "dispatch_inventory_ambiguous" });
		fixture.assertComplete();
	}
	const equal = dispatchFixture(freshReads());
	equal.acknowledgement.at = before;
	equal.observation.capturedAt = before;
	await assert.rejects(equal.native.corroborate(equal.created, equal.prepared, before), { code: "dispatch_inventory_ambiguous" });
});

test("base branch, base commit, HEAD or dirty-worktree drift holds attachment after corroboration", async () => {
	for (const change of [
		{ baseBranch: "different-base" }, { baseCommit: "c".repeat(40) },
		{ head: "c".repeat(40) }, { clean: false },
	]) {
		const fixture = dispatchFixture(freshReads());
		Object.assign(fixture.observation, change);
		await assert.rejects(fixture.native.corroborate(fixture.created, fixture.prepared, before), { code: "dispatch_bootstrap_drift" });
		fixture.assertComplete();
	}
});

/** @param {Reservation} prepared @returns {import("../../types/parallel.js").ReservedInputs} */
function inputs(prepared) {
	const artifact = { repositoryId, commit: "c".repeat(40), path: "output/package.json", mode: /** @type {const} */ ("100644"), digest: "d".repeat(64) };
	const body = {
		format: /** @type {const} */ ("foundry-reserved-inputs-v1"),
		consumer: prepared.attempt, bootstrap: { repositoryId, branch: prepared.baseBranch, commit: baseCommit },
		deliveries: [{
			packageId: "producer", attempt: { ...prepared.attempt, taskId: "T-002", attemptId: "T-002-A001", reservationId: "producer-reservation" },
			commit: artifact.commit, outputs: [{ id: "package", artifact }],
		}],
		inputs: [{ producer: "producer", output: "package", destination: "inputs/package.json", artifact }],
	};
	return { ...body, digest: analysisInputDigest(body) };
}

test("handoff preserves the complete reserved descriptor and delegation byte-for-byte as coordinator-only admission", async () => {
	const fixture = dispatchFixture([{
		name: "send_session_message", result: success({ hostAdmission: { sessionId: child().sessionId, accepted: true } }),
	}]);
	const descriptor = inputs(fixture.prepared);
	const requiredInputs = descriptor.inputs.map(({ producer, output, destination }) => ({ producer, output, destination }));
	const delegationPrompt = `  Unchanged implementation handoff.\n${stableStringify(descriptor)}\n`;
	const prepared = dispatchReservation({ ...fixture.prepared, inputs: descriptor, requiredInputs, delegationPrompt });
	const result = await fixture.native.handoff(prepared, fixture.created);
	assert.deepEqual(fixture.calls[0].arguments, {
		session_id: fixture.created.sessionId, message: delegationPrompt,
		coordinator_only: true, delivery_mode: "immediate", mode: "autopilot",
	});
	assert.equal(fixture.native.decodeHandoff(result.value, fixture.created.sessionId), fixture.created.sessionId);
	for (const hostAdmission of [{ sessionId: "other-child", accepted: true }, { sessionId: fixture.created.sessionId, accepted: false }]) {
		assert.throws(() => fixture.native.decodeHandoff({ hostAdmission }, fixture.created.sessionId), { code: "dispatch_handoff_unconfirmed" });
	}
	assert.throws(() => dispatchReservation({ ...prepared, delegationPrompt: "descriptor omitted" }), { code: "dispatch_inputs_changed" });
	assert.throws(() => dispatchReservation({ ...prepared, baseBranch: "substituted-base" }), { code: "dispatch_inputs_changed" });
	assert.throws(() => dispatchReservation({ ...prepared, inputs: null }), { code: "dispatch_inputs_missing" });
	assert.throws(() => dispatchReservation({ ...prepared, requiredInputs: [] }), { code: "parallel_input_coverage" });
	fixture.assertComplete();
});

test("prepared setup acknowledgements and reservations cannot be reassigned to another attempt or owner", async () => {
	const fixture = dispatchFixture(), prepared = fixture.prepared;
	assert.throws(() => dispatchReservation({
		...prepared, initialization: { ...prepared.initialization, acknowledgement: "Foundry setup ready: another/T-001/T-001-A001" },
	}), { code: "dispatch_setup_invalid" });
	assert.throws(() => dispatchReservation({
		...prepared, initialization: { ...prepared.initialization, kickoff: { ...prepared.initialization.kickoff, mode: "autopilot" } },
	}), { code: "dispatch_setup_invalid" });
	const foreign = dispatchReservation({ ...prepared, attempt: { ...prepared.attempt, owner: "foreign-owner" } });
	await assert.rejects(fixture.native.create(foreign), { code: "dispatch_foreign_plan" });
	await assert.rejects(fixture.native.handoff(foreign, fixture.created), { code: "dispatch_foreign_plan" });
	await assert.rejects(fixture.native.corroborate(fixture.created, foreign, before), { code: "dispatch_foreign_plan" });
	assert.deepEqual(fixture.calls, []);
});

test("workflow launch forwards the exact prepared args and limits through the offered tool, not SDK workflow.run", async () => {
	const fixture = dispatchFixture([{ name: "run_dynamic_workflow", result: success({ hostRunId: "injected-native-run" }) }]);
	const launchSpec = {
		name: "prepared-package-verifier", args: { reservation: fixture.prepared.attempt, checks: ["scope", "delivery"] },
		limits: { maxConcurrentSubagents: 2, maxTotalSubagents: 3, timeoutSeconds: 240, maxAiCredits: 1.5 },
	};
	const snapshot = structuredClone(launchSpec);
	const result = await fixture.native.launch(launchSpec);
	assert.deepEqual(fixture.calls.map(call => ({ name: call.name, arguments: call.arguments })), [
		{ name: "run_dynamic_workflow", arguments: snapshot },
	]);
	assert.deepEqual(launchSpec, snapshot);
	assert.equal(fixture.native.decodeRun(result.value), "injected-native-run");
	assert.throws(() => fixture.native.decodeRun({ hostRunId: "" }));
	fixture.assertComplete();
});

test("missing, disabled and nested workflow routes never fall back or relaunch", async () => {
	const preparedWorkflows = readRecord(capabilities.preparedWorkflows);
	assert.deepEqual(preparedWorkflows.forbiddenFallbacks, ["session.workflow.run", "nested workflow"]);
	const missing = recording([], { offered: new Set([...offered].filter(name => name !== "run_dynamic_workflow")) });
	await assert.rejects(createNativeDispatch({ transport: missing.transport, decodeRun: value => value }).launch({ name: "prepared" }),
		{ code: "dispatch_capability_unavailable", disposition: "not-started" });
	assert.deepEqual(missing.calls, []);
	for (const availability of ["unavailable", "unproven"]) {
		const fixture = recording([], { availability: () => availability === "unavailable" ? "unavailable" : "unproven" });
		const native = createNativeDispatch({ transport: fixture.transport, decodeRun: value => value });
		await assert.rejects(native.launch({ name: "prepared" }), { code: "dispatch_capability_unavailable", disposition: "not-started" });
		assert.deepEqual(fixture.calls, []);
	}
	const disabled = dispatchFixture([{ name: "run_dynamic_workflow", result: rpcFailure.result }]);
	await assert.rejects(disabled.native.launch({ name: "prepared" }), { code: "dispatch_native_failure", disposition: "uncertain" });
	disabled.assertComplete();
	const nested = dispatchFixture();
	nested.context.inWorkflow = true;
	await assert.rejects(nested.native.launch({ name: "prepared" }), { code: "dispatch_invocation_owner", disposition: "not-started" });
	assert.deepEqual(nested.calls, []);
	const unsupported = recording([], { offered: new Set([...offered, "session.workflow.run"]) });
	await assert.rejects(unsupported.transport.call("session.workflow.run", { name: "prepared" }), { code: "dispatch_capability_unavailable", disposition: "not-started" });
	assert.deepEqual(unsupported.calls, []);
});

test("uncertain effects without exact host reconciliation remain unresolved and are not recreated", async () => {
	const fixture = dispatchFixture([{ name: "create_session", fault: new Error("lost creation response") }]);
	await assert.rejects(fixture.native.create(fixture.prepared), { code: "dispatch_transport_uncertain" });
	/** @type {import("../../types/parallel.js").EffectReceipt} */
	const receipt = {
		id: "creation-receipt", attempt: fixture.prepared.attempt, kind: "creation", epoch: 0,
		payloadDigest: "e".repeat(64), state: "uncertain", sessionId: null, runId: null,
		source: "injected lost-response receipt", at: before,
	};
	assert.equal(await fixture.native.reconcile(receipt, readJsonValue(fixture.prepared)), null);
	await assert.rejects(fixture.native.reconcile({ ...receipt, attempt: { ...receipt.attempt, owner: "foreign-owner" } }, {}), { code: "dispatch_foreign_plan" });
	fixture.assertComplete();
});

function admissionPlans() {
	const prepared = reservation(), created = child();
	const initial = approved({ id: prepared.attempt.planId });
	initial.repository = { workingDirectory: created.worktreePath, baseBranch: prepared.baseBranch };
	initial.factory = {
		repositoryId, unitId: "dispatch-unit", unitRevision: 1, candidateId: null, owner,
		contractRevision: null, contractDigest: null, contextDigest: null, blueprintDigest: "f".repeat(64),
	};
	const reserved = { ...reserveTaskAttempt(initial, prepared.attempt.taskId, { reservationId: prepared.attempt.reservationId, at: before }), revision: initial.revision + 1 };
	const attached = { ...attachTaskAttempt(reserved, prepared.attempt.taskId, prepared.attempt.attemptId, {
		sessionId: created.sessionId, branch: created.branch, at: acknowledgedAt,
	}), revision: reserved.revision + 1 };
	const delivered = { ...completeTaskAttempt(attached, prepared.attempt.taskId, prepared.attempt.attemptId, "done", {
		branch: created.branch, commit: "c".repeat(40), resultSummary: "Injected delivery", evidence: claimedEvidence(), at: capturedAt,
	}), revision: attached.revision + 1 };
	return { prepared, created, initial, reserved, attached, delivered };
}

test("native status, reserve, attach and complete use captured request schemas and owned plan postconditions", async () => {
	const { prepared, created, initial, reserved, attached, delivered } = admissionPlans();
	const { attemptId, ...identity } = prepared.attempt;
	const fixture = recording([
		{ name: "foundry_get_status", result: success({ ok: true, value: { plan: initial } }) },
		{ name: "foundry_reserve_task", result: success({ ok: true, value: { plan: reserved, taskId: identity.taskId, attemptId, baseBranch: prepared.baseBranch } }) },
		{ name: "foundry_attach_task", result: success({ ok: true, value: attached }) },
		{ name: "foundry_complete_task", result: JSON.stringify({ ok: true, value: delivered }) },
	]);
	const native = createNativeAdmission({ transport: fixture.transport });
	assert.deepEqual((await native.status(identity.planId)).plan, initial);
	assert.equal((await native.reserve(identity, initial.revision)).attempt.id, attemptId);
	assert.deepEqual((await native.attach(prepared.attempt, reserved.revision, { ...created, baseCommit })).plan, attached);
	/** @type {import("../../requests.mjs").Request<"completeTask">} */
	const request = {
		planId: identity.planId, taskId: identity.taskId, attemptId, expectedRevision: attached.revision,
		status: "done", branch: created.branch, commit: "c".repeat(40), resultSummary: "Injected delivery", evidence: claimedEvidence(),
		sessionInventory: { complete: true, capturedAt, sessions: [{ id: created.sessionId, status: "idle" }] },
	};
	assert.deepEqual((await native.complete(request)).plan, delivered);
	assert.deepEqual(fixture.calls.map(call => call.arguments), [
		{ planId: identity.planId },
		{ planId: identity.planId, taskId: identity.taskId, reservationId: identity.reservationId, expectedRevision: initial.revision },
		{ planId: identity.planId, taskId: identity.taskId, attemptId, expectedRevision: reserved.revision,
			sessionId: created.sessionId, branch: created.branch, bootstrap: { worktreePath: created.worktreePath, baseCommit } },
		request,
	]);
	fixture.assertComplete();
});

test("native reservation rejects foreign ownership and mismatched returned attempt, base or repository", async () => {
	const { prepared, reserved } = admissionPlans(), { attemptId, ...identity } = prepared.attempt;
	for (const change of [
		{ attemptId: "T-001-A002" }, { taskId: "T-002" }, { baseBranch: "substituted-base" },
		{ plan: { ...reserved, factory: { ...reserved.factory, repositoryId: "c".repeat(64) } } },
	]) {
		const fixture = recording([{ name: "foundry_reserve_task", result: success({
			plan: reserved, taskId: identity.taskId, attemptId, baseBranch: prepared.baseBranch, ...change,
		}) }]);
		await assert.rejects(createNativeAdmission({ transport: fixture.transport }).reserve(identity, reserved.revision), { code: "dispatch_reservation_mismatch" });
		fixture.assertComplete();
	}
	const fixture = recording([]), native = createNativeAdmission({ transport: fixture.transport });
	await assert.rejects(native.reserve({ ...identity, owner: "foreign-owner" }, reserved.revision), { code: "dispatch_foreign_plan" });
	await assert.rejects(native.attach({ ...prepared.attempt, owner: "foreign-owner" }, reserved.revision, { ...child(), baseCommit }), { code: "dispatch_foreign_plan" });
	assert.deepEqual(fixture.calls, []);
	for (const plan of [
		{ ...reserved, id: "different-plan" },
		{ ...reserved, factory: { ...reserved.factory, owner: "foreign-owner" } },
	]) {
		const foreign = recording([{ name: "foundry_get_status", result: success({ plan }) }]);
		await assert.rejects(createNativeAdmission({ transport: foreign.transport }).status(identity.planId), { code: "dispatch_foreign_plan" });
		foreign.assertComplete();
	}
});

test("native attachment and completion reject mismatched returned postconditions", async () => {
	const { prepared, created, reserved, attached, delivered } = admissionPlans();
	for (const change of [{ sessionId: "other-child" }, { branch: "work/other-child" }, { reservationId: "other-reservation" }]) {
		const plan = structuredClone(attached);
		Object.assign(plan.tasks[0].attempts[0], change);
		const fixture = recording([{ name: "foundry_attach_task", result: success(plan) }]);
		await assert.rejects(createNativeAdmission({ transport: fixture.transport }).attach(
			prepared.attempt, reserved.revision, { ...created, baseCommit },
		), { code: "dispatch_attachment_mismatch" });
		fixture.assertComplete();
	}
	const wrongCommit = structuredClone(delivered);
	wrongCommit.tasks[0].attempts[0].commit = "d".repeat(40);
	for (const plan of [attached, wrongCommit]) {
		const fixture = recording([{ name: "foundry_complete_task", result: success(plan) }]);
		await assert.rejects(createNativeAdmission({ transport: fixture.transport }).complete({
			planId: prepared.attempt.planId, taskId: prepared.attempt.taskId, attemptId: prepared.attempt.attemptId,
			expectedRevision: attached.revision, status: "done", commit: "c".repeat(40),
		}), { code: "dispatch_delivery_mismatch" });
		fixture.assertComplete();
	}
});
