import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** @typedef {import("node:test").TestContext} TestContext */
/** @type {WeakMap<TestContext, Map<number,string>>} */
const readers = new WeakMap();
const archive = fileURLToPath(new URL("./fixtures/legacy-readers.tar.xz", import.meta.url));

/** These are framework modules only. Every repo, ledger, worker and result
 * is created by the test; the old and new runtimes operate on the same fixture.
 * @param {TestContext} t @param {number} version */
function directory(t, version) {
	let opened = readers.get(t);
	if (!opened) readers.set(t, opened = new Map());
	const existing = opened.get(version);
	if (existing) return existing;
	assert.ok([22,51,52,54,55,56,58,59,60,61,64,79].includes(version), `Unknown fixture reader ${version}`);
	const root = mkdtempSync(path.join(tmpdir(), "foundry-reader-"));
	t.after(() => rmSync(root, {recursive:true, force:true}));
	execFileSync("tar", ["-xf", archive, "-C", root, String(version)]);
	const dir = path.join(root, String(version));
	assert.equal(readFileSync(path.join(dir, "work/reader.version"), "utf8").trim(), String(version));
	mkdirSync(path.join(dir, "test"));
	copyFileSync(new URL("./fixture.mjs", import.meta.url), path.join(dir, "test/fixture.mjs"));
	opened.set(version, dir);
	return dir;
}

/** @param {TestContext} t @param {number} version @returns {Promise<typeof import("../work/runtime.mjs").createRuntime>} */
export async function historicalRuntime(t, version) {
	return (await import(pathToFileURL(path.join(directory(t, version), "work/runtime.mjs")).href)).createRuntime;
}

/** @param {TestContext} t @param {number} version @returns {Promise<typeof import("./fixture.mjs").factory>} */
export async function historicalFactory(t, version) {
	return (await import(pathToFileURL(path.join(directory(t, version), "test/fixture.mjs")).href)).factory;
}
