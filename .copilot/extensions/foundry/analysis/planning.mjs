import { errorCode, errorMessage, isList, isOneOf, isRecord, property, readJsonValue } from "../data.mjs";
import { validateDependencyGraph, validateTaskTopology } from "../plan/graph.mjs";
import { DELIVERY_REQUIREMENT, LIMITS } from "../plan/values.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { plainObject, stringList, text } from "./fields.mjs";
import { fail, FoundryAnalysisError } from "../errors.mjs";
import { visualCriterion } from "../factory/visual.mjs";

/**
 * @typedef {object} PlanningInput
 * @property {string} objective
 * @property {string[]} constraints
 * @property {string} repositoryContext
 * @property {number} maxTasks
 * @property {import("../types/json.js").JsonObject} [factoryContext] Complete opaque JSON context; the factory bridge validates authority.
 */
/** @typedef {PlanningInput & {inputDigest: string}} PlanningArgs */
/** @typedef {import("../types/plan.js").PlanBlueprint} PlanBlueprint */

/**
 * Validates and normalizes a planning request.
 *
 * @param {unknown} value
 * @returns {PlanningInput}
 */
export function normalizePlanningInput(value) {
	const input = plainObject(value, "input");
	const maxTasks = input.maxTasks ?? LIMITS.tasks - 1;
	if (typeof maxTasks !== "number" || !Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks >= LIMITS.tasks) {
		fail(
			"invalid_analysis_input",
			"input.maxTasks must be positive and leave a representable T-xxx identifier for the final verifier",
		);
	}
	const rawContext = input.factoryContext === undefined ? undefined : plainObject(input.factoryContext, "factoryContext");
	let factoryContext;
	if (rawContext) {
		try {
			const json = readJsonValue(rawContext);
			if (json === null || typeof json !== "object" || Array.isArray(json)) fail("invalid_analysis_input", "Factory context must be a JSON object");
			factoryContext = json;
		} catch (error) {
			fail("invalid_analysis_input", "Factory context must be finite, acyclic JSON data", { message: errorMessage(error) });
		}
	}
	return {
		objective: text(input.objective, "input.objective"),
		constraints: stringList(input.constraints ?? [], "input.constraints"),
		repositoryContext: text(input.repositoryContext, "input.repositoryContext"),
		maxTasks,
		...(factoryContext ? { factoryContext: structuredClone(factoryContext) } : {}),
	};
}

/**
 * Adds the canonical digest to normalized planning arguments.
 *
 * @param {unknown} value
 * @returns {PlanningArgs}
 */
export function buildPlanningArgs(value) {
	const normalized = normalizePlanningInput(value);
	return {
		...normalized,
		inputDigest: analysisInputDigest(normalized),
	};
}

/**
 * Validates a supplied planning digest against the shared canonical input.
 *
 * @param {unknown} value
 * @returns {PlanningArgs}
 */
export function validatePlanningArgs(value) {
	const input = plainObject(value, "args");
	if (Object.keys(input).some(key => !["objective", "constraints", "repositoryContext", "maxTasks", "factoryContext", "inputDigest"].includes(key))) {
		fail("invalid_analysis_input", "Planning arguments cannot supply repair budgets, native lineage or unexpected fields");
	}
	const canonical = buildPlanningArgs(input);
	if (input.inputDigest !== canonical.inputDigest) {
		fail("analysis_input_mismatch", "Planning arguments do not match their canonical digest");
	}
	return canonical;
}

/**
 * Validates a generated plan blueprint through the authoritative domain model.
 *
 * @param {unknown} value
 * @param {number} maxTasks
 * @param {unknown} [visual]
 * @returns {PlanBlueprint}
 */
export function validatePlanBlueprint(value, maxTasks, visual) {
	const blueprint = plainObject(value, "plan");
	if (!isList(blueprint.tasks)
		|| blueprint.tasks.length < 2
		|| blueprint.tasks.length > maxTasks + 1) {
		fail(
			"invalid_analysis_result",
			`plan.tasks must contain 1-${maxTasks} implementation tasks plus one verifier`,
		);
	}
	const ids = new Set();
	const tasks = blueprint.tasks.map((rawTask, index) => {
		const task = plainObject(rawTask, `plan.tasks[${index}]`);
		const id = text(task.id, `plan.tasks[${index}].id`);
		if (!/^T-\d{3}$/.test(id) || ids.has(id)) {
			fail(
				"invalid_analysis_result",
				`plan.tasks[${index}].id must be a unique T-001 identifier`,
			);
		}
		ids.add(id);
		if (!isOneOf(task.kind, ["implement", "verify"])) {
			fail(
				"invalid_analysis_result",
				`plan.tasks[${index}].kind must be implement or verify`,
			);
		}
		if (!isOneOf(task.deliveryRequirement, Object.values(DELIVERY_REQUIREMENT))) {
			fail(
				"invalid_analysis_result",
				`plan.tasks[${index}].deliveryRequirement must be branch, commit, or pr`,
			);
		}
		/** @type {"implement"|"verify"} */
		const kind = task.kind;
		/** @type {"branch"|"commit"|"pr"} */
		const deliveryRequirement = task.deliveryRequirement;
		return {
			id,
			title: text(task.title, `plan.tasks[${index}].title`),
			kind,
			description: text(task.description, `plan.tasks[${index}].description`),
			dependsOn: stringList(task.dependsOn, `plan.tasks[${index}].dependsOn`),
			acceptanceCriteria: stringList(task.acceptanceCriteria, `plan.tasks[${index}].acceptanceCriteria`, undefined, undefined, kind === "verify" ? 0 : 1),
			expectedFiles: stringList(task.expectedFiles, `plan.tasks[${index}].expectedFiles`),
			deliveryRequirement,
		};
	});
	try {
		validateDependencyGraph(tasks);
		const { verifyTask, targetTask } = validateTaskTopology(tasks);
		if (visual !== undefined && !targetTask?.acceptanceCriteria.includes(visualCriterion(visual))) {
			fail("invalid_analysis_result", "UI-producing plans must retain the exact declared visual fidelity criterion on their final implementation target");
		}
		if (verifyTask.deliveryRequirement !== DELIVERY_REQUIREMENT.COMMIT
			|| verifyTask.acceptanceCriteria.length !== 0
			|| verifyTask.expectedFiles.length !== 0) {
			fail(
				"invalid_analysis_result",
				"The verifier must use commit delivery with no authored criteria or files",
			);
		}
	} catch (error) {
		if (error instanceof FoundryAnalysisError) throw error;
		fail(
			"invalid_analysis_result",
			`Plan blueprint failed validation: ${errorMessage(error)}`,
			{ causeCode: errorCode(error) ?? null },
		);
	}
	return {
		title: text(blueprint.title, "plan.title"),
		objective: text(blueprint.objective, "plan.objective"),
		constraints: stringList(blueprint.constraints, "plan.constraints"),
		tasks,
	};
}

/**
 * Validates the complete multi-critic planning workflow result.
 *
 * @param {unknown} value
 * @param {unknown} expectedInput
 * @param {number} maxTasks
 * @returns {PlanBlueprint}
 */
export function validatePlanningResult(value, expectedInput, maxTasks) {
	const normalizedInput = normalizePlanningInput(expectedInput);
	const expectedDigest = analysisInputDigest(normalizedInput);
	const result = plainObject(value, "result");
	if (result.kind !== "foundry-plan-result") {
		fail("invalid_analysis_result", "Planning result kind is not supported");
	}
	if (result.inputDigest !== expectedDigest) {
		fail("analysis_input_mismatch", "Planning result input digest does not match the persisted run");
	}
	if (result.status !== "ready") {
		fail("analysis_needs_review", "Foundry planning did not produce a ready plan", {
			issues: isList(result.issues) ? result.issues : [],
			missingPerspectives: isList(result.missingPerspectives)
				? result.missingPerspectives
				: [],
		});
	}
	const verificationIssues = property(result.verification, "issues");
	if ((isList(result.issues) && result.issues.length > 0)
		|| (isList(result.missingPerspectives)
			&& result.missingPerspectives.length > 0)
		|| property(result.verification, "passed") !== true
		|| !isList(verificationIssues)
		|| verificationIssues.length !== 0) {
		fail("invalid_analysis_result", "Ready planning result contains unresolved review findings");
	}
	if (!isList(result.critiques)
		|| result.critiques.length !== 2
		|| result.critiques.some((critique) => (
			!isRecord(critique)
			|| !isOneOf(critique.verdict, ["accept", "revise"])
			|| !isList(critique.risks)
			|| !isList(critique.requiredChanges)
		))) {
		fail("invalid_analysis_result", "Ready planning result requires two complete critic perspectives");
	}
	const plan = validatePlanBlueprint(result.plan, maxTasks, normalizedInput.factoryContext?.visualEvaluation);
	if (plan.objective !== normalizedInput.objective
		|| stableStringify(plan.constraints)
		!== stableStringify(normalizedInput.constraints)) {
		fail(
			"analysis_input_mismatch",
			"Planning result changed the canonical objective or constraints",
		);
	}
	return plan;
}
