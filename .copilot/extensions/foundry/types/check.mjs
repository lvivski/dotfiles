import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [sdk, compiler, typeRoots, dependencies] = process.argv.slice(2);
if (!sdk || !compiler || !typeRoots) throw new Error("Usage: node types/check.mjs SDK_DIRECTORY TSC_EXECUTABLE TYPE_ROOTS [DEPENDENCY_ROOT]");

/** @param {string} directory @returns {Promise<string[]>} */
async function sources(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	return (await Promise.all(entries.map(async entry => {
		const filename = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Refusing a source symlink: ${filename}`);
		if (entry.isDirectory()) return sources(filename);
		return /\.(mjs|js|ts)$/.test(entry.name) ? [filename] : [];
	}))).flat();
}
const temporary = await mkdtemp(path.join(os.tmpdir(), "foundry-sdk-check-"));
try {
	const configuration = JSON.parse(await readFile(path.join(root, "jsconfig.json"), "utf8"));
	const filename = path.join(temporary, "tsconfig.json");
	await writeFile(filename, JSON.stringify({
		compilerOptions: {
			...configuration.compilerOptions,
			typeRoots: [path.resolve(typeRoots)],
			paths: {
				"@github/copilot-sdk": [path.join(path.resolve(sdk), "index.d.ts")],
				"@github/copilot-sdk/extension": [path.join(path.resolve(sdk), "extension.d.ts")],
				...(dependencies ? { "vscode-jsonrpc/node.js": [path.join(path.resolve(dependencies), "vscode-jsonrpc/lib/node/main.d.ts")] } : {}),
			},
		},
		files: await sources(root),
	}));
	const result = spawnSync(process.execPath, [path.resolve(compiler), "--project", filename, "--pretty", "false"], { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.signal) throw new Error(`Type checking stopped with ${result.signal}`);
	process.exitCode = result.status ?? 1;
} finally {
	await rm(temporary, { recursive: true, force: true });
}
