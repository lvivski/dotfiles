import { isRecord, readJsonValue } from "../data.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { fail } from "../errors.mjs";
import { plainObject, stringList, text } from "./fields.mjs";
import { validatePlanningArgs, validatePlanBlueprint } from "./planning.mjs";

/** @typedef {import("../types/json.js").JsonObject} JsonObject */
/** @typedef {import("../types/repair.js").RepairMaterial} Material */
/** @typedef {import("../types/repair.js").RepairPreparation} Preparation */

/** @param {unknown} value @param {string[]} keys @param {string} label */
export function closedRepairObject(value, keys, label) {
	const object = plainObject(value, label);
	if (Object.keys(object).some(key => !keys.includes(key))) fail("repair_input_invalid", `${label} contains unknown fields`);
	return object;
}

/** @param {unknown} value @returns {JsonObject} */
export function repairObject(value) {
	const json = readJsonValue(value);
	if (!isRecord(json)) fail("repair_input_invalid", "Repair evidence must be a JSON object");
	return json;
}

/** @param {unknown} value */
export function repairDigest(value) {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("repair_input_invalid", "Expected a SHA-256 repair identity");
	return value;
}

/** @param {unknown} value @returns {import("../types/repair.js").PlanningVerdict} */
export function planningVerdict(value) {
	const object = closedRepairObject(value, ["passed", "issues"], "verification");
	if (typeof object.passed !== "boolean") fail("repair_review_invalid", "Independent review requires a boolean verdict");
	return { passed: object.passed, issues: stringList(object.issues, "verification.issues", 128, 16000) };
}

/** @param {unknown} value @returns {import("../types/repair.js").PlanningCritique} */
function critique(value) {
	const object = closedRepairObject(value, ["verdict", "risks", "requiredChanges"], "critic");
	if (object.verdict !== "accept" && object.verdict !== "revise") fail("repair_critics_missing", "Repair requires the original complete critics");
	return {
		verdict: object.verdict,
		risks: stringList(object.risks, "critic.risks", 128, 16000),
		requiredChanges: stringList(object.requiredChanges, "critic.requiredChanges", 128, 16000),
	};
}

/** @param {unknown} value @returns {Material} */
export function repairMaterial(value) {
	const object = closedRepairObject(value, ["input", "candidate", "critiques", "diagnostics", "verification", "decomposition", "stage"], "repair material");
	if (!Array.isArray(object.critiques) || object.critiques.length !== 2 || object.critiques.some(item => item == null)) {
		fail("repair_critics_missing", "Repair requires exactly two original critics");
	}
	if (object.stage !== "structural" && object.stage !== "semantic") fail("repair_input_invalid", "Unknown repair stage");
	const input = validatePlanningArgs(object.input);
	if (stableStringify(input) !== stableStringify(object.input)) fail("repair_input_invalid", "Repair must retain the full canonical input");
	if (!isRecord(object.candidate)) fail("repair_candidate_missing", "Repair requires an original candidate, not an upstream substitute");
	const verification = object.verification === null ? null : planningVerdict(object.verification);
	if (object.stage === "semantic" && (!verification || verification.passed || !verification.issues.length)) {
		fail("repair_source_ineligible", "Semantic repair requires the original failed semantic verdict");
	}
	return {
		input, candidate: readJsonValue(object.candidate),
		critiques: [critique(object.critiques[0]), critique(object.critiques[1])],
		diagnostics: stringList(object.diagnostics, "diagnostics", 128, 16000, 1),
		verification, decomposition: readJsonValue(object.decomposition), stage: object.stage,
	};
}

/** Normalize only the injected objective/constraints; never substitute a decomposition.
 * @param {unknown} value @param {import("./planning.mjs").PlanningArgs} input @param {string} stage */
export function inspectRepairCandidate(value, input, stage) {
	const json = readJsonValue(value);
	const blueprint = { ...(isRecord(json) ? json : {}), objective: input.objective, constraints: input.constraints };
	try {
		return { plan: validatePlanBlueprint(blueprint, input.maxTasks, input.factoryContext?.visualEvaluation), blueprint, issue: null };
	} catch (error) {
		return { plan: null, blueprint, issue: `${stage} rejected: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Structural invariants are not an agent verdict about substantive conservation.
 * @param {Material} material @param {unknown} candidate */
export function checkRepairConservation(material, candidate) {
	const original = plainObject(material.candidate, "original candidate");
	const repaired = plainObject(candidate, "repair candidate");
	if (!Array.isArray(original.tasks) || !Array.isArray(repaired.tasks) || original.tasks.length !== repaired.tasks.length) {
		fail("repair_conservation", "Repair cannot add or remove tasks");
	}
	if (("objective" in repaired && repaired.objective !== material.input.objective)
		|| ("constraints" in repaired && stableStringify(repaired.constraints) !== stableStringify(material.input.constraints))) {
		fail("repair_conservation", "Repair cannot change objective or constraints");
	}
	for (const [index, raw] of original.tasks.entries()) {
		const before = plainObject(raw, "original task");
		const after = plainObject(repaired.tasks[index], "repaired task");
		for (const field of ["id", "kind", "dependsOn", "expectedFiles", "deliveryRequirement"]) {
			if (stableStringify(before[field]) !== stableStringify(after[field])) fail("repair_conservation", `Repair changed task ${field}`);
		}
	}
}

/** Authority projection excludes retrieved observations/proposals, never governing definitions.
 * @param {unknown} value */
export function repairAuthority(value) {
	const context = plainObject(value, "factory context");
	for (const field of ["repositoryId", "owner", "unitId", "unitRevision", "unit", "contract", "governing", "authority"]) {
		if (!Object.hasOwn(context, field)) fail("repair_authority_missing", `Factory context is missing ${field}`);
	}
	if (context.authority !== "discovery-only" && context.authority !== "accepted-contract") fail("repair_authority_missing", "Unknown factory authority");
	if (context.authority === "discovery-only" && (context.contract !== null || context.governing !== null)) fail("repair_authority_missing", "Discovery cannot acquire governing authority");
	if (context.authority === "accepted-contract" && (!isRecord(context.contract) || !isRecord(context.governing))) fail("repair_authority_missing", "Accepted authority is incomplete");
	repairDigest(context.repositoryId);
	text(context.owner, "owner", 4096);
	text(context.unitId, "unitId", 256);
	if (!Number.isSafeInteger(context.unitRevision) || Number(context.unitRevision) < 1) fail("repair_authority_missing", "Invalid capability revision");
	return repairObject(Object.fromEntries(["repositoryId", "owner", "unitId", "unitRevision", "unit", "contract", "governing", "authority", "visualEvaluation"]
		.filter(field => Object.hasOwn(context, field)).map(field => [field, context[field]])));
}

/** @param {Omit<Preparation, "format" | "id" | "digest" | "inputDigest">} value @returns {Preparation} */
export function buildRepairPreparation(value) {
	const material = repairMaterial(value.material);
	const { owner, sessionId, rootRunId, sourceDigest, mode, repositoryPath, authority, source } = value;
	const body = { owner, sessionId, rootRunId, sourceDigest, mode, repositoryPath, authority, source,
		format: /** @type {const} */ ("foundry-plan-repair-v1"), inputDigest: material.input.inputDigest, material };
	const id = analysisInputDigest([body.owner, body.sessionId, body.rootRunId]);
	return { ...body, id, digest: analysisInputDigest({ ...body, id }) };
}

/** @param {unknown} value @returns {Preparation} */
export function validateRepairPreparation(value) {
	const object = closedRepairObject(value, ["format", "id", "digest", "owner", "sessionId", "rootRunId", "inputDigest", "sourceDigest", "mode", "repositoryPath", "authority", "source", "material"], "preparation");
	if (object.format !== "foundry-plan-repair-v1" || (object.mode !== "inline" && object.mode !== "recovery")) fail("repair_input_invalid", "Unknown repair preparation");
	const preparation = buildRepairPreparation({
		owner: text(object.owner, "owner", 4096), sessionId: text(object.sessionId, "sessionId", 256),
		rootRunId: text(object.rootRunId, "rootRunId", 256), sourceDigest: repairDigest(object.sourceDigest), mode: object.mode,
		repositoryPath: object.repositoryPath === null ? null : text(object.repositoryPath, "repositoryPath", 4096),
		authority: object.authority === null ? null : repairAuthority(object.authority),
		source: object.source === null ? null : repairObject(object.source), material: repairMaterial(object.material),
	});
	if (stableStringify(preparation) !== stableStringify(object)) fail("repair_identity_mismatch", "Repair preparation content or identity changed");
	return preparation;
}

/** @param {Preparation} preparation @returns {import("../types/repair.js").RepairLaunch} */
export function repairLaunch(preparation) {
	return { name: "plan-repair", args: { preparationId: preparation.id, preparationDigest: preparation.digest } };
}

/** @param {unknown} value */
export function repairLaunchArgs(value) {
	const object = closedRepairObject(value, ["preparationId", "preparationDigest"], "repair launch");
	return { preparationId: repairDigest(object.preparationId), preparationDigest: repairDigest(object.preparationDigest) };
}

/** @param {unknown} value @returns {import("../types/repair.js").RepairOutcome} */
export function repairOutcome(value) {
	const object = closedRepairObject(value, ["plan", "verification", "synthesisRepair", "issues", "repairBudget"], "repair outcome");
	const repair = closedRepairObject(object.synthesisRepair, ["original", "diagnostic", "candidate", "issue", "stage", "originalVerification"], "repair evidence");
	const budget = closedRepairObject(object.repairBudget, ["rootRunId", "used", "preparationId", "preparationDigest"], "repair budget");
	if (budget.used !== true || (repair.stage !== "structural" && repair.stage !== "semantic")
		|| (repair.issue !== null && typeof repair.issue !== "string")) fail("repair_result_invalid", "Invalid repair result evidence");
	return {
		plan: repairObject(object.plan),
		verification: object.verification === null ? null : planningVerdict(object.verification),
		synthesisRepair: {
			original: readJsonValue(repair.original), diagnostic: text(repair.diagnostic, "diagnostic", 128 * 16000),
			candidate: readJsonValue(repair.candidate), issue: repair.issue, stage: repair.stage,
			originalVerification: repair.originalVerification === null ? null : planningVerdict(repair.originalVerification),
		},
		issues: stringList(object.issues, "issues", 128, 16000),
		repairBudget: {
			rootRunId: text(budget.rootRunId, "rootRunId", 256), used: true,
			preparationId: repairDigest(budget.preparationId), preparationDigest: repairDigest(budget.preparationDigest),
		},
	};
}
