import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { admitted, boundWriter, reserveNotice } from "./native.mjs";
import { owns } from "./plan.mjs";
import { touchesCut } from "./transfer.mjs";
import { writerRoot } from "./workspace.mjs";
import { commitAt, generationRoot, pinFile } from "./product.mjs";
import { covers, fail, members, names, relative, text, roots as scopePaths } from "./values.mjs";

/** @typedef {import("./model.js").Artifact} Artifact */
/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** Capture once outside the lock. The returned ledger update rechecks authority, not the file.
 * @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} args */
export function preparePublication(cwd, run, actor, args) {
	const file = relative(args.file);
	if (!Array.isArray(args.to)) fail("invalid_recipient", "Expected a list of recipient directories");
	const to = [...new Set(args.to.map(relative))].sort();

	/** @param {Run} current */
	function authorize(current) {
		admitted(current);
		const dirs = new Set(Object.values(current.nodes).flatMap(n => scopePaths(n.grain.directory)));
		if (!to.length || !to.every(dir => dirs.has(dir) || current.policy.squads.some(s => "areas" in s && owns(s, dir))))
			fail("invalid_recipient", "Name a recipient assignment directory or a path within a charter area");
		if (actor === current.owner && args.token === undefined) return;
		const node = boundWriter(current, actor, text(args.token, "assignment token"));
		if (node.state !== "writing") fail("stale_assignment", "This assignment is no longer writing");
		if (!covers(node.grain.directory, file) || touchesCut(node.retained ?? [],file)) fail("charter_scope", "File is outside the publisher's assignment");
		return text(node.generation, "generation");
	}

	const generation = authorize(run);
	if (generation) {
		cwd = writerRoot(cwd,run,boundWriter(run,actor,text(args.token,"assignment token")));
		generationRoot(cwd, generation);
	}
	const base = generation ?? commitAt(cwd, "HEAD");
	const artifact = { file, blob: pinFile(cwd, file), base, publisher: actor, to };
	return (/** @type {Run} */ current) => {
		authorize(current);
		const items = current.artifacts ??= [];
		if (!items.some(a => isDeepStrictEqual(a, artifact))) items.push(artifact);
	};
}

/** @param {Artifact} a @param {Node} n */
export const offered = (a, n) => scopePaths(n.grain.directory).some(dir => covers(a.to,dir));

/** @param {Run} run @param {Node} node @param {number} [since] */
const offersFor = (run, node, since = 0) => run.artifacts?.slice(since).filter(a => offered(a, node)) ?? [];

/** @param {Run} run @param {Node} node @param {Record<string,unknown>} args */
export function reportedReferences(run, node, args) {
	const allowed = new Set(offersFor(run, node).map(a => a.blob));
	/** @type {import("./model.js").ArtifactReport} */ const report = {};
	for (const key of /** @type {const} */ (["usedArtifacts", "comparedArtifacts"])) {
		if (args[key] === undefined) continue;
		const blobs = names(args[key], `${key} blob`);
		if (blobs.some(blob => !allowed.has(blob))) fail("foreign_artifact", "Artifact version was not offered to this assignment");
		if (blobs.length) report[key] = blobs;
	}
	return report;
}

/** Materialize untouched bytes outside the worktree; the suffix is data, not shell syntax.
 * @param {Artifact} a */
export function materialize(a) {
	const suffix = path.extname(a.file).replace(/[^A-Za-z0-9.]/g, "");
	return `d=$(mktemp -d) && p="$d/reference${suffix}" && git --no-replace-objects cat-file blob ${a.blob} > "$p" && printf '%s\\n' "$p"`;
}

/** @param {Run} run @param {Node} n @param {string} [issuer] */
export function takeArtifactBrief(run, n, issuer) {
	const items = offersFor(run, n, n.artifactCursor);
	if (!items.length || issuer && issuer !== run.owner && issuer !== n.worker && items.some(a => a.publisher !== issuer)) return "";
	n.artifactCursor = run.artifacts?.length;
	return ["Read-only reference material (not a change in scope or evidence of comparison). From your worktree, extract the selected version and inspect the resulting file:",
		...items.map(a => `${JSON.stringify(a.file)} from ${a.base} (working copy), supplied by ${JSON.stringify(a.publisher)}:\n${materialize(a)}`),
		"At submit, optionally list exact blobs in usedArtifacts, or comparedArtifacts if you actually compared the product. Missing observation is not a match."].join("\n");
}

/** @param {Run} run @param {string} actor */
export function notifyWriters(run, actor) {
	if (!run.artifacts?.length) return;
	for (const n of Object.values(run.nodes)) {
		if (n.state !== "writing" || !n.worker || !n.token) continue;
		const body = takeArtifactBrief(run, n, actor);
		if (body) reserveNotice(run, actor, n.token, "artifact", body, n);
	}
}
