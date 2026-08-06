/** @module snapshot — immutable, hashed snapshots of Conveyor host bundles. */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { atomicWriteFile, atomicWriteJson, readJsonFile } from "./persistence.mjs";

const MANIFEST = "manifest.json";
const ENTRY = "index.mjs";
const RELATIVE_IMPORT =
	/\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

/** Resolve a host file or bundle directory to its executable module. @param {string} source */
export function hostEntry(source) {
	const path = resolve(source);
	const stat = lstatSync(path);
	if (stat.isDirectory()) {
		const entry = join(path, ENTRY);
		if (!isFile(entry)) throw new Error(`host bundle ${path} must contain ${ENTRY}`);
		return entry;
	}
	if (!stat.isFile()) throw new Error(`host source is not a regular file or directory: ${path}`);
	return path;
}

/**
 * Snapshot a self-contained host module or bundle directory into `target`.
 * Single files must not use relative imports; use a bundle directory for multi-file hosts.
 * @param {string} source
 * @param {string} target
 */
export function snapshotHost(source, target) {
	const resolved = resolve(source);
	const sourceStat = lstatSync(resolved);
	const sourceRoot = sourceStat.isDirectory() ? resolved : isSnapshotEntry(resolved) ? dirname(resolved) : null;
	if (sourceRoot && resolve(sourceRoot) === resolve(target)) throw new Error("host snapshot source and target must differ");
	const entry = hostEntry(resolved);
	const files = sourceRoot ? collectBundle(sourceRoot) : collectSingle(entry);
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	for (const file of files) {
		const destination = join(target, file.relative);
		atomicWriteFile(destination, readFileSync(file.path));
	}
	const manifest = {
		version: 1,
		entry: sourceRoot ? relative(sourceRoot, entry) : ENTRY,
		files: files.map(({ relative: path, hash, size }) => ({ path, hash, size })),
	};
	atomicWriteJson(join(target, MANIFEST), manifest);
	verifyHostSnapshot(target);
	return { root: target, entry: join(target, manifest.entry), manifest };
}

/** Verify every file in a host snapshot and return its executable entry. @param {string} root */
export function verifyHostSnapshot(root) {
	const resolved = resolve(root);
	const manifest = readJsonFile(join(resolved, MANIFEST));
	if (!manifest || manifest.version !== 1 || typeof manifest.entry !== "string" || !Array.isArray(manifest.files)) {
		throw new Error(`invalid host snapshot manifest: ${join(resolved, MANIFEST)}`);
	}
	const seen = new Set();
	for (const item of manifest.files) {
		if (!item || typeof item.path !== "string" || !safeRelative(item.path) || seen.has(item.path)) {
			throw new Error(`invalid host snapshot path: ${String(item?.path)}`);
		}
		seen.add(item.path);
		const path = join(resolved, item.path);
		if (!isFile(path)) throw new Error(`host snapshot file is missing: ${item.path}`);
		const body = readFileSync(path);
		if (body.length !== item.size || digest(body) !== item.hash) {
			throw new Error(`host snapshot file failed integrity verification: ${item.path}`);
		}
	}
	const actual = new Set(listBundlePaths(resolved));
	if (actual.size !== seen.size || [...actual].some((path) => !seen.has(path))) {
		throw new Error("host snapshot contains files not covered by its manifest");
	}
	if (!seen.has(manifest.entry)) throw new Error(`host snapshot entry is not listed in its manifest: ${manifest.entry}`);
	return { root: resolved, entry: join(resolved, manifest.entry), manifest };
}

/** @param {string} path */
function isSnapshotEntry(path) {
	return basename(path) === ENTRY && existsSync(join(dirname(path), MANIFEST));
}

/** @param {string} entry */
function collectSingle(entry) {
	const source = readFileSync(entry, "utf8");
	const imports = [...source.matchAll(RELATIVE_IMPORT)].map((match) => match[1] || match[2]).filter(Boolean);
	if (imports.length) {
		throw new Error(
			`single-file host modules cannot use relative imports (${imports.join(", ")}); place the host and helpers in a bundle directory with ${ENTRY}`,
		);
	}
	const body = Buffer.from(source);
	return [{ path: entry, relative: ENTRY, hash: digest(body), size: body.length }];
}

/** @param {string} root */
function collectBundle(root) {
	const realRoot = realpathSync(root);
	/** @type {{ path: string, relative: string, hash: string, size: number }[]} */
	const files = [];
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (dir === root && entry.name === MANIFEST) continue;
			const path = join(dir, entry.name);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new Error(`host bundles cannot contain symbolic links: ${relative(root, path)}`);
			if (stat.isDirectory()) {
				visit(path);
				continue;
			}

			if (!stat.isFile()) throw new Error(`host bundles can contain only regular files: ${relative(root, path)}`);
			const real = realpathSync(path);
			if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error(`host bundle file escapes its root: ${path}`);
			const rel = relative(root, path);
			if (!safeRelative(rel)) throw new Error(`unsafe host bundle path: ${rel}`);
			const body = readFileSync(path);
			files.push({ path, relative: rel, hash: digest(body), size: body.length });
		}
	};
	visit(root);
	if (!files.some((file) => file.relative === ENTRY)) throw new Error(`host bundle ${root} must contain ${ENTRY}`);
	return files;
}

/** Enumerate the snapshot file set without re-reading or re-hashing file contents. @param {string} root */
function listBundlePaths(root) {
	/** @type {string[]} */
	const files = [];
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (dir === root && entry.name === MANIFEST) continue;
			const path = join(dir, entry.name);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new Error(`host bundles cannot contain symbolic links: ${relative(root, path)}`);
			if (stat.isDirectory()) visit(path);
			else if (stat.isFile()) files.push(relative(root, path));
			else throw new Error(`host bundles can contain only regular files: ${relative(root, path)}`);
		}
	};
	visit(root);
	return files;
}

/** @param {string} value */
function safeRelative(value) {
	return !!value && !value.startsWith("..") && !value.includes("\0") && !value.split(/[\\/]/).includes("..");
}

/** @param {string|Buffer} body */
function digest(body) {
	return createHash("sha256").update(body).digest("hex");
}

/** @param {string} path */
function isFile(path) {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}
