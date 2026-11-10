import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkEvaluator, resolveEvaluatorBundle } from "../../evidence/bundles.mjs";
import { candidateAssurance } from "../../factory/assurance.mjs";
import { applyEvent } from "../../factory/replay.mjs";
import { must } from "../assertions.mjs";
import { fixture, source } from "../bridge/fixture.mjs";
import { legacyV2ReceiptHistory } from "../factory/legacy.mjs";
import { BUNDLE, COMMIT, DIGEST, PROCEDURE, git } from "../git.mjs";

/** @param {Awaited<ReturnType<typeof fixture>>} f @param {string} [commit] */
const deliver = (f, commit = COMMIT) => f.mutate("recordDelivery", {
	candidateId: f.candidate.id, commit, artifact: { kind: "implementation", ref: `git:${commit}:implementation.mjs`, digest: DIGEST },
	source: { ...source(), kind: "external-run", owner: "fixture", runId: "producer", sessionId: "producer", actor: "producer" },
});

/** @param {Awaited<ReturnType<typeof fixture>>} f @param {string} [commit] */
const receipt = (f, commit = COMMIT) => ({
	id: "checked-evaluation", candidateId: f.candidate.id, evaluation: { id: "oracle", revision: 1 },
	contractDigest: f.candidate.contractDigest, contextDigest: f.candidate.contextDigest, commit,
	procedureDigest: DIGEST, outcome: "passed", source: { ...source(), kind: "external-run", owner: "fixture", runId: "verifier", actor: "verifier" },
	environment: "fixture-node", workload: "fixture-workload",
	independence: { method: "separate-process", reason: "A distinct process is a provenance claim, not attestation" }, report: "Protected assertions passed",
});

/** @param {string} repo @param {string} filename @param {string} contents */
async function change(repo, filename, contents) {
	await writeFile(path.join(repo, filename), contents);
	git(repo, "add", "--", filename);
	git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Candidate change");
	return git(repo, "rev-parse", "HEAD");
}

test("accepted executable digests are computed from Git material and invocation, never caller assertions", async (t) => {
	const f = await fixture(t);
	const actual = resolveEvaluatorBundle(f.repo, BUNDLE);
	assert.equal(actual.digest, DIGEST);
	assert.deepEqual(actual.files.map((file) => file.path), ["evaluators/check.mjs", "evaluators/fixture.json", "evaluators/helper.mjs", "package-lock.json", "package.json"]);
	const definition = f.factory.generation(f.candidate.id).evaluations[0].evaluation;
	const { digest: _digest, ...procedure } = PROCEDURE;
	const appended = f.mutate("appendKnowledge", {
		id: "computed", unitId: "unit", kind: "evaluation", statement: "Computed protected evaluator", source: source(),
		evaluation: { ...definition, procedure },
	});
	assert.equal(appended.knowledge.evaluation?.procedure.digest, DIGEST);
	assert.throws(() => f.mutate("appendKnowledge", {
		id: "forged", unitId: "unit", kind: "evaluation", statement: "Do not trust a digest", source: source(),
		evaluation: { ...definition, procedure: { ...PROCEDURE, digest: "f".repeat(64) } },
	}), { code: "factory_evaluator_changed" });
	deliver(f);
	assert.throws(() => f.mutate("recordEvaluation", { ...receipt(f), identity: checkEvaluator(f.repo, definition, COMMIT) }), { code: "factory_evaluator_identity_reserved" });
	const run = spawnSync(process.execPath, BUNDLE.invocation.argv.slice(1), { cwd: f.repo, encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	const requested = receipt(f);
	const accepted = f.mutate("recordEvaluation", requested).evidence;
	assert.deepEqual(accepted.identity, { version: 1, method: "protected-git-bundle", digest: DIGEST, evaluatorCommit: COMMIT, candidateCommit: COMMIT });
	assert.equal(accepted.trust, "independent-claim");
	assert.deepEqual(accepted.source, requested.source, "Identity checks must not manufacture process provenance");
});

test("weakening entry points, helpers, fixtures or dependency material cannot pass by echoing the original digest", async (t) => {
	for (const [filename, contents] of [
		["evaluators/check.mjs", "process.exit(0);\n"],
		["evaluators/helper.mjs", "export const check = () => true;\n"],
		["evaluators/fixture.json", "{\"ids\":[]}\n"],
		["package-lock.json", "{\"lockfileVersion\":3,\"packages\":{\"weakened\":{}}}\n"],
		["package.json", "{\"type\":\"module\",\"scripts\":{\"test\":\"true\"}}\n"],
	]) await t.test(filename, async (t) => {
		const f = await fixture(t);
		const commit = await change(f.repo, filename, contents);
		deliver(f, commit);
		assert.throws(() => f.mutate("recordEvaluation", receipt(f, commit)), { code: "factory_evaluator_changed" });
		assert.equal(f.factory.snapshot().candidates[0].evidence.length, 0);
	});
});

test("native completion uses the same protected-bundle guard and leaves rejected reports retryable", async (t) => {
	const f = await fixture(t);
	const commit = await change(f.repo, "evaluators/helper.mjs", "export const check = () => true;\n");
	let plan = await f.implement(await f.generationPlan(), { commit });
	plan = await f.attach(f.ops, plan, "T-002");
	await assert.rejects(f.ops.completeTask(f.payload(plan, "T-002", { commit })), { code: "factory_evaluator_changed" });
	assert.equal((await f.ops.getPlan({ planId: plan.id })).revision, plan.revision);
	assert.equal(f.factory.snapshot().candidates[0].evidence.length, 0);
	assert.ok(f.factory.inspect().knowledge.some((entry) => entry.id.startsWith("rejected-") && entry.authority === "non-governing"));
});

test("invocation changes, missing support declarations and missing artifacts are distinct failures", async (t) => {
	const f = await fixture(t);
	const definition = f.factory.generation(f.candidate.id).evaluations[0].evaluation;
	const changed = { ...PROCEDURE, bundle: { ...BUNDLE, invocation: { argv: ["node", "--no-warnings", "evaluators/check.mjs"], cwd: "." } } };
	assert.throws(() => f.mutate("appendKnowledge", {
		id: "changed-invocation", unitId: "unit", kind: "evaluation", statement: "Invocation change needs new identity", source: source(),
		evaluation: { ...definition, procedure: changed },
	}), { code: "factory_evaluator_changed" });
	assert.notEqual(resolveEvaluatorBundle(f.repo, changed.bundle).digest, DIGEST);
	assert.throws(() => resolveEvaluatorBundle(f.repo, { ...BUNDLE, support: [] }), { code: "factory_evaluator_dependency_missing" });
	assert.throws(() => resolveEvaluatorBundle(f.repo, { ...BUNDLE, root: "missing", entryPoint: "missing/check.mjs", invocation: { argv: ["node", "missing/check.mjs"], cwd: "." } }), { code: "factory_evaluator_artifact_missing" });
	assert.throws(() => resolveEvaluatorBundle(f.repo, { ...BUNDLE, commit: "a".repeat(40) }), { code: "factory_commit_missing" });
	assert.throws(() => resolveEvaluatorBundle(path.join(f.root, "unavailable-host"), BUNDLE), { code: "factory_repository_unsupported" });
	assert.throws(() => deliver(f, "a".repeat(40)), { code: "factory_commit_missing" });
	await rm(path.join(f.repo, ".git", "objects", COMMIT.slice(0, 2), COMMIT.slice(2)));
	assert.throws(() => checkEvaluator(f.repo, definition, COMMIT), { code: "factory_commit_missing" });
});

test("ambiguous, escaped, symlinked and entry-file-only bundles are refused", async (t) => {
	const f = await fixture(t);
	for (const root of ["../evaluators", "/evaluators", "evaluators/../evaluators", "evaluators\\other", "evaluators//nested", "evaluators/*"]) {
		assert.throws(() => resolveEvaluatorBundle(f.repo, { ...BUNDLE, root }), { code: "factory_evaluator_path_invalid" });
	}
	assert.throws(() => resolveEvaluatorBundle(f.repo, { ...BUNDLE, support: ["evaluators/helper.mjs"] }), { code: "factory_evaluator_path_invalid" });
	assert.throws(() => resolveEvaluatorBundle(f.repo, { ...BUNDLE, root: "evaluators/check.mjs", entryPoint: "evaluators/check.mjs/run.mjs", invocation: { argv: ["node", "evaluators/check.mjs/run.mjs"], cwd: "." } }), { code: "factory_evaluator_bundle_invalid" });
	await rm(path.join(f.repo, "evaluators/helper.mjs"));
	await symlink("../implementation.mjs", path.join(f.repo, "evaluators/helper.mjs"));
	git(f.repo, "add", "evaluators/helper.mjs");
	git(f.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Symlinked helper");
	assert.throws(() => resolveEvaluatorBundle(f.repo, { ...BUNDLE, commit: git(f.repo, "rev-parse", "HEAD") }), { code: "factory_evaluator_path_invalid" });
});

test("legacy claims retain exact provenance and trust without acquiring mechanical identity or new acceptance", async (t) => {
	const f = await fixture(t);
	const legacy = legacyV2ReceiptHistory(f.factory.repository);
	/** @type {import("../../types/factory.js").FactoryState} */
	const state = { units: [], knowledge: [], contracts: [], candidates: [], decisions: [], signals: [], renewals: [], retirements: [], compactions: [], bindings: [] };
	for (const event of legacy.document.events) applyEvent(state, event, { historical: true });
	const old = must(state.candidates[0].evidence.find((entry) => entry.id === legacy.original.id));
	assert.equal(old.identity, undefined);
	assert.equal(old.trust, "independent-claim");
	assert.deepEqual(old.source, legacy.original.source);
	assert.equal(state.contracts[0].digest, legacy.contractDigest);
	assert.equal(state.candidates[0].contextDigest, legacy.contextDigest);
	assert.ok(candidateAssurance(state, state.candidates[0], legacy.document.events.at(-1)?.at ?? "").evaluationSupport[0].gaps.includes("evaluator-unverified"));
	const unpinned = { ...f.factory.generation(f.candidate.id).evaluations[0].evaluation, procedure: { kind: "command", ref: "legacy:test", digest: DIGEST } };
	f.mutate("appendKnowledge", { id: "legacy-proposal", unitId: "unit", kind: "evaluation", statement: "Retained unpinned proposal", source: source(), evaluation: unpinned });
	assert.throws(() => f.mutate("acceptContract", {
		unitId: "unit", unitRevision: 1, obligations: [{ id: "obligation", revision: 1 }], evaluations: [{ id: "legacy-proposal", revision: 1 }],
		actor: "owner", reason: "A digest-only proposal cannot be newly accepted as executable",
	}), { code: "factory_evaluator_unpinned" });
});

test("non-executable references and human rubrics never acquire executable identity", async (t) => {
	const f = await fixture(t);
	const definition = f.factory.generation(f.candidate.id).evaluations[0].evaluation;
	assert.throws(() => f.mutate("appendKnowledge", {
		id: "mislabelled-human", unitId: "unit", kind: "evaluation", statement: "Human review is not executable identity", source: source(),
		evaluation: { ...definition, modality: "human" },
	}), { code: "factory_evaluation_modality" });
	f.mutate("appendKnowledge", {
		id: "reference-only", unitId: "unit", kind: "evaluation", statement: "A non-executable source remains a reference", source: source(),
		evaluation: { ...definition, procedure: { kind: "reference", ref: "https://example.invalid/rubric", digest: DIGEST } },
	});
	f.mutate("acceptContract", {
		unitId: "unit", unitRevision: 1, obligations: [{ id: "obligation", revision: 1 }], evaluations: [{ id: "reference-only", revision: 1 }],
		actor: "owner", reason: "Retain the reference without inventing executable evidence",
	});
	const { candidate } = f.mutate("prepareCandidate", {
		id: "reference-candidate", unitId: "unit", contractRevision: 2, actor: "producer", mode: "implementation",
		context: { generation: [], comparisonOnly: [], independence: { method: "fresh-process", reason: "Attributable producer" } },
	});
	f.mutate("recordDelivery", {
		candidateId: candidate.id, commit: COMMIT, artifact: { kind: "implementation", ref: `git:${COMMIT}`, digest: DIGEST },
		source: { ...source(), kind: "external-run", owner: "fixture", runId: "reference-producer" },
	});
	const report = {
		...receipt(f), candidateId: candidate.id, evaluation: { id: "reference-only", revision: 1 },
		contractDigest: candidate.contractDigest, contextDigest: candidate.contextDigest,
	};
	assert.throws(() => f.mutate("recordEvaluation", report), { code: "factory_evaluator_unsupported" });
	const observation = f.mutate("recordEvaluation", { ...report, outcome: "inconclusive" });
	assert.equal(observation.evidence.identity, undefined);
	assert.ok(observation.assurance.evaluationSupport[0].gaps.includes("non-executable-reference"));
});
