import { COMMIT, digest, fail, list, object, text } from "./fields.mjs";

/** @param {unknown} value @param {string} field @param {boolean} [allowRoot] */
export function repositoryPath(value, field, allowRoot = false) {
	const result = text(value, field);
	if (allowRoot && result === ".") return result;
	if (result !== result.normalize("NFC") || /[\u0000-\u0020\u007f\\:*?[\]]/.test(result)
		|| result.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
		|| result.startsWith("-")) {
		fail("factory_evaluator_path_invalid", `${field} must be an unambiguous repository-relative Git path`);
	}
	return result;
}

/** @param {unknown} value @returns {import("../types/factory.js").EvaluatorBundle} */
export function evaluatorBundle(value) {
	object(value, ["version", "commit", "root", "entryPoint", "support", "invocation"], "procedure.bundle");
	if (value.version !== 1) fail("factory_evaluator_unsupported", "Only evaluator bundle version 1 is supported");
	if (typeof value.commit !== "string" || !COMMIT.test(value.commit)) fail("factory_evaluator_commit_invalid", "An evaluator must name one full immutable Git commit");
	const root = repositoryPath(value.root, "bundle.root");
	const entryPoint = repositoryPath(value.entryPoint, "bundle.entryPoint");
	if (!entryPoint.startsWith(`${root}/`)) fail("factory_evaluator_path_invalid", "The evaluator entry point must be inside its protected bundle directory");
	const support = list(value.support, "bundle.support").map((entry) => repositoryPath(entry, "bundle.support"));
	const paths = [root, ...support];
	if (paths.some((entry, index) => paths.some((other, otherIndex) => index !== otherIndex
		&& (entry.toLowerCase() === other.toLowerCase() || entry.toLowerCase().startsWith(`${other.toLowerCase()}/`))))) {
		fail("factory_evaluator_path_invalid", "Evaluator bundle and support paths must be unique, non-overlapping roots");
	}
	object(value.invocation, ["argv", "cwd"], "bundle.invocation");
	const cwd = repositoryPath(value.invocation.cwd, "bundle.invocation.cwd", true);
	const argv = list(value.invocation.argv, "bundle.invocation.argv", undefined, 2).map((entry) => {
		const argument = text(entry, "bundle.invocation.argv");
		if (argument.includes("\0")) fail("factory_evaluator_unsupported", "Evaluator invocation arguments cannot contain NUL");
		return argument;
	});
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(argv[0])) fail("factory_evaluator_unsupported", "Evaluator invocation requires a literal executable name, not shell text or a host-specific path");
	const relativeEntry = cwd === "." ? entryPoint : entryPoint.startsWith(`${cwd}/`) ? entryPoint.slice(cwd.length + 1) : null;
	if (!relativeEntry || !argv.slice(1).some((entry) => entry === relativeEntry || entry === `./${relativeEntry}`)) {
		fail("factory_evaluator_unsupported", "The literal invocation must name the protected entry point relative to its working directory");
	}
	return { version: 1, commit: value.commit, root, entryPoint, support: support.sort(), invocation: { argv, cwd } };
}

/** @param {unknown} value @returns {import("../types/factory.js").EvaluationIdentity} */
export function evaluationIdentity(value) {
	object(value, ["version", "method", "digest", "evaluatorCommit", "candidateCommit"], "evidence.identity");
	if (value.version !== 1 || value.method !== "protected-git-bundle") fail("factory_evaluator_unsupported", "Unknown mechanical evaluator identity");
	for (const field of ["evaluatorCommit", "candidateCommit"]) {
		if (typeof value[field] !== "string" || !COMMIT.test(value[field])) fail("factory_evaluator_commit_invalid", `identity.${field} must be a full Git commit`);
	}
	return {
		version: 1, method: "protected-git-bundle", digest: digest(value.digest, "identity.digest"),
		evaluatorCommit: String(value.evaluatorCommit), candidateCommit: String(value.candidateCommit),
	};
}
