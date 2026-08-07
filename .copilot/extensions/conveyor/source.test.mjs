import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { extractMeta, resolveSource, stripExports } from "./source.mjs";
import { tmpDir } from "./fixtures/support.mjs";

test("extractMeta reads native Factory metadata", () => {
	const meta = extractMeta(`export const meta = {
		name: "audit",
		description: "Audit files.",
		limits: { maxConcurrentSubagents: 2, maxAiCredits: 5 },
	};`);
	assert.deepEqual(meta, {
		name: "audit",
		description: "Audit files.",
		limits: { maxConcurrentSubagents: 2, maxAiCredits: 5 },
	});
});

test("extractMeta rejects pre-Factory limit names", () => {
	assert.throws(
		() => extractMeta(`export const meta = { limits: { agents: 2 } };`),
		/unknown Factory limit/,
	);
});

test("extractMeta rejects metadata with no Factory launch effect", () => {
	assert.throws(
		() => extractMeta(`export const meta = { phases: ["Review"] };`),
		/unknown Conveyor metadata field 'phases'/,
	);
});

test("stripExports preserves source positions", () => {
	const source = "export const meta = {};\nexport async function work() {}\n";
	const stripped = stripExports(source);
	assert.equal(stripped.length, source.length);
	assert.doesNotMatch(stripped, /\bexport\b/);
});

test("resolveSource honors nearest project then user definitions", () => {
	const repo = tmpDir();
	mkdirSync(join(repo, ".git"));
	const nested = join(repo, "packages", "app");
	const project = join(nested, ".copilot", "conveyors");
	const user = tmpDir();
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, "demo.mjs"), `export const meta = { name: "demo" }; return "project";`);
	writeFileSync(join(user, "demo.mjs"), `export const meta = { name: "demo" }; return "user";`);
	const resolved = resolveSource({ name: "demo" }, { cwd: nested, userDir: user });
	assert.match(resolved.source, /project/);
	assert.equal(resolved.name, "demo");
});

test("resolveSource requires exactly one source and strict names", () => {
	assert.throws(() => resolveSource({}, { cwd: tmpDir() }), /exactly one/);
	assert.throws(
		() => resolveSource({ script: "return 1", name: "demo" }, { cwd: tmpDir() }),
		/exactly one/,
	);
	assert.throws(
		() => resolveSource({ name: "../escape" }, { cwd: tmpDir() }),
		/name must contain/,
	);
});
