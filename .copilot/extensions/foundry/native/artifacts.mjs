import { spawnSync } from "node:child_process";
import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import { errorCode, isRecord } from "../data.mjs";
import { stableStringify } from "../digest.mjs";
import { observeRetentionPath } from "../hooks/paths.mjs";
import { artifactSubject, planArtifactRetention, readArtifactManifest } from "../plan/artifacts.mjs";

/** @typedef {import("../plan/artifacts.mjs").ArtifactManifest} ArtifactManifest */
/** @typedef {ArtifactManifest["artifacts"][number]} ManifestArtifact */
/** @typedef {ArtifactManifest["commits"][number]} ManifestCommit */
/** @typedef {{status: "completed" | "denied" | "interrupted", receiptId: string}} PreservationReceipt */
/** @typedef {{revision: string, inventory: unknown, removalRoots: string[]}} RetentionBinding */
/** @typedef {{artifact: ManifestArtifact, source: string, destination: string, revalidate: () => void}} ArtifactRequest */
/** @typedef {{sourceRepository: string, retainedRepository: string, commit: ManifestCommit, revalidate: () => void}} CommitRequest */
/** @typedef {{
 * subject: import("../plan/artifacts.mjs").ArtifactSubject, storeId: string,
 * sourceRoots: Record<string, string>, sourceRepository: string,
 * retentionRoot: string, retainedRepository: string,
 * readBinding: () => RetentionBinding | null,
 * provider: {
 *   retainArtifact: (request: ArtifactRequest) => Promise<PreservationReceipt>,
 *   retainCommit: (request: CommitRequest) => Promise<PreservationReceipt>
 * }
 * }} ArtifactRetentionOptions */
/** @typedef {{kind: "artifact" | "commit", id: string, status: "verified"}} PreservationObservation */
/** @typedef {PreservationReceipt & {kind: "artifact" | "commit", id: string}} RetainedReceipt */
/** @typedef {{
 * status: "observed" | "held", manifest: ArtifactManifest | null,
 * observations: PreservationObservation[], receipts: RetainedReceipt[],
 * reasons: string[], raceSafe: false, guarantee: string
 * }} PreservationResult */

const guarantee = "Point-in-time private filesystem/Git observations only; no archive permission, exhaustive host inventory, race-safe removal or Windows-native guarantee.";
/** @param {string} code @returns {never} */
function hold(code) { throw new Error(code); }
/** @param {unknown} error */
function reason(error) {
	if (error instanceof Error && /^retention_[a-z_]+$/.test(error.message)) return error.message;
	const code = errorCode(error);
	if (code && /^(?:artifact_[a-z_]+|E[A-Z]+)$/.test(code)) return code;
	return "retention_observation_failed";
}
/** @param {string} filename */
function absolute(filename) {
	if (!path.isAbsolute(filename) || path.normalize(filename) !== filename || filename === path.parse(filename).root
		|| /[\\\0]/.test(filename)) hold("retention_root_invalid");
	return filename;
}
/** @param {string} a @param {string} b */
function overlaps(a, b) {
	const left = a.normalize("NFC").toLowerCase(), right = b.normalize("NFC").toLowerCase();
	return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}
/** @template T @param {T} value @returns {T} */
function freeze(value) {
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) freeze(item);
		Object.freeze(value);
	}
	return value;
}
/** @param {unknown} value @returns {PreservationReceipt} */
function receipt(value) {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "receiptId,status"
		|| !["completed", "denied", "interrupted"].includes(String(value.status))
		|| typeof value.receiptId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.receiptId)) {
		hold("retention_provider_receipt_invalid");
	}
	return { status: /** @type {PreservationReceipt["status"]} */ (value.status), receiptId: value.receiptId };
}

/**
 * Trusted composition seam, not a tool/JSON grant. The owner-local readBinding must
 * derive complete required inventory, causal revision and removal footprint from
 * canonical host records; null/unknown holds. Options and providers must never be
 * populated from model permission assertions. Provider methods use their ordinary
 * authorized private-storage route, preserve full original receipts privately, and
 * must call revalidate immediately before their bounded no-clobber effect. There is
 * no fallback writer here. Orchestration retains denial/retry holds independently of
 * these byte observations. Checks detect cooperative substitutions, not hostile races;
 * mode/UID checks do not attest ACLs, mounts or crash durability. Production archive
 * still needs its separate action-time host authority and provider durability contract.
 *
 * observe is read-only and works after sources disappear. retain reads originals
 * first, invokes only missing-item providers, and independently checks resulting bytes
 * and complete Git connectivity; a receipt alone cannot establish preservation.
 *
 * @param {ArtifactRetentionOptions} options
 */
export function createArtifactRetention(options) {
	const subject = artifactSubject(options.subject), storeId = options.storeId;
	const sourceRoots = Object.fromEntries(Object.entries(options.sourceRoots).map(([id, root]) => [id, absolute(root)]));
	const sourceRepository = absolute(options.sourceRepository);
	const retentionRoot = absolute(options.retentionRoot), retainedRepository = absolute(options.retainedRepository);
	const readBinding = options.readBinding;
	const retainArtifact = options.provider.retainArtifact, retainCommit = options.provider.retainCommit;
	if (typeof readBinding !== "function" || typeof retainArtifact !== "function" || typeof retainCommit !== "function") {
		hold("retention_provider_unavailable");
	}
	/** @type {Map<string, string>} */
	const anchors = new Map();
	/** @param {string} root @param {string} relative @param {Parameters<typeof observeRetentionPath>[2]} settings @param {boolean} [pinFile] */
	function inspect(root, relative, settings, pinFile = true) {
		const observed = observeRetentionPath(root, relative, settings);
		for (const component of observed.components) {
			if (!pinFile && settings.kind === "file" && component.path === observed.path) continue;
			const identity = `${component.device}:${component.inode}`;
			if (anchors.has(component.path) && anchors.get(component.path) !== identity) hold("retention_path_substituted");
			anchors.set(component.path, identity);
		}
		return observed;
	}
	/** @param {ArtifactManifest} manifest */
	function binding(manifest) {
		const current = readBinding();
		if (!current || typeof current.revision !== "string" || !current.revision
			|| !Array.isArray(current.removalRoots) || !current.removalRoots.length) {
			hold("retention_binding_unobserved");
		}
		const inventory = planArtifactRetention(current.inventory);
		if (stableStringify(inventory) !== stableStringify(manifest)
			|| stableStringify(manifest.subject) !== stableStringify(subject) || manifest.storeId !== storeId) {
			hold("retention_identity_changed");
		}
		const removalRoots = current.removalRoots.map(absolute).sort();
		for (const root of [retentionRoot, retainedRepository]) {
			if ([...removalRoots, ...Object.values(sourceRoots), sourceRepository].some(removed => overlaps(root, removed))) {
				hold("retention_destination_removable");
			}
			inspect(root, "", { kind: "directory", private: true });
		}
		return stableStringify({ revision: current.revision, inventory, removalRoots });
	}
	/** @param {string} repository @param {string[]} args @param {boolean} [bare] */
	function git(repository, args, bare = false) {
		inspect(repository, "", { kind: "directory" });
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		const result = spawnSync("git", [...(bare ? ["--git-dir", repository] : ["-C", repository]), "--no-replace-objects", ...args], {
			env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull,
				GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
			encoding: "utf8", maxBuffer: bufferConstants.MAX_LENGTH,
		});
		inspect(repository, "", { kind: "directory" });
		if (result.error || result.signal || result.status !== 0) hold("retention_git_unavailable");
		return result.stdout.trim();
	}
	/** All files/objects must be self-contained. No alternate object databases, shallow
	 * boundaries, lazy fetch, replacements, linked objects or linked Git configuration. */
	function durableRepository() {
		const pending = [""];
		inspect(retainedRepository, "", { kind: "directory", private: true });
		while (pending.length) {
			const relative = pending.pop();
			if (relative === undefined) hold("retention_git_inventory_invalid");
			for (const entry of readdirSync(path.join(retainedRepository, relative), { withFileTypes: true })) {
				const child = relative ? `${relative}/${entry.name}` : entry.name;
				if (["objects/info/alternates", "objects/info/http-alternates", "shallow", "info/grafts", "commondir", "gitdir", "worktrees"].includes(child)
					|| child.startsWith("refs/replace/") || child.endsWith(".promisor")) hold("retention_git_dependency");
				inspect(retainedRepository, child, { kind: entry.isDirectory() ? "directory" : "file" }, false);
				if (entry.isDirectory()) pending.push(child);
			}
		}
		const config = git(retainedRepository, ["config", "--local", "--no-includes", "--list"], true);
		if (/^(?:include(?:if\.[^=]+)?\.path|extensions\.partialclone|remote\.[^=]+\.promisor|fsck\.[^=]+)=/mi.test(config)) {
			hold("retention_git_dependency");
		}
		if (git(retainedRepository, ["rev-parse", "--is-bare-repository"], true) !== "true"
			|| git(retainedRepository, ["rev-parse", "--absolute-git-dir"], true) !== retainedRepository
			|| git(retainedRepository, ["rev-parse", "--path-format=absolute", "--git-common-dir"], true) !== retainedRepository) {
			hold("retention_git_not_independent");
		}
	}
	/** @param {ManifestCommit} item */
	function sourceCommit(item) {
		const metadata = lstatSync(path.join(sourceRepository, ".git"));
		if (metadata.isSymbolicLink() || (!metadata.isDirectory() && (!metadata.isFile() || metadata.nlink !== 1))
			|| git(sourceRepository, ["rev-parse", "--show-toplevel"]) !== sourceRepository
			|| git(sourceRepository, ["rev-parse", "--verify", item.sourceRef]) !== item.commit
			|| git(sourceRepository, ["cat-file", "-t", item.commit]) !== "commit") hold("retention_source_changed");
	}
	/** @param {ManifestCommit} item @param {boolean} missing */
	function retainedCommit(item, missing) {
		durableRepository();
		const refs = git(retainedRepository, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)", item.durableRef], true)
			.split("\n").filter(Boolean);
		if (!refs.length && missing) return false;
		if (refs.length !== 1 || refs[0] !== `${item.durableRef} ${item.commit}`) hold("retention_ref_mismatch");
		if (git(retainedRepository, ["cat-file", "-t", item.commit], true) !== "commit") hold("retention_object_missing");
		git(retainedRepository, ["fsck", "--full", "--no-reflogs", item.commit], true);
		durableRepository();
		return true;
	}
	/** @param {string} root @param {string} relative @param {ManifestArtifact} item @param {boolean} missing @param {boolean} privateStore */
	function bytes(root, relative, item, missing, privateStore) {
		const before = inspect(root, relative, { kind: "file", missing, private: privateStore });
		if (!before.exists) return false;
		if (before.size !== item.bytes) hold("retention_size_mismatch");
		const fd = openSync(before.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const opened = fstatSync(fd, { bigint: true });
			const stamp = `${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeNs}:${opened.ctimeNs}`;
			if (!opened.isFile() || opened.nlink !== 1n || stamp !== before.stamp) hold("retention_source_changed");
			const data = Buffer.alloc(item.bytes + 1);
			let length = 0, size;
			do {
				size = readSync(fd, data, length, data.length - length, length);
				length += size;
			} while (size && length < data.length);
			const after = inspect(root, relative, { kind: "file", private: privateStore });
			const final = fstatSync(fd, { bigint: true });
			if (before.stamp !== after.stamp || stamp !== `${final.dev}:${final.ino}:${final.size}:${final.mtimeNs}:${final.ctimeNs}`
				|| length !== item.bytes || createHash("sha256").update(data.subarray(0, length)).digest("hex") !== item.sha256) {
				hold("retention_digest_mismatch");
			}
			return true;
		} finally { closeSync(fd); }
	}
	/** @param {ManifestArtifact} item */
	function sourceBytes(item) {
		const root = sourceRoots[item.root];
		if (!root) hold("retention_foreign_root");
		inspect(root, "", { kind: "directory" });
		bytes(root, item.path, item, false, false);
		return path.join(root, item.path);
	}
	/** @param {unknown} value @param {boolean} write @returns {Promise<PreservationResult>} */
	async function run(value, write) {
		/** @type {PreservationResult} */
		const result = { status: "held", manifest: null, observations: [], receipts: [], reasons: [], raceSafe: false, guarantee };
		try {
			if (process.platform === "win32") hold("retention_platform_unsupported");
			const manifest = freeze(readArtifactManifest(value));
			result.manifest = manifest;
			const initial = binding(manifest);
			const current = () => { if (binding(manifest) !== initial) hold("retention_binding_changed"); };
			if (write) {
				for (const item of manifest.artifacts) sourceBytes(item);
				for (const item of manifest.commits) sourceCommit(item);
			}
			for (const item of manifest.artifacts) {
				current();
				if (!bytes(retentionRoot, item.destination, item, write, true)) {
					const source = sourceBytes(item), destination = path.join(retentionRoot, item.destination);
					const revalidate = () => {
						current(); sourceBytes(item);
						if (bytes(retentionRoot, item.destination, item, true, true)) hold("retention_destination_appeared");
					};
					revalidate();
					const saved = receipt(await retainArtifact(Object.freeze({ artifact: item, source, destination, revalidate })));
					result.receipts.push({ ...saved, kind: "artifact", id: item.id });
					if (saved.status !== "completed") hold(`retention_provider_${saved.status}`);
					current(); sourceBytes(item);
					bytes(retentionRoot, item.destination, item, false, true);
				}
				result.observations.push({ kind: "artifact", id: item.id, status: "verified" });
			}
			for (const item of manifest.commits) {
				current();
				if (!retainedCommit(item, write)) {
					const revalidate = () => {
						current(); sourceCommit(item);
						if (retainedCommit(item, true)) hold("retention_destination_appeared");
					};
					revalidate();
					const saved = receipt(await retainCommit(Object.freeze({ sourceRepository, retainedRepository, commit: item, revalidate })));
					result.receipts.push({ ...saved, kind: "commit", id: item.commit });
					if (saved.status !== "completed") hold(`retention_provider_${saved.status}`);
					current(); sourceCommit(item); retainedCommit(item, false);
				}
				result.observations.push({ kind: "commit", id: item.commit, status: "verified" });
			}
			current();
			// A later provider must not invalidate an earlier observation.
			for (const item of manifest.artifacts) bytes(retentionRoot, item.destination, item, false, true);
			for (const item of manifest.commits) retainedCommit(item, false);
			if (write) {
				for (const item of manifest.artifacts) sourceBytes(item);
				for (const item of manifest.commits) sourceCommit(item);
			}
			current();
			result.status = "observed";
		} catch (error) {
			result.reasons.push(reason(error));
		}
		return result;
	}
	return Object.freeze({
		/** @param {unknown} manifest */
		observe: manifest => run(manifest, false),
		/** @param {unknown} manifest */
		retain: manifest => run(manifest, true),
	});
}
