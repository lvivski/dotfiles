import { createHash } from "node:crypto";
import {
	closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
	readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { errorCode } from "../data.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { git, gitPath, requireCommit } from "../evidence/git.mjs";
import { digest, fail, list, object } from "../factory/fields.mjs";
import { repositoryPath as relativePath } from "../factory/procedures.mjs";
import { compilePackageGraph } from "../plan/packages.mjs";
import {
	admissionIdentity, artifactIdentity, assertInputCoverage, attemptIdentity, consumerEntry,
	deliveryReceipt, packageInput, reservedInputs,
} from "../plan/parallel-contracts.mjs";

/** @typedef {import("../types/parallel.js").AttemptIdentity} AttemptIdentity
 * @typedef {import("../types/parallel.js").ArtifactIdentity} ArtifactIdentity
 * @typedef {import("../types/parallel.js").ReservedInputs} ReservedInputs
 * @typedef {import("../types/parallel.js").ConsumerEntry} ConsumerEntry
 * @typedef {{receipt: import("../types/parallel.js").DeliveryReceipt, delivery: import("../types/parallel.js").ProducerDelivery, worktreePath: string}} OwnedDelivery
 * @typedef {{repositoryId: string, owner: string, planId: string, taskId: string, packageId: string}} DeliveryQuery
 * @typedef {{protectedPaths: string[], comparisonOnlyPaths: string[], comparisonOnlyDigests: string[], forbiddenWorktreePaths: string[]}} InputPolicy
 * @typedef {{
 * repositoryPath: string, repositoryId: string, owner: string, planId: string,
 * decomposition: import("../types/parallel.js").PackageDecomposition, taskIds: Record<string, string>,
 * policy: InputPolicy,
 * readOwnedDelivery: (query: DeliveryQuery) => OwnedDelivery | null,
 * readAuthorizedConsumerEntry: (descriptor: ReservedInputs) => ConsumerEntry | null
 * }} PackageInputOptions
 */

/** @param {unknown} left @param {unknown} right */
const same = (left, right) => stableStringify(left) === stableStringify(right);
/** @param {string} left @param {string} right */
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
/** @param {string} value */
const folded = (value) => value.normalize("NFC").toLowerCase();
/** @param {string} left @param {string} right */
const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
/** @param {Buffer} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** @template T @param {T} value @returns {T} */
function freeze(value) {
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) freeze(item);
		Object.freeze(value);
	}
	return value;
}
/** @param {string} code @param {string} message @returns {never} */
const hold = (code, message) => fail(code, message, { disposition: "inconclusive" });
/** @param {string} filename */
function stat(filename) {
	try { return lstatSync(filename); }
	catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
}
/** @param {unknown} filename @returns {string} */
function absolutePath(filename) {
	if (typeof filename !== "string" || !path.isAbsolute(filename) || path.normalize(filename) !== filename || filename.includes("\0")) {
		fail("parallel_worktree_path", "An exact absolute canonical worktree path is required");
	}
	let existing = filename;
	while (!stat(existing)) existing = path.dirname(existing);
	if (realpathSync(existing) !== existing) fail("parallel_worktree_path", "Pinned worktree paths cannot alias another location");
	return filename;
}
/** @param {string} directory @param {string[]} args */
function readGit(directory, args) {
	const result = git(directory, args);
	if (result.error || result.status !== 0) hold("parallel_git_unavailable", "Required immutable Git evidence is unavailable");
	return result.stdout;
}

/** @param {string} repository @param {ArtifactIdentity} artifact */
function artifactBytes(repository, artifact) {
	requireCommit(repository, artifact.commit);
	const records = readGit(repository, ["ls-tree", "-z", "--full-tree", artifact.commit, "--", artifact.path])
		.toString("utf8").split("\0").filter(Boolean);
	if (!records.length) hold("parallel_output_unavailable", "A declared output is absent at its delivered immutable commit");
	const match = records.length === 1 && /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40,64})\t(.+)$/.exec(records[0]);
	if (!match || match[2] !== "blob" || match[1] !== artifact.mode || match[4] !== artifact.path) {
		fail("parallel_output_mismatch", "Delivered output path or mode differs from the immutable Git object");
	}
	const bytes = readGit(repository, ["cat-file", "blob", match[3]]);
	if (sha256(bytes) !== artifact.digest) fail("parallel_output_mismatch", "Delivered output SHA256 differs from the immutable Git bytes");
	return bytes;
}

/** Reject case aliases even in parent components on case-sensitive filesystems.
 * @param {string[]} paths */
function distinctPaths(paths) {
	const components = new Map();
	for (const filename of paths) {
		const parts = filename.split("/");
		for (let count = 1; count <= parts.length; count++) {
			const prefix = parts.slice(0, count).join("/"), key = folded(prefix);
			const previous = components.get(key);
			if (previous && previous !== prefix) fail("parallel_destination_conflict", "Case-aliased input paths are ambiguous");
			components.set(key, prefix);
		}
	}
	if (paths.some((filename, index) => paths.some((other, otherIndex) => index !== otherIndex && overlaps(folded(filename), folded(other))))) {
		fail("parallel_destination_conflict", "Input destinations must not duplicate or overlap");
	}
}

/** Existing leaves are never reused, including byte-identical files and ignored files.
 * @param {string} root @param {string} destination */
function destinationPath(root, destination) {
	let parent = root;
	const parts = destination.split("/");
	for (const [index, part] of parts.entries()) {
		const filename = path.join(parent, part);
		if (stat(parent)) {
			if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory()) fail("parallel_destination_escape", "Input parent is not a canonical directory");
			if (readdirSync(parent).some((entry) => folded(entry) === folded(part) && entry !== part)) {
				fail("parallel_destination_conflict", "Input destination aliases an existing path");
			}
		}
		const existing = stat(filename);
		if (existing?.isSymbolicLink()) fail("parallel_destination_escape", "Input paths cannot traverse or replace symlinks");
		if (existing && (index === parts.length - 1 || !existing.isDirectory())) {
			fail("parallel_destination_conflict", "An input destination already exists or overlaps a file");
		}
		parent = filename;
	}
	return parent;
}

/**
 * Trusted composition seam, not a document-based grant. readOwnedDelivery MUST read
 * the current owner-local successful completion/receipt, never imported history,
 * observations, caller attestations or branch tips. It must include the actual producer
 * worktree identity. readAuthorizedConsumerEntry MUST return null until current native
 * setup corroboration, successful attachment and unchanged successful handoff match the
 * descriptor. T-004/T-007 own that real host corroboration, including current attempt,
 * cancellation state, project/creator/session identity and complete handoff payload.
 *
 * Policy must include exact evaluator bundle/helper/lock roots and comparison-only
 * source paths/content digests. It is cloned, as are declarations and package/task IDs.
 * Options must originate in trusted closed sealed recovery: compilation checks graph
 * consistency and canonical task IDs, not acceptance of the supplied contract bindings.
 * Resolve is read-only. Materialization creates snapshots, NOT delivery ancestry; the
 * existing exact-commit integration gate must still run. Filesystem checks and exclusive
 * creation assume a cooperatively owned worktree, not hostile-writer OS isolation.
 * A restarted composition must resolve again before materializing a persisted descriptor.
 *
 * @param {PackageInputOptions} options @returns {import("../types/parallel.js").InputPort}
 */
export function createPackageInputs(options) {
	const repository = realpathSync(absolutePath(options.repositoryPath));
	if (repository !== options.repositoryPath || gitPath(repository, "--show-toplevel") !== repository) {
		fail("parallel_worktree_path", "The pinned repository must be its canonical worktree root");
	}
	const common = gitPath(repository, "--git-common-dir");
	const graph = compilePackageGraph(options.decomposition, options.decomposition.bindings);
	const declaration = freeze(graph.decomposition);
	const scope = admissionIdentity({ repositoryId: options.repositoryId, owner: options.owner, planId: options.planId,
		taskId: "T-001", reservationId: "input-scope" });
	if (declaration.bindings.repositoryId !== scope.repositoryId) fail("parallel_repository_mismatch", "Declarations belong to another repository");
	if (!same(options.taskIds, graph.taskIds)) {
		fail("parallel_package_mapping", "Package task IDs must match the canonical compiled graph");
	}
	const taskIds = freeze(graph.taskIds);
	object(options.policy, ["protectedPaths", "comparisonOnlyPaths", "comparisonOnlyDigests", "forbiddenWorktreePaths"], "input policy");
	const policy = freeze({
		protectedPaths: list(options.policy.protectedPaths, "protected paths", 512).map((value) => relativePath(value, "protected path")),
		comparisonOnlyPaths: list(options.policy.comparisonOnlyPaths, "comparison-only paths", 512).map((value) => relativePath(value, "comparison-only path")),
		comparisonOnlyDigests: list(options.policy.comparisonOnlyDigests, "comparison-only digests", 512).map((value) => digest(value, "comparison-only digest")),
		forbiddenWorktreePaths: list(options.policy.forbiddenWorktreePaths, "forbidden worktrees", 512).map(absolutePath),
	});
	const readOwnedDelivery = options.readOwnedDelivery, readAuthorizedConsumerEntry = options.readAuthorizedConsumerEntry;
	if (typeof readOwnedDelivery !== "function" || typeof readAuthorizedConsumerEntry !== "function") {
		fail("parallel_input_authority", "Owned delivery and authorized native consumer readers are required");
	}
	for (const item of declaration.packages) {
		distinctPaths(item.inputs.map((input) => input.destination));
		distinctPaths(item.outputs.map((output) => output.path));
		for (const input of item.inputs) {
			const producer = declaration.packages.find((entry) => entry.id === input.producer);
			if (!producer || producer.id === item.id || !producer.outputs.some((output) => output.id === input.output)) {
				fail("parallel_input_coverage", "Input must name an exact distinct declared producer output");
			}
		}
	}
	/** @type {Map<string, string>} */
	const resolutions = new Map();

	/** @param {AttemptIdentity} value */
	function ownedAttempt(value) {
		const attempt = attemptIdentity(value);
		if (attempt.repositoryId !== scope.repositoryId || attempt.owner !== scope.owner || attempt.planId !== scope.planId) {
			fail("parallel_foreign_owner", "Inputs require the pinned repository, owner and plan");
		}
		return attempt;
	}
	/** @param {AttemptIdentity} attempt */
	function consumerPackage(attempt) {
		ownedAttempt(attempt);
		const item = declaration.packages.find((entry) => taskIds[entry.id] === attempt.taskId);
		if (!item) fail("parallel_package_mapping", "Consumer task has no immutable package declaration");
		return item;
	}
	/** @param {string[]} paths @param {string} [contentDigest] */
	function checkComparison(paths, contentDigest) {
		if (paths.some((filename) => policy.comparisonOnlyPaths.some((blocked) => overlaps(folded(filename), folded(blocked))))
			|| contentDigest && policy.comparisonOnlyDigests.includes(contentDigest)) {
			fail("parallel_comparison_leakage", "Comparison-only paths or bytes cannot enter generation inputs");
		}
	}
	/** @param {string} source @param {string} destination @param {string} [contentDigest] */
	function checkPolicy(source, destination, contentDigest) {
		checkComparison([source, destination], contentDigest);
		if (policy.protectedPaths.some((blocked) => overlaps(folded(destination), folded(blocked)))) {
			fail("parallel_protected_destination", "Inputs cannot replace evaluator bundles, helpers or locks");
		}
	}
	/** @param {string} packageId @returns {OwnedDelivery} */
	function currentDelivery(packageId) {
		const declared = declaration.packages.find((item) => item.id === packageId);
		if (!declared) fail("parallel_package_mapping", "Unknown predecessor package");
		const current = readOwnedDelivery(freeze({ repositoryId: scope.repositoryId, owner: scope.owner, planId: scope.planId,
			taskId: taskIds[packageId], packageId }));
		if (current === null) hold("parallel_delivery_unavailable", "A current owner-local successful predecessor delivery is required");
		object(current, ["receipt", "delivery", "worktreePath"], "owned delivery");
		const receipt = deliveryReceipt(current.receipt);
		ownedAttempt(receipt.attempt);
		object(current.delivery, ["packageId", "attempt", "commit", "outputs"], "producer delivery");
		const attempt = ownedAttempt(attemptIdentity(current.delivery.attempt));
		if (current.delivery.packageId !== packageId || attempt.taskId !== taskIds[packageId]
			|| !same(receipt.attempt, attempt) || receipt.commit !== current.delivery.commit) {
			fail("parallel_delivery_mismatch", "Successful receipt must bind the exact declared producer attempt, reservation and commit");
		}
		const outputs = list(current.delivery.outputs, "producer outputs", 128, 1).map((output) => {
			object(output, ["id", "artifact"], "producer output");
			const artifact = artifactIdentity(output.artifact);
			const expected = declared.outputs.find((item) => item.id === output.id);
			if (!expected || expected.path !== artifact.path || artifact.repositoryId !== scope.repositoryId || artifact.commit !== receipt.commit) {
				fail("parallel_output_mismatch", "Delivered output must match its immutable declared path, repository and commit");
			}
			checkComparison([artifact.path], artifact.digest);
			artifactBytes(repository, artifact);
			return { id: expected.id, artifact };
		}).sort((left, right) => compare(left.id, right.id));
		if (!same(outputs.map((output) => output.id), declared.outputs.map((output) => output.id).sort())) {
			fail("parallel_output_mismatch", "Delivery must contain all and only declared outputs exactly once");
		}
		return { receipt, delivery: { packageId, attempt, commit: receipt.commit, outputs }, worktreePath: absolutePath(current.worktreePath) };
	}
	/** @param {AttemptIdentity} attempt @param {import("../types/parallel.js").BootstrapBase} bootstrap
	 * @param {import("../types/parallel.js").PackageInput[]} supplied */
	function resolveCurrent(attempt, bootstrap, supplied) {
		const consumer = ownedAttempt(attempt), required = consumerPackage(consumer).inputs;
		const inputs = list(supplied, "inputs", 128).map(packageInput);
		const key = (/** @type {import("../types/parallel.js").PackageInput} */ input) => stableStringify(input);
		if (!same(inputs.map(key).sort(), required.map(key).sort())) fail("parallel_input_coverage", "The complete immutable predecessor set is required");
		for (const input of required) {
			const output = declaration.packages.find((item) => item.id === input.producer)?.outputs.find((item) => item.id === input.output);
			if (output) checkPolicy(output.path, input.destination);
		}
		const current = [...new Set(required.map((input) => input.producer))].sort().map(currentDelivery);
		const deliveries = current.map((item) => item.delivery);
		const resolved = required.map((input) => {
			const artifact = deliveries.find((item) => item.packageId === input.producer)?.outputs.find((output) => output.id === input.output)?.artifact;
			if (!artifact) fail("parallel_input_coverage", "A required predecessor output is missing");
			checkPolicy(artifact.path, input.destination, artifact.digest);
			return { ...input, artifact };
		}).sort((left, right) => compare(left.destination, right.destination));
		const body = { format: /** @type {const} */ ("foundry-reserved-inputs-v1"), consumer, bootstrap, deliveries, inputs: resolved };
		const descriptor = reservedInputs({ ...body, digest: analysisInputDigest(body) });
		assertInputCoverage(descriptor, required);
		requireCommit(repository, descriptor.bootstrap.commit);
		return { descriptor: freeze(descriptor), current, stamp: analysisInputDigest(current) };
	}

	/** @param {ReservedInputs} descriptor @param {ConsumerEntry} supplied */
	function authorizedEntry(descriptor, supplied) {
		const entry = consumerEntry(supplied, descriptor);
		const current = readAuthorizedConsumerEntry(descriptor);
		if (current === null) hold("parallel_consumer_held", "Current setup corroboration, successful attachment and unchanged handoff are required");
		if (!same(consumerEntry(current, descriptor), entry)) fail("parallel_consumer_mismatch", "Consumer does not match the authoritative attached and handed-off entry");
		return entry;
	}
	/** @param {ReservedInputs} descriptor @param {ConsumerEntry} entry @param {OwnedDelivery[]} deliveries @param {boolean} clean */
	function checkWorktree(descriptor, entry, deliveries, clean) {
		const root = entry.worktreePath;
		const forbidden = [repository, ...policy.forbiddenWorktreePaths, ...deliveries.map((item) => item.worktreePath)];
		if (forbidden.some((item) => overlaps(folded(root), folded(item)))) fail("parallel_consumer_worktree", "Consumer cannot be a producer, source or main worktree");
		const directory = gitPath(root, "--absolute-git-dir");
		if (realpathSync(root) !== root || gitPath(root, "--show-toplevel") !== root || gitPath(root, "--git-common-dir") !== common
			|| !directory.startsWith(`${common}${path.sep}worktrees${path.sep}`)
			|| !lstatSync(path.join(root, ".git")).isFile()
			|| path.resolve(directory, readFileSync(path.join(directory, "gitdir"), "utf8").trim()) !== path.join(root, ".git")) {
			fail("parallel_consumer_worktree", "Consumer must be an isolated canonical linked worktree of the pinned repository");
		}
		const worktrees = readGit(repository, ["worktree", "list", "--porcelain", "-z"]).toString("utf8").split("\0");
		if (!worktrees.includes(`worktree ${root}`)) fail("parallel_consumer_worktree", "Consumer worktree is not registered in the pinned repository");
		if (readGit(root, ["rev-parse", "--verify", "HEAD"]).toString("utf8").trim() !== descriptor.bootstrap.commit) {
			fail("parallel_bootstrap_mismatch", "Consumer HEAD must remain at the exact reserved bootstrap commit");
		}
		if (clean) {
			const index = readGit(root, ["ls-files", "-v", "-z"]).toString("utf8").split("\0").filter(Boolean);
			if (index.some((item) => item[0] !== "H")) {
				hold("parallel_bootstrap_unverifiable", "Sparse, assume-unchanged or unresolved index entries cannot corroborate a clean bootstrap");
			}
			if (readGit(root, ["-c", "core.filemode=true", "-c", "core.ignorestat=false", "-c", "core.untrackedCache=false",
				"status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]).length) {
				fail("parallel_bootstrap_dirty", "Consumer bootstrap worktree must be clean before materialization");
			}
		}
	}

	return {
		resolve(attempt, bootstrap, inputs) {
			const { descriptor, stamp } = resolveCurrent(attempt, bootstrap, inputs);
			const previous = resolutions.get(descriptor.digest);
			if (previous && previous !== stamp) fail("parallel_delivery_stale", "Previously reserved delivery authority changed");
			resolutions.set(descriptor.digest, stamp);
			return descriptor;
		},
		async materialize(value, supplied) {
			const descriptor = freeze(reservedInputs(value));
			assertInputCoverage(descriptor, consumerPackage(descriptor.consumer).inputs);
			const stamp = resolutions.get(descriptor.digest);
			if (!stamp) fail("parallel_input_unreserved", "Materialization requires this owner's resolved input descriptor");
			const entry = authorizedEntry(descriptor, supplied);
			const current = resolveCurrent(descriptor.consumer, descriptor.bootstrap, descriptor.inputs.map(({ producer, output, destination }) => ({ producer, output, destination })));
			if (!same(current.descriptor, descriptor) || current.stamp !== stamp) fail("parallel_delivery_stale", "Reserved predecessor receipt, attempt or delivered binding is no longer current");
			checkWorktree(descriptor, entry, current.current, true);
			const files = descriptor.inputs.map((input) => ({
				input, bytes: artifactBytes(repository, input.artifact), filename: destinationPath(entry.worktreePath, input.destination),
			}));
			authorizedEntry(descriptor, entry);
			checkWorktree(descriptor, entry, current.current, true);
			/** @type {{filename: string, dev: number, ino: number, directory: boolean}[]} */
			const created = [];
			try {
				for (const { input, bytes, filename } of files) {
					destinationPath(entry.worktreePath, input.destination);
					let parent = entry.worktreePath;
					for (const part of input.destination.split("/").slice(0, -1)) {
						parent = path.join(parent, part);
						if (!stat(parent)) {
							mkdirSync(parent, { mode: 0o700 });
							const identity = lstatSync(parent);
							created.push({ filename: parent, dev: identity.dev, ino: identity.ino, directory: true });
						}
					}
					destinationPath(entry.worktreePath, input.destination);
					const fd = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
					try {
						const identity = fstatSync(fd);
						created.push({ filename, dev: identity.dev, ino: identity.ino, directory: false });
						writeFileSync(fd, bytes);
						fchmodSync(fd, input.artifact.mode === "100755" ? 0o755 : 0o644);
					} finally { closeSync(fd); }
				}
				checkWorktree(descriptor, entry, current.current, false);
				for (const { filename, input } of files) {
					const actual = lstatSync(filename);
					if (!actual.isFile() || (actual.mode & 0o777) !== (input.artifact.mode === "100755" ? 0o755 : 0o644)
						|| sha256(readFileSync(filename)) !== input.artifact.digest) fail("parallel_materialization_changed", "Materialized bytes or modes changed");
				}
				return descriptor.inputs.map((input) => ({ ...input.artifact }));
			} catch (error) {
				const retained = [];
				for (const item of created.reverse()) {
					try {
						const actual = stat(item.filename);
						if (!actual) continue;
						if (realpathSync(path.dirname(item.filename)) !== path.dirname(item.filename)
							|| actual.dev !== item.dev || actual.ino !== item.ino) { retained.push(item.filename); continue; }
						if (item.directory) rmdirSync(item.filename); else unlinkSync(item.filename);
					} catch { retained.push(item.filename); }
				}
				if (retained.length) fail("parallel_materialization_rollback", "Rollback retained changed or externally populated paths", { retained, cause: errorCode(error) });
				throw error;
			}
		},
	};
}
