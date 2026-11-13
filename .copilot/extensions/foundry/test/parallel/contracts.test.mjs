import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { isRecord, parseJson } from "../../data.mjs";
import {
	admissionRecord, artifactIdentity, assertConservedBindings, assertInputCoverage, attemptIdentity, cancellationObligation,
	consumerEntry, dependencyObservation, effectReceipt, governingBindings, packageDecomposition,
	parallelHistory, reservedInputs, resourceClaim,
} from "../../plan/parallel-contracts.mjs";
import { validatePlan } from "../../plan/validation.mjs";
import { assertAdmissionFence, assertEffectTransition, synchronousTransition } from "../../storage/parallel-protocol.mjs";
import { COMMIT, DIGEST } from "../git.mjs";
import { draft } from "../plan/fixture.mjs";
import { assertOfferedToolArguments, offeredSchema } from "./native-contracts.mjs";

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
