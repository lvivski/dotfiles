import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRecoveryOperations } from "../../application/recovery.mjs";
import { createFactoryBridge } from "../../bridge.mjs";
import { parseJson, readRecord, readString } from "../../data.mjs";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { consumerAgreement } from "../../factory/technical.mjs";
import { createOfferedDispatchTransport, DispatchNativeError } from "../../native/admission.mjs";
import { createdChild, dispatchReservation } from "../../native/dispatch.mjs";
import { createNativeHost } from "../../native/host.mjs";
import { bindNativeContext, createNativeAssurance, createNativeInputs } from "../../native/observations.mjs";
import { createNativeTechnicalExecutor } from "../../native/technical.mjs";
import { createFoundryDispatch, createFoundryOperations } from "../../operations.mjs";
import { canonicalBindings } from "../../plan/packages.mjs";
import { createParallelStorage, createPlanStore } from "../../storage.mjs";
import { buildFoundryTools } from "../../tools.mjs";
import { technicalFixture, technicalOwner } from "../application/fixture.mjs";
import { must } from "../assertions.mjs";
import { fixture } from "../bridge/fixture.mjs";
import { git } from "../git.mjs";
import { assertOfferedToolArguments } from "../parallel/native-contracts.mjs";
import { analysisFixture } from "./fixture.mjs";
import { charter, goal, historicalIdentity, operatingFixture } from "../factory/operating.mjs";

/** @typedef {import("../../native/host.mjs").NativeHostAccess} Access */
/** @typedef {import("../../native/observations.mjs").Capture} Capture */
/** @typedef {import("../../types/parallel.js").ParallelReservation} Reservation */
/** @param {unknown} value */
const success = value => ({ resultType: "success", textResultForLlm: JSON.stringify(value) });

test("REL-05 root-created dispatch forwards the exact workflow and supplied decoder without fallback", async t => {
	const f = await setup(t);
	/** @type {{name: string, arguments: import("../../types/json.js").JsonValue, toolCallId?: string}[]} */
	const calls = [];
	/** @type {unknown[]} */
	const decoded = [];
	const transport = createOfferedDispatchTransport({
		owner: f.owner, sessionId: f.context.sessionId, offered: new Set(["run_dynamic_workflow"]),
		availability: () => "supported",
		context: () => ({ owner: f.owner, sessionId: f.context.sessionId, inWorkflow: false }),
		executor: { async execute(input) {
			calls.push(input);
			return success({ nativeRun: "exact-fixture-run" });
		} },
	});
	const host = { ...f.host, decodeRun(/** @type {unknown} */ value) {
		decoded.push(value);
		return readString(readRecord(value).nativeRun);
	} };
	const dispatch = createFoundryDispatch(host, transport);
	const launchSpec = { name: "fixture-workflow", args: { immutable: "input" }, limits: { maxTotalSubagents: 2 } };
	const result = await dispatch.launch(launchSpec, "exact-call");
	assert.equal(dispatch.decodeRun(result.value), "exact-fixture-run");
	assert.deepEqual(decoded, [{ nativeRun: "exact-fixture-run" }]);
	assert.deepEqual(calls, [{ name: "run_dynamic_workflow", arguments: launchSpec, toolCallId: "exact-call" }]);
	const missing = createFoundryDispatch({ ...host, decodeRun: undefined }, transport);
	await assert.rejects(missing.launch(launchSpec), { code: "dispatch_result_unsupported" });
	assert.throws(() => missing.decodeRun(result.value), { code: "dispatch_result_unsupported" });
	assert.throws(() => createFoundryDispatch({ ...host, decodeRun: () => "" }, transport).decodeRun(result.value));
	assert.equal(calls.length, 1, "Missing/invalid decoding cannot trigger another native invocation");
});

test("REL-06 common bridge delegates squads and goals to the existing fenced canonical writer", async t => {
	const f = await operatingFixture(t);
	const options = {
		getWorkspacePath: () => f.owner, factoryStorageRoot: f.storageRoot, analysis: analysisFixture(),
		getOperating: () => ({ rules: f.ports.rules, admission: f.admission, native: f.native }),
	};
	const root = createFoundryOperations(options), canonical = root.factoryFor(f.repo);
	const bridge = createFactoryBridge({ workspace: () => f.owner, storeFor: root.storeFor, notify: () => {},
		storageRoot: f.storageRoot, operating: () => ({ ...options.getOperating(), persistence: root.storeFor().operating }) });
	assert.equal(bridge.operatingFor(f.repo), bridge.factoryFor(f.repo).operating);
	assert.equal(bridge.squadsFor(f.repo), bridge.factoryFor(f.repo).squads);
	assert.equal(bridge.goalsFor(f.repo), bridge.factoryFor(f.repo).goals);
	/** @param {string} id @param {import("../../types/operating.js").OperatingRecord[]} records */
	const batch = (id, records) => canonical.operating.prepare({
		version: 1, id, snapshot: canonical.operating.snapshot().token, source: historicalIdentity, records,
	});
	bridge.squadsFor(f.repo).commit(batch("joined-charter", [charter()]), f.authority());
	const stale = batch("stale-charter", [charter("squad", 2)]);
	bridge.goalsFor(f.repo).commit(batch("joined-goal", [goal("joined-goal")]), f.authority());
	assert.equal(bridge.squadsFor(f.repo).history({ id: "squad", revision: 1 }).binding.state, "unresolved");
	assert.ok(bridge.goalsFor(f.repo).inspect({ id: "joined-goal", revision: 1 }));
	assert.throws(() => canonical.operating.commit(stale, f.authority()), { code: "operating_snapshot_changed" });
	const before = root.storeFor().readCurrent(f.planId);
	f.observation.allowed = false;
	assert.throws(() => canonical.goals.commit(batch("denied-goal", [goal("denied-goal")]), f.authority()), /fixture native denial/);
	assert.deepEqual(root.storeFor().readCurrent(f.planId), before);
	const missing = createFoundryOperations({ ...options, getOperating: undefined });
	assert.throws(() => missing.factoryFor(f.repo).goals.commit(batch("missing-goal", [goal("missing-goal")]), f.authority()),
		{ code: "operating_authority_unavailable" });
	assert.deepEqual(root.storeFor().readCurrent(f.planId), before);
	assert.deepEqual(before.operating?.publications.map(entry => entry.batch.id), ["joined-charter", "joined-goal"]);
});

test("REL-07 root retention requires the real outbox binding and leaves absent observations/guards held", async t => {
	const f = await operatingFixture(t);
	const scope = { repositoryId: f.factory.repository.id, owner: f.owner, coordinatorSessionId: "coordinator", currentSessionId: "retention" };
	const subject = { attempt: { repositoryId: scope.repositoryId, owner: scope.owner, planId: f.planId,
		taskId: "T-001", attemptId: "T-001-A001", reservationId: "fixture-reservation" },
		sessionId: "fixture-worker", coordinatorSessionId: scope.coordinatorSessionId, worktreePath: path.join(f.root, "child") };
	const at = "2026-11-13T00:00:00.000Z";
	const event = { version: 1, id: "joined-completion", subject, revision: 1, sequence: 1,
		sourceCommit: "b".repeat(40), sourceDigest: "c".repeat(64), at, source: "injected source-only completion" };
	/** Injected outbox, not a production binding or archive provider.
	 * @type {Map<string, import("../../types/retention.js").RetentionIntent>} */
	const records = new Map();
	let transactions = 0, reads = 0;
	/** @type {import("../../types/retention.js").RetentionCanonicalPort} */
	const canonical = {
		read(id) { reads++; return structuredClone(records.get(id) ?? null); },
		transaction(actual, action) {
			transactions++;
			assert.deepEqual(actual, event);
			return action({
				assertCurrent(value, _assessment, mode) { assert.deepEqual(value, event); assert.equal(mode, "assess"); },
				read: id => structuredClone(records.get(id) ?? null),
				insert: value => { assert.equal(records.size, 0); records.set(value.id, structuredClone(value)); },
				replace() { throw new Error("No replacement is expected in this binding test"); },
			});
		},
	};
	const bindings = {
		scope, canonical, clock: () => at,
		observations: {
			async completion() { return event; },
			async capture() { return { version: 1, subject, eventId: event.id, eventRevision: 1, eventSequence: 1,
				revision: 1, sequence: 2, capturedAt: at, validUntil: "2026-11-13T00:01:00.000Z",
				source: "injected incomplete capture", ownership: "unknown", inventories: [],
				workspace: { state: "unknown", tracked: [], untracked: [], ignored: [] } }; },
		},
		artifacts: { async inspect() { return null; } },
	};
	const options = { getWorkspacePath: () => f.owner, factoryStorageRoot: f.storageRoot, analysis: analysisFixture() };
	assert.throws(() => createFoundryOperations(options).retentionFor(f.repo), { code: "retention_persistence_unsupported" });
	assert.throws(() => createFoundryOperations({ ...options, getRetention: () => ({ ...bindings, canonical: undefined }) }).retentionFor(f.repo),
		{ code: "retention_persistence_unsupported" });
	assert.throws(() => createFoundryOperations({ ...options, getRetention: () => ({ ...bindings, scope: { ...scope, owner: "/foreign" } }) }).retentionFor(f.repo),
		{ code: "retention_foreign" });
	const service = createFoundryOperations({ ...options, getRetention: () => bindings }).retentionFor(f.repo);
	const assessment = await service.completionEvent({ eventId: event.id });
	assert.equal(assessment.state, "held");
	assert.ok(assessment.holds.some(entry => entry.code === "retention_ownership_unknown"));
	assert.equal(transactions, 1);
	assert.equal(reads, 1);
	assert.equal(records.size, 1);
	assert.ok(assessment.intent);
	const execution = await service.execute({ intentId: assessment.intent.id });
	assert.ok(execution.holds.some(entry => entry.code === "retention_action_time_unsupported"));
	assert.equal(transactions, 1, "Missing guarded host cannot admit an archive effect");
	assert.equal(records.get(assessment.intent.id)?.start, null);
});

/** Production composition and stores; only the App/provider boundary is simulated.
 * @param {import("node:test").TestContext} t
 * @param {{missing?: string, route?: Access["route"]}} [options] */
async function setup(t, options = {}) {
	const f = await fixture(t, { visual: true }), owner = path.join(f.root, "coordinator");
	const context = { workspacePath: owner, sessionId: "coordinator", projectId: "fixture-project",
		repositoryId: f.factory.repository.id, inWorkflow: false };
	const store = createPlanStore({ workspacePath: owner }), planId = "native-join";
	const readPlan = () => store.readCurrent(planId);
	const generation = f.factory.generation(f.candidate.id);
	const bindings = canonicalBindings({
		authority: "accepted-contract", repositoryId: context.repositoryId,
		unit: { id: generation.unit.id, revision: generation.unit.revision },
		contract: { revision: generation.contract.revision, digest: generation.contract.digest },
		requirements: generation.obligations.map(({ id, revision }) => ({ id, revision })),
		evaluators: generation.evaluations.map(({ id, revision, evaluation }) => ({
			id, revision, procedureDigest: evaluation.procedure.digest, requirements: evaluation.obligations,
			independent: evaluation.independent, modality: evaluation.modality,
		})),
		visualEvaluation: generation.unit.visualEvaluation ?? null,
	});
	/** @type {import("../../types/parallel.js").PackageDecomposition} */
	const decomposition = { format: "foundry-packages-v1", bindings, target: "product", packages: [
		{ id: "producer", title: "Exact module", expectedFiles: ["implementation.mjs"], inputs: [],
			outputs: [{ id: "module", path: "implementation.mjs" }], requirements: [], evaluators: [] },
		{ id: "product", title: "Consume module", expectedFiles: ["product.json"],
			inputs: [{ producer: "producer", output: "module", destination: "inputs/module.mjs" }],
			outputs: [{ id: "product", path: "product.json" }], requirements: bindings.requirements,
			evaluators: bindings.evaluators.map(({ id, revision }) => ({ id, revision })) },
	] };
	await f.ops.createFactoryPlan({ id: planId, expectedRevision: 0, expectedFactoryRevision: f.factory.snapshot().revision,
		candidateId: f.candidate.id, repository: { workingDirectory: f.repo, baseBranch: "main" }, decomposition });
	const storage = createParallelStorage({ workspacePath: path.join(f.repo, ".git"), directoryParts: ["foundry", "parallel"],
		repositoryId: context.repositoryId, owner });
	const bridge = createFactoryBridge({ workspace: () => owner, storeFor: () => store, storageRoot: f.storageRoot, notify: () => {} });
	/** @type {Map<string, import("../../types/parallel.js").ParallelChild>} */
	const children = new Map();
	/** @type {{name: string, args: unknown, correlation: string}[]} */
	const calls = [];
	const control = {
		/** @type {unknown} */ handoffFailure: null,
		incomplete: false, drift: false, contributorsComplete: true, sessionStatus: "idle",
		/** @type {((reservation: Reservation) => Promise<void>) | null} */ beforeHandoff: null,
	};
	/** @param {string} taskId */
	function reservation(taskId) {
		const attempt = must(readPlan().tasks.find(task => task.id === taskId)?.attempts.at(-1));
		const record = must(storage.admission.list().find(entry => entry.attempt?.attemptId === attempt.id));
		return dispatchReservation(readRecord(storage.journal.payload(must(record.attempt), "creation")).reservation);
	}
	/** @param {unknown} input @param {unknown} value @returns {Capture} */
	const capture = (input, value) => ({ context: structuredClone(context), subjectDigest: analysisInputDigest(input),
		capturedAt: new Date().toISOString(), source: "fixture:correlated-provider-not-live-native-evidence", complete: !control.incomplete, value });
	/** @type {import("../../operations.mjs").FoundryOperations} */
	let operations;
	/** @param {string} name @param {unknown} args @param {string} correlation */
	async function invoke(name, args, correlation) {
		assertOfferedToolArguments(name, args);
		calls.push({ name, args: structuredClone(args), correlation });
		const input = readRecord(args);
		if (["create_session", "foundry_attach_task", "send_session_message"].includes(name)) {
			const record = must(storage.admission.list().find(entry => entry.receipts.some(receipt => receipt.id === correlation)));
			assert.equal(record.phase, "reserved");
			assert.equal(must(storage.journal.read(must(record.attempt)).find(receipt => receipt.id === correlation)).state, "in-flight");
		}
		if (name.startsWith("foundry_")) {
			const tool = must(buildFoundryTools(operations).find(tool => tool.name === name));
			return tool.handler(args, { sessionId: context.sessionId, toolCallId: correlation, toolName: name, arguments: args });
		}
		if (name === "create_session") {
			const sessionId = `child-${children.size + 1}`, branch = `native-${sessionId}`, worktreePath = path.join(f.root, sessionId);
			git(f.repo, "worktree", "add", "--quiet", "-b", branch, worktreePath, readString(input.base_branch));
			const child = { sessionId, branch, worktreePath, projectId: context.projectId, creatorSessionId: context.sessionId };
			children.set(sessionId, child);
			if (control.drift) context.projectId = "foreign-project";
			return success(child);
		}
		if (name === "get_session") return success(must(children.get(readString(input.project_session_id))));
		if (name === "list_sessions_and_chats") return success([...children.values()]);
		if (name === "send_session_message") {
			const task = must(readPlan().tasks.find(task => task.attempts.at(-1)?.sessionId === input.session_id));
			const pinned = reservation(task.id);
			assert.equal(input.message, pinned.delegationPrompt);
			await control.beforeHandoff?.(pinned);
			if (control.handoffFailure instanceof Error) throw control.handoffFailure;
			if (control.handoffFailure !== null) return control.handoffFailure;
			return success({ sessionId: input.session_id, accepted: true });
		}
		throw new Error(`Unexpected operation ${name}`);
	}
	/** @type {Access} */
	const access = {
		current: () => context, readPlan, route: options.route ?? "primary-app",
		taskPolicies: plan => Object.fromEntries(plan.tasks.map(task => [task.id, {
			resources: task.expectedFiles.map((scope, index) => ({ id: `${task.id.toLowerCase()}-${index}`,
				kind: "shared-write", scope, mode: "exclusive", capacity: 1, units: 1 })), team: null, dependencies: [],
		}])),
		primary: {
			foundry_get_status: (args, id) => invoke("foundry_get_status", args, id),
			foundry_reserve_task: (args, id) => invoke("foundry_reserve_task", args, id),
			foundry_attach_task: (args, id) => invoke("foundry_attach_task", args, id),
			foundry_complete_task: (args, id) => invoke("foundry_complete_task", args, id),
			create_session: (args, id) => invoke("create_session", args, id),
			get_session: (args, id) => invoke("get_session", args, id),
			list_sessions_and_chats: (args, id) => invoke("list_sessions_and_chats", args, id),
			send_session_message: (args, id) => invoke("send_session_message", args, id),
		},
		decodeCreated: createdChild,
		decodeHandoff: value => ({ sessionId: readString(readRecord(value).sessionId), accepted: readRecord(value).accepted === true }),
		observations: {
			setup: async input => capture(input, { sessionId: input.child.sessionId, message: input.reservation.initialization.acknowledgement,
				at: new Date().toISOString(), source: "fixture:setup-turn-not-idle" }),
			child: async input => {
				const task = must(readPlan().tasks.find(task => task.attempts.at(-1)?.status === "reserved"));
				const pinned = reservation(task.id);
				return capture(input, { child: input.child, aliases: [input.child.sessionId], baseBranch: pinned.baseBranch,
					baseCommit: pinned.baseCommit, head: git(input.child.worktreePath, "rev-parse", "HEAD"),
					clean: git(input.child.worktreePath, "status", "--porcelain", "--untracked-files=all") === "",
					coordinatingCreatorSessionId: context.sessionId });
			},
			reconcile: async input => capture(input, null),
			recovery: async input => {
				const record = must(storage.admission.read(input.identity)), attempt = must(record.attempt);
				const sessionId = must(readPlan().tasks.find(task => task.id === attempt.taskId)?.attempts.at(-1)?.sessionId);
				const result = capture(input, null);
				result.value = { complete: !control.incomplete, capturedAt: result.capturedAt, source: result.source,
					sessions: [{ id: sessionId, status: control.sessionStatus, attempt }], runs: [] };
				return result;
			},
			outcomes: async input => capture(input, []),
			reviews: async input => capture(input, ["implementation", "architecture", "security", "visual"].map(kind => ({
				kind, required: kind !== "security", reason: "Exact synthetic UI applicability", reviewers: kind === "security" ? [] : ["independent-fixture-reviewer"],
			}))),
			contributors: async input => ({ ...capture(input, {
				commit: must(input.plan.tasks.find(task => task.id === input.taskId)?.attempts.at(-1)?.commit),
				authors: [...children.keys(), "runtime-helper"],
			}), complete: control.contributorsComplete }),
		},
	};
	if (options.missing) {
		Reflect.deleteProperty(access, options.missing);
		Reflect.deleteProperty(must(access.observations), options.missing);
		Reflect.deleteProperty(must(access.primary), options.missing);
	}
	const host = createNativeHost(access);
	operations = createFoundryOperations({ getWorkspacePath: () => owner, getSession: () => context,
		getParallelHost: () => host, factoryStorageRoot: f.storageRoot, analysis: analysisFixture() });
	await f.approve(operations, readPlan());
	const invocation = { invocation: { sessionId: context.sessionId, toolCallId: "fixture-join-invocation" } };
	const dispatch = () => operations.dispatchReady({ planId, limit: 1 }, invocation);
	/** @param {string} taskId @param {string} [commit] */
	const complete = (taskId, commit = f.commit) => operations.completeTask(f.payload(readPlan(), taskId, { commit }), invocation);
	const inputs = () => must(bridge.packageInputs(readPlan(), storage));
	return { ...f, owner, context, readPlan, operations, storage, bridge, host, children, calls, control,
		reservation, dispatch, complete, inputs, decomposition, invocation };
}

test("NB-JOIN-02/03: delivered host composes canonical admission, exact handoff, Git inputs and independent UI assurance", async t => {
	const f = await setup(t);
	await f.dispatch();
	await Promise.all([f.dispatch(), f.dispatch()]);
	assert.equal(f.children.size, 1);
	assert.equal(f.calls.filter(call => call.name === "send_session_message").length, 1);
	await f.complete("T-001");
	assert.equal(f.storage.admission.list()[0].phase, "released");
	f.control.beforeHandoff = async pinned => {
		if (pinned.attempt.taskId !== "T-002") return;
		assert.equal(f.inputs().entry(must(pinned.inputs)), null);
		assert.equal(existsSync(path.join(must(f.children.get("child-2")).worktreePath, "inputs/module.mjs")), false);
	};
	await f.dispatch();
	const pinned = f.reservation("T-002"), descriptor = must(pinned.inputs), packages = f.inputs();
	const entry = must(packages.entry(descriptor)), child = must(f.children.get(entry.sessionId));
	const nativeInputs = createNativeInputs({ check: bindNativeContext(() => f.context), inputs: packages.inputs, entry: packages.entry });
	assert.deepEqual(nativeInputs.resolve(pinned.attempt, descriptor.bootstrap, pinned.requiredInputs), descriptor);
	await assert.rejects(nativeInputs.materialize(descriptor, { ...entry, handoffReceiptId: "imported-success" }), { code: "parallel_consumer_held" });
	const artifacts = await nativeInputs.materialize(descriptor, entry);
	assert.deepEqual(artifacts, descriptor.inputs.map(input => input.artifact));
	const bytes = readFileSync(path.join(child.worktreePath, "inputs/module.mjs"));
	assert.equal(createHash("sha256").update(bytes).digest("hex"), artifacts[0].digest);
	assert.equal(artifacts[0].commit, f.commit);
	writeFileSync(path.join(child.worktreePath, "product.json"), JSON.stringify({ consumed: artifacts }));
	unlinkSync(path.join(child.worktreePath, "inputs/module.mjs"));
	git(child.worktreePath, "add", "product.json");
	git(child.worktreePath, "commit", "--quiet", "-m", "Consume pinned module");
	const commit = git(child.worktreePath, "rev-parse", "HEAD");
	await f.complete("T-002", commit);
	const definitions = f.factory.generation(f.candidate.id).evaluations;
	const assurance = createNativeAssurance({
		check: bindNativeContext(() => f.context), observations: f.host,
		readSubject: () => ({ plan: f.readPlan(), taskId: "T-002", repository: f.repo,
			input: { governing: f.decomposition.bindings, decomposition: f.decomposition, packageId: "product",
				inputs: descriptor, delivery: must(f.inputs().delivery("T-002")), producer: child.sessionId, definitions } }),
	});
	const subject = await assurance.prepare(), visual = { ...f.visualResult(), deliveryCommit: commit };
	const evaluator = definitions[0];
	const report = {
		format: "foundry-package-assurance-v1", subjectDigest: subject.digest, observedAt: new Date().toISOString(),
		evaluations: [{ evaluation: { id: evaluator.id, revision: evaluator.revision }, procedureDigest: evaluator.evaluation.procedure.digest,
			environment: evaluator.evaluation.environment, workload: evaluator.evaluation.workload, outcome: "passed", report: JSON.stringify(visual),
			reviewer: "independent-fixture-reviewer", independenceReason: "Fixture reviewer distinct from all native/runtime contributors" }],
		reviews: subject.reviews.filter(review => review.required).map(review => ({ kind: review.kind, author: child.sessionId,
			reviewer: "independent-fixture-reviewer", commit, scope: subject.requirements, outcome: "passed",
			findings: [{ requirement: subject.requirements[0], observation: "Exact materialized module and synthetic native/reference comparison",
				evidence: `fixture:git:${commit}:product.json` }] })),
	};
	assert.equal((await assurance.assess(report)).passed, true);
	assert.deepEqual(subject.authors, ["child-1", "child-2", "runtime-helper"]);
	const unchanged = stableStringify(f.readPlan()), nativeCalls = f.calls.length;
	for (const scenario of ["missing", "failed", "stale", "mismatched", "contributors"]) {
		const changed = structuredClone(report), capture = readRecord(parseJson(changed.evaluations[0].report));
		const states = capture.states;
		assert.ok(Array.isArray(states));
		const state = readRecord(states[0]);
		if (scenario === "missing") state.capture = null;
		if (scenario === "failed") readRecord(readRecord(state.assessment).composition).outcome = "failed";
		if (scenario === "stale") readRecord(state.capture).capturedAt = "2020-01-01T00:00:00.000Z";
		if (scenario === "mismatched") capture.deliveryCommit = "f".repeat(40);
		f.control.contributorsComplete = scenario !== "contributors";
		changed.evaluations[0].report = JSON.stringify(capture);
		await assert.rejects(assurance.assess(changed), scenario);
		assert.equal(stableStringify(f.readPlan()), unchanged);
		assert.equal(f.calls.length, nativeCalls);
	}
	assert.equal(f.readPlan().tasks.at(-1)?.status, "planned", "Source assurance does not complete the independent verifier");
	t.diagnostic(JSON.stringify({ kind: "joined-source-protocol", actualNative: false, calls: f.calls, descriptor, entry,
		artifacts, commit, subject, report, admissions: f.storage.admission.list() }));
});

for (const missing of ["decodeCreated", "decodeHandoff", "setup", "child", "create_session", "send_session_message", "extension-rpc"]) {
	test(`NB-JOIN-03: composed dispatch holds missing ${missing} before reservation or creation`, async t => {
		const f = await setup(t, missing === "extension-rpc" ? { route: missing } : { missing });
		const result = await f.dispatch();
		assert.equal(readRecord(result).state, "held");
		assert.equal(f.calls.length, 0);
		assert.equal(f.storage.admission.list().length, 0);
		assert.ok(f.readPlan().tasks.every(task => task.attempts.length === 0));
	});
}

for (const scenario of ["denied", "uncertain", "native-error", "owner-drift", "incomplete"]) {
	test(`NB-JOIN-03: composed ${scenario} retains original journal and never replays or falls back`, async t => {
		const f = await setup(t), original = new DispatchNativeError("provider-denied", "Original provider error", "definitive-failure", { fixture: true });
		if (scenario === "denied") f.control.handoffFailure = { resultType: "denied", textResultForLlm: "Fixture permission denied" };
		if (scenario === "uncertain") f.control.handoffFailure = new Error("Fixture lost admission response");
		if (scenario === "native-error") f.control.handoffFailure = original;
		f.control.drift = scenario === "owner-drift";
		f.control.incomplete = scenario === "incomplete";
		await f.dispatch();
		const before = f.calls.filter(call => ["create_session", "send_session_message"].includes(call.name));
		await f.dispatch();
		assert.deepEqual(f.calls.filter(call => ["create_session", "send_session_message"].includes(call.name)), before);
		assert.equal(f.children.size, 1);
		const record = must(f.storage.admission.list()[0]);
		assert.equal(record.phase, "reserved", "A failed/unknown effect cannot release the only claim");
		assert.deepEqual(record.receipts, f.storage.journal.read(must(record.attempt)));
		const last = must(record.receipts.at(-1));
		if (["denied", "native-error"].includes(scenario)) assert.equal(last.state, "definitive-failure");
		if (["uncertain", "owner-drift"].includes(scenario)) assert.equal(last.state, "uncertain");
		if (scenario === "incomplete") {
			assert.equal(last.kind, "creation");
			assert.ok(!f.calls.some(call => call.name === "foundry_attach_task"));
		}
		if (scenario === "native-error") {
			const outcome = readRecord(f.storage.journal.outcomes(must(record.attempt), last.id).at(-1));
			assert.equal(readRecord(outcome.error).code, original.code);
			assert.deepEqual(outcome.raw, original.receipt);
		}
		t.diagnostic(JSON.stringify({ kind: "joined-held-effect", actualNative: false, scenario, record, calls: f.calls }));
	});
}

test("NB-JOIN-02/07: native recovery observations retain idle and incomplete holds in canonical storage", async t => {
	const f = await setup(t);
	await f.dispatch();
	const record = must(f.storage.admission.list()[0]), observe = must(f.host.observeRecovery);
	const recovery = createRecoveryOperations({ ...f.storage, observations: f.storage.admission,
		repositoryId: f.context.repositoryId, owner: f.owner, observe });
	recovery.cancel(record.identity);
	const before = f.calls.length;
	assert.equal((await recovery.reconcile(record.identity)).state, "held");
	f.control.incomplete = true;
	await assert.rejects(recovery.reconcile(record.identity), { code: "dispatch_observation_incomplete" });
	assert.equal(must(f.storage.admission.read(record.identity)).phase, "cancelling");
	assert.equal(f.calls.length, before, "No termination, archive, fallback or native replay is performed");
	t.diagnostic(JSON.stringify({ kind: "joined-recovery-hold", actualNative: false, admission: f.storage.admission.read(record.identity) }));
});

test("NB-JOIN-02/05: canonical technical authority composes the delivered executor without turning fixture permission into a grant", async t => {
	const f = await technicalFixture(t), bytes = Buffer.from(must(f.before.files.find(file => file.path === "technical/agreement.json")).content, "base64");
	const input = { repositoryPath: f.repositoryPath, before: f.before.bundle, after: f.after.bundle, agreement: consumerAgreement(parseJson(bytes.toString())) };
	const binding = { owner: f.workspacePath, sessionId: technicalOwner.sessionId, projectId: "fixture-project", repositoryPath: f.repositoryPath };
	const workload = { input, beforeDigest: f.before.digest, afterDigest: f.after.digest, agreementPath: "technical/agreement.json",
		agreementDigest: createHash("sha256").update(bytes).digest("hex"), environment: f.definition.environment };
	const current = () => ({ ...binding, ...technicalOwner, agentId: null, inWorkflow: false });
	/** @type {string[]} */
	const calls = [];
	let permitted = false;
	const execute = createNativeTechnicalExecutor({ binding, workload, current, fixture: {
		route: "fixture-process",
		async authorize(request) {
			calls.push("permission");
			return { requestId: request.id, requestDigest: analysisInputDigest(request), status: permitted ? "granted" : "denied", source: "fixture:permission" };
		},
		async execute(request, permissionSource, signal) {
			calls.push("execution");
			const execution = await f.executor(request.workload.input, signal);
			return { requestId: request.id, requestDigest: analysisInputDigest(request), status: "completed", source: execution.source, permissionSource, execution };
		},
	} });
	const operations = f.reopen({ executeTechnical: execute });
	await assert.rejects(operations.factoryAction(await f.request(operations), { invocation: technicalOwner }), { code: "delegation_unavailable" });
	assert.deepEqual(calls, []);
	await f.grant(operations);
	const snapshot = f.factory.snapshot(), plan = await operations.getPlan({ planId: f.plan.id });
	await assert.rejects(operations.factoryAction(await f.request(operations), { invocation: technicalOwner }), { code: "technical_permission_rejected" });
	assert.deepEqual(f.factory.snapshot(), snapshot);
	assert.deepEqual(await operations.getPlan({ planId: f.plan.id }), plan);
	assert.equal(f.executions.length, 0);
	const unavailable = f.reopen({ executeTechnical: createNativeTechnicalExecutor({ binding, workload, current }) });
	await assert.rejects(unavailable.factoryAction(await f.request(unavailable), { invocation: technicalOwner }), { code: "technical_execution_unavailable" });
	assert.deepEqual(f.factory.snapshot(), snapshot);
	permitted = true;
	await operations.factoryAction(await f.request(operations), { invocation: technicalOwner });
	assert.deepEqual(calls, ["permission", "permission", "execution"]);
	assert.deepEqual(f.executions.map(run => run.exitCode), [1, 0]);
	const decision = must((await operations.getPlan({ planId: f.plan.id })).technicalDecisions?.[0]);
	assert.deepEqual(decision.oldScope, decision.newScope);
	assert.deepEqual(decision.renewal?.execution.before, decision.renewal?.execution.after);
	assert.equal(f.ui.calls, 0);
	t.diagnostic(JSON.stringify({ kind: "joined-technical-fixture", actualNative: false, binding, workload, decision, executions: f.executions }));
});
