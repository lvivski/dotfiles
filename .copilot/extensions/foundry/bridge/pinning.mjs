import { analysisInputDigest } from "../digest.mjs";
import { isRecord } from "../data.mjs";
import { FoundryFactoryError, fail } from "../factory/fields.mjs";
import { key as refKey } from "../factory/records.mjs";
import { evaluationCriterion } from "../factory/criterion.mjs";
import { validateTaskTopology } from "../plan/graph.mjs";

/** @typedef {import("../types/factory.js").KnowledgeRef} KnowledgeRef */
/** @typedef {import("../types/factory.js").ProjectedEvaluation} ProjectedEvaluation */
/** @typedef {{repositoryId: string, unitId: string, unitRevision: number, owner: string, contract: {digest: string, revision: number} | null}} PlanningContext */

export { evaluationCriterion };

/** Locate a governing check by its exact revision/digest criterion, not T-001 or array position.
 * @param {import("../types/plan.js").FoundryPlan} plan @param {ProjectedEvaluation} entry */
export function evaluationCheckId(plan, entry) {
	const { targetTask, verifyTask } = validateTaskTopology(plan.tasks, plan.evaluationTarget ?? null);
	const taskId = plan.evaluationTarget ? verifyTask.id : targetTask?.id;
	const criteria = plan.evaluationTarget?.criteria ?? targetTask?.acceptanceCriteria ?? [];
	const criterion = evaluationCriterion(entry);
	const index = criteria.indexOf(criterion);
	if (!taskId || index < 0 || criteria.lastIndexOf(criterion) !== index) {
		fail("factory_evaluation_coverage", "The final target must contain each exact pinned evaluation criterion once");
	}
	return `${taskId}-C${String(index + 1).padStart(3, "0")}`;
}

/** @param {ProjectedEvaluation[]} definitions @param {KnowledgeRef[] | undefined} refs */
export function selectEvaluations(definitions, refs) {
	if (refs === undefined) return definitions;
	if (!Array.isArray(refs) || !refs.length || refs.length > 32
		|| refs.some((ref) => !ref || typeof ref.id !== "string" || !Number.isSafeInteger(ref.revision) || ref.revision < 1)
		|| new Set(refs.map(refKey)).size !== refs.length
		|| refs.some((ref) => !definitions.some((entry) => refKey(entry) === refKey(ref)))) {
		throw new FoundryFactoryError("factory_evaluator_changed", "Select unique pinned accepted evaluator revisions");
	}
	return definitions.filter((entry) => refs.some((ref) => refKey(entry) === refKey(ref)));
}

/** @param {Pick<import("../types/plan.js").PlanBlueprint, "title" | "objective" | "constraints" | "tasks">} plan */
const blueprintOf = (plan) => ({
	title: plan.title, objective: plan.objective, constraints: plan.constraints,
	tasks: plan.tasks.map(({ id, title, kind, description, dependsOn, acceptanceCriteria, expectedFiles, deliveryRequirement }) =>
		({ id, title, kind, description, dependsOn, acceptanceCriteria, expectedFiles, deliveryRequirement })),
});

/** @param {Pick<import("../types/plan.js").PlanBlueprint, "title" | "objective" | "constraints" | "tasks"> & {repository: import("../types/plan.js").Repository, evaluationTarget?: import("../types/plan.js").EvaluationTarget | null}} plan */
export const blueprintDigest = (plan) => analysisInputDigest({
	blueprint: blueprintOf(plan), repository: plan.repository,
	...(plan.evaluationTarget ? { evaluationTarget: plan.evaluationTarget } : {}),
});

/** @param {unknown} value @returns {asserts value is PlanningContext} */
export function assertPlanningContext(value) {
	if (!isRecord(value) || typeof value.repositoryId !== "string" || typeof value.unitId !== "string"
		|| typeof value.unitRevision !== "number" || typeof value.owner !== "string"
		|| (value.contract !== null && (!isRecord(value.contract)
			|| typeof value.contract.digest !== "string" || typeof value.contract.revision !== "number"))) {
		fail("factory_context_invalid", "Factory planning requires its canonical repository, unit and accepted contract context");
	}
}
