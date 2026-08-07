import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

test("share manifest and extension entry register the native Factory", () => {
	const manifest = JSON.parse(readFileSync(join(ROOT, "copilot-extension.json"), "utf8"));
	assert.deepEqual(manifest, { name: "conveyor", version: 1 });
	const entry = readFileSync(join(ROOT, "extension.mjs"), "utf8");
	assert.match(entry, /defineFactory/);
	assert.match(entry, /joinSession/);
	assert.match(entry, /factories:\s*\[conveyor\]/);
	assert.match(entry, /buildTools/);
});
