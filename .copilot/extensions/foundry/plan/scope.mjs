import path from "node:path";
import { TASK_STATUS } from "./values.mjs";

/**
 * Canonicalizes a declared file scope for conservative overlap checks.
 *
 * @param {string} scope
 * @param {boolean} [allowAbsolute] Physical resources may name absolute POSIX paths.
 * @returns {{value: string, prefix: string, glob: boolean, root: boolean, unsafe: boolean}}
 */
function scopeDescriptor(scope, allowAbsolute = false) {
	const raw = String(scope);
	const windowsAbsolute = path.win32.isAbsolute(raw)
		|| /^[A-Za-z]:/.test(raw);
	const slashNormalized = raw.replace(/\\/g, "/");
	const normalized = slashNormalized.startsWith("/")
		? slashNormalized
		: slashNormalized.replace(/^(?:\.\/)+/, "");
	const rawTraversal = normalized.split("/").includes("..");
	const canonical = path.posix.normalize(normalized);
	const comparison = canonical.toLowerCase();
	const unsafe = rawTraversal
		|| /[\u0000-\u001f\u007f]/.test(raw)
		|| canonical.startsWith("../")
		|| canonical === ".."
		|| (allowAbsolute
			? /^[A-Za-z]:/.test(raw) || slashNormalized.startsWith("//")
				|| raw.startsWith("\\") || normalized.startsWith("~")
			: windowsAbsolute || canonical.startsWith("/"));
	const wildcard = canonical.search(/[*?[{]/);
	return {
		value: comparison.replace(/\/+$/, ""),
		prefix: (wildcard === -1 ? comparison : comparison.slice(0, wildcard))
			.replace(/\/+$/, ""),
		glob: wildcard !== -1,
		root: canonical === "." || canonical === "" || canonical === "/",
		unsafe,
	};
}

/**
 * Physical path resources overlap at segment boundaries, not arbitrary prefixes.
 * Unanchored, root, traversal and pattern scopes cannot prove independence.
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function resourcePathsMayOverlap(left, right) {
	const a = scopeDescriptor(left, true), b = scopeDescriptor(right, true);
	if ([a, b].some(scope => scope.root || scope.unsafe || scope.glob || !scope.prefix)) return true;
	return a.value.startsWith("/") !== b.value.startsWith("/")
		|| a.value === b.value
		|| a.value.startsWith(`${b.value}/`)
		|| b.value.startsWith(`${a.value}/`);
}

/**
 * Determines whether two declared scope collections may overlap.
 *
 * Empty, unsafe, root, or ambiguous scopes are treated as overlapping.
 *
 * @param {string[]} left
 * @param {string[]} right
 * @returns {boolean}
 */
export function scopesMayOverlap(left, right) {
	if (left.length === 0 || right.length === 0) {
		return true;
	}
	for (const leftScope of left) {
		const leftDescriptor = scopeDescriptor(leftScope);
		for (const rightScope of right) {
			const rightDescriptor = scopeDescriptor(rightScope);
			if (leftDescriptor.root
				|| rightDescriptor.root
				|| leftDescriptor.unsafe
				|| rightDescriptor.unsafe
				|| !leftDescriptor.prefix
				|| !rightDescriptor.prefix
				|| leftDescriptor.value === rightDescriptor.value
				|| leftDescriptor.prefix.startsWith(`${rightDescriptor.prefix}/`)
				|| rightDescriptor.prefix.startsWith(`${leftDescriptor.prefix}/`)
				|| (leftDescriptor.glob && rightDescriptor.value.startsWith(leftDescriptor.prefix))
				|| (rightDescriptor.glob && leftDescriptor.value.startsWith(rightDescriptor.prefix))
				|| (leftDescriptor.glob && rightDescriptor.glob
					&& (leftDescriptor.prefix.startsWith(rightDescriptor.prefix)
						|| rightDescriptor.prefix.startsWith(leftDescriptor.prefix)))) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Finds pairwise scope conflicts involving at least one ready task.
 *
 * @param {Pick<import("../types/plan.js").FoundryTask, "id" | "status" | "expectedFiles">[]} tasks
 * @returns {Array<{taskIds: [string, string], reason: string}>}
 */
export function findScopeConflicts(tasks) {
	const relevant = tasks
		.filter((task) => task.status === TASK_STATUS.READY
			|| task.status === TASK_STATUS.RUNNING)
		.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
	/** @type {Array<{taskIds: [string, string], reason: string}>} */
	const conflicts = [];
	for (let leftIndex = 0; leftIndex < relevant.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < relevant.length; rightIndex += 1) {
			const left = relevant[leftIndex];
			const right = relevant[rightIndex];
			if (left.status !== TASK_STATUS.READY
				&& right.status !== TASK_STATUS.READY) {
				continue;
			}
			if (scopesMayOverlap(left.expectedFiles, right.expectedFiles)) {
				conflicts.push({
					taskIds: [left.id, right.id],
					reason: left.expectedFiles.length === 0 || right.expectedFiles.length === 0
						? "At least one task has an unspecified file scope"
						: "Declared file scopes may overlap",
				});
			}
		}
	}
	return conflicts;
}

/**
 * Selects a deterministic non-overlapping subset of ready tasks.
 *
 * @param {Pick<import("../types/plan.js").FoundryTask, "id" | "expectedFiles">[]} tasks Ready task candidates.
 * @param {Pick<import("../types/plan.js").FoundryTask, "id" | "expectedFiles">[]} [occupied] Tasks with active reservations.
 * @returns {{dispatchableTaskIds: string[], heldTaskIds: string[], occupiedTaskIds: string[]}}
 */
export function selectNonOverlappingTasks(tasks, occupied = []) {
	/** @type {Pick<import("../types/plan.js").FoundryTask, "id" | "expectedFiles">[]} */
	const selected = [];
	const held = [];
	for (const task of [...tasks].sort((left, right) => left.id < right.id ? -1 : 1)) {
		if (occupied.some((candidate) => scopesMayOverlap(candidate.expectedFiles, task.expectedFiles))
			|| selected.some((candidate) => scopesMayOverlap(candidate.expectedFiles, task.expectedFiles))) {
			held.push(task.id);
		} else {
			selected.push(task);
		}
	}
	return {
		dispatchableTaskIds: selected.map((task) => task.id),
		heldTaskIds: held,
		occupiedTaskIds: occupied.map((task) => task.id).sort(),
	};
}
