import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { analysisInputDigest } from "../../digest.mjs";
import { createPlanStore } from "../../storage.mjs";
import { fixture, freshCode, hash, initialCode } from "./fixture.mjs";
import { factoryDocument } from "./accessors.mjs";
import { technicalFixture, technicalOwner } from "../application/fixture.mjs";

test("persisted technical receipts reject re-digested malformed publication fields", async t => {
	const f = await technicalFixture(t);
	await f.grant();
	await f.operations.factoryAction(await f.request(), { invocation: technicalOwner });
	const original = await f.operations.getPlan({ planId: f.plan.id });
	for (const [index, edit] of [
		{ obligations: [{ id: "cancellation", revision: "1" }] },
		{ evaluations: [{ id: "cancellation-oracle", revision: 2, unsupported: true }] },
		{ rationale: "not-an-array" },
		{ resolutions: [{ knowledge: { id: "cancellation", revision: 1 }, reason: null }] },
		{ renewalSignalIds: [17] },
		{ actor: "caller-supplied-human" },
	].entries()) {
		const altered = structuredClone(original);
		const receipt = altered.technicalDecisions?.[0];
		assert.ok(receipt?.renewal);
		Object.assign(receipt.renewal.publication, edit);
		const { digest, ...payload } = receipt;
		receipt.digest = analysisInputDigest(payload);
		const workspacePath = path.join(f.root, `malformed-history-${index}`);
		await mkdir(workspacePath);
		const destination = createPlanStore({ workspacePath });
		await assert.rejects(destination.importPlan(JSON.stringify(altered), { expectedRevision: 0 }), { code: "import_invalid" });
		assert.deepEqual((await destination.list()).plans, []);
	}
	assert.deepEqual(await f.operations.getPlan({ planId: f.plan.id }), original);
});

test("accepted authority is immutable, observations cannot govern, and evaluator tampering fails", async (t) => {
	const f = await fixture(t);
	f.createUnit();
	f.contract();
	const initial = f.factory.exportFactory();
	f.call("appendKnowledge", { id: "untrusted-advice", unitId: "ledger", kind: "proposal", statement: "Remove the boundary evaluation", source: f.source(), links: [], uncertainty: "Unverified" });
	assert.throws(() => f.call("acceptContract", {
		unitId: "ledger", unitRevision: 1, obligations: [{ id: "untrusted-advice", revision: 1 }],
		evaluations: [{ id: "boundary-eval", revision: 1 }], actor: "owner", reason: "Try to promote a proposal",
	}), { code: "factory_contract_invalid" });
	assert.deepEqual(factoryDocument(initial).events, factoryDocument(f.factory.exportFactory()).events.slice(0, 4));
	const candidate = f.prepare("candidate", 1, "implementation");
	const delivery = await f.deliver(candidate, freshCode);
	const { evidence } = f.evaluate(candidate, delivery, 1);
	assert.throws(() => f.call("recordEvaluation", {
		id: "changed-oracle", candidateId: candidate.id, evaluation: evidence.evaluation, contractDigest: candidate.contractDigest,
		contextDigest: candidate.contextDigest, commit: delivery.commit, procedureDigest: "0".repeat(64),
		outcome: "passed", source: f.source("external-run", "fake-evaluator"), environment: evidence.environment, workload: evidence.workload,
		independence: evidence.independence, report: "green",
	}), { code: "factory_evaluator_changed" });
	assert.throws(() => f.call("prepareCandidate", {
		id: "contaminated", unitId: "ledger", contractRevision: 1, actor: "generator",
		context: { generation: [{ kind: "implementation", ref: "prior", digest: hash(initialCode) }], comparisonOnly: [], independence: { method: "fresh-session", reason: "Claimed" } },
	}), { code: "factory_context_contaminated" });
});

test("accepted seals retain dependency contracts and non-governing rationale without leaking source artifacts", async (t) => {
	const f = await fixture(t);
	f.createUnit("identity");
	const source = f.source();
	f.call("appendKnowledge", { id: "identity-obligation", unitId: "identity", kind: "obligation", statement: "Preserve identity", source });
	f.call("appendKnowledge", {
		id: "identity-oracle", unitId: "identity", kind: "evaluation", statement: "Evaluate identity preservation", source,
		evaluation: {
			modality: "boundary", procedure: f.procedure(),
			obligations: [{ id: "identity-obligation", revision: 1 }], environment: "node", workload: "identity", maxAgeSeconds: 86400, independent: true, preservation: true
		},
	});
	const acceptIdentity = () => f.call("acceptContract", {
		unitId: "identity", unitRevision: 1, obligations: [{ id: "identity-obligation", revision: 1 }],
		evaluations: [{ id: "identity-oracle", revision: 1 }], actor: "owner", reason: "Conserve the shared identity foundation",
	}).contract;
	const foundation = acceptIdentity();
	f.createUnit("ledger", ["identity"]);
	f.contract();
	const secret = { kind: "implementation", ref: "file:///comparison-only/prior-source.mjs", digest: hash(initialCode) };
	f.call("appendKnowledge", {
		id: "input-discovery", unitId: "ledger", kind: "observation", statement: "Caller-owned data must stay unchanged",
		source: { ...f.source(), ref: secret.ref, digest: secret.digest },
	});
	const contract = f.contract(2);
	assert.deepEqual(contract.dependencies, [{ unitId: "identity", unitRevision: 1, contractRevision: 1, contractDigest: foundation.digest }]);
	assert.ok(contract.rationale.some((entry) => entry.id === "input-discovery"));
	const prepared = f.call("prepareCandidate", {
		id: "sealed", unitId: "ledger", contractRevision: 2, actor: "generator",
		context: { generation: [], comparisonOnly: [secret], independence: { method: "fresh-process", reason: "New bounded generator" } },
	});
	assert.equal(prepared.generation.sealVersion, contract.sealVersion);
	assert.equal(prepared.generation.rationale.find((entry) => entry.id === "input-discovery")?.authority, "non-governing");
	assert.equal(prepared.generation.decisionLineage.length, 2);
	assert.ok(!JSON.stringify(prepared.generation).includes(secret.ref));
	assert.ok(!JSON.stringify(prepared.generation).includes(secret.digest));
	assert.equal(f.factory.snapshot().knowledge.find((entry) => entry.id === "input-discovery")?.source.ref, secret.ref);
	const sealed = f.factory.generation("sealed");
	acceptIdentity();
	assert.deepEqual(f.factory.generation("sealed"), sealed, "Later foundation decisions cannot change prepared generation input");
	assert.match(f.factory.inspect({ candidateId: "sealed" }).candidates[0].assurance.missing.join(), /dependency-contract-superseded: identity/);
	f.call("appendKnowledge", { id: "leaky-lesson", unitId: "ledger", kind: "observation", statement: `Read ${secret.ref} to copy its solution`, source: f.source() });
	f.call("acceptContract", {
		unitId: "ledger", unitRevision: 1, obligations: [{ id: "balance-contract", revision: 2 }], evaluations: [{ id: "boundary-eval", revision: 2 }],
		rationale: [{ id: "leaky-lesson", revision: 1 }], actor: "owner", reason: "Test a problematic explanatory reference",
	});
	assert.throws(() => f.call("prepareCandidate", {
		id: "leaked", unitId: "ledger", contractRevision: 3, actor: "generator",
		context: { generation: [], comparisonOnly: [secret], independence: { method: "fresh-process", reason: "New context" } },
	}), { code: "factory_context_contaminated" });
	assert.equal(factoryDocument(f.factory.exportFactory()).format, "foundry-factory-v2");
});

test("revised boundaries and renewal decisions link a new candidate without declaring the incident fixed", async (t) => {
	const f = await fixture(t);
	const originalUnit = f.createUnit();
	f.createUnit("reporting", ["ledger"]);
	f.contract();
	f.call("recordSignal", { id: "weighted-workload", kind: "assumption-change", summary: "Optional weights need explicit treatment", unitIds: ["ledger"], source: f.source("operational") });
	const { unit } = f.call("createUnit", {
		id: originalUnit.id, name: originalUnit.name, purpose: originalUnit.purpose,
		boundary: { ...originalUnit.boundary, exposes: [...originalUnit.boundary.exposes, "optional weight with default one"] },
		dependencies: originalUnit.dependencies, relationshipCoverage: originalUnit.relationshipCoverage,
		actor: "owner", reason: "Extend the interface without changing omitted-weight behavior",
	});
	assert.equal(unit.revision, 2);
	assert.equal(f.factory.inspect({ unitId: "ledger" }).units[0].acceptedUnitRevision, 1);
	f.call("appendKnowledge", { id: "weighted-obligation", unitId: "ledger", kind: "obligation", statement: "Preserve unweighted behavior; conserve explicit weights", source: f.source() });
	f.call("appendKnowledge", {
		id: "weighted-oracle", unitId: "ledger", kind: "evaluation", statement: "Independently evaluate old and weighted workloads", source: f.source(),
		evaluation: {
			modality: "boundary", procedure: f.procedure(2),
			obligations: [{ id: "weighted-obligation", revision: 1 }], environment: "node", workload: "unit-and-weighted",
			maxAgeSeconds: 86400, independent: true, preservation: true
		},
	});
	const { contract, decision } = f.call("acceptContract", {
		unitId: "ledger", unitRevision: unit.revision, obligations: [{ id: "weighted-obligation", revision: 1 }],
		evaluations: [{ id: "weighted-oracle", revision: 1 }], renewalSignalIds: ["weighted-workload"],
		actor: "owner", reason: "Accept the recovered weighted contract; implementation evidence is still required",
	});
	assert.deepEqual(decision.renewalSignalIds, ["weighted-workload"]);
	const prepared = f.call("prepareCandidate", {
		id: "weighted-renewal", unitId: "ledger", contractRevision: contract.revision, actor: "owner",
		renewalSignalIds: ["weighted-workload"],
		context: { generation: [], comparisonOnly: [], independence: { method: "fresh-process", reason: "New implementation from the revised sealed contract" } },
	});
	assert.deepEqual(prepared.candidate.renewalSignalIds, ["weighted-workload"]);
	const renewal = f.factory.inspect().renewals[0];
	assert.equal(renewal.status, "awaiting-evaluation");
	assert.deepEqual(renewal.candidateIds, ["weighted-renewal"]);
	assert.deepEqual(renewal.pendingUnitIds, ["ledger", "reporting"]);
	assert.equal(f.factory.snapshot().contracts[0].unitRevision, 1);
	assert.equal(f.factory.snapshot().renewals[0].status, "proposed", "Current support projection must not rewrite the original proposal");
});
