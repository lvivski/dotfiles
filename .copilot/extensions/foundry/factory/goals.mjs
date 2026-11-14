import { analysisInputDigest } from "../digest.mjs";
import { operatingRecord } from "../plan/schemas/operating.mjs";
import { fail } from "./fields.mjs";
import { operatingGeneration, operatingRecords } from "./operating.mjs";
import { contractFor, evaluationFor, key, knowledgeFor, privateKnowledge, same } from "./records.mjs";

/** @typedef {import("../types/factory.js").FactorySnapshot} Snapshot */
/** @typedef {import("../types/factory.js").KnowledgeRef} Ref */
/** @typedef {import("../types/operating.js").OperatingRecord} Record */
/** @typedef {import("../types/operating.js").OperatingGoal} Goal */
/** @typedef {import("../types/operating.js").OperatingRelationship} Relationship */

/** @param {readonly string[]} values @param {string} label */
function unique(values, label) {
	if (new Set(values).size !== values.length) fail("goal_duplicate", `${label} must be unique`);
}

/** @param {Map<string, string[]>} edges */
function acyclic(edges) {
	const visited = new Set();
	const active = new Set();
	/** @param {string} id */
	function visit(id) {
		if (active.has(id)) fail("goal_cycle", `Blocking cycle at ${id}`);
		if (visited.has(id)) return;
		active.add(id);
		for (const next of edges.get(id) ?? []) visit(next);
		active.delete(id);
		visited.add(id);
	}
	for (const id of edges.keys()) visit(id);
}

/** Resolved references never follow a latest revision. Effective relationship
 * revisions stay visible after either endpoint changes, until explicitly revised.
 * @param {Snapshot} state @param {readonly Record[]} [records] */
export function goalGraph(state, records = []) {
	const history = [...operatingRecords(state), ...records.map(operatingRecord)];
	const revisions = new Map(history.map(record => [key(record), record]));
	const effective = new Map(history.map(record => [record.id, record]));
	/** @template {Record["kind"]} K @param {Ref} ref @param {K} kind
	 * @returns {Extract<Record, {kind: K}>} */
	function resolve(ref, kind) {
		const record = revisions.get(key(ref));
		if (!record || record.kind !== kind) fail("goal_reference_missing", `Missing ${kind} ${key(ref)}`);
		return /** @type {Extract<Record, {kind: K}>} */ (record);
	}
	const goals = [...effective.values()].filter(record => record.kind === "goal");
	const relationships = [...effective.values()].filter(record => record.kind === "relationship");
	return { history, effective, resolve, goals, relationships };
}

/** @param {Snapshot} state @param {Goal} goal */
function validateCriteria(state, goal) {
	unique(goal.criteria.map(entry => entry.id), "Goal criteria");
	const ids = new Set(goal.criteria.map(entry => entry.id));
	for (const criterion of goal.criteria) {
		unique(criterion.evaluations.map(key), "Criterion evaluators");
		unique(criterion.dependsOn, "Criterion dependencies");
		if (criterion.dependsOn.some(id => !ids.has(id))) fail("goal_criterion_missing", "Criterion dependency must resolve in the same pinned goal");
		if (criterion.obligation && knowledgeFor(state, criterion.obligation).kind !== "obligation") {
			fail("goal_obligation_invalid", "A criterion obligation must resolve to canonical obligation knowledge");
		}
		for (const ref of criterion.evaluations) {
			const definition = evaluationFor(state, ref);
			if (criterion.obligation && !definition.obligations.some(entry => same(entry, criterion.obligation))) {
				fail("goal_evaluator_mismatch", "The pinned evaluator must cover this exact obligation revision");
			}
			if (definition.environment !== criterion.environment || definition.workload !== criterion.workload) {
				fail("goal_context_mismatch", "Criterion context cannot replace the pinned evaluator environment or workload");
			}
		}
	}
	acyclic(new Map(goal.criteria.map(entry => [entry.id, entry.dependsOn])));
	if (!goal.contract) {
		if (goal.candidateId) fail("goal_contract_missing", "A candidate requires a pinned canonical contract");
		return;
	}
	const contract = contractFor(state, goal.contract.unitId, goal.contract.contractRevision);
	if (contract.unitRevision !== goal.contract.unitRevision || contract.digest !== goal.contract.contractDigest) {
		fail("goal_contract_mismatch", "The exact contract revision and digest must match");
	}
	for (const criterion of goal.criteria) {
		if (!criterion.obligation || !contract.obligations.some(ref => same(ref, criterion.obligation))) {
			fail("goal_obligation_mismatch", "Contract-backed criteria must name an exact accepted obligation");
		}
		const required = contract.evaluations.filter(ref =>
			evaluationFor(state, ref).obligations.some(obligation => same(obligation, criterion.obligation)));
		if (!same([...required.map(key)].sort(), [...criterion.evaluations.map(key)].sort())) {
			fail("goal_evaluator_mismatch", "Criteria must retain every contract evaluator for their obligation, including preservation, human and visual checks");
		}
	}
	if (contract.obligations.some(ref => !goal.criteria.some(criterion => same(criterion.obligation, ref)))) {
		fail("goal_obligation_missing", "The goal must retain every obligation of its pinned contract");
	}
	const candidate = state.candidates.find(entry => entry.id === goal.candidateId);
	if (candidate && (candidate.unitId !== contract.unitId || candidate.contractRevision !== contract.revision
		|| candidate.contractDigest !== contract.digest)) fail("goal_candidate_mismatch", "Candidate and goal contract identities differ");
}

/** Missing portable execution records are holds, never fabricated resolutions.
 * When execution is present every pin is compared, including the input artifact.
 * @param {Snapshot} state @param {Relationship} edge @param {ReturnType<typeof goalGraph>} graph */
export function producerGaps(state, edge, graph) {
	if (edge.relation !== "artifact") return [];
	const producer = edge.producer;
	if (!producer || !edge.to) return ["producer-unresolved"];
	const target = graph.resolve(edge.to, "goal");
	const gaps = [];
	if (!same(producer.contract, target.contract)) gaps.push("producer-contract-mismatch");
	const contract = target.contract ? contractFor(state, target.contract.unitId, target.contract.contractRevision) : null;
	if (!contract || !same([...producer.evaluators.map(entry => key(entry.evaluation))].sort(), [...contract.evaluations.map(key)].sort())
		|| producer.evaluators.some(entry => evaluationFor(state, entry.evaluation).procedure.digest !== entry.procedureDigest)) {
		gaps.push("producer-evaluator-mismatch");
	}
	const consumer = graph.resolve(edge.from, "goal");
	const consumption = state.candidates.find(entry => entry.id === consumer.candidateId);
	if (consumption && !consumption.context.generation.some(input => same(input, producer.artifact))) {
		gaps.push("consumer-input-mismatch");
	}
	const candidate = state.candidates.find(entry => entry.id === target.candidateId);
	if (!candidate) return [...gaps, "producer-execution-unavailable"];
	if (!candidate.delivery) return [...gaps, "producer-delivery-missing"];
	const delivery = candidate.delivery;
	if (delivery.commit !== producer.commit || !same(delivery.artifact, producer.artifact)) gaps.push("producer-delivery-mismatch");
	if (delivery.source.kind !== "app-task" || delivery.source.planId !== producer.planId
		|| delivery.source.taskId !== producer.taskId || delivery.source.attemptId !== producer.attemptId) gaps.push("producer-attempt-mismatch");
	if (!candidate.binding || candidate.binding.planId !== producer.planId || candidate.binding.purpose === "evaluation"
		|| candidate.binding.owner !== delivery.source.owner) gaps.push("producer-binding-mismatch");
	if (candidate.completion?.disposition === "cancelled") gaps.push("producer-cancelled");
	else if (!candidate.completion?.passed) gaps.push("producer-incomplete");
	if (candidate.completion?.commit !== producer.commit) gaps.push("producer-completion-mismatch");
	if (contract?.historyOnly) gaps.push("producer-history-only");
	return gaps;
}

/** Production full-effective-graph validator, composed under the canonical
 * writer's snapshot lock as well as prepare/import. No authority or I/O here.
 * @param {Snapshot} state @param {readonly Record[]} records */
export function validateGoals(state, records) {
	const graph = goalGraph(state, records);
	const comparison = new Set(graph.history.flatMap(record => record.context.filter(entry => entry.usage === "comparison-only").map(entry => entry.digest)));
	for (const record of graph.history) {
		if (record.kind !== "goal") continue;
		graph.resolve(record.charter, "charter");
		validateCriteria(state, record);
		for (const context of record.context.filter(entry => entry.usage === "generation")) {
			if (context.artifact?.kind === "implementation" || comparison.has(context.digest)
				|| (context.artifact && comparison.has(context.artifact.digest))
				|| (context.knowledge && privateKnowledge(knowledgeFor(state, context.knowledge)))) {
				fail("goal_generation_contaminated", "Fresh goal context cannot expose comparison-only implementation or private session knowledge");
			}
		}
	}
	/** @type {Map<string, string[]>} */
	const edges = new Map();
	for (const edge of graph.relationships) {
		const consumer = graph.resolve(edge.from, "goal");
		unique(edge.criterionIds, "Relationship criterion identities");
		if (!edge.criterionIds.length || edge.criterionIds.some(id => !consumer.criteria.some(criterion => criterion.id === id))) {
			fail("goal_criterion_missing", "A relationship must explicitly scope its affected criteria");
		}
		if (!edge.to) {
			if (edge.producer) fail("goal_producer_invalid", "Unresolved requirements cannot contain a fabricated producer");
			continue;
		}
		const target = graph.resolve(edge.to, "goal");
		const targets = edges.get(consumer.id) ?? [];
		targets.push(target.id);
		edges.set(consumer.id, targets);
		if (edge.relation !== "artifact") {
			if (edge.producer) fail("goal_producer_invalid", "Only artifact relationships carry producer pins");
			continue;
		}
		if (!edge.producer || !same(edge.producer.goal, edge.to) || !same(edge.producer.charter, target.charter)) {
			fail("goal_producer_mismatch", "A resolved artifact pins the exact target goal and accountable charter");
		}
		if (!target.candidateId || !target.contract || !edge.producer.evaluators.length) {
			fail("goal_producer_unresolved", "A resolved producer needs a candidate, exact contract and evaluator identities; otherwise retain an unresolved requirement");
		}
		graph.resolve(edge.producer.charter, "charter");
		unique(edge.producer.evaluators.map(entry => key(entry.evaluation)), "Producer evaluators");
		if (!same(edge.producer.contract, target.contract)) fail("goal_producer_mismatch", "Producer contract must equal the pinned goal contract");
		const gaps = producerGaps(state, edge, graph);
		if (gaps.some(gap => gap.endsWith("-mismatch"))) fail("goal_producer_mismatch", gaps.join(", "));
	}
	// Logical identities prevent an obsolete endpoint revision from concealing a
	// blocking cycle. Historical *relationship* revisions are not effective edges.
	acyclic(edges);
}

/** @param {Snapshot} state @param {Ref} ref */
export function goalGeneration(state, ref) {
	validateGoals(state, []);
	const graph = goalGraph(state);
	const goal = graph.resolve(ref, "goal");
	const { candidateId, ...record } = goal;
	return { ...structuredClone(record), context: operatingGeneration(goal).context, authority: "proposed",
		relationships: graph.relationships.filter(edge => same(edge.from, ref)).map(edge => {
			const { producer, ...relation } = edge;
			// A resolved producer is not itself permission to expose its implementation.
			return { ...structuredClone(relation), context: operatingGeneration(edge).context, producer: null };
		}) };
}

/** Stable open program needs, not a live program registration or acceptance.
 * Comparison/recovery provenance is returned only as an owner-local reference.
 * @param {import("../types/operating.js").OperatingIdentity} source @param {Ref} charter */
export function regenerationGoal(source, charter) {
	const needs = [
		["boundary", "Explicitly accept the boundary, contract and protected evaluators; preserve shared six-resource SR1 account/access/generations/budgets and Mail/Chat, or separately accept a different boundary."],
		["incumbent", "Explicitly select and preserve an incumbent; a comparison lead is not an accepted incumbent."],
		["generation", "Admit separate fresh generation without comparison-only implementation inputs."],
		["evaluation", "Independently evaluate the exact fresh candidate with protected boundary and preservation evidence, including applicable native, visual, human and platform checks."],
		["replacement", "Obtain explicit replacement acceptance without treating technical completion as acceptance."],
		["consumer", "Demonstrate actual consumer use of the accepted replacement."],
		["wiring", "Separately admit and deliver common public tool registration and lifecycle-driver wiring."],
		["execution", "Demonstrate supported live App-bound squads and goal execution under native permissions."],
		["cleanup", "Separately admit and demonstrate data-preserving real cleanup after all consumers and verifiers finish."],
	];
	const comparison = "hyper-comparison:69c3dcd5d91b04ad1a6a2006b5720a0793aac70b";
	const base = { version: /** @type {const} */ (1), revision: 1, previous: null, source, context: [] };
	/** @type {Goal} */
	const goal = { ...base, kind: "goal", id: "hyper-regeneration", title: "Hyper regeneration", intent: "Keep full regeneration open beyond bounded source/model delivery.",
		charter, authority: "proposed", contract: null, candidateId: null, relationshipCoverage: "partial",
		context: [{ id: "calendar-comparison", kind: "artifact", digest: analysisInputDigest(comparison), usage: "comparison-only", knowledge: null, artifact: null }],
		preserves: ["Incumbent and user data", "Shared six-resource SR1 account/access/generations/budgets", "Mail/Chat and shared limits"],
		criteria: needs.map(([id, statement]) => ({ id, statement, obligation: null, evaluations: [], dependsOn: [], environment: "unresolved", workload: "Hyper regeneration" })),
	};
	/** @type {Record[]} */
	const records = [goal, ...needs.map(([id, requirement]) => ({
		...base, kind: /** @type {const} */ ("relationship"), id: `hyper-needs-${id}`, relation: /** @type {const} */ ("depends-on"),
		from: { id: goal.id, revision: goal.revision }, to: null, requirement, criterionIds: [id], producer: null,
	}))];
	return { records, references: [{ id: "calendar-comparison", kind: /** @type {const} */ ("comparison"), ref: comparison, digest: analysisInputDigest(comparison) }] };
}
