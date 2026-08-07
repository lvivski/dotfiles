import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MOBIUS_CONVEYORS } from "./scripts.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const CONVEYOR_ROOT = path.resolve(ROOT, "conveyors");

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
            if (entry.name !== "test") files.push(...await sourceFiles(target));
        } else if (/\.(?:mjs|js)$/.test(entry.name)
            && !entry.name.endsWith(".test.mjs")
            && entry.name !== "worker.mjs") {
            files.push(target);
        }
    }
    return files;
}

/**
 * Lists hand-authored production modules covered by the JSDoc policy.
 *
 * Bundled Conveyor scripts are executable workflow artifacts with their own
 * schemas and prompts, so they are intentionally excluded.
 *
 * @returns {Promise<string[]>}
 */
async function documentedSourceFiles() {
    const rootEntries = await readdir(ROOT, { withFileTypes: true });
    const rendererEntries = await readdir(path.join(ROOT, "renderer"), {
        withFileTypes: true,
    });
    return [
        ...rootEntries
            .filter((entry) => entry.isFile()
                && entry.name.endsWith(".mjs")
                && !entry.name.endsWith(".test.mjs"))
            .map((entry) => path.join(ROOT, entry.name)),
        ...rendererEntries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
            .map((entry) => path.join(ROOT, "renderer", entry.name)),
    ].sort();
}

/**
 * Tests whether a declaration has an immediately adjacent JSDoc block.
 *
 * @param {string[]} lines
 * @param {number} index
 * @returns {boolean}
 */
function hasAdjacentJsDoc(lines, index) {
    let cursor = index - 1;
    while (cursor >= 0 && lines[cursor].trim().length === 0) cursor -= 1;
    return cursor >= 0 && lines[cursor].trim().endsWith("*/");
}

/**
 * Finds named callable and exported-constant declarations in one source file.
 *
 * @param {string[]} lines
 * @returns {Array<{index: number, name: string}>}
 */
function documentedDeclarations(lines) {
    const declarations = [];
    const patterns = [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/,
        /^\s*(?:export\s+)?class\s+([\w$]+)/,
        /^\s*(?:async\s+)?(constructor|toJSON|snapshot|close)\s*\(/,
        /^\s*export\s+const\s+([\w$]+)/,
    ];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        let matched = false;
        for (const pattern of patterns) {
            const match = line.match(pattern);
            if (match) {
                declarations.push({ index, name: match[1] });
                matched = true;
                break;
            }
        }
        if (matched) continue;
        const arrow = line.match(
            /^\s*(?:export\s+)?const\s+([\w$]+)\s*=\s*(?:async\b|\()/,
        );
        if (!arrow) continue;
        let candidate = line;
        let cursor = index;
        while (!candidate.includes("=>")
            && !candidate.includes(";")
            && cursor + 1 < lines.length) {
            cursor += 1;
            candidate += `\n${lines[cursor]}`;
        }
        if (candidate.includes("=>")) {
            declarations.push({ index, name: arrow[1] });
        }
    }
    return declarations;
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

test("hand-authored production modules keep applicable declarations documented", async () => {
    for (const filename of await documentedSourceFiles()) {
        const source = await readFile(filename, "utf8");
        const lines = source.split(/\r?\n/);
        assert.equal(
            source.trimStart().startsWith("/**"),
            true,
            `${filename} must begin with a module JSDoc block`,
        );
        for (const declaration of documentedDeclarations(lines)) {
            assert.equal(
                hasAdjacentJsDoc(lines, declaration.index),
                true,
                `${filename}:${declaration.index + 1} ${declaration.name} needs JSDoc`,
            );
        }
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
