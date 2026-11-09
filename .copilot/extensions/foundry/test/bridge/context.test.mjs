import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVerificationInput } from "../../analysis/verification.mjs";
import { run as runPlan } from "../../workflows/plan.mjs";
import { must } from "../assertions.mjs";
import { fixture } from "./fixture.mjs";

test("pinned governing context reaches all planning stages and conceptual proposals remain non-governing", async (t) => {
	const f = await fixture(t);
	const prepared = await f.ops.preparePlan({ repositoryPath: f.repo, unitId: "unit", intent: "discovery", objective: "Explore a bounded improvement", repositoryContext: "Untrusted fixture context" });
	/** @type {Array<{label: string, prompt: string}>} */
	const prompts = [];
	const blueprint = {
		title: "Discovery", tasks: [
			{ id: "T-001", title: "Explore", kind: "implement", description: "Explore without changing authority", dependsOn: [], acceptanceCriteria: ["Report findings"], expectedFiles: [], deliveryRequirement: "commit" },
			{ id: "T-002", title: "Verify", kind: "verify", description: "Verify findings", dependsOn: ["T-001"], acceptanceCriteria: [], expectedFiles: [], deliveryRequirement: "commit" },
		]
	};
	const proposal = "Simplification proposal: share one internal identity resolver; conserve obligation@1 and oracle@1; changing external identity needs explicit human acceptance.";
	await runPlan({
		args: prepared.launchSpec.args, phase() { },
		parallel: (tasks) => Promise.all(tasks.map((task) => task())),
		agent: async (prompt, { label } = {}) => {
			assert.ok(label);
			prompts.push({ label, prompt });
			if (label.includes("critic")) return { verdict: "accept", risks: [proposal], requiredChanges: [] };
			if (label === "plan:verifier") return { passed: true, issues: [] };
			return blueprint;
		},
	});
	for (const { prompt } of prompts) assert.match(prompt, /Caller-owned input is immutable/);
	let plan = await f.verify(f.ops, await f.implement(await f.generationPlan()));
	const before = f.factory.snapshot().contracts[0].digest;
	({ plan } = await f.finish(f.ops, plan, { proposal }));
	const learned = f.factory.inspect().knowledge.find((entry) => entry.statement === proposal);
	assert.ok(learned);
	assert.equal(learned.kind, "proposal");
	assert.equal(learned.authority, "non-governing");
	assert.deepEqual(learned.links, [{ relation: "depends-on", target: { id: "obligation", revision: 1 } }]);
	assert.equal(f.factory.snapshot().contracts[0].digest, before);
	assert.deepEqual(plan.verification.conceptualReview?.proposals, [proposal]);
});

test("a reserved verification keeps its pinned definitions despite later accepted knowledge", async (t) => {
	const f = await fixture(t);
	let plan = await f.verify(f.ops, await f.implement(await f.generationPlan()));
	const prepared = await f.ops.prepareVerification({ planId: plan.id, expectedRevision: plan.revision, reservationId: "frozen-verification" });
	plan = prepared.plan;
	const original = must(prepared.launchSpec).args;
	f.mutate("acceptContract", {
		unitId: "unit", unitRevision: 1, obligations: [{ id: "obligation", revision: 1 }], evaluations: [{ id: "oracle", revision: 1 }],
		actor: "owner", reason: "A later decision must not be substituted into the already reserved input"
	});
	const repeated = await f.ops.prepareVerification({ planId: plan.id, expectedRevision: plan.revision, reservationId: "frozen-verification" });
	assert.deepEqual(must(repeated.launchSpec).args, original);
	const normalized = normalizeVerificationInput(original);
	const definitions = must(must(normalized.factory).context).definitions;
	assert.equal(definitions.obligations[0].statement, "Caller-owned input is immutable");
	assert.notEqual(must(definitions.contract).digest, must(f.factory.snapshot().contracts.at(-1)).digest);
	const malformed = structuredClone(normalized);
	// @ts-expect-error Null is deliberately not a knowledge reference.
	must(must(malformed.factory).context).definitions.evaluations[0].evaluation.obligations = [null];
	assert.throws(() => normalizeVerificationInput(malformed), { name: "FoundryAnalysisError", code: "invalid_analysis_input" });
});
