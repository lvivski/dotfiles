import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createFactoryService } from "../../factory.mjs";
import { resolveEvaluatorBundle } from "../../evidence/bundles.mjs";
import { goalGraph, validateGoals } from "../../factory/goals.mjs";
import { goalImpact, goalReadiness, goalRollup } from "../../factory/rollup.mjs";
import { VISUAL_AXES } from "../../factory/visual.mjs";
import { factoryMutator } from "./accessors.mjs";
import { charter, fixtureRules, goal, historicalIdentity, operatingFixture } from "./operating.mjs";
import { COMMIT, DIGEST, PROCEDURE, git, seedRepository } from "../git.mjs";

/** @param {import("node:test").TestContext} t @param {{human?: boolean, visual?: boolean}} [options] */
async function fixture(t, options = {}) {
	const f = await operatingFixture(t, { rules: { ...fixtureRules, goals: validateGoals } });
	let clock = new Date(Date.now() + 1000).toISOString();
	const tick = (seconds = 1) => clock = new Date(Date.parse(clock) + seconds * 1000).toISOString();
	const factory = createFactoryService({ repositoryPath: f.repo, storageRoot: f.storageRoot, operating: f.ports, clock: () => clock });
	const mutate = factoryMutator(factory);
	let commit = COMMIT;
	let procedure = structuredClone(PROCEDURE);
	const reference = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="white"/></svg>\n';
	const referenceDigest = createHash("sha256").update(reference).digest("hex");
	const capture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0GkAAAAASUVORK5CYII=", "base64");
	const capturePath = path.join(f.root, "fixture.png");
	if (options.visual) {
		await writeFile(path.join(f.repo, "evaluators/reference.svg"), reference);
		git(f.repo, "add", "--", "evaluators/reference.svg");
		git(f.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Goal visual reference fixture");
		commit = git(f.repo, "rev-parse", "HEAD");
		const resolved = resolveEvaluatorBundle(f.repo, { ...PROCEDURE.bundle, commit });
		procedure = { ...PROCEDURE, bundle: resolved.bundle, digest: resolved.digest };
		await writeFile(capturePath, capture);
	}
	const source = () => ({ kind: "discovery", ref: "fixture:goal-intent", actor: "fixture", at: clock });
	for (const id of ["input", "order"]) mutate("appendKnowledge", { id, unitId: "unit", kind: "obligation", statement: `Preserve ${id}`, source: source() });
	/** @type {{id: string, obligation: string, modality: import("../../types/factory.js").EvaluationDefinition["modality"], human?: boolean, visual?: boolean}[]} */
	const definitions = [
		{ id: "implementation", obligation: "input", modality: "implementation-test" },
		{ id: "boundary", obligation: "input", modality: "boundary" },
		{ id: "order-oracle", obligation: "order", modality: "boundary" },
		...(options.human ? [{ id: "human", obligation: "input", modality: /** @type {const} */ ("human"), human: true }] : []),
		...(options.visual ? [{ id: "visual", obligation: "input", modality: /** @type {const} */ ("boundary"), visual: true }] : []),
	];
	for (const entry of definitions) mutate("appendKnowledge", { id: entry.id, unitId: "unit", kind: "evaluation", statement: `Evaluate ${entry.id}`, source: source(),
		evaluation: { modality: entry.modality, procedure: entry.human ? { kind: "judgment", ref: "Fixture human rubric", digest: DIGEST } : procedure,
			obligations: [{ id: entry.obligation, revision: 1 }], environment: "fixture-node", workload: "fixture", independent: true,
			preservation: entry.modality === "boundary", maxAgeSeconds: 100,
			...(entry.visual ? { visual: { capture: "Synthetic fixture capture, not live visual evidence",
				states: [{ id: "ordinary", intent: "Fixture visual state", reference: { path: "evaluators/reference.svg", digest: referenceDigest } }] } } : {}) } });
	const { contract } = mutate("acceptContract", { unitId: "unit", unitRevision: 1, obligations: ["input", "order"].map(id => ({ id, revision: 1 })),
		evaluations: definitions.map(({ id }) => ({ id, revision: 1 })), actor: "fixture", reason: "Source fixture acceptance only" });
	const { candidate } = mutate("prepareCandidate", { id: "candidate", unitId: "unit", contractRevision: 1, actor: "fixture-producer",
		context: { generation: [], comparisonOnly: [], independence: { method: "fresh-session", reason: "Source fixture generation" } } });
	const binding = { unitId: "unit", unitRevision: 1, candidateId: candidate.id, contractRevision: 1, contractDigest: contract.digest,
		contextDigest: candidate.contextDigest, blueprintDigest: DIGEST };
	mutate("bindPlan", { ...binding, planId: "generate", owner: "fixture-producer" });
	tick();
	mutate("recordDelivery", { candidateId: candidate.id, commit, artifact: { kind: "implementation", ref: "fixture:goal-delivery", digest: DIGEST },
		source: { kind: "app-task", ref: "fixture:delivery", actor: "fixture-producer", at: clock, owner: "fixture-producer",
			planId: "generate", taskId: "T-001", attemptId: "T-001-A001", sessionId: "producer-session" } });
	mutate("recordCompletion", { candidateId: candidate.id, passed: true, commit, evidenceIds: ["all-implementation-tasks-done"],
		source: { kind: "native-workflow", ref: "fixture:tasks-done", actor: "fixture", at: clock, owner: "fixture-producer", planId: "generate", runId: "generation-completed" } });
	for (const definition of definitions.filter(entry => !entry.human)) mutate("bindEvaluationPlan", { ...binding,
		planId: `evaluate-${definition.id}`, owner: "fixture-evaluator", evaluations: [{ id: definition.id, revision: 1 }], targetCommit: commit });
	const model = goal("target");
	model.authority = "accepted";
	model.contract = { unitId: "unit", unitRevision: 1, contractRevision: 1, contractDigest: contract.digest };
	model.candidateId = candidate.id;
	model.relationshipCoverage = "complete";
	model.criteria = ["input", "order"].map(id => ({ id, statement: `Conserve ${id}`, obligation: { id, revision: 1 },
		evaluations: definitions.filter(entry => entry.obligation === id).map(({ id }) => ({ id, revision: 1 })),
		dependsOn: [], environment: "fixture-node", workload: "fixture" }));
	/** @param {string} id @param {import("../../types/operating.js").OperatingRecord[]} records */
	const publish = (id, records) => factory.operating.commit(factory.operating.prepare({ version: 1, id, records,
		snapshot: factory.operating.snapshot().token, source: historicalIdentity }), f.authority());
	publish("model", [charter(), model]);
	let sequence = 0;
	/** @param {string} id @param {import("../../types/factory.js").Outcome} [outcome]
	 * @param {{observedAt?: string, environment?: string, sameContext?: boolean, run?: string,
	 * candidate?: import("../../types/factory.js").Candidate}} [config] */
	function evaluate(id, outcome = "passed", config = {}) {
		tick();
		const number = ++sequence;
		const definition = definitions.find(entry => entry.id === id);
		assert.ok(definition);
		const observedAt = config.observedAt ?? clock;
		const run = config.run ?? `evaluation-${number}`;
		const subject = config.candidate ?? candidate;
		const planId = subject.id === candidate.id ? `evaluate-${id}` : `${subject.id}-evaluate-${id}`;
		const report = definition.visual ? JSON.stringify({
			format: "foundry-visual-report-v1", deliveryCommit: commit, environment: "fixture-node",
			states: [{ id: "ordinary", referenceDigest, capture: { path: capturePath, digest: createHash("sha256").update(capture).digest("hex"),
				capturedAt: observedAt, method: "native-screenshot", viewport: "100x100@1" },
				assessment: Object.fromEntries(VISUAL_AXES.map(axis => [axis, { outcome, finding: `Synthetic ${axis} finding, not live capture validation` }])) }],
		}) : "Bounded source fixture evaluator output";
		const result = mutate("recordEvaluation", { id: `evidence-${number}`, candidateId: subject.id, evaluation: { id, revision: 1 },
			procedureDigest: definition.human ? DIGEST : procedure.digest, contractDigest: contract.digest, contextDigest: subject.contextDigest, commit,
			outcome, environment: config.environment ?? "fixture-node", workload: "fixture", report,
			independence: { method: definition.human ? "human-review" : config.sameContext ? "same-context" : "separate-session", reason: "Synthetic fixture attribution, not attestation" },
			source: definition.human ? { kind: "human", ref: `fixture:judgment-${run}`, actor: "fixture-human", at: observedAt, judgmentId: run }
				: { kind: "app-task", ref: `fixture:${run}`, actor: "fixture-evaluator", at: observedAt, owner: "fixture-evaluator",
					planId, taskId: "T-002", attemptId: `T-002-A${String(number).padStart(3, "0")}`, sessionId: run } });
		if (!definition.human) mutate("recordEvaluationCompletion", { candidateId: subject.id, passed: outcome === "passed", commit, evidenceIds: [result.evidence.id],
			source: { kind: "native-workflow", ref: `fixture:complete-${run}`, actor: "fixture", at: clock, owner: "fixture-evaluator", planId, runId: run } });
		return result.evidence;
	}
	/** @param {string} id @param {import("../../types/factory.js").ContextArtifact[]} generation @param {boolean} [complete] */
	function produce(id, generation, complete = true) {
		tick();
		const { candidate: subject } = mutate("prepareCandidate", { id, unitId: "unit", contractRevision: 1, mode: "implementation", actor: id,
			context: { generation, comparisonOnly: [], independence: { method: "fresh-session", reason: "Separately attributed sibling fixture generation" } } });
		const bound = { ...binding, candidateId: id, contextDigest: subject.contextDigest };
		mutate("bindPlan", { ...bound, planId: `generate-${id}`, owner: "fixture-producer" });
		mutate("recordDelivery", { candidateId: id, commit, artifact: { kind: "implementation", ref: `fixture:${id}`, digest: DIGEST },
			source: { kind: "app-task", ref: `fixture:delivery-${id}`, actor: id, at: clock, owner: "fixture-producer",
				planId: `generate-${id}`, taskId: "T-001", attemptId: "T-001-A001", sessionId: `${id}-session` } });
		if (complete) mutate("recordCompletion", { candidateId: id, passed: true, commit, evidenceIds: ["tasks-done"],
			source: { kind: "native-workflow", ref: `fixture:completed-${id}`, actor: "fixture", at: clock, owner: "fixture-producer", planId: `generate-${id}`, runId: `${id}-completed` } });
		for (const definition of definitions.filter(entry => !entry.human)) mutate("bindEvaluationPlan", { ...bound,
			planId: `${id}-evaluate-${definition.id}`, owner: "fixture-evaluator", evaluations: [{ id: definition.id, revision: 1 }], targetCommit: commit });
		return subject;
	}
	const inspect = (id = model.id, at = clock) => goalRollup(factory.snapshot(), { id, revision: 1 }, at);
	return { ...f, factory, mutate, model, contract, candidate, definitions, publish, evaluate, produce, inspect, tick, now: () => clock, commit, procedure };
}

test("all implementation tasks done cannot close criteria missing boundary, preservation or human evidence", async t => {
	const f = await fixture(t, { human: true });
	assert.equal(f.factory.snapshot().candidates[0].completion?.passed, true);
	f.evaluate("implementation");
	f.evaluate("order-oracle");
	const result = f.inspect();
	assert.equal(result.status, "open");
	assert.equal(result.criteria[1].status, "supported");
	assert.ok(result.criteria[0].evaluations.find(entry => entry.evaluation.id === "boundary")?.reasons.includes("missing"));
	assert.ok(result.criteria[0].evaluations.find(entry => entry.evaluation.id === "human")?.reasons.includes("pending-human"));
	f.evaluate("boundary");
	assert.equal(f.inspect().status, "open");
	f.evaluate("human");
	assert.equal(f.inspect().status, "closed");
	assert.equal(f.inspect().trust, "claims-not-attestation");
});

test("new failures outrank late historical passes, equal-time conflicts persist, and duplicate publication cannot renew", async t => {
	const f = await fixture(t);
	f.evaluate("implementation"); f.evaluate("order-oracle");
	const old = f.evaluate("boundary");
	assert.equal(f.inspect().status, "closed");
	const acceptance = f.mutate("decideCandidate", { candidateId: f.candidate.id, action: "accept", expectedIncumbentId: null, actor: "fixture", reason: "Historical fixture selection" }).decision;
	const failed = f.evaluate("boundary", "failed");
	f.evaluate("boundary", "passed", { observedAt: old.source.at });
	let support = f.inspect().criteria[0].evaluations.find(entry => entry.evaluation.id === "boundary");
	assert.ok(support);
	assert.equal(support.selected?.id, failed.id);
	assert.ok(support.reasons.includes("failed"));
	assert.equal(support.observations.filter(entry => entry.disposition === "historical").length, 2);
	f.evaluate("boundary", "passed", { observedAt: failed.source.at });
	support = f.inspect().criteria[0].evaluations.find(entry => entry.evaluation.id === "boundary");
	assert.ok(support?.reasons.includes("conflicting-observations"));
	const fresh = f.evaluate("boundary");
	const before = f.factory.exportFactory();
	assert.throws(() => f.mutate("recordEvaluation", {
		id: "duplicate-origin", candidateId: fresh.candidateId, evaluation: fresh.evaluation, procedureDigest: fresh.procedureDigest,
		contractDigest: fresh.contractDigest, contextDigest: fresh.contextDigest, commit: fresh.commit, outcome: "passed",
		environment: fresh.environment, workload: fresh.workload, report: fresh.report, independence: fresh.independence,
		source: { ...fresh.source, at: f.tick() },
	}), { code: "factory_evaluation_origin_reused" });
	assert.equal(f.factory.exportFactory(), before);
	assert.equal(f.inspect().status, "closed");
	assert.deepEqual(f.factory.snapshot().decisions.find(entry => entry.id === acceptance.id), acceptance);
	assert.equal(f.inspect("target", f.tick(101)).status, "open");
	assert.ok(f.inspect().criteria[0].evaluations.some(entry => entry.reasons.includes("expired")));
});

test("canonical renewal and context gaps reopen only their linked criteria with exact evidence identity retained", async t => {
	const f = await fixture(t);
	f.evaluate("implementation"); f.evaluate("boundary"); const order = f.evaluate("order-oracle");
	f.mutate("recordSignal", { id: "input-renewal", kind: "assumption-change", summary: "Input-only requirement changed",
		unitIds: ["unit"], knowledgeRefs: [{ id: "input", revision: 1 }],
		source: { kind: "operational", ref: "fixture:renewal", actor: "fixture", at: f.now() } });
	let result = f.inspect();
	assert.equal(result.criteria[0].status, "open");
	assert.equal(result.criteria[1].status, "supported");
	assert.deepEqual(result.criteria[1].evaluations[0].selected, order);
	const mismatch = f.evaluate("order-oracle", "passed", { environment: "different-platform" });
	result = f.inspect();
	assert.ok(result.criteria[1].evaluations[0].reasons.includes("environment-mismatch"));
	assert.equal(result.criteria[1].evaluations[0].selected?.source.at, mismatch.source.at);
	assert.equal(result.criteria[1].evaluations[0].procedureDigest, f.procedure.digest);
	f.evaluate("order-oracle", "passed", { sameContext: true });
	assert.ok(f.inspect().criteria[1].evaluations[0].reasons.includes("independence-missing"));
	const unavailable = goalRollup(f.factory.snapshot(), { id: "target", revision: 1 }, f.now(), { availableEnvironments: ["windows-native"] });
	assert.ok(unavailable.criteria[1].evaluations[0].reasons.includes("unavailable-platform"));
});

test("visual rejection remains attributable and cannot be replaced by implementation success", async t => {
	const f = await fixture(t, { visual: true });
	f.evaluate("implementation"); f.evaluate("boundary"); f.evaluate("order-oracle"); f.evaluate("visual", "failed");
	const result = f.inspect();
	const support = result.criteria[0].evaluations.find(entry => entry.evaluation.id === "visual");
	assert.ok(support?.visual);
	assert.ok(support.reasons.includes("visually-rejected"));
	assert.match(support.requirement, /visual fidelity/);
	assert.equal(result.status, "open");
	assert.equal(result.criteria[1].status, "supported");
});

test("contract and evaluator renewal never substitute latest identities into old goal support", async t => {
	const f = await fixture(t);
	f.evaluate("implementation"); const original = f.evaluate("boundary"); f.evaluate("order-oracle");
	const historical = f.factory.snapshot().decisions;
	const definition = f.factory.snapshot().knowledge.find(entry => entry.id === "boundary")?.evaluation;
	assert.ok(definition);
	f.mutate("appendKnowledge", { id: "boundary", unitId: "unit", kind: "evaluation", statement: "Renewed boundary oracle",
		evaluation: definition, links: [{ relation: "supersedes", target: { id: "boundary", revision: 1 } }],
		source: { kind: "discovery", ref: "fixture:renewal", actor: "fixture", at: f.now() } });
	assert.equal(f.inspect().status, "closed");
	f.mutate("acceptContract", { unitId: "unit", unitRevision: 1, obligations: f.contract.obligations,
		evaluations: f.contract.evaluations.map(ref => ref.id === "boundary" ? { ...ref, revision: 2 } : ref),
		actor: "fixture", reason: "Synthetic explicitly accepted evaluator renewal" });
	const support = f.inspect();
	assert.equal(support.status, "open");
	assert.ok(support.criteria[0].reasons.includes("contract-superseded"));
	assert.equal(support.criteria[0].evaluations.find(entry => entry.evaluation.id === "boundary")?.selected?.id, original.id);
	assert.equal(support.criteria[0].evaluations.find(entry => entry.evaluation.id === "boundary")?.evaluation.revision, 1);
	assert.deepEqual(f.factory.snapshot().decisions.slice(0, historical.length), historical);
	assert.throws(() => f.publish("follow-latest", [{ ...f.model, revision: 2, previous: { id: "target", revision: 1 },
		criteria: f.model.criteria.map(criterion => ({ ...criterion, evaluations: criterion.evaluations.map(ref => ref.id === "boundary" ? { ...ref, revision: 2 } : ref) })) }]),
		{ code: "goal_evaluator_mismatch" });
});

test("multi-level sibling joins selectively reopen, retain unknown impact and reject changed input revisions", async t => {
	const f = await fixture(t);
	f.evaluate("implementation"); f.evaluate("boundary"); f.evaluate("order-oracle");
	const input = { kind: /** @type {const} */ ("implementation"), ref: "fixture:goal-delivery", digest: DIGEST };
	const sibling = f.produce("sibling-candidate", [input]);
	for (const { id } of f.definitions) f.evaluate(id, "passed", { candidate: sibling });
	const consumer = { ...structuredClone(f.model), id: "consumer", candidateId: sibling.id, charter: { id: "sibling", revision: 1 } };
	const root = { ...structuredClone(f.model), id: "root" };
	const unrelated = { ...structuredClone(f.model), id: "unrelated" };
	/** @type {import("../../types/operating.js").OperatingRelationship} */
	const artifact = { version: 1, kind: "relationship", id: "shared-input", revision: 1, previous: null, source: historicalIdentity, context: [],
		relation: "artifact", from: { id: consumer.id, revision: 1 }, to: { id: f.model.id, revision: 1 }, requirement: "Use exact producer input",
		criterionIds: ["input"], producer: { goal: { id: f.model.id, revision: 1 }, charter: f.model.charter,
			planId: "generate", taskId: "T-001", attemptId: "T-001-A001", commit: f.commit,
			artifact: { kind: "implementation", ref: "fixture:goal-delivery", digest: DIGEST }, contract: f.model.contract,
			evaluators: f.definitions.map(({ id }) => ({ evaluation: { id, revision: 1 }, procedureDigest: f.procedure.digest })) } };
	f.publish("hierarchy", [charter("sibling"), consumer, root, unrelated, artifact,
		{ ...artifact, id: "subgoal", relation: "subgoal", from: { id: root.id, revision: 1 }, to: { id: consumer.id, revision: 1 }, producer: null }]);
	assert.equal(f.inspect("root").status, "closed");
	f.evaluate("boundary", "failed");
	assert.equal(f.inspect("consumer").criteria[0].status, "open");
	assert.equal(f.inspect("consumer").criteria[1].status, "supported");
	f.evaluate("boundary");
	assert.equal(f.inspect("root").status, "closed");
	const changed = { ...structuredClone(f.model), revision: 2, previous: { id: f.model.id, revision: 1 }, relationshipCoverage: /** @type {const} */ ("partial") };
	f.publish("producer-revision", [changed]);
	const reopened = f.inspect("consumer");
	assert.ok(reopened.criteria[0].reasons.some(reason => reason.includes("producer-revision-changed")));
	assert.equal(reopened.criteria[1].status, "supported");
	assert.equal(f.inspect("root").criteria[0].status, "open");
	assert.equal(f.inspect("unrelated").status, "closed");
	const impact = goalImpact(f.factory.snapshot(), [{ goal: { id: "target", revision: 2 }, criterionIds: ["input"] }]);
	assert.deepEqual(impact.affected.find(entry => entry.goalId === "consumer")?.criterionIds, ["input"]);
	assert.ok(impact.uncertainGoalIds.includes("unrelated"));
	assert.equal(goalGraph(f.factory.snapshot()).relationships.find(entry => entry.id === "shared-input")?.to?.revision, 1);
	const cancelled = goalReadiness(f.factory.snapshot(), { id: "consumer", revision: 1 }, f.now(), { phase: "cancelled", reason: "Canonical caller fence cancelled" });
	assert.equal(cancelled.readyForExistingAdmission, false);
	assert.equal(cancelled.authority, "projection-only");
	const cancelledProducer = f.produce("cancelled-input", [], false);
	f.mutate("abandonPlan", { candidateId: cancelledProducer.id, reason: "Fixture completed cancellation, not live cancellation evidence",
		source: { kind: "human", ref: "fixture:cancelled-input", actor: "fixture", at: f.now(), owner: "fixture-producer", planId: "generate-cancelled-input" } });
	const revisedProducer = { ...changed, revision: 3, previous: { id: changed.id, revision: 2 }, candidateId: cancelledProducer.id };
	const revisedConsumer = { ...consumer, revision: 2, previous: { id: consumer.id, revision: 1 }, candidateId: null };
	assert.ok(artifact.producer);
	const retry = { ...artifact, revision: 2, previous: { id: artifact.id, revision: 1 }, from: { id: consumer.id, revision: 2 }, to: { id: f.model.id, revision: 3 },
		producer: { ...artifact.producer, goal: { id: f.model.id, revision: 3 }, planId: "generate-cancelled-input",
			artifact: { ...input, ref: "fixture:cancelled-input" } } };
	assert.throws(() => f.publish("incompatible-retry", [revisedProducer, { ...revisedConsumer, candidateId: sibling.id }, retry]),
		{ code: "goal_producer_mismatch" });
	f.publish("cancelled-input", [revisedProducer, revisedConsumer, retry]);
	const reopenedAfterRestart = goalRollup(f.open().snapshot(), { id: consumer.id, revision: 2 }, f.now());
	assert.ok(reopenedAfterRestart.criteria[0].reasons.some(reason => reason.includes("producer-cancelled")));
	assert.equal(reopenedAfterRestart.status, "open");
});

test("portable reopen retains model history but cannot manufacture candidate evidence or native ownership", async t => {
	const f = await fixture(t);
	f.evaluate("implementation"); f.evaluate("boundary"); f.evaluate("order-oracle");
	assert.equal(f.inspect().status, "closed");
	const clone = path.join(f.root, "clone");
	const cache = path.join(f.root, "cache");
	await mkdir(clone); await mkdir(cache); seedRepository(clone);
	await cp(path.join(f.repo, ".foundry"), path.join(clone, ".foundry"), { recursive: true });
	const open = () => createFactoryService({ repositoryPath: clone, storageRoot: cache, operating: f.ports, clock: f.now });
	for (const restored of [open(), open()]) {
		const state = restored.snapshot();
		assert.deepEqual(state.candidates, []);
		assert.deepEqual(state.bindings, []);
		assert.equal(goalRollup(state, { id: "target", revision: 1 }, f.now()).status, "open");
		assert.equal(goalGraph(state).resolve({ id: "target", revision: 1 }, "goal").candidateId, f.candidate.id);
	}
});
