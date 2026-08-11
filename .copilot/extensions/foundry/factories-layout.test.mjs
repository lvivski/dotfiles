import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FOUNDRY_FACTORIES } from "./factory.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const FACTORY_DIR = join(ROOT, "factories");

test("factory modules match the registry and declare every phase they use", () => {
	const filenames = readdirSync(FACTORY_DIR)
		.filter((entry) => entry.endsWith(".mjs"))
		.sort();
	const definitions = Object.values(FOUNDRY_FACTORIES);
	assert.deepEqual(
		filenames,
		definitions.map(({ meta }) => `${meta.name}.mjs`).sort(),
	);

	for (const { meta } of definitions) {
		const filename = join(FACTORY_DIR, `${meta.name}.mjs`);
		const source = readFileSync(filename, "utf8");
		const usedPhases = [...source.matchAll(/\bphase\("([^"]+)"\)/g)].map((match) => match[1]);
		assert.deepEqual(usedPhases, meta.phases.map(({ title }) => title), filename);
		assert.match(source, /export async function run\(factory\)/);
		assert.doesNotMatch(
			source,
			/run_conveyor|runHarness|stripExports|scriptPath|node:vm|context\.args/,
			filename,
		);
	}
});
