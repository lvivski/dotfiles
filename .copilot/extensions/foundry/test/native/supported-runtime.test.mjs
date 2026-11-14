import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDispatchOperations } from "../../application/dispatch.mjs";
import { parseJson, readJsonValue, readRecord, readString } from "../../data.mjs";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { fail } from "../../factory/fields.mjs";
import { createNativeAdmission, createOfferedDispatchTransport, DispatchNativeError } from "../../native/admission.mjs";
import { createdChild, dispatchReservation } from "../../native/dispatch.mjs";
import { createNativeRetention } from "../../native/retention.mjs";
import { repairMarker } from "../../native/repair.mjs";
import { createSupportedRuntime } from "../../native/supported-runtime.mjs";
import { createFoundryDispatch, createFoundryOperations } from "../../operations.mjs";
import { attachTaskAttempt, reserveTaskAttempt } from "../../plan/execution.mjs";
import { createParallelStorage } from "../../storage.mjs";
import { admissionFence } from "../../storage/admission.mjs";
import { buildFoundryTools } from "../../tools.mjs";
import { analysisStub, createApproved, runTask, withOperations } from "../application/fixture.mjs";
import { createParallelFixture } from "../parallel/fixture.mjs";
import { approved } from "../plan/fixture.mjs";
import { repairNativeFixture } from "./plans.mjs";

/** @typedef {import("../../types/json.js").JsonValue} Json */
/** @typedef {import("../../types/parallel.js").EffectReceipt} Receipt */
/** @typedef {import("../../native/admission.mjs").NativeResult} NativeResult */
/** @typedef {{name: string, arguments: Json, toolCallId?: string}} Invocation */
/** @typedef {{sessionId: string, workspacePath: string, rpc: {tools: {execute(input: Invocation): Promise<unknown>}}}} RecordingSession */
/** @typedef {ReturnType<typeof scenario>} Scenario */

/** These recording SDK/provider boundaries are not evidence of live App effects. */
const AT = "2026-11-13T00:00:00.000Z";
const REPOSITORY = "a".repeat(64), COMMIT = "b".repeat(40);
const PROMPT = "Reserved task: café / 雪\r\n\tPreserve every byte.  \t\r\n\n";
/** @param {unknown} value */
const success = value => ({ resultType: "success", textResultForLlm: JSON.stringify(value) });
/** @template T @param {T} result @param {string} code
 * @returns {asserts result is T & {state: "held", code: string, details?: unknown}} */
function held(result, code) {
	assert.equal(readRecord(result).state, "held", JSON.stringify(result));
	assert.equal(readRecord(result).code, code, JSON.stringify(result));
}

/** @param {string} workspacePath */
function recording(workspacePath) {
	/** @type {Invocation[]} */
	const calls = [];
	/** @type {import("../../native/observations.mjs").Context} */
	const context = { workspacePath, sessionId: "recording-owner", projectId: "recording-project",
		repositoryId: REPOSITORY, inWorkflow: false };
	/** @type {{response: unknown, during: ((input: Invocation) => void) | null, owner: RecordingSession | null,
	 * reconcile: NativeResult | null, failOutcome: boolean,
	 * reconciliations: {receipt: Receipt, payload: Json}[]}} */
	const state = {
		response: success({ native: { identity: "recorded-run" } }),
		during: null, owner: null, reconcile: null, failOutcome: false, reconciliations: [],
	};
	/** @type {RecordingSession["rpc"]["tools"]} */
	const tools = { async execute(input) {
		calls.push(structuredClone(input));
		state.during?.(input);
		if (state.response instanceof Error) throw state.response;
		return structuredClone(state.response);
	} };
	// A real SDK session has getters unrelated to this route; never enumerate it.
	/** @type {RecordingSession} */
	const owner = { sessionId: context.sessionId, workspacePath, rpc: { tools } };
	Object.defineProperty(owner, "workflow", { enumerable: true, get() { throw new Error("Private workflow API was read"); } });
	state.owner = owner;
	const runtime = createSupportedRuntime({ getSession: () => state.owner });
	return { calls, context, state, owner, tools, runtime };
}

/**
 * Actual shared SQLite admission/journal and production runtime/host/dispatch composition.
 * The extra transport names belong ONLY to a recording canonical fixture provider, not
 * the supported runtime. Cold effects always throw; warm tests seed original receipts.
 */
function scenario() {
	const fixture = createParallelFixture({ name: "supported-runtime" });
	const r = recording(fixture.workspacePath);
	let plan = approved({ id: "supported-runtime" });
	plan.repository.workingDirectory = fixture.workspacePath;
	plan.factory = { repositoryId: REPOSITORY, owner: fixture.workspacePath, unitId: "recorded-unit",
		unitRevision: 1, candidateId: null, contractRevision: null, contractDigest: null,
		contextDigest: null, blueprintDigest: "c".repeat(64) };
	plan = reserveTaskAttempt(plan, "T-001", { reservationId: "supported-reservation" });
	const identity = { repositoryId: REPOSITORY, owner: fixture.workspacePath,
		planId: plan.id, taskId: "T-001", reservationId: "supported-reservation" };
	const attempt = { ...identity, attemptId: "T-001-A001" };
	const child = { sessionId: "recorded-child", projectId: r.context.projectId,
		creatorSessionId: r.context.sessionId, worktreePath: path.join(fixture.workspacePath, "child"), branch: "recorded-child" };
	const reservation = dispatchReservation({ attempt, projectId: child.projectId, baseBranch: "main", baseCommit: COMMIT,
		initialization: { acknowledgement: `Foundry setup ready: ${plan.id}/T-001/T-001-A001`,
			kickoff: { mode: "interactive", prompt: "Setup only.  \n" } },
		delegationPrompt: PROMPT, inputs: null, requiredInputs: [] });
	const settings = { workspacePath: fixture.workspacePath, repositoryId: REPOSITORY,
		owner: fixture.workspacePath, directoryParts: ["canonical-admission"], clock: () => AT };
	const openStorage = () => createParallelStorage(settings);
	const storage = openStorage();
	const claim = storage.admission.claim({ identity, expectedRevision: 0,
		resources: [{ id: "output", kind: "shared-write", scope: fixture.workspacePath,
			mode: "exclusive", capacity: 1, units: 1 }], team: null });
	storage.admission.bindReservation(admissionFence(claim), attempt);
	/** @type {Invocation[]} */
	const canonicalReads = [];
	/** @param {unknown} input @param {unknown} value @returns {import("../../native/observations.mjs").Capture} */
	const capture = (input, value) => ({ context: structuredClone(r.context), subjectDigest: analysisInputDigest(input),
		capturedAt: new Date().toISOString(), source: "recording canonical provider", complete: true, value });
	/** @type {Parameters<typeof r.runtime.host>[0]} */
	const access = {
		current: () => r.context, readPlan: () => plan, taskPolicies: () => ({}),
		decodeCreated: createdChild,
		decodeHandoff: value => ({ sessionId: readString(readRecord(value).sessionId), accepted: readRecord(value).accepted === true }),
		// Deliberately nonstandard: the root composition must forward this decoder.
		decodeRun: value => readString(readRecord(readRecord(value).native).identity),
		observations: {
			setup: async () => { throw new Error("Warm admission must not bootstrap again"); },
			child: async () => { throw new Error("Warm admission must retain original attachment"); },
			reconcile: async input => {
				r.state.reconciliations.push(structuredClone(input));
				return capture(input, r.state.reconcile === null ? null : { ...input, result: r.state.reconcile });
			},
		},
	};
	function compose(ports = openStorage()) {
		const host = r.runtime.host(access);
		assert.equal(host.state, "available");
		assert.deepEqual([...host.offered].sort(), ["run_dynamic_workflow", "send_session_message"]);
		const fixtureNames = new Set([...host.offered, "foundry_get_status", "create_session",
			"get_session", "list_sessions_and_chats", "foundry_attach_task"]);
		const transport = createOfferedDispatchTransport({
			owner: identity.owner, sessionId: r.context.sessionId,
			context: () => ({ owner: r.context.workspacePath, sessionId: r.context.sessionId, inWorkflow: r.context.inWorkflow }),
			offered: fixtureNames,
			route: host.route, capability: host.capability,
			availability: name => host.offered.has(name) ? host.availability(name) : "supported",
			executor: { async execute(input) {
				if (host.offered.has(input.name)) {
					const kind = input.name === "run_dynamic_workflow" ? "workflow" : "handoff";
					const receipt = ports.journal.read(attempt).find(value => value.kind === kind);
					if (receipt) {
						assert.equal(receipt.state, "in-flight");
						assert.equal(input.toolCallId, receipt.id, "The native correlation must be durable before RPC admission");
						const admission = ports.admission.read(identity);
						assert.ok(admission);
						assert.deepEqual(admission.receipts.find(value => value.id === receipt.id), receipt);
					}
					return host.executor.execute(input);
				}
				if (input.name === "foundry_get_status") {
					canonicalReads.push(structuredClone(input));
					return success({ plan });
				}
				throw new Error(`Cold fixture operation is forbidden: ${input.name}`);
			} },
		});
		const native = createFoundryDispatch(host, transport);
		/** @type {typeof ports.journal} */
		const journal = { ...ports.journal, recordResult(tx, receipt, outcome) {
			if (r.state.failOutcome) fail("recording_write_failed", "Injected failed canonical outcome write");
			return ports.journal.recordResult(tx, receipt, outcome);
		} };
		return { host, transport, native, ports, dispatcher: createDispatchOperations({
			admission: ports.admission, journal, native, plans: createNativeAdmission({ transport }),
			reserve: async () => { throw new Error("Warm dispatch must not reserve again"); },
			ready: async () => [], clock: () => AT,
		}) };
	}
	/** @param {"creation" | "attachment"} kind @param {Json} payload @param {unknown} value */
	function seed(kind, payload, value) {
		const { admission, journal } = storage;
		const fence = () => {
			const record = admission.read(identity);
			assert.ok(record);
			return admissionFence(record);
		};
		/** @type {Receipt} */
		const receipt = { id: `recorded-${kind}`, attempt, kind, epoch: 0,
			payloadDigest: analysisInputDigest(payload), state: "intent",
			sessionId: null, runId: null, source: "recorded original canonical receipt", at: AT };
		admission.withFence(fence(), tx => journal.prepare(tx, receipt, payload));
		admission.withFence(fence(), tx => journal.start(tx, receipt.id));
		admission.withFence(fence(), tx => journal.recordResult(tx, { ...receipt, state: "succeeded", sessionId: child.sessionId },
			readJsonValue({ value, raw: success(value), source: receipt.source, startedAt: AT })));
	}
	function warm() {
		plan = attachTaskAttempt(plan, identity.taskId, attempt.attemptId, { sessionId: child.sessionId, branch: child.branch });
		seed("creation", readJsonValue({ reservation, arguments: compose().native.createArguments(reservation) }), child);
		seed("attachment", { child, baseCommit: COMMIT }, plan);
		r.state.response = success({ sessionId: child.sessionId, accepted: true });
	}
	return { ...r, fixture, identity, attempt, child, reservation, storage, compose, warm, canonicalReads,
		/** @param {unknown} [value] @returns {NativeResult} */
		original(value = { native: { identity: "recorded-run" } }) {
			const receipt = storage.journal.read(attempt).find(value => value.kind === "workflow");
			assert.ok(receipt);
			return { value, raw: success(value), source: `${r.context.sessionId}/run_dynamic_workflow/${receipt.id}` };
		} };
}

test("SR03/09 supported runtime exposes only callable RPC callbacks; missing authority stays partial and unobserved", async () => {
	const fixture = createParallelFixture({ name: "supported-capabilities" });
	try {
		const r = recording(fixture.workspacePath);
		const host = r.runtime.host();
		assert.equal(r.runtime.route, "extension-rpc");
		assert.equal(host.state, "partial");
		assert.equal(host.route, "extension-rpc");
		assert.equal(Object.hasOwn(host, "session"), false);
		assert.equal(Object.hasOwn(host, "executor"), false);
		for (const capability of r.runtime.capabilities()) {
			assert.equal(capability.advertised, null);
			assert.equal(capability.admission, "unobserved");
			assert.equal(capability.effect, "unobserved");
			assert.equal(capability.callable, ["run_dynamic_workflow", "send_session_message"].includes(capability.operation));
			if (!capability.callable) {
				assert.equal(capability.disposition, "held");
				assert.ok(capability.prerequisite?.length);
			}
		}
		for (const operation of ["cold_first_assignment", "observeSetup", "observeChild", "technical_execution",
			"retention_persistence", "archive_session"]) {
			assert.equal(host.capabilities.find(value => value.operation === operation)?.callable, false);
		}
		Reflect.set(r.tools, "execute", "not-a-callable-SDK-boundary");
		assert.ok(r.runtime.capabilities().every(value => !value.callable && value.disposition === "held"));
		await assert.rejects(r.runtime.workflow({ name: "prepared" }, "non-callable"), { code: "dispatch_identity_unavailable" });
		assert.equal(r.calls.length, 0);
		r.state.owner = null;
		assert.ok(r.runtime.capabilities().every(value => !value.callable && value.disposition === "held"));
		await assert.rejects(r.runtime.workflow({ name: "prepared" }, "missing-owner"), { code: "dispatch_identity_unavailable" });
		assert.equal(r.calls.length, 0);
	} finally { fixture.dispose(); }
});

test("SR02/04 production host/root/native composition forwards exact launch bytes, optional omissions and injected decoder", async () => {
	/** @type {Json[]} */
	const specs = [
		{ name: "prepared" },
		{ name: "prepared", args: { input: { complete: ["full", "payload"], whitespace: PROMPT }, optional: null } },
		{ name: "prepared", args: { input: ["nested"] },
			limits: { maxTotalSubagents: 3, maxConcurrentSubagents: 2, timeoutSeconds: 240, maxAiCredits: 1.5 } },
	];
	for (const spec of specs) {
		const s = scenario();
		try {
			const digest = analysisInputDigest(spec), c = s.compose();
			const result = await c.native.launch(spec, "original-correlation");
			assert.equal(c.native.decodeRun(result.value), "recorded-run");
			assert.deepEqual(s.calls, [{ name: "run_dynamic_workflow", arguments: spec, toolCallId: "original-correlation" }]);
			assert.equal(analysisInputDigest(spec), digest);
			for (const key of ["args", "limits"]) {
				assert.equal(Object.hasOwn(readRecord(s.calls[0].arguments), key), Object.hasOwn(readRecord(spec), key));
			}
			assert.deepEqual(result.raw, s.state.response);
			assert.equal(result.source, `${s.context.sessionId}/run_dynamic_workflow/original-correlation`);
			await assert.rejects(c.transport.call("archive_session", {}, "held-unrelated"), error => {
				assert.ok(error instanceof DispatchNativeError);
				assert.equal(error.code, "dispatch_capability_unavailable");
				const details = readRecord(error.receipt);
				assert.equal(details.operation, "archive_session");
				assert.equal(details.route, "extension-rpc");
				assert.equal(details.disposition, "held");
				assert.match(readString(details.prerequisite), /all-writer guard/);
				return true;
			});
			assert.equal(s.calls.length, 1, "An unrelated held operation must not invoke an RPC or disable the supported launch");
			assert.equal(s.canonicalReads.length, 0);
		} finally { s.fixture.dispose(); }
	}
});

test("SR02/06 root repair launch uses supported RPC with the existing durable journal and never relaunches on restart", async t => {
	const f = await repairNativeFixture(t);
	const runtime = createSupportedRuntime({ getSession: () => f.session });
	const createOps = () => createFoundryOperations({
		getSession: () => f.session, getWorkspacePath: () => f.owner, analysis: f.analysis,
		getNativeRuntime: () => runtime, getParallelHost: () => runtime.host(),
		repairHost: f.nativeHost.host,
	});
	const prepared = await f.prepare();
	const before = f.journal().read(prepared.preparationId, prepared.preparationDigest);
	const source = structuredClone(f.records.source);
	assert.equal(before.state, "prepared");
	assert.equal(f.launches.length, 0);
	const admitted = await createOps().launchPlanRepair(prepared.launchSpec.args, f.context);
	assert.equal(admitted.state, "admitted");
	assert.equal(admitted.runId, "repair-native-run");
	const effect = f.journal().effects(prepared.preparationId, prepared.preparationDigest)[0].effect;
	const expected = { name: "run_dynamic_workflow", arguments: prepared.launchSpec,
		toolCallId: `repair-${readRecord(effect).id}` };
	assert.deepEqual(f.launches, [expected]);
	assert.equal(Object.hasOwn(readRecord(f.launches[0].arguments), "limits"), Object.hasOwn(prepared.launchSpec, "limits"));
	const events = f.journal().events(prepared.preparationId, prepared.preparationDigest);
	assert.ok(events.some(event => event.event === "effect-receipt"));
	assert.deepEqual(readRecord(readRecord(events.at(-1)?.payload).evidence).output, success({ runId: "repair-native-run" }));
	assert.equal((await createOps().launchPlanRepair(prepared.launchSpec.args, f.context)).runId, admitted.runId);
	assert.deepEqual(f.journal().events(prepared.preparationId, prepared.preparationDigest).slice(0, events.length), events);
	f.records["repair-native-run"].progress = [repairMarker(before.preparation)];
	const reconciled = await createOps().reconcilePlanRepair(prepared.launchSpec.args, f.context);
	assert.equal(reconciled.state, "admitted");
	assert.equal(reconciled.runId, admitted.runId);
	assert.deepEqual(reconciled.preparation, before.preparation);
	assert.equal((await createOps().launchPlanRepair(prepared.launchSpec.args, f.context)).runId, admitted.runId);
	assert.deepEqual(f.launches, [expected], "Reconciliation must observe the original run, not invoke a new launch");
	assert.deepEqual(f.records.source, source);
});

test("SR06 root repair retains original raw admission after owner drift and never relaunches", async t => {
	const f = await repairNativeFixture(t);
	const runtime = createSupportedRuntime({ getSession: () => f.session });
	const ops = createFoundryOperations({ getSession: () => f.session, getWorkspacePath: () => f.owner,
		analysis: f.analysis, getNativeRuntime: () => runtime, repairHost: f.nativeHost.host });
	const prepared = await f.prepare(), raw = success({ runId: "possibly-admitted-original-run" });
	f.setExecutor(async () => { f.session.sessionId = "changed-owner"; return raw; });
	await assert.rejects(ops.launchPlanRepair(prepared.launchSpec.args, f.context), { code: "repair_admission_uncertain" });
	const record = f.journal().read(prepared.preparationId, prepared.preparationDigest);
	assert.equal(record.state, "uncertain");
	const evidence = readRecord(readRecord(f.journal().events(prepared.preparationId, prepared.preparationDigest).at(-1)?.payload).evidence);
	assert.deepEqual(readRecord(evidence.receipt).raw, raw);
	assert.equal(readRecord(evidence.receipt).operation, "run_dynamic_workflow");
	f.session.sessionId = f.sessionId;
	await assert.rejects(ops.launchPlanRepair(prepared.launchSpec.args, f.context));
	assert.equal(f.launches.length, 1);
});

test("SR06 root repair exposes original raw admission when its outcome transaction fails and retains durable intent", async t => {
	const f = await repairNativeFixture(t);
	const runtime = createSupportedRuntime({ getSession: () => f.session });
	const createOps = () => createFoundryOperations({ getSession: () => f.session, getWorkspacePath: () => f.owner,
		analysis: f.analysis, getNativeRuntime: () => runtime, repairHost: f.nativeHost.host });
	const prepared = await f.prepare(), databasePath = f.journal().databasePath;
	const execute = f.session.rpc.tools.execute.bind(f.session.rpc.tools);
	f.session.rpc.tools.execute = async input => {
		const raw = await execute(input);
		const db = new DatabaseSync(databasePath);
		try {
			db.exec(`CREATE TRIGGER supported_repair_outcome_failure BEFORE INSERT ON planning_repair_events
				WHEN NEW.event = 'admitted' BEGIN SELECT RAISE(FAIL, 'recording failed outcome persistence'); END`);
		} finally { db.close(); }
		return raw;
	};
	await assert.rejects(createOps().launchPlanRepair(prepared.launchSpec.args, f.context), error => {
		assert.ok(error instanceof Error);
		const failure = readRecord(Reflect.get(error, "details"));
		assert.equal(Reflect.get(error, "code"), "database_error");
		assert.equal(failure.sqliteMessage, "recording failed outcome persistence");
		assert.equal(failure.preparationId, prepared.preparationId);
		assert.equal(failure.disposition, "uncertain");
		assert.deepEqual(readRecord(readRecord(failure.unpersisted).evidence).output, success({ runId: "repair-native-run" }));
		assert.equal(readRecord(failure.unpersisted).runId, "repair-native-run");
		return true;
	});
	assert.equal(f.journal().read(prepared.preparationId, prepared.preparationDigest).state, "intent");
	assert.ok(f.journal().events(prepared.preparationId, prepared.preparationDigest).some(event => event.event === "effect-receipt"));
	const db = new DatabaseSync(databasePath);
	try { db.exec("DROP TRIGGER supported_repair_outcome_failure"); } finally { db.close(); }
	assert.equal((await createOps().launchPlanRepair(prepared.launchSpec.args, f.context)).runId, "repair-native-run");
	assert.equal(f.launches.length, 1);
});

test("SR04 warm handoff retains coordinator-only reserved prompt bytes and canonical once-only admission across restart", async () => {
	const s = scenario();
	try {
		s.warm();
		const first = await s.compose().dispatcher.dispatch(s.identity);
		assert.equal(first.state, "handed-off", JSON.stringify(first));
		assert.equal(first.executionObserved, false);
		assert.equal(first.inputsMaterialized, false);
		assert.deepEqual(s.calls, [{ name: "send_session_message", arguments: {
			session_id: s.child.sessionId, message: PROMPT, coordinator_only: true, delivery_mode: "immediate", mode: "autopilot",
		}, toolCallId: first.receipt.id }]);
		assert.deepEqual(Buffer.from(s.calls[0].arguments.message), Buffer.from(s.reservation.delegationPrompt));
		assert.deepEqual(await s.compose().dispatcher.dispatch(s.identity), first);
		assert.equal(s.calls.length, 1, "Reconstructed dispatch must read the original handoff, not admit another message");
		assert.deepEqual(s.storage.journal.read(s.attempt).map(value => [value.kind, value.state]),
			[["creation", "succeeded"], ["attachment", "succeeded"], ["handoff", "succeeded"]]);
		assert.deepEqual(readRecord(s.storage.journal.outcomes(s.attempt, first.receipt.id)[0]).raw, s.state.response);
	} finally { s.fixture.dispose(); }
});

test("SR02/04 closed workflow and warm inputs cannot add authority or invoke dependent operations", async () => {
	const s = scenario();
	try {
		for (const extra of [{ resumeFromRunId: "foreign" }, { authorized: true }, { permissions: "all" }, { toolCallId: "forged" }]) {
			await assert.rejects(s.runtime.workflow({ name: "prepared", ...extra }, "invalid"), { code: "factory_input_invalid" });
		}
		const warm = { session_id: s.child.sessionId, message: PROMPT, coordinator_only: true,
			delivery_mode: "immediate", mode: "autopilot" };
		for (const extra of [{ coordinator_only: false }, { delivery_mode: "enqueue" }, { mode: "interactive" },
			{ source_user_message: { id: "invented", revision: 1 } }, { authorized: true }, { prompt: "rewritten" }]) {
			await assert.rejects(Reflect.apply(s.runtime.warmHandoff, undefined, [{ ...warm, ...extra }, "invalid"]));
		}
		const c = s.compose();
		for (const child of [{ ...s.child, projectId: "foreign" }, { ...s.child, creatorSessionId: "foreign" },
			{ ...s.child, sessionId: s.context.sessionId }]) {
			await assert.rejects(c.native.handoff(s.reservation, child, "foreign"), { code: "dispatch_child_mismatch" });
		}
		await assert.rejects(c.native.handoff({ ...s.reservation, attempt: { ...s.attempt, owner: "/foreign" } }, s.child),
			{ code: "dispatch_foreign_plan" });
		const result = await c.dispatcher.launch({ ...s.attempt, owner: "/foreign" }, { name: "prepared" });
		held(result, "dispatch_foreign_plan");
		assert.equal(s.calls.length + s.canonicalReads.length, 0);
	} finally { s.fixture.dispose(); }
});

test("SR04 owner drift before admission holds; drift during RPC preserves original raw result as uncertain", async () => {
	/** @type {((s: Scenario) => void)[]} */
	const before = [
		s => { s.context.workspacePath = "/foreign"; },
		s => { s.context.sessionId = "foreign"; },
		s => { s.context.projectId = "foreign"; },
		s => { s.context.repositoryId = "d".repeat(64); },
		s => { s.context.inWorkflow = true; },
		s => { s.context.agentId = "runtime-helper"; },
	];
	for (const change of before) {
		const s = scenario();
		try {
			const c = s.compose();
			change(s);
			await assert.rejects(c.native.launch({ name: "prepared" }, "before"), { code: "dispatch_invocation_owner" });
			assert.equal(s.calls.length, 0);
		} finally { s.fixture.dispose(); }
	}
	/** @type {((s: Scenario) => void)[]} */
	const during = [
		s => { s.owner.sessionId = "changed"; },
		s => { s.owner.workspacePath = "/changed"; },
		s => { s.owner.rpc.tools = { execute: async () => { throw new Error("Alternate executor must never run"); } }; },
		s => { s.owner.rpc.tools.execute = async () => { throw new Error("Same-object replacement executor must never run"); }; },
	];
	for (const change of during) {
		const s = scenario();
		try {
			s.state.during = () => change(s);
			await assert.rejects(s.compose().native.launch({ name: "prepared" }, "during"), error => {
				assert.ok(error instanceof DispatchNativeError);
				assert.equal(error.code, "dispatch_invocation_owner");
				assert.equal(error.disposition, "uncertain");
				assert.deepEqual(readRecord(error.receipt).raw, s.state.response);
				return true;
			});
			assert.equal(s.calls.length, 1);
			assert.equal(s.canonicalReads.length, 0);
		} finally { s.fixture.dispose(); }
	}
});

test("SR06 workflow durable receipt survives duplicate/reconstructed dispatch without a second RPC", async () => {
	const s = scenario(), spec = { name: "prepared", args: { exact: PROMPT }, limits: { maxTotalSubagents: 2 } };
	try {
		const firstDispatcher = s.compose().dispatcher;
		const first = await firstDispatcher.launch(s.attempt, spec);
		assert.equal(first.state, "launched", JSON.stringify(first));
		assert.equal(first.runId, "recorded-run");
		assert.deepEqual(await firstDispatcher.launch(s.attempt, spec), first);
		assert.deepEqual(await s.compose().dispatcher.launch(s.attempt, spec), first);
		held(await s.compose().dispatcher.launch(s.attempt, { ...spec, limits: { maxTotalSubagents: 8 } }), "parallel_receipt_identity");
		assert.equal(s.calls.length, 1);
		assert.deepEqual(s.calls[0], { name: "run_dynamic_workflow", arguments: spec, toolCallId: first.receipt.id });
		assert.deepEqual(s.storage.journal.payload(s.attempt, "workflow"), spec);
		assert.deepEqual(s.storage.admission.read(s.identity)?.receipts, [first.receipt]);
		assert.deepEqual(s.storage.journal.outcomes(s.attempt, first.receipt.id)[0], { ...s.original(), startedAt: AT });
	} finally { s.fixture.dispose(); }
});

test("SR06 denied workflow and warm admissions are definitive, retain raw denial and never replay", async () => {
	for (const warm of [false, true]) {
		const s = scenario();
		try {
			if (warm) s.warm();
			const raw = { resultType: "denied", textResultForLlm: "Permission denied by original recording boundary" };
			s.state.response = raw;
			const run = () => warm ? s.compose().dispatcher.dispatch(s.identity)
				: s.compose().dispatcher.launch(s.attempt, { name: "prepared" });
			held(await run(), "dispatch_permission_rejected");
			held(await run(), "dispatch_effect_terminal");
			assert.equal(s.calls.length, 1);
			const receipt = s.storage.journal.read(s.attempt).find(value => value.kind === (warm ? "handoff" : "workflow"));
			assert.ok(receipt);
			assert.equal(receipt.state, "definitive-failure");
			const original = readRecord(s.storage.journal.outcomes(s.attempt, receipt.id)[0]);
			assert.deepEqual(readRecord(original.raw).raw, raw);
			assert.equal(readRecord(original.error).code, "dispatch_permission_rejected");
			assert.equal(s.state.reconciliations.length, 0);
		} finally { s.fixture.dispose(); }
	}
});

test("SR06 malformed or lost workflow results retain uncertainty and reconcile the original operation without invocation", async () => {
	for (const raw of [
		{ native: { identity: "unwrapped-not-authority" } },
		success({ wrong: "missing-native-identity" }),
		new Error("Recording transport lost after possible workflow launch"),
	]) {
		const s = scenario(), spec = { name: "prepared", args: { exact: ["payload"] } };
		try {
			s.state.response = raw;
			assert.equal((await s.compose().dispatcher.launch(s.attempt, spec)).state, "held");
			const receipt = s.storage.journal.read(s.attempt)[0];
			assert.equal(receipt.state, "uncertain");
			assert.equal(receipt.runId, null);
			const outcome = readRecord(s.storage.journal.outcomes(s.attempt, receipt.id)[0]);
			assert.ok(outcome.error);
			if (!(raw instanceof Error)) {
				assert.deepEqual(readRecord(raw).resultType === "success" ? outcome.raw : readRecord(outcome.raw).raw, raw);
			}
			held(await s.compose().dispatcher.launch(s.attempt, spec), "dispatch_effect_uncertain");
			assert.equal(s.calls.length, 1);
			s.state.reconcile = s.original();
			const recovered = await s.compose().dispatcher.launch(s.attempt, spec);
			assert.equal(recovered.state, "launched", JSON.stringify(recovered));
			assert.equal(recovered.runId, "recorded-run");
			assert.equal(s.calls.length, 1);
			const request = s.state.reconciliations.at(-1);
			assert.ok(request);
			assert.equal(request.receipt.id, receipt.id);
			assert.deepEqual(request.payload, spec);
			assert.deepEqual(readRecord(s.storage.journal.outcomes(s.attempt, receipt.id).at(-1)).raw, s.original().raw);
		} finally { s.fixture.dispose(); }
	}
});

test("SR06 failed outcome persistence exposes original raw identity and leaves durable start for read-only reconciliation", async () => {
	const s = scenario(), spec = { name: "prepared", args: { immutable: true } };
	try {
		s.state.failOutcome = true;
		const result = await s.compose().dispatcher.launch(s.attempt, spec);
		held(result, "dispatch_outcome_persistence_failed");
		const details = readRecord(result.details), unpersisted = readRecord(details.unpersisted);
		assert.equal(details.disposition, "uncertain");
		assert.equal(details.operation, "workflow");
		assert.deepEqual(unpersisted.raw, s.state.response);
		assert.equal(readRecord(readRecord(unpersisted.value).native).identity, "recorded-run");
		assert.equal(readRecord(details.persistenceError).code, "recording_write_failed");
		const receipt = s.storage.journal.read(s.attempt)[0];
		assert.equal(receipt.state, "in-flight");
		assert.equal(readRecord(details.receipt).id, receipt.id);
		assert.deepEqual(s.storage.journal.outcomes(s.attempt, receipt.id), []);
		s.state.failOutcome = false;
		held(await s.compose().dispatcher.launch(s.attempt, spec), "dispatch_effect_uncertain");
		s.state.reconcile = { value: unpersisted.value, raw: readJsonValue(unpersisted.raw),
			source: readString(unpersisted.source) };
		const recovered = await s.compose().dispatcher.launch(s.attempt, spec);
		assert.equal(recovered.state, "launched");
		assert.equal(recovered.runId, "recorded-run");
		assert.equal(s.calls.length, 1);
		assert.equal(s.state.reconciliations.at(-1)?.receipt.id, receipt.id);
	} finally { s.fixture.dispose(); }
});

test("SR05 partial runtime preserves legacy root reserve/attach but holds cold automatic admission before any effect", async () => {
	/** @type {ReturnType<typeof recording>} */
	let r;
	await withOperations(async ({ operations, workspacePath }) => {
		r = recording(workspacePath);
		let plan = await createApproved(operations, workspacePath);
		const reserved = await operations.reserveTask({ planId: plan.id, taskId: "T-001",
			expectedRevision: plan.revision, reservationId: "legacy-partial" });
		plan = await operations.attachTask({ planId: plan.id, taskId: "T-001", attemptId: reserved.attemptId,
			expectedRevision: reserved.plan.revision, sessionId: "legacy-child", branch: "legacy-branch" });
		assert.equal(plan.tasks[0].attempts.at(-1)?.sessionId, "legacy-child");
		const before = structuredClone(plan);
		assert.deepEqual(readRecord(await operations.getStatus({ planId: plan.id })).nativeCapabilities, r.runtime.capabilities());
		const cold = await operations.dispatchReady({ planId: plan.id, limit: 1 },
			{ invocation: { sessionId: r.context.sessionId, toolCallId: "cold-held" } });
		held(cold, "parallel_identity_unsupported");
		assert.equal(readRecord(cold.details).disposition, "held");
		assert.equal(readRecord(cold.details).route, "extension-rpc");
		assert.deepEqual(await operations.storeFor().read(plan.id), before);
		assert.equal(r.calls.length, 0);
	}, { getSession: () => r?.owner, getParallelHost: () => r?.runtime.host(), getNativeRuntime: () => r.runtime });
});

test("SR07 root completion uses owning native context and closed canonical notification; missing outbox never archives", async () => {
	/** @type {ReturnType<typeof recording>} */
	let r;
	let notifications = 0;
	await withOperations(async ({ operations, workspacePath }) => {
		r = recording(workspacePath);
		const input = { repositoryPath: workspacePath, eventId: "recorded-canonical-completion" };
		for (const context of [{}, { invocation: { sessionId: "foreign", toolCallId: "foreign" } },
			{ invocation: { sessionId: r.context.sessionId, toolCallId: "helper", agentId: "helper" } }]) {
			await assert.rejects(operations.completionEvent(input, context), { code: "delegation_identity_required" });
		}
		assert.equal(notifications, 0);
		const context = { invocation: { sessionId: r.context.sessionId, toolCallId: "completion-notification" } };
		for (const extra of [{ event: { status: "done" } }, { cleanup: true }, { archive: true }, { canonical: {} }]) {
			await assert.rejects(operations.completionEvent({ ...input, ...extra }, context), { code: "factory_input_invalid" });
		}
		await assert.rejects(operations.completionEvent(input, context), { code: "retention_persistence_unsupported" });
		await assert.rejects(operations.completionEvent(input, context), { code: "retention_persistence_unsupported" });
		assert.equal(notifications, 6);
		assert.equal(r.calls.length, 0, "Neither completion nor absent persistence may invoke archive, workflow or a fallback");
		assert.ok(buildFoundryTools(operations).every(tool => !/completion_event|archive_session|retention/.test(tool.name)),
			"Canonical notifications are not a public tool accepting event payloads");
	}, { getSession: () => r?.owner, getNativeRuntime: () => ({ ...r.runtime, completionEvent(input, retentionFor) {
		notifications++;
		return r.runtime.completionEvent(input, retentionFor);
	} }) });
});

test("SR07 supplied canonical SQLite completion binding persists one assessment across duplicate and reconstructed root delivery", async () => {
	const fixture = createParallelFixture({ name: "supported-completion-outbox", initialize(db) {
		db.exec("CREATE TABLE IF NOT EXISTS supported_completion_outbox (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL)");
	} });
	/** @type {ReturnType<typeof recording>} */
	let r;
	/** @type {NonNullable<ReturnType<import("../../application/storage.mjs").RetentionBindings>> | undefined} */
	let binding;
	const counts = { completions: 0, captures: 0, artifacts: 0, transactions: 0, inserts: 0, replacements: 0,
		guards: 0, archive: 0, reconciliations: 0 };
	try {
		await withOperations(async ({ operations, workspacePath, notifications }) => {
			r = recording(workspacePath);
			const approved = await createApproved(operations, workspacePath);
			const { plan: completed } = await runTask(operations, approved, "T-001", { sessionId: "completed-recording-child" });
			const finished = completed.tasks.find(task => task.id === "T-001"), attempt = finished?.attempts.at(-1);
			assert.ok(completed.factory && finished && attempt?.commit && attempt.sessionId);
			const reserved = await operations.reserveTask({ planId: completed.id, expectedRevision: completed.revision,
				taskId: "T-002", reservationId: "other-still-running" });
			const before = await operations.attachTask({ planId: completed.id, taskId: "T-002", attemptId: reserved.attemptId,
				expectedRevision: reserved.plan.revision, sessionId: "still-running-recording-child", branch: "work/still-running" });
			const notificationCount = notifications.length;
			/** @type {import("../../types/retention.js").RetentionEvent} */
			const event = { version: 1, id: "supplied-canonical-completion", revision: completed.revision, sequence: completed.revision,
				sourceCommit: attempt.commit, sourceDigest: analysisInputDigest(finished), at: AT, source: "immutable recording canonical task completion",
				subject: { sessionId: attempt.sessionId, coordinatorSessionId: r.owner.sessionId,
					worktreePath: path.join(fixture.workspacePath, "completed-recording-child"),
					attempt: { repositoryId: completed.factory.repositoryId, owner: workspacePath, planId: completed.id,
						taskId: finished.id, attemptId: attempt.id, reservationId: attempt.reservationId } } };
			const originalEvent = structuredClone(event);
			/** @param {import("node:sqlite").DatabaseSync} db @param {string} id */
			const read = (db, id) => {
				const row = db.prepare("SELECT document FROM supported_completion_outbox WHERE id = ?").get(id);
				return row ? parseJson(String(row.document)) : null;
			};
			/** @type {import("../../types/retention.js").RetentionCanonicalPort} */
			const canonical = {
				read: id => read(fixture.right.db, id),
				transaction(actual, action) {
					counts.transactions++;
					return fixture.left.storage.transaction(db => action({
						assertCurrent(current, assessment, mode) {
							assert.deepEqual(current, originalEvent);
							assert.deepEqual(actual, originalEvent);
							assert.equal(assessment, null);
							assert.equal(mode, "assess", "Completion notification must not admit archive start");
							assert.deepEqual(operations.storeFor().readCurrent(completed.id).tasks.find(task => task.id === finished.id), finished);
						},
						read: id => read(db, id),
						insert(intent) {
							counts.inserts++;
							db.prepare("INSERT INTO supported_completion_outbox VALUES (?, ?, ?)")
								.run(intent.id, intent.revision, stableStringify(intent));
						},
						replace(intent, expectedRevision) {
							counts.replacements++;
							const changed = db.prepare("UPDATE supported_completion_outbox SET revision = ?, document = ? WHERE id = ? AND revision = ?")
								.run(intent.revision, stableStringify(intent), intent.id, expectedRevision);
							assert.equal(changed.changes, 1);
						},
					}), { write: true });
				},
			};
			binding = {
				scope: { repositoryId: completed.factory.repositoryId, owner: workspacePath,
					coordinatorSessionId: r.owner.sessionId, currentSessionId: r.owner.sessionId }, canonical,
				observations: {
					async completion(eventId) {
						counts.completions++;
						assert.equal(eventId, originalEvent.id);
						return structuredClone(originalEvent);
					},
					async capture(actual) {
						counts.captures++;
						assert.deepEqual(actual, originalEvent);
						return { version: 1, subject: originalEvent.subject, eventId: originalEvent.id,
							eventRevision: originalEvent.revision, eventSequence: originalEvent.sequence,
							revision: 1, sequence: originalEvent.sequence + 1, capturedAt: AT,
							validUntil: "2026-11-13T00:01:00.000Z", source: "recording incomplete canonical assessment",
							ownership: "owned", inventories: [], workspace: { state: "unknown", tracked: [], untracked: [], ignored: [] } };
					},
				},
				artifacts: { async inspect(actual) {
					counts.artifacts++;
					assert.deepEqual(actual, originalEvent);
					return null;
				} },
				archive: {
					async withSubjectGuard(_subject, action) {
						counts.guards++;
						return action(async () => { counts.archive++; throw new Error("Completion cannot invoke archive"); });
					},
					async reconcile() { counts.reconciliations++; throw new Error("Unstarted assessment cannot reconcile an archive"); },
				},
				clock: () => "2026-11-13T00:00:01.000Z",
			};
			const input = { repositoryPath: workspacePath, eventId: event.id };
			const context = { invocation: { sessionId: r.owner.sessionId, toolCallId: "canonical-event-notification" } };
			const first = await operations.completionEvent(input, context);
			assert.equal(first.state, "held");
			assert.ok(first.intent);
			assert.deepEqual(first.intent.event, originalEvent);
			assert.equal(first.holds.filter(hold => hold.code === "retention_inventory_missing").length, 10);
			assert.ok(first.holds.some(hold => hold.code === "retention_workspace_unknown"));
			assert.ok(first.holds.some(hold => hold.code === "retention_manifest_missing"));
			assert.equal(first.intent.assessments.length, 1);
			assert.equal(first.intent.start, null);
			assert.deepEqual(first.intent.outcomes, []);
			assert.deepEqual(await operations.completionEvent(input, context), first);
			const restarted = createFoundryOperations({ getSession: () => r.owner, getWorkspacePath: () => workspacePath,
				analysis: analysisStub(), factoryStorageRoot: workspacePath, getNativeRuntime: () => r.runtime,
				getRetention: () => binding, notify: event => notifications.push(event) });
			assert.deepEqual(await restarted.completionEvent(input, context), first);
			assert.deepEqual(canonical.read(first.intent.id), first.intent);
			assert.deepEqual(first.intent.assessments[0].event, originalEvent);
			assert.deepEqual(await restarted.storeFor().read(before.id), before, "Assessment must not complete or alter another running task");
			assert.equal(notifications.length, notificationCount);
			assert.deepEqual(event, originalEvent);
			assert.deepEqual(counts, { completions: 3, captures: 1, artifacts: 1, transactions: 1, inserts: 1, replacements: 0,
				guards: 0, archive: 0, reconciliations: 0 });
			assert.equal(fixture.right.db.prepare("SELECT count(*) AS total FROM supported_completion_outbox").get()?.total, 1);
			assert.equal(r.calls.length, 0);
		}, { getSession: () => r?.owner, getNativeRuntime: () => r.runtime, getRetention: () => binding });
	} finally { fixture.dispose(); }
});

/** Test-only conditional archive counter: no App subjects, native archive or removal.
 * @param {string} root */
function retentionFixture(root) {
	const subject = { attempt: { owner: root, repositoryId: REPOSITORY, planId: "recorded-retention",
		taskId: "T-001", attemptId: "T-001-A001", reservationId: "retained-reservation" },
		child: { sessionId: "retained-child", projectId: "recorded-project", creatorSessionId: "recorded-owner",
			branch: "retained-child", worktreePath: path.join(root, "child") },
		coordinatorSessionId: "recorded-owner", runIds: ["retained-run"] };
	const state = { reasons: /** @type {import("../../native/retention.mjs").Hold[]} */ ([]), active: false, permission: true, writerChanged: false,
		effects: 0, guards: 0, reconciliations: 0 };
	let sequence = 0;
	/** @param {string} intentId @param {import("../../native/retention.mjs").Status} status
	 * @param {import("../../native/retention.mjs").Hold[]} reasons */
	const receipt = (intentId, status, reasons) => ({ source: "recording guarded native disposition",
		raw: { subject, intentId, operation: "archive_session", status, reasons } });
	/** @type {import("../../native/retention.mjs").RetentionHost} */
	const host = {
		source: "recording retention provider",
		context: () => ({ owner: root, sessionId: subject.coordinatorSessionId, projectId: subject.child.projectId,
			repositoryId: REPOSITORY, worktreePath: path.join(root, "coordinator") }),
		checkpoint: async () => ({ epoch: "recorded-host-epoch", sequence: ++sequence }),
		async observe({ after }) {
			return { source: "recorded exhaustive inventory", raw: { subject, after,
				detailSequence: ++sequence, inventorySequence: ++sequence, activity: state.active ? "busy" : "idle",
				workspace: { tracked: [], untracked: [], ignored: [] },
				pages: [{ cursor: null, next: null, sessions: [subject],
					attempts: [{ identity: subject.attempt, taskStatus: "done", attemptStatus: "done" }],
					runs: [{ runId: subject.runIds[0], attempt: subject.attempt, status: "completed" }] }] } };
		},
		decodeObservation: value => value,
		assess: async () => ({ source: "recorded canonical artifacts and eligibility authority",
			raw: { reasons: state.reasons }, reasons: state.reasons }),
		route: () => "supported",
		async conditionalArchive({ intentId, reassess }) {
			state.guards++;
			const current = await reassess();
			if (state.writerChanged) return receipt(intentId, "held", [{ code: "all-writer-change", message: "Another writer changed eligibility" }]);
			if (current.status !== "inspected") return receipt(intentId, "held", current.reasons);
			if (!state.permission) return receipt(intentId, "denied", [{ code: "native-permission-denied", message: "Original permission denied" }]);
			state.effects++;
			throw new Error("No archive effect is permitted in these negative tests");
		},
		decodeArchive: value => value,
		observeOutcome: async () => { state.reconciliations++; return null; },
		decodeReconciliation: value => value,
	};
	return { state, host, native: () => createNativeRetention({ subject, host }) };
}

test("SR08 canonical artifacts, eligibility, all-writer guard, permission and reconciliation all fail closed with zero archive", async () => {
	const fixture = createParallelFixture({ name: "supported-retention-negative" });
	try {
		/** @type {[((f: ReturnType<typeof retentionFixture>) => void), string][]} */
		const cases = [
			[f => { f.state.reasons = [{ code: "retention-artifacts-missing", message: "Canonical source/ref/context/report/evaluator/artifact bytes are not retained" }]; }, "retention-artifacts-missing"],
			[f => { f.state.reasons = [{ code: "consumer-held", message: "Current canonical consumer hold remains" }]; }, "consumer-held"],
			[f => { f.state.active = true; }, "activity-unsettled"],
			[f => { delete f.host.conditionalArchive; }, "unsupported-race-safety"],
			[f => { delete f.host.observeOutcome; }, "unsupported-reconciliation"],
			[f => { delete f.host.decodeReconciliation; }, "unsupported-reconciliation"],
			[f => { f.state.writerChanged = true; }, "all-writer-change"],
			[f => { f.state.permission = false; }, "native-permission-denied"],
		];
		for (const [change, code] of cases) {
			const f = retentionFixture(fixture.workspacePath);
			change(f);
			const result = await f.native().archive({ intentId: "recorded-retention-intent" });
			assert.equal(result.code, code, JSON.stringify(result));
			assert.notEqual(result.status, "archived");
			assert.equal(f.state.effects, 0);
			if (code === "unsupported-reconciliation") {
				assert.equal(result.status, "unsupported");
				assert.equal(f.state.guards, 0, "Missing original-operation reconciliation must hold before invoking any archive guard");
				assert.equal(result.receipt, null);
			}
			if (code === "native-permission-denied") {
				assert.equal(result.status, "denied");
				assert.equal(readRecord(result.receipt?.raw).status, "denied");
			}
			const guards = f.state.guards, original = structuredClone(result.receipt);
			const reconciled = await f.native().reconcile(result);
			assert.equal(reconciled.status, "uncertain");
			assert.equal(reconciled.code, code === "unsupported-reconciliation" ? "unsupported-reconciliation" : "disposition-unresolved");
			assert.deepEqual(reconciled.receipt, original);
			assert.equal(f.state.guards, guards, "Reconciliation may only read the original operation");
			assert.equal(f.state.reconciliations, code === "unsupported-reconciliation" ? 0 : 1);
			assert.equal(f.state.effects, 0);
		}
	} finally { fixture.dispose(); }
});
