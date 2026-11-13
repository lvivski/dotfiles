import { assertKnownKeys, assertPlainObject, fail } from "./fields.mjs";
import { COMMIT_PATTERN } from "./values.mjs";

/** @typedef {{repositoryId: string, ownerId: string, sessionId: string, planId: string, taskId: string, attemptId: string}} ArtifactSubject */
/** @typedef {"report" | "evaluator" | "context" | "decision" | "failure" | "artifact"} ArtifactKind */
/** @typedef {{id: string, kind: ArtifactKind, originalId: string, producerId: string, root: string, path: string, sha256: string, bytes: number}} RequiredArtifact */
/** @typedef {{commit: string, sourceRef: string, durableRef: string}} RequiredCommit */
/** @typedef {{subject: ArtifactSubject, storeId: string, artifacts: RequiredArtifact[], commits: RequiredCommit[]}} ArtifactInventory */
/** @typedef {Omit<ArtifactInventory, "artifacts"> & {artifacts: (RequiredArtifact & {destination: string})[]}} ArtifactManifest */

export const ARTIFACT_LIMITS = Object.freeze({ artifacts: 128, commits: 128, bytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 });
const kinds = /** @type {const} */ (["report", "evaluator", "context", "decision", "failure", "artifact"]);
const subjectKeys = ["repositoryId", "ownerId", "sessionId", "planId", "taskId", "attemptId"];

/** @param {unknown} value @param {string[]} keys @param {string} name */
function object(value, keys, name) {
	assertPlainObject(value, name);
	assertKnownKeys(value, new Set(keys), name);
	return value;
}

/** Opaque identifiers, never titles, credentials, content or filesystem roots.
 * @param {unknown} value @returns {string} */
function identifier(value) {
	if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
		fail("artifact_identity", "Artifact identities must be bounded opaque identifiers");
	}
	return value;
}

/** @param {unknown} value @returns {string} */
function relativePath(value) {
	if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9._/-]+$/.test(value)
		|| value.split("/").some(part => !part || part === "." || part === ".." || part.endsWith(".")
			|| /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
		fail("artifact_path", "Artifacts require unambiguous bounded relative paths");
	}
	return value;
}

/** @param {unknown} value @param {number} maximum @returns {unknown[]} */
function entries(value, maximum) {
	if (!Array.isArray(value) || !value.length || value.length > maximum
		|| Object.keys(value).length !== value.length) {
		fail("artifact_inventory", "Artifact inventory must be nonempty, explicit and within its bound");
	}
	return value;
}

/** @param {unknown} value @returns {ArtifactSubject} */
export function artifactSubject(value) {
	const input = object(value, subjectKeys, "artifact subject");
	return {
		repositoryId: identifier(input.repositoryId), ownerId: identifier(input.ownerId),
		sessionId: identifier(input.sessionId), planId: identifier(input.planId),
		taskId: identifier(input.taskId), attemptId: identifier(input.attemptId),
	};
}

/** @param {unknown} value */
function ref(value) {
	const name = relativePath(value);
	if (!name.startsWith("refs/") || name.includes("..")
		|| name.split("/").some(part => part.startsWith(".") || part.endsWith(".lock"))) {
		fail("artifact_ref", "Preservation requires exact fully qualified Git refs");
	}
	return name;
}

/** @param {unknown} value @returns {RequiredArtifact} */
function artifact(value) {
	const input = object(value, ["id", "kind", "originalId", "producerId", "root", "path", "sha256", "bytes"], "artifact");
	const kind = kinds.find(kind => kind === input.kind);
	if (!kind) fail("artifact_kind", "An original artifact category is required");
	if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)) {
		fail("artifact_digest", "An exact SHA256 of the complete original bytes is required");
	}
	if (typeof input.bytes !== "number" || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > ARTIFACT_LIMITS.bytes) {
		fail("artifact_size", "Artifact byte length is missing or exceeds the bounded reader");
	}
	return { id: identifier(input.id), kind, originalId: identifier(input.originalId), producerId: identifier(input.producerId),
		root: identifier(input.root), path: relativePath(input.path), sha256: input.sha256, bytes: input.bytes };
}

/** @param {string} left @param {string} right */
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

/**
 * Pure closed decoding and deterministic planning. This neither asserts inventory
 * completeness nor retention/permission. Native observation must match the entire
 * inventory against its current trusted owner-local reader. No private bytes enter
 * this output; IDs, digests and ref/path metadata still belong in private storage.
 *
 * @param {unknown} value @returns {ArtifactManifest}
 */
export function planArtifactRetention(value) {
	const input = object(value, ["subject", "storeId", "artifacts", "commits"], "artifact inventory");
	const subject = artifactSubject(input.subject), storeId = identifier(input.storeId);
	const artifacts = entries(input.artifacts, ARTIFACT_LIMITS.artifacts).map(artifact).sort((a, b) => compare(a.id, b.id));
	const commits = entries(input.commits, ARTIFACT_LIMITS.commits).map(value => {
		const item = object(value, ["commit", "sourceRef", "durableRef"], "source commit");
		if (typeof item.commit !== "string" || !COMMIT_PATTERN.test(item.commit)) fail("artifact_commit", "A full immutable commit ID is required");
		const sourceRef = ref(item.sourceRef), durableRef = ref(item.durableRef);
		if (!durableRef.startsWith(`refs/foundry/retained/${subject.sessionId}/`)) {
			fail("artifact_ref", "Durable refs must belong to the exact retained subject namespace");
		}
		return { commit: item.commit, sourceRef, durableRef };
	}).sort((a, b) => compare(a.durableRef, b.durableRef));
	for (const kind of kinds.filter(kind => kind !== "artifact")) {
		if (!artifacts.some(artifact => artifact.kind === kind)) fail("artifact_incomplete", `Preservation requires original ${kind} artifacts`);
	}
	if (artifacts.reduce((sum, item) => sum + item.bytes, 0) > ARTIFACT_LIMITS.totalBytes) {
		fail("artifact_overflow", "The complete artifact set exceeds the bounded retention budget");
	}
	/** @type {Map<string, string>} */
	const paths = new Map();
	const ids = new Set(), originals = new Set();
	for (const item of artifacts) {
		relativePath(`${subject.sessionId}/${item.id}`);
		const original = `${item.kind}:${item.originalId}:${item.producerId}`;
		if (ids.has(item.id.toLowerCase()) || originals.has(original)) fail("artifact_duplicate", "Duplicate artifact identity is ambiguous");
		ids.add(item.id.toLowerCase()); originals.add(original);
		const key = `${item.root.toLowerCase()}/${item.path.toLowerCase()}`;
		if (paths.has(key)) fail("artifact_duplicate", "Duplicate or aliased source content cannot be silently omitted");
		paths.set(key, item.sha256);
	}
	const refs = new Set(), sources = new Map();
	for (const item of commits) {
		const key = item.durableRef.toLowerCase();
		if ([...refs].some(other => other === key || other.startsWith(`${key}/`) || key.startsWith(`${other}/`))
			|| (sources.has(item.sourceRef) && sources.get(item.sourceRef) !== item.commit)) {
			fail("artifact_duplicate", "Conflicting source or durable refs cannot be merged");
		}
		refs.add(key); sources.set(item.sourceRef, item.commit);
	}
	return {
		subject, storeId, commits,
		artifacts: artifacts.map(item => ({ ...item, destination: `${subject.sessionId}/${item.id}-${item.sha256}.bin` })),
	};
}

/** Reconstruct rather than trusting serialized manifest destinations or authority flags.
 * @param {unknown} value @returns {ArtifactManifest} */
export function readArtifactManifest(value) {
	const input = object(value, ["subject", "storeId", "artifacts", "commits"], "artifact manifest");
	const planned = planArtifactRetention({
		...input,
		artifacts: entries(input.artifacts, ARTIFACT_LIMITS.artifacts).map(value => {
			const item = object(value, ["id", "kind", "originalId", "producerId", "root", "path", "sha256", "bytes", "destination"], "manifest artifact");
			const { destination, ...original } = item;
			return original;
		}),
	});
	for (const value of entries(input.artifacts, ARTIFACT_LIMITS.artifacts)) {
		assertPlainObject(value, "manifest artifact");
		if (planned.artifacts.find(item => item.id === value.id)?.destination !== value.destination) {
			fail("artifact_destination", "A manifest cannot override its bounded intended retention location");
		}
	}
	return planned;
}
