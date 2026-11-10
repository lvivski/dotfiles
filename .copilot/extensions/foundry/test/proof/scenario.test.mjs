import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createFactoryService } from "../../factory.mjs";
import { createAdmissionApi } from "./api.mjs";
import { evaluateApi } from "./evaluators/api.mjs";
import { evaluate } from "./evaluators/policy.mjs";
import { evaluateWeighted } from "./evaluators/weighted.mjs";
import { createLab } from "./lab.mjs";
import * as recordedAlternative from "./policies/alternative.mjs";
import * as initialPolicy from "./policies/initial.mjs";
import * as reconstructedPolicy from "./policies/reconstructed.mjs";
import * as weightedPolicy from "./policies/weighted.mjs";
import { seedReconstruction } from "./scenario.mjs";

const policies = { "recorded-alternative": recordedAlternative, "reconstructed-policy": reconstructedPolicy };

test("functional success cannot substitute for a learned conservation obligation", async () => {
	const { schedule } = initialPolicy;
	assert.ok(evaluate(schedule, { conservation: false }).every((entry) => entry.outcome === "passed"));
	assert.deepEqual(
		evaluate(schedule).filter((entry) => entry.outcome === "failed").map((entry) => entry.evaluationId),
		["input-conservation"],
	);
});

for (const name of /** @type {const} */ (["recorded-alternative", "reconstructed-policy"])) test(`prewritten ${name} fixture meets the recovered boundary contract`, async () => {
	const { schedule } = policies[name];
	const evidence = evaluate(schedule);
	assert.equal(evidence.length, 6);
	assert.deepEqual(evidence.filter((entry) => entry.outcome !== "passed"), []);
});

test("the prewritten weighted fixture preserves old behavior and satisfies the changed workload", async () => {
	const { schedule } = weightedPolicy;
	assert.deepEqual(evaluate(schedule).filter((entry) => entry.outcome !== "passed"), []);
	assert.equal(evaluateWeighted(schedule).outcome, "passed");
});

test("the unchanged dependent conserves authority while composing with the renewed policy", async () => {
	const policy = weightedPolicy;
	assert.equal(evaluateApi(createAdmissionApi).outcome, "passed");
	const api = createAdmissionApi(policy);
	assert.deepEqual(evaluate(api.schedule.bind(api)).filter((entry) => entry.outcome !== "passed"), []);
	assert.equal(evaluateWeighted(api.schedule.bind(api)).outcome, "passed");
});

test("new workload evidence reveals a renewal need without falsifying historical checks", async () => {
	const { schedule } = recordedAlternative;
	const historical = evaluate(schedule);
	assert.ok(historical.every((entry) => entry.outcome === "passed"));
	assert.equal(evaluateWeighted(schedule).outcome, "failed");
	assert.ok(historical.every((entry) => entry.outcome === "passed"));
});

test("real artifact failures drive explicit knowledge acceptance and restorable sealed context", async (t) => {
	const lab = await createLab();
	t.after(() => rm(lab.directory, { recursive: true, force: true }));
	const { service, generation, prepared } = await seedReconstruction(lab);
	assert.equal(generation.sealVersion, 3);
	assert.equal(prepared.candidate.delivery, null);
	assert.equal(prepared.candidate.context.independence.method, "fresh-session");
	assert.ok(generation.rationale.every((entry) => entry.authority === "non-governing"));
	const rejected = service.snapshot().decisions.find((entry) =>
		entry.kind === "reject-candidate" && entry.candidateId === "baseline-reconsidered");
	assert.ok(rejected);
	const exported = service.exportFactory();
	const storageRoot = path.join(lab.directory, "restored");
	await mkdir(storageRoot);
	const restored = createFactoryService({ repositoryPath: lab.repositoryPath, storageRoot });
	const result = restored.importFactory({ source: exported, expectedRevision: 0 });
	assert.equal(result.executionOwnership, "not-transferred");
	assert.deepEqual(restored.generation(prepared.candidate.id), generation);
	assert.equal(restored.exportFactory(), exported);
});
