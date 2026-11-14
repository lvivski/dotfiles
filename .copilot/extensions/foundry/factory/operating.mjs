import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { operatingAuthority, operatingBatch, operatingPublication } from "../plan/schemas/operating.mjs";
import { approvalScope, sameApprovalScope } from "../plan/schemas/approval.mjs";
import { fail, object } from "./fields.mjs";

/** @typedef {import("../types/factory.js").FactorySnapshot} Snapshot */
/** @typedef {import("../types/operating.js").OperatingRecord} OperatingRecord */
/** @typedef {import("../types/operating.js").OperatingBatch} Batch */
/** @typedef {import("../types/operating.js").OperatingPublication} Publication */
/** @typedef {import("../types/operating.js").OperatingRules} Rules */

/** Only the canonical writer's post-validation callback issues a one-use permit.
 * The permit carries no native authority and never survives restart or JSON.
 * @type {WeakMap<object, string>} */
const commitPermits = new WeakMap();
/** @param {import("../types/operating.js").OperatingCommitPermit} permit @param {Publication} publication
 * @param {import("../types/operating.js").OperatingAuthority} authority */
export function consumeOperatingPermit(permit, publication, authority) {
	if (!permit || commitPermits.get(permit) !== analysisInputDigest({ publication, authority })) {
		fail("operating_validation_required", "Only the current canonical writer's fully validated batch may commit owner-local publication intent");
	}
	commitPermits.delete(permit);
}
/** Immutable history, not just the latest revisions. @param {Pick<Snapshot, "operating">} state */
export const operatingRecords = state => (state.operating ?? []).flatMap(entry => entry.batch.records);
/** @param {Pick<Snapshot, "operating">} state */
export function effectiveOperatingRecords(state) {
	const latest = new Map(operatingRecords(state).map(record => [record.id, record]));
	return [...latest.values()];
}
/** @param {Snapshot} state @returns {import("../types/operating.js").OperatingSnapshot} */
export function operatingToken(state) {
	return { version: 1, repositoryId: state.repository.id, factoryRevision: state.revision, stateDigest: analysisInputDigest(state) };
}
/** @param {Snapshot} state @param {Batch} batch */
export function assertOperatingSnapshot(state, batch) {
	if (stableStringify(operatingToken(state)) !== stableStringify(batch.snapshot)) {
		fail("operating_snapshot_changed", "The whole effective factory snapshot changed; re-read and revalidate every resolved reference");
	}
}
/** Structural invariants are always enforced, including historical replay.
 * Domain policy is supplied by the separately owned leaves.
 * @param {Pick<Snapshot, "operating" | "contracts">} state @param {Batch} batch */
export function validateOperatingRecords(state, batch) {
	const records = operatingRecords(state);
	for (const record of batch.records) {
		const previous = records.filter(entry => entry.id === record.id).at(-1);
		if ((previous?.revision ?? 0) + 1 !== record.revision || (previous && previous.kind !== record.kind)) {
			fail("operating_revision_conflict", "Operating revisions are immutable, contiguous and kind-stable");
		}
		if (record.kind === "goal" && record.authority === "accepted" && (!record.contract
			|| !state.contracts.some(contract => contract.unitId === record.contract?.unitId
				&& contract.unitRevision === record.contract.unitRevision && contract.revision === record.contract.contractRevision
				&& contract.digest === record.contract.contractDigest && !contract.historyOnly))) {
			fail("operating_contract_missing", "An accepted goal must reference a real pinned accepted contract; model records cannot accept one");
		}
	}
}
/** Validators only see owned data and cannot replace a candidate, mint authority or mutate a store.
 * They must validate the complete effective graph, including unchanged records.
 * @param {Snapshot} state @param {Batch} batch @param {Rules | undefined} rules */
export function validateOperatingRules(state, batch, rules) {
	validateOperatingRecords(state, batch);
	const kinds = new Set([...effectiveOperatingRecords(state), ...batch.records].map(record => record.kind));
	const required = [
		...(kinds.has("charter") || kinds.has("decision") ? [rules?.charters] : []),
		...(kinds.has("goal") || kinds.has("relationship") ? [rules?.goals] : []),
	];
	for (const rule of required) {
		if (typeof rule !== "function") fail("operating_validation_unavailable", "Complete charter and goal domain validation must be composed before mutation/import");
		if (rule.constructor?.name === "AsyncFunction") fail("operating_validator_invalid", "Domain validation must be synchronous");
		const owned = { state: structuredClone(state), records: structuredClone(batch.records) };
		const before = stableStringify(owned);
		const result = rule(owned.state, owned.records);
		if (result !== undefined || stableStringify(owned) !== before) {
			fail("operating_validator_invalid", "Domain validation must synchronously validate, not modify, the complete frozen candidate");
		}
	}
}
/** @param {import("../types/factory.js").FactoryState} state @param {Record<string, unknown>} input */
export function applyOperatingPublication(state, input) {
	object(input, ["publication"], "operating event");
	const publication = operatingPublication(input.publication);
	if ((state.operating ?? []).some(entry => entry.batch.id === publication.batch.id)) {
		fail("operating_publication_conflict", "A publication identity cannot be reused");
	}
	validateOperatingRecords(state, publication.batch);
	state.operating = [...(state.operating ?? []), publication];
	return { operating: publication };
}
/** Only explicitly generation-facing references survive this projection.
 * @param {OperatingRecord} record */
export function operatingGeneration(record) {
	return { ...structuredClone(record), context: record.context.filter(entry => entry.usage === "generation").map(entry => structuredClone(entry)) };
}

/** Shared by the domain facade and the canonical writer. Neither a record
 * category nor an imported historical receipt can create decision authority.
 * @param {import("../types/plan.js").FoundryPlan} plan
 * @param {import("../types/operating.js").OperatingAuthority} authority
 * @param {import("../types/plan.js").ApprovalDelegation | null} delegation
 * @param {Publication} publication @param {string | undefined} coordinatorSessionId */
export function assertOperatingDecisionAuthority(plan, authority, delegation, publication, coordinatorSessionId) {
	if (delegation && (!coordinatorSessionId || delegation.revocation || authority.delegationId !== delegation.id
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
		if (record.kind !== "decision" || record.status !== "historical") continue;
		if (!["plan", "completion", "technical-retry", "evaluator-renewal"].includes(record.category)) {
			fail("squad_separate_authority", "Contract, replacement, human and external/resource decisions require their separate authority paths");
		}
		const kind = record.category === "technical-retry" ? "retry" : "consumer-expectation";
		const type = record.category === "plan" || record.category === "completion" ? record.category : "technical";
		if (!coordinatorSessionId || !delegation || delegation.revocation || authority.delegationId !== delegation.id
			|| !sameApprovalScope(delegation.scope, approvalScope(plan, coordinatorSessionId, type, delegation.scope.technical))) {
			fail("squad_delegation_out_of_scope", "Historical decision recording requires the existing exact, unrevoked category delegation");
		}
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
}

/** Rechecked under the canonical writer before the owner outbox transaction.
 * @param {Snapshot} state @param {Batch} batch
 * @param {import("../types/operating.js").OperatingAuthority} authority */
function assertOperatingBinding(state, batch, authority) {
	const history = operatingRecords(state);
	const records = [...history, ...batch.records];
	const binding = authority.binding;
	if (!binding || !records.some(record => record.kind === "charter"
		&& record.id === binding.charter.id && record.revision === binding.charter.revision)) {
		fail("squad_binding_mismatch", "The local binding must resolve to an exact canonical charter");
	}
	/** @param {OperatingRecord} record @param {OperatingRecord[]} available */
	const charter = (record, available) => {
		if (record.kind === "charter") return { id: record.id, revision: record.revision };
		if (record.kind !== "relationship") return record.charter;
		const goal = available.find(item => item.kind === "goal" && item.id === record.from.id && item.revision === record.from.revision);
		return goal?.kind === "goal" ? goal.charter : null;
	};
	for (const record of batch.records) {
		if (stableStringify(charter(record, records)) !== stableStringify(binding.charter)) {
			fail("operating_owner_mismatch", "Every mutation must belong to the exact locally bound charter revision");
		}
		const previous = history.filter(item => item.id === record.id).at(-1);
		if (previous && (previous.kind === "goal" || previous.kind === "relationship")
			&& stableStringify(charter(previous, history)) !== stableStringify(binding.charter)) {
			fail("operating_owner_mismatch", "A new revision cannot transfer another charter's goal or relationship");
		}
	}
}

/**
 * Lock order: existing admission writer -> factory writer -> owner-plan writer.
 * The owner COMMIT linearizes authorization and the immutable outbox. The factory
 * COMMIT linearizes the effective graph; .foundry publication follows. A crash
 * between them leaves a recoverable exact intent, not cross-database ACID.
 * Never rebase a committed intent onto a newer snapshot.
 * @param {{snapshot: () => Snapshot,
 * append: (publication: Publication, authorize: () => void) => void,
 * validate: (state: Snapshot, batch: Batch) => void,
 * now: () => string,
 * ports?: import("../types/operating.js").OperatingPorts}} options
 * @returns {import("../types/operating.js").OperatingService}
 */
export function createOperatingService({ snapshot, append, validate, now, ports }) {
	const requirePorts = () => {
		if (!ports?.native || !ports.admission || !ports.persistence) {
			fail("operating_authority_unavailable", "Operating mutations require the existing native owner, admission fence and owner-plan writer");
		}
		return ports;
	};
	/** @param {Batch} input */
	const prepare = input => {
		const batch = operatingBatch(input);
		const state = snapshot();
		assertOperatingSnapshot(state, batch);
		validate(state, batch);
		return batch;
	};
	return Object.freeze({
		snapshot: () => { const state = snapshot(); return { state, token: operatingToken(state) }; },
		prepare,
		commit(input, rawAuthority) {
			const batch = prepare(input);
			const state = snapshot();
			assertOperatingSnapshot(state, batch);
			const authority = operatingAuthority(rawAuthority);
			if (!authority.binding) fail("operating_binding_required", "An exact corroborated native binding is required; names cannot establish ownership");
			const sessionId = authority.binding.sessionId;
			const { admission, persistence, native } = requirePorts();
			return admission.withFence(authority.fence, ({ admission: held }) => {
				if (held.phase !== "reserved" || held.attempt?.attemptId !== authority.attemptId
					|| held.identity.repositoryId !== batch.snapshot.repositoryId || held.identity.planId !== authority.planId
					|| held.identity.taskId !== authority.taskId) fail("operating_authority_changed", "Only the exact active canonical admission can authorize this batch");
				const payload = {
					version: /** @type {const} */ (1), batch, planId: authority.planId, planRevision: authority.expectedPlanRevision,
					taskId: authority.taskId, attemptId: authority.attemptId, reservationId: held.identity.reservationId,
					ownerDigest: analysisInputDigest(held.identity.owner),
					sessionId, at: now(),
				};
				const publication = operatingPublication({ ...payload, digest: analysisInputDigest(payload) });
				let authorized = false;
				try {
					append(publication, () => {
						assertOperatingBinding(state, batch, authority);
						const permit = Object.freeze({ kind: /** @type {const} */ ("operating-validated-commit") });
						commitPermits.set(permit, analysisInputDigest({ publication, authority }));
						try {
							const committed = persistence.commit(publication, authority, {
								assertAuthority(plan, current, delegation, intent) {
									assertOperatingDecisionAuthority(plan, current, delegation, intent, native.coordinatorSessionId);
									return native.assertAuthority(plan, current, delegation, intent);
								},
							}, permit);
							if (stableStringify(committed) !== stableStringify(publication)) fail("operating_publication_conflict", "Owner writer returned a different committed batch");
							authorized = true;
						} finally { commitPermits.delete(permit); }
					});
				} catch (cause) {
					if (!authorized) throw cause;
					throw Object.assign(new Error("Operating authorization is committed but publication is pending; reconcile this exact digest without authorizing another batch", { cause }), {
						code: "operating_publication_pending", planId: publication.planId, publicationDigest: publication.digest,
					});
				}
				return publication;
			});
		},
		reconcile(planId, digest) {
			const { persistence } = requirePorts();
			const publication = operatingPublication(persistence.require(planId, digest));
			const existing = snapshot().operating?.find(entry => entry.batch.id === publication.batch.id);
			if (existing) {
				if (stableStringify(existing) !== stableStringify(publication)) fail("operating_publication_conflict", "Published history differs from the committed outbox");
				return publication;
			}
			// Publication of an already committed authorization is not a new native operation.
			append(publication, () => { persistence.require(planId, digest); });
			return publication;
		},
	});
}
