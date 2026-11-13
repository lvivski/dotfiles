import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, open, openSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { open as openPromise } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isRecord, parseJson } from "../../data.mjs";
import { fixtureRoot, seedRepository } from "../git.mjs";
import { invocations, visualSelectors } from "./run.mjs";

const root = process.env.FOUNDRY_PARALLEL_SCRATCH;
assert.ok(root, "Run this suite with node test/parallel/run.mjs tests test/parallel/runner.test.mjs");
const outside = path.join(path.dirname(root), "forbidden-test-write");
const extension = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("selectors are explicit, absolute and exactly match the hash-pinned visual invocation", () => {
	const selected = invocations("tests", ["test/parallel/runner.test.mjs"]);
	assert.equal(selected.length, 1);
	assert.deepEqual(selected[0], ["--test", "--test-isolation=none", "--test-reporter=spec", fileURLToPath(import.meta.url)]);
	assert.equal(invocations("visual-baseline", []).length, 14);
	assert.equal(visualSelectors().length, 14);
	assert.throws(() => invocations("tests", []), /explicit test selectors/);
	assert.throws(() => invocations("tests", ["--test.test.mjs"]), /explicit test files/);
	assert.throws(() => invocations("tests", ["test/**/*.test.mjs"]), /explicit test files/);
	assert.throws(() => invocations("tests", [outside]), /explicit test files/);
	assert.throws(() => invocations("visual-baseline", ["test/parallel/runner.test.mjs"]), /cannot be replaced/);
	assert.throws(() => invocations("offline", ["--noCheck"]), /do not accept/);
	assert.throws(() => invocations("unknown", []), /Usage:/);
	assert.deepEqual(invocations("offline", [])[0].slice(1), [
		"--project", "jsconfig.json", "--typeRoots",
		path.resolve(extension, "../../skills/foundry/.parallel-check/toolchain/node_modules/@types"), "--pretty", "false",
	]);
	const native = invocations("native", [])[0];
	assert.equal(native[0], "types/check.mjs");
	assert.equal(native.length, 5);
});

test("legacy relative fixtures, directory fsync and all open variants stay usable", async (t) => {
	assert.ok(process.cwd().startsWith(`${root}${path.sep}`) || process.cwd() === root);
	for (const key of ["TMPDIR", "TMP", "TEMP"]) assert.equal(process.env[key], os.tmpdir());
	const directory = await fixtureRoot(t, "isolated-runner");
	seedRepository(directory);
	const descriptor = openSync(directory, "r");
	try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
	const filename = path.join(directory, "callback");
	const fd = await new Promise((resolve, reject) => open(filename, "w", (error, value) => error ? reject(error) : resolve(value)));
	writeFileSync(fd, "callback");
	fsyncSync(fd);
	closeSync(fd);
	const handle = await openPromise(path.join(directory, "promise"), "w");
	try { await handle.writeFile("promise"); await handle.sync(); } finally { await handle.close(); }
	assert.equal(readFileSync(filename, "utf8"), "callback");
});

test("external paths, symlink traversal, hardlinks and untracked handles are rejected", async () => {
	assert.throws(() => writeFileSync(outside, "no"), /Out-of-scratch/);
	assert.throws(() => mkdirSync(`${outside}-directory`), /Out-of-scratch/);
	const directory = mkdtempSync(path.join(os.tmpdir(), "links-"));
	const externalLink = path.join(directory, "external");
	symlinkSync(path.dirname(root), externalLink);
	assert.throws(() => writeFileSync(path.join(externalLink, "escaped"), "no"), /Out-of-scratch link traversal/);
	unlinkSync(externalLink);
	const target = path.join(directory, "target");
	writeFileSync(target, "before");
	const localLink = path.join(directory, "local");
	symlinkSync("target", localLink);
	writeFileSync(localLink, "after");
	assert.equal(readFileSync(target, "utf8"), "after");
	const { linkSync } = await import("node:fs");
	assert.throws(() => linkSync(fileURLToPath(import.meta.url), path.join(directory, "hardlink")), /Out-of-scratch/);
	const handle = await openPromise(fileURLToPath(import.meta.url), "r");
	try { assert.throws(() => handle.chmod(0o600), /Out-of-scratch/); }
	finally { await handle.close(); }
	assert.ok(!existsSync(outside));
});

test("SQLite named imports, CommonJS, sidecars, ATTACH, VACUUM and backup cannot write outside", async () => {
	const require = createRequire(import.meta.url);
	assert.throws(() => new DatabaseSync(`${outside}.sqlite`), /Out-of-scratch/);
	assert.throws(() => new (require("node:sqlite").DatabaseSync)(`${outside}.sqlite`), /Out-of-scratch/);
	const directory = mkdtempSync(path.join(os.tmpdir(), "sqlite-"));
	const filename = path.join(directory, "database");
	symlinkSync(path.dirname(root), `${filename}-wal`);
	assert.throws(() => new DatabaseSync(filename), /Out-of-scratch link traversal/);
	unlinkSync(`${filename}-wal`);
	const db = new DatabaseSync(filename);
	try {
		db.exec("CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('preserved')");
		assert.throws(() => db.exec(`ATTACH '${outside}.sqlite' AS external`), /not authorized|authorization denied/);
		assert.throws(() => db.exec(`ATTACH 'file:${outside}.sqlite?mode=rwc' AS external`), /not authorized|authorization denied/);
		assert.throws(() => db.exec(`VACUUM INTO '${outside}.sqlite'`), /not authorized|authorization denied/);
		assert.throws(() => backup(db, `${outside}.sqlite`), /Out-of-scratch/);
		await backup(db, path.join(directory, "backup"));
		db.exec(`ATTACH '${path.join(directory, "attached")}' AS local; CREATE TABLE local.example (value TEXT)`);
	} finally { db.close(); }
	const deferred = new DatabaseSync(":memory:", { open: false });
	deferred.open();
	try { assert.throws(() => deferred.exec(`ATTACH '${outside}.sqlite' AS external`), /not authorized|authorization denied/); }
	finally { deferred.close(); }
	assert.ok(!existsSync(`${outside}.sqlite`));
});

test("subprocesses get distinct temporary roots, preserve promisify and retain the write guard", async () => {
	const script = `import os from "node:os"; import assert from "node:assert/strict";
		import { writeFileSync } from "node:fs"; import { DatabaseSync } from "node:sqlite";
		for (const key of ["TMPDIR", "TMP", "TEMP"]) assert.equal(process.env[key], os.tmpdir());
		assert.throws(() => writeFileSync(${JSON.stringify(outside)}, "no"), /Out-of-scratch/);
		assert.throws(() => new DatabaseSync(${JSON.stringify(`${outside}.sqlite`)}), /Out-of-scratch/);
		console.log(os.tmpdir());`;
	const first = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
	assert.equal(first.status, 0, first.stderr);
	const second = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script]);
	assert.notEqual(first.stdout.trim(), second.stdout.trim());
	assert.ok(first.stdout.trim().startsWith(`${root}${path.sep}`));
	assert.throws(() => spawnSync(process.execPath, ["-e", ""], { env: { ...process.env, NODE_OPTIONS: "" } }), /dropped scratch write guard/);
	assert.throws(() => spawnSync(process.execPath, ["-e", ""], { shell: true }), /Shell subprocesses/);
	assert.throws(() => spawnSync("git", ["-C", extension, "status"]), /Out-of-scratch/);
	assert.throws(() => spawnSync("git", [`--output=${outside}`, "status"]), /Out-of-scratch/);
	assert.throws(() => execFileSync("sh", ["-c", "true"]), /Unapproved test executable/);
	const noSqlite = await promisify(execFile)(process.execPath, ["--no-experimental-sqlite", "--input-type=module", "-e",
		`try { await import("node:sqlite"); process.exitCode = 1; } catch { console.log("unavailable"); }`]);
	assert.equal(noSqlite.stdout.trim(), "unavailable");
});

test("inherited NODE_OPTIONS are refused with distinct durable evidence", () => {
	const runner = fileURLToPath(new URL("run.mjs", import.meta.url));
	const outputs = [];
	for (const selector of ["--invalid.test.mjs", "test/missing.test.mjs"]) {
		const result = spawnSync(process.execPath, [runner, "tests", selector], { encoding: "utf8", cwd: extension });
		assert.equal(result.status, 1);
		const match = /Evidence: (.+)/.exec(result.stdout);
		assert.ok(match, result.stderr);
		const evidence = parseJson(readFileSync(match[1], "utf8"));
		assert.ok(isRecord(evidence));
		assert.equal(evidence.exitStatus, 1);
		assert.ok(typeof evidence.error === "string");
		assert.match(evidence.error, /Inherited NODE_OPTIONS must be explicitly removed/);
		assert.deepEqual(evidence.commands, []);
		outputs.push(evidence.output);
	}
	assert.notEqual(outputs[0], outputs[1]);
});
