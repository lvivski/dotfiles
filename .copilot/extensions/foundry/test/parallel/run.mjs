import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { errorMessage, isRecord, parseJson } from "../../data.mjs";

const extension = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workspace = path.resolve(extension, "../../..");
const scratch = path.join(workspace, ".copilot/skills/foundry/.parallel-check");
const dependencyRoot = path.join(scratch, "toolchain/node_modules");
const compiler = path.join(dependencyRoot, "typescript/bin/tsc");
const typeRoots = path.join(dependencyRoot, "@types");
const sdk = "/Applications/GitHub Copilot.app/Contents/Resources/copilot-sdk";
const guard = fileURLToPath(new URL("confinement.mjs", import.meta.url));
const nodeOptions = `--import=${pathToFileURL(guard).href}`;
const visualEvidence = "/Users/lvivski/.copilot/session-state/85803622-fe24-4424-8a28-be5db6b89da8/files/foundry-visual-evidence.json";
const pinnedVisualSha256 = "8e845a7b3c4f6b70433ebfd85f2cb23fb11e1da7b7ae5edded6feeea0cae1a6f";

/** @param {string} filename */
const sha = (filename) => createHash("sha256").update(readFileSync(filename)).digest("hex");
/** @param {string} filename */
const fingerprint = (filename) => ({ path: realpathSync(filename), sha256: sha(filename) });
/** @param {string} parent @param {string} filename */
const within = (parent, filename) => filename === parent || filename.startsWith(`${parent}${path.sep}`);

/** Resolve the historical selectors only after verifying the immutable evidence.
 * @returns {string[]} */
export function visualSelectors() {
	assert.equal(sha(visualEvidence), pinnedVisualSha256, "Frozen visual evidence hash changed");
	const evidence = parseJson(readFileSync(visualEvidence, "utf8"));
	assert.ok(isRecord(evidence) && Array.isArray(evidence.validation), "Invalid frozen validation evidence");
	const checks = evidence.validation.filter((entry) => isRecord(entry) && typeof entry.command === "string" && entry.command.startsWith("node --test "));
	assert.equal(checks.length, 1, "Expected exactly one frozen test invocation");
	const check = checks[0];
	assert.ok(isRecord(check) && typeof check.command === "string");
	const prefix = "node --test --test-reporter=spec ";
	assert.ok(check.command.startsWith(prefix), "Unexpected frozen test flags");
	const files = check.command.slice(prefix.length).split(" ").map((file) => {
		assert.ok(file.startsWith(".copilot/extensions/foundry/test/"));
		return file.slice(".copilot/extensions/foundry/".length);
	});
	assert.equal(files.length, 14, "The frozen visual baseline must contain exactly 14 selectors");
	assert.equal(new Set(files).size, 14, "Frozen selectors must be distinct");
	return files;
}

/** @param {string} mode @param {string[]} selectors */
export function invocations(mode, selectors) {
	assert.ok(["tests", "visual-baseline", "offline", "native"].includes(mode),
		"Usage: node test/parallel/run.mjs tests SELECTOR... | visual-baseline | offline | native");
	if (mode === "tests" || mode === "visual-baseline") {
		if (mode === "visual-baseline") assert.equal(selectors.length, 0, "Frozen visual selectors cannot be replaced");
		const files = mode === "visual-baseline" ? visualSelectors() : selectors;
		assert.ok(files.length > 0, "Provide explicit test selectors");
		return files.map((file) => {
			assert.ok(!file.startsWith("-") && !/[*?[\]]/.test(file) && file.endsWith(".test.mjs"), "Only explicit test files are supported");
			const filename = realpathSync(path.resolve(extension, file));
			assert.ok(within(path.join(extension, "test"), filename), "Tests must belong to this extension");
			// One file per process gives legacy cwd-based fixtures a private output root.
			return ["--test", "--test-isolation=none", "--test-reporter=spec", filename];
		});
	}
	assert.equal(selectors.length, 0, "Compiler modes do not accept selector overrides");
	return [mode === "offline"
		? [compiler, "--project", "jsconfig.json", "--typeRoots", typeRoots, "--pretty", "false"]
		: ["types/check.mjs", sdk, compiler, typeRoots, dependencyRoot]];
}

/** @param {string} output @param {string | undefined} nativeCompiler */
function environment(output, nativeCompiler) {
	const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
		!key.startsWith("GIT_") && !key.startsWith("FOUNDRY_PARALLEL_") && key !== "NODE_OPTIONS"));
	return {
		...inherited, TMPDIR: output, TMP: output, TEMP: output,
		FOUNDRY_PARALLEL_SCRATCH: output, FOUNDRY_PARALLEL_OUTPUT: output, NODE_OPTIONS: nodeOptions,
		...(nativeCompiler ? { FOUNDRY_PARALLEL_COMPILER: nativeCompiler, FOUNDRY_PARALLEL_COMPILER_SHA256: sha(nativeCompiler) } : {}),
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(output, "gitconfig"),
		GIT_CONFIG_SYSTEM: path.join(output, "gitconfig"), GIT_TERMINAL_PROMPT: "0",
		XDG_CACHE_HOME: output, npm_config_cache: path.join(output, "npm-cache"),
	};
}

/** @param {string | undefined} mode @param {string[]} selectors */
function main(mode, selectors) {
	if (!existsSync(scratch)) mkdirSync(scratch, { recursive: true });
	assert.equal(realpathSync(workspace), workspace, "Workspace must be canonical");
	assert.equal(realpathSync(scratch), scratch, "Scratch must remain in the current worktree");
	const parent = process.env.FOUNDRY_PARALLEL_OUTPUT ?? scratch;
	assert.ok(within(scratch, parent) && realpathSync(parent) === parent, "Runner output must stay inside worktree scratch");
	const output = mkdtempSync(path.join(parent, "runner-"));
	/** @type {Record<string, unknown>[]} */
	const commands = [];
	/** @type {Record<string, unknown>} */
	const record = {
		format: "foundry-parallel-check-v1", mode: mode ?? null, selectors, startedAt: new Date().toISOString(), output,
		commands, exitStatus: 1,
	};
	try {
		record.node = { ...fingerprint(process.execPath), version: process.version };
		record.runner = fingerprint(fileURLToPath(import.meta.url));
		record.guard = {
			...fingerprint(guard),
			boundary: "Trusted-fixture JavaScript write detection, not a security sandbox. Native Git and the pinned no-emit compiler are trusted; native addons, races, and hostile bypasses are not contained. Each command has its own writable root; scenario subprocesses share that root but get distinct temporary/output directories.",
		};
		assert.ok(Number(process.versions.node.split(".")[0]) >= 26, "Node 26+ is required for SQLite authorizers and --test-isolation=none");
		assert.ok(!process.env.NODE_OPTIONS,
			"Inherited NODE_OPTIONS must be explicitly removed; do not silently override process policy");
		assert.ok(mode, "Provide a runner mode");
		const plans = invocations(mode, selectors);
		if (mode === "visual-baseline") record.visualBaseline = { ...fingerprint(visualEvidence), selectors: visualSelectors() };
		/** @type {string | undefined} */
		let nativeCompiler;
		if (mode === "offline" || mode === "native") {
			const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
			const packages = ["typescript", "@types/node", "vscode-jsonrpc", platformPackage];
			const versions = ["7.0.2", "26.6.6", "10.0.0", "7.0.2"];
			record.packages = packages.map((name, index) => {
				const filename = path.join(dependencyRoot, name, "package.json");
				const value = parseJson(readFileSync(filename, "utf8"));
				assert.ok(isRecord(value) && value.version === versions[index], `Missing or changed pinned dependency ${name}@${versions[index]}`);
				return { name, version: value.version, ...fingerprint(filename) };
			});
			nativeCompiler = realpathSync(path.join(dependencyRoot, platformPackage, "lib", process.platform === "win32" ? "tsc.exe" : "tsc"));
			record.compiler = { ...fingerprint(compiler), typeRoots, dependencyRoot, executable: fingerprint(nativeCompiler) };
			record.lock = fingerprint(path.join(scratch, "toolchain/package-lock.json"));
			if (mode === "native") record.sdk = ["index.d.ts", "extension.d.ts", "session.d.ts", "generated/rpc.d.ts", "workflow.d.ts"].map(name => fingerprint(path.join(sdk, name)));
		}
		/** @param {string} label @param {string[]} argv @param {boolean} sourceCwd */
		function execute(label, argv, sourceCwd) {
			const directory = mkdtempSync(path.join(output, `${label}-`));
			const env = environment(directory, nativeCompiler);
			const cwd = sourceCwd ? extension : directory;
			const result = spawnSync(process.execPath, argv, { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
			const entry = {
				label, output: directory, cwd, argv: [process.execPath, ...argv], environment: env,
				exitStatus: result.status, signal: result.signal, error: result.error ? errorMessage(result.error) : null,
				stdout: result.stdout, stderr: result.stderr,
			};
			// Evidence must not copy ambient credentials from the inherited environment.
			const publicEntry = { ...entry, environment: Object.fromEntries(Object.entries(env).filter(([key]) =>
				["TMPDIR", "TMP", "TEMP", "NODE_OPTIONS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"].includes(key) || key.startsWith("FOUNDRY_PARALLEL_"))) };
			commands.push(publicEntry);
			writeFileSync(path.join(directory, "evidence.json"), `${JSON.stringify(publicEntry, null, 2)}\n`);
			if (result.error) throw result.error;
			if (result.signal) throw new Error(`${label} terminated by ${result.signal}`);
			return result;
		}
		// Probe a sibling inside this invocation, never an actual source/live path.
		const forbidden = path.join(output, "forbidden-probe");
		const preflight = execute("preflight", ["--input-type=module", "-e", `
			import assert from "node:assert/strict";
			import { writeFileSync } from "node:fs";
			import { DatabaseSync } from "node:sqlite";
			assert.throws(() => writeFileSync(${JSON.stringify(forbidden)}, "forbidden"), /Out-of-scratch/);
			assert.throws(() => new DatabaseSync(${JSON.stringify(`${forbidden}.sqlite`)}), /Out-of-scratch/);
			console.log("canonical scratch and hard-coded external-write rejection passed");
		`], false);
		assert.equal(preflight.status, 0, preflight.stderr || preflight.stdout);
		let status = 0;
		for (const [index, argv] of plans.entries()) {
			const result = execute(`check-${index + 1}`, argv, mode === "offline" || mode === "native");
			process.stdout.write(result.status === 0 ? (result.stdout ?? "").split("\n").slice(-10).join("\n") : result.stdout ?? "");
			process.stderr.write(result.stderr ?? "");
			if (result.status !== 0) status = result.status ?? 1;
		}
		record.exitStatus = status;
		process.exitCode = status;
	} catch (error) {
		record.error = errorMessage(error);
		process.stderr.write(`${record.error}\n`);
		process.exitCode = 1;
	} finally {
		record.completedAt = new Date().toISOString();
		const filename = path.join(output, "evidence.json");
		writeFileSync(filename, `${JSON.stringify(record, null, 2)}\n`);
		console.log(`Evidence: ${filename}`);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [mode, ...selectors] = process.argv.slice(2);
	main(mode, selectors);
}
