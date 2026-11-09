/**
 * Check every owned source against the installed SDK, independently of the
 * offline declarations, then compare the offline contracts to the real API.
 *
 * Usage: node types/check.mjs SDK_DIRECTORY TSC_EXECUTABLE TYPE_ROOTS [DEPENDENCY_ROOT]
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage, isRecord, parseJson } from "../data.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const [sdkDirectory, compiler, typeRoots, dependencyRoot] = process.argv.slice(2);
if (!sdkDirectory || !compiler || !typeRoots) {
	throw new Error("Usage: node types/check.mjs SDK_DIRECTORY TSC_EXECUTABLE TYPE_ROOTS [DEPENDENCY_ROOT]");
}

/** @param {string} directory @returns {Promise<string[]>} */
async function sourceFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(entries.map(async (entry) => {
		const filename = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`SDK check refuses a symlink: ${filename}`);
		if (entry.isDirectory()) return sourceFiles(filename);
		return /\.(?:mjs|js|ts)$/.test(entry.name) ? [filename] : [];
	}));
	return files.flat().sort();
}

const directory = await mkdtemp(path.join(os.tmpdir(), "foundry-sdk-check-"));
try {
	const source = parseJson(await readFile(path.join(root, "jsconfig.json"), "utf8"));
	if (!isRecord(source) || !isRecord(source.compilerOptions)) throw new Error("Invalid Foundry compiler configuration");
	const shimPath = path.join(root, "types", "sdk.d.ts");
	const files = await sourceFiles(root);
	const shim = (await readFile(shimPath, "utf8")).replaceAll("@github/copilot-sdk", "@foundry/offline-sdk");
	const translated = path.join(directory, "offline-sdk.d.ts");
	const conformance = path.join(directory, "sdk-conformance.ts");
	await writeFile(translated, shim);
	await writeFile(conformance, `
import type * as Offline from "@foundry/offline-sdk";
import type * as Native from "@github/copilot-sdk";
import type * as OfflineExtension from "@foundry/offline-sdk/extension";
import type * as NativeExtension from "@github/copilot-sdk/extension";
type Assert<T extends true> = T;
type Fits<A, B> = [A] extends [B] ? true : false;
type NativePort = Pick<Native.SessionWorkflowApi, keyof Offline.SessionWorkflowApi>;
declare const nativePort: NativePort;
declare const offlinePort: Offline.SessionWorkflowApi;
const workflowInput: NativePort = offlinePort;
const workflowOutput: Offline.SessionWorkflowApi = nativePort;
type ToolInput = Assert<Fits<Offline.Tool, Native.Tool>>;
type ToolResult = Assert<Fits<Native.ToolResultObject, Offline.ToolResultObject>>;
type ToolResultOutput = Assert<Fits<Offline.ToolResultObject, Native.ToolResultObject>>;
type CanvasInput = Assert<Fits<OfflineExtension.CanvasOptions, NativeExtension.CanvasOptions>>;
type CanvasOutput = Assert<Fits<NativeExtension.Canvas, OfflineExtension.Canvas>>;
type HookInput = Assert<Fits<Offline.SessionHooks, Native.SessionHooks>>;
type WorkflowContextInput = Assert<Fits<Omit<Native.WorkflowContext, "session">, Omit<Offline.WorkflowContext, "session">>>;
declare const nativeSession: Native.CopilotSession;
const subscribe: Offline.CopilotSession["on"] = (type, handler) => nativeSession.on(type, handler);
type WorkflowMetadata = Assert<Fits<Offline.WorkflowHandle["meta"], Native.WorkflowHandle["meta"]>>;
type ElicitationInput = Assert<Fits<Offline.ElicitationParams, Native.ElicitationParams>>;
type ElicitationOutput = Assert<Fits<Awaited<ReturnType<Native.SessionUiApi["elicitation"]>>, Awaited<ReturnType<Offline.SessionUiApi["elicitation"]>>>>;
type LogInput = Assert<Fits<Parameters<Offline.CopilotSession["log"]>, Parameters<Native.CopilotSession["log"]>>>;
`);
	const configPath = path.join(directory, "tsconfig.json");
	await writeFile(configPath, JSON.stringify({
		compilerOptions: {
			...source.compilerOptions,
			typeRoots: [path.resolve(typeRoots)],
			paths: {
				"@github/copilot-sdk": [path.join(path.resolve(sdkDirectory), "index.d.ts")],
				"@github/copilot-sdk/extension": [path.join(path.resolve(sdkDirectory), "extension.d.ts")],
				...(dependencyRoot ? {
					// The SDK uses the older node.js spelling; modern packages expose ./node.
					"vscode-jsonrpc/node.js": [path.join(path.resolve(dependencyRoot), "vscode-jsonrpc", "lib", "node", "main.d.ts")],
				} : {}),
			},
		},
		// The shim is replaced, not merged with native declarations; tests remain included.
		files: [...files.filter((filename) => filename !== shimPath), translated, conformance],
	}));
	const result = spawnSync(process.execPath, [path.resolve(compiler), "--project", configPath, "--pretty", "false"], { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.signal) throw new Error(`SDK compiler stopped with ${result.signal}`);
	if (result.status !== 0) process.exitCode = result.status ?? 1;
	else process.stdout.write(`Checked ${files.length} owned JS/TS files against the bundled SDK; offline API conformance passed.\n`);
} catch (error) {
	process.stderr.write(`${errorMessage(error)}\n`);
	process.exitCode = 1;
} finally {
	await rm(directory, { recursive: true, force: true });
}
