import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { CONVEYOR_FACTORY_META } from "./factory.mjs";
import { extractMeta, stripExports } from "./source.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIRECTORIES = [
	join(ROOT, ".copilot", "conveyors"),
	join(ROOT, ".copilot", "skills", "conveyor", "examples"),
];

test("all shipped harnesses compile as native Factory workflows", () => {
	for (const directory of DIRECTORIES) {
		for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".mjs"))) {
			const filename = join(directory, name);
			const source = readFileSync(filename, "utf8");
			const metadata = extractMeta(source);
			assert.equal(typeof metadata.name, "string", filename);
			for (const [key, value] of Object.entries(metadata.limits)) {
				assert.ok(
					value <= CONVEYOR_FACTORY_META.limits[key],
					`${filename} ${key} exceeds the registered Conveyor Factory envelope`,
				);
			}
			new vm.Script(`(async () => {\n${stripExports(source)}\n})()`, { filename });
			assert.doesNotMatch(
				source,
				/\b(?:host|workspace)\.|\bcontext\.(?:dryRun|memory)\b|\b(?:profile|agentType|effort|cwd|validate|retries):|\bverify\s*\(/,
				filename,
			);
		}
	}
});
