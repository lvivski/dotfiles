import { analysisInputDigest } from "../../digest.mjs";
import { artifact } from "../../factory/definitions.mjs";
import { COMMIT, digest, enumeration, fail, identifier, integer, list, object, reference, strings, text, timestamp } from "../../factory/fields.mjs";
import { admissionIdentity } from "../parallel-contracts.mjs";

/** @typedef {import("../../types/operating.js").OperatingRecord} Record */
/** @typedef {import("../../types/operating.js").OperatingPublication} Publication */
/** @typedef {import("../../types/operating.js").OperatingHistory} History */

/** @param {unknown} value */
function version(value) {
	if (value !== 1) fail("operating_version_unsupported", "Only operating-model version 1 is supported");
	return /** @type {const} */ (1);
}
/** @param {unknown} value */
const nullableRef = value => value === null ? null : reference(value);
/** @param {unknown} value @param {string} field */
const nullableId = (value, field) => value === null ? null : text(value, field);
/** @param {unknown} value */
function commit(value) {
	if (typeof value !== "string" || !COMMIT.test(value)) fail("operating_commit_invalid", "An immutable full commit identity is required");
	return value;
}
/** @param {unknown} value @returns {import("../../types/operating.js").OperatingIdentity} */
export function operatingIdentity(value) {
	object(value, ["version", "kind", "identity", "source", "authority"], "historical identity");
	return { version: version(value.version), kind: enumeration(value.kind, ["app", "human", "external"], "identity.kind"),
		identity: digest(value.identity, "identity"), source: digest(value.source, "source"),
		authority: enumeration(value.authority, ["historical"], "identity.authority") };
}
/** @param {unknown} value @returns {import("../../types/factory.js").ContractDependency | null} */
function contract(value) {
	if (value === null) return null;
	object(value, ["unitId", "unitRevision", "contractRevision", "contractDigest"], "contract");
	return { unitId: identifier(value.unitId), unitRevision: integer(value.unitRevision, "unitRevision"),
		contractRevision: integer(value.contractRevision, "contractRevision"), contractDigest: digest(value.contractDigest, "contractDigest") };
}
/** @param {unknown} value */
function portableArtifact(value) {
	const result = artifact(value);
	if (/^(?:\/|[a-z]:[\\/]|file:|~[\\/])/i.test(result.ref) || /:\/\/[^/]*@/.test(result.ref)) {
		fail("operating_private_reference", "Portable artifacts cannot contain local paths or credential-bearing URLs");
	}
	return result;
}
/** @param {unknown} value @returns {import("../../types/operating.js").OperatingContext} */
function context(value) {
	object(value, ["id", "kind", "digest", "usage", "knowledge", "artifact"], "context");
	const result = { id: identifier(value.id), kind: enumeration(value.kind, ["knowledge", "decision", "artifact"], "context.kind"),
		digest: digest(value.digest, "context.digest"), usage: enumeration(value.usage, ["generation", "private", "comparison-only"], "context.usage"),
		knowledge: nullableRef(value.knowledge), artifact: value.artifact === null ? null : portableArtifact(value.artifact) };
	if (result.usage !== "generation" && (result.knowledge !== null || result.artifact !== null)) {
		fail("operating_private_reference", "Private and comparison references belong only in the owner-local store");
	}
	return result;
}
/** @param {unknown} value @returns {import("../../types/operating.js").OperatingCriterion} */
function criterion(value) {
	object(value, ["id", "statement", "obligation", "evaluations", "dependsOn", "environment", "workload"], "criterion");
	return { id: identifier(value.id), statement: text(value.statement, "criterion.statement"),
		obligation: nullableRef(value.obligation), evaluations: list(value.evaluations, "evaluations").map(reference),
		dependsOn: list(value.dependsOn, "criterion dependencies").map(item => identifier(item)),
		environment: text(value.environment, "environment"), workload: text(value.workload, "workload") };
}
/** @param {unknown} value @returns {import("../../types/operating.js").OperatingProducer | null} */
function producer(value) {
	if (value === null) return null;
	object(value, ["goal", "charter", "planId", "taskId", "attemptId", "commit", "artifact", "contract", "evaluators"], "producer");
	return { goal: reference(value.goal), charter: reference(value.charter), planId: identifier(value.planId),
		taskId: text(value.taskId, "taskId"), attemptId: text(value.attemptId, "attemptId"),
		commit: commit(value.commit), artifact: portableArtifact(value.artifact), contract: contract(value.contract),
		evaluators: list(value.evaluators, "evaluators").map(item => {
			object(item, ["evaluation", "procedureDigest"], "producer evaluator");
			return { evaluation: reference(item.evaluation), procedureDigest: digest(item.procedureDigest, "procedureDigest") };
		}) };
}
const common = ["version", "kind", "id", "revision", "previous", "source", "context"];
/** @param {unknown} value @returns {Record} */
export function operatingRecord(value) {
	object(value, [...common, "name", "purpose", "accountable", "scope", "decisions", "title", "intent", "charter",
		"authority", "contract", "criteria", "preserves", "relationshipCoverage", "candidateId", "relation", "from",
		"to", "requirement", "criterionIds", "producer", "goal", "category", "status", "rationale", "governing"], "operating record");
	const kind = enumeration(value.kind, ["charter", "goal", "relationship", "decision"], "record.kind");
	const base = { version: version(value.version), id: identifier(value.id), revision: integer(value.revision, "record.revision"),
		previous: nullableRef(value.previous), source: operatingIdentity(value.source), context: list(value.context, "context").map(context) };
	if (base.revision === 1 ? base.previous !== null
		: base.previous?.id !== base.id || base.previous.revision !== base.revision - 1) {
		fail("operating_lineage_invalid", "A record must retain its exact immediate predecessor");
	}
	if (kind === "charter") {
		object(value, [...common, "name", "purpose", "accountable", "scope", "decisions"], "charter");
		return { ...base, kind, name: text(value.name, "name"), purpose: text(value.purpose, "purpose"),
			accountable: operatingIdentity(value.accountable), scope: strings(value.scope, "scope", undefined, 1),
			decisions: list(value.decisions, "decisions").map(operatingCategory) };
	}
	if (kind === "goal") {
		object(value, [...common, "title", "intent", "charter", "authority", "contract", "criteria", "preserves", "relationshipCoverage", "candidateId"], "goal");
		return { ...base, kind, title: text(value.title, "title"), intent: text(value.intent, "intent"),
			charter: reference(value.charter), authority: enumeration(value.authority, ["proposed", "accepted"], "goal.authority"),
			contract: contract(value.contract), criteria: list(value.criteria, "criteria", undefined, 1).map(criterion),
			preserves: strings(value.preserves, "preserves"), relationshipCoverage: enumeration(value.relationshipCoverage, ["complete", "partial"], "relationshipCoverage"),
			candidateId: nullableId(value.candidateId, "candidateId") };
	}
	if (kind === "relationship") {
		object(value, [...common, "relation", "from", "to", "requirement", "criterionIds", "producer"], "relationship");
		return { ...base, kind, relation: enumeration(value.relation, ["subgoal", "depends-on", "artifact"], "relation"),
			from: reference(value.from), to: nullableRef(value.to), requirement: text(value.requirement, "requirement"),
			criterionIds: list(value.criterionIds, "criterionIds").map(item => identifier(item)), producer: producer(value.producer) };
	}
	object(value, [...common, "charter", "goal", "category", "status", "rationale", "governing"], "decision");
	return { ...base, kind, charter: reference(value.charter), goal: nullableRef(value.goal), category: operatingCategory(value.category),
		status: enumeration(value.status, ["observation", "inference", "proposal", "historical"], "decision.status"),
		rationale: text(value.rationale, "rationale"), governing: list(value.governing, "governing").map(reference) };
}
/** @param {unknown} value @returns {import("../../types/operating.js").OperatingCategory} */
function operatingCategory(value) {
	return enumeration(value, ["observation", "proposal", "plan", "completion", "technical-retry", "evaluator-renewal", "contract", "replacement", "human", "external", "resource"], "decision category");
}
/** @param {unknown} value @returns {import("../../types/operating.js").OperatingSnapshot} */
export function operatingSnapshot(value) {
	object(value, ["version", "repositoryId", "factoryRevision", "stateDigest"], "snapshot");
	return { version: version(value.version), repositoryId: digest(value.repositoryId, "repositoryId"),
		factoryRevision: integer(value.factoryRevision, "factoryRevision", 0), stateDigest: digest(value.stateDigest, "stateDigest") };
}
/** @param {unknown} value @returns {import("../../types/operating.js").OperatingBatch} */
export function operatingBatch(value) {
	object(value, ["version", "id", "snapshot", "records", "source"], "batch");
	const batch = { version: version(value.version), id: identifier(value.id), snapshot: operatingSnapshot(value.snapshot),
		records: list(value.records, "records", undefined, 1).map(operatingRecord), source: operatingIdentity(value.source) };
	if (new Set(batch.records.map(record => record.id)).size !== batch.records.length) {
		fail("operating_batch_invalid", "A batch contains at most one revision per record");
	}
	return batch;
}
/** @param {unknown} value @returns {Publication} */
export function operatingPublication(value) {
	object(value, ["version", "batch", "digest", "planId", "planRevision", "taskId", "attemptId", "reservationId", "ownerDigest", "sessionId", "at"], "publication");
	const payload = { version: version(value.version), batch: operatingBatch(value.batch), planId: identifier(value.planId),
		planRevision: integer(value.planRevision, "planRevision"), taskId: text(value.taskId, "taskId"),
		attemptId: text(value.attemptId, "attemptId"), reservationId: text(value.reservationId, "reservationId"),
		ownerDigest: digest(value.ownerDigest, "ownerDigest"), sessionId: text(value.sessionId, "sessionId"), at: timestamp(value.at, "at") };
	if (analysisInputDigest(payload) !== digest(value.digest, "publication.digest")) fail("operating_digest_invalid", "Publication does not match its immutable payload");
	return { ...payload, digest: digest(value.digest, "publication.digest") };
}
/** @param {unknown} value @returns {import("../../types/operating.js").OperatingBinding | null} */
export function operatingBinding(value) {
	if (value === null) return null;
	object(value, ["charter", "projectId", "sessionId", "owner", "planId", "taskId", "attemptId", "observationDigest"], "local binding");
	return { charter: reference(value.charter), projectId: text(value.projectId, "projectId"),
		sessionId: text(value.sessionId, "sessionId"), owner: text(value.owner, "owner"),
		planId: identifier(value.planId), taskId: text(value.taskId, "taskId"), attemptId: text(value.attemptId, "attemptId"),
		observationDigest: digest(value.observationDigest, "observationDigest") };
}
/** @param {unknown} value */
export function operatingReferences(value) {
	return list(value, "private references").map(entry => {
		object(entry, ["id", "kind", "ref", "digest"], "private reference");
		return { id: identifier(entry.id), kind: enumeration(entry.kind, ["context", "source", "decision", "comparison"], "reference.kind"),
			ref: text(entry.ref, "reference.ref"), digest: digest(entry.digest, "reference.digest") };
	});
}
/** @param {unknown} value @returns {import("../../types/operating.js").OperatingAuthority} */
export function operatingAuthority(value) {
	object(value, ["planId", "expectedPlanRevision", "taskId", "attemptId", "fence", "binding", "references", "delegationId"], "operating authority");
	object(value.fence, ["admission", "revision", "epoch"], "admission fence");
	return { planId: identifier(value.planId), expectedPlanRevision: integer(value.expectedPlanRevision, "expectedPlanRevision"),
		taskId: text(value.taskId, "taskId"), attemptId: text(value.attemptId, "attemptId"),
		fence: { admission: admissionIdentity(value.fence.admission), revision: integer(value.fence.revision, "fence.revision"), epoch: integer(value.fence.epoch, "fence.epoch", 0) },
		binding: operatingBinding(value.binding), references: operatingReferences(value.references), delegationId: nullableId(value.delegationId, "delegationId") };
}
/** @param {unknown} value @returns {History} */
export function operatingHistory(value) {
	object(value, ["version", "publications", "local"], "operating history");
	const publications = list(value.publications, "publications").map(operatingPublication);
	const local = list(value.local, "local markers").map(entry => {
		object(entry, ["digest", "references", "binding"], "local marker");
		return { digest: digest(entry.digest, "local.digest"), references: operatingReferences(entry.references), binding: operatingBinding(entry.binding) };
	});
	if (new Set(publications.map(p => p.batch.id)).size !== publications.length
		|| new Set(local.map(p => p.digest)).size !== local.length
		|| local.some(entry => !publications.some(p => p.digest === entry.digest))) {
		fail("operating_history_invalid", "Operating history requires unique publications and matching local commit markers");
	}
	return { version: version(value.version), publications, local };
}
