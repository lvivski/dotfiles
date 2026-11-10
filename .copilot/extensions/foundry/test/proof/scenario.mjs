import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { arrayOf, parseJson, readNumber, readString, recordOf } from "../../data.mjs";
import { initialContract, reconstructionContract } from "./contracts.mjs";
import { evaluate, readSchedule } from "./evaluators/policy.mjs";
import { digest } from "./lab.mjs";

/** @typedef {ReturnType<typeof import("../../factory.mjs").createFactoryService>} Factory */
/** @typedef {Awaited<ReturnType<typeof import("./lab.mjs").createLab>>} Lab */
/** @typedef {Awaited<ReturnType<Lab["commitArtifact"]>>} ArtifactDelivery */

/** @param {string} name */
const sourceFile = (name) => readFile(new URL(`./${name}.mjs`, import.meta.url), "utf8");
/** @param {Factory} service */
const revision = (service) => service.snapshot().revision;
/** @param {import("../../types/factory.js").KnowledgeRef} record */
const ref = (record) => ({ id: record.id, revision: record.revision });
/** @param {string} reference */
const source = (reference) => ({
	kind: "discovery", ref: reference, actor: "fixture-steward", at: new Date().toISOString(),
});

/** @param {Factory} service @param {string} id @param {string} kind @param {string} statement @param {Record<string, unknown>} [extras] */
export function append(service, id, kind, statement, extras = {}) {
	return service.appendKnowledge({
		expectedRevision: revision(service), id, unitId: "admission-policy", kind, statement,
		source: source(`proof:${id}`), links: [], uncertainty: null, ...extras,
	}).knowledge;
}

/** @param {Factory} service @param {string} candidateId @param {{conservation?: boolean}} [options] */
export async function recordAssertions(service, candidateId, { conservation = true } = {}) {
	const candidate = service.snapshot().candidates.find((entry) => entry.id === candidateId);
	assert.ok(candidate?.delivery);
	const bytes = await readFile(candidate.delivery.artifact.ref);
	assert.equal(digest(bytes), candidate.delivery.artifact.digest);
	const run = spawnSync(process.execPath, [path.join(path.dirname(candidate.delivery.artifact.ref), "evaluators/check.mjs"), candidate.delivery.artifact.ref],
		{ encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
	if (run.error) throw run.error;
	assert.equal(run.status, 0, run.stderr);
	const observed = recordOf({
		processId: readNumber, observedAt: readString,
		receipts: arrayOf(recordOf({ evaluationId: readString, outcome: readString, detail: readString })),
	})(parseJson(run.stdout));
	assert.equal(observed.processId, run.pid);
	assert.notEqual(observed.processId, process.pid);
	const receipts = observed.receipts.filter((entry) => conservation || entry.evaluationId !== "input-conservation");
	const definitions = service.generation(candidateId).evaluations;
	for (const receipt of receipts) {
		const definition = definitions.find((entry) => entry.id === `evaluate-${receipt.evaluationId}`);
		assert.ok(definition);
		service.recordEvaluation({
		expectedRevision: revision(service),
		id: `${candidateId}-${receipt.evaluationId}`,
		candidateId,
		evaluation: { id: `evaluate-${receipt.evaluationId}`, revision: 1 },
		contractDigest: candidate.contractDigest,
		contextDigest: candidate.contextDigest,
		commit: candidate.delivery.commit,
		procedureDigest: definition.evaluation.procedure.digest,
		outcome: receipt.outcome,
		source: {
			kind: "external-run", ref: `fixture Node evaluator, process ${observed.processId}`,
			actor: "proof-evaluator", at: observed.observedAt,
			runId: `node-evaluation-${observed.processId}-${observed.observedAt}`, owner: `node-evaluator-process-${observed.processId}`,
		},
		environment: `node/${process.version}`,
		workload: "unit-weight",
		independence: { method: "separate-process", reason: "Actual artifact evaluated independently of its original generation origin." },
		report: JSON.stringify(receipt),
	});
	}
	return receipts;
}

/** @param {Factory} service @param {string} id @param {{revision: number}} contract
 * @param {ArtifactDelivery & {source: {kind: string, ref: string, actor: string, at: string, runId: string, owner: string, sessionId?: string}}} delivery
 * @param {ArtifactDelivery["artifact"][]} [comparisonOnly] */
export function adopt(service, id, contract, delivery, comparisonOnly = [delivery.artifact]) {
	const prepared = service.prepareCandidate({
		expectedRevision: revision(service), id, unitId: "admission-policy", contractRevision: contract.revision,
		mode: "adoption", actor: "fixture-steward",
		context: {
			generation: [], comparisonOnly,
			independence: { method: "existing-artifact", reason: "Existing artifact is evaluated after knowledge recovery; fresh generation is not claimed." },
		},
	});
	service.recordDelivery({ expectedRevision: revision(service), candidateId: id, ...delivery });
	return prepared.candidate;
}

/**
 * Prepare a generation package; this fixture does not run reconstruction.
 * @param {Awaited<ReturnType<typeof import("./lab.mjs").createLab>>} lab
 * @param {{alternativeSource?: {kind: string, ref: string, actor: string, at: string, runId: string, owner: string, sessionId?: string}}} [options]
 */
export async function seedReconstruction(lab, { alternativeSource } = {}) {
	await lab.commitArtifact("evaluators/policy.mjs", await sourceFile("evaluators/policy"));
	const evaluator = await lab.commitArtifact("evaluators/check.mjs", await sourceFile("evaluators/check"));
	const initial = await lab.commitArtifact("initial-policy.mjs", await sourceFile("policies/initial"));
	const alternative = await lab.commitArtifact("recorded-alternative.mjs", await sourceFile("policies/alternative"));
	/** @param {ArtifactDelivery} delivery */
	const existingSource = (delivery) => ({
		kind: "external-run", ref: `existing fixture commit ${delivery.commit}`,
		actor: "fixture-artifact-preparer", at: new Date(lab.git(["show", "-s", "--format=%cI", delivery.commit])).toISOString(),
		runId: `fixture-origin-${delivery.commit}`, owner: `fixture-origin-${delivery.commit}`,
	});
	const service = lab.service();
	service.createUnit({
		expectedRevision: 0, id: "admission-policy", name: initialContract.title, purpose: initialContract.intent,
		boundary: {
			owns: ["admission-decisions"], exposes: [JSON.stringify(initialContract.interface)],
			consumes: ["task-state"], preserves: ["Logical resource ownership and dependency meaning"],
		},
		dependencies: [], relationshipCoverage: "complete", actor: "fixture-steward",
	});
	const obligations = initialContract.obligations.map(([id, statement]) => ref(append(service, id, "obligation", statement)));
	const capacity = obligations.find((entry) => entry.id === "capacity");
	assert.ok(capacity);
	const assumption = append(service, "unit-weight-assumption", "inference", initialContract.assumptions[0], {
		uncertainty: "Only the initial unit-weight workload was observed.",
		links: [{ relation: "derived-from", target: capacity }],
	});
	/** @param {import("../../types/factory.js").KnowledgeRef} obligation @param {boolean} preservation */
	const addEvaluation = (obligation, preservation) => ref(append(
		service, `evaluate-${obligation.id}`, "evaluation", `Execute the independent ${obligation.id} boundary assertions.`,
		{
			evaluation: {
				modality: "boundary",
				procedure: {
					kind: "command", ref: `git:${evaluator.commit}:evaluators/check.mjs#${obligation.id}`,
					bundle: {
						version: 1, commit: evaluator.commit, root: "evaluators", entryPoint: "evaluators/check.mjs", support: [],
						invocation: { argv: ["node", "evaluators/check.mjs", "{candidate}"], cwd: "." },
					},
				},
				obligations: [obligation], environment: `node/${process.version}`, workload: "unit-weight",
				maxAgeSeconds: 86400, independent: true, preservation,
			},
		},
	));
	const evaluations = obligations.map((entry) => addEvaluation(entry, entry.id === "logical-ownership"));
	const contract1 = service.acceptContract({
		expectedRevision: revision(service), unitId: "admission-policy", unitRevision: 1,
		obligations, evaluations, rationale: [ref(assumption)], resolutions: [],
		actor: "fixture-steward", reason: "Accept the explicitly limited recovered baseline contract.",
	}).contract;
	adopt(service, "baseline", contract1, { ...initial, source: existingSource(initial) });
	assert.ok((await recordAssertions(service, "baseline", { conservation: false }))
		.every((entry) => entry.outcome === "passed"));
	service.decideCandidate({
		expectedRevision: revision(service), candidateId: "baseline", action: "accept", expectedIncumbentId: null,
		actor: "fixture-steward", reason: "Adopt existing software; this decision does not claim reconstruction.",
	});
	const baseline = readSchedule(await import(pathToFileURL(initial.artifact.ref).href));
	const failure = evaluate(baseline).find((entry) => entry.evaluationId === "input-conservation");
	assert.ok(failure);
	assert.equal(failure.outcome, "failed");
	const observation = append(service, "input-order-observation", "observation",
		"Actual execution changes caller-owned task-array order; the functional contract did not capture this conservation requirement.");
	const definition = reconstructionContract.obligations.find(([id]) => id === "input-conservation");
	assert.ok(definition);
	const conservation = ref(append(service, "input-conservation", "obligation", definition[1], {
		links: [{ relation: "derived-from", target: ref(observation) }],
	}));
	const conservationEvaluation = addEvaluation(conservation, true);
	const contract2 = service.acceptContract({
		expectedRevision: revision(service), unitId: "admission-policy", unitRevision: 1,
		obligations: [...obligations, conservation], evaluations: [...evaluations, conservationEvaluation],
		rationale: [ref(assumption), ref(observation)], resolutions: [],
		actor: "fixture-steward", reason: "Explicitly accept input conservation; the observation was not automatically authoritative.",
	}).contract;
	adopt(service, "baseline-reconsidered", contract2, { ...initial, source: existingSource(initial) });
	const failed = await recordAssertions(service, "baseline-reconsidered");
	assert.deepEqual(failed.filter((entry) => entry.outcome === "failed").map((entry) => entry.evaluationId), ["input-conservation"]);
	assert.throws(() => service.decideCandidate({
		expectedRevision: revision(service), candidateId: "baseline-reconsidered", action: "accept", expectedIncumbentId: "baseline",
		actor: "fixture-steward", reason: "A real failed conservation check must block acceptance.",
	}), { code: "factory_assurance_incomplete" });
	service.decideCandidate({
		expectedRevision: revision(service), candidateId: "baseline-reconsidered", action: "reject", expectedIncumbentId: "baseline",
		actor: "fixture-steward", reason: "Plausible functional results do not meet the accepted conservation obligation.",
	});
	adopt(service, "recorded-alternative", contract2, { ...alternative, source: alternativeSource ?? existingSource(alternative) },
		[initial.artifact, alternative.artifact]);
	assert.ok((await recordAssertions(service, "recorded-alternative")).every((entry) => entry.outcome === "passed"));
	const prepared = service.prepareCandidate({
		expectedRevision: revision(service), id: "fresh-reconstruction", unitId: "admission-policy", contractRevision: contract2.revision,
		mode: "reconstruction", actor: "fixture-steward",
		context: {
			generation: [{ kind: "schema", ref: "proof:admission-interface", digest: digest(JSON.stringify(initialContract.interface)) }],
			comparisonOnly: [initial.artifact, alternative.artifact],
			independence: { method: "fresh-session", reason: "A new chat will receive only the accepted generation package, not original or alternative implementation interiors." },
		},
	});
	const generation = service.generation(prepared.candidate.id);
	assert.equal(generation.sealVersion, 3);
	for (const artifact of [initial.artifact, alternative.artifact]) {
		assert.ok(!JSON.stringify(generation).includes(artifact.ref));
		assert.ok(!JSON.stringify(generation).includes(artifact.digest));
	}
	await writeFile(path.join(lab.directory, "generation-final.json"), JSON.stringify(generation, null, 2));
	await writeFile(path.join(lab.directory, "proof-manifest.json"), JSON.stringify({
		initial, alternative, evaluator, contract1, contract2, candidateId: prepared.candidate.id,
		contextDigest: prepared.candidate.contextDigest,
	}, null, 2));
	return { service, generation, prepared, contract2, initial, alternative, evaluator };
}
