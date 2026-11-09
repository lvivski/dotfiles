/**
 * Original schema-2/v2 wire history, including a duplicate-origin receipt and
 * the later acceptance that the old publication-order rules admitted.
 * This fixture does not call current factory mutations or sealing helpers.
 */
import { createHash } from "node:crypto";

/** @param {unknown} value @returns {unknown} */
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
	: value && typeof value === "object"
		? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(/** @type {Record<string, unknown>} */(value)[key])]))
		: value;
/** @param {unknown} value */
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
/** @param {number} minute */
const time = (minute) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
/** @param {{id: string, revision: number}} entry */
const ref = (entry) => ({ id: entry.id, revision: entry.revision });

/** @param {{id: string, commonDirectory: string}} repository */
export function legacyV2ReceiptHistory(repository) {
	const unitInput = {
		id: "legacy-unit", name: "Legacy unit", purpose: "Preserve caller identity",
		boundary: { owns: ["identity-selection"], exposes: ["select(input)"], consumes: [], preserves: ["caller input"] },
		dependencies: [], relationshipCoverage: "complete", actor: "old-owner",
	};
	const unit = { ...unitInput, revision: 1, at: time(0), reason: "Initial capability definition" };
	const obligationInput = {
		id: "legacy-obligation", unitId: unit.id, kind: "obligation", statement: "Caller identity remains unchanged",
		source: { kind: "discovery", ref: "fixture:old-spec", actor: "old-owner", at: time(1) },
	};
	const obligation = { ...obligationInput, revision: 1, links: [], uncertainty: null, evaluation: null, recordedAt: time(1) };
	const evaluatorInput = {
		id: "legacy-evaluator", unitId: unit.id, kind: "evaluation", statement: "Independently check the boundary and conservation",
		source: { kind: "discovery", ref: "fixture:old-oracle", actor: "old-owner", at: time(2) },
		evaluation: {
			modality: "boundary", procedure: { kind: "command", ref: "fixture:old-test", digest: "b".repeat(64) },
			obligations: [ref(obligation)], environment: "old-node", workload: "old-workload",
			maxAgeSeconds: 86400, independent: true, preservation: true,
		},
	};
	const evaluator = { ...evaluatorInput, revision: 1, links: [], uncertainty: null, recordedAt: time(2) };
	const acceptance = {
		unitId: unit.id, unitRevision: 1, obligations: [ref(obligation)], evaluations: [ref(evaluator)],
		actor: "old-owner", reason: "Accept the recovered contract",
	};
	const decision = {
		id: "decision-4", kind: "accept-contract", unitId: unit.id,
		actor: acceptance.actor, reason: acceptance.reason, at: time(3), resolutions: [],
	};
	/** @param {typeof obligation | typeof evaluator} entry */
	const project = (entry) => ({
		id: entry.id, revision: entry.revision, unitId: entry.unitId, kind: entry.kind,
		authority: "accepted", statement: entry.statement, uncertainty: entry.uncertainty, links: entry.links,
		...(entry.evaluation ? { evaluation: entry.evaluation } : {}),
	});
	const sealedContext = {
		sealVersion: 2, unit, obligations: [project(obligation)], evaluations: [project(evaluator)],
		rationale: [], decisionLineage: [decision], omittedEarlierDecisions: 0, foundations: [],
	};
	const contract = {
		sealVersion: 2, unitId: unit.id, unitRevision: 1, revision: 1,
		obligations: [ref(obligation)], evaluations: [ref(evaluator)], decisionId: decision.id, acceptedAt: time(3),
		previousDigest: null, rationale: [], dependencies: [], decisionIds: [decision.id], omittedEarlierDecisions: 0, digest: "",
	};
	contract.digest = digest({ ...contract, sealedContext, provenance: [obligation, evaluator] });
	const context = {
		generation: [], comparisonOnly: [],
		independence: { method: "fresh-process", reason: "A distinct old generator process" },
	};
	const candidateInput = { id: "legacy-candidate", unitId: unit.id, contractRevision: 1, mode: "implementation", actor: "old-owner", context };
	const generation = {
		purpose: "implementation", candidateId: candidateInput.id, ...sealedContext, contract,
		inputs: context.generation, independence: context.independence,
		limitations: "Manifest and actor reports are claims, not OS-level source isolation or deterministic generation.",
	};
	const contextDigest = digest({ sealVersion: 2, generation, comparisonOnly: [] });
	const delivery = {
		candidateId: candidateInput.id, commit: "a".repeat(40),
		artifact: { kind: "implementation", ref: "fixture:old-module", digest: "c".repeat(64) },
		source: { kind: "external-run", ref: "fixture:old-generation", actor: "old-producer", at: time(5), owner: "old-session", runId: "generation-run" },
	};
	const original = {
		id: "original-receipt", candidateId: candidateInput.id, evaluation: ref(evaluator),
		contractDigest: contract.digest, contextDigest, commit: delivery.commit, procedureDigest: evaluator.evaluation.procedure.digest,
		outcome: "passed", source: { kind: "external-run", ref: "fixture:old-evaluation", actor: "old-verifier", at: time(7), owner: "old-session", runId: "evaluation-run" },
		environment: "old-node", workload: "old-workload", independence: { method: "separate-process", reason: "Different producer and evaluator processes" },
		report: "The old boundary test passed",
	};
	const signal = {
		id: "old-renewal", kind: "assumption-change", summary: "Operating assumptions need renewed support",
		unitIds: [unit.id], knowledgeRefs: [ref(obligation)],
		source: { kind: "operational", ref: "fixture:old-incident", actor: "old-operator", at: time(9) },
	};
	const duplicate = { ...original, id: "renamed-receipt", source: { ...original.source, at: time(10) } };
	const selection = {
		candidateId: candidateInput.id, action: "accept", expectedIncumbentId: null,
		actor: "old-owner", reason: "The publication-order engine treated the later receipt as renewed support",
	};
	/** @type {Array<[number, import("../../types/factory.js").FactoryAction, Record<string, unknown>]>} */
	const records = [
		[0, "createUnit", unitInput], [1, "appendKnowledge", obligationInput], [2, "appendKnowledge", evaluatorInput],
		[3, "acceptContract", acceptance], [4, "prepareCandidate", candidateInput], [6, "recordDelivery", delivery],
		[8, "recordEvaluation", original], [9, "recordSignal", signal], [11, "recordEvaluation", duplicate], [12, "decideCandidate", selection],
	];
	const events = records.map(([minute, action, input], index) => ({ revision: index + 1, at: time(minute), action, input }));
	return { document: { format: "foundry-factory-v2", repository, revision: events.length, events }, candidateId: candidateInput.id, contractDigest: contract.digest, contextDigest, original, duplicate, delivery, selection };
}
