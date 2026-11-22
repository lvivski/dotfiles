import { execFileSync, spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { contains, fail, relative } from "./values.mjs";

const env = {
	PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "",
	GIT_AUTHOR_NAME: "Foundry", GIT_AUTHOR_EMAIL: "foundry@localhost", GIT_COMMITTER_NAME: "Foundry",
	GIT_COMMITTER_EMAIL: "foundry@localhost", GIT_AUTHOR_DATE: "@1 +0000", GIT_COMMITTER_DATE: "@1 +0000"
};
/** @param {string} cwd @param {string[]} args */
const gitArgs = (cwd, args) => ["--no-pager", "--no-replace-objects", "--no-lazy-fetch", "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args];

/** @param {string} cwd @param {string[]} args @param {string|Buffer} [input] @param {string} [index] @param {number} [maxBuffer] */
export function git(cwd, args, input, index, maxBuffer) {
	return execFileSync("git", gitArgs(cwd, args), {
		input, env: index ? { ...env, GIT_INDEX_FILE: index } : env, stdio: ["pipe", "pipe", "pipe"], timeout: 30000,
		maxBuffer: maxBuffer ?? (args[0] === "cat-file" ? Infinity : 128 * 1024 * 1024),
	});
}

/** @param {string} cwd @param {string} ref */
export const commitAt = (cwd, ref) => git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).toString().trim();
/** @param {string} cwd */
export const rootAt = cwd => realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).toString().trim());
/** @param {string} cwd @param {string} commit @param {string[]} paths */
export const versionOf = (cwd, commit, paths) => createHash("sha256").update(git(cwd, ["ls-tree", "--full-tree", "-z", commit, "--", ...paths])).digest("hex");

/** @param {string} cwd @param {string} commit @param {string} filename */
export function committedFile(cwd, commit, filename) {
	const [entry] = regularFiles(cwd, commit, [filename]);
	return git(cwd, ["cat-file", "blob", entry.oid]);
}

/** @param {string} cwd @param {string} commit @param {string[]} files */
export function regularFiles(cwd, commit, files) {
	const items = entries(cwd, commit, false, files.map(relative));
	const byName = new Map(items.map(e => [e.name, e]));
	return files.map(filename => {
		const e = byName.get(filename);
		if (!e || !["100644", "100755"].includes(e.mode))
			fail("missing_contract", `No regular file at ${commit}:${filename}`);
		return e;
	});
}

/** @typedef {{name:string,mode:string,type:string,oid:string}} Entry */
/** @param {string} name */
const pathKey = name => name.normalize("NFC").toLowerCase();

/** Include directories: A/x and a/y also alias on a case-insensitive filesystem.
 * @param {{name:string}[]} files */
function pathNames(files) {
	const paths = new Map();
	for (const { name } of files) {
		let prefix = "";
		for (const part of name.split("/")) {
			prefix = prefix ? `${prefix}/${part}` : part;
			const key = pathKey(prefix);
			if (paths.has(key) && paths.get(key) !== prefix) fail("tree_conflict", `Case-aliased path: ${prefix}`);
			paths.set(key, prefix);
		}
	}
	return paths;
}

/** @param {string} cwd @param {string} tree @param {boolean} [recursive] @param {string[]} [filter] @returns {Entry[]} */
export function entries(cwd, tree, recursive = false, filter) {
	const raw = git(cwd, ["ls-tree", "--full-tree", "-z", ...(recursive ? ["-r"] : []), tree, ...(filter ? ["--", ...filter] : [])]);
	const string = raw.toString("utf8");
	if (!Buffer.from(string).equals(raw))
		fail("unsupported_tree", "Non-UTF-8 Git paths cannot be materialized");
	return string.split("\0").filter(Boolean).map(line => {
		const match = /^([0-7]+) (blob|tree|commit) ([a-f0-9]+)\t(.+)$/s.exec(line);
		if (!match)
			fail("unsupported_tree", "Malformed tree entry");
		return { name: relative(match[4]), mode: match[1], type: match[2], oid: match[3] };
	});
}

/** @param {string} cwd @param {Entry[]} items */
function build(cwd, items) {
	pathNames(items);
	return git(cwd, ["mktree", "-z"], items.map(e => `${e.mode} ${e.type} ${e.oid}\t${e.name}\0`).join("")).toString().trim();
}

/** @param {string} cwd @param {string} tree @param {string} directory */
function subtree(cwd, tree, directory) {
	const found = entries(cwd, tree, false, [relative(directory)])[0];
	if (found && found.type !== "tree")
		fail("tree_conflict", `${directory} is not a directory`);
	return found?.oid ?? null;
}

/** @param {string} cwd @param {string} revision @param {string} directory */
export function directoryBaseline(cwd, revision, directory) {
	const tree = subtree(cwd, revision, directory);
	return tree ? { directory, revision, tree } : undefined;
}

/** @param {string} cwd @param {string} revision @param {string} directory */
export function verifyDirectoryPin(cwd, revision, directory) {
	if (git(cwd, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${revision}\n`).toString().trimEnd() !== `${revision} commit`)
		fail("invalid_baseline", `Expected a full local commit ID: ${revision}`);
	if (!directoryBaseline(cwd, revision, directory))
		fail("invalid_baseline", `No prior directory at ${revision}:${directory}`);
}

/** @param {string} cwd @param {string|null} tree @param {string} directory @param {string|null} replacement @param {string|null} [expected] @returns {string|null} */
function replace(cwd, tree, directory, replacement, expected) {
	const [name, ...tail] = relative(directory).split("/");
	const items = tree ? entries(cwd, tree) : [], child = items.find(e => e.name === name);
	if (child && child.type !== "tree")
		fail("tree_conflict", `Non-directory at ${name}`);
	let value = replacement;
	const current = child?.oid ?? null;
	if (tail.length)
		value = replace(cwd, current, tail.join("/"), replacement, expected);
	else if (expected !== undefined && current !== expected && current !== replacement)
		fail("tree_conflict", `Concurrent modification of ${directory}`);
	if (current === value)
		return tree;
	const rest = items.filter(e => e.name !== name);
	if (value)
		rest.push({ name, type: "tree", mode: "040000", oid: value });
	return rest.length ? build(cwd, rest) : null;
}

/** @param {string} cwd @param {string} oid */
export function retain(cwd, oid) {
	git(cwd, ["update-ref", "--no-deref", `refs/foundry/objects/${oid}`, oid]);
	return oid;
}

/** Pin only the explicitly selected file, including untracked or binary data. Never touch the index.
 * @param {string} cwd @param {string} file */
export function pinFile(cwd, file) {
	const source = path.join(cwd, relative(file));
	const stat = lstatSync(source);
	if (!stat.isFile() || stat.nlink !== 1 || realpathSync(source) !== source || stat.dev !== lstatSync(cwd).dev)
		fail("unsupported_tree", `Expected a regular, unlinked file: ${file}`);
	const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || realpathSync(source) !== source)
			fail("artifact_changed", `File changed during publication: ${file}`);
		const oid = execFileSync("git", gitArgs(cwd, ["hash-object", "-w", "--stdin"]), { env, stdio: [fd, "pipe", "pipe"] }).toString().trim();
		const after = fstatSync(fd);
		if (opened.ctimeMs !== after.ctimeMs || opened.size !== after.size) fail("artifact_changed", `File changed during publication: ${file}`);
		return retain(cwd, oid);
	} finally { closeSync(fd); }
}

/** @param {string} cwd @param {string|null} tree @param {string} label @param {string} [parent] */
function pin(cwd, tree, label, parent) {
	const oid = git(cwd, ["-c", "commit.gpgSign=false", "commit-tree", tree ?? build(cwd, []), ...(parent ? ["-p", parent] : [])], `${label}\n`).toString().trim();
	return retain(cwd, oid);
}

/** @param {string} cwd @param {string} commit */
export const treeOf = (cwd, commit) => git(cwd, ["rev-parse", "--verify", `${commit}^{tree}`]).toString().trim();
/** @param {string} cwd @param {string} commit @param {string} directory */
export const withoutGrain = (cwd, commit, directory) => pin(cwd, replace(cwd, treeOf(cwd, commit), directory, null), "Foundry generation base");

/** @param {string} cwd @param {string[]} paths @param {boolean} [write] */
function blobIds(cwd, paths, write = false) {
	if (!paths.length) return [];
	const ids = git(cwd, ["hash-object", ...(write ? ["-w"] : []), "--no-filters", "--stdin-paths"], `${paths.join("\n")}\n`).toString().trimEnd().split("\n");
	if (ids.length !== paths.length) fail("missing_blob", "Incomplete Git blob list");
	return ids;
}

/** @param {string} cwd @param {(staged:(args:string[], input?:string)=>Buffer)=>string} use */
function withIndex(cwd, use) {
	const dir = mkdtempSync(path.join(tmpdir(), "foundry-index-"));
	try {
		return use((args, input) => git(cwd, ["-c", "core.splitIndex=false", "-c", "core.sparseCheckout=false", "-c", "core.fsmonitor=false", ...args], input, path.join(dir, "index")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** @param {string} dir @param {Map<string,string>} [expected] @param {boolean} [worktree] */
function diskFiles(dir, expected, worktree = false) {
	/** @type {{name:string,mode:string}[]} */ const files = [];
	const device = lstatSync(dir).dev;
	/** @param {string} prefix */
	function visit(prefix) {
		for (const entry of readdirSync(path.join(dir, prefix), { encoding: "buffer" })) {
			if (!isUtf8(entry)) fail("unsupported_tree", "Non-UTF-8 file name");
			if (worktree && !prefix && entry.toString() === ".git") continue;
			const name = path.join(prefix, relative(entry.toString())), file = path.join(dir, name);
			if (expected && expected.get(pathKey(name)) !== name) fail("product_changed", `Unexpected path: ${name}`);
			const stat = lstatSync(file);
			if (stat.dev !== device || stat.isSymbolicLink() || realpathSync(file) !== file || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
				fail("unsupported_tree", `Linked or special file: ${name}`);
			if (stat.isDirectory()) visit(name);
			else files.push({ name, mode: stat.mode & 0o100 ? "100755" : "100644" });
		}
	}
	visit("");
	return files;
}

/** @param {string} root @param {string} directory */
function grainTree(root, directory) {
	let dir = root;
	for (const part of relative(directory).split("/")) {
		dir = path.join(dir, part);
		const stat = lstatSync(dir, { throwIfNoEntry: false });
		if (!stat) return null;
		if (!stat.isDirectory() || realpathSync(dir) !== dir) fail("unsupported_tree", `Invalid grain directory: ${dir}`);
	}
	const files = diskFiles(dir);
	if (!files.length) return null;
	pathNames(files);
	const ids = blobIds(root, files.map(f => `./${directory}/${f.name}`), true);
	return withIndex(root, staged => {
		staged(["update-index", "-z", "--index-info"], files.map((f, i) => `${f.mode} ${ids[i]}\t${f.name}\0`).join(""));
		// update-index can exit successfully after ignoring a path. Never publish a partial directory.
		const indexed = new Set(staged(["ls-files", "-z"]).toString().split("\0"));
		for (const f of files) if (!indexed.has(f.name)) fail("unsupported_tree", `Git cannot index ${f.name}`);
		return staged(["write-tree"]).toString().trim();
	});
}

/** @param {string} cwd @param {string} generation */
export function generationRoot(cwd, generation) {
	const root = rootAt(cwd);
	const [local, common, head] = git(root, ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir", "HEAD"]).toString().trimEnd().split("\n");
	if (head !== generation || local === common)
		fail("wrong_workspace", "Submit from the assigned native worktree at its frozen generation base");
	return root;
}

/** @param {string} cwd @param {string} generation @param {string} directory */
export function capture(cwd, generation, directory) {
	const root = generationRoot(cwd, generation);
	return pin(root, replace(root, treeOf(root, generation), directory, grainTree(root, directory)), "Foundry grain candidate");
}

/** @param {string} cwd @param {string} base @param {{directory:string,from:string,to:string}[]} updates @param {string} [parent] */
export function combine(cwd, base, updates, parent) {
	/** @type {string|null} */ let tree = treeOf(cwd, base);
	for (const { directory, from, to } of updates) {
		const before = from === base ? undefined : subtree(cwd, from, directory);
		try {
			tree = replace(cwd, tree, directory, subtree(cwd, to, directory), before);
		}
		catch (error) {
			if (error instanceof Error && "code" in error && error.code === "tree_conflict")
				fail("tree_conflict", `Concurrent modification of ${directory}: ${error.message}`);
			throw error;
		}
	}
	return pin(cwd, tree, "Foundry product candidate", parent);
}

/** Carry the actual checkpoint delta onto a moved target, not a reconstruction from past jobs.
 * read-tree does only trivial three-way merges; no worktree, content merge drivers or real index.
 * @param {string} cwd @param {import("./model.js").Product} last @param {string} target */
export function rejoin(cwd, last, target) {
	return withIndex(cwd, staged => {
		staged(["read-tree", "-i", "-m", "--aggressive", last.target, target, last.commit]);
		const conflict = staged(["ls-files", "--unmerged", "-z"]).toString().split("\0", 1)[0];
		if (conflict) fail("tree_conflict", `Concurrent modification since checkpoint: ${conflict.slice(conflict.indexOf("\t") + 1)}`);
		return pin(cwd, staged(["write-tree"]).toString().trim(), "Foundry checkpoint on new target");
	});
}

/** @param {string} cwd @param {string} from @param {string} to @param {string[]} [paths] @param {number} [maxBytes] */
export function changedFiles(cwd, from, to, paths = [], maxBytes) {
	const raw = git(cwd, ["diff-tree", "--no-ext-diff", "--no-renames", "--ignore-submodules=none", "-r", "--name-only", "-z", from, to, "--", ...paths], undefined, undefined, maxBytes);
	if (!isUtf8(raw)) fail("unsupported_tree", "Non-UTF-8 changed paths cannot be represented");
	return raw.toString().split("\0").filter(Boolean);
}

/** Acceptance helpers may be shared across plans. Scout reads are not contract pins.
 * @param {import("./model.js").Policy} policy */
export const contractPaths = policy => policy.sharedBrief ? [...policy.files, ".foundry"] : policy.files;

/** @param {string} cwd @param {import("./model.js").Policy} policy @param {string} commit */
export function verifyContracts(cwd, policy, commit) {
	if (commit === policy.base)
		return;
	const changed = changedFiles(cwd, policy.base, commit, contractPaths(policy));
	if (changed.length)
		fail("contract_changed", `The conserved contract changed: ${changed.join(", ")}`);
}

/** Stream Git's raw batch (header LF, size bytes, LF) directly into the checked tree.
 * @param {string} cwd @param {string} root @param {Entry[]} items */
async function materialize(cwd, root, items) {
	const child = spawn("git", gitArgs(cwd, ["cat-file", "--batch"]), { env, stdio: ["pipe", "pipe", "inherit"] });
	const closed = once(child, "close"), input = pipeline(Readable.from(items.map(e => `${e.oid}\n`)), child.stdin);
	/** @param {AsyncIterable<Buffer>} chunks */
	async function extract(chunks) {
		let index = 0, header = "", remaining = 0;
		/** @type {number|undefined} */ let fd;
		try {
			for await (let bytes of chunks) while (bytes.length) {
				if (fd === undefined) {
					const nl = bytes.indexOf(10);
					header += bytes.toString("ascii", 0, nl < 0 ? bytes.length : nl);
					if (header.length > 128) fail("missing_blob", "Invalid Git batch header");
					if (nl < 0) break;
					const e = items[index], match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
					if (!e || !match || match[1] !== e.oid) fail("missing_blob", `Unexpected blob: ${header}`);
					remaining = Number(match[2]);
					const file = path.join(root, e.name);
					mkdirSync(path.dirname(file), { recursive: true });
					fd = openSync(file, "wx");
					fchmodSync(fd, e.mode === "100755" ? 0o755 : 0o644);
					header = "";
					bytes = bytes.subarray(nl + 1);
				} else if (remaining) {
					const size = Math.min(remaining, bytes.length);
					writeFileSync(fd, bytes.subarray(0, size));
					bytes = bytes.subarray(size);
					remaining -= size;
				} else {
					if (bytes[0] !== 10) fail("missing_blob", "Invalid Git batch separator");
					bytes = bytes.subarray(1);
					closeSync(fd);
					fd = undefined;
					index++;
				}
			}
			if (index !== items.length || header) fail("missing_blob", "Incomplete Git batch");
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	try {
		const [[code]] = await Promise.all([closed, input, extract(child.stdout)]);
		if (code !== 0) fail("missing_blob", "Git could not read the pinned blobs");
	} finally {
		child.kill();
	}
}

/** Prove all bytes and executable bits against Git, including ignored and untracked paths.
 * Only a separately verified linked worktree may omit its root .git administrative file.
 * @param {string} cwd @param {string} root @param {Entry[]} items @param {boolean} [worktree] */
export function verifyTree(cwd, root, items, worktree = false) {
	const modes = new Map(diskFiles(root, pathNames(items), worktree).map(f => [f.name, f.mode]));
	for (const e of items) if (modes.get(e.name) !== e.mode) fail("product_changed", `Product changed: ${e.name}`);
	const hashes = blobIds(cwd, items.map(e => path.join(root, e.name)));
	for (const [i, e] of items.entries())
		if (hashes[i] !== e.oid) fail("product_changed", `Product changed: ${e.name}`);
}

/** @param {string} cwd @param {string} commit @param {(root:string)=>void} evaluate @param {{base:string, revision:string}} [overlay] */
export async function withProduct(cwd, commit, evaluate, overlay) {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "foundry-check-")));
	try {
		let items = entries(cwd, commit, true);
		if (overlay) {
			const paths = changedFiles(cwd, overlay.base, overlay.revision);
			if (paths.some(p => !p.startsWith(".foundry/"))) fail("contract_scope", "Evaluator overlay includes product paths");
			if (paths.length) {
				const replaced = new Set(paths);
				items = [...items.filter(e => !replaced.has(e.name)), ...entries(cwd, overlay.revision, true, paths)];
			}
		}
		pathNames(items); // Refuse aliases before writing any files.
		for (const e of items)
			if (!["100644", "100755"].includes(e.mode))
				fail("unsupported_tree", `Cannot evaluate ${e.name}: not a regular file`);
		await materialize(cwd, root, items);
		evaluate(root);
		verifyTree(cwd, root, items);
	}
	finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** @param {string} dir @param {string[]} paths */
export const outside = (dir, paths) => !paths.some(p => {
	const a = pathKey(dir), b = pathKey(p);
	return contains(a, b) || contains(b, a);
});
