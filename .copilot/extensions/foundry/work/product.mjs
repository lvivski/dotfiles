import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

/** @param {string} cwd @param {string[]} args @param {string|Buffer} [input] */
export function git(cwd, args, input) {
	return execFileSync("git", gitArgs(cwd, args), {
		input, env, stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 128 * 1024 * 1024,
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
/** @param {string} cwd @param {string} tree @param {boolean} [recursive] @param {string[]} [filter] @returns {Entry[]} */
function entries(cwd, tree, recursive = false, filter) {
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
	const seen = new Set();
	for (const { name } of items) {
		const key = name.normalize("NFC").toLowerCase();
		if (seen.has(key))
			fail("tree_conflict", `Case-aliased product path: ${name}`);
		seen.add(key);
	}
	return git(cwd, ["mktree", "-z"], items.map(e => `${e.mode} ${e.type} ${e.oid}\t${e.name}\0`).join("")).toString().trim();
}

/** @param {string} cwd @param {string} tree @param {string} directory */
function subtree(cwd, tree, directory) {
	const found = entries(cwd, tree, false, [relative(directory)])[0];
	if (found && found.type !== "tree")
		fail("tree_conflict", `${directory} is not a directory`);
	return found?.oid ?? null;
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

/** @param {string} cwd @param {string|null} tree @param {string} label @param {string} [parent] */
function pin(cwd, tree, label, parent) {
	const oid = git(cwd, ["-c", "commit.gpgSign=false", "commit-tree", tree ?? build(cwd, []), ...(parent ? ["-p", parent] : [])], `${label}\n`).toString().trim();
	return retain(cwd, oid);
}

/** @param {string} cwd @param {string} commit */
const treeOf = (cwd, commit) => git(cwd, ["rev-parse", "--verify", `${commit}^{tree}`]).toString().trim();
/** @param {string} cwd @param {string} commit @param {string} directory */
export const withoutGrain = (cwd, commit, directory) => pin(cwd, replace(cwd, treeOf(cwd, commit), directory, null), "Foundry generation base");

/** @param {string} cwd @param {string} generation @param {string} directory */
export function capture(cwd, generation, directory) {
	const root = rootAt(cwd), dir = path.join(root, relative(directory));
	const [local, common, head] = git(root, ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir", "HEAD"]).toString().trimEnd().split("\n");
	if (head !== generation || local === common)
		fail("wrong_workspace", "Submit from the assigned native worktree at its frozen generation base");
	/** @type {Map<string,Entry[]>} */ const directories = new Map();
	/** @type {Array<[string,Entry]>} */ const files = [];
	/** @param {string} location */
	function scan(location) {
		if (!lstatSync(location).isDirectory() || realpathSync(location) !== location)
			fail("unsupported_tree", `Expected an unlinked directory at ${location}`);
		/** @type {Entry[]} */ const items = [];
		for (const name of readdirSync(location).sort()) {
			relative(name);
			const filename = path.join(location, name), stat = lstatSync(filename);
			if (stat.isDirectory()) {
				scan(filename);
				if (directories.has(filename))
					items.push({ name, oid: "", type: "tree", mode: "040000" });
			}
			else {
				if (!stat.isFile() || stat.nlink !== 1 || realpathSync(filename) !== filename)
					fail("unsupported_tree", `Cannot publish a linked or special file: ${filename}`);
				/** @type {Entry} */ const e = { name, oid: "", type: "blob", mode: stat.mode & 0o100 ? "100755" : "100644" };
				files.push([`./${path.relative(root, filename)}`, e]);
				items.push(e);
			}
		}
		if (items.length)
			directories.set(location, items);
	}
	let current = root, missing = false;
	for (const part of directory.split("/")) {
		current = path.join(current, part);
		const stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat) {
			missing = true;
			break;
		}
		if (!stat.isDirectory() || realpathSync(current) !== current)
			fail("unsupported_tree", `Invalid grain directory: ${current}`);
	}
	if (!missing)
		scan(dir);
	if (files.length) {
		const hashes = git(root, ["hash-object", "-w", "--no-filters", "--stdin-paths"], files.map(([p]) => `${p}\n`).join("")).toString().trim().split("\n");
		if (hashes.length !== files.length)
			fail("missing_blob", "Incomplete directory capture");
		files.forEach(([, e], i) => { e.oid = hashes[i]; });
	}
	/** @type {Map<string,string>} */ const trees = new Map();
	for (const [folder, items] of directories) {
		for (const e of items)
			if (e.type === "tree")
				e.oid = trees.get(path.join(folder, e.name)) ?? fail("missing_tree", "Incomplete directory capture");
		trees.set(folder, build(root, items));
	}
	return pin(root, replace(root, treeOf(root, generation), directory, trees.get(dir) ?? null), "Foundry grain candidate");
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

/** @param {string} cwd @param {import("./model.js").Policy} policy @param {string} commit */
export function verifyContracts(cwd, policy, commit) {
	if (commit === policy.base)
		return;
	const files = new Set([policy.source, policy.productCheck, ...policy.grains.flatMap(g => [g.specification, ...g.boundary, g.check]), ...policy.squads.map(s => s.charter)]);
	const changed = git(cwd, ["diff-tree", "--no-ext-diff", "--no-renames", "-r", "--name-only", "-z", policy.base, commit, "--", ...files]).toString().split("\0").filter(Boolean);
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

/** @param {string} cwd @param {string} commit @param {(root:string)=>void} evaluate */
export async function withProduct(cwd, commit, evaluate) {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "foundry-check-")));
	try {
		const items = entries(cwd, commit, true), paths = new Map();
		for (const e of items) {
			if (!["100644", "100755"].includes(e.mode))
				fail("unsupported_tree", `Cannot evaluate ${e.name}: not a regular file`);
			let p = "";
			for (const part of e.name.split("/")) {
				p = p ? `${p}/${part}` : part;
				const k = p.normalize("NFC").toLowerCase();
				if (paths.has(k) && paths.get(k) !== p)
					fail("tree_conflict", `Case-aliased path: ${p}`);
				paths.set(k, p);
			}
		}
		await materialize(cwd, root, items);
		evaluate(root);
		/** @param {string} dir */
		function verifyNames(dir) {
			for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
				const name = dir ? `${dir}/${entry.name}` : entry.name;
				if (paths.get(name.normalize("NFC").toLowerCase()) !== name)
					fail("product_changed", `Evaluator added ${name}`);
				if (entry.isDirectory())
					verifyNames(name);
			}
		}
		verifyNames("");
		for (const e of items) {
			const file = path.join(root, e.name), stat = lstatSync(file);
			if (!stat.isFile() || stat.nlink !== 1 || realpathSync(file) !== file || Boolean(stat.mode & 0o100) !== (e.mode === "100755"))
				fail("product_changed", `Evaluator changed ${e.name}`);
		}
		const hashes = git(cwd, ["hash-object", "--no-filters", "--stdin-paths"], items.map(e => `${path.join(root, e.name)}\n`).join("")).toString().trimEnd().split("\n");
		for (const [i, e] of items.entries())
			if (hashes[i] !== e.oid) fail("product_changed", `Evaluator changed ${e.name}`);
	}
	finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** @param {string} dir @param {string[]} paths */
export const outside = (dir, paths) => !paths.some(p => {
	const a = dir.normalize("NFC").toLowerCase(), b = p.normalize("NFC").toLowerCase();
	return contains(a, b) || contains(b, a);
});
