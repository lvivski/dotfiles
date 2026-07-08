/** @module hostio.test — curated host I/O: read-only git guard, fs reads, gated writes, pure parseDiff. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { HostIO, parseDiff, pathHelpers, _READ_ONLY_GIT } from "./hostio.mjs";
import { tmpDir } from "./fixtures/support.mjs";

/** Create a temp git repo with one commit. @returns {string} */
function makeRepo() {
	const dir = tmpDir();
	const run = (/** @type {string[]} */ args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	run(["init", "-q", "-b", "main"]);
	run(["config", "user.email", "t@t"]);
	run(["config", "user.name", "t"]);
	writeFileSync(join(dir, "a.txt"), "one\n");
	run(["add", "-A"]);
	run(["commit", "-q", "-m", "init"]);
	return dir;
}

// ---- pure helpers ---------------------------------------------------------

test("path helpers are pure string math", () => {
	assert.equal(pathHelpers.basename("a/b/c.ts"), "c.ts");
	assert.equal(pathHelpers.dirname("a/b/c.ts"), "a/b");
	assert.equal(pathHelpers.extname("a/b/c.ts"), ".ts");
	assert.equal(pathHelpers.join("a", "b", "c"), join("a", "b", "c"));
	assert.equal(pathHelpers.relative("a/b", "a/b/c"), "c");
});

test("parseDiff extracts files, hunks, and 1-based line numbers", () => {
	const diff = [
		"diff --git a/src/x.ts b/src/x.ts",
		"index 111..222 100644",
		"--- a/src/x.ts",
		"+++ b/src/x.ts",
		"@@ -10,3 +10,4 @@ function f() {",
		" const a = 1;",
		"-const b = 2;",
		"+const b: number = 2;",
		"+const c = 3;",
		" return a;",
		"diff --git a/y.ts b/y.ts",
		"--- a/y.ts",
		"+++ b/y.ts",
		"@@ -1 +1 @@",
		"-old",
		"+new",
	].join("\n");
	const files = parseDiff(diff);
	assert.equal(files.length, 2);
	assert.equal(files[0].path, "src/x.ts");
	assert.equal(files[0].hunks.length, 1);
	const adds = files[0].hunks[0].changes.filter((c) => c.type === "add");
	assert.deepEqual(
		adds.map((c) => [c.text, c.newLine]),
		[["const b: number = 2;", 11], ["const c = 3;", 12]],
	);
	const del = files[0].hunks[0].changes.find((c) => c.type === "del");
	assert.equal(del?.oldLine, 11);
	assert.equal(files[1].path, "y.ts");
});

test("parseDiff handles new-file (/dev/null) headers", () => {
	const files = parseDiff(["diff --git a/n.ts b/n.ts", "--- /dev/null", "+++ b/n.ts", "@@ -0,0 +1 @@", "+hi"].join("\n"));
	assert.equal(files[0].path, "n.ts");
	assert.equal(files[0].oldPath, ""); // /dev/null ignored
});

// ---- git (read-only) ------------------------------------------------------

test("git() runs read-only subcommands and returns stdout", async () => {
	const repo = makeRepo();
	const host = new HostIO({ cwd: repo });
	const sha = await host.git("rev-parse", "HEAD");
	assert.match(sha, /^[0-9a-f]{40}$/);
	writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
	const names = await host.git("diff", "--name-only");
	assert.equal(names, "a.txt");
});

test("git() rejects mutating subcommands, leading flags, and empty args", async () => {
	const host = new HostIO({ cwd: makeRepo() });
	await assert.rejects(host.git("commit", "-m", "x"), /not a read-only subcommand/);
	await assert.rejects(host.git("push"), /not a read-only subcommand/);
	await assert.rejects(host.git("--version"), /needs a subcommand first/);
	await assert.rejects(host.git(), /needs a subcommand first/);
	// the allowlist stays conservative
	assert.ok(_READ_ONLY_GIT.has("diff") && !_READ_ONLY_GIT.has("commit"));
});

test("git() is forbidden in restricted mode", async () => {
	const host = new HostIO({ cwd: makeRepo(), restricted: true });
	await assert.rejects(host.git("rev-parse", "HEAD"), /forbidden in restricted mode/);
});

// ---- reads ----------------------------------------------------------------

test("files.readText / readJson / exists resolve against the run cwd", async () => {
	const dir = tmpDir();
	writeFileSync(join(dir, "data.json"), '{"b":2,"a":1}');
	const host = new HostIO({ cwd: dir });
	assert.equal(await host.files.readText("data.json"), '{"b":2,"a":1}');
	assert.deepEqual(await host.files.readJson("data.json"), { a: 1, b: 2 });
	assert.equal(await host.files.exists("data.json"), true);
	assert.equal(await host.files.exists("missing.json"), false);
});

test("files.readJson reports invalid JSON with the path", async () => {
	const dir = tmpDir();
	writeFileSync(join(dir, "bad.json"), "{nope}");
	const host = new HostIO({ cwd: dir });
	await assert.rejects(host.files.readJson("bad.json"), /invalid JSON/);
});

test("files.glob is deterministic and prunes node_modules + dotfiles", async () => {
	const dir = tmpDir();
	for (const p of ["pkg/sub", "pkg/node_modules/dep", ".hidden"]) mkdirSync(join(dir, p), { recursive: true });
	writeFileSync(join(dir, "pkg/package.json"), "{}");
	writeFileSync(join(dir, "pkg/sub/package.json"), "{}");
	writeFileSync(join(dir, "pkg/node_modules/dep/package.json"), "{}");
	writeFileSync(join(dir, ".hidden/package.json"), "{}");
	writeFileSync(join(dir, "root.ts"), "");
	const host = new HostIO({ cwd: dir });
	assert.deepEqual(await host.files.glob("**/package.json"), ["pkg/package.json", "pkg/sub/package.json"]);
	assert.deepEqual(await host.files.glob("*.ts"), ["root.ts"]);
});

// ---- writes (gated) -------------------------------------------------------

test("files.writeText / writeJson round-trip and create parent dirs", async () => {
	const dir = tmpDir();
	const host = new HostIO({ cwd: dir });
	await host.files.writeText("out/note.txt", "hello");
	assert.equal(readFileSync(join(dir, "out/note.txt"), "utf8"), "hello");
	await host.files.writeJson("out/manifest.json", { b: 2, a: 1 });
	// keys sorted, pretty, trailing newline
	assert.equal(readFileSync(join(dir, "out/manifest.json"), "utf8"), '{\n  "a": 1,\n  "b": 2\n}\n');
});

test("writes no-op under dry-run (and log the skip) but reads still work", async () => {
	const dir = tmpDir();
	const logs = /** @type {string[]} */ ([]);
	const host = new HostIO({ cwd: dir, dryRun: true, log: (s) => logs.push(s) });
	await host.files.writeText("skip.txt", "x");
	assert.equal(existsSync(join(dir, "skip.txt")), false);
	assert.ok(logs.some((l) => /dry-run/.test(l)));
});

test("writes are forbidden in restricted mode", async () => {
	const host = new HostIO({ cwd: tmpDir(), restricted: true });
	await assert.rejects(host.files.writeText("x.txt", "y"), /forbidden in restricted mode/);
	await assert.rejects(host.files.writeJson("x.json", {}), /forbidden in restricted mode/);
});
