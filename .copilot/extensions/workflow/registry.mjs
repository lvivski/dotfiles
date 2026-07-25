/** @module registry — project/user workflow discovery with nearest-scope precedence. */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

/** @param {string} cwd @returns {string|null} */
export function findRepositoryRoot(cwd) {
	let dir = resolve(cwd);
	const root = parse(dir).root;
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dir === root) return null;
		dir = dirname(dir);
	}
}

/** Closest project workflow directories first. @param {string} cwd */
export function projectWorkflowDirs(cwd) {
	const repo = findRepositoryRoot(cwd);
	if (!repo) return [];
	const dirs = [];
	let dir = resolve(cwd);
	while (true) {
		dirs.push(join(dir, ".copilot", "workflows"));
		if (dir === repo) break;
		dir = dirname(dir);
	}
	return dirs;
}

/**
 * Resolve a workflow name. Project definitions win by nearest directory, then user scope.
 * @param {string} name
 * @param {{ cwd: string, userDir: string }} opts
 * @returns {{ path: string, scope: "project"|"user", root: string }|null}
 */
export function resolveWorkflowDefinition(name, { cwd, userDir }) {
	for (const dir of projectWorkflowDirs(cwd)) {
		const path = safeDefinition(join(dir, `${name}.mjs`), dir);
		if (path) return { path, scope: "project", root: dir };
	}
	const path = safeDefinition(join(userDir, `${name}.mjs`), userDir);
	return path ? { path, scope: "user", root: userDir } : null;
}

/** @param {string} path @param {string} root @returns {string|null} */
function safeDefinition(path, root) {
	try {
		if (!lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) return null;
		const actual = realpathSync(path);
		const actualRoot = realpathSync(root);
		const rel = relative(actualRoot, actual);
		if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
		return actual;
	} catch {
		return null;
	}
}
