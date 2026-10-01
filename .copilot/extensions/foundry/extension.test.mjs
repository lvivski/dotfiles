import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FOUNDRY_WORKFLOWS } from "./workflow.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const WORKFLOW_ROOT = path.resolve(ROOT, "workflows");

/**
 * Recursively lists production JavaScript used by extension safety checks.
 *
 * @param {string} [directory]
 * @returns {Promise<string[]>}
 */
async function sourceFiles(directory = ROOT) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
			if (entry.name !== "test") {
				files.push(...await sourceFiles(target));
			}
        } else if (/\.(?:mjs|js)$/.test(entry.name)
            && !entry.name.endsWith(".test.mjs")
            && entry.name !== "worker.mjs") {
            files.push(target);
        }
    }
    return files;
}

test("share manifest and extension entry point satisfy discovery contracts", async () => {
    const manifest = JSON.parse(await readFile(
        path.join(ROOT, "copilot-extension.json"),
        "utf8",
    ));
    assert.deepEqual(manifest, { name: "foundry" });

    const entry = await readFile(path.join(ROOT, "extension.mjs"), "utf8");
    assert.match(entry, /joinSession\(/);
    assert.match(entry, /buildFoundryTools/);
    assert.match(entry, /buildFoundryHooks/);
    assert.match(entry, /defineWorkflow/);
    assert.match(entry, /joinSession\(\{\s+workflows,/);
    assert.match(entry, /session\?\.workflow\b/);
});

test("production source has no stdout logging", async () => {
    for (const filename of await sourceFiles()) {
        const source = await readFile(filename, "utf8");
        assert.doesNotMatch(source, /\bconsole\.log\s*\(/, filename);
    }
});

test("bundled workflows use only native Workflow primitives", async () => {
	const expectedTimeouts = {
		audit: 900,
		"deep-research": 3600,
		plan: 900,
		"review-queue": 3600,
		"security-review": 3600,
		triage: 900,
		verify: 900,
	};
    for (const specification of Object.values(FOUNDRY_WORKFLOWS)) {
		assert.ok(
			specification.meta.phases.every(
				(phase) => typeof phase?.title === "string" && phase.title.trim(),
			),
		);
		assert.equal(specification.meta.limits.maxAiCredits, 10000);
		assert.equal(
			specification.meta.limits.timeoutSeconds,
			expectedTimeouts[specification.meta.name],
		);
		const filename = path.join(WORKFLOW_ROOT, `${specification.meta.name}.mjs`);
        const source = await readFile(filename, "utf8");
		assert.match(source, new RegExp(`name:\\s*"${specification.meta.name}"`));
		assert.doesNotMatch(source, /\b(?:profile|agentType|effort|cwd|validate|retries):/);
        assert.doesNotMatch(source, /\bhost\./);
        assert.doesNotMatch(source, /\bworkspace\./);
    }
});
