import { property } from "../data.mjs";
import { createFactoryService } from "../factory.mjs";
import { checkContextSize, discoveryContext } from "../factory/context.mjs";
import { fail } from "../factory/fields.mjs";
import { same as sameRefs } from "../factory/records.mjs";
import { blueprintDigest } from "./pinning.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {ReturnType<typeof createFactoryService>} FactoryService */

/** @param {{
 * workspace: () => string,
 * storageRoot: string | undefined,
 * clock: (() => Date|string|number) | undefined,
 * }} dependencies */
export function createAuthority({ workspace, storageRoot, clock }) {

	/** @type {Map<string, FactoryService>} */
	const stores = new Map();

	/** @param {string} repositoryPath */
	const factoryFor = (repositoryPath) => {
		let factory = stores.get(repositoryPath);
		if (!factory) {
			factory = createFactoryService({ repositoryPath, storageRoot, clock });
			stores.set(repositoryPath, factory);
		}
		return factory;
	};

	/** @param {FoundryPlan} plan */
	function requireOwner(plan) {
		if (!plan.factory) fail("factory_context_required", "Foundry plans require durable capability context; create a factory-backed draft");
		if (plan.factory.owner !== workspace()) fail("factory_execution_foreign", "This plan belongs to another session. Inspect its durable knowledge; do not control or import its native runs.");
	}

	/** @param {FoundryPlan} plan @param {boolean} [owned] */
	const stateFor = (plan, owned = true) => {
		if (owned) requireOwner(plan);
		if (!plan.factory) fail("factory_context_required", "Foundry plans require durable capability context");
		const authority = plan.factory;
		const factory = factoryFor(plan.repository.workingDirectory);
		if (plan.factory?.repositoryId !== factory.repository.id) fail("factory_repository_mismatch", "Plan factory identity does not match this repository");
		const state = factory.executionSnapshot();
		const binding = state.bindings.find((entry) => entry.owner === authority.owner && entry.planId === plan.id);
		if (!binding || binding.blueprintDigest !== blueprintDigest(plan)
			|| binding.blueprintDigest !== plan.factory.blueprintDigest
			|| binding.unitId !== plan.factory.unitId || binding.candidateId !== plan.factory.candidateId
			|| ["unitRevision", "contractRevision", "contractDigest", "contextDigest"].some((field) => property(binding, field) !== property(authority, field))
			|| (binding.purpose ?? "generation") !== (plan.factory.purpose ?? "generation")
			|| (plan.evaluationTarget && (binding.targetCommit !== plan.evaluationTarget.commit
				|| !sameRefs(binding.evaluations, plan.evaluationTarget.evaluations)))) {
			fail("factory_plan_mismatch", "Plan intent no longer matches its durable factory binding");
		}
		return { factory, state, binding, plan: { ...plan, factory: authority } };
	};

	/** @param {string} repositoryPath @param {string} unitId
	 * @param {{binding?: import("../types/factory.js").FactoryBinding, query?: string}} [input] */
	const context = (repositoryPath, unitId, input = {}) => {
		const factory = factoryFor(repositoryPath);
		const state = factory.snapshot();
		const unit = state.units.filter((entry) => entry.id === unitId).at(-1);
		if (!unit) fail("factory_unit_missing", "Define the capability's behavior, boundaries and shared dependencies before planning");
		const contracts = state.contracts.filter((entry) => entry.unitId === unitId);
		const contract = input.binding ? input.binding.contractRevision === null ? null
			: contracts.find((entry) => entry.revision === input.binding?.contractRevision) ?? null : contracts.at(-1) ?? null;
		if (input.binding && (input.binding.unitId !== unitId || (contract?.digest ?? null) !== input.binding.contractDigest)) {
			fail("factory_plan_mismatch", "The pinned discovery authority no longer matches its durable binding");
		}
		const revision = input.binding?.unitRevision ?? contract?.unitRevision ?? unit.revision;
		const governingUnit = state.units.find((entry) => entry.id === unitId && entry.revision === revision);
		if (!governingUnit) fail("factory_unit_missing", "Accepted contract references a missing boundary");
		const pinned = contract ? factory.contractContext(unitId, contract.revision) : null;
		const retrieved = pinned ? null : discoveryContext(state, unitId, { query: input.query });
		const result = {
			repositoryId: factory.repository.id, unitId, unitRevision: governingUnit.revision, owner: workspace(),
			unit: governingUnit, proposedUnit: !input.binding && governingUnit.revision !== unit.revision ? unit : null, contract,
			governing: pinned ? { unit: pinned.unit, contract, obligations: pinned.obligations, evaluations: pinned.evaluations, foundations: pinned.foundations } : null,
			rationale: pinned?.rationale ?? retrieved?.rationale ?? [],
			decisionLineage: pinned?.decisionLineage ?? [],
			authority: contract ? "accepted-contract" : "discovery-only",
			...(retrieved ? { signals: retrieved.signals, retrieval: retrieved.retrieval } : {}),
		};
		checkContextSize(result);
		return result;
	};
	return { factoryFor, requireOwner, stateFor, context };
}
