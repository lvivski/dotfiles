import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { operatingAuthority, operatingBatch, operatingPublication } from "../plan/schemas/operating.mjs";
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

/**
 * Lock order: existing admission writer -> factory writer -> owner-plan writer.
 * The owner COMMIT linearizes authorization and the immutable outbox. The factory
 * COMMIT linearizes the effective graph; .foundry publication follows. A crash
 * between them leaves a recoverable exact intent, not cross-database ACID.
 * Never rebase a committed intent onto a newer snapshot.
 * @param {{snapshot: () => Snapshot,
 * append: (publication: Publication, authorize: () => void) => void,
 * now: () => string,
 * ports?: import("../types/operating.js").OperatingPorts}} options
 * @returns {import("../types/operating.js").OperatingService}
 */
export function createOperatingService({ snapshot, append, now, ports }) {
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
		validateOperatingRules(state, batch, ports?.rules);
		return batch;
	};
	return Object.freeze({
		snapshot: () => { const state = snapshot(); return { state, token: operatingToken(state) }; },
		prepare,
		commit(input, rawAuthority) {
			const batch = prepare(input);
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
						const permit = Object.freeze({ kind: /** @type {const} */ ("operating-validated-commit") });
						commitPermits.set(permit, analysisInputDigest({ publication, authority }));
						try {
							const committed = persistence.commit(publication, authority, native, permit);
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
