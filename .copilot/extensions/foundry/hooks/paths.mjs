import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { errorCode, errorMessage, property } from "../data.mjs";

/** @typedef {Pick<import("@github/copilot-sdk").CopilotSession, "sessionId" | "workspacePath"> & {
 *   rpc: {extensions: Pick<import("@github/copilot-sdk").CopilotSession["rpc"]["extensions"], "list">},
 * }} HelperSession */

const SESSION_HELPER = "foundry-exact-relay";

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
 * Requires real directories and unlinked regular files beneath the session helper.
 * Missing descendants are permitted for creation, but the registered directory must exist.
 *
 * @param {string} workspacePath
 * @param {string} candidate
 */
function requireHelperTarget(workspacePath, candidate) {
	const root = lstatSync(workspacePath);
	if (root.isSymbolicLink() || !root.isDirectory()) {
		throw new Error("Session workspace must be a real directory");
	}
	const realRoot = realpathSync(workspacePath);
	const parts = path.relative(workspacePath, candidate).split(path.sep);
	let current = workspacePath;
	for (const [index, part] of parts.entries()) {
		current = path.join(current, part);
		let metadata;
		try {
			metadata = lstatSync(current);
		} catch (error) {
			if (errorCode(error) === "ENOENT" && index >= 2) return;
			throw error;
		}
		const final = index === parts.length - 1;
		if (metadata.isSymbolicLink()
			|| (final ? !metadata.isFile() || metadata.nlink !== 1 : !metadata.isDirectory())
			|| realpathSync(current) !== path.join(realRoot, ...parts.slice(0, index + 1))) {
			throw new Error(`Helper target must remain unlinked inside its registered directory: ${current}`);
		}
	}
}

/**
 * Denies file writes outside the workspace except the registered owner-local relay.
 * The session is supplied by the extension after matching native hook ownership, never tool args.
 *
 * @param {string} toolName
 * @param {unknown} toolArgs
 * @param {string | undefined} workingDirectory
 * @param {HelperSession | null | undefined} [session]
 * @returns {Promise<{decision: "deny", reason: string} | null>}
 */
export async function inspectWriteBoundary(toolName, toolArgs, workingDirectory, session) {
	const normalizedName = String(toolName ?? "").toLowerCase();
	if (!FILE_WRITE_TOOLS.has(normalizedName)) {
		return null;
	}
	if (!workingDirectory) {
		return { decision: "deny", reason: "Foundry cannot verify file writes without the active workspace" };
	}
	const outside = absolutePathsFromArgs(normalizedName, toolArgs)
		.filter((candidate) => !inside(workingDirectory, candidate));
	if (outside.length === 0) {
		return null;
	}
	const denied = /** @type {const} */ ({
		decision: "deny",
		reason: `Foundry blocks writes outside the active workspace: ${outside[0]}`,
	});
	const workspacePath = session?.workspacePath;
	if (!session?.sessionId || !workspacePath || !path.isAbsolute(workspacePath)) return denied;
	const helperRoot = path.join(workspacePath, "extensions", SESSION_HELPER);
	const invalid = outside.find((candidate) => !path.isAbsolute(candidate)
		|| candidate.split(/[\\/]/).includes("..")
		|| !inside(helperRoot, candidate)
		|| path.resolve(candidate) === helperRoot);
	if (invalid) {
		return { decision: "deny", reason: `Foundry blocks writes outside the active workspace: ${invalid}` };
	}
	try {
		const registry = await session.rpc.extensions.list();
		const matches = registry.extensions.filter((extension) => extension.source === "session"
			&& extension.name === SESSION_HELPER);
		if (matches.length !== 1 || !matches[0].id || matches[0].status !== "running") {
			return { decision: "deny", reason: `Foundry requires a running owner-local registration for ${SESSION_HELPER}` };
		}
		for (const candidate of outside) requireHelperTarget(workspacePath, candidate);
	} catch (error) {
		return { decision: "deny", reason: `Foundry could not verify the registered helper write boundary: ${errorMessage(error)}` };
	}
	return null;
}
