import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { readBoolean } from "../data.mjs";
import { COMMIT, digest, enumeration, fail, identifier, integer, list, object, reference, strings, text, timestamp } from "../factory/fields.mjs";
import { repositoryPath } from "../factory/procedures.mjs";
import { ATTEMPT_ID_PATTERN, PLAN_ID_PATTERN, TASK_ID_PATTERN } from "./values.mjs";
import path from "node:path";

/** @param {unknown} value @param {RegExp | string} pattern @param {string} label */
function matching(value, pattern, label) {
	const result = text(value, label, 512);
	if (!new RegExp(pattern).test(result)) fail("parallel_identity_invalid", `Invalid ${label}`);
	return result;
}
/** @param {unknown} value */
export const commitId = (value) => matching(value, COMMIT, "commit");
/** @param {unknown} value @returns {import("../types/parallel.js").AdmissionIdentity} */
export function admissionIdentity(value) {
	object(value, ["repositoryId", "owner", "planId", "taskId", "reservationId"], "admission identity");
	return {
		repositoryId: digest(value.repositoryId, "repositoryId"), owner: text(value.owner, "owner", 4096),
		planId: matching(value.planId, PLAN_ID_PATTERN, "planId"), taskId: matching(value.taskId, TASK_ID_PATTERN, "taskId"),
		reservationId: text(value.reservationId, "reservationId", 256),
	};
}
/** @param {unknown} value @returns {import("../types/parallel.js").AttemptIdentity} */
export function attemptIdentity(value) {
	object(value, ["repositoryId", "owner", "planId", "taskId", "reservationId", "attemptId"], "attempt identity");
	const { attemptId, ...identity } = value;
	const admission = admissionIdentity(identity);
	const id = matching(attemptId, ATTEMPT_ID_PATTERN, "attemptId");
	if (!id.startsWith(`${admission.taskId}-A`)) fail("parallel_identity_mismatch", "Attempt belongs to another task");
	return { ...admission, attemptId: id };
}
/** @param {unknown} value @returns {import("../types/parallel.js").ArtifactIdentity} */
export function artifactIdentity(value) {
	object(value, ["repositoryId", "commit", "path", "mode", "digest"], "artifact identity");
	return {
		repositoryId: digest(value.repositoryId, "repositoryId"), commit: commitId(value.commit),
		path: repositoryPath(value.path, "artifact path"), mode: enumeration(value.mode, ["100644", "100755"], "artifact mode"),
		digest: digest(value.digest, "artifact digest"),
	};
}
/** @template T @param {T[]} values @param {(value: T) => string} key @param {string} label */
function unique(values, key, label) {
	if (new Set(values.map(key)).size !== values.length) fail("parallel_duplicate", `Duplicate ${label}`);
	return values;
}
/** @param {unknown} value */
function references(value) {
	return unique(list(value, "references", 128).map(reference), refKey, "reference");
}
/** @param {import("../types/factory.js").KnowledgeRef} value */
export const refKey = (value) => `${value.id}@${value.revision}`;
/** @param {unknown} value @returns {import("../types/parallel.js").GoverningBindings} */
export function governingBindings(value) {
	object(value, ["authority", "repositoryId", "unit", "contract", "requirements", "evaluators", "visualEvaluation"], "governing bindings");
	const authority = enumeration(value.authority, ["discovery-only", "accepted-contract"], "binding authority");
	let contract = null;
	if (value.contract !== null) {
		object(value.contract, ["revision", "digest"], "contract binding");
		contract = { revision: integer(value.contract.revision, "contract revision"), digest: digest(value.contract.digest, "contract digest") };
	}
	if ((authority === "accepted-contract") !== (contract !== null)) fail("parallel_authority_mismatch", "Discovery-only bindings cannot become an accepted contract");
	const requirements = references(value.requirements);
	const evaluators = unique(list(value.evaluators, "evaluators", 128).map((entry) => {
		object(entry, ["id", "revision", "procedureDigest", "requirements", "independent", "modality"], "evaluator binding");
		const required = references(entry.requirements);
		if (!required.length || required.some((ref) => !requirements.some((item) => refKey(item) === refKey(ref)))) {
			fail("parallel_binding_mismatch", "Evaluator requirements must retain governing revisions");
		}
		return { ...reference({ id: entry.id, revision: entry.revision }),
			procedureDigest: digest(entry.procedureDigest, "procedure digest"), requirements: required,
			independent: readBoolean(entry.independent),
			modality: enumeration(entry.modality, ["implementation-test", "boundary", "operational", "human"], "evaluator modality") };
	}), refKey, "evaluator");
	if (requirements.some((ref) => !evaluators.some((entry) => entry.requirements.some((item) => refKey(item) === refKey(ref))))) {
		fail("parallel_binding_coverage", "Every requirement needs a pinned evaluator");
	}
	const visualEvaluation = value.visualEvaluation === null ? null : reference(value.visualEvaluation);
	if (visualEvaluation && !evaluators.some((entry) => refKey(entry) === refKey(visualEvaluation) && entry.independent && entry.modality !== "human")) {
		fail("parallel_visual_binding", "Declared visual evaluation needs its exact independent non-human evaluator");
	}
	return { authority, repositoryId: digest(value.repositoryId, "repositoryId"), unit: reference(value.unit), contract, requirements, evaluators, visualEvaluation };
}
/** Compare to the supplied frozen governing definitions, not a package's self-attestation.
 * @param {unknown} value @param {import("../types/parallel.js").GoverningBindings} governing */
export function assertConservedBindings(value, governing) {
	const supplied = governingBindings(value);
	if (stableStringify(supplied) !== stableStringify(governingBindings(governing))) {
		fail("parallel_binding_mismatch", "Package bindings changed the frozen authority, requirements or evaluators");
	}
	return supplied;
}
/** @param {unknown} value @returns {import("../types/parallel.js").PackageInput} */
export function packageInput(value) {
	object(value, ["producer", "output", "destination"], "package input");
	return { producer: identifier(value.producer), output: identifier(value.output), destination: repositoryPath(value.destination, "input destination") };
}
/** Syntax and governing references only; T-002 owns graph compilation and executable-plan caps.
 * @param {unknown} value @returns {import("../types/parallel.js").PackageDecomposition} */
export function packageDecomposition(value) {
	object(value, ["format", "bindings", "packages", "target"], "package decomposition");
	if (value.format !== "foundry-packages-v1") fail("parallel_format", "Unknown package format");
	const bindings = governingBindings(value.bindings);
	const packages = unique(list(value.packages, "packages", 128, 1).map((entry) => {
		object(entry, ["id", "title", "expectedFiles", "inputs", "outputs", "requirements", "evaluators"], "work package");
		const requirements = references(entry.requirements);
		const evaluators = references(entry.evaluators);
		if (requirements.some((ref) => !bindings.requirements.some((item) => refKey(item) === refKey(ref)))
			|| evaluators.some((ref) => !bindings.evaluators.some((item) => refKey(item) === refKey(ref)))) {
			fail("parallel_binding_mismatch", "Package references substituted governing revisions");
		}
		return {
			id: identifier(entry.id), title: text(entry.title, "package title", 256),
			expectedFiles: strings(entry.expectedFiles, "expected files", 128, 1),
			inputs: unique(list(entry.inputs, "package inputs", 128).map(packageInput), (input) => input.destination, "input destination"),
			outputs: unique(list(entry.outputs, "package outputs", 128, 1).map((output) => {
				object(output, ["id", "path"], "package output");
				return { id: identifier(output.id), path: repositoryPath(output.path, "output path") };
			}), (output) => output.id, "output identity"),
			requirements, evaluators,
		};
	}), (entry) => entry.id, "package");
	const target = identifier(value.target);
	if (!packages.some((entry) => entry.id === target)) fail("parallel_target_missing", "Final package target is missing");
	return { format: value.format, bindings, packages, target };
}
/** @param {unknown} value @returns {import("../types/parallel.js").ReservedInputs} */
export function reservedInputs(value) {
	object(value, ["format", "consumer", "bootstrap", "deliveries", "inputs", "digest"], "reserved inputs");
	if (value.format !== "foundry-reserved-inputs-v1") fail("parallel_format", "Unknown reserved-input format");
	const consumer = attemptIdentity(value.consumer);
	object(value.bootstrap, ["repositoryId", "branch", "commit"], "bootstrap base");
	const bootstrap = { repositoryId: digest(value.bootstrap.repositoryId, "repositoryId"), branch: text(value.bootstrap.branch, "base branch", 512), commit: commitId(value.bootstrap.commit) };
	if (bootstrap.repositoryId !== consumer.repositoryId) fail("parallel_repository_mismatch", "Bootstrap and consumer repositories differ");
	const deliveries = unique(list(value.deliveries, "producer deliveries", 128).map((entry) => {
		object(entry, ["packageId", "attempt", "commit", "outputs"], "producer delivery");
		const attempt = attemptIdentity(entry.attempt);
		const commit = commitId(entry.commit);
		if (attempt.repositoryId !== consumer.repositoryId || attempt.owner !== consumer.owner || attempt.planId !== consumer.planId
			|| attempt.attemptId === consumer.attemptId) fail("parallel_identity_mismatch", "Producer must be a distinct owned predecessor");
		const outputs = unique(list(entry.outputs, "delivered outputs", 128, 1).map((output) => {
			object(output, ["id", "artifact"], "delivered output");
			const artifact = artifactIdentity(output.artifact);
			if (artifact.repositoryId !== attempt.repositoryId || artifact.commit !== commit) fail("parallel_artifact_mismatch", "Output differs from its producer delivery");
			return { id: identifier(output.id), artifact };
		}), (output) => output.id, "delivered output");
		return { packageId: identifier(entry.packageId), attempt, commit, outputs };
	}), (entry) => entry.packageId, "producer");
	const inputs = unique(list(value.inputs, "resolved inputs", 128).map((entry) => {
		object(entry, ["producer", "output", "destination", "artifact"], "resolved input");
		const input = packageInput({ producer: entry.producer, output: entry.output, destination: entry.destination });
		const artifact = artifactIdentity(entry.artifact);
		const delivered = deliveries.find((item) => item.packageId === input.producer)?.outputs.find((item) => item.id === input.output);
		if (!delivered || stableStringify(delivered.artifact) !== stableStringify(artifact)) fail("parallel_input_substitution", "Input is not the exact delivered output");
		return { ...input, artifact };
	}), (input) => input.destination, "resolved destination");
	if (deliveries.some((entry) => !inputs.some((input) => input.producer === entry.packageId))) fail("parallel_input_coverage", "Every predecessor delivery must contribute a declared input");
	/** @type {Omit<import("../types/parallel.js").ReservedInputs, "digest">} */
	const result = { format: value.format, consumer, bootstrap, deliveries, inputs };
	const inputDigest = digest(value.digest, "reserved input digest");
	if (inputDigest !== analysisInputDigest(result)) fail("parallel_input_digest", "Reserved input descriptor changed");
	return { ...result, digest: inputDigest };
}
/** Compare to the complete immutable package declaration, not just the supplied subset.
 * @param {import("../types/parallel.js").ReservedInputs} descriptor
 * @param {import("../types/parallel.js").PackageInput[]} required */
export function assertInputCoverage(descriptor, required) {
	const keys = (/** @type {import("../types/parallel.js").PackageInput[]} */ entries) => entries.map((entry) =>
		stableStringify(packageInput({ producer: entry.producer, output: entry.output, destination: entry.destination }))).sort();
	if (stableStringify(keys(descriptor.inputs)) !== stableStringify(keys(required))) fail("parallel_input_coverage", "Complete multi-predecessor input set is required");
}
/** A validated entry is a binding, not permission; T-002 accepts it only from the
 * attached, handed-off consumer operation, never from setup or an imported receipt.
 * @param {unknown} value @param {import("../types/parallel.js").ReservedInputs} descriptor
 * @returns {import("../types/parallel.js").ConsumerEntry} */
export function consumerEntry(value, descriptor) {
	object(value, ["attempt", "sessionId", "worktreePath", "attachedRevision", "handoffReceiptId", "inputDigest"], "consumer entry");
	const attempt = attemptIdentity(value.attempt);
	const worktreePath = text(value.worktreePath, "consumer worktree", 4096);
	if (!path.isAbsolute(worktreePath) || path.normalize(worktreePath) !== worktreePath) fail("parallel_consumer_path", "Consumer needs its canonical attached worktree");
	if (stableStringify(attempt) !== stableStringify(descriptor.consumer) || value.inputDigest !== descriptor.digest) fail("parallel_consumer_mismatch", "Consumer entry changed the reserved identity or complete input set");
	return { attempt, worktreePath, sessionId: text(value.sessionId, "sessionId", 512),
		attachedRevision: integer(value.attachedRevision, "attached revision"), handoffReceiptId: text(value.handoffReceiptId, "handoff receipt", 512),
		inputDigest: digest(value.inputDigest, "input digest") };
}
/** @param {unknown} value @returns {import("../types/parallel.js").DependencyObservation} */
export function dependencyObservation(value) {
	object(value, ["authority", "repositoryId", "owner", "planId", "taskId", "revision", "source", "capturedAt", "validUntil", "complete", "status", "commit"], "dependency observation");
	if (value.authority !== "observation-only") fail("parallel_observation_authority", "Observations never confer execution authority");
	const capturedAt = timestamp(value.capturedAt, "capturedAt"), validUntil = timestamp(value.validUntil, "validUntil");
	if (Date.parse(validUntil) < Date.parse(capturedAt)) fail("parallel_observation_time", "Observation expires before capture");
	return { authority: value.authority, repositoryId: digest(value.repositoryId, "repositoryId"), owner: text(value.owner, "owner", 4096),
		planId: matching(value.planId, PLAN_ID_PATTERN, "planId"), taskId: matching(value.taskId, TASK_ID_PATTERN, "taskId"),
		revision: integer(value.revision, "observation revision"), source: text(value.source, "source", 4096),
		capturedAt, validUntil, complete: readBoolean(value.complete),
		status: enumeration(value.status, ["available", "unavailable", "unknown"], "observation status"), commit: value.commit === null ? null : commitId(value.commit) };
}
/** @param {unknown} value @returns {import("../types/parallel.js").TeamClaim} */
export function teamClaim(value) {
	object(value, ["id", "capacity", "units"], "team claim");
	const capacity = integer(value.capacity, "explicit capacity");
	return { id: identifier(value.id), capacity, units: integer(value.units, "claimed units", 1, capacity) };
}
/** @param {unknown} value @returns {import("../types/parallel.js").ResourceClaim} */
export function resourceClaim(value) {
	object(value, ["id", "kind", "scope", "mode", "capacity", "units"], "resource claim");
	const { id, capacity, units } = teamClaim({ id: value.id, capacity: value.capacity, units: value.units });
	const kind = enumeration(value.kind, ["worktree-build", "foreground-input", "shared-write", "exact-package"], "resource kind");
	const mode = enumeration(value.mode, ["shared", "exclusive"], "resource mode");
	if ((kind !== "worktree-build" || mode === "exclusive") && (mode !== "exclusive" || capacity !== 1 || units !== 1)) fail("parallel_resource_exclusion", "Foreground, shared-write and exact-package operations are exclusive");
	return { id, kind, scope: text(value.scope, "resource scope", 4096), mode, capacity, units };
}
/** @param {unknown} value @returns {import("../types/parallel.js").EffectReceipt} */
export function effectReceipt(value) {
	object(value, ["id", "attempt", "kind", "epoch", "payloadDigest", "state", "sessionId", "runId", "source", "at"], "effect receipt");
	const kind = enumeration(value.kind, ["creation", "attachment", "handoff", "workflow"], "effect kind");
	const state = enumeration(value.state, ["intent", "in-flight", "succeeded", "definitive-failure", "uncertain", "cancelled-before-start"], "effect state");
	const sessionId = value.sessionId === null ? null : text(value.sessionId, "sessionId", 512);
	const runId = value.runId === null ? null : text(value.runId, "runId", 512);
	if (state === "succeeded" && (kind === "workflow" ? !runId || sessionId !== null : !sessionId || runId !== null)) {
		fail("parallel_receipt_identity", "Successful effects require the exact returned native identity");
	}
	if (["intent", "cancelled-before-start"].includes(state) && (sessionId !== null || runId !== null)) fail("parallel_receipt_identity", "An unstarted intent cannot invent native identity");
	return { id: identifier(value.id), attempt: attemptIdentity(value.attempt), kind, epoch: integer(value.epoch, "epoch", 0),
		payloadDigest: digest(value.payloadDigest, "payload digest"), state, sessionId, runId,
		source: text(value.source, "receipt source", 4096), at: timestamp(value.at, "receipt time") };
}
/** @param {unknown} value @returns {import("../types/parallel.js").CancellationObligation} */
export function cancellationObligation(value) {
	object(value, ["attempt", "sessionId", "runIds", "pendingEffectIds", "disposition", "inventory", "terminatedRunIds"], "cancellation obligation");
	const disposition = enumeration(value.disposition, ["unresolved", "no-session-created", "session-terminated"], "cancellation disposition");
	const sessionId = value.sessionId === null ? null : text(value.sessionId, "sessionId", 512);
	const runIds = strings(value.runIds, "owned runs", 128);
	const pendingEffectIds = strings(value.pendingEffectIds, "pending effects", 128);
	const terminatedRunIds = strings(value.terminatedRunIds, "terminated runs", 128);
	let inventory = null;
	if (value.inventory !== null) {
		object(value.inventory, ["complete", "capturedAt", "source"], "terminal inventory");
		inventory = { complete: readBoolean(value.inventory.complete), capturedAt: timestamp(value.inventory.capturedAt, "inventory time"), source: text(value.inventory.source, "inventory source", 4096) };
	}
	if (terminatedRunIds.some((id) => !runIds.includes(id))) fail("parallel_foreign_run", "Cannot settle unrelated runs");
	if (disposition !== "unresolved" && (!inventory?.complete || pendingEffectIds.length
		|| terminatedRunIds.length !== runIds.length || (disposition === "session-terminated") !== (sessionId !== null))) {
		fail("parallel_unsafe_release", "Terminal disposition requires complete inventory, settled effects and every owned native run");
	}
	return { attempt: attemptIdentity(value.attempt), sessionId, runIds, pendingEffectIds, disposition, inventory, terminatedRunIds };
}
/** @param {unknown} value @returns {import("../types/parallel.js").DeliveryReceipt} */
export function deliveryReceipt(value) {
	object(value, ["attempt", "sessionId", "commit", "planRevision", "source", "terminalRunIds"], "delivery receipt");
	return { attempt: attemptIdentity(value.attempt), sessionId: text(value.sessionId, "delivery session", 512),
		commit: commitId(value.commit), planRevision: integer(value.planRevision, "completed plan revision"),
		source: text(value.source, "complete-task receipt", 4096), terminalRunIds: strings(value.terminalRunIds, "terminal delivery runs", 128) };
}
/** @param {unknown} value @returns {import("../types/parallel.js").AdmissionRecord} */
export function admissionRecord(value) {
	object(value, ["format", "identity", "revision", "epoch", "phase", "attempt", "resources", "team", "obligations", "receipts", "delivery", "reservationFailure"], "admission record");
	if (value.format !== "foundry-admission-v1") fail("parallel_format", "Unknown admission format");
	const identity = admissionIdentity(value.identity);
	const attempt = value.attempt === null ? null : attemptIdentity(value.attempt);
	const phase = enumeration(value.phase, ["claim-held", "reserved", "cancelling", "settled", "released"], "admission phase");
	const epoch = integer(value.epoch, "epoch", 0);
	if (["claim-held", "reserved"].includes(phase) && epoch !== 0 || phase === "cancelling" && epoch === 0) fail("parallel_phase_mismatch", "Cancellation fences cannot be reopened as active reservations");
	let reservationFailure = null;
	if (value.reservationFailure !== null) {
		object(value.reservationFailure, ["source", "at"], "definitive reservation failure");
		reservationFailure = { source: text(value.reservationFailure.source, "reservation failure source", 4096), at: timestamp(value.reservationFailure.at, "reservation failure time") };
	}
	if (reservationFailure && (attempt !== null || !["settled", "released"].includes(phase))) fail("parallel_phase_mismatch", "Definitive no-reservation evidence cannot accompany a bound attempt");
	const sameAdmission = (/** @type {import("../types/parallel.js").AttemptIdentity} */ item) => {
		const { attemptId, ...other } = item;
		return stableStringify(other) === stableStringify(identity);
	};
	if (attempt && !sameAdmission(attempt)) fail("parallel_identity_mismatch", "Reservation belongs to another admission");
	if (phase === "reserved" && !attempt || phase === "claim-held" && attempt) fail("parallel_phase_mismatch", "Claim and reservation identities disagree");
	const obligations = unique(list(value.obligations, "cancellation obligations", 128).map(cancellationObligation), (item) => item.attempt.attemptId, "cancellation obligation");
	const receipts = unique(list(value.receipts, "effect receipts", 512).map(effectReceipt), (item) => item.id, "effect receipt");
	const delivery = value.delivery === null ? null : deliveryReceipt(value.delivery);
	if (delivery && (!attempt || stableStringify(delivery.attempt) !== stableStringify(attempt))) fail("parallel_identity_mismatch", "Delivery belongs to the exact owned attempt");
	if (obligations.some((item) => !attempt || stableStringify(item.attempt) !== stableStringify(attempt))
		|| receipts.some((item) => !attempt || stableStringify(item.attempt) !== stableStringify(attempt) || item.epoch > epoch)) {
		fail("parallel_identity_mismatch", "Native obligations and receipts belong to the exact owned attempt/fence");
	}
	const delivered = delivery !== null && epoch === 0;
	if (["settled", "released"].includes(phase) && !attempt && !reservationFailure) fail("parallel_unsafe_release", "Unbound claims need definitive reservation failure or cancellation-before-reservation evidence");
	if (["settled", "released"].includes(phase) && (obligations.some((item) => item.disposition === "unresolved")
		|| attempt && !delivered && obligations.length !== 1 || receipts.some((item) => ["intent", "in-flight", "uncertain"].includes(item.state)))) {
		fail("parallel_unsafe_release", "Unsettled native side effects retain claims");
	}
	if (["settled", "released"].includes(phase) && receipts.some((receipt) =>
		receipt.sessionId && !(delivered && delivery?.sessionId === receipt.sessionId) && !obligations.some((item) => item.sessionId === receipt.sessionId && item.disposition === "session-terminated")
		|| receipt.runId && !(delivered && delivery?.terminalRunIds.includes(receipt.runId)) && !obligations.some((item) => item.terminatedRunIds.includes(receipt.runId ?? "")))) {
		fail("parallel_unsafe_release", "Native outcomes require the same session/run terminal disposition");
	}
	return { format: value.format, identity, revision: integer(value.revision, "revision"), epoch, phase, attempt,
		resources: unique(list(value.resources, "resources", 128).map(resourceClaim), (item) => item.id, "resource"),
		team: value.team === null ? null : teamClaim(value.team), obligations, receipts, delivery, reservationFailure };
}
/** Import/export is history, never an admission-store mutation or a delegation grant.
 * @param {unknown} value @returns {import("../types/parallel.js").ParallelHistory} */
export function parallelHistory(value) {
	object(value, ["format", "authority", "admissions", "observations"], "parallel history");
	if (value.format !== "foundry-parallel-history-v1" || value.authority !== "history-only") fail("parallel_history_authority", "Imported history cannot activate execution");
	return { format: value.format, authority: value.authority,
		admissions: list(value.admissions, "historical admissions", 128).map(admissionRecord),
		observations: list(value.observations, "historical observations", 128).map(dependencyObservation) };
}
