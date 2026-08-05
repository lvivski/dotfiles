import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findRepositoryRoot, projectConveyorDirs, resolveConveyorDefinition } from "./registry.mjs";
import { tmpDir } from "./fixtures/support.mjs";

test("nearest project conveyor wins before repository and user scopes", () => {
	const repo = tmpDir();
	mkdirSync(join(repo, ".git"));
	const nested = join(repo, "packages", "app");
	mkdirSync(nested, { recursive: true });
	const user = tmpDir();
	for (const [dir, text] of [
		[join(repo, ".copilot", "conveyors"), "repo"],
		[join(nested, ".copilot", "conveyors"), "nested"],
		[user, "user"],
	]) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "demo.mjs"), text);
	}
	const found = resolveConveyorDefinition("demo", { cwd: nested, userDir: user });
	assert.equal(found?.scope, "project");
	assert.equal(found?.root, join(nested, ".copilot", "conveyors"));
	assert.equal(findRepositoryRoot(nested), repo);
	assert.deepEqual(projectConveyorDirs(nested).slice(-1), [join(repo, ".copilot", "conveyors")]);
});

test("user conveyor is the fallback outside a repository", () => {
	const cwd = tmpDir();
	const user = tmpDir();
	writeFileSync(join(user, "demo.mjs"), "user");
	assert.equal(resolveConveyorDefinition("demo", { cwd, userDir: user })?.scope, "user");
});

test("conveyor symlinks escaping their scope are rejected", () => {
	const repo = tmpDir();
	mkdirSync(join(repo, ".git"));
	const dir = join(repo, ".copilot", "conveyors");
	mkdirSync(dir, { recursive: true });
	const outside = join(tmpDir(), "outside.mjs");
	writeFileSync(outside, "outside");
	symlinkSync(outside, join(dir, "escape.mjs"));
	assert.equal(resolveConveyorDefinition("escape", { cwd: repo, userDir: tmpDir() }), null);
});
