import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { analysisInputDigest } from "../digest.mjs";

export const EVALUATOR_FILES = {
	"evaluators/check.mjs": "import assert from 'node:assert/strict';\nimport { check } from './helper.mjs';\nimport { preserve } from '../implementation.mjs';\nassert.ok(check(preserve));\n",
	"evaluators/helper.mjs": "import { readFileSync } from 'node:fs';\nconst fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));\nexport const check = (preserve) => { const input = fixture.ids.map(id => ({id})); return preserve(input)[0].id === input[0].id; };\n",
	"evaluators/fixture.json": "{\"ids\":[\"a\"]}\n",
	"package.json": "{\"private\":true,\"type\":\"module\"}\n",
	"package-lock.json": "{\"lockfileVersion\":3,\"requires\":true,\"packages\":{}}\n",
	"implementation.mjs": "export const preserve = (input) => input.map(value => ({...value}));\n",
};

/** @param {string} type @param {Buffer | string} value */
const oid = (type, value) => {
	const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
	return createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
};

/** @param {Record<string, string>} files @param {string} [prefix] @returns {string} */
const tree = (files, prefix = "") => {
	const names = [...new Set(Object.keys(files).filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length).split("/")[0]))];
	const entries = names.map((name) => {
		const file = files[`${prefix}${name}`];
		const directory = file === undefined;
		return { name, directory, oid: directory ? tree(files, `${prefix}${name}/`) : oid("blob", file) };
	}).sort((left, right) => `${left.name}${left.directory ? "/" : ""}` < `${right.name}${right.directory ? "/" : ""}` ? -1 : 1);
	return oid("tree", Buffer.concat(entries.map((entry) => Buffer.concat([
		Buffer.from(`${entry.directory ? "40000" : "100644"} ${entry.name}\0`), Buffer.from(entry.oid, "hex"),
	]))));
};

/** @param {string} treeId */
const commitObject = (treeId) => `tree ${treeId}\nauthor Foundry fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Foundry fixture <fixture@example.invalid> 1700000000 +0000\n\nImmutable evaluator fixture\n`;

export const COMMIT = oid("commit", commitObject(tree(EVALUATOR_FILES)));
export const BUNDLE = {
	version: /** @type {const} */ (1), commit: COMMIT, root: "evaluators", entryPoint: "evaluators/check.mjs",
	support: ["package-lock.json", "package.json"], invocation: { argv: ["node", "evaluators/check.mjs"], cwd: "." },
};
export const DIGEST = analysisInputDigest({
	format: "foundry-evaluator-bundle-v1", bundle: BUNDLE,
	files: Object.entries(EVALUATOR_FILES).filter(([filename]) => filename !== "implementation.mjs")
		.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
		.map(([filename, content]) => ({ path: filename, mode: "100644", digest: createHash("sha256").update(content).digest("hex") })),
});
export const PROCEDURE = { kind: /** @type {const} */ ("command"), ref: "node evaluators/check.mjs", digest: DIGEST, bundle: BUNDLE };

/** @param {string} directory @param {...string} args */
export const git = (directory, ...args) => execFileSync("git", ["--no-pager", "-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Actual tiny Git objects, shared by protocol fixtures instead of accepting invented hashes.
 * @param {string} directory */
export function seedRepository(directory) {
	mkdirSync(directory, { recursive: true });
	git(directory, "init", "--quiet", "-b", "main");
	for (const [filename, content] of Object.entries(EVALUATOR_FILES)) {
		mkdirSync(path.dirname(path.join(directory, filename)), { recursive: true });
		writeFileSync(path.join(directory, filename), content);
	}
	git(directory, "add", "--", ...Object.keys(EVALUATOR_FILES));
	const treeId = git(directory, "write-tree");
	const commit = execFileSync("git", ["-C", directory, "hash-object", "-w", "-t", "commit", "--stdin"], { input: commitObject(treeId), encoding: "utf8" }).trim();
	if (commit !== COMMIT) throw new Error("The shared Git evaluator fixture is not deterministic");
	git(directory, "update-ref", "refs/heads/main", commit);
	git(directory, "reset", "--hard", "--quiet", commit);
	return commit;
}

/** @param {import("node:test").TestContext} t @param {string} name */
export async function fixtureRoot(t, name) {
	const root = path.resolve(`.foundry-${name}-${randomUUID()}`);
	await mkdir(root, { mode: 0o700 });
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}
