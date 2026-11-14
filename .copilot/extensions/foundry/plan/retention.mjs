import path from "node:path";
import { readJsonValue } from "../data.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { digest, enumeration, fail, integer, list, object, text, timestamp } from "../factory/fields.mjs";
import { repositoryPath } from "../factory/procedures.mjs";
import { attemptIdentity, commitId } from "./parallel-contracts.mjs";

/** @typedef {import("../types/retention.js").RetentionSubject} Subject */
/** @typedef {import("../types/retention.js").RetentionEvent} Event */
/** @typedef {import("../types/retention.js").RetentionAssessment} Assessment */
/** @typedef {import("../types/retention.js").RetentionIntent} Intent */
/** @type {import("../types/retention.js").RetentionInventoryKind[]} */
const inventories = ["tasks", "attempts", "runs", "sessions", "work", "prs", "merges", "automations", "consumers", "evaluators"];
/** @type {import("../types/retention.js").RetentionArtifactKind[]} */
const artifacts = ["source", "ref", "context", "decision", "report", "evaluator", "artifact"];
/** @param {unknown} a @param {unknown} b */
export const sameRetention = (a, b) => stableStringify(a) === stableStringify(b);
/** @param {unknown} value @param {string} [label] */
export function retentionId(value, label = "identity") {
	if (typeof value !== "string" || value.length > 256 || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)) fail("retention_identity_invalid", `Malformed ${label}`);
	return value;
}
/** @param {unknown} value @param {string} label */
function absolute(value, label) {
	const result = text(value, label, 4096);
	if (!path.isAbsolute(result) || path.normalize(result) !== result || result.endsWith(path.sep) || result === path.parse(result).root
		|| /[\x00-\x1f\x7f]/.test(result)) fail("retention_path_invalid", `${label} must be a bounded canonical absolute path`);
	return result;
}
/** @param {string} parent @param {string} child */
const within = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
/** @template T @param {T[]} values @param {(value: T) => string} key @param {string} label */
function unique(values, key, label) {
	if (new Set(values.map(key)).size !== values.length) fail("retention_duplicate", `Duplicate or conflicting ${label}`);
	return values;
}
/** @param {unknown} value @param {string[]} keys @param {string} label @returns {asserts value is Record<string, unknown>} */
function versioned(value, keys, label) {
	object(value, ["version", ...keys], label);
	if (value.version !== 1) fail("retention_version", `Unsupported ${label} version`);
}
/** @param {unknown} value @returns {import("../types/retention.js").RetentionScope} */
export function retentionScope(value) {
	object(value, ["repositoryId", "owner", "coordinatorSessionId", "currentSessionId"], "retention scope");
	return { repositoryId: digest(value.repositoryId, "repositoryId"), owner: text(value.owner, "owner", 4096),
		coordinatorSessionId: retentionId(value.coordinatorSessionId), currentSessionId: retentionId(value.currentSessionId) };
}
/** @param {unknown} value @returns {Subject} */
export function retentionSubject(value) {
	object(value, ["attempt", "sessionId", "coordinatorSessionId", "worktreePath"], "retention subject");
	const attempt = attemptIdentity(value.attempt);
	retentionId(attempt.reservationId, "reservationId");
	if (/[\x00-\x1f\x7f]/.test(attempt.owner)) fail("retention_identity_invalid", "Malformed owner");
	return { attempt, sessionId: retentionId(value.sessionId, "sessionId"),
		coordinatorSessionId: retentionId(value.coordinatorSessionId, "coordinatorSessionId"), worktreePath: absolute(value.worktreePath, "worktreePath") };
}
/** @param {unknown} value @returns {Event} */
export function retentionEvent(value) {
	versioned(value, ["id", "subject", "revision", "sequence", "sourceCommit", "sourceDigest", "at", "source"], "completion");
	return { version: 1, id: retentionId(value.id, "eventId"), subject: retentionSubject(value.subject),
		revision: integer(value.revision, "completion revision"), sequence: integer(value.sequence, "completion sequence"),
		sourceCommit: commitId(value.sourceCommit), sourceDigest: digest(value.sourceDigest, "source digest"),
		at: timestamp(value.at, "completion time"), source: text(value.source, "completion source", 4096) };
}
/** @param {unknown} value @returns {import("../types/retention.js").RetentionObservation} */
export function retentionObservation(value) {
	versioned(value, ["subject", "eventId", "eventRevision", "eventSequence", "revision", "sequence", "capturedAt", "validUntil", "source", "ownership", "inventories", "workspace"], "observation");
	object(value.workspace, ["state", "tracked", "untracked", "ignored"], "workspace");
	const paths = (/** @type {unknown} */ entries) => unique(list(entries, "workspace paths", 128).map(entry => repositoryPath(entry, "workspace path")), entry => entry, "workspace paths");
	const observed = unique(list(value.inventories, "inventories", inventories.length).map(entry => {
		object(entry, ["kind", "revision", "sequence", "source", "coverage", "nextCursor", "knownIds", "items"], "inventory");
		const kind = enumeration(entry.kind, inventories, "inventory kind");
		return { kind, revision: integer(entry.revision, "inventory revision"), sequence: integer(entry.sequence, "inventory sequence"),
			source: text(entry.source, "inventory source", 4096), coverage: enumeration(entry.coverage, ["exhaustive", "partial", "unknown"], "inventory coverage"),
			nextCursor: entry.nextCursor === null ? null : text(entry.nextCursor, "next cursor", 512),
			knownIds: unique(list(entry.knownIds, "known identities", 128).map(id => retentionId(id)), id => id, "known identities"),
			items: unique(list(entry.items, "inventory entries", 128).map(item => {
				object(item, ["id", "subject", "state", "revision", "sequence", "source", "authority"], "inventory entry");
				const subject = retentionSubject(item.subject), id = retentionId(item.id);
				if ((kind === "tasks" && id !== subject.attempt.taskId) || (kind === "attempts" && id !== subject.attempt.attemptId)
					|| (kind === "sessions" && id !== subject.sessionId)) fail("retention_identity_mismatch", `${kind} entry has another identity`);
				return { id, subject, state: enumeration(item.state, ["terminal", "active", "unknown", "ambiguous"], "observed state"),
					revision: integer(item.revision, "entry revision"), sequence: integer(item.sequence, "entry sequence"),
					source: text(item.source, "entry source", 4096), authority: text(item.authority, "releasing authority", 4096) };
			}), item => item.id, "inventory entries") };
	}), entry => entry.kind, "inventories");
	return { version: 1, subject: retentionSubject(value.subject), eventId: retentionId(value.eventId),
		eventRevision: integer(value.eventRevision, "event revision"), eventSequence: integer(value.eventSequence, "event sequence"),
		revision: integer(value.revision, "observation revision"), sequence: integer(value.sequence, "observation sequence"),
		capturedAt: timestamp(value.capturedAt, "capture time"), validUntil: timestamp(value.validUntil, "expiry"),
		source: text(value.source, "observation source", 4096), ownership: enumeration(value.ownership, ["owned", "foreign", "unknown", "ambiguous"], "ownership observation"),
		inventories: observed, workspace: { state: enumeration(value.workspace.state, ["observed", "unknown"], "workspace observation"),
			tracked: paths(value.workspace.tracked), untracked: paths(value.workspace.untracked), ignored: paths(value.workspace.ignored) } };
}
/** @param {unknown} value @returns {import("../types/retention.js").RetentionManifest} */
export function retentionManifest(value) {
	versioned(value, ["subject", "sourceCommit", "sourceDigest", "sequence", "capturedAt", "source", "retainedRoot", "required", "items"], "manifest");
	const key = (/** @type {{kind: string, id: string}} */ item) => `${item.kind}:${item.id}`;
	return { version: 1, subject: retentionSubject(value.subject), sourceCommit: commitId(value.sourceCommit),
		sourceDigest: digest(value.sourceDigest, "source digest"), sequence: integer(value.sequence, "manifest sequence"),
		capturedAt: timestamp(value.capturedAt, "manifest capture"), source: text(value.source, "manifest source", 4096), retainedRoot: absolute(value.retainedRoot, "retained root"),
		required: unique(list(value.required, "required artifacts", 128).map(item => {
			object(item, ["kind", "id"], "required artifact");
			return { kind: enumeration(item.kind, artifacts, "artifact kind"), id: retentionId(item.id) };
		}), key, "required artifacts"),
		items: unique(list(value.items, "retained artifacts", 128).map(item => {
			object(item, ["kind", "id", "digest", "location", "state", "source"], "retained artifact");
			return { kind: enumeration(item.kind, artifacts, "artifact kind"), id: retentionId(item.id), digest: digest(item.digest, "artifact digest"),
				location: absolute(item.location, "artifact location"), state: enumeration(item.state, ["retained", "missing", "unknown"], "retention state"),
				source: text(item.source, "artifact source", 4096) };
		}), key, "retained artifacts") };
}
/** Pure candidate assessment; no decoded field grants ownership, permission or exclusion.
 * @param {import("../types/retention.js").RetentionScope} scopeValue @param {unknown} eventValue
 * @param {unknown} observationValue @param {unknown} manifestValue @param {string} at
 * @param {readonly Assessment[]} [history] @returns {Assessment} */
export function assessRetention(scopeValue, eventValue, observationValue, manifestValue, at, history = []) {
	list(history, "prior assessment history", 64);
	const scope = retentionScope(scopeValue), event = retentionEvent(eventValue), observation = retentionObservation(observationValue);
	const manifest = manifestValue === null ? null : retentionManifest(manifestValue);
	const assessedAt = timestamp(at, "assessment time");
	/** @type {import("../types/retention.js").RetentionHold[]} */
	const holds = [];
	const hold = (/** @type {string} */ code, /** @type {string} */ reason, authority = "owning coordinator") => { holds.push({ code, reason, authority }); };
	const subject = event.subject;
	if (subject.sessionId === scope.currentSessionId || subject.sessionId === scope.coordinatorSessionId) hold("retention_self", "The current or coordinating owner session cannot archive itself");
	if (subject.attempt.repositoryId !== scope.repositoryId || subject.attempt.owner !== scope.owner || subject.coordinatorSessionId !== scope.coordinatorSessionId) hold("retention_foreign", "Subject is outside this repository/coordinator owner scope");
	if (!sameRetention(subject, observation.subject) || event.id !== observation.eventId
		|| event.revision !== observation.eventRevision || event.sequence !== observation.eventSequence) hold("retention_subject_changed", "Completion, attempt or observed subject changed; obtain the current canonical completion");
	if (observation.ownership !== "owned") hold(`retention_ownership_${observation.ownership}`, "Corroborated unambiguous finished ownership is missing", "native session owner");
	if (observation.sequence < event.sequence || Date.parse(observation.capturedAt) < Date.parse(event.at)
		|| Date.parse(observation.capturedAt) > Date.parse(assessedAt) || Date.parse(observation.validUntil) <= Date.parse(assessedAt)) hold("retention_stale", "Capture is not causally current; refresh all inventories", "canonical observers");
	if (history.some(previous => !sameRetention(previous.event, event) || observation.sequence < previous.observation.sequence
		|| observation.revision < previous.observation.revision
		|| (observation.revision === previous.observation.revision && !sameRetention(observation, previous.observation)))) hold("retention_observation_conflict", "Observation revision regressed or was reused with different content", "canonical observers");
	for (const kind of inventories) {
		const inventory = observation.inventories.find(item => item.kind === kind);
		const priors = history.flatMap(previous => previous.observation.inventories.filter(item => item.kind === kind));
		if (!inventory) { hold("retention_inventory_missing", `Missing ${kind} inventory`, `${kind} authority`); continue; }
		if (inventory.coverage !== "exhaustive" || inventory.nextCursor !== null
			|| !sameRetention([...inventory.knownIds].sort(), inventory.items.map(item => item.id).sort())) hold("retention_inventory_incomplete", `${kind} inventory has pages, gaps or unexplained omissions`, `${kind} authority`);
		if (inventory.sequence !== observation.sequence || priors.some(prior => inventory.revision < prior.revision
			|| (inventory.revision === prior.revision && !sameRetention(inventory, prior)))) hold("retention_inventory_stale", `${kind} inventory is not at the current causal watermark`, `${kind} authority`);
		if (priors.some(prior => prior.knownIds.some(id => !inventory.knownIds.includes(id)))) hold("retention_inventory_omission", `${kind} lost previously observed identities; retain terminal records`, `${kind} authority`);
		const required = kind === "tasks" ? subject.attempt.taskId : kind === "attempts" ? subject.attempt.attemptId : kind === "sessions" ? subject.sessionId : null;
		if (required && !inventory.items.some(item => item.id === required)) hold("retention_terminal_missing", `${kind} lacks the actual subject's terminal record`, `${kind} authority`);
		for (const item of inventory.items) {
			if (!sameRetention(item.subject, subject)) hold("retention_subject_changed", `${kind}:${item.id} belongs to another or reopened subject`, item.authority);
			if (item.sequence > inventory.sequence) hold("retention_inventory_stale", `${kind}:${item.id} is newer than its inventory`, item.authority);
			if (item.state !== "terminal") hold(`retention_${kind}_${item.state}`, `${kind}:${item.id} must be resolved by ${item.authority}`, item.authority);
		}
	}
	if (observation.workspace.state !== "observed") hold("retention_workspace_unknown", "Inspect tracked, untracked and ignored worktree content", "workspace observer");
	for (const kind of /** @type {const} */ (["tracked", "untracked", "ignored"])) {
		if (observation.workspace[kind].length) hold(`retention_${kind}`, `${kind} worktree files must be conserved before archival`, "workspace owner");
	}
	if (!manifest) hold("retention_manifest_missing", "Durable source, context and evidence retention has not been observed", "artifact retention authority");
	else {
		if (!sameRetention(manifest.subject, subject) || manifest.sourceCommit !== event.sourceCommit || manifest.sourceDigest !== event.sourceDigest) hold("retention_manifest_mismatch", "Retention does not pin the exact delivered subject/source", "artifact retention authority");
		if (manifest.sequence !== observation.sequence || Date.parse(manifest.capturedAt) < Date.parse(observation.capturedAt)
			|| Date.parse(manifest.capturedAt) > Date.parse(assessedAt)) hold("retention_manifest_stale", "Retained bytes require current causal inspection", "artifact retention authority");
		if (within(subject.worktreePath, manifest.retainedRoot) || within(manifest.retainedRoot, subject.worktreePath)) hold("retention_root_unsafe", "Retention root must be separate from the removable worktree", "artifact retention authority");
		for (const kind of artifacts) if (!manifest.required.some(item => item.kind === kind)) hold(`retention_${kind}_unobserved`, `Missing retained ${kind} inventory`, "artifact retention authority");
		if (history.some(previous => previous.manifest?.required.some(required => !manifest.required.some(item => sameRetention(item, required))))) hold("retention_artifact_omission", "Previously required retained artifacts cannot disappear from the inventory", "artifact retention authority");
		for (const required of manifest.required) {
			const item = manifest.items.find(item => item.id === required.id && item.kind === required.kind);
			if (!item || item.state !== "retained") hold(`retention_${required.kind}_missing`, `Retain ${required.kind}:${required.id} and its original binding`, "artifact retention authority");
		}
		for (const item of manifest.items) {
			if (!within(manifest.retainedRoot, item.location) || within(subject.worktreePath, item.location) || item.location === manifest.retainedRoot) hold("retention_artifact_unsafe", `${item.kind}:${item.id} is not outside the removable worktree in the retained root`, "artifact retention authority");
		}
	}
	const body = { version: /** @type {const} */ (1), event, observation, manifest, assessedAt,
		state: holds.length ? /** @type {const} */ ("held") : /** @type {const} */ ("candidate"), holds };
	return { ...body, id: `assessment-${analysisInputDigest(body)}` };
}
/** @param {Event} event */
export const retentionIntentId = (event) => `retention-${analysisInputDigest({ repositoryId: event.subject.attempt.repositoryId, owner: event.subject.attempt.owner, eventId: event.id })}`;
/** @param {Intent} intent @param {Assessment} assessment @returns {import("../types/retention.js").RetentionArchiveRequest} */
export function retentionArchiveRequest(intent, assessment) {
	if (assessment.state !== "candidate" || !assessment.manifest || !sameRetention(intent.event, assessment.event)) fail("retention_not_candidate", "Only an exact candidate can prepare an archive operation");
	return { version: 1, operationId: `archive-${analysisInputDigest({ intentId: intent.id, assessmentId: assessment.id })}`,
		intentId: intent.id, subject: intent.event.subject, completionRevision: intent.event.revision,
		sourceCommit: intent.event.sourceCommit, sourceDigest: intent.event.sourceDigest,
		observationDigest: analysisInputDigest(assessment.observation), manifestDigest: analysisInputDigest(assessment.manifest), assessmentId: assessment.id };
}
/** @param {unknown} value @returns {import("../types/retention.js").RetentionOutcome} */
export function retentionOutcome(value) {
	versioned(value, ["operationId", "subject", "disposition", "source", "at", "receipt", "error"], "archive outcome");
	let error = null;
	if (value.error !== null) {
		object(value.error, ["code", "message"], "archive error");
		error = { code: text(value.error.code, "error code", 256), message: text(value.error.message, "error message", 8000) };
	}
	const receipt = readJsonValue(value.receipt);
	if (Buffer.byteLength(stableStringify(receipt)) > 65536) fail("retention_outcome_overflow", "Original receipt exceeds the bounded outbox; retain it externally, never truncate it");
	const disposition = enumeration(value.disposition, ["archived", "denied", "unavailable", "failed", "uncertain"], "archive disposition");
	if (disposition === "archived" && (receipt === null || error !== null)) fail("retention_outcome_invalid", "Archived outcome needs the original successful receipt");
	return { version: 1, operationId: retentionId(value.operationId), subject: retentionSubject(value.subject), disposition,
		source: text(value.source, "outcome source", 4096), at: timestamp(value.at, "outcome time"), receipt, error };
}
/** Decode stored history without treating a retained assessment as current authority.
 * @param {unknown} value @returns {Intent} */
export function retentionIntent(value) {
	versioned(value, ["id", "event", "revision", "assessments", "start", "outcomes"], "retention intent");
	const event = retentionEvent(value.event), id = retentionId(value.id);
	if (id !== retentionIntentId(event)) fail("retention_intent_mismatch", "Intent identity changed");
	const assessments = unique(list(value.assessments, "assessment history", 64, 1).map(entry => {
		versioned(entry, ["id", "event", "observation", "manifest", "assessedAt", "state", "holds"], "assessment");
		const body = { version: /** @type {const} */ (1), event: retentionEvent(entry.event), observation: retentionObservation(entry.observation),
			manifest: entry.manifest === null ? null : retentionManifest(entry.manifest), assessedAt: timestamp(entry.assessedAt, "assessment time"),
			state: enumeration(entry.state, ["held", "candidate"], "assessment state"),
			holds: list(entry.holds, "assessment holds", 2048).map(hold => {
				object(hold, ["code", "reason", "authority"], "hold");
				return { code: text(hold.code, "hold code", 256), reason: text(hold.reason, "hold reason", 8000), authority: text(hold.authority, "hold authority", 4096) };
			}) };
		if (entry.id !== `assessment-${analysisInputDigest(body)}` || !sameRetention(body.event, event)
			|| (body.state === "candidate") !== (body.holds.length === 0)) fail("retention_assessment_mismatch", "Stored assessment identity or disposition changed");
		return { ...body, id: retentionId(entry.id) };
	}), entry => entry.id, "assessments");
	const outcomes = unique(list(value.outcomes, "original outcomes", 64).map(retentionOutcome), analysisInputDigest, "outcomes");
	const result = { version: /** @type {const} */ (1), id, event, revision: integer(value.revision, "intent revision"), assessments, start: null, outcomes };
	let start = null;
	if (value.start !== null) {
		object(value.start, ["version", "operationId", "intentId", "subject", "completionRevision", "sourceCommit", "sourceDigest", "observationDigest", "manifestDigest", "assessmentId"], "archive request");
		const assessmentId = value.start.assessmentId;
		const assessment = assessments.find(entry => entry.id === assessmentId);
		if (!assessment) fail("retention_start_mismatch", "Started operation has no retained assessment");
		start = retentionArchiveRequest(result, assessment);
		if (!sameRetention(start, value.start)) fail("retention_start_mismatch", "Started operation changed its exact payload");
		if (outcomes.some(item => item.at < assessment.assessedAt)) fail("retention_outcome_stale", "Outcome predates its exact operation assessment");
	}
	if (outcomes.some(item => !start || item.operationId !== start.operationId || !sameRetention(item.subject, event.subject))) fail("retention_outcome_mismatch", "Outcome belongs to another operation");
	for (let index = 1; index < outcomes.length; index++) {
		if (outcomes[index - 1].disposition !== "uncertain" || outcomes[index].at < outcomes[index - 1].at) fail("retention_outcome_conflict", "Original terminal outcomes cannot be overwritten");
	}
	return { ...result, start };
}
