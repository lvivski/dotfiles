import assert from "node:assert/strict";
import test from "node:test";
import { candidateAssurance } from "../../factory/assurance.mjs";
import { must } from "../assertions.mjs";
import { COMMIT, DIGEST, fixture, source } from "../bridge/fixture.mjs";

test("shared-foundation assurance visits a 22-node preceding-two DAG once per candidate", () => {
	/** @type {import("../../types/factory.js").FactoryState} */
	const state = { units: [], knowledge: [], contracts: [], candidates: [], decisions: [], retirements: [], signals: [], bindings: [], renewals: [], compactions: [] };
	let accesses = 0;
	const at = "2026-01-01T00:00:01.000Z";
	for (let index = 0; index < 22; index++) {
		const id = `u${index}`;
		const dependencies = [index - 1, index - 2].filter((value) => value >= 0);
		/** @type {import("../../types/factory.js").Provenance} */
		const provenance = { kind: "external-run", ref: "fixture:dag", actor: "verifier", at: "2026-01-01T00:00:00.000Z" };
		/** @type {import("../../types/factory.js").Knowledge} */
		const obligation = { id: `o${index}`, revision: 1, unitId: id, kind: "obligation", statement: "Fixture conservation", source: provenance, recordedAt: provenance.at, evaluation: null, uncertainty: null, links: [] };
		/** @type {import("../../types/factory.js").Knowledge} */
		const evaluator = {
			id: `e${index}`, revision: 1, unitId: id, kind: "evaluation", statement: "Fixture oracle", source: provenance, recordedAt: provenance.at, uncertainty: null, links: [],
			evaluation: {
				modality: "boundary", procedure: { kind: "command", ref: "fixture:evaluate", digest: DIGEST }, obligations: [{ id: obligation.id, revision: 1 }],
				environment: "fixture", workload: "fixture", independent: true, preservation: true, maxAgeSeconds: 86400
			}
		};
		/** @type {import("../../types/factory.js").FactoryContract} */
		const contract = {
			sealVersion: 2, acceptedAt: provenance.at, previousDigest: null, rationale: [], decisionIds: [`d${index}`], omittedEarlierDecisions: 0, unitId: id, unitRevision: 1, revision: 1, digest: String(index).padStart(64, "0"),
			obligations: [{ id: obligation.id, revision: 1 }], evaluations: [{ id: evaluator.id, revision: 1 }], decisionId: `d${index}`,
			dependencies: dependencies.map((value) => ({ unitId: `u${value}`, unitRevision: 1, contractRevision: 1, contractDigest: String(value).padStart(64, "0") }))
		};
		state.units.push({
			id, revision: 1, dependencies: dependencies.map((value) => `u${value}`), relationshipCoverage: "complete",
			name: id, purpose: "DAG traversal", boundary: { owns: [id], exposes: [id], consumes: [], preserves: [id] }, actor: "fixture", reason: "DAG fixture", at: provenance.at
		});
		state.knowledge.push(obligation, evaluator);
		state.contracts.push(contract);
		state.decisions.push({ id: `d${index}`, kind: "accept-contract", unitId: id, actor: "fixture", reason: "DAG fixture", at: provenance.at, resolutions: [] },
			{ id: `s${index}`, kind: "accept-candidate", unitId: id, candidateId: `c${index}`, incumbentId: null, contractDigest: contract.digest, evidenceIds: [`proof${index}`], actor: "fixture", reason: "DAG fixture", at: provenance.at });
		state.candidates.push({
			id: `c${index}`, unitId: id, contractRevision: 1, contractDigest: contract.digest, contextDigest: DIGEST, mode: "implementation", actor: "fixture", createdAt: provenance.at, incumbentId: null, binding: null, completion: null,
			context: { generation: [], comparisonOnly: [], independence: { method: "fresh-session", reason: "DAG fixture" } },
			delivery: { commit: COMMIT, artifact: { kind: "implementation", ref: "fixture:dag", digest: DIGEST }, recordedAt: provenance.at, trust: "claimed", source: { ...provenance, sessionId: `producer${index}` } },
			/** @returns {import("../../types/factory.js").EvaluationEvidence[]} */
			get evidence() {
				accesses++;
				return [{
					id: `proof${index}`, candidateId: `c${index}`, contractDigest: contract.digest, contextDigest: DIGEST, commit: COMMIT, procedureDigest: DIGEST, report: "DAG proof", reportDigest: DIGEST, recordedAt: provenance.at, evaluation: { id: evaluator.id, revision: 1 }, outcome: "passed", trust: "independent-claim",
					environment: "fixture", workload: "fixture", independence: { method: "separate-process", reason: "Fixture" },
					source: provenance
				}];
			},
		});

	}
	assert.equal(candidateAssurance(state, must(state.candidates.at(-1)), at).ready, true);
	assert.ok(accesses <= 44, `Expected linear shared traversal, got ${accesses} evidence accesses`);
});

test("knowledge-scoped signals invalidate only covered evaluators within the directly affected unit", async (t) => {
	const f = await fixture(t);
	f.mutate("appendKnowledge", { id: "other-obligation", unitId: "unit", kind: "obligation", statement: "Preserve output order", source: source() });
	f.mutate("appendKnowledge", {
		id: "other-oracle", unitId: "unit", kind: "evaluation", statement: "Evaluate output order", source: source(),
		evaluation: {
			modality: "implementation-test", procedure: { kind: "command", ref: "order-test", digest: DIGEST },
			obligations: [{ id: "other-obligation", revision: 1 }], environment: "fixture-node", workload: "fixture-workload",
			maxAgeSeconds: 86400, independent: true, preservation: false
		}
	});
	f.mutate("acceptContract", {
		unitId: "unit", unitRevision: 1,
		obligations: [{ id: "obligation", revision: 1 }, { id: "other-obligation", revision: 1 }],
		evaluations: [{ id: "oracle", revision: 1 }, { id: "other-oracle", revision: 1 }], actor: "owner", reason: "Two independently scoped obligations"
	});
	const { candidate } = f.mutate("prepareCandidate", {
		id: "two-checks", unitId: "unit", contractRevision: 2, actor: "producer",
		context: { generation: [], comparisonOnly: [], independence: { method: "fresh-process", reason: "External fixture generation" } }
	});
	f.mutate("recordDelivery", {
		candidateId: candidate.id, commit: COMMIT, artifact: { kind: "implementation", ref: "fixture:module", digest: DIGEST },
		source: { kind: "external-run", owner: "fixture", runId: "generate-two", ref: "fixture:generate", actor: "producer", at: new Date().toISOString() }
	});
	for (const id of ["oracle", "other-oracle"]) f.mutate("recordEvaluation", {
		id: `evidence-${id}`, candidateId: candidate.id, evaluation: { id, revision: 1 }, procedureDigest: DIGEST,
		contractDigest: candidate.contractDigest, contextDigest: candidate.contextDigest, commit: COMMIT, outcome: "passed",
		environment: "fixture-node", workload: "fixture-workload", report: "One actual evaluator batch may report distinct subjects",
		independence: { method: "separate-process", reason: "Distinct evaluator invocation" },
		source: { kind: "external-run", owner: "fixture", runId: "evaluate-batch", ref: "fixture:evaluate", actor: "evaluator", at: new Date().toISOString() },
	});
	f.mutate("recordSignal", {
		id: "one-obligation", kind: "assumption-change", summary: "Only caller input assumptions changed",
		unitIds: ["unit"], knowledgeRefs: [{ id: "obligation", revision: 1 }], source: { ...source(), kind: "operational" }
	});
	let support = f.factory.inspect({ candidateId: candidate.id }).candidates[0].assurance.evaluationSupport;
	assert.ok(must(support.find((entry) => entry.evaluation.id === "oracle")).gaps.includes("renewal-required"));
	assert.deepEqual(must(support.find((entry) => entry.evaluation.id === "other-oracle")).gaps, []);
	f.mutate("recordSignal", {
		id: "one-evaluator", kind: "evidence-expired", summary: "The order oracle needs refresh",
		knowledgeRefs: [{ id: "other-oracle", revision: 1 }], source: source()
	});
	support = f.factory.inspect({ candidateId: candidate.id }).candidates[0].assurance.evaluationSupport;
	assert.ok(must(support.find((entry) => entry.evaluation.id === "other-oracle")).gaps.includes("renewal-required"));
});

test("equal-time contradictory observations are retained without letting publication order pick a pass", async (t) => {
	const f = await fixture(t);
	f.mutate("recordDelivery", {
		candidateId: f.candidate.id, commit: COMMIT,
		artifact: { kind: "implementation", ref: "fixture:module", digest: DIGEST },
		source: { kind: "external-run", owner: "fixture", runId: "generation", sessionId: "producer", ref: "fixture:generation", actor: "producer", at: new Date().toISOString() }
	});
	const observedAt = new Date().toISOString();
	for (const outcome of ["failed", "passed"]) f.mutate("recordEvaluation", {
		id: `tied-${outcome}`, candidateId: f.candidate.id, evaluation: { id: "oracle", revision: 1 }, procedureDigest: DIGEST,
		contractDigest: f.candidate.contractDigest, contextDigest: f.candidate.contextDigest, commit: COMMIT, outcome,
		environment: "fixture-node", workload: "fixture-workload", report: `Actual ${outcome} observation`,
		independence: { method: "separate-process", reason: "Independent actual execution" },
		source: { kind: "external-run", owner: "fixture", runId: `execution-${outcome}`, ref: `fixture:${outcome}`, actor: "evaluator", at: observedAt },
	});
	const state = f.factory.snapshot();
	const candidate = state.candidates[0];
	assert.equal(candidate.evidence.length, 2);
	const assurance = candidateAssurance(state, candidate, observedAt);
	assert.equal(assurance.ready, false);
	assert.ok(assurance.evaluationSupport[0].gaps.includes("conflicting-observations"));
	candidate.evidence.reverse();
	assert.deepEqual(candidateAssurance(state, candidate, observedAt), assurance);
});
