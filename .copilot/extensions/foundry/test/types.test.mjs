import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const grain = process.env.FOUNDRY_TYPES_GRAIN ?? fileURLToPath(new URL("../types/", import.meta.url));
const toolchain = fileURLToPath(new URL("../../../editor/node_modules/", import.meta.url));

/** @param {string} dir */
function contents(dir) {
	return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort().map(name => {
		const file = path.join(dir, name);
		return [name, statSync(file).isDirectory() ? null : createHash("sha256").update(readFileSync(file)).digest("hex")];
	});
}

test("the installed-SDK checker diagnoses errors in a companion extension without changing either tree", t => {
	const dir = mkdtempSync(path.join(tmpdir(), "sdk-contract-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const name of ["primary", "companion/nested", "sdk", "deps/vscode-jsonrpc/lib/node", "tmp"])
		mkdirSync(path.join(dir, name), { recursive: true });
	cpSync(grain, path.join(dir, "primary/types"), { recursive: true });
	copyFileSync(new URL("../jsconfig.json", import.meta.url), path.join(dir, "primary/jsconfig.json"));
	writeFileSync(path.join(dir, "sdk/index.d.ts"), "export declare const primarySDK: number;");
	writeFileSync(path.join(dir, "sdk/extension.d.ts"), "export declare const extensionSDK: number;");
	writeFileSync(path.join(dir, "deps/vscode-jsonrpc/lib/node/main.d.ts"), "export declare const transport: number;");
	writeFileSync(path.join(dir, "primary/use.ts"), 'import { primarySDK } from "@github/copilot-sdk"; export const total: number = primarySDK;');
	const companion = path.join(dir, "companion/nested/consumer.ts");
	const imports = 'import { extensionSDK } from "@github/copilot-sdk/extension"; import { transport } from "vscode-jsonrpc/node.js";';
	const exec = () => {
		const before = contents(dir);
		const result = spawnSync(process.execPath, ["primary/types/check.mjs", "sdk", path.join(toolchain, "typescript/bin/tsc"),
			path.join(toolchain, "@types"), "deps", "companion"], { cwd: dir,
			env: { ...process.env, TMPDIR: path.join(dir, "tmp"), NODE_DISABLE_COMPILE_CACHE: "1" }, encoding: "utf8" });
		assert.ifError(result.error);
		assert.equal(result.signal, null);
		assert.deepEqual(contents(dir), before, "the checker changed its inputs or left temporary files");
		return { status: result.status, diagnostics: result.stdout + result.stderr };
	};
	writeFileSync(companion, `${imports}\nexport const total: number = extensionSDK + transport;\n`);
	const good = exec();
	assert.equal(good.status, 0, good.diagnostics);
	writeFileSync(companion, `${imports}\nexport const total: number = "stale";\n`);
	const bad = exec();
	assert.notEqual(bad.status, 0, "the checker accepted the companion's bad type");
	assert.match(bad.diagnostics, /companion[/\\]nested[/\\]consumer\.ts\(\d+,\d+\): error TS2322\b/);
});
