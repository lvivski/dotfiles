import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findRepositoryRoot, projectWorkflowDirs, resolveWorkflowDefinition } from "./registry.mjs";
import { tmpDir } from "./fixtures/support.mjs";

test("nearest project workflow wins before repository and user scopes", () => {
	const repo = tmpDir();
	mkdirSync(join(repo, ".git"));
	const nested = join(repo, "packages", "app");
	mkdirSync(nested, { recursive: true });
	const user = tmpDir();
	for (const [dir, text] of [
		[join(repo, ".copilot", "workflows"), "repo"],
		[join(nested, ".copilot", "workflows"), "nested"],
		[user, "user"],
	]) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "demo.mjs"), text);
	}
	const found = resolveWorkflowDefinition("demo", { cwd: nested, userDir: user });
	assert.equal(found?.scope, "project");
	assert.equal(found?.root, join(nested, ".copilot", "workflows"));
	assert.equal(findRepositoryRoot(nested), repo);
	assert.deepEqual(projectWorkflowDirs(nested).slice(-1), [join(repo, ".copilot", "workflows")]);
});

test("user workflow is the fallback outside a repository", () => {
	const cwd = tmpDir();
	const user = tmpDir();
	writeFileSync(join(user, "demo.mjs"), "user");
	assert.equal(resolveWorkflowDefinition("demo", { cwd, userDir: user })?.scope, "user");
});

test("workflow symlinks escaping their scope are rejected", () => {
	const repo = tmpDir();
	mkdirSync(join(repo, ".git"));
	const dir = join(repo, ".copilot", "workflows");
	mkdirSync(dir, { recursive: true });
	const outside = join(tmpDir(), "outside.mjs");
	writeFileSync(outside, "outside");
	symlinkSync(outside, join(dir, "escape.mjs"));
	assert.equal(resolveWorkflowDefinition("escape", { cwd: repo, userDir: tmpDir() }), null);
});
