import { source } from "./definitions.mjs";
import { enumeration, fail, identifier, list, object, reference, strings, text } from "./fields.mjs";
import { key, knowledgeFor, same, uniqueId, unitFor } from "./records.mjs";

/** @typedef {import("../types/factory.js").KnowledgeRef} KnowledgeRef */
/** @typedef {import("../types/factory.js").FactoryEvent} FactoryEvent */
/** @typedef {import("../types/factory.js").FactoryState} FactoryState */
/** @typedef {import("../types/factory.js").EvaluationDefinition} EvaluationDefinition */
/** @typedef {import("../types/factory.js").FactoryResults} FactoryResults */

/** @param {FactoryState} state @param {string} unitId @param {unknown} values */
export function renewalSignals(state, unitId, values) {
	const ids = strings(values ?? [], "renewalSignalIds").map((id) => identifier(id));
	for (const id of ids) {
		const signal = state.signals.find((entry) => entry.id === id);
		if (!signal) fail("factory_signal_missing", `Renewal signal ${id} does not exist`);
		const impact = affectedUnits(state, signal.unitIds, signal.knowledgeRefs);
		if (![...impact.affectedUnitIds, ...impact.uncertainUnitIds].includes(unitId)) {
			fail("factory_signal_scope", `Renewal signal ${id} does not affect capability ${unitId}`);
		}
	}
	return ids;
}

/** @param {FactoryState} state @param {string[]} unitIds @param {KnowledgeRef[]} knowledgeRefs */
export function affectedUnits(state, unitIds, knowledgeRefs) {
	const affected = new Set(unitIds);
	for (const ref of knowledgeRefs) affected.add(knowledgeFor(state, ref).unitId);
	const units = [...new Set(state.units.map((unit) => unit.id))].map((id) => {
		const contract = state.contracts.filter((entry) => entry.unitId === id).at(-1);
		return unitFor(state, id, contract?.unitRevision);
	});
	for (const id of affected) unitFor(state, id);
	let changed = true;
	while (changed) {
		changed = false;
		for (const unit of units) {
			if (!affected.has(unit.id) && unit.dependencies.some((id) => affected.has(id))) {
				affected.add(unit.id);
				changed = true;
			}
		}
	}
	const uncertain = affected.size === 0 || units.some((unit) => unit.relationshipCoverage === "partial"
		|| !same(unit.dependencies, unitFor(state, unit.id).dependencies));
	return {
		affectedUnitIds: [...affected].sort(),
		uncertainUnitIds: uncertain ? units.map((unit) => unit.id).filter((id) => !affected.has(id)).sort() : [],
		localization: uncertain ? "uncertain" : "declared-relationships",
	};
}

/** @param {FactoryState} state @param {import("../types/factory.js").Signal} signal @param {string} unitId @param {KnowledgeRef} evaluationRef @param {EvaluationDefinition} definition */
export function signalAffectsEvaluation(state, signal, unitId, evaluationRef, definition) {
	const localRefs = signal.knowledgeRefs.filter((ref) => knowledgeFor(state, ref).unitId === unitId);
	if (!localRefs.length) return true;
	if (localRefs.some((ref) => !["obligation", "evaluation"].includes(knowledgeFor(state, ref).kind))) return true;
	return localRefs.some((ref) => knowledgeFor(state, ref).kind === "evaluation"
		? key(ref) === key(evaluationRef)
		: definition.obligations.some((obligation) => key(obligation) === key(ref)));
}

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean}} [options] @returns {FactoryResults["recordSignal"]} */
export function recordSignal(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["id", "kind", "summary", "unitIds", "knowledgeRefs", "source"], action);
	const id = uniqueId(state.signals, input.id);
	const unitIds = strings(input.unitIds ?? [], "signal.unitIds").map((id) => identifier(id));
	const knowledgeRefs = list(input.knowledgeRefs ?? [], "signal.knowledgeRefs", 64).map(reference);
	const affected = affectedUnits(state, unitIds, knowledgeRefs);
	const signal = {
		id, kind: enumeration(input.kind, ["incident", "failed-evaluation", "assumption-change", "evidence-expired", "context-mismatch"], "signal.kind"),
		summary: text(input.summary, "signal.summary"), unitIds, knowledgeRefs,
		source: source(input.source, at), ...affected, recordedAt: at,
	};
	const renewal = {
		id: `renewal-${id}`, signalId: id, status: "proposed", ...affected,
		proposal: "Re-evaluate affected pinned obligations first; explicitly revise contracts or prepare bounded replacement candidates only where evidence requires it.",
		at,
	};
	state.signals.push(signal);
	state.renewals.push(renewal);
	return { signal, renewal };

}
