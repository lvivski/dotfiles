import { stableStringify } from "../digest.mjs";
import { errorCode } from "../data.mjs";
import { requiresHumanJudgment } from "../factory/definitions.mjs";
import { fail } from "../factory/fields.mjs";
import { createDraftPlan } from "../plan/lifecycle.mjs";
import { assertPlanningContext, blueprintDigest, evaluationCriterion, selectEvaluations } from "./pinning.mjs";
import { declaredVisual, visualCriterion } from "../factory/visual.mjs";
import { validateTaskTopology } from "../plan/graph.mjs";
import { checkVisualReferences } from "../evidence/visual.mjs";

/** @typedef {{id: string, repository: import("../types/plan.js").Repository, expectedRevision: number, expectedFactoryRevision?: number, candidateId: string, expectedFiles?: string[], evaluations?: KnowledgeRef[]}} FactoryPlanInput */
/** @typedef {import("../types/factory.js").KnowledgeRef} KnowledgeRef */

/** @param {{
 * workspace: () => string,
 * storeFor: () => ReturnType<typeof import("../storage.mjs").createPlanStore>,
 * notify: (event: import("../types/plan.js").ChangeEvent) => void,
 * factoryFor: ReturnType<typeof import("./authority.mjs").createAuthority>["factoryFor"],
 * context: ReturnType<typeof import("./authority.mjs").createAuthority>["context"],
 * }} dependencies */
export function createBoundPlans({ workspace, storeFor, notify, factoryFor, context }) {

	/** @param {{id: string, repository: import("../types/plan.js").Repository,
	 * blueprint: import("../types/plan.js").PlanBlueprint, planning?: import("../types/plan.js").Planning | null,
	 * factoryContext: unknown, candidateId?: string | null, expectedFactoryRevision?: number, expectedRevision: number}} input */
	const createBoundDraft = async ({ id, repository, blueprint, planning = null, factoryContext, candidateId = null, expectedFactoryRevision, expectedRevision }) => {
		if (expectedRevision !== 0) fail("invalid_expected_revision", "Creating a draft requires expectedRevision 0");
		assertPlanningContext(factoryContext);
		const factory = factoryFor(repository.workingDirectory);
		const state = factory.snapshot();
		const candidate = candidateId ? state.candidates.find((entry) => entry.id === candidateId) : null;
		const evaluating = Boolean(blueprint.evaluationTarget);
		if (candidateId && !candidate) fail("factory_candidate_missing", "Prepare a candidate before assembling its plan");
		const binding = state.bindings.find((entry) => entry.planId === id && entry.owner === workspace());
		const intendedDigest = blueprintDigest({ ...blueprint, repository });
		if (binding && (binding.blueprintDigest !== intendedDigest || binding.candidateId !== candidateId || binding.unitId !== factoryContext.unitId)) {
			fail("factory_plan_bound", "Plan identity is reserved for different factory work");
		}
		const canonicalContext = context(repository.workingDirectory, factoryContext.unitId);
		const unitRevision = binding?.unitRevision ?? (candidate ? factory.generation(candidate.id).unit.revision : factoryContext.unitRevision);
		const unit = state.units.find((entry) => entry.id === factoryContext.unitId && entry.revision === unitRevision);
		if (!unit) fail("factory_unit_missing", "Plan capability revision is missing");
		const visual = declaredVisual(state, unit);
		if (visual) {
			checkVisualReferences(repository.workingDirectory, visual.evaluation);
			const { targetTask } = validateTaskTopology(blueprint.tasks, blueprint.evaluationTarget);
			const criteria = blueprint.evaluationTarget?.criteria ?? targetTask?.acceptanceCriteria ?? [];
			if (!criteria.includes(visualCriterion(visual))) fail("factory_visual_required", "UI plans cannot omit the declared reference-to-output visual gate; use a declared successor for changed scope");
		}
		if (factoryContext.repositoryId !== factory.repository.id || factoryContext.owner !== workspace()
			|| (!binding && !evaluating && (factoryContext.unitRevision !== canonicalContext.unitRevision
				|| (factoryContext.contract?.digest ?? null) !== (canonicalContext.contract?.digest ?? null)
				|| (candidate && candidate.contractDigest !== canonicalContext.contract?.digest)))) {
			fail("factory_context_stale", "Planning context changed or belongs to another repository/session; prepare from current authority");
		}
		/** @type {import("../types/plan.js").PlanFactoryBinding} */
		const factoryBinding = {
			repositoryId: factory.repository.id, owner: workspace(), unitId: factoryContext.unitId,
			unitRevision: binding?.unitRevision ?? (candidate ? factory.generation(candidate.id).contract.unitRevision : factoryContext.unitRevision),
			candidateId, contractRevision: binding ? binding.contractRevision : candidate?.contractRevision ?? factoryContext.contract?.revision ?? null,
			contractDigest: binding ? binding.contractDigest : candidate?.contractDigest ?? factoryContext.contract?.digest ?? null,
			contextDigest: binding ? binding.contextDigest : candidate?.contextDigest ?? null, blueprintDigest: intendedDigest,
			...(evaluating ? { purpose: "evaluation" } : {}),
		};
		const plan = createDraftPlan({ id, repository, ...blueprint, planning, factory: factoryBinding });
		if (!binding) {
			factory[evaluating ? "bindEvaluationPlan" : "bindPlan"]({
				expectedRevision: expectedFactoryRevision ?? state.revision, unitId: factoryContext.unitId,
				candidateId, planId: id, owner: workspace(), blueprintDigest: factoryBinding.blueprintDigest,
				unitRevision: factoryBinding.unitRevision, contractRevision: factoryBinding.contractRevision,
				contractDigest: factoryBinding.contractDigest, contextDigest: factoryBinding.contextDigest,
				...(blueprint.evaluationTarget ? { targetCommit: blueprint.evaluationTarget.commit, evaluations: blueprint.evaluationTarget.evaluations } : {}),
			});
		} else if (binding.blueprintDigest !== factoryBinding.blueprintDigest || binding.candidateId !== candidateId || binding.unitId !== factoryContext.unitId) {
			fail("factory_plan_bound", "Plan identity is reserved for different factory work");
		}
		let created;
		try {
			created = await storeFor().create(plan, 0);
		} catch (error) {
			if (errorCode(error) !== "plan_exists") throw error;
			const existing = await storeFor().read(id);
			if (!existing.factory || stableStringify(existing.factory) !== stableStringify(factoryBinding)
				|| stableStringify(existing.repository) !== stableStringify(repository)) throw error;
			created = existing;
		}
		notify({ workspacePath: workspace(), planId: id, revision: created.revision });
		return created;
	};

	/** @param {FactoryPlanInput} input */
	const createPlan = async (input) => {
		const factory = factoryFor(input.repository.workingDirectory);
		const state = factory.snapshot();
		const candidate = state.candidates.find((entry) => entry.id === input.candidateId);
		if (!candidate) fail("factory_candidate_missing", "Prepare a pinned candidate before creating a reconstruction plan");
		if (candidate.mode === "adoption") fail("factory_adoption_not_generation", "Adoption evaluates the existing delivery directly; it does not create a fresh-generation plan");
		if (candidate.context.independence.method === "fresh-process") fail("factory_app_generation_origin", "App dispatch cannot attest fresh process provenance. Use a fresh-session candidate or a real external generation process.");
		const generation = factory.generation(candidate.id);
		const automatic = generation.evaluations.filter((entry) => !requiresHumanJudgment(entry.evaluation));
		/** @type {import("../types/plan.js").PlanBlueprint} */
		const blueprint = {
			title: `${candidate.mode === "reconstruction" ? "Reconstruct" : "Implement"} ${generation.unit.name}`,
			objective: generation.unit.purpose,
			constraints: [
				"Preserve the current accepted implementation until explicit replacement approval.",
				"Do not alter pinned obligations or evaluators to make the candidate pass.",
				"Use shared foundations through their conserved interfaces, not duplicate identity or authority stacks.",
			],
			tasks: [
				{
					id: "T-001", title: "Produce a fresh candidate", kind: "implement",
					description: `Produce candidate ${candidate.id} from sealed contract ${candidate.contractDigest}. The recovered specification is an input, implementation discoveries are outputs. Capture new observations or proposals without making them authority.`,
					dependsOn: [], acceptanceCriteria: automatic.length ? automatic.map(evaluationCriterion) : ["Deliver the immutable candidate for explicit independent human judgment without changing accepted contracts."],
					expectedFiles: input.expectedFiles ?? [], deliveryRequirement: "commit",
				},
				{
					id: "T-002", title: "Independently evaluate the candidate", kind: "verify",
					description: "Evaluate every pinned procedure against the exact delivered commit. Report real output, environmental context, preservation and architectural failures. Do not repair the candidate or weaken the contract.",
					dependsOn: ["T-001"], acceptanceCriteria: [], expectedFiles: [], deliveryRequirement: "commit",
				},
			],
		};
		return createBoundDraft({
			...input, blueprint, factoryContext: context(input.repository.workingDirectory, candidate.unitId),
			candidateId: candidate.id,
		});
	};

	/** @param {FactoryPlanInput} input */
	const createEvaluationPlan = async (input) => {
		const factory = factoryFor(input.repository.workingDirectory);
		const state = factory.snapshot();
		const candidate = state.candidates.find((entry) => entry.id === input.candidateId);
		if (!candidate?.delivery) fail("factory_delivery_required", "Re-evaluation requires an existing immutable delivery");
		const generation = factory.generation(candidate.id);
		const selected = selectEvaluations(generation.evaluations, input.evaluations);
		const automatic = selected.filter((entry) => !requiresHumanJudgment(entry.evaluation));
		if (!automatic.length) fail("factory_human_judgment_required", "Human-only assurance is recorded as explicit human judgment, not an App task");
		/** @type {import("../types/plan.js").PlanBlueprint} */
		const blueprint = {
			title: `Re-evaluate ${generation.unit.name}`,
			objective: `Independently re-evaluate immutable candidate ${candidate.id} at ${candidate.delivery.commit}`,
			constraints: ["Read-only evaluation: do not modify implementation, evaluators, commits, branches or accepted contracts.", "Preserve the original generation completion and selection; append new assurance only."],
			evaluationTarget: { candidateId: candidate.id, commit: candidate.delivery.commit, criteria: automatic.map(evaluationCriterion), evaluations: selected.map(({ id, revision }) => ({ id, revision })) },
			tasks: [{
				id: "T-001", title: "Re-evaluate immutable delivery", kind: "verify",
				description: "Run the selected pinned evaluations read-only against the exact existing commit, report actual output and context, and leave the implementation unchanged.",
				dependsOn: [], acceptanceCriteria: [], expectedFiles: [], deliveryRequirement: "commit",
			}],
		};
		return createBoundDraft({
			...input, blueprint, candidateId: candidate.id,
			factoryContext: { ...context(input.repository.workingDirectory, candidate.unitId), unitRevision: generation.unit.revision, contract: generation.contract },
		});
	};
	return { createBoundDraft, createPlan, createEvaluationPlan };
}
