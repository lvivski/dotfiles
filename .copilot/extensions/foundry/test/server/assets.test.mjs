import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { RENDERER_SCRIPTS } from "../../server/assets.mjs";

test("renderer assigns plan-authored content through textContent", async () => {
	const script = (await Promise.all(RENDERER_SCRIPTS.map((name) =>
		readFile(new URL(`../../renderer/${name}`, import.meta.url), "utf8")))).join("\n");
	assert.doesNotMatch(script, /\.innerHTML\s*=/);
	assert.match(script, /\.textContent\s*=/);
});
