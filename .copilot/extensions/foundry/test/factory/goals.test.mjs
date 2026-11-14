import assert from "node:assert/strict";
import test from "node:test";
import { goalGeneration, goalGraph, producerGaps, validateGoals } from "../../factory/goals.mjs";
import { operatingRecords } from "../../factory/operating.mjs";
import { factoryMutator } from "./accessors.mjs";
import { charter, fixtureRules, goal, historicalIdentity, operatingFixture } from "./operating.mjs";
import { COMMIT, DIGEST, PROCEDURE } from "../git.mjs";

const rules = { ...fixtureRules, goals: validateGoals };
/** @param {string} id @param {string} from @param {string | null} to
 * @param {import("../../types/operating.js").OperatingRelationship["relation"]} [relation]
 * @returns {import("../../types/operating.js").OperatingRelationship} */
function edge(id, from, to, relation = "depends-on") {
	return { version: 1, kind: "relationship", id, revision: 1, previous: null, source: historicalIdentity, context: [],
		relation, from: { id: from, revision: 1 }, to: to ? { id: to, revision: 1 } : null,
		requirement: "Require the pinned producer boundary", criterionIds: ["criterion"], producer: null };
}

test("durable multi-level goals retain charter revisions and legal unresolved needs", async t => {
	const f = await operatingFixture(t, { rules });
	const sibling = [charter("sibling"), { ...goal("input"), charter: { id: "sibling", revision: 1 } }, edge("unresolved", "input", null)];
	const siblingAuthority = f.authority();
	assert.ok(siblingAuthority.binding);
	siblingAuthority.binding.charter = { id: "sibling", revision: 1 };
	f.factory.operating.commit(f.batch("sibling", sibling), siblingAuthority);
	const records = [charter(), goal("root"), goal("child"),
		edge("decompose", "root", "child", "subgoal"), edge("join", "child", "input")];
	f.factory.operating.commit(f.batch("initial", records), f.authority());
	const original = f.factory.exportFactory();
	assert.deepEqual(operatingRecords(f.open().snapshot()), [...sibling, ...records]);
	f.factory.operating.commit(f.batch("update", [{ ...goal("child", 2), intent: "Revised observable intent" }]), f.authority());
	assert.equal(goalGraph(f.open().snapshot()).resolve({ id: "child", revision: 1 }, "goal").intent, goal("child").intent);
	assert.throws(() => f.batch("conflict", [goal("child", 2)]), { code: "operating_revision_conflict" });
	assert.notEqual(f.factory.exportFactory(), original);
	assert.equal(f.open().snapshot().operating?.length, 3);
});

test("direct, indirect and mixed cycles fail against the complete effective graph", async t => {
	const f = await operatingFixture(t, { rules });
	f.factory.operating.commit(f.batch("initial", [charter(), goal("a"), goal("b"), goal("c"),
		edge("ab", "a", "b", "subgoal"), edge("bc", "b", "c")]), f.authority());
	for (const record of [edge("aa", "a", "a"), edge("ba", "b", "a"), edge("ca", "c", "a", "subgoal")]) {
		assert.throws(() => f.batch(record.id, [record]), { code: "goal_cycle" });
	}
	const changed = { ...edge("bc", "b", "a"), revision: 2, previous: { id: "bc", revision: 1 } };
	assert.throws(() => f.batch("changed-edge", [changed]), { code: "goal_cycle" });
	assert.equal(f.factory.snapshot().operating?.length, 1);
});

test("unknown revisions, wrong kinds, removed criteria and local criterion cycles fail closed", async t => {
	const f = await operatingFixture(t, { rules });
	f.factory.operating.commit(f.batch("initial", [charter(), goal("a"), goal("b")]), f.authority());
	assert.throws(() => f.batch("unknown-charter", [{ ...goal("c"), charter: { id: "squad", revision: 2 } }]), { code: "goal_reference_missing" });
	assert.throws(() => f.batch("wrong-kind", [edge("wrong", "a", "squad")]), { code: "goal_reference_missing" });
	assert.throws(() => f.batch("missing-revision", [{ ...edge("missing", "a", "b"), to: { id: "b", revision: 2 } }]), { code: "goal_reference_missing" });
	assert.throws(() => f.batch("criterion", [{ ...edge("missing-criterion", "a", "b"), criterionIds: ["removed"] }]), { code: "goal_criterion_missing" });
	const cyclic = goal("cyclic");
	cyclic.criteria[0].dependsOn = ["criterion"];
	assert.throws(() => f.batch("local-cycle", [cyclic]), { code: "goal_cycle" });
	const duplicate = goal("duplicate");
	duplicate.criteria.push(structuredClone(duplicate.criteria[0]));
	assert.throws(() => f.batch("duplicate", [duplicate]), { code: "goal_duplicate" });
});

test("revisions cannot conceal cycles by substituting latest endpoints", async t => {
	const f = await operatingFixture(t, { rules });
	f.factory.operating.commit(f.batch("initial", [charter(), goal("a"), goal("b"), edge("ab", "a", "b")]), f.authority());
	f.factory.operating.commit(f.batch("revision", [goal("a", 2), goal("b", 2)]), f.authority());
	const pinned = goalGraph(f.factory.snapshot()).relationships[0];
	assert.deepEqual(pinned.from, { id: "a", revision: 1 });
	assert.deepEqual(pinned.to, { id: "b", revision: 1 });
	assert.throws(() => f.batch("latest-substitution", [{ ...edge("ba", "b", "a"), from: { id: "b", revision: 2 }, to: { id: "a", revision: 2 } }]),
		{ code: "goal_cycle" });
});

test("accepted goals and exact producer delivery pins use canonical contracts and execution records", async t => {
	const f = await operatingFixture(t, { rules });
	const mutate = factoryMutator(f.factory);
	const source = { kind: "discovery", ref: "fixture:goal-boundary", actor: "fixture", at: new Date().toISOString() };
	mutate("appendKnowledge", { id: "obligation", unitId: "unit", kind: "obligation", statement: "Preserve input data", source });
	mutate("appendKnowledge", { id: "oracle", unitId: "unit", kind: "evaluation", statement: "Evaluate preserved data", source,
		evaluation: { modality: "boundary", procedure: PROCEDURE, obligations: [{ id: "obligation", revision: 1 }],
			environment: "fixture-node", workload: "fixture", independent: true, preservation: true, maxAgeSeconds: 86400 } });
	const { contract } = mutate("acceptContract", { unitId: "unit", unitRevision: 1, obligations: [{ id: "obligation", revision: 1 }],
		evaluations: [{ id: "oracle", revision: 1 }], actor: "fixture", reason: "Synthetic fixture acceptance, not a live contract" });
	const { candidate } = mutate("prepareCandidate", { id: "producer", unitId: "unit", contractRevision: 1, actor: "fixture",
		context: { generation: [], comparisonOnly: [], independence: { method: "fresh-session", reason: "Synthetic independent generation" } } });
	mutate("bindPlan", { unitId: "unit", unitRevision: 1, candidateId: candidate.id, contractRevision: 1, contractDigest: contract.digest,
		contextDigest: candidate.contextDigest, planId: "producer-plan", owner: "fixture-producer", blueprintDigest: DIGEST });
	mutate("recordDelivery", { candidateId: candidate.id, commit: COMMIT, artifact: { kind: "implementation", ref: "fixture:input", digest: DIGEST },
		source: { kind: "app-task", ref: "fixture:delivery", actor: "fixture", at: new Date().toISOString(), owner: "fixture-producer",
			planId: "producer-plan", taskId: "T-001", attemptId: "T-001-A001", sessionId: "producer-session" } });
	mutate("recordCompletion", { candidateId: candidate.id, passed: true, commit: COMMIT, evidenceIds: [],
		source: { kind: "native-workflow", ref: "fixture:complete", actor: "fixture", at: new Date().toISOString(), owner: "fixture-producer", planId: "producer-plan", runId: "producer-run" } });
	const producer = goal("producer-goal");
	producer.authority = "accepted";
	producer.candidateId = candidate.id;
	producer.contract = { unitId: "unit", unitRevision: 1, contractRevision: 1, contractDigest: contract.digest };
	producer.criteria[0].obligation = { id: "obligation", revision: 1 };
	producer.criteria[0].evaluations = [{ id: "oracle", revision: 1 }];
	const relationship = edge("artifact", "consumer", producer.id, "artifact");
	relationship.producer = { goal: { id: producer.id, revision: 1 }, charter: producer.charter, planId: "producer-plan",
		taskId: "T-001", attemptId: "T-001-A001", commit: COMMIT, artifact: { kind: "implementation", ref: "fixture:input", digest: DIGEST },
		contract: producer.contract, evaluators: [{ evaluation: { id: "oracle", revision: 1 }, procedureDigest: DIGEST }] };
	f.factory.operating.commit(f.batch("accepted", [charter(), producer, goal("consumer"), relationship]), f.authority());
	const state = f.open().snapshot();
	assert.deepEqual(producerGaps(state, relationship, goalGraph(state)), []);
	const pins = relationship.producer;
	assert.ok(pins);
	assert.throws(() => f.batch("artifact-mixed-cycle", [edge("back", producer.id, "consumer", "subgoal")]), { code: "goal_cycle" });
	for (const changed of [
		{ planId: "other-plan" }, { taskId: "T-002" }, { attemptId: "T-001-A002" }, { commit: "a".repeat(40) },
		{ artifact: { kind: /** @type {const} */ ("implementation"), ref: "fixture:other", digest: DIGEST } },
		{ charter: { id: "squad", revision: 2 } }, { contract: { ...producer.contract, contractRevision: 2 } },
		{ evaluators: [{ evaluation: { id: "oracle", revision: 1 }, procedureDigest: "a".repeat(64) }] },
	]) {
		assert.throws(() => f.batch("substituted", [{ ...relationship, revision: 2, previous: { id: relationship.id, revision: 1 },
			producer: { ...pins, ...changed } }]), { code: "goal_producer_mismatch" });
	}
	const stripped = { ...producer, id: "stripped", candidateId: null, criteria: [{ ...producer.criteria[0], evaluations: [] }] };
	assert.throws(() => f.batch("stripped", [stripped]), { code: "goal_evaluator_mismatch" });
	assert.throws(() => f.batch("context-substitution", [{ ...producer, id: "different-context",
		criteria: [{ ...producer.criteria[0], environment: "different-platform" }] }]), { code: "goal_context_mismatch" });
	assert.equal(goalGraph(state).resolve({ id: producer.id, revision: 1 }, "goal").authority, "accepted");
});

test("generation excludes local context, candidate and producer execution identities", async t => {
	const f = await operatingFixture(t, { rules });
	const privateGoal = goal("private");
	privateGoal.context = [{ id: "comparison", kind: "artifact", digest: "a".repeat(64), usage: "comparison-only", knowledge: null, artifact: null }];
	f.factory.operating.commit(f.batch("initial", [charter(), privateGoal]), f.authority());
	const generation = goalGeneration(f.factory.snapshot(), { id: "private", revision: 1 });
	assert.deepEqual(generation.context, []);
	assert.equal("candidateId" in generation, false);
	assert.equal(generation.authority, "proposed");
	const untrusted = { ...goal("bad"), conversation: "private-message-sentinel" };
	assert.throws(() => f.batch("conversation", [untrusted]), { code: "factory_input_invalid" });
	const contaminated = goal("contaminated");
	contaminated.context = [{ id: "disguised", kind: "artifact", digest: "a".repeat(64), usage: "generation",
		knowledge: null, artifact: { kind: "reference", ref: "fixture:disguised-comparison", digest: "a".repeat(64) } }];
	assert.throws(() => f.batch("disguised", [contaminated]), { code: "goal_generation_contaminated" });
	contaminated.context[0] = { ...contaminated.context[0], digest: DIGEST, artifact: { kind: "implementation", ref: "fixture:incumbent-source", digest: DIGEST } };
	assert.throws(() => f.batch("implementation-input", [contaminated]), { code: "goal_generation_contaminated" });
});
