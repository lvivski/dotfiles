import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { fail } from "../factory/fields.mjs";
import { operatingRecords } from "../factory/operating.mjs";
import { squadCharter, squadGeneration, squadHistory, validateSquads } from "../factory/squads.mjs";
import { approvalScope, sameApprovalScope } from "../plan/schemas/approval.mjs";
import { operatingAuthority, operatingBatch } from "../plan/schemas/operating.mjs";

/** @typedef {import("../types/operating.js").OperatingBatch} Batch */
/** @typedef {import("../types/operating.js").OperatingAuthority} Authority */
/** @typedef {import("../types/operating.js").OperatingNativePort} Native */

/** Compose with the supported host's synchronous, fenced ownership assertion.
 * An asynchronously captured metadata snapshot is not this capability. This
 * adapter records decisions; it cannot perform any delegated approval itself.
 * @param {{ownership?: Native, coordinatorSessionId: string}} dependencies
 * @returns {Native} */
export function createSquadAuthority({ ownership, coordinatorSessionId }) {
	return Object.freeze({
		assertAuthority(plan, authority, delegation, publication) {
			if (!ownership || typeof ownership.assertAuthority !== "function"
				|| ownership.assertAuthority.constructor?.name === "AsyncFunction" || !coordinatorSessionId) {
				fail("squad_ownership_unavailable", "Current fenced native ownership is unavailable; squad binding remains unresolved");
			}
			const observed = structuredClone({ plan, authority, delegation, publication });
			const before = stableStringify(observed);
			const result = ownership.assertAuthority(observed.plan, observed.authority, observed.delegation, observed.publication);
			if (result !== undefined || stableStringify(observed) !== before) {
				fail("squad_ownership_invalid", "Ownership must synchronously assert the exact current binding, not mutate or return cached permission");
			}
			if (delegation && (delegation.revocation || authority.delegationId !== delegation.id
				|| !sameApprovalScope(delegation.scope, approvalScope(plan, coordinatorSessionId,
					delegation.scope.approvalType ?? "plan", delegation.scope.technical)))) {
				fail("squad_delegation_out_of_scope", "A supplied delegation must match the current owner, coordinator, repository, capability and file scope");
			}
			const binding = authority.binding;
			if (!binding || publication.batch.source.kind !== "app"
				|| publication.batch.source.identity !== analysisInputDigest(binding.sessionId)
				|| publication.batch.records.some(record => record.source.kind !== "app"
					|| stableStringify(record.source) !== stableStringify(publication.batch.source))) {
				fail("squad_actor_mismatch", "New records retain the actual bound App worker, never a supplied foreign or human actor");
			}
			for (const record of publication.batch.records) {
				if (record.kind !== "charter" && record.kind !== "decision") {
					fail("squad_record_unsupported", "The squad service cannot mutate goals or relationships");
				}
				const ref = record.kind === "charter" ? record : record.charter;
				if (ref.id !== binding.charter.id || ref.revision !== binding.charter.revision) {
					fail("squad_binding_mismatch", "Every mutation must belong to the exact locally bound charter revision");
				}
				if (record.kind !== "decision" || record.status !== "historical") continue;
				if (!["plan", "completion", "technical-retry", "evaluator-renewal"].includes(record.category)) {
					fail("squad_separate_authority", "Contract, replacement, human and external/resource decisions require their separate authority paths");
				}
				const kind = record.category === "technical-retry" ? "retry" : "consumer-expectation";
				const type = record.category === "plan" || record.category === "completion" ? record.category : "technical";
				if (!delegation || delegation.revocation || authority.delegationId !== delegation.id
					|| !sameApprovalScope(delegation.scope, approvalScope(plan, coordinatorSessionId, type, delegation.scope.technical))) {
					fail("squad_delegation_out_of_scope", "Historical decision recording requires the existing exact, unrevoked category delegation");
				}
				// A historical entry describes an actual baseline authorization receipt;
				// the charter and this service must not manufacture one.
				const receipt = type === "technical"
					? plan.technicalDecisions?.find(entry => entry.kind === kind && entry.delegation.id === delegation.id
						&& entry.sessionId === coordinatorSessionId && entry.digest === record.source.source)
					: plan.gates[type === "plan" ? "delegatedApproval" : "delegatedCompletion"];
				if (!receipt || receipt.delegation.id !== delegation.id || receipt.sessionId !== coordinatorSessionId
					|| receipt.planId !== plan.id || receipt.blueprintDigest !== plan.factory?.blueprintDigest
					|| (type !== "technical" && analysisInputDigest(receipt) !== record.source.source)) {
					fail("squad_decision_receipt_missing", "Record only an existing exact baseline decision receipt; a squad entry is not approval");
				}
			}
		},
	});
}

/** Domain facade over the canonical service. Compose validateSquads as the
 * canonical charters rule and createSquadAuthority as its native assertion.
 * The existing operating writer owns the fence, owner transaction and outbox.
 * @param {{operating: import("../types/operating.js").OperatingService}} dependencies */
export function createSquadService({ operating }) {
	/** @param {Batch} input */
	const prepare = input => {
		const batch = operatingBatch(input);
		if (batch.records.some(record => record.kind !== "charter" && record.kind !== "decision")) {
			fail("squad_record_unsupported", "Squad batches contain only charter and decision revisions");
		}
		validateSquads(operating.snapshot().state, batch.records);
		return operating.prepare(batch);
	};
	return Object.freeze({
		prepare,
		/** @param {Batch} input @param {Authority} inputAuthority */
		commit(input, inputAuthority) {
			const batch = prepare(input);
			const authority = operatingAuthority(inputAuthority);
			if (!authority.binding) fail("squad_binding_unresolved", "A squad name or imported history cannot establish current native ownership");
			squadCharter([...operatingRecords(operating.snapshot().state), ...batch.records], authority.binding.charter);
			return operating.commit(batch, authority);
		},
		/** @param {import("../types/factory.js").KnowledgeRef} ref */
		history: ref => ({ ...squadHistory(operating.snapshot().state, ref),
			binding: { state: /** @type {const} */ ("unresolved"), reason: "Historical records are non-owning; current authority is checked only inside the canonical write fence" } }),
		/** @param {import("../types/factory.js").KnowledgeRef} ref */
		generation: ref => squadGeneration(operating.snapshot().state, ref),
		/** Exact committed publication only, never establishment of current ownership.
		 * @param {string} planId @param {string} digest */
		reconcile: (planId, digest) => operating.reconcile(planId, digest),
	});
}
