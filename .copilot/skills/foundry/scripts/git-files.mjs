import { execFileSync, spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {fail,relative} from "./recipe.mjs";

export const env = {
	PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "",
	GIT_AUTHOR_NAME: "Foundry", GIT_AUTHOR_EMAIL: "foundry@localhost", GIT_COMMITTER_NAME: "Foundry",
	GIT_COMMITTER_EMAIL: "foundry@localhost", GIT_AUTHOR_DATE: "@1 +0000", GIT_COMMITTER_DATE: "@1 +0000"
};
/** @param {string} cwd @param {string[]} args */
export const gitArgs = (cwd, args) => ["--no-pager", "--no-replace-objects", "--no-lazy-fetch", "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args];

/** @param {string} cwd @param {string[]} args @param {string|Buffer} [input] @param {string} [index] @param {number} [maxBuffer] @param {number} [timeout] */
export function git(cwd, args, input, index, maxBuffer, timeout=30000) {
	return execFileSync("git", gitArgs(cwd, args), {
		input, env: index ? { ...env, GIT_INDEX_FILE: index } : env, stdio: ["pipe", "pipe", "pipe"], timeout,
		maxBuffer: maxBuffer ?? (args[0] === "cat-file" ? Infinity : 128 * 1024 * 1024),
	});
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
export const pathKey = name => name.normalize("NFC").toLowerCase();

/** Include directories: A/x and a/y also alias on a case-insensitive filesystem.
 * @param {{name:string}[]} files */
export function pathNames(files) {
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
/** @param {string} cwd @param {string[]} paths @param {boolean} [write] */
export function blobIds(cwd, paths, write = false) {
	if (!paths.length) return [];
	if(paths.some(p=>/[\r\n\0]/.test(p)))fail("invalid_path","Cannot hash a line-delimited filesystem path containing a newline");
	const ids = git(cwd, ["hash-object", ...(write ? ["-w"] : []), "--no-filters", "--stdin-paths"], `${paths.join("\n")}\n`).toString().trimEnd().split("\n");
	if (ids.length !== paths.length) fail("missing_blob", "Incomplete Git blob list");
	return ids;
}
/** @param {string} dir @param {Map<string,string>} [expected] @param {boolean} [worktree] */
export function diskEntries(dir, expected, worktree = false, /** @type {((name:string)=>boolean)|undefined} */ skip = undefined) {
	/** @type {{name:string,mode:string}[]} */ const files = [];
	const device = lstatSync(dir).dev;
	/** @param {string} prefix */
	function visit(prefix) {
		for (const entry of readdirSync(path.join(dir, prefix), { encoding: "buffer" })) {
			if (!isUtf8(entry)) fail("unsupported_tree", "Non-UTF-8 file name");
			if (worktree && !prefix && entry.toString() === ".git") continue;
			const name = path.join(prefix, relative(entry.toString())), file = path.join(dir, name);
			if (skip?.(name)) continue;
			if (expected && expected.get(pathKey(name)) !== name) fail("product_changed", `Unexpected path: ${name}`);
			const stat = lstatSync(file);
			if (stat.dev !== device || stat.isSymbolicLink() || realpathSync(file) !== file || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
				fail("unsupported_tree", `Linked or special file: ${name}`);
			files.push({ name, mode: stat.isDirectory() ? "040000" : stat.mode & 0o100 ? "100755" : "100644" });
			if (stat.isDirectory()) visit(name);
		}
	}
	visit("");
	return files;
}

/** Fingerprint a temporary build artifact without writing its blobs into the repository.
 * @param {string} cwd @param {string} dir */
export function artifactDigest(cwd, dir) {
	if (!lstatSync(dir).isDirectory() || realpathSync(dir)!==dir) fail("invalid_artifact","Prepared output must be a private directory");
	const items=diskEntries(dir).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
	pathNames(items);
	const files=items.filter(e=>e.mode!=="040000");
	if (!files.length) fail("invalid_artifact","Prepared output contains no regular files");
	const ids=blobIds(cwd,files.map(e=>path.join(dir,e.name)));
	return createHash("sha256").update(JSON.stringify([items,ids])).digest("hex");
}

/** Stream Git's raw batch (header LF, size bytes, LF) directly into the checked tree.
 * @param {string} cwd @param {string} root @param {Entry[]} items */
export async function writeBlobs(cwd, root, items) {
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
	const modes = new Map(diskEntries(root, pathNames(items), worktree).map(f => [f.name, f.mode]));
	for (const e of items) if (modes.get(e.name) !== e.mode) fail("product_changed", `Product changed: ${e.name}`);
	const hashes = blobIds(cwd, items.map(e => path.join(root, e.name)));
	for (const [i, e] of items.entries())
		if (hashes[i] !== e.oid) fail("product_changed", `Product changed: ${e.name}`);
}
