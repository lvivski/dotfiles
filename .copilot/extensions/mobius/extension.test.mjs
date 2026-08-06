import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MOBIUS_CONVEYORS } from "./scripts.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const CONVEYOR_ROOT = path.resolve(ROOT, "conveyors");

async function sourceFiles(directory = ROOT) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== "test") files.push(...await sourceFiles(target));
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
    assert.deepEqual(manifest, { name: "mobius", version: 1 });

    const entry = await readFile(path.join(ROOT, "extension.mjs"), "utf8");
    assert.match(entry, /joinSession\(/);
    assert.match(entry, /buildMobiusTools/);
    assert.match(entry, /buildMobiusHooks/);
    assert.doesNotMatch(entry, /factor/i);
});

test("production source has no stdout logging or Minions dependency", async () => {
    for (const filename of await sourceFiles()) {
        const source = await readFile(filename, "utf8");
        assert.doesNotMatch(source, /\bconsole\.log\s*\(/, filename);
        assert.doesNotMatch(source, /(?:from|import\()\s*["'][^"']*minions/i, filename);
    }
});

test("pinned Mobius conveyors are restricted analysis-only scripts", async () => {
    for (const specification of Object.values(MOBIUS_CONVEYORS)) {
        const filename = path.join(
            CONVEYOR_ROOT,
            path.basename(specification.relativePath),
        );
        const source = await readFile(filename, "utf8");
        assert.equal(
            createHash("sha256").update(source).digest("hex"),
            specification.scriptSha256,
        );
        assert.match(source, /profile:\s*"none"/);
        assert.doesNotMatch(source, /profile:\s*"(?:inherit|research)"/);
        assert.doesNotMatch(source, /\bhost\./);
        assert.doesNotMatch(source, /\bworkspace\./);
    }
});
