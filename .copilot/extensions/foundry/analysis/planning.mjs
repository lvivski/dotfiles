import { errorCode, errorMessage, isList, isOneOf, isRecord, property, readJsonValue } from "../data.mjs";
import { validateDependencyGraph, validateTaskTopology } from "../plan/graph.mjs";
import { DELIVERY_REQUIREMENT, LIMITS } from "../plan/values.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { plainObject, stringList, text } from "./fields.mjs";
import { fail, FoundryAnalysisError } from "../errors.mjs";

/**
 * @typedef {object} PlanningInput
 * @property {string} objective
 * @property {string[]} constraints
 * @property {string} repositoryContext
 * @property {number} maxTasks
 * @property {import("../types/json.js").JsonObject} [factoryContext] Opaque, bounded JSON context; the factory bridge validates authority.
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
	const maxTasks = input.maxTasks ?? 6;
	if (typeof maxTasks !== "number" || !Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 12) {
		fail(
			"invalid_analysis_input",
			"input.maxTasks must be an integer from 1 through 12",
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
	if (factoryContext && stableStringify(factoryContext).length > 128 * 1024) {
		fail("invalid_analysis_input", "Factory planning context exceeds 128 KiB; choose a smaller coherent unit");
	}
	return {
		objective: text(input.objective, "input.objective", LIMITS.objective),
		constraints: stringList(
			input.constraints ?? [],
			"input.constraints",
			LIMITS.constraints,
			LIMITS.constraint,
		),
		repositoryContext: text(
			input.repositoryContext,
			"input.repositoryContext",
			16_000,
		),
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
 * @returns {PlanBlueprint}
 */
export function validatePlanBlueprint(value, maxTasks) {
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
		const id = text(task.id, `plan.tasks[${index}].id`, 5);
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
			title: text(task.title, `plan.tasks[${index}].title`, LIMITS.taskTitle),
			kind,
			description: text(
				task.description,
				`plan.tasks[${index}].description`,
				LIMITS.taskDescription,
			),
			dependsOn: stringList(
				task.dependsOn,
				`plan.tasks[${index}].dependsOn`,
				LIMITS.dependencies,
				5,
			),
			acceptanceCriteria: stringList(
				task.acceptanceCriteria,
				`plan.tasks[${index}].acceptanceCriteria`,
				LIMITS.acceptanceCriteria,
				LIMITS.acceptanceCriterion,
				kind === "verify" ? 0 : 1,
			),
			expectedFiles: stringList(
				task.expectedFiles,
				`plan.tasks[${index}].expectedFiles`,
				LIMITS.expectedFiles,
				LIMITS.expectedFile,
			),
			deliveryRequirement,
		};
	});
	try {
		validateDependencyGraph(tasks);
		const { verifyTask } = validateTaskTopology(tasks);
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
		title: text(blueprint.title, "plan.title", LIMITS.planTitle),
		objective: text(blueprint.objective, "plan.objective", LIMITS.objective),
		constraints: stringList(
			blueprint.constraints,
			"plan.constraints",
			LIMITS.constraints,
			LIMITS.constraint,
		),
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
	if ((isList(result.issues) && result.issues.length > 0)
		|| (isList(result.missingPerspectives)
			&& result.missingPerspectives.length > 0)
		|| property(result.verification, "passed") !== true) {
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
	const plan = validatePlanBlueprint(result.plan, maxTasks);
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
