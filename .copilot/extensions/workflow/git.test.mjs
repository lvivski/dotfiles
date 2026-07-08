/** @module git.test — low-level spawnGit: success, non-zero (no reject), and spawn-error → code 127. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { spawnGit } from "./git.mjs";
import { tmpDir } from "./fixtures/support.mjs";

/** Create a temp git repo with one commit. @returns {string} */
function makeRepo() {
	const dir = tmpDir();
	const run = (/** @type {string[]} */ args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	run(["init", "-q", "-b", "main"]);
	run(["config", "user.email", "t@t"]);
	run(["config", "user.name", "t"]);
	writeFileSync(join(dir, "a.txt"), "hi");
	run(["add", "-A"]);
	run(["commit", "-q", "-m", "init"]);
	return dir;
}

test("spawnGit resolves { code:0, stdout, stderr:'' } on success", async () => {
	const r = await spawnGit(["rev-parse", "HEAD"], makeRepo());
	assert.equal(r.code, 0);
	assert.match(r.stdout.trim(), /^[0-9a-f]{40}$/);
	assert.equal(r.stderr, "");
});

test("spawnGit never rejects: a non-zero exit is returned as a code", async () => {
	const r = await spawnGit(["cat-file", "-e", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"], makeRepo());
	assert.notEqual(r.code, 0);
});

test("spawnGit reports a spawn failure (bad cwd) as code 127 with a message", async () => {
	const r = await spawnGit(["status"], join(tmpDir(), "does", "not", "exist"));
	assert.equal(r.code, 127);
	assert.ok(r.stderr.length > 0);
});

test("spawnGit bounds captured output to maxChars", async () => {
	const r = await spawnGit(["rev-parse", "HEAD"], makeRepo(), 8);
	assert.ok(r.stdout.length <= 8, `expected <= 8 chars, got ${r.stdout.length}`);
});
