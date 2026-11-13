import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseJson, readRecord } from "../data.mjs";
import { RENDERER_SCRIPTS } from "../server/assets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

/** @param {string} [directory] @returns {string[]} */
function files(directory = root) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const filename = path.join(directory, entry.name);
		assert.ok(!entry.isSymbolicLink(), `Owned source must not be a symlink: ${filename}`);
		return entry.isDirectory() ? files(filename) : [path.relative(root, filename)];
	}).sort();
}

/** @param {string} filename */
function source(filename) {
	return readFileSync(path.join(root, filename), "utf8");
}

/** Static ESM declarations, including multiline imports; JSDoc imports are type-only.
 * @param {string} text */
function imports(text) {
	return [...text.matchAll(/^import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];/gm)].map((match) => match[1]);
}

const approvedCompoundFilenames = new Set([
	"bridge/package-inputs.mjs",
	"plan/parallel-contracts.mjs",
	"storage/parallel-protocol.mjs",
	"types/parallel-conformance.ts",
	"test/parallel/native-contracts.mjs",
	"test/parallel/fixtures/native-capabilities.json",
	"test/parallel/fixtures/native-rpc-failure.json",
	"test/parallel/fixtures/native-tools.json",
	"test/parallel/fixtures/sdk-identities.json",
]);

/** @param {string} filename */
function validateFilename(filename) {
	for (const directory of filename.split(path.sep).slice(0, -1)) assert.match(directory, /^[a-z]+$/, filename);
	if (filename === "copilot-extension.json" || approvedCompoundFilenames.has(filename)) return;
	const stem = path.basename(filename).replace(/\.(?:mjs|js|ts|json|md|html|css)$/, "").replace(/\.(?:test|d)$/, "");
	assert.match(stem, /^(?:[a-z]+|README)$/, filename);
}

test("owned filenames have one-word stems with only the approved standard exceptions", () => {
	for (const filename of files()) validateFilename(filename);
});

test("filename exceptions do not admit nonlisted names or the same basenames in other directories", () => {
	for (const filename of approvedCompoundFilenames) {
		assert.throws(() => validateFilename(path.join("other", path.basename(filename))), assert.AssertionError);
		assert.throws(() => validateFilename(filename.replace(/(\.[^.]+)$/, "-new$1")), assert.AssertionError);
	}
	for (const filename of ["factory/new-helper.mjs", "test/parallel/fixtures/new-fixture.json", "other/copilot-extension.json", "two-words/helper.mjs"]) {
		assert.throws(() => validateFilename(filename), assert.AssertionError);
	}
});

test("runtime modules are acyclic, keep authority layers separate, and never import test suites", () => {
	const owned = new Set(files());
	const modules = [...owned].filter((filename) => /\.(?:mjs|js)$/.test(filename));
	const graph = new Map(modules.map((filename) => {
		const text = source(filename);
		assert.doesNotMatch(text, /^export\s+\*/m, `Broad export barrel: ${filename}`);
		const dependencies = imports(text).flatMap((specifier) => {
			if (!specifier.startsWith(".")) {
				if (filename.startsWith("renderer/")) assert.fail(`Browser module imports external code: ${filename}: ${specifier}`);
				return [];
			}
			const target = path.relative(root, path.resolve(root, path.dirname(filename), specifier));
			assert.ok(owned.has(target), `Unresolved import: ${filename} -> ${target}`);
			assert.ok(!target.endsWith(".test.mjs"), `Importing a suite duplicates its execution: ${filename} -> ${target}`);
			if (!filename.startsWith("test/")) assert.ok(!target.startsWith("test/"), `Production imports a fixture: ${filename}`);
			if (filename.startsWith("renderer/")) assert.ok(target.startsWith("renderer/"), `Browser dependency escaped its asset boundary: ${filename}`);
			if (/^(?:plan|analysis)\//.test(filename)) {
				assert.doesNotMatch(target, /^(?:application|bridge|native|server|renderer|storage|tools)\//, `${filename} -> ${target}`);
				assert.ok(!["operations.mjs", "factory.mjs", "server.mjs", "storage.mjs", "workflow.mjs"].includes(target), `${filename} -> ${target}`);
			}
			if (/^factory\//.test(filename) && !["factory/storage.mjs", "factory/repository.mjs"].includes(filename)) {
				assert.doesNotMatch(target, /^(?:application|bridge|native|server|renderer|storage)\//, `${filename} -> ${target}`);
				assert.ok(!["operations.mjs", "factory.mjs", "server.mjs", "storage.mjs"].includes(target), `${filename} -> ${target}`);
				assert.notEqual(target, "factory/storage.mjs", `${filename} imports persistence rather than receiving a port`);
			}
			if (filename.startsWith("bridge/")) assert.doesNotMatch(target, /^(?:application|native|server|renderer)\//, `${filename} -> ${target}`);
			if (filename.startsWith("application/")) assert.doesNotMatch(target, /^(?:native|server|renderer)\//, `${filename} -> ${target}`);
			return [target];
		});
		return [filename, dependencies];
	}));
	const visited = new Set();
	/** @param {string} filename @param {string[]} ancestry */
	function visit(filename, ancestry) {
		assert.ok(!ancestry.includes(filename), `Dependency cycle: ${[...ancestry, filename].join(" -> ")}`);
		if (visited.has(filename)) return;
		for (const dependency of graph.get(filename) ?? []) visit(dependency, [...ancestry, filename]);
		visited.add(filename);
	}
	for (const filename of modules) visit(filename, []);

	const factoryDependencies = new Set();
	/** @param {string} filename @param {string[]} ancestry */
	function visitFactoryDependency(filename, ancestry) {
		assert.doesNotMatch(filename, /^analysis\//, `Factory depends on analysis: ${[...ancestry, filename].join(" -> ")}`);
		if (factoryDependencies.has(filename)) return;
		factoryDependencies.add(filename);
		for (const dependency of graph.get(filename) ?? []) visitFactoryDependency(dependency, [...ancestry, filename]);
	}
	for (const filename of modules.filter((filename) => filename === "factory.mjs" || filename.startsWith("factory/"))) {
		visitFactoryDependency(filename, []);
	}
});

test("strict checking recursively covers owned sources and keeps negative guards enabled", () => {
	const config = readRecord(parseJson(source("jsconfig.json")));
	const options = readRecord(config.compilerOptions);
	assert.deepEqual(config.include, ["**/*.mjs", "**/*.js", "**/*.ts"]);
	assert.equal(Object.hasOwn(config, "exclude"), false);
	for (const flag of ["allowJs", "checkJs", "strict"]) assert.equal(options[flag], true, flag);
	assert.equal(options.skipLibCheck, false);
	for (const flag of ["noImplicitAny", "useUnknownInCatchVariables"]) assert.notEqual(options[flag], false, flag);
	for (const filename of files().filter((filename) => /\.(?:mjs|js|ts)$/.test(filename))) {
		assert.doesNotMatch(source(filename), /@ts-(?:ignore|nocheck)\b/, filename);
	}
	assert.match(source("types/guards.test.ts"), /@ts-expect-error Guard noImplicitAny/);
	assert.match(source("types/guards.test.ts"), /@ts-expect-error Guard useUnknownInCatchVariables/);
	const nativeCheck = source("types/check.mjs");
	assert.match(nativeCheck, /"types", "sdk\.d\.ts"/);
	assert.match(nativeCheck, /files\.filter\(\(filename\) => filename !== shimPath\)/);
});

test("the renderer whitelist contains exactly the packaged module graph", () => {
	const packaged = files().filter((filename) => filename.startsWith("renderer/") && filename.endsWith(".mjs"));
	assert.deepEqual(packaged, RENDERER_SCRIPTS.map((name) => `renderer/${name}`).sort());
	assert.equal(new Set(RENDERER_SCRIPTS).size, RENDERER_SCRIPTS.length);
	assert.match(source("renderer/index.html"), /<script type="module" src="app\.mjs"><\/script>/);
	for (const filename of packaged) for (const specifier of imports(source(filename))) {
		assert.ok(specifier.startsWith("./"), filename);
		assert.ok(RENDERER_SCRIPTS.includes(specifier.slice(2)), `${filename} -> ${specifier}`);
	}
});
