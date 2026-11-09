import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createFactoryService } from "../../factory.mjs";
import { must } from "../assertions.mjs";
import { evaluator, fixture, freshCode, hash, initialCode } from "./fixture.mjs";

test("discovery, recovered obligations, fresh alternatives, independent rejection, replacement and selective renewal", async (t) => {
	const f = await fixture(t);
	f.createUnit();
	f.createUnit("reporting", ["ledger"]);
	f.contract();
	const incumbent = f.prepare("initial", 1, "implementation");
	const first = await f.deliver(incumbent, initialCode);
	assert.equal(f.evaluate(incumbent, first, 1).run.status, 0);
	f.decide(incumbent, "accept", null);

	const discovered = spawnSync(process.execPath, ["--input-type=module", "-e", evaluator(true), first.filename], { encoding: "utf8" });
	assert.notEqual(discovered.status, 0);
	assert.match(discovered.stderr, /caller-owned input/);
	f.call("appendKnowledge", {
		id: "input-discovery", unitId: "ledger", kind: "observation",
		statement: discovered.stderr.slice(0, 7000), source: f.source(), links: [{ relation: "derived-from", target: { id: "boundary-eval", revision: 1 } }], uncertainty: null,
	});
	assert.equal(f.factory.inspect().knowledge.find((entry) => entry.id === "input-discovery")?.authority, "non-governing");
	f.contract(2);
	const bad = f.prepare("plausible-but-wrong", 2);
	const badDelivery = await f.deliver(bad, initialCode);
	const badEvaluation = f.evaluate(bad, badDelivery, 2);
	assert.equal(badEvaluation.evidence.outcome, "failed");
	assert.equal(badEvaluation.evidence.trust, "independent-claim");
	assert.throws(() => f.decide(bad, "accept", incumbent.id), { code: "factory_assurance_incomplete" });
	f.decide(bad, "reject", incumbent.id);
	assert.equal(f.factory.inspect().units.find((unit) => unit.id === "ledger")?.currentCandidateId, incumbent.id);

	const good = f.prepare("conserved-candidate", 2);
	assert.equal(good.contractDigest, bad.contractDigest);
	const generation = f.factory.generation(good.id);
	assert.ok(!JSON.stringify(generation).includes(hash(initialCode)));
	const delivery = await f.deliver(good, freshCode);
	assert.equal(f.evaluate(good, delivery, 2).run.status, 0);
	f.decide(good, "accept", incumbent.id);
	assert.deepEqual(f.factory.inspect().renewalNeeds, [], "Rejected and superseded candidates are historical evidence, not current recovery work");
	const beforeSignal = f.factory.snapshot().decisions;
	const signal = f.call("recordSignal", {
		id: "batch-workload", kind: "assumption-change", summary: "Observed batch debits change the declared single-operation workload",
		unitIds: ["ledger"], knowledgeRefs: [{ id: "balance-contract", revision: 2 }], source: f.source("operational"),
	});
	assert.deepEqual(signal.renewal.affectedUnitIds, ["ledger", "reporting"]);
	assert.equal(signal.renewal.status, "proposed");
	assert.deepEqual(f.factory.snapshot().decisions, beforeSignal);
	assert.match(f.factory.inspect({ candidateId: good.id }).candidates[0].assurance.missing.join(" "), /renewal-required/);
	assert.deepEqual(f.factory.inspect().renewalNeeds.map((entry) => entry.candidateId), [good.id]);
	const restarted = createFactoryService({ repositoryPath: f.repositoryPath, storageRoot: f.root, clock: f.clock });
	assert.deepEqual(restarted.snapshot(), f.factory.snapshot());
	assert.equal(restarted.inspect().units.find((unit) => unit.id === "ledger")?.currentCandidateId, good.id);
	assert.equal(restarted.inspect().knowledge.find((entry) => entry.id === "input-discovery")?.authority, "non-governing");
});

test("context/expiry and incomplete relationships surface missing support without rewriting historical decisions", async (t) => {
	const f = await fixture(t);
	f.createUnit();
	f.createUnit("unknown", [], "partial");
	f.contract();
	const candidate = f.prepare("candidate", 1, "implementation");
	f.evaluate(candidate, await f.deliver(candidate, freshCode), 1);
	f.decide(candidate, "accept", null);
	assert.match(f.factory.inspect({ workload: "different" }).candidates[0].assurance.missing.join(), /workload-mismatch/);
	f.advance(86401);
	assert.match(f.factory.inspect().candidates[0].assurance.missing.join(), /expired/);
	assert.equal(f.factory.snapshot().decisions.at(-1)?.kind, "accept-candidate");
	const signal = f.call("recordSignal", { id: "incident", kind: "incident", summary: "Failure", source: f.source(), unitIds: ["ledger"], knowledgeRefs: [] });
	assert.equal(signal.renewal.localization, "uncertain");
	assert.deepEqual(signal.renewal.uncertainUnitIds, ["unknown"]);
});

test("adoption discovers a contract after the implementation without inventing retrospective generation", async (t) => {
	const f = await fixture(t);
	f.createUnit();
	const filename = path.join(f.repositoryPath, "already-existing.mjs");
	await writeFile(filename, initialCode);
	f.git("add", "already-existing.mjs");
	f.git("-c", "user.name=Factory fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Original discovery");
	const commit = f.git("rev-parse", "HEAD");
	const originalSource = f.source("external-run", "original-discovery-process");
	f.call("appendKnowledge", { id: "discovered-identity", unitId: "ledger", kind: "observation", statement: "Existing behavior preserves account identity", source: f.source() });
	f.contract();
	const artifact = { kind: "implementation", ref: pathToFileURL(filename).href, digest: hash(initialCode) };
	const { candidate } = f.call("prepareCandidate", {
		id: "adopted", unitId: "ledger", contractRevision: 1, mode: "adoption", actor: "owner",
		context: { generation: [], comparisonOnly: [artifact], independence: { method: "existing-artifact", reason: "Implementation predates recovered knowledge" } },
	});
	assert.equal(f.factory.generation(candidate.id).purpose, "evaluate-existing-artifact-not-generation");
	f.call("recordDelivery", { candidateId: candidate.id, commit, artifact, source: originalSource });
	assert.equal(f.evaluate(candidate, { filename: artifact.ref, commit }, 1).run.status, 0);
	f.decide(candidate, "accept", null);
	const fresh = f.prepare("not-adoption", 1);
	assert.throws(() => f.call("recordDelivery", { candidateId: fresh.id, commit, artifact, source: originalSource }), { code: "factory_generation_predates_context" });
});

test("late old evidence cannot clear a new incident and contradictions need explicit resolution", async (t) => {
	const f = await fixture(t);
	f.createUnit();
	f.contract();
	const candidate = f.prepare("initial", 1, "implementation");
	const delivery = await f.deliver(candidate, freshCode);
	const { evidence } = f.evaluate(candidate, delivery, 1);
	f.decide(candidate, "accept", null);
	f.call("recordSignal", { id: "later-incident", kind: "incident", summary: "Changed workload observed", source: f.source("operational"), unitIds: ["ledger"] });
	const repeat = {
		id: "late-evidence", candidateId: candidate.id, evaluation: evidence.evaluation,
		contractDigest: evidence.contractDigest, contextDigest: evidence.contextDigest, commit: evidence.commit,
		procedureDigest: evidence.procedureDigest, outcome: evidence.outcome, source: evidence.source,
		environment: evidence.environment, workload: evidence.workload, independence: evidence.independence, report: evidence.report,
	};
	assert.throws(() => f.call("recordEvaluation", repeat), { code: "factory_evaluation_origin_reused" });
	assert.throws(() => f.call("recordEvaluation", { ...repeat, source: { ...repeat.source, at: f.source().at } }), { code: "factory_evaluation_origin_reused" });
	assert.match(f.factory.inspect().candidates[0].assurance.missing.join(), /renewal-required/);
	f.call("recordEvaluation", { ...repeat, id: "reevaluation", source: f.source("external-run", "fresh-reevaluation") });
	assert.equal(f.factory.inspect().candidates[0].assurance.ready, true);
	f.call("appendKnowledge", {
		id: "contradiction", unitId: "ledger", kind: "observation", statement: "The declared unit-weight workload is not universal",
		source: f.source("operational"), links: [{ relation: "contradicts", target: { id: "balance-contract", revision: 1 } }], uncertainty: "Workload coverage incomplete",
	});
	const acceptance = {
		unitId: "ledger", unitRevision: 1, obligations: [{ id: "balance-contract", revision: 1 }], evaluations: [{ id: "boundary-eval", revision: 1 }],
		actor: "owner", reason: "Conserve the bounded scope, not the untested general claim",
	};
	assert.throws(() => f.call("acceptContract", acceptance), { code: "factory_unresolved_knowledge" });
	f.call("acceptContract", { ...acceptance, resolutions: [{ knowledge: { id: "contradiction", revision: 1 }, reason: "Retain the single-debit workload explicitly; other workloads need separate evaluation" }] });
	const acceptanceDecision = must(f.factory.snapshot().decisions.at(-1));
	assert.ok(acceptanceDecision.kind === "accept-contract");
	assert.equal(acceptanceDecision.resolutions[0].knowledge.id, "contradiction");
});

test("known generation origins cannot masquerade as fresh sessions or processes, while exact delivery replay is idempotent", async (t) => {
	for (const method of ["fresh-session", "fresh-process"]) {
		const f = await fixture(t);
		f.createUnit();
		f.contract();
		/** @param {string} id */
		const prepare = (id) => f.call("prepareCandidate", {
			id, unitId: "ledger", contractRevision: 1, actor: "producer",
			context: { generation: [], comparisonOnly: [], independence: { method, reason: "A new generation origin is required" } },
		}).candidate;
		const first = prepare("first");
		const origin = {
			...f.source("external-run", "original-process"),
			...(method === "fresh-session" ? { sessionId: "original-session" } : {}),
		};
		const payload = {
			candidateId: first.id, commit: "a".repeat(40),
			artifact: { kind: "implementation", ref: "fixture:delivered", digest: hash(freshCode) }, source: origin
		};
		f.call("recordDelivery", payload);
		const revision = f.factory.snapshot().revision;
		assert.equal(f.call("recordDelivery", payload).idempotent, true);
		assert.equal(f.factory.snapshot().revision, revision);
		const second = prepare("second");
		assert.throws(() => f.call("recordDelivery", {
			...payload, candidateId: second.id, source: { ...origin, at: f.source().at },
		}), { code: "factory_generation_origin_reused" });
	}
});
