import { fail } from "../factory/fields.mjs";
import { isRecord, parseJson } from "../data.mjs";
import { goalGeneration, goalGraph, validateGoals } from "../factory/goals.mjs";
import { assertOperatingSnapshot } from "../factory/operating.mjs";
import { goalReadiness } from "../factory/rollup.mjs";
import { same } from "../factory/records.mjs";
import { operatingAuthority, operatingBatch } from "../plan/schemas/operating.mjs";

/** @typedef {import("../types/operating.js").OperatingService} Operating */
/** @typedef {import("../types/factory.js").KnowledgeRef} Ref */
/** @typedef {Parameters<typeof goalReadiness>[3]} Admission */

/** Composition must install validateGoals as the canonical writer/import
 * validator. These ports reuse its exact snapshot, transaction and native fence;
 * this service owns no store, leases, authority, scheduler or native actions.
 * @param {{operating: Operating, now: () => string,
 * admission?: (goal: Ref) => Admission,
 * availableEnvironments?: readonly string[],
 * transfer?: {export: () => string, import: (source: string, expectedRevision: number) => unknown}}} ports */
export function createGoalService(ports) {
	/** @param {string} source */
	const portable = source => {
		const document = parseJson(source);
		if (!isRecord(document) || document.portable !== true) {
			fail("goal_transfer_not_portable", "Goal transfer requires the canonical portable knowledge projection, never execution authority");
		}
		return source;
	};
	/** @param {unknown} input */
	const prepare = input => {
		const batch = operatingBatch(input);
		if (batch.records.some(record => !["goal", "relationship"].includes(record.kind))) {
			fail("goal_scope_invalid", "The goal service only mutates goals and relationships");
		}
		const { state } = ports.operating.snapshot();
		assertOperatingSnapshot(state, batch);
		validateGoals(state, batch.records);
		return ports.operating.prepare(batch);
	};
	return Object.freeze({
		snapshot: ports.operating.snapshot,
		prepare,
		/** @param {unknown} input @param {unknown} authorityInput */
		commit(input, authorityInput) {
			const batch = prepare(input);
			const authority = operatingAuthority(authorityInput);
			if (!authority.binding) fail("goal_owner_missing", "A historical identity or squad name cannot authorize a goal mutation");
			const { state } = ports.operating.snapshot();
			const before = goalGraph(state);
			const graph = goalGraph(state, batch.records);
			for (const record of batch.records) {
				const goal = record.kind === "goal" ? record : record.kind === "relationship" ? graph.resolve(record.from, "goal") : null;
				const prior = before.effective.get(record.id);
				const previousGoal = prior?.kind === "goal" ? prior : prior?.kind === "relationship" ? before.resolve(prior.from, "goal") : null;
				if (!goal || !same(goal.charter, authority.binding.charter)
					|| (previousGoal && !same(previousGoal.charter, authority.binding.charter))) {
					fail("goal_owner_mismatch", "The exact accountable charter revision must match the canonical native binding");
				}
			}
			return ports.operating.commit(batch, authority);
		},
		/** @param {string} planId @param {string} digest */
		reconcile: (planId, digest) => ports.operating.reconcile(planId, digest),
		/** @param {Ref} ref */
		inspect(ref) {
			const { state } = ports.operating.snapshot();
			const admission = ports.admission?.(ref) ?? { phase: "unknown", reason: "Native admission observation is unavailable" };
			return goalReadiness(state, ref, ports.now(), admission, { availableEnvironments: ports.availableEnvironments });
		},
		/** @param {Ref} ref */
		generation: ref => goalGeneration(ports.operating.snapshot().state, ref),
		exportHistory() {
			if (!ports.transfer) fail("goal_transfer_unavailable", "Canonical portable export is unavailable");
			return portable(ports.transfer.export());
		},
		/** @param {string} source @param {number} expectedRevision */
		importHistory(source, expectedRevision) {
			if (!ports.transfer) fail("goal_transfer_unavailable", "Canonical whole-graph import is unavailable");
			return ports.transfer.import(portable(source), expectedRevision);
		},
	});
}
