import { errorCode } from "../data.mjs";
import { stableStringify } from "../digest.mjs";
import { normalizeRecoveryInventory, normalizeRecoveryObservation } from "../inventory.mjs";
import { reconcileCancellationObligations } from "../plan/cancellation.mjs";
import { admissionIdentity, admissionRecord, effectReceipt } from "../plan/parallel-contracts.mjs";
import { FoundryOperationError } from "./errors.mjs";

/** @typedef {import("../types/parallel.js").AdmissionIdentity} Identity */
/** @typedef {import("../types/parallel.js").AdmissionRecord} Record */
/** @typedef {import("../types/parallel.js").EffectReceipt} Receipt */
/** @typedef {{state: "held" | "released", record: Record, holds: string[], obligations: import("../types/parallel.js").CancellationObligation[]}} RecoveryResult */
/** @typedef {{
 * retainObservation: (fence: import("../types/parallel.js").Fence, observation: import("../inventory.mjs").RecoveryObservation) => Record,
 * readObservations: (identity: Identity) => import("../inventory.mjs").RecoveryObservation[]
 * }} RecoveryObservationPort */

/** @param {Record} record */
const fence = record => ({ admission: record.identity, revision: record.revision, epoch: record.epoch });
/** @param {unknown} left @param {unknown} right */
const same = (left, right) => stableStringify(left) === stableStringify(right);

/**
 * One bounded reconciliation, normally woken by an owner notification. Ports are live,
 * owner-bound authorities; imported records are not accepted as mutable inputs.
 * No native creation/control, claim persistence, deletion, timers, or retry scheduler.
 * @param {{
 * admission: import("../types/parallel.js").AdmissionPort,
 * journal: import("../types/parallel.js").DispatchJournalPort,
 * observations: RecoveryObservationPort,
 * repositoryId: string, owner: string,
 * observe: (input: {identity: Identity, after: string}) => Promise<import("../inventory.mjs").RecoveryInventory>,
 * listAdmissions?: (planId: string) => {complete: boolean, identities: Identity[]},
 * clock?: () => string
 * }} dependencies
 */
export function createRecoveryOperations({ admission, journal, observations, repositoryId, owner, observe, listAdmissions, clock = () => new Date().toISOString() }) {
	if (!observations || typeof observations.retainObservation !== "function" || typeof observations.readObservations !== "function") {
		throw new FoundryOperationError("parallel_observation_port_required", "Recovery requires durable observation retention by the admission authority");
	}
	/** @param {Identity} identity */
	function read(identity) {
		const requested = admissionIdentity(identity);
		if (requested.repositoryId !== repositoryId || requested.owner !== owner) {
			throw new FoundryOperationError("parallel_foreign_owner", "Recovery cannot take ownership of another repository or coordinator");
		}
		const stored = admission.read(requested);
		if (!stored) throw new FoundryOperationError("parallel_admission_missing", "Recover the original admission; do not create a replacement");
		const record = admissionRecord(stored);
		if (!same(record.identity, requested)) throw new FoundryOperationError("parallel_foreign_owner", "Admission read returned another identity");
		return record;
	}

	/** Never replay an effect after conflict; a new observation is a separate invocation.
	 * @param {Record} current @param {() => unknown} mutation @param {(latest: Record) => boolean} postcondition */
	function commit(current, mutation, postcondition) {
		try {
			mutation();
		} catch (error) {
			if (errorCode(error) !== "revision_conflict") throw error;
			const latest = read(current.identity);
			if (postcondition(latest)) return latest;
			throw error;
		}
		const latest = read(current.identity);
		if (!postcondition(latest)) throw new FoundryOperationError("parallel_recovery_postcondition", "Admission mutation did not retain the required recovery outcome");
		return latest;
	}

	/** @param {Identity} identity */
	function cancel(identity) {
		const current = read(identity);
		if (["cancelling", "settled", "released"].includes(current.phase)) return current;
		return commit(current, () => admission.cancel(fence(current)),
			latest => ["cancelling", "settled", "released"].includes(latest.phase));
	}

	/** Retain the exact outcome of an already-started effect, including late arrivals.
	 * The caller supplies an authoritative native receipt, not a guessed disposition.
	 * @param {Identity} identity @param {Receipt} outcome */
	function recordOutcome(identity, outcome) {
		const current = read(identity), receipt = effectReceipt(outcome);
		if (!same(current.attempt, receipt.attempt)) throw new FoundryOperationError("parallel_foreign_owner", "Native outcome belongs to another attempt");
		const retained = current.receipts.find(item => item.id === receipt.id);
		if (retained && same(retained, receipt)) return current;
		if (!retained || !["reserved", "cancelling"].includes(current.phase)) {
			throw new FoundryOperationError("parallel_recovery_receipt", "Recovery can only settle an existing effect under its current fence");
		}
		if (["intent", "in-flight"].includes(receipt.state)) {
			throw new FoundryOperationError("parallel_recovery_receipt", "Recovery cannot initiate a native effect");
		}
		return commit(current, () => admission.withFence(fence(current), tx => journal.recordOutcome(tx, receipt)),
			latest => latest.receipts.some(item => same(item, receipt)));
	}

	/** @param {Record} record */
	function retainedIdentities(record) {
		const history = observations.readObservations(record.identity).map(normalizeRecoveryObservation);
		if (history.some(item => !same(item.attempt, record.attempt))) {
			throw new FoundryOperationError("parallel_foreign_owner", "Retained observation belongs to another attempt");
		}
		return {
			sessionIds: [...new Set([
				...history.flatMap(item => item.sessionIds),
				...record.obligations.flatMap(item => item.sessionId ? [item.sessionId] : []),
				...record.receipts.flatMap(item => item.sessionId ? [item.sessionId] : []),
				...(record.delivery ? [record.delivery.sessionId] : []),
			])],
			runIds: [...new Set([
				...history.flatMap(item => item.runIds), ...record.obligations.flatMap(item => item.runIds),
				...record.receipts.flatMap(item => item.runId ? [item.runId] : []),
				...(record.delivery?.terminalRunIds ?? []),
			])],
		};
	}

	/** @param {Record} record @param {string[]} holds @param {import("../types/parallel.js").CancellationObligation[]} [obligations] @returns {RecoveryResult} */
	const held = (record, holds, obligations = record.obligations) => ({ state: "held", record, holds, obligations });
	/** @param {Record} record @returns {RecoveryResult} */
	const released = record => ({ state: "released", record, holds: [], obligations: record.obligations });

	/** @param {Identity} identity @returns {Promise<RecoveryResult>} */
	async function reconcile(identity) {
		let current = read(identity);
		if (current.phase === "released") return released(current);
		if (current.phase === "settled") {
			return released(commit(current, () => admission.release(fence(current)), latest => latest.phase === "released"));
		}
		if (current.phase !== "cancelling") return held(current, ["cancellation-fence-required"]);
		if (!current.attempt) return held(current, ["reservation-outcome-unresolved"]);
		const receipts = journal.read(current.attempt).map(effectReceipt);
		const sorted = (/** @type {Receipt[]} */ entries) => [...entries].sort((a, b) => a.id.localeCompare(b.id));
		if (!same(sorted(receipts), sorted(current.receipts))) return held(current, ["dispatch-journal-admission-mismatch"]);
		for (const receipt of receipts) {
			if (receipt.state !== "intent") continue;
			current = recordOutcome(identity, { ...receipt, state: "cancelled-before-start", at: clock(), source: "recovery:cancelled-before-native-start" });
		}
		const after = clock();
		const inventory = normalizeRecoveryInventory(await observe({ identity: current.identity, after }));
		// A stale capture cannot prove termination, but its positive owned identities
		// still need durable retention under the freshly revalidated fence.
		const latest = read(identity);
		const changed = latest.revision !== current.revision || latest.epoch !== current.epoch;
		current = latest;
		const retained = retainedIdentities(current);
		const sessionIds = inventory.sessions.filter(item => same(item.attempt, current.attempt)).map(item => item.id);
		const runIds = inventory.runs.filter(item => same(item.attempt, current.attempt)).map(item => item.id);
		if (sessionIds.some(id => !retained.sessionIds.includes(id)) || runIds.some(id => !retained.runIds.includes(id))) {
			if (current.phase !== "cancelling") {
				throw new FoundryOperationError("parallel_late_native_observation", "New owned native identities appeared after settlement; preserve this capture and reconcile admission ownership", { inventory });
			}
			const observation = normalizeRecoveryObservation({ attempt: current.attempt, sessionIds, runIds, source: inventory.source, capturedAt: inventory.capturedAt });
			current = commit(current, () => observations.retainObservation(fence(current), observation), record => {
				const known = retainedIdentities(record);
				return sessionIds.every(id => known.sessionIds.includes(id)) && runIds.every(id => known.runIds.includes(id));
			});
			const decision = reconcileCancellationObligations(current, inventory, retainedIdentities(current));
			// Retention changed the fence after this capture. Require a later observation
			// rather than passing pre-write inventory to settlement.
			return held(current, [...decision.holds, "native-observations-retained"], decision.obligations);
		}
		if (changed) return held(current, ["revision-changed-during-observation"]);
		if (!Number.isFinite(Date.parse(after)) || Date.parse(inventory.capturedAt) < Date.parse(after)) {
			return held(current, ["native-inventory-stale"]);
		}
		const decision = reconcileCancellationObligations(current, inventory, retained);
		if (decision.holds.length) return held(current, decision.holds, decision.obligations);
		current = commit(current, () => admission.settle(fence(current), decision.obligations),
			record => ["settled", "released"].includes(record.phase) && same(record.obligations, decision.obligations));
		if (current.phase === "released") return released(current);
		return released(commit(current, () => admission.release(fence(current)), record => record.phase === "released"));
	}

	/** Enumerate the owner's durable admissions, not only the plan's latest active attempts.
	 * The caller must fence plan reservation before invoking this bounded join.
	 * @param {string} planId */
	async function reconcilePlan(planId) {
		if (!listAdmissions) throw new FoundryOperationError("parallel_inventory_unavailable", "Plan recovery requires the authoritative admission inventory");
		const inventory = listAdmissions(planId);
		/** @type {RecoveryResult[]} */
		const results = [];
		if (inventory.complete !== true) return { state: "held", results, holds: ["admission-inventory-incomplete"] };
		const identities = inventory.identities.map(admissionIdentity);
		const keys = identities.map(stableStringify).sort();
		if (new Set(keys).size !== keys.length) throw new FoundryOperationError("parallel_inventory_invalid", "Admission inventory contains duplicates");
		// Validate the entire selection before mutating any row; foreign entries never
		// expand the coordinator's authority, even when supplied by an inventory port.
		for (const identity of identities) {
			if (identity.planId !== planId) throw new FoundryOperationError("parallel_foreign_owner", "Admission inventory includes another plan");
			read(identity);
		}
		for (const identity of identities) cancel(identity);
		for (const identity of identities) results.push(await reconcile(identity));
		const after = listAdmissions(planId);
		const holds = results.flatMap(result => result.holds);
		if (after.complete !== true || !same(keys, after.identities.map(admissionIdentity).map(stableStringify).sort())) {
			holds.push("admission-inventory-changed");
		}
		return { state: holds.length ? "held" : "released", results, holds };
	}

	return Object.freeze({ cancel, recordOutcome, reconcile, reconcilePlan });
}
