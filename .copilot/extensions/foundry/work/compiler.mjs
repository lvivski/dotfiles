import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as Tasks from "./tasks.mjs";
import { FoundryError, closedFields as closed, decodeCheck, decodeInput, decodeLimits as limits, decodeScope, digest, json, number as finiteNumber, record, resourcePath, text } from "./values.mjs";

/** @typedef {import("./model.js").Check} Check */
/** @typedef {import("./model.js").Task} Task */

/** @param {unknown} value @returns {Check} */
export function compileCheck(value) {
	const input = record(value);
	closed(input, ["id", "origin", "requirement", "kind", "command", "path", "oracleFiles", "oracleCommit", "artifactFiles", "version"]);
	const definition = {
		id: text(input.id, "check id"),
		origin: input.origin ?? "contract",
		requirement: text(input.requirement, "check requirement"),
		kind: input.kind,
		...(input.command === undefined ? {} : { command: input.command }),
		...(input.path === undefined ? {} : { path: input.path }),
		...(input.oracleFiles === undefined ? {} : { oracleFiles: input.oracleFiles }),
		...(input.oracleCommit === undefined ? {} : { oracleCommit: input.oracleCommit }),
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
 * Compilation makes no model calls and invents neither units nor a verifier DAG.
 *
 * @param {unknown} value
 * @param {import("./database.mjs").Database} store
 * @param {string} actor
 * @param {{reference:string,sha256:string}} [source]
 */
export function compileGoal(value, store, actor, source) {
	const compiled = compileDefinition(value, source);
	return store.write(Tasks.createGoalWithTasks, compiled.goal, compiled.tasks, actor, compiled.units);
}

/** @param {unknown} value @param {{reference:string,sha256:string}} [source] */
export function compileDefinition(value, source) {
	const input = record(value);
	closed(input, ["id", "title", "scope", "projectId", "limits", "tasks", "units", "format", "version"]);
	if ((input.format !== undefined || input.version !== undefined) && (input.format !== "foundry-contract" || input.version !== 2)) {
		throw new FoundryError("unsupported_contract", "Expected a foundry-contract version 2 definition");
	}
	const scope = decodeScope(input.scope);
	const definitions = array(input.tasks ?? [], "tasks").map(value => {
		const task = record(value);
		closed(task, ["id", "parentId", "unitId", "role", "title", "assignment", "workType", "checks", "scope", "inputs"]);
		const workType = text(task.workType, "work type");
		if (!scope.workTypes.includes("*") && !scope.workTypes.includes(workType)) throw new FoundryError("scope_widening", `Work type ${workType} is outside the goal scope`);
		return {
			title: text(task.title, "task title"),
			assignment: text(task.assignment, "complete assignment"),
			workType,
			...(task.role === undefined ? {} : { role: taskRole(task.role) }),
			checks: array(task.checks ?? [], "checks").map(compileCheck),
			...(task.id === undefined ? {} : { id: text(task.id, "task id") }),
			...(task.parentId === undefined ? {} : { parentId: text(task.parentId, "parent task") }),
			...(task.unitId === undefined ? {} : { unitId: text(task.unitId, "task unit") }),
			...(task.scope === undefined ? {} : { scope: record(task.scope) }),
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
	const units = array(input.units ?? [], "organizational units").map(value => {
		const unit = record(value);
		closed(unit, ["id", "parentId", "name", "kind", "context"]);
		return { id: text(unit.id, "unit template id"), name: text(unit.name, "unit name"),
			context: array(unit.context ?? [], "unit context").map(value => text(value, "unit context")),
			...(unit.parentId === undefined ? {} : { parentId: text(unit.parentId, "parent unit") }),
			...(unit.kind === undefined ? {} : { kind: text(unit.kind, "unit kind") }) };
	});
	const pendingUnits = [...units];
	/** @type {typeof units} */
	const orderedUnits = [];
	if (new Set(units.map(unit => unit.id)).size !== units.length) throw new FoundryError("duplicate_template", "Unit template identities must be unique");
	while (pendingUnits.length) {
		const index = pendingUnits.findIndex(unit => unit.parentId === undefined || orderedUnits.some(parent => parent.id === unit.parentId));
		if (index < 0) throw new FoundryError("invalid_parent", "Unit template parents must exist and be acyclic");
		orderedUnits.push(...pendingUnits.splice(index, 1));
	}
	return { units: orderedUnits, goal: {
		title: text(input.title, "goal title"),
		scope,
		...(input.id === undefined ? {} : { id: text(input.id, "goal id") }),
		...(input.projectId === undefined ? {} : { projectId: text(input.projectId, "project id") }),
		...(input.limits === undefined ? {} : { limits: decodeLimits(input.limits) }),
		...(source === undefined ? {} : { source }),
	}, tasks: ordered };
}

/** @param {unknown} value @param {string} label @returns {unknown[]} */
export function array(value, label) {
	if (!Array.isArray(value)) throw new FoundryError("invalid_input", `${label} must be an array`);
	return value;
}

/** @param {unknown} value @param {string} label */
export function number(value, label) {
	return finiteNumber(value, label, "invalid_input");
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
	if (input.format !== "foundry-contract" || input.version !== 2) {
		throw new FoundryError("unsupported_contract", "Expected a foundry-contract version 2 source document");
	}

	return { definition: input, reference: relative, sha256: createHash("sha256").update(content).digest("hex") };
}

/** @param {unknown} value @returns {Task["role"]} */
function taskRole(value) {
	if (value === "coordinator" || value === "producer") return value;
	throw new FoundryError("invalid_role", "Task role must be producer or coordinator");
}
