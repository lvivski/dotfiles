import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import promises from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { errorCode, errorMessage, isRecord } from "../../data.mjs";

const root = process.env.FOUNDRY_PARALLEL_SCRATCH;
const output = process.env.FOUNDRY_PARALLEL_OUTPUT;
assert.ok(root && path.isAbsolute(root), "Missing canonical scratch root");
assert.ok(output && path.isAbsolute(output), "Missing process output root");
assert.equal(fs.realpathSync(root), root);
assert.equal(fs.realpathSync(output), output);
/** @param {string} value */
const within = (value) => value === root || value.startsWith(`${root}${path.sep}`);
assert.ok(within(output));
for (const key of ["TMPDIR", "TMP", "TEMP"]) assert.equal(process.env[key], output);
assert.equal(fs.realpathSync(os.tmpdir()), output);
const lstat = fs.lstatSync, realpath = fs.realpathSync;
const descriptors = new Set([1, 2]);

/** Trusted-fixture detection only: native code and deliberate bypasses are not sandboxed.
 * @param {unknown} value @param {boolean} [follow] */
function check(value, follow = true) {
	if (isRecord(value) && typeof value.fd === "number") value = value.fd;
	if (typeof value === "number") {
		assert.ok(descriptors.has(value), `Untracked writable descriptor: ${value}`);
		return;
	}
	assert.ok(typeof value === "string" || value instanceof URL || Buffer.isBuffer(value), "Unsupported writable path");
	const resolved = path.resolve(value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value);
	assert.ok(within(resolved), `Out-of-scratch write: ${resolved}`);
	let existing = follow ? resolved : path.dirname(resolved);
	while (true) {
		try { lstat(existing); break; }
		catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
			existing = path.dirname(existing);
		}
	}
	assert.ok(within(realpath(existing)), `Out-of-scratch link traversal: ${resolved}`);
}

/** @param {object} target @param {string} name @param {number[]} [indices] @param {boolean} [follow] */
function wrap(target, name, indices = [0], follow = true) {
	/** @type {unknown} */
	const original = Reflect.get(target, name);
	if (typeof original !== "function") return;
	Reflect.set(target, name, function (/** @type {unknown[]} */ ...args) {
		for (const index of indices) check(args[index], follow);
		return Reflect.apply(original, target, args);
	});
}
for (const name of ["writeFile", "appendFile", "truncate", "mkdir", "mkdtemp", "mkdtempDisposable", "chmod", "chown", "utimes", "createWriteStream"]) {
	wrap(fs, name); wrap(fs, `${name}Sync`); wrap(promises, name);
}
for (const name of ["rm", "rmdir", "unlink", "lchmod", "lchown", "lutimes", "rename"]) {
	const indices = name === "rename" ? [0, 1] : [0];
	wrap(fs, name, indices, false); wrap(fs, `${name}Sync`, indices, false); wrap(promises, name, indices, false);
}
for (const name of ["copyFile", "cp", "symlink", "link"]) {
	const indices = name === "link" ? [0, 1] : [1];
	wrap(fs, name, indices, name !== "symlink"); wrap(fs, `${name}Sync`, indices, name !== "symlink"); wrap(promises, name, indices, name !== "symlink");
}
/** @param {unknown} flags */
const writes = (flags) => typeof flags === "number"
	? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
	: typeof flags === "string" && /[wax+]/.test(flags);
/** Read-only scratch directory descriptors are valid fsync targets.
 * @param {unknown} filename @param {number} fd */
function track(filename, fd) {
	try { check(filename); descriptors.add(fd); }
	catch { descriptors.delete(fd); }
}
const openSync = fs.openSync;
fs.openSync = (filename, flags, mode) => {
	if (writes(flags)) check(filename);
	const fd = openSync(filename, flags, mode);
	track(filename, fd);
	return fd;
};
const closeSync = fs.closeSync;
fs.closeSync = (fd) => { closeSync(fd); descriptors.delete(fd); };
const close = fs.close;
Reflect.set(fs, "close", (/** @type {number} */ fd, /** @type {((error: NodeJS.ErrnoException | null) => void) | undefined} */ callback) => close(fd, (error) => {
	if (!error) descriptors.delete(fd);
	callback?.(error);
}));
const open = fs.open;
Reflect.set(fs, "open", (/** @type {unknown[]} */ ...args) => {
	const callback = args.pop();
	assert.equal(typeof callback, "function", "fs.open requires a callback");
	if (writes(args[1])) check(args[0]);
	return Reflect.apply(open, fs, [...args, (/** @type {NodeJS.ErrnoException | null} */ error, /** @type {number} */ fd) => {
		if (!error) track(args[0], fd);
		if (typeof callback === "function") Reflect.apply(callback, undefined, [error, fd]);
	}]);
});
const openPromise = promises.open;
promises.open = async (filename, flags, mode) => {
	if (writes(flags)) check(filename);
	const handle = await openPromise(filename, flags, mode);
	track(filename, handle.fd);
	for (const name of ["write", "writev", "writeFile", "appendFile", "truncate", "chmod", "chown", "utimes", "sync", "datasync", "createWriteStream"]) {
		/** @type {unknown} */
		const original = Reflect.get(handle, name);
		if (typeof original === "function") Reflect.set(handle, name, (/** @type {unknown[]} */ ...args) => {
			check(filename);
			return Reflect.apply(original, handle, args);
		});
	}
	const closeHandle = handle.close.bind(handle);
	handle.close = async () => { const fd = handle.fd; await closeHandle(); descriptors.delete(fd); };
	return handle;
};
for (const name of ["write", "writev", "ftruncate", "fchmod", "fchown", "futimes", "fsync", "fdatasync"]) {
	wrap(fs, name); wrap(fs, `${name}Sync`);
}

// SQLite is not synchronized by syncBuiltinESMExports. A load hook exposes the
// checked constructor to named imports as well as CommonJS/default consumers.
if (!process.execArgv.includes("--no-experimental-sqlite")) {
	const sqlite = process.getBuiltinModule("node:sqlite");
	assert.ok(sqlite, "Native SQLite is unavailable");
	/** @param {unknown} filename */
	function checkDatabase(filename) {
		if (filename === ":memory:") return;
		assert.ok(typeof filename === "string" || filename instanceof URL || Buffer.isBuffer(filename), "Unsupported SQLite path");
		const value = filename instanceof URL ? fileURLToPath(filename) : filename.toString();
		const name = value.startsWith("file:") ? fileURLToPath(new URL(value)) : value;
		check(name);
		for (const suffix of ["-wal", "-shm", "-journal"]) check(`${name}${suffix}`);
	}
	const Database = sqlite.DatabaseSync;
	sqlite.DatabaseSync = class extends Database {
		/** @param {string | Buffer | URL} filename @param {import("node:sqlite").DatabaseSyncOptions} [options] */
		constructor(filename, options) {
			checkDatabase(filename);
			super(filename, options ?? {});
			if (this.isOpen) this.setAuthorizer(null);
		}
		open() { super.open(); this.setAuthorizer(null); }
		/** @param {Parameters<import("node:sqlite").DatabaseSync["setAuthorizer"]>[0]} callback */
		setAuthorizer(callback) {
			super.setAuthorizer((action, arg1, ...args) => {
				if (action === sqlite.constants.SQLITE_ATTACH) {
					try { checkDatabase(arg1); }
					catch { return sqlite.constants.SQLITE_DENY; }
				}
				return callback?.(action, arg1, ...args) ?? sqlite.constants.SQLITE_OK;
			});
		}
	};
	const backup = sqlite.backup;
	sqlite.backup = (source, filename, options) => {
		checkDatabase(filename);
		return backup(source, filename, options ?? {});
	};
	registerHooks({
		load(url, context, nextLoad) {
			if (url !== "node:sqlite") return nextLoad(url, context);
			return {
				format: "module", shortCircuit: true,
				source: `const sqlite = process.getBuiltinModule("node:sqlite"); export default sqlite;\n${Object.keys(sqlite).map(key => `export const ${key} = sqlite.${key};`).join("\n")}`,
			};
		},
	});
}

/** @param {string} filename */
const hash = (filename) => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
/** @type {Map<string, {path: string, sha256: string}>} */
const executables = new Map();
/** @param {string} filename @param {Record<string, unknown>} env */
function executable(filename, env) {
	const searchPath = typeof env.PATH === "string" ? env.PATH : "";
	const resolved = path.isAbsolute(filename) ? filename : searchPath.split(path.delimiter)
		.map(directory => path.resolve(directory, filename)).find(candidate => {
			try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
			catch { return false; }
		});
	assert.ok(resolved, `Cannot resolve subprocess executable: ${filename}`);
	const canonical = realpath(resolved);
	let value = executables.get(canonical);
	if (!value) {
		value = { path: canonical, sha256: hash(canonical) };
		executables.set(canonical, value);
	}
	return value;
}
/** @param {unknown} value */
const text = (value) => typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString() : null;

for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
	/** @type {unknown} */
	const original = Reflect.get(childProcess, name);
	assert.ok(typeof original === "function");
	const wrapped = (/** @type {unknown[]} */ ...args) => {
		const [file, argv, options] = args;
		assert.ok(typeof file === "string" && Array.isArray(argv) && argv.every(arg => typeof arg === "string"), "Subprocesses require an executable and explicit string argv");
		const nativeCompiler = process.env.FOUNDRY_PARALLEL_COMPILER;
		assert.ok(file === "git" || file === process.execPath || (nativeCompiler && file === nativeCompiler), `Unapproved test executable: ${file}`);
		if (file === nativeCompiler) assert.equal(hash(file), process.env.FOUNDRY_PARALLEL_COMPILER_SHA256, "Pinned compiler executable changed");
		const settings = isRecord(options) ? options : {};
		assert.ok(!settings.shell, "Shell subprocesses are not confined");
		const env = settings.env ?? process.env;
		assert.ok(isRecord(env));
		assert.equal(env.NODE_OPTIONS, process.env.NODE_OPTIONS, "Child dropped scratch write guard");
		assert.ok(typeof env.FOUNDRY_PARALLEL_SCRATCH === "string");
		check(env.FOUNDRY_PARALLEL_SCRATCH);
		const parent = env.FOUNDRY_PARALLEL_OUTPUT;
		assert.ok(typeof parent === "string");
		check(parent);
		for (const key of ["TMPDIR", "TMP", "TEMP"]) assert.equal(env[key], parent, "Child changed temporary directory");
		if (file === "git") {
			const cwd = settings.cwd ?? process.cwd();
			check(cwd);
			assert.ok(typeof cwd === "string");
			let gitCwd = cwd;
			for (let i = 0; i < argv.length; i++) {
				const arg = argv[i];
				if (arg === "-C") { gitCwd = path.resolve(gitCwd, argv[++i]); check(gitCwd); }
				else if (path.isAbsolute(arg)) check(arg);
				else if (/^--(?:git-dir|work-tree|output)=/.test(arg)) check(path.resolve(gitCwd, arg.slice(arg.indexOf("=") + 1)));
			}
			for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) {
				if (env[key] !== undefined) check(env[key]);
			}
		}
		const childOutput = fs.mkdtempSync(path.join(parent, "child-"));
		const childEnv = {
			...env, TMPDIR: childOutput, TMP: childOutput, TEMP: childOutput, FOUNDRY_PARALLEL_OUTPUT: childOutput,
			GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(childOutput, "gitconfig"),
			GIT_CONFIG_SYSTEM: path.join(childOutput, "gitconfig"), GIT_TERMINAL_PROMPT: "0",
			XDG_CACHE_HOME: childOutput, npm_config_cache: path.join(childOutput, "npm-cache"),
		};
		/** @type {Record<string, unknown>} */
		const evidence = {
			argv: [file, ...argv], cwd: settings.cwd ?? process.cwd(), output: childOutput,
			executable: executable(file, env),
			environment: Object.fromEntries(Object.entries(childEnv).filter(([key]) => ["TMPDIR", "TMP", "TEMP", "NODE_OPTIONS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].includes(key))),
			startedAt: new Date().toISOString(), exitStatus: null, outputCapture: settings.stdio === "inherit" ? "in enclosing command evidence" : "piped streams",
		};
		const save = () => fs.writeFileSync(path.join(childOutput, "evidence.json"), `${JSON.stringify({ ...evidence, completedAt: new Date().toISOString() }, null, 2)}\n`);
		const rest = isRecord(options) || options === undefined ? args.slice(3) : args.slice(2);
		try {
			/** @type {unknown} */
			const result = Reflect.apply(original, childProcess, [file, argv, { ...settings, env: childEnv }, ...rest]);
			if (result instanceof childProcess.ChildProcess) {
				let stdout = "", stderr = "";
				result.stdout?.on("data", chunk => { stdout += String(chunk); });
				result.stderr?.on("data", chunk => { stderr += String(chunk); });
				result.once("error", error => { evidence.error = errorMessage(error); });
				result.once("close", (code, signal) => {
					Object.assign(evidence, { exitStatus: code, signal, stdout, stderr }); save();
				});
			} else {
				Object.assign(evidence, isRecord(result)
					? { exitStatus: result.status, signal: result.signal, stdout: text(result.stdout), stderr: text(result.stderr), error: result.error ? errorMessage(result.error) : null }
					: { exitStatus: 0, stdout: text(result), stderr: null });
				save();
			}
			return result;
		} catch (error) {
			Object.assign(evidence, { error: errorMessage(error), exitStatus: isRecord(error) ? error.status ?? null : null,
				stdout: isRecord(error) ? text(error.stdout) : null, stderr: isRecord(error) ? text(error.stderr) : null });
			save();
			throw error;
		}
	};
	if (name === "execFile") Object.defineProperty(wrapped, promisify.custom, {
		value: (/** @type {unknown[]} */ ...args) => new Promise((resolve, reject) => {
			wrapped(...args, (/** @type {unknown} */ error, /** @type {unknown} */ stdout, /** @type {unknown} */ stderr) =>
				error ? reject(error) : resolve({ stdout, stderr }));
		}),
	});
	Reflect.set(childProcess, name, wrapped);
}
for (const name of ["exec", "execSync", "fork"]) Reflect.set(childProcess, name, () => { throw new Error("Unconfined shell/fork subprocess"); });
// TypeScript's launcher catches this and uses the audited execFileSync fallback.
process.execve = () => { throw new Error("execve would bypass subprocess evidence"); };
syncBuiltinESMExports();
