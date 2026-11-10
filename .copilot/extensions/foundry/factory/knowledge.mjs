import { analysisInputDigest } from "../digest.mjs";
import { assertAcceptedDependencies, checkContextSize, contractContext, rationaleClosure } from "./context.mjs";
import { evaluation, source } from "./definitions.mjs";
import { actorReason, digest, enumeration, fail, identifier, integer, list, object, reference, strings, text } from "./fields.mjs";
import { contractFor, disputedKnowledge, evaluationFor, key, knowledgeFor, latest, retired, unitFor } from "./records.mjs";
import { renewalSignals } from "./signals.mjs";

/** @typedef {import("../types/factory.js").FactoryEvent} FactoryEvent */
/** @typedef {import("../types/factory.js").FactoryState} FactoryState */
/** @typedef {import("../types/factory.js").CapabilityUnit} CapabilityUnit */
/** @typedef {import("../types/factory.js").Knowledge} Knowledge */
/** @typedef {import("../types/factory.js").FactoryContract} FactoryContract */
/** @typedef {import("../types/factory.js").FactoryResults} FactoryResults */

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean}} [options] @returns {FactoryResults["createUnit"]} */
export function createUnit(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["id", "name", "purpose", "boundary", "dependencies", "relationshipCoverage", "actor", "reason"], action);
	const id = identifier(input.id);
	const previous = latest(state.units, id);
	object(input.boundary, ["owns", "exposes", "consumes", "preserves"], "boundary");
	const dependencies = strings(input.dependencies, "dependencies").map((id) => identifier(id));
	if (dependencies.includes(id)) fail("factory_boundary_invalid", "A capability cannot depend on itself");
	dependencies.forEach((id) => unitFor(state, id));
	/** @type {CapabilityUnit} */
	const unit = {
		id, revision: (previous?.revision ?? 0) + 1,
		name: text(input.name, "name", 160), purpose: text(input.purpose, "purpose"),
		boundary: {
			owns: strings(input.boundary.owns, "boundary.owns", 32, 1),
			exposes: strings(input.boundary.exposes, "boundary.exposes", 32, 1),
			consumes: strings(input.boundary.consumes, "boundary.consumes"),
			preserves: strings(input.boundary.preserves, "boundary.preserves", 32, 1),
		},
		dependencies, relationshipCoverage: enumeration(input.relationshipCoverage, ["complete", "partial"], "relationshipCoverage"),
		actor: text(input.actor, "actor", 256), at,
		reason: previous ? text(input.reason, "revision reason") : input.reason ? text(input.reason, "reason") : "Initial capability definition",
	};
	/** @param {string} target @param {Set<string>} seen */
	const visit = (target, seen) => {
		if (target === id) fail("factory_dependency_cycle", "Capability dependencies must be acyclic");
		if (seen.has(target)) return;
		seen.add(target);
		unitFor(state, target).dependencies.forEach((dep) => visit(dep, seen));
	};
	dependencies.forEach((dep) => visit(dep, new Set()));
	state.units.push(unit);
	return { unit };

}

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean, portable?: boolean}} [options] @returns {FactoryResults["appendKnowledge"]} */
export function appendKnowledge(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["id", "unitId", "kind", "statement", "source", "links", "uncertainty", "evaluation", "sourceCommitment", "statementCommitment"], action);
	const id = identifier(input.id);
	const unit = unitFor(state, input.unitId);
	const previous = latest(state.knowledge, id);
	if (previous && previous.unitId !== input.unitId) fail("factory_identity_conflict", "Knowledge identity cannot move between capabilities");
	const links = list(input.links ?? [], "links", 64).map((link) => {
		object(link, ["relation", "target"], "link");
		const target = reference(link.target);
		knowledgeFor(state, target);
		return { relation: enumeration(link.relation, ["supports", "contradicts", "derived-from", "supersedes", "depends-on"], "link.relation"), target };
	});
	if (previous && !links.some((link) => link.relation === "supersedes" && key(link.target) === key(previous))) {
		fail("factory_lineage_required", "A knowledge revision must explicitly supersede its preceding revision");
	}
	const kind = enumeration(input.kind, ["observation", "inference", "proposal", "obligation", "evaluation"], "knowledge.kind");
	if (kind !== "evaluation" && input.evaluation !== undefined && input.evaluation !== null) {
		fail("factory_input_invalid", "Only evaluation knowledge can define an evaluator");
	}
	/** @type {Knowledge} */
	const entry = {
		id, revision: (previous?.revision ?? 0) + 1, unitId: unit.id, kind,
		statement: text(input.statement, "statement"), source: source(input.source, at), links,
		uncertainty: input.uncertainty == null ? null : text(input.uncertainty, "uncertainty"),
		evaluation: kind === "evaluation" ? evaluation(input.evaluation, state, unit.id) : null,
		recordedAt: at,
	};
	if (input.sourceCommitment !== undefined) {
		entry.sourceCommitment = digest(input.sourceCommitment, "sourceCommitment");
		if (!options.portable && entry.sourceCommitment !== analysisInputDigest(entry.source)) {
			fail("factory_provenance_changed", "Source commitment does not match the recorded provenance");
		}
		if (input.statementCommitment !== undefined) {
			entry.statementCommitment = digest(input.statementCommitment, "statementCommitment");
			if (!options.portable && entry.statementCommitment !== analysisInputDigest(entry.statement)) {
				fail("factory_provenance_changed", "Statement commitment does not match the recorded knowledge");
			}
		}
	}
	state.knowledge.push(entry);
	return { knowledge: entry };

}

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean, portable?: boolean}} [options] @returns {FactoryResults["acceptContract"]} */
export function acceptContract(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["unitId", "unitRevision", "obligations", "evaluations", "actor", "reason", "resolutions", "rationale", "renewalSignalIds", "sealVersion",
		...(options.portable ? ["historicalSeal", "contextSeal", "historicalOnly"] : [])], action);
	const sealVersion = input.sealVersion === undefined ? 2 : integer(input.sealVersion, "sealVersion", 2, 3);
	const unit = unitFor(state, input.unitId, integer(input.unitRevision, "unitRevision"));
	/** @param {unknown} refs @param {"obligation" | "evaluation"} kind */
	const selected = (refs, kind) => {
		const selectedRefs = list(refs, kind, 32, 1).map(reference);
		if (new Set(selectedRefs.map(key)).size !== selectedRefs.length) fail("factory_contract_invalid", "Contract references must be unique");
		for (const ref of selectedRefs) {
			const entry = knowledgeFor(state, ref);
			if (entry.unitId !== unit.id || entry.kind !== kind || retired(state, "knowledge", ref.id, ref.revision)) {
				fail("factory_contract_invalid", `Contract ${kind} references must be live ${kind} revisions of this unit`);
			}
		}
		return selectedRefs;
	};
	const obligations = selected(input.obligations, "obligation");
	const evaluations = selected(input.evaluations, "evaluation");
	const definitions = evaluations.map((ref) => evaluationFor(state, ref));
	if (!options.historical && definitions.some((definition) => definition.procedure.kind === "command" && !definition.procedure.bundle)) {
		fail("factory_evaluator_unpinned", "New executable contract acceptance requires an immutable Git evaluator bundle, not a legacy command reference");
	}
	if (definitions.some((definition) => definition.obligations.some((ref) => !obligations.some((item) => key(item) === key(ref))))
		|| obligations.some((ref) => !definitions.some((definition) => definition.obligations.some((item) => key(item) === key(ref))))) {
		fail("factory_evaluation_coverage", "Every obligation must have a pinned evaluation and every evaluation must cover selected obligation revisions");
	}
	if (!definitions.some((definition) => definition.modality === "boundary")
		|| !definitions.some((definition) => definition.preservation)) {
		fail("factory_evaluation_coverage", "Accepted contracts require independent boundary and preservation evaluations");
	}
	for (const otherId of new Set(state.contracts.map((contract) => contract.unitId))) {
		if (otherId === unit.id) continue;
		const otherContract = contractFor(state, otherId);
		const otherUnit = unitFor(state, otherId, otherContract.unitRevision);
		if (unit.boundary.owns.some((authority) => otherUnit.boundary.owns.includes(authority))) {
			fail("factory_authority_overlap", `Capability ${otherId} already owns a declared authority`);
		}
	}
	const resolutions = list(input.resolutions ?? [], "resolutions", 64).map((resolution) => {
		object(resolution, ["knowledge", "reason"], "resolution");
		knowledgeFor(state, resolution.knowledge);
		return { knowledge: reference(resolution.knowledge), reason: text(resolution.reason, "resolution reason") };
	});
	const selectedRefs = [...obligations, ...evaluations];
	const rationale = rationaleClosure(state, selectedRefs, list(input.rationale ?? [], "rationale", 32).map(reference));
	if (rationale.some((ref) => retired(state, "knowledge", ref.id, ref.revision))) {
		fail("factory_context_invalid", "Retired explanatory knowledge cannot enter a new accepted context");
	}
	const dependencies = assertAcceptedDependencies(state, unit, options.historical === true);
	const disputed = disputedKnowledge(state, selectedRefs);
	if (disputed.some((entry) => !resolutions.some((resolution) => key(resolution.knowledge) === key(entry)))) {
		fail("factory_unresolved_knowledge", "Acceptance needs attributed reasons resolving selected uncertainty and known contradictions", { knowledge: disputed.map(key) });
	}
	const renewalSignalIds = renewalSignals(state, unit.id, input.renewalSignalIds);
	/** @type {import("../types/factory.js").ContractDecision} */
	const decision = {
		id: `decision-${revision}`, kind: "accept-contract", unitId: unit.id, ...actorReason(input, at), resolutions,
		...(renewalSignalIds.length ? { renewalSignalIds } : {}),
	};
	const previous = state.contracts.filter((entry) => entry.unitId === unit.id).at(-1);
	const priorDecisionIds = state.contracts.filter((entry) => entry.unitId === unit.id).map((entry) => entry.decisionId);
	/** @type {FactoryContract} */
	const contract = {
		sealVersion,
		unitId: unit.id, unitRevision: unit.revision, revision: (previous?.revision ?? 0) + 1,
		obligations, evaluations, decisionId: decision.id, acceptedAt: at,
		previousDigest: previous?.digest ?? null,
		rationale, dependencies, decisionIds: [...priorDecisionIds.slice(-15), decision.id],
		omittedEarlierDecisions: Math.max(0, priorDecisionIds.length - 15),
		digest: "",
	};
	state.decisions.push(decision);
	const sealedContext = contractContext(state, contract);
	checkContextSize(sealedContext);
	contract.digest = analysisInputDigest({
		...contract, sealedContext,
		provenance: [...selectedRefs, ...rationale].map((ref) => {
			const entry = knowledgeFor(state, ref);
			if (sealVersion === 2) return entry;
			const { source: origin, sourceCommitment, statement, statementCommitment, ...knowledge } = entry;
			return { ...knowledge, sourceCommitment: sourceCommitment ?? analysisInputDigest(origin),
				statementCommitment: statementCommitment ?? analysisInputDigest(statement) };
		}),
	});
	if (input.historicalSeal !== undefined) {
		if (!options.portable || !options.historical || sealVersion !== 2) {
			fail("factory_context_invalid", "A historical seal must retain its exact accepted context");
		}
		if (input.contextSeal !== analysisInputDigest(sealedContext)) {
			if (input.historicalOnly !== true) fail("factory_context_invalid", "A historical seal must retain its exact accepted context");
			contract.historyOnly = true;
		}
		contract.digest = digest(input.historicalSeal, "historicalSeal");
	}
	state.contracts.push(contract);
	return { contract, decision };

}

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean}} [options] @returns {FactoryResults["ingestAnalysis"]} */
export function ingestAnalysis(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["unitId", "source", "report"], action);
	const unit = unitFor(state, input.unitId);
	const report = text(input.report, "analysis report", 48000);
	const provenance = source(input.source, at);
	if (!["audit", "research", "review", "security", "triage"].includes(provenance.kind)
		|| !provenance["runId"] || !provenance["owner"] || provenance["digest"] !== analysisInputDigest(report)) {
		fail("factory_analysis_provenance", "Analysis ingestion requires the exact scoped native report, owning session, run and digest");
	}
	/** @type {Knowledge[]} */
	const knowledge = [];
	for (let offset = 0; offset < report.length; offset += 7500) {
		const id = `analysis-${analysisInputDigest([provenance["owner"], provenance["runId"], input.unitId, offset, provenance["digest"]]).slice(0, 40)}`;
		if (state.knowledge.some((entry) => entry.id === id)) fail("factory_analysis_duplicate", "This native analysis was already ingested into this capability");
		const result = appendKnowledge(state, {
			revision, at, action: "appendKnowledge", input: {
				id, unitId: unit.id, kind: "observation", statement: report.slice(offset, offset + 7500),
				source: provenance,
				uncertainty: "Retained analysis output, not established product truth or governing requirements. Preserve its stated coverage gaps and verify proposals before acceptance.",
				links: knowledge.length ? [{ relation: "derived-from", target: { id: knowledge[knowledge.length - 1].id, revision: 1 } }] : [],
			},
		});
		knowledge.push(result.knowledge);
	}
	return { knowledge, reportDigest: digest(provenance.digest, "analysis digest") };

}
