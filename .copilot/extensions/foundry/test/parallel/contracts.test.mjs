import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createDispatchOperations } from "../../application/dispatch.mjs";
import { createRecoveryOperations } from "../../application/recovery.mjs";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { isRecord, parseJson, readJsonValue } from "../../data.mjs";
import { createNativeAdmission, createOfferedDispatchTransport } from "../../native/admission.mjs";
import { createNativeDispatch, dispatchReservation } from "../../native/dispatch.mjs";
import { projectAdmission } from "../../plan/admission.mjs";
import { attachTaskAttempt, reserveTaskAttempt } from "../../plan/execution.mjs";
import { approvePlan, transitionPlan } from "../../plan/lifecycle.mjs";
import { buildDelegationPrompt, buildTaskInitialization } from "../../plan/prompt.mjs";
import { hasSuccessfulDelivery } from "../../plan/queries.mjs";
import {
	admissionRecord, artifactIdentity, assertConservedBindings, assertInputCoverage, attemptIdentity, cancellationObligation,
	consumerEntry, dependencyObservation, effectReceipt, governingBindings, packageDecomposition,
	parallelHistory, reservedInputs, resourceClaim,
} from "../../plan/parallel-contracts.mjs";
import { validatePlan } from "../../plan/validation.mjs";
import { createParallelStorage, createPlanStore } from "../../storage.mjs";
import { admissionFence } from "../../storage/admission.mjs";
import { assertAdmissionFence, assertEffectTransition, synchronousTransition } from "../../storage/parallel-protocol.mjs";
import { COMMIT, DIGEST } from "../git.mjs";
import { draft, task } from "../plan/fixture.mjs";
import { deferred } from "../promises.mjs";
import { createParallelFixture } from "./fixture.mjs";
import { assertOfferedToolArguments, offeredSchema } from "./native-contracts.mjs";
import { generateWorkload, runWorkload } from "./workload.mjs";

const REPOSITORY = "a".repeat(64);
const owner = "fixture-coordinator";
const at = "2026-11-13T05:00:00.000Z";
/** @param {string} taskId @returns {import("../../types/parallel.js").AttemptIdentity} */
const attempt = (taskId) => ({ repositoryId: REPOSITORY, owner, planId: "parallel-fixture", taskId, reservationId: `reserve-${taskId}`, attemptId: `${taskId}-A001` });
/** @returns {import("../../types/parallel.js").GoverningBindings} */
const bindings = () => ({
	authority: "accepted-contract", repositoryId: REPOSITORY, unit: { id: "fixture-unit", revision: 1 },
	contract: { revision: 1, digest: DIGEST }, requirements: [{ id: "preservation", revision: 1 }],
	evaluators: [{ id: "oracle", revision: 1, procedureDigest: DIGEST, requirements: [{ id: "preservation", revision: 1 }], independent: true, modality: "boundary" }],
	visualEvaluation: { id: "oracle", revision: 1 },
});
/** @returns {import("../../types/parallel.js").ReservedInputs} */
function descriptor() {
	const artifact = (/** @type {string} */ name) => ({ repositoryId: REPOSITORY, commit: COMMIT, path: name, mode: /** @type {const} */ ("100644"), digest: DIGEST });
	const body = {
		format: /** @type {const} */ ("foundry-reserved-inputs-v1"),
		consumer: attempt("T-003"), bootstrap: { repositoryId: REPOSITORY, branch: "bootstrap", commit: COMMIT },
		deliveries: [
			{ packageId: "alpha", attempt: attempt("T-001"), commit: COMMIT, outputs: [{ id: "value", artifact: artifact("alpha.json") }] },
			{ packageId: "beta", attempt: attempt("T-002"), commit: COMMIT, outputs: [{ id: "value", artifact: artifact("beta.json") }] },
		],
		inputs: [
			{ producer: "alpha", output: "value", destination: "inputs/alpha.json", artifact: artifact("alpha.json") },
			{ producer: "beta", output: "value", destination: "inputs/beta.json", artifact: artifact("beta.json") },
		],
	};
	return { ...body, digest: analysisInputDigest(body) };
}
/** @returns {import("../../types/parallel.js").EffectReceipt} */
const receipt = () => ({ id: "create-once", attempt: attempt("T-003"), kind: "creation", epoch: 0,
	payloadDigest: DIGEST, state: "intent", sessionId: null, runId: null, source: "fixture-native-correlation", at });
/** @returns {import("../../types/parallel.js").AdmissionRecord} */
function admission() {
	const { attemptId, ...identity } = attempt("T-003");
	return { format: "foundry-admission-v1", identity, revision: 2, epoch: 0, phase: "reserved",
		attempt: attempt("T-003"), resources: [{ id: "native-input", kind: "foreground-input", scope: "fixture-host", mode: "exclusive", capacity: 1, units: 1 }],
		team: { id: "fixture-team", capacity: 2, units: 1 }, obligations: [], receipts: [], delivery: null, reservationFailure: null };
}

/** @param {import("node:test").TestContext} t @param {string[]} [directoryParts] */
function storageFixture(t, directoryParts) {
	const fixture = createParallelFixture({ name: "production-storage", directoryParts: directoryParts ?? ["files", "foundry-admission"] });
	t.after(fixture.dispose);
	return {
		fixture,
		/** @param {string} [boundOwner] */
		open: (boundOwner = owner) => createParallelStorage({
			workspacePath: fixture.workspacePath, repositoryId: REPOSITORY, owner: boundOwner,
			directoryParts, clock: () => at, busyTimeoutMs: 1,
		}),
	};
}

/** @param {ReturnType<typeof createParallelStorage>["admission"]} store
 * @param {import("../../types/parallel.js").AttemptIdentity} value
 * @param {import("../../types/parallel.js").ResourceClaim[]} [resources] */
function reserve(store, value, resources = admission().resources) {
	const { attemptId, ...identity } = value;
	const held = store.claim({ identity, expectedRevision: 0, resources, team: admission().team });
	return store.bindReservation(admissionFence(held), value);
}

test("package references conserve immutable requirement/evaluator revisions without accepting discovery", () => {
	const source = bindings();
	assert.deepEqual(governingBindings(source), source);
	assertConservedBindings(structuredClone(source), source);
	const substituted = structuredClone(source);
	substituted.evaluators[0].procedureDigest = "f".repeat(64);
	assert.throws(() => assertConservedBindings(substituted, source), { code: "parallel_binding_mismatch" });
	assert.throws(() => governingBindings({ ...source, authority: "discovery-only" }), { code: "parallel_authority_mismatch" });
	assert.equal(governingBindings({ ...source, authority: "discovery-only", contract: null }).contract, null);
	assert.throws(() => governingBindings({ ...source, evaluators: [] }), { code: "parallel_binding_coverage" });
	assert.throws(() => governingBindings({ ...source, visualEvaluation: { id: "oracle", revision: 2 } }), { code: "parallel_visual_binding" });
	const input = { format: "foundry-packages-v1", bindings: source, target: "product",
		packages: [{ id: "product", title: "Product", expectedFiles: ["src/product.mjs"], inputs: [], outputs: [{ id: "product", path: "src/product.mjs" }],
			requirements: source.requirements, evaluators: [{ id: "oracle", revision: 1 }] }] };
	assert.equal(packageDecomposition(input).packages.length, 1);
	assert.throws(() => packageDecomposition({ ...input, packages: [] }));
	assert.throws(() => packageDecomposition({ ...input, packages: [{ ...input.packages[0], requirements: [{ id: "preservation", revision: 2 }] }] }), { code: "parallel_binding_mismatch" });
	assert.throws(() => packageDecomposition({ ...input, accepted: true }));
});

test("complete multi-predecessor input descriptor rejects omission, substitution and pre-handoff materialization binding", () => {
	const value = descriptor();
	const required = value.inputs.map(({ producer, output, destination }) => ({ producer, output, destination }));
	assert.deepEqual(reservedInputs(value), value);
	assertInputCoverage(value, required);
	const missing = descriptor();
	missing.inputs.pop(); missing.deliveries.pop();
	const { digest: ignored, ...remaining } = missing;
	missing.digest = analysisInputDigest(remaining);
	assert.throws(() => assertInputCoverage(reservedInputs(missing), required), { code: "parallel_input_coverage" });
	const changed = descriptor();
	changed.inputs[0].artifact.digest = "f".repeat(64);
	assert.throws(() => reservedInputs(changed), { code: "parallel_input_substitution" });
	assert.throws(() => reservedInputs({ ...value, bootstrap: { ...value.bootstrap, commit: "f".repeat(40) } }), { code: "parallel_input_digest" });
	const entry = { attempt: value.consumer, sessionId: "real-attached-fixture", worktreePath: "/fixture/worktree",
		attachedRevision: 5, handoffReceiptId: "handoff-succeeded", inputDigest: value.digest };
	assert.equal(consumerEntry(entry, value).inputDigest, value.digest);
	assert.throws(() => consumerEntry({ ...entry, handoffReceiptId: "" }, value));
	assert.throws(() => consumerEntry({ ...entry, attachedRevision: 0 }, value));
	assert.throws(() => consumerEntry({ ...entry, attempt: attempt("T-001") }, value), { code: "parallel_consumer_mismatch" });
});

test("artifact and attempt identities are closed and repository/commit/path/mode scoped", () => {
	const item = descriptor().inputs[0].artifact;
	for (const change of [{ commit: "main" }, { path: "../outside" }, { mode: "120000" }, { digest: "wrong" }, { grant: "imported" }]) {
		assert.throws(() => artifactIdentity({ ...item, ...change }));
	}
	assert.throws(() => attemptIdentity({ ...attempt("T-001"), attemptId: "T-002-A001" }), { code: "parallel_identity_mismatch" });
	const foreign = descriptor();
	foreign.deliveries[0].attempt.owner = "other-coordinator";
	assert.throws(() => reservedInputs(foreign), { code: "parallel_identity_mismatch" });
});

test("observations and imported historical receipts cannot become active grants or foreign ownership", () => {
	const observation = { authority: "observation-only", repositoryId: REPOSITORY, owner: "foreign-owner", planId: "foreign-plan", taskId: "T-001",
		revision: 7, source: "complete inventory snapshot", capturedAt: at, validUntil: "2026-11-13T06:00:00.000Z", complete: true, status: "available", commit: COMMIT };
	const history = { format: "foundry-parallel-history-v1", authority: "history-only",
		admissions: [admission()], observations: [dependencyObservation(observation)] };
	assert.deepEqual(parallelHistory(parseJson(stableStringify(parallelHistory(history)))), history);
	assert.throws(() => parallelHistory({ ...history, authority: "active" }), { code: "parallel_history_authority" });
	assert.throws(() => parallelHistory({ ...history, grants: [{ approved: true }] }));
	assert.throws(() => dependencyObservation({ ...observation, authority: "execution" }), { code: "parallel_observation_authority" });
	assert.throws(() => dependencyObservation({ ...observation, completeTask: true }));
	const current = admission();
	assert.throws(() => assertAdmissionFence(current, { admission: { ...current.identity, owner: "foreign-owner" }, revision: current.revision, epoch: 0 }), { code: "parallel_foreign_owner" });
});

test("explicit resource capacity, revision and cancellation fences gate new effects", () => {
	const current = admission(), fence = { admission: current.identity, revision: current.revision, epoch: current.epoch };
	assertAdmissionFence(current, fence);
	assert.throws(() => assertAdmissionFence(current, { ...fence, revision: 1 }), { code: "revision_conflict" });
	assert.throws(() => assertAdmissionFence({ ...current, epoch: 1, phase: "cancelling" }, fence), { code: "revision_conflict" });
	assert.throws(() => assertAdmissionFence({ ...current, epoch: 1, phase: "cancelling" }, { ...fence, epoch: 1 }), { code: "parallel_fenced" });
	assertAdmissionFence({ ...current, epoch: 1, phase: "cancelling" }, { ...fence, epoch: 1 }, { settlement: true });
	assert.throws(() => resourceClaim({ ...current.resources[0], mode: "shared", capacity: 2 }), { code: "parallel_resource_exclusion" });
	assert.throws(() => resourceClaim({ ...current.resources[0], units: 0 }));
	assert.throws(() => synchronousTransition(() => Promise.resolve("native effect")), { code: "parallel_async_transaction" });
});

test("native receipt transitions are idempotent and preserve uncertainty and returned identities", () => {
	const intent = receipt(), started = { ...intent, state: /** @type {const} */ ("in-flight") };
	const uncertain = { ...started, state: /** @type {const} */ ("uncertain") };
	const completed = { ...started, state: /** @type {const} */ ("succeeded"), sessionId: "native-child" };
	assertEffectTransition(intent, started);
	assertEffectTransition(started, uncertain);
	assertEffectTransition(uncertain, completed);
	assertEffectTransition(completed, structuredClone(completed));
	assert.throws(() => effectReceipt({ ...completed, sessionId: null }), { code: "parallel_receipt_identity" });
	assert.throws(() => assertEffectTransition(intent, completed), { code: "parallel_effect_transition" });
	assert.throws(() => assertEffectTransition(completed, started), { code: "parallel_effect_transition" });
	assert.throws(() => assertEffectTransition(started, { ...completed, payloadDigest: "f".repeat(64) }), { code: "parallel_receipt_identity" });
});

test("cancellation settlement cannot release uncertain effects or omit native children/runs", () => {
	const current = admission();
	const obligation = { attempt: attempt("T-003"), sessionId: "native-child", runIds: ["owned-run"], pendingEffectIds: [],
		disposition: "session-terminated", inventory: { complete: true, capturedAt: at, source: "fixture authoritative terminal inventory" }, terminatedRunIds: ["owned-run"] };
	const parsed = cancellationObligation(obligation);
	assert.throws(() => cancellationObligation({ ...obligation, pendingEffectIds: ["uncertain-create"] }), { code: "parallel_unsafe_release" });
	assert.throws(() => cancellationObligation({ ...obligation, terminatedRunIds: [] }), { code: "parallel_unsafe_release" });
	assert.throws(() => cancellationObligation({ ...obligation, inventory: { ...obligation.inventory, complete: false } }), { code: "parallel_unsafe_release" });
	const settled = { ...current, epoch: 1, phase: "settled", obligations: [parsed], receipts: [{ ...receipt(), state: "succeeded", sessionId: "native-child" }] };
	assert.equal(admissionRecord(settled).phase, "settled");
	assert.throws(() => admissionRecord({ ...settled, receipts: [{ ...receipt(), state: "uncertain" }] }), { code: "parallel_unsafe_release" });
	assert.throws(() => admissionRecord({ ...settled, receipts: [{ ...receipt(), state: "succeeded", sessionId: "another-child" }] }), { code: "parallel_unsafe_release" });
	const done = { ...current, phase: "settled", delivery: { attempt: attempt("T-003"), sessionId: "native-child", commit: COMMIT, planRevision: 8, source: "complete_task durable receipt", terminalRunIds: [] } };
	assert.equal(admissionRecord(done).delivery?.commit, COMMIT);
	assert.throws(() => admissionRecord({ ...done, epoch: 1 }), { code: "parallel_unsafe_release" });
	assert.throws(() => admissionRecord({ ...current, attempt: null, phase: "released" }), { code: "parallel_unsafe_release" });
	assert.equal(admissionRecord({ ...current, attempt: null, phase: "released", reservationFailure: { source: "definitive no-reservation receipt", at } }).phase, "released");
});

test("legacy plan validation retains original serialized shape and digest without implicit parallel fields", () => {
	const original = draft();
	const before = stableStringify(original), digest = analysisInputDigest(original);
	assert.equal(digest, "486cecba2841b1453b7020ce1e2ba8696044ab65a36b8d576370e8f8f993f1e3", "Frozen legacy fixture digest");
	assert.equal(stableStringify(validatePlan(parseJson(before))), before);
	assert.equal(analysisInputDigest(validatePlan(original)), digest);
	assert.throws(() => validatePlan({ ...original, parallel: admission() }));
});

test("adapter request conformance uses actual offered schemas and preserves unsupported RPC failure", () => {
	const snapshot = readFileSync(new URL("fixtures/native-tools.json", import.meta.url));
	assert.equal(createHash("sha256").update(snapshot).digest("hex"), "cf9444d4d80c86863819c4f761ee1f8401d358ba4747d3bc7b5e9f6646f9dadf");
	assertOfferedToolArguments("create_session", { base_branch: "reserved-base", workspace_type: "worktree",
		coordinate_with_creator: true, notify_on_idle: "always", kickoff: { prompt: "setup-only", mode: "interactive" } });
	assert.throws(() => assertOfferedToolArguments("create_session", { notify_on_idle: "all" }));
	assertOfferedToolArguments("foundry_reserve_task", { planId: "parallel-fixture", taskId: "T-001", expectedRevision: 3, reservationId: "stable-admission" });
	assert.throws(() => assertOfferedToolArguments("foundry_reserve_task", { planId: "parallel-fixture", taskId: "T-001", expectedRevision: 3, reservationId: "stable", permissionBypass: true }));
	assertOfferedToolArguments("send_session_message", { session_id: "attached-child", message: "unchanged delegation", coordinator_only: true, mode: "autopilot" });
	assertOfferedToolArguments("run_dynamic_workflow", { name: "exact-prepared", args: { input: "unchanged" }, limits: { maxTotalSubagents: 2 } });
	assert.throws(() => assertOfferedToolArguments("run_dynamic_workflow", { name: "exact-prepared", resumeFromRunId: "different-run" }));
	assert.throws(() => offeredSchema("session.workflow.run"), /not offered/);
	const failed = parseJson(readFileSync(new URL("fixtures/native-rpc-failure.json", import.meta.url), "utf8"));
	assert.ok(isRecord(failed) && isRecord(failed.result));
	assert.equal(failed.result.resultType, "failure");
	assert.equal(failed.result.error, "This session management tool is disabled");
});

test("production composition shares one claim database across distinct owner-bound stores", (t) => {
	const directoryParts = ["files", "shared-claims"];
	const { fixture, open } = storageFixture(t, directoryParts);
	const left = open(), right = open("foreign-owner");
	assert.equal(left.admission.databasePath, fixture.databasePath);
	assert.equal(right.admission.databasePath, fixture.databasePath);
	const active = reserve(left.admission, attempt("T-003"));
	const foreignAttempt = { ...attempt("T-004"), owner: "foreign-owner" };
	const { attemptId, ...foreignIdentity } = foreignAttempt;
	assert.throws(() => right.admission.claim({
		identity: foreignIdentity, expectedRevision: 0, resources: active.resources, team: null,
	}), { code: "parallel_capacity_held" });
	assert.equal(right.admission.read(foreignIdentity), null);
	const foreign = reserve(right.admission, foreignAttempt, active.resources.map(resource => ({ ...resource, scope: "foreign-host" })));
	assert.throws(() => right.admission.cancel(admissionFence(active)), { code: "parallel_foreign_owner" });
	assert.throws(() => right.admission.withFence(admissionFence(foreign), tx => left.journal.intent(tx, receipt())), { code: "parallel_foreign_owner" });
	assert.throws(() => left.admission.withFence(admissionFence(active), ({ db }) => {
		db.exec("DELETE FROM parallel_admissions");
	}), { code: "database_error" });
	assert.deepEqual(right.admission.read(foreign.identity), foreign);
	assert.deepEqual(right.admission.list().find(record => record.identity.owner === owner), active);
	directoryParts[1] = "changed-after-construction";
	assert.deepEqual(left.admission.read(active.identity), active, "The caller cannot retarget the captured shared location");
	assert.deepEqual(right.journal.read(attempt("T-003")), []);
	assert.deepEqual(right.admission.read(foreign.identity), foreign);
});

test("production fenced intent, start and result persist hydrated admissions atomically across reopen", (t) => {
	const { open } = storageFixture(t);
	const left = open(), observer = open(), right = open("foreign-owner");
	const active = reserve(left.admission, attempt("T-003"));
	const foreign = reserve(right.admission, { ...attempt("T-004"), owner: "foreign-owner" },
		active.resources.map(resource => ({ ...resource, scope: "foreign-host" })));
	const payload = { bootstrap: { branch: "reserved-base", commit: COMMIT }, inputs: descriptor().inputs };
	const intent = { ...receipt(), payloadDigest: analysisInputDigest(payload) };
	left.admission.withFence(admissionFence(active), tx => {
		left.journal.prepare(tx, intent, payload);
		assert.deepEqual(tx.admission.receipts, [intent]);
		assert.deepEqual(observer.admission.read(active.identity), active);
		assert.deepEqual(observer.journal.read(intent.attempt), []);
		assert.equal(observer.journal.payload(intent.attempt, intent.kind), null);
		assert.throws(() => observer.admission.cancel(admissionFence(active)), { code: "storage_busy" });
	});
	const prepared = observer.admission.read(active.identity);
	assert.ok(prepared);
	assert.deepEqual(prepared.receipts, [intent]);
	assert.deepEqual(observer.journal.read(intent.attempt), prepared.receipts);
	assert.deepEqual(observer.journal.payload(intent.attempt, intent.kind), payload);
	const started = left.admission.withFence(admissionFence(prepared), tx => left.journal.start(tx, intent.id));
	assert.equal(started.state, "in-flight");
	const inFlight = observer.admission.read(active.identity);
	assert.ok(inFlight);
	assert.deepEqual(inFlight.receipts, [started]);
	assert.deepEqual(right.journal.read(intent.attempt), [started]);
	assert.throws(() => observer.admission.withFence(admissionFence(inFlight), tx => observer.journal.start(tx, intent.id)),
		{ code: "dispatch_already_started" });
	const completed = { ...started, state: /** @type {const} */ ("succeeded"), sessionId: "native-child" };
	const result = { session_id: "native-child", transport: { acknowledged: true } };
	assert.throws(() => left.admission.withFence(admissionFence(inFlight), tx => {
		left.journal.recordResult(tx, completed, result);
		assert.deepEqual(tx.admission.receipts, [completed]);
		assert.deepEqual(observer.admission.read(active.identity), inFlight);
		assert.deepEqual(observer.journal.read(intent.attempt), [started]);
		assert.deepEqual(observer.journal.outcomes(intent.attempt, intent.id), []);
		throw new Error("interrupt result before commit");
	}), /interrupt result before commit/);
	const recovered = open();
	assert.deepEqual(recovered.admission.read(active.identity), inFlight);
	assert.deepEqual(recovered.journal.read(intent.attempt), [started]);
	assert.deepEqual(recovered.journal.outcomes(intent.attempt, intent.id), []);
	recovered.admission.withFence(admissionFence(inFlight), tx => recovered.journal.recordResult(tx, completed, result));
	const reopened = open(), persisted = reopened.admission.read(active.identity);
	assert.ok(persisted);
	assert.equal(persisted.revision, inFlight.revision + 1);
	assert.deepEqual(persisted.receipts, [completed]);
	assert.deepEqual(reopened.journal.read(intent.attempt), persisted.receipts);
	assert.deepEqual(reopened.journal.payload(intent.attempt, intent.kind), payload);
	assert.deepEqual(reopened.journal.outcomes(intent.attempt, intent.id), [result]);
	assert.deepEqual(persisted.resources, active.resources);
	assert.deepEqual(persisted.team, active.team);
	assert.equal(persisted.phase, "reserved");
	assert.deepEqual(right.admission.read(foreign.identity), foreign);
});

test("production cancellation closes unstarted journal intents without reopening starts or foreign claims", (t) => {
	const { open } = storageFixture(t);
	const left = open(), peer = open(), right = open("foreign-owner");
	const active = reserve(left.admission, attempt("T-003"));
	const foreign = reserve(right.admission, { ...attempt("T-004"), owner: "foreign-owner" },
		active.resources.map(resource => ({ ...resource, scope: "foreign-host" })));
	const intent = receipt();
	left.admission.withFence(admissionFence(active), tx => left.journal.intent(tx, intent));
	const prepared = peer.admission.read(active.identity);
	assert.ok(prepared);
	const cancelled = peer.admission.cancel(admissionFence(prepared));
	assert.deepEqual(cancelled.obligations[0].pendingEffectIds, [intent.id]);
	assert.deepEqual(left.journal.read(intent.attempt), [intent]);
	assert.throws(() => left.admission.withFence(admissionFence(prepared), tx => left.journal.start(tx, intent.id)),
		{ code: "revision_conflict" });
	assert.throws(() => left.admission.withFence(admissionFence(cancelled), tx => left.journal.start(tx, intent.id)),
		{ code: "parallel_fenced" });
	assert.throws(() => left.admission.withFence(admissionFence(cancelled), tx => left.journal.intent(tx, {
		...intent, id: "new-workflow", kind: "workflow", epoch: cancelled.epoch,
	})), { code: "parallel_fenced" });
	const closed = { ...intent, state: /** @type {const} */ ("cancelled-before-start") };
	peer.admission.withFence(admissionFence(cancelled), tx => peer.journal.recordOutcome(tx, closed));
	const reopened = open(), persisted = reopened.admission.read(active.identity);
	assert.ok(persisted);
	assert.equal(persisted.phase, "cancelling");
	assert.deepEqual(persisted.receipts, [closed]);
	assert.deepEqual(reopened.journal.read(intent.attempt), persisted.receipts);
	assert.deepEqual(persisted.obligations[0].pendingEffectIds, []);
	assert.deepEqual(persisted.resources, active.resources);
	assert.deepEqual(persisted.team, active.team);
	assert.throws(() => reopened.admission.release(admissionFence(persisted)), { code: "parallel_unsafe_release" });
	const observation = { attempt: intent.attempt, sessionIds: [], runIds: [], source: "complete fixture inventory", capturedAt: at };
	reopened.admission.retainObservation(admissionFence(persisted), observation);
	assert.deepEqual(open().admission.readObservations(active.identity), [observation]);
	assert.deepEqual(right.admission.read(foreign.identity), foreign);
});

test("production journal reads reject changed persisted schema identity instead of initializing another database", (t) => {
	const { fixture, open } = storageFixture(t);
	const storage = open(), active = reserve(storage.admission, attempt("T-003"));
	storage.admission.withFence(admissionFence(active), tx => storage.journal.intent(tx, receipt()));
	const before = storage.admission.read(active.identity);
	for (const change of ["PRAGMA user_version = 0", "PRAGMA application_id = 0"]) {
		fixture.left.db.exec(change);
		for (const read of [
			() => storage.journal.read(attempt("T-003")),
			() => storage.journal.payload(attempt("T-003"), "creation"),
			() => storage.journal.outcomes(attempt("T-003"), receipt().id),
		]) assert.throws(read, { code: "parallel_database_version" });
		assert.throws(open, { code: "parallel_database_version" });
		fixture.left.db.exec("PRAGMA user_version = 3; PRAGMA application_id = 0x464e4144");
	}
	assert.deepEqual(storage.admission.read(active.identity), before);
	assert.deepEqual(storage.journal.read(attempt("T-003")), [receipt()]);
});

test("plan readCurrent synchronously validates latest storage while legacy async reads and database stay separate", async (t) => {
	const { fixture, open } = storageFixture(t);
	const parallel = open(), active = reserve(parallel.admission, attempt("T-003"));
	const options = { workspacePath: fixture.workspacePath, clock: () => at };
	const store = createPlanStore(options), other = createPlanStore(options);
	const plan = await store.create(draft(), 0);
	assert.notEqual(store.databasePath, parallel.admission.databasePath);
	assert.deepEqual(store.readCurrent(plan.id), plan);
	assert.deepEqual(await store.read(plan.id), plan);
	const updated = await other.update(plan.id, plan.revision, { ...plan, title: "Current owner-local revision" });
	assert.deepEqual(store.readCurrent(plan.id), updated);
	assert.deepEqual(await store.read(plan.id), updated);
	assert.throws(() => store.readCurrent("../invalid"), { code: "invalid_plan_id" });
	await assert.rejects(store.read("../invalid"), { code: "invalid_plan_id" });
	assert.throws(() => createParallelStorage({
		...options, repositoryId: REPOSITORY, owner, directoryParts: ["files", "foundry"],
	}), { code: "parallel_database_version" });
	assert.deepEqual(createPlanStore(options).readCurrent(plan.id), updated);
	assert.deepEqual(parallel.admission.read(active.identity), active);
});

/** @typedef {import("./workload.mjs").Workload} LogicalWorkload */
/** @typedef {import("./workload.mjs").LogicalPackage} LogicalNode */
/** @typedef {import("./workload.mjs").InventoryView} InventoryView */
/** @typedef {import("../../types/parallel.js").AdmissionIdentity} Identity */
/** @typedef {import("../../types/parallel.js").EffectReceipt} Receipt */
/** @typedef {import("../../native/admission.mjs").NativeResult} NativeResult */

const TERMINAL_BARRIER = "Cancellation terminal availability barrier; NOT successful output delivery";

/**
 * Real admission projection, shared admission/journal storage, dispatcher and recovery.
 * Only the offered native endpoint/results and observation ports are simulated. The
 * immutable schedule cancels every node: external availability observations identify
 * the fixture bootstrap, never a successful producer commit or materialized artifact.
 * @param {import("node:test").TestContext} t @param {LogicalWorkload} workload
 */
async function composedWorkload(t, workload) {
	const directoryParts = ["files", "composed-workload"];
	const fixture = createParallelFixture({ name: `composed-${workload.size}`, directoryParts });
	let tick = 0;
	const clock = () => new Date(Date.UTC(2030, 0, 1) + ++tick * 1000).toISOString();
	const open = (boundOwner = workload.owner) => createParallelStorage({
		workspacePath: fixture.workspacePath, repositoryId: workload.repositoryId, owner: boundOwner,
		directoryParts, clock, busyTimeoutMs: 1,
	});
	let storage = open(), observer = open();
	let planStore = createPlanStore({ workspacePath: fixture.workspacePath, clock });
	const foreignStore = open("unrelated-owner");
	assert.equal(storage.admission.databasePath, fixture.databasePath);
	assert.equal(observer.admission.databasePath, foreignStore.admission.databasePath);
	assert.notEqual(storage.admission, observer.admission);
	assert.notEqual(planStore.databasePath, storage.admission.databasePath);
	/** @type {import("./workload.mjs").TraceEvent[]} */
	const events = [];
	/** @type {Map<string, InventoryView>} */
	const views = new Map();
	/** @type {Map<string, NativeResult>} */
	const nativeResults = new Map();
	/** @type {Map<string, Receipt>} */
	const lateReceipts = new Map();
	/** @type {Map<string, ReturnType<typeof dispatchReservation>>} */
	const reservations = new Map();
	/** @type {Map<string, {entered: ReturnType<typeof deferred<void>>, response: ReturnType<typeof deferred<import("../../types/json.js").JsonValue>>, result: Promise<unknown> | null}>} */
	const suspended = new Map();
	/** @type {{name: string, correlation: string}[]} */
	const nativeCalls = [];
	const intentFaults = new Set();
	const completedEvents = new Set();
	const readinessHolds = new Set();
	/** @type {"before-commit" | "after-commit" | null} */
	let armed = null;
	let replayCount = 0;
	const coordinator = "synthetic-workload-coordinator";
	/** @param {LogicalNode} pkg @returns {Identity} */
	const identity = pkg => ({
		repositoryId: workload.repositoryId, owner: workload.owner, planId: `barrier-${pkg.id}`,
		taskId: "T-001", reservationId: `synthetic-${workload.seed}-${pkg.id}`,
	});
	const byPlan = new Map(workload.packages.map(pkg => [identity(pkg).planId, pkg]));
	const byId = new Map(workload.packages.map(pkg => [pkg.id, pkg]));
	/** @param {string} planId */
	function nodeFor(planId) {
		const pkg = byPlan.get(planId);
		assert.ok(pkg);
		return pkg;
	}
	/** @param {LogicalNode} pkg */
	function record(pkg) {
		const current = storage.admission.read(identity(pkg));
		assert.ok(current);
		return current;
	}
	/** @param {string} code */
	const faultError = code => Object.assign(new Error(code), { code });

	t.after(async () => {
		for (const pending of suspended.values()) pending.response.resolve(null);
		await Promise.all([...suspended.values()].map(pending => pending.result));
		fixture.dispose();
	});

	// Each executable fixture has one implementation and its still-blocked verifier.
	// Cross-plan policies carry the logical DAG; no executable task limit is enlarged.
	for (const pkg of workload.packages) {
		const candidate = draft({ id: identity(pkg).planId, tasks: [task("T-001")],
			title: `${pkg.id}: cancellation barrier only` });
		candidate.repository.workingDirectory = fixture.workspacePath;
		candidate.factory = {
			repositoryId: workload.repositoryId, owner: workload.owner,
			unitId: `unit-${pkg.id}`, unitRevision: 1, candidateId: null,
			contractRevision: null, contractDigest: null, contextDigest: null,
			blueprintDigest: analysisInputDigest(pkg),
		};
		const created = await planStore.create(candidate, 0);
		await planStore.update(created.id, created.revision,
			approvePlan(transitionPlan(created, "awaiting-approval", { at: clock() }), workload.owner, { at: clock() }));
		assert.equal(planStore.readCurrent(created.id).tasks.length, 2);
	}

	const foreignIdentity = { repositoryId: workload.repositoryId, owner: "unrelated-owner",
		planId: "unrelated-plan", taskId: "T-001", reservationId: "unrelated-reservation" };
	const foreignAttempt = { ...foreignIdentity, attemptId: "T-001-A001" };
	const foreignClaim = foreignStore.admission.claim({ identity: foreignIdentity, expectedRevision: 0,
		resources: [{ id: "foreign-write", kind: "shared-write", scope: "foreign-output",
			mode: "exclusive", capacity: 1, units: 1 }], team: null });
	foreignStore.admission.bindReservation(admissionFence(foreignClaim), foreignAttempt);
	for (const kind of /** @type {const} */ (["creation", "workflow"])) {
		const current = foreignStore.admission.read(foreignIdentity);
		assert.ok(current);
		const payload = { foreign: true, kind };
		const intent = effectReceipt({ id: `foreign-${kind}`, attempt: foreignAttempt, kind, epoch: 0,
			payloadDigest: analysisInputDigest(payload), state: "intent", sessionId: null, runId: null,
			source: "synthetic foreign native transport", at: clock() });
		foreignStore.admission.withFence(admissionFence(current), tx => foreignStore.journal.prepare(tx, intent, payload));
		const prepared = foreignStore.admission.read(foreignIdentity);
		assert.ok(prepared);
		const started = foreignStore.admission.withFence(admissionFence(prepared), tx => foreignStore.journal.start(tx, intent.id));
		const inFlight = foreignStore.admission.read(foreignIdentity);
		assert.ok(inFlight);
		foreignStore.admission.withFence(admissionFence(inFlight), tx => foreignStore.journal.recordResult(tx, {
			...started, state: "succeeded", sessionId: kind === "creation" ? "unrelated-session" : null,
			runId: kind === "workflow" ? "unrelated-run" : null,
		}, { synthetic: true, kind }));
	}
	const foreign = foreignStore.admission.read(foreignIdentity);
	assert.ok(foreign);
	const foreignCancelling = foreignStore.admission.cancel(admissionFence(foreign));
	foreignStore.admission.retainObservation(admissionFence(foreignCancelling), {
		attempt: foreignAttempt, sessionIds: ["unrelated-session"], runIds: ["unrelated-run"],
		source: "synthetic foreign inventory", capturedAt: clock(),
	});
	const foreignSession = { id: "unrelated-session", status: "running", attempt: foreignAttempt };
	const foreignRun = { id: "unrelated-run", status: "running", attempt: foreignAttempt };
	function foreignSnapshot() {
		const db = fixture.right.db;
		return {
			admission: foreignStore.admission.read(foreignIdentity), session: foreignSession, run: foreignRun,
			// Compare stored bytes, including revisions/timestamps and complete sidecars.
			rows: stableStringify({
				admission: db.prepare("SELECT * FROM parallel_admissions WHERE identity = ?").all(stableStringify(foreignIdentity)),
				observations: db.prepare("SELECT * FROM parallel_admission_observations WHERE identity = ? ORDER BY id").all(stableStringify(foreignIdentity)),
				effects: db.prepare("SELECT * FROM dispatch_effects WHERE attempt = ? ORDER BY rowid").all(stableStringify(foreignAttempt)),
				outcomes: db.prepare("SELECT * FROM dispatch_outcomes WHERE attempt = ? ORDER BY rowid").all(stableStringify(foreignAttempt)),
			}),
		};
	}

	/** No independent ready queue: all configured dependencies and occupancy go to T003.
	 * @param {LogicalNode} pkg */
	function projection(pkg) {
		const now = clock();
		const dependencies = pkg.dependencies.map(id => {
			const predecessor = byId.get(id);
			assert.ok(predecessor);
			const predecessorIdentity = identity(predecessor);
			const retained = storage.admission.read(predecessorIdentity);
			return {
				repositoryId: workload.repositoryId, owner: workload.owner,
				planId: predecessorIdentity.planId, taskId: predecessorIdentity.taskId, minimumRevision: 1,
				observation: retained?.phase === "released" && completedEvents.has(id) ? dependencyObservation({
					authority: "observation-only", repositoryId: workload.repositoryId, owner: workload.owner,
					planId: predecessorIdentity.planId, taskId: predecessorIdentity.taskId, revision: retained.revision,
					source: `${TERMINAL_BARRIER}; released admission ${predecessorIdentity.reservationId}; bootstrap identity only`,
					capturedAt: now, validUntil: "2099-01-01T00:00:00.000Z",
					complete: true, status: "available", commit: COMMIT,
				}) : null,
			};
		});
		const plan = planStore.readCurrent(identity(pkg).planId);
		return projectAdmission(plan, {
			repositoryId: workload.repositoryId, owner: workload.owner, authorized: true, now,
			claims: storage.admission.list(),
			tasks: {
				"T-001": { resources: pkg.resources, team: { id: "logical-team", capacity: 4, units: 1 }, dependencies },
				"T-997": { resources: [], team: null, dependencies: [] },
			},
		});
	}

	/** @param {LogicalNode} pkg */
	const childFor = pkg => ({ sessionId: `session-${pkg.id}`, projectId: "synthetic-workload-project",
		creatorSessionId: coordinator, worktreePath: path.join(fixture.workspacePath, "synthetic-children", pkg.id),
		branch: `synthetic/${pkg.id}` });
	/** @param {unknown} value */
	const envelope = value => ({ resultType: "success", textResultForLlm: JSON.stringify(value) });
	const transport = createOfferedDispatchTransport({
		owner: workload.owner, sessionId: coordinator,
		context: () => ({ owner: workload.owner, sessionId: coordinator, inWorkflow: false }),
		offered: new Set(["create_session", "get_session", "list_sessions_and_chats", "send_session_message",
			"run_dynamic_workflow", "foundry_get_status", "foundry_reserve_task", "foundry_attach_task"]),
		availability: () => "supported",
		executor: { async execute({ name, arguments: args, toolCallId }) {
			assertOfferedToolArguments(name, args);
			assert.ok(isRecord(args));
			if (name === "foundry_get_status") {
				assert.equal(typeof args.planId, "string");
				return envelope({ plan: planStore.readCurrent(String(args.planId)) });
			}
			if (name === "foundry_reserve_task") {
				const pkg = nodeFor(String(args.planId));
				const plan = await planStore.mutate(String(args.planId), Number(args.expectedRevision), current =>
					reserveTaskAttempt(current, String(args.taskId), { reservationId: String(args.reservationId), at: clock() }));
				const task = plan.tasks[0], attempt = task.attempts.at(-1);
				assert.ok(attempt);
				assert.equal(attempt.reservationId, identity(pkg).reservationId);
				return envelope({ plan, taskId: task.id, attemptId: attempt.id, baseBranch: attempt.baseBranch,
					initialization: buildTaskInitialization(plan, task, attempt),
					delegationPrompt: buildDelegationPrompt(plan, task, attempt) });
			}
			if (name === "get_session") {
				const pkg = workload.packages.find(pkg => childFor(pkg).sessionId === args.project_session_id);
				assert.ok(pkg);
				return envelope(childFor(pkg));
			}
			if (name === "list_sessions_and_chats") return envelope({ complete: true,
				sessions: [...nativeResults.values()].flatMap(({ value }) => isRecord(value)
					&& typeof value.worktreePath === "string" ? [value] : []) });

			// A second constructor reads the committed intent/start BEFORE accepting transport.
			assert.ok(toolCallId);
			const current = observer.admission.list().find(entry => entry.receipts.some(receipt => receipt.id === toolCallId));
			assert.ok(current?.attempt, "A native invocation requires a committed bound admission");
			const started = observer.journal.read(current.attempt).find(receipt => receipt.id === toolCallId);
			assert.ok(started);
			assert.equal(started.state, "in-flight");
			assert.equal(current.phase, "reserved");
			assert.equal(started.epoch, current.epoch);
			const pkg = nodeFor(current.identity.planId), child = childFor(pkg);
			assert.ok(events.some(event => event.kind === "admitted" && event.packageId === pkg.id));
			assert.ok(!nativeCalls.some(call => call.correlation === toolCallId), "Committed effects must not invoke twice");
			nativeCalls.push({ name, correlation: toolCallId });
			events.push({ kind: "started", packageId: pkg.id, effectId: started.id });
			let value;
			if (name === "create_session") {
				assert.equal(started.kind, "creation");
				const reservation = reservations.get(pkg.id);
				assert.ok(reservation);
				assert.deepEqual(args, native.createArguments(reservation));
				value = child;
			} else if (name === "foundry_attach_task") {
				assert.equal(started.kind, "attachment");
				value = await planStore.mutate(String(args.planId), Number(args.expectedRevision), current =>
					attachTaskAttempt(current, String(args.taskId), String(args.attemptId),
						{ sessionId: String(args.sessionId), branch: String(args.branch), at: clock() }));
			} else if (name === "send_session_message") {
				assert.equal(started.kind, "handoff");
				assert.equal(args.message, reservations.get(pkg.id)?.delegationPrompt);
				value = { sessionId: child.sessionId, accepted: true };
			} else {
				assert.equal(name, "run_dynamic_workflow");
				assert.equal(started.kind, "workflow");
				value = { runId: `run-${pkg.id}` };
			}
			const raw = envelope(value);
			nativeResults.set(toolCallId, { value, raw, source: `${coordinator}/${name}/${toolCallId}` });
			if (name === "run_dynamic_workflow" && pkg.scenario === "in-flight") {
				const pending = suspended.get(pkg.id);
				assert.ok(pending);
				pending.entered.resolve();
				return pending.response.promise;
			}
			if (name === "run_dynamic_workflow" && ["uncertain", "before-commit", "after-commit"].includes(pkg.scenario)) {
				throw new Error("Synthetic host retained the exact result; transport acknowledgement was lost");
			}
			return raw;
		} },
	});
	const plans = createNativeAdmission({ transport });
	const native = createNativeDispatch({
		transport, decodeCreated: value => value, decodeHandoff: value => value,
		decodeRun: value => isRecord(value) ? value.runId : null,
		observeSetup: async (child, reservation) => ({ sessionId: child.sessionId,
			message: reservation.initialization.acknowledgement, at: clock(), source: "synthetic exact setup turn" }),
		observeChild: async ({ child, detail, inventory }) => {
			assert.deepEqual(detail.value, child);
			assert.ok(isRecord(inventory.value) && inventory.value.complete === true);
			const pkg = workload.packages.find(pkg => childFor(pkg).sessionId === child.sessionId);
			assert.ok(pkg);
			const reservation = reservations.get(pkg.id);
			assert.ok(reservation);
			return { child, capturedAt: clock(), source: "synthetic complete canonical child/bootstrap observation",
				complete: true, aliases: [child.sessionId], baseBranch: reservation.baseBranch,
				baseCommit: reservation.baseCommit, head: reservation.baseCommit, clean: true };
		},
		// Inventory is never promoted into a dispatch result, even after restart.
		reconcile: async () => null,
	});

	/** Wire T003 projection/native reservation to the actual serialized claim authority.
	 * @param {Identity} requested */
	async function reserveNode(requested) {
		const pkg = nodeFor(requested.planId);
		assert.deepEqual(requested, identity(pkg));
		const decision = projection(pkg);
		if (!decision.dispatchableTaskIds.includes(requested.taskId)) {
			for (const hold of decision.holds.flatMap(item => item.reasons)) readinessHolds.add(hold.kind);
			throw faultError("parallel_admission_held");
		}
		const plan = planStore.readCurrent(requested.planId);
		const held = storage.admission.claim({ identity: requested, expectedRevision: 0,
			resources: pkg.resources, team: { id: "logical-team", capacity: 4, units: 1 } });
		const result = await plans.reserve(requested, plan.revision);
		const attempt = { ...requested, attemptId: result.attempt.id };
		storage.admission.bindReservation(admissionFence(held), attempt);
		const committed = observer.admission.read(requested);
		assert.ok(committed?.attempt);
		assert.deepEqual(committed.attempt, attempt);
		events.push({ kind: "admitted", packageId: pkg.id, identity: committed.identity, resources: committed.resources });
		const reservation = dispatchReservation({ attempt, projectId: childFor(pkg).projectId,
			baseBranch: result.attempt.baseBranch, baseCommit: COMMIT,
			initialization: result.value.initialization, delegationPrompt: result.value.delegationPrompt,
			inputs: null, requiredInputs: [] });
		reservations.set(pkg.id, reservation);
		return reservation;
	}

	/** @param {Identity} requested @param {string} after */
	async function observe(requested, after) {
		const pkg = nodeFor(requested.planId), current = record(pkg), view = views.get(pkg.id) ?? "terminal";
		assert.ok(current.attempt);
		assert.equal(current.phase, "cancelling");
		const inventory = {
			complete: view !== "partial", capturedAt: view === "stale" ? "2000-01-01T00:00:00.000Z" : clock(),
			source: `synthetic complete native inventory after ${after}`,
			sessions: [structuredClone(foreignSession)], runs: [structuredClone(foreignRun)],
		};
		if (view !== "missing-session") inventory.sessions.push({
			id: childFor(pkg).sessionId, status: view === "idle-session" ? "idle" : "completed",
			attempt: view === "foreign-binding" ? foreignAttempt : current.attempt,
		});
		if (pkg.scenario !== "intent" && view !== "missing-run") inventory.runs.push({
			id: `run-${pkg.id}`, status: view === "live-run" ? "running" : "completed", attempt: current.attempt,
		});
		if (view === "observed-run" || view === "observed-run-terminal") inventory.runs.push({
			id: `observed-run-${pkg.id}`, status: view === "observed-run" ? "running" : "completed", attempt: current.attempt,
		});
		return inventory;
	}

	/** @param {ReturnType<typeof createParallelStorage>} [boundStorage] */
	function build(boundStorage = storage) {
		const { admission, journal } = boundStorage;
		const dispatcher = createDispatchOperations({
			admission, plans, native, clock, reserve: reserveNode, ready: async () => [],
			journal: {
				...journal,
				start(tx, id) {
					const started = journal.start(tx, id), pkg = nodeFor(started.attempt.planId);
					if (started.kind === "workflow" && pkg.scenario === "intent" && !intentFaults.has(pkg.id)) {
						intentFaults.add(pkg.id);
						// Roll back the REAL start transaction; no native invocation is made.
						throw faultError("injected_uncommitted_start");
					}
					return started;
				},
			},
		});
		const recovery = createRecoveryOperations({
			admission, observations: admission, repositoryId: workload.repositoryId, owner: workload.owner,
			clock, observe: ({ identity, after }) => observe(identity, after),
			journal: {
				...journal,
				recordOutcome(tx, receipt) {
					const response = nativeResults.get(receipt.id);
					const result = receipt.state === "succeeded" && response
						? journal.recordResult(tx, receipt, readJsonValue(response))
						: journal.recordOutcome(tx, receipt);
					if (receipt.state === "succeeded" && armed === "before-commit") {
						armed = null;
						// Authorizer remains active: only the real journal was mutated.
						assert.notDeepEqual(observer.journal.read(receipt.attempt), tx.admission.receipts);
						throw faultError("injected_persistence_fault");
					}
					return result;
				},
			},
		});
		return { dispatcher, recovery };
	}
	let operations = build();
	/** @param {LogicalNode} pkg */
	const launchSpec = pkg => ({ name: "synthetic-prepared-workflow", args: { packageId: pkg.id }, limits: { maxTotalSubagents: 1 } });

	/** @type {import("./workload.mjs").WorkloadAdapter} */
	const adapter = {
		label: "integrated",
		async request(pkg) {
			const prior = storage.admission.read(identity(pkg));
			if (prior) {
				const before = stableStringify(prior), calls = nativeCalls.length;
				const replayed = await build(open()).dispatcher.dispatch(prior.identity);
				assert.equal(replayed.state, "handed-off", JSON.stringify(replayed));
				assert.equal(stableStringify(record(pkg)), before);
				assert.equal(nativeCalls.length, calls);
				replayCount++;
				return "existing";
			}
			const result = await operations.dispatcher.dispatch(identity(pkg));
			if (result.state === "held") {
				assert.equal(result.code, "parallel_admission_held", JSON.stringify(result));
				assert.equal(storage.admission.read(identity(pkg)), null);
				return "held";
			}
			assert.equal(result.inputsMaterialized, false);
			assert.equal(result.executionObserved, false);
			const attempt = record(pkg).attempt;
			assert.ok(attempt);
			if (pkg.scenario === "in-flight") {
				/** @type {NonNullable<ReturnType<typeof suspended.get>>} */
				const pending = { entered: deferred(), response: deferred(), result: null };
				suspended.set(pkg.id, pending);
				const launched = operations.dispatcher.launch(attempt, launchSpec(pkg));
				pending.result = launched;
				await pending.entered.promise;
				assert.equal(record(pkg).receipts.find(receipt => receipt.kind === "workflow")?.state, "in-flight");
			} else {
				const launched = await operations.dispatcher.launch(attempt, launchSpec(pkg));
				if (pkg.scenario === "intent") assert.equal(launched.state === "held" && launched.code, "injected_uncommitted_start");
				else if (["uncertain", "before-commit", "after-commit"].includes(pkg.scenario)) {
					assert.equal(launched.state === "held" && launched.code, "dispatch_transport_uncertain");
				} else assert.equal(launched.state, "launched", JSON.stringify(launched));
			}
			return "started";
		},
		cancel(pkg) {
			const before = record(pkg);
			const cancelled = operations.recovery.cancel(before.identity);
			assert.deepEqual(observer.admission.read(before.identity), cancelled);
			if (before.phase !== "cancelling") events.push({ kind: "fenced", packageId: pkg.id });
		},
		inventory(pkg, view) { views.set(pkg.id, view); },
		async reconcile(pkg) {
			const before = record(pkg);
			const result = await operations.recovery.reconcile(before.identity);
			assert.deepEqual(observer.admission.read(before.identity), result.record);
			if (before.phase !== "released" && result.state === "released") {
				assert.equal(result.record.delivery, null);
				assert.equal(result.record.epoch, 1);
				events.push({ kind: "released", packageId: pkg.id });
			}
			return result;
		},
		async outcome(pkg) {
			const pending = suspended.get(pkg.id);
			if (pending) {
				const receipt = record(pkg).receipts.find(receipt => receipt.kind === "workflow");
				assert.ok(receipt);
				const response = nativeResults.get(receipt.id);
				assert.ok(response);
				pending.response.resolve(response.raw);
				const result = await pending.result;
				assert.ok(isRecord(result) && result.state === "launched");
				suspended.delete(pkg.id);
				const committed = record(pkg).receipts.find(item => item.id === receipt.id);
				assert.ok(committed?.state === "succeeded");
				lateReceipts.set(pkg.id, committed);
			}
			if (!lateReceipts.has(pkg.id)) {
				const retained = record(pkg).receipts.find(receipt => receipt.kind === "workflow");
				assert.ok(retained);
				const response = nativeResults.get(retained.id);
				assert.ok(response, "Only the retained exact transport result may settle a late effect");
				lateReceipts.set(pkg.id, { ...retained, state: "succeeded", runId: native.decodeRun(response.value),
					source: response.source, at: clock() });
			}
			const receipt = lateReceipts.get(pkg.id);
			assert.ok(receipt);
			operations.recovery.recordOutcome(identity(pkg), receipt);
			assert.deepEqual(observer.journal.read(receipt.attempt).find(item => item.id === receipt.id), receipt);
			if (armed === "after-commit") {
				armed = null;
				throw faultError("injected_persistence_fault");
			}
		},
		fault(point) { assert.equal(armed, null); armed = point; },
		restart() {
			const before = adapter.snapshot(), previous = storage;
			storage = open();
			observer = open();
			planStore = createPlanStore({ workspacePath: fixture.workspacePath, clock });
			operations = build();
			assert.notEqual(storage.admission, previous.admission);
			assert.notEqual(storage.journal, previous.journal);
			assert.deepEqual(adapter.snapshot(), before, "Fresh constructors must recover the full committed state");
			events.push({ kind: "restart" });
		},
		complete(pkg) {
			const current = record(pkg);
			assert.equal(current.phase, "released");
			assert.equal(current.delivery, null);
			const plan = planStore.readCurrent(current.identity.planId);
			assert.ok(plan.tasks.every(task => !hasSuccessfulDelivery(task)));
			assert.ok(projectAdmission(plan).holds.some(hold => hold.taskId === "T-997"
				&& hold.reasons.some(reason => reason.code === "dependency-delivery-missing")),
			"The cancelled logical barrier MUST NOT satisfy a successful-delivery dependency");
			if (!completedEvents.has(pkg.id)) {
				completedEvents.add(pkg.id);
				events.push({ kind: "completed", packageId: pkg.id });
			}
		},
		snapshot() {
			const records = storage.admission.list();
			// Read-only enumeration avoids opening one connection per record per oracle check.
			const observations = fixture.right.db.prepare("SELECT identity, document FROM parallel_admission_observations ORDER BY id").all();
			return { records, events: structuredClone(events),
				observations: records.map(record => ({ identity: record.identity, entries: observations
					.filter(row => row.identity === stableStringify(record.identity))
					.map(row => /** @type {import("../../inventory.mjs").RecoveryObservation} */ (parseJson(String(row.document)))) })),
				foreign: foreignSnapshot() };
		},
	};
	return {
		adapter,
		verify() {
			assert.equal(armed, null);
			assert.equal(suspended.size, 0);
			assert.equal(replayCount, workload.size);
			assert.ok(readinessHolds.has("observation-completeness"));
			assert.ok(readinessHolds.has("resource"));
			assert.equal(nativeCalls.length, workload.size * 4 - intentFaults.size);
			const snapshot = adapter.snapshot();
			for (const pkg of workload.packages) {
				const current = record(pkg);
				assert.ok(current.attempt);
				assert.deepEqual(storage.journal.read(current.attempt), current.receipts);
				assert.deepEqual(observer.admission.readObservations(current.identity), snapshot.observations
					.find(entry => stableStringify(entry.identity) === stableStringify(current.identity))?.entries);
				assert.equal(current.receipts.length, 4);
				assert.ok(current.receipts.every(receipt => receipt.state === "succeeded"
					|| receipt.kind === "workflow" && pkg.scenario === "intent" && receipt.state === "cancelled-before-start"));
				for (const receipt of current.receipts.filter(receipt => receipt.state === "succeeded")) {
					assert.ok(storage.journal.outcomes(current.attempt, receipt.id).some(outcome =>
						isRecord(outcome) && outcome.source === receipt.source && Object.hasOwn(outcome, "raw")),
					"Every owned successful/late outcome requires the actual durable native journal result");
				}
				if (pkg.scenario === "intent") assert.equal(nativeCalls.some(call =>
					call.correlation === current.receipts.find(receipt => receipt.kind === "workflow")?.id), false);
			}
			return { replayCount, nativeStarts: nativeCalls.length, uncommittedStartsRolledBack: intentFaults.size,
				readinessHolds: [...readinessHolds].sort() };
		},
	};
}

for (const [size, seed] of /** @type {const} */ ([[32, 6238], [128, 6334]])) {
	test(`integrated production workload: ${size} cancellation barriers, not successful producer delivery`, async t => {
		const workload = generateWorkload({ size, seed });
		const before = stableStringify(workload);
		const composed = await composedWorkload(t, workload);
		const report = await runWorkload(workload, composed.adapter);
		assert.equal(stableStringify(workload), before, "The generator's immutable schedule must remain unchanged");
		assert.equal(report.label, "integrated");
		assert.equal(report.assertions.admitted, size);
		assert.equal(report.assertions.completed, size);
		assert.ok(report.holds > 0 && report.restarts > 0);
		const checks = composed.verify();
		t.diagnostic(JSON.stringify({ proofBoundary: TERMINAL_BARRIER, nativeTransport: "synthetic; no App calls",
			datasetDigest: report.datasetDigest, size, seed, assertions: report.assertions,
			reconciliations: report.reconciliations, holds: report.holds, restarts: report.restarts, ...checks }));
	});
}
