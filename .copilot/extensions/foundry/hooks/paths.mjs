import path from "node:path";
import { property } from "../data.mjs";

/** File-oriented tools whose arguments can be checked against the workspace. */
const FILE_WRITE_TOOLS = new Set([
	"apply_patch",
	"create",
	"edit",
	"write",
]);

/**
 * Tests whether a candidate path remains inside a workspace root.
 *
 * Handles POSIX, Windows absolute, drive-relative, and UNC path families
 * without allowing cross-platform path aliases.
 *
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
function inside(root, candidate) {
	const windowsRoot = /^[A-Za-z]:[\\/]/.test(root) || /^\\\\/.test(root);
	const windowsCandidate = /^[A-Za-z]:[\\/]/.test(candidate)
		|| /^\\\\/.test(candidate);
	const posixCandidate = path.posix.isAbsolute(candidate);
	if (windowsRoot ? (posixCandidate && !windowsCandidate) : windowsCandidate) {
		return false;
	}
	const implementation = windowsRoot ? path.win32 : path.posix;
	const resolvedRoot = implementation.resolve(root);
	const resolvedCandidate = implementation.isAbsolute(candidate)
		? implementation.resolve(candidate)
		: implementation.resolve(resolvedRoot, candidate);
	const relative = implementation.relative(resolvedRoot, resolvedCandidate);
	return relative === ""
		|| (!relative.startsWith("..") && !implementation.isAbsolute(relative));
}

/**
 * Extracts path-like arguments from supported file-write tools.
 *
 * @param {string} toolName
 * @param {unknown} toolArgs
 * @returns {string[]}
 */
function absolutePathsFromArgs(toolName, toolArgs) {
	const found = [];
	if (toolArgs && typeof toolArgs === "object") {
		for (const key of ["path", "file", "target", "destination", "outputPath"]) {
			const value = property(toolArgs, key);
			if (typeof value === "string") {
				found.push(value);
			}
		}
	}
	if (toolName === "apply_patch" && typeof toolArgs === "string") {
		for (const match of toolArgs.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File:|Move to:) (.+)$/gm)) {
			found.push(match[1].trim());
		}
	}
	return found;
}

/**
 * Denies obvious file-tool writes outside the active workspace.
 *
 * @param {string} toolName
 * @param {unknown} toolArgs
 * @param {string | undefined} workingDirectory
 * @returns {{decision: "deny", reason: string} | null}
 */
export function inspectWriteBoundary(toolName, toolArgs, workingDirectory) {
	if (!workingDirectory) {
		return null;
	}
	const normalizedName = String(toolName ?? "").toLowerCase();
	if (!FILE_WRITE_TOOLS.has(normalizedName)) {
		return null;
	}
	const outside = absolutePathsFromArgs(normalizedName, toolArgs)
		.find((candidate) => !inside(workingDirectory, candidate));
	if (!outside) {
		return null;
	}
	return {
		decision: "deny",
		reason: `Foundry blocks writes outside the active workspace: ${outside}`,
	};
}
