import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { FoundryError, decodeCheck, decodeInput, decodeLimits as limits, decodeScope, digest, json, record, resourcePath, text } from "./values.mjs";

/** @typedef {import("./model.js").Check} Check */
/** @typedef {import("./model.js").Task} Task */

/** @param {unknown} value @returns {Check} */
export function compileCheck(value) {
	const input = record(value);
	closed(input, ["id", "origin", "requirement", "kind", "command", "path", "oracleFiles", "artifactFiles", "version"]);
	const definition = {
		id: text(input.id, "check id"),
		origin: input.origin ?? "contract",
		requirement: text(input.requirement, "check requirement"),
		kind: input.kind,
		...(input.command === undefined ? {} : { command: input.command }),
		...(input.path === undefined ? {} : { path: input.path }),
		...(input.oracleFiles === undefined ? {} : { oracleFiles: input.oracleFiles }),
		...(input.artifactFiles === undefined ? {} : { artifactFiles: array(input.artifactFiles, "artifact files").map(resourcePath).sort() }),
	};
	const version = digest(json(definition));
	if (input.version !== undefined && input.version !== version) {
		throw new FoundryError("check_version_mismatch", "A check version must identify its exact definition");
	}
	return decodeCheck({ ...definition, version });
}

/**
 * A source contract describes meaning; its execution records live in work.sqlite.
 * Compilation makes no model calls and invents neither teams nor a verifier DAG.
 *
 * @param {unknown} value
 * @param {ReturnType<typeof import("./store.mjs").openWorkStore>} store
 * @param {string} actor
 * @param {{reference:string,sha256:string}} [source]
 */
export function compileGoal(value, store, actor, source) {
	const input = record(value);
	closed(input, ["id", "title", "scope", "projectId", "limits", "tasks", "format", "version"]);
	const scope = decodeScope(input.scope);
	const definitions = array(input.tasks ?? [], "tasks").map(value => {
		const task = record(value);
		closed(task, ["id", "parentId", "teamId", "title", "assignment", "workType", "checks", "scope", "inputs"]);
		const workType = text(task.workType, "work type");
		if (!scope.workTypes.includes("*") && !scope.workTypes.includes(workType)) throw new FoundryError("scope_widening", `Work type ${workType} is outside the goal scope`);
		return {
			title: text(task.title, "task title"),
			assignment: text(task.assignment, "complete assignment"),
			workType,
			checks: array(task.checks ?? [], "checks").map(compileCheck),
			...(task.id === undefined ? {} : { id: text(task.id, "task id") }),
			...(task.parentId === undefined ? {} : { parentId: text(task.parentId, "parent task") }),
			...(task.teamId === undefined ? {} : { teamId: text(task.teamId, "task team") }),
			...(task.scope === undefined ? {} : { scope: decodeScope(task.scope) }),
			inputs: array(task.inputs ?? [], "versioned inputs").map(decodeInput),
		};
	});
	const pending = [...definitions];
	/** @type {typeof definitions} */
	const ordered = [];
	while (pending.length) {
		const remaining = new Set(pending.map(task => task.id).filter(id => id !== undefined));
		const index = pending.findIndex(task => [task.parentId, ...task.inputs.map(input => input.taskId)]
			.every(id => id === undefined || !remaining.has(id)));
		if (index < 0) throw new FoundryError("dependency_cycle", "Initial task relationships contain a cycle");
		ordered.push(...pending.splice(index, 1));
	}
	return store.createGoalWithTasks({
		title: text(input.title, "goal title"),
		scope,
		...(input.id === undefined ? {} : { id: text(input.id, "goal id") }),
		...(input.projectId === undefined ? {} : { projectId: text(input.projectId, "project id") }),
		...(input.limits === undefined ? {} : { limits: decodeLimits(input.limits) }),
		...(source === undefined ? {} : { source }),
	}, ordered, actor);
}

/** @param {Record<string, unknown>} input @param {string[]} fields */
function closed(input, fields) {
	const extra = Object.keys(input).filter(key => !fields.includes(key));
	if (extra.length) throw new FoundryError("unsupported_fields", `Unsupported source fields: ${extra.join(", ")}`);
}

/** @param {unknown} value @param {string} label @returns {unknown[]} */
export function array(value, label) {
	if (!Array.isArray(value)) throw new FoundryError("invalid_input", `${label} must be an array`);
	return value;
}

/** @param {unknown} value @param {string} label */
export function number(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new FoundryError("invalid_input", `${label} must be a finite number`);
	return value;
}

/** @param {unknown} value @returns {import("./model.js").Limits} */
export function decodeLimits(value) {
	const input = record(value);
	closed(input, ["workers", "credits", "repairs", "deadline"]);
	return limits(input);
}

/** @param {string} directory @param {string} filename */
export function readContract(directory, filename) {
	const root = realpathSync(directory);
	const resolved = realpathSync(path.resolve(root, filename));
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.startsWith(`.foundry${path.sep}`)) {
		throw new FoundryError("contract_scope", "Contracts must be repository-owned .foundry source artifacts");
	}
	const content = readFileSync(resolved, "utf8");
	const input = record(/** @type {unknown} */ (JSON.parse(content)));
	if (input.format !== "foundry-contract" || input.version !== 1) {
		throw new FoundryError("unsupported_contract", "Expected a foundry-contract version 1 source document");
	}
	return { definition: input, reference: relative, sha256: createHash("sha256").update(content).digest("hex") };
}
