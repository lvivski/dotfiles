import { createHash } from "node:crypto";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { fail } from "../factory/fields.mjs";
import { evaluatorBundle, repositoryPath } from "../factory/procedures.mjs";
import { git, requireCommit } from "./git.mjs";

/** @typedef {import("../types/factory.js").EvaluatorBundle} EvaluatorBundle */
/** @typedef {{path: string, mode: string, content: string}} Material */

const DEPENDENCY_FILES = [
	"package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
	".npmrc", ".yarnrc", ".yarnrc.yml", "pyproject.toml", "poetry.lock", "uv.lock", "requirements.txt", "Pipfile", "Pipfile.lock",
	"Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "Gemfile", "Gemfile.lock", "composer.json", "composer.lock",
	"deno.json", "deno.jsonc", "deno.lock",
];

/** Evaluator-owned transitive inputs still need explicit declaration. Ambient ancestor
 * manifests/locks must not be silently excluded from the protected material.
 * @param {string} repository @param {EvaluatorBundle} bundle @param {string} commit */
function requireDependencyMaterial(repository, bundle, commit) {
	const directories = new Set([""]);
	for (const entry of [bundle.root, ...bundle.support, bundle.invocation.cwd === "." ? "" : bundle.invocation.cwd]) {
		if (!entry) continue;
		const parts = entry.split("/");
		for (let length = 1; length <= parts.length; length++) directories.add(`${parts.slice(0, length).join("/")}/`);
	}
	const paths = [...directories].flatMap((directory) => DEPENDENCY_FILES.map((filename) => `${directory}${filename}`));
	const result = git(repository, ["ls-tree", "-z", "--full-tree", commit, "--", ...paths]);
	if (result.error || result.status !== 0) fail("factory_evaluator_unsupported", "Evaluator dependency declarations could not be inspected", { disposition: "inconclusive" });
	for (const entry of result.stdout.toString("utf8").split("\0").filter(Boolean)) {
		const filename = entry.slice(entry.indexOf("\t") + 1);
		if (![bundle.root, ...bundle.support].some((root) => filename === root || filename.startsWith(`${root}/`))) {
			fail("factory_evaluator_dependency_missing", "Declare ancestor dependency manifests/configuration/lock material in bundle.support", { path: filename });
		}
	}
}

/** @param {string} repository @param {EvaluatorBundle} bundle @param {string} commit @returns {Material[]} */
function material(repository, bundle, commit) {
	requireCommit(repository, commit);
	requireDependencyMaterial(repository, bundle, commit);
	for (const root of [bundle.root, ...bundle.support]) {
		const kind = git(repository, ["cat-file", "-t", `${commit}:${root}`]);
		if (kind.error || kind.status !== 0) fail("factory_evaluator_artifact_missing", "A declared evaluator bundle/support artifact is unavailable at the exact commit", { commit, path: root, disposition: "inconclusive" });
		if (root === bundle.root && kind.stdout.toString("utf8").trim() !== "tree") {
			fail("factory_evaluator_bundle_invalid", "The evaluator bundle must protect a complete directory, not only an entry file");
		}
	}
	if (bundle.invocation.cwd !== ".") {
		const kind = git(repository, ["cat-file", "-t", `${commit}:${bundle.invocation.cwd}`]);
		if (kind.status !== 0 || kind.stdout.toString("utf8").trim() !== "tree") fail("factory_evaluator_artifact_missing", "The declared invocation working directory is missing");
	}
	const listing = git(repository, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", bundle.root, ...bundle.support]);
	if (listing.error || listing.status !== 0) fail("factory_evaluator_unsupported", "The evaluator Git tree could not be inspected", { disposition: "inconclusive" });
	const listingText = listing.stdout.toString("utf8");
	if (!Buffer.from(listingText, "utf8").equals(listing.stdout)) fail("factory_evaluator_path_invalid", "Evaluator Git paths must be unambiguous UTF-8");
	const entries = listingText.split("\0").filter(Boolean);
	if (!entries.length) fail("factory_evaluator_capacity", "Evaluator bundles must contain regular files");
	const names = new Set();
	const files = entries.map((entry) => {
		const match = /^([0-9]{6}) (blob|commit) ([a-f0-9]+)\t(.+)$/s.exec(entry);
		if (!match || !["100644", "100755"].includes(match[1]) || match[2] !== "blob") {
			fail("factory_evaluator_path_invalid", "Evaluator material cannot contain symlinks, submodules or non-regular files");
		}
		const [, mode, , oid, name] = match;
		repositoryPath(name, "evaluator material");
		if (names.has(name.toLowerCase())) fail("factory_evaluator_path_invalid", "Evaluator paths cannot alias on case-insensitive worktrees");
		names.add(name.toLowerCase());
		const content = git(repository, ["cat-file", "blob", oid]);
		if (content.error || content.status !== 0) fail("factory_evaluator_artifact_missing", "The complete evaluator blob is unavailable", { path: name, disposition: "inconclusive" });
		if (content.stdout.subarray(0, 100).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1")) {
			fail("factory_evaluator_unsupported", "Git LFS pointers are not preserved executable evaluator content", { path: name, disposition: "unsupported" });
		}
		return { path: name, mode, content: content.stdout.toString("base64") };
	}).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	if (!files.some((file) => file.path === bundle.entryPoint)) fail("factory_evaluator_artifact_missing", "The declared evaluator entry point is not a regular protected file");
	return files;
}

/** Content hashes cover every byte and executable mode, not a caller-authored digest.
 * @param {Material[]} files */
export const materialManifest = (files) => files.map(({ path, mode, content }) => ({
	path, mode, digest: createHash("sha256").update(Buffer.from(content, "base64")).digest("hex"),
}));

/** Reads preserved bytes for acceptance and portable artifact publication; never executes repository code.
 * @param {string} repository @param {unknown} value */
export function resolveEvaluatorBundle(repository, value) {
	const bundle = evaluatorBundle(value);
	const files = material(repository, bundle, bundle.commit);
	const digest = analysisInputDigest({ format: "foundry-evaluator-bundle-v1", bundle, files: materialManifest(files) });
	return { bundle, digest, files };
}

/** @param {string} repository @param {import("../types/factory.js").EvaluationDefinition} definition @param {string} [candidateCommit]
 * @returns {import("../types/factory.js").EvaluationIdentity | null} */
export function checkEvaluator(repository, definition, candidateCommit) {
	if (definition.procedure.kind !== "command") return null;
	if (!definition.procedure.bundle) fail("factory_evaluator_unpinned", "Legacy command references are inspectable claims, not immutable executable bundles; explicitly accept a new evaluator revision");
	const pinned = resolveEvaluatorBundle(repository, definition.procedure.bundle);
	if (pinned.digest !== definition.procedure.digest) fail("factory_evaluator_changed", "The preserved Git content or invocation does not match the accepted evaluator digest");
	if (candidateCommit === undefined) return null;
	const candidate = material(repository, pinned.bundle, candidateCommit);
	if (stableStringify(materialManifest(candidate)) !== stableStringify(materialManifest(pinned.files))) {
		fail("factory_evaluator_changed", "The candidate changed protected evaluator/helper/fixture/dependency material; a new accepted evaluator revision is required");
	}
	return {
		version: 1, method: "protected-git-bundle", digest: pinned.digest,
		evaluatorCommit: pinned.bundle.commit, candidateCommit,
	};
}
