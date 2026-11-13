import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildAssuranceSubject } from "../../analysis/assurance.mjs";
import { validatePackageAssurance } from "../../bridge/evidence.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { must } from "../assertions.mjs";
import { git } from "../git.mjs";
import { fixture } from "./fixture.mjs";

/** @param {string | Buffer} value */
const sha = (value) => createHash("sha256").update(value).digest("hex");

/** Writes only the isolated test repository; never changes the accepted evaluator commit.
 * @param {string} repo @param {Record<string, string>} files */
async function commitFiles(repo, files) {
	for (const [filename, content] of Object.entries(files)) await writeFile(path.join(repo, filename), content);
	git(repo, "add", "--", ...Object.keys(files));
	git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Isolated assurance delivery");
	return git(repo, "rev-parse", "HEAD");
}

/** @param {string} repo @param {string} repositoryId @param {string} commit @param {string} filename
 * @returns {import("../../types/parallel.js").ArtifactIdentity} */
function artifact(repo, repositoryId, commit, filename) {
	const bytes = execFileSync("git", ["--no-pager", "-C", repo, "show", `${commit}:${filename}`], { stdio: ["ignore", "pipe", "pipe"] });
	return { repositoryId, commit, path: filename, mode: "100644", digest: sha(bytes) };
}

/** Gate-only fixtures establish byte/identity checks, not native execution or reviewer provenance.
 * @param {import("node:test").TestContext} t */
async function assuranceFixture(t) {
	const f = await fixture(t);
	const repositoryId = f.factory.repository.id;
	const leftCommit = await commitFiles(f.repo, { "left.mjs": "export const copy = (value) => ({ ...value });\n" });
	const rightCommit = await commitFiles(f.repo, { "right.mjs": "export const normalize = (value) => value;\n" });
	const finalCommit = await commitFiles(f.repo, {
		"implementation.mjs": "import { copy } from './left.mjs';\nimport { normalize } from './right.mjs';\nexport const preserve = (input) => input.map(value => normalize(copy(value)));\n",
	});
	const definitions = f.factory.generation(f.candidate.id).evaluations;
	const requirements = [{ id: "obligation", revision: 1 }];
	const evaluators = definitions.map(({ id, revision }) => ({ id, revision }));
	/** @type {import("../../types/parallel.js").GoverningBindings} */
	const governing = {
		authority: "accepted-contract", repositoryId, unit: { id: "unit", revision: 1 },
		contract: { revision: 1, digest: f.candidate.contractDigest }, requirements,
		evaluators: definitions.map(({ id, revision, evaluation }) => ({
			id, revision, procedureDigest: evaluation.procedure.digest, requirements: evaluation.obligations,
			independent: evaluation.independent, modality: evaluation.modality,
		})),
		visualEvaluation: null,
	};
	/** @param {string} taskId @returns {import("../../types/parallel.js").AttemptIdentity} */
	const attempt = (taskId) => ({
		repositoryId, owner: path.join(f.root, "coordinator"), planId: "package-assurance", taskId,
		reservationId: `reserved-${taskId}`, attemptId: `${taskId}-A001`,
	});
	/** @type {import("../../types/parallel.js").ProducerDelivery[]} */
	const deliveries = [
		{ packageId: "left", attempt: attempt("T-001"), commit: leftCommit,
			outputs: [{ id: "module", artifact: artifact(f.repo, repositoryId, leftCommit, "left.mjs") }] },
		{ packageId: "right", attempt: attempt("T-002"), commit: rightCommit,
			outputs: [{ id: "module", artifact: artifact(f.repo, repositoryId, rightCommit, "right.mjs") }] },
	];
	const resolved = deliveries.map((delivery) => ({
		producer: delivery.packageId, output: "module", destination: delivery.outputs[0].artifact.path,
		artifact: delivery.outputs[0].artifact,
	}));
	/** @type {import("../../types/parallel.js").PackageDecomposition} */
	const decomposition = {
		format: "foundry-packages-v1", bindings: governing, target: "combined",
		packages: [
			...deliveries.map((delivery) => ({
				id: delivery.packageId, title: `Synthetic ${delivery.packageId} producer`, expectedFiles: [delivery.outputs[0].artifact.path],
				inputs: [], outputs: [{ id: "module", path: delivery.outputs[0].artifact.path }], requirements: [], evaluators: [],
			})),
			{ id: "combined", title: "Synthetic combined target", expectedFiles: ["implementation.mjs"],
				inputs: resolved.map(({ producer, output, destination }) => ({ producer, output, destination })),
				outputs: [{ id: "implementation", path: "implementation.mjs" }], requirements, evaluators },
		],
	};
	/** @type {Omit<import("../../types/parallel.js").ReservedInputs, "digest">} */
	const inputBody = {
		format: "foundry-reserved-inputs-v1", consumer: attempt("T-003"),
		bootstrap: { repositoryId, branch: "main", commit: f.commit }, deliveries, inputs: resolved,
	};
	/** @type {Parameters<typeof buildAssuranceSubject>[0]} */
	const subjectInput = {
		decomposition, governing, packageId: "combined",
		inputs: { ...inputBody, digest: analysisInputDigest(inputBody) },
		delivery: { packageId: "combined", attempt: inputBody.consumer, commit: finalCommit,
			outputs: [{ id: "implementation", artifact: artifact(f.repo, repositoryId, finalCommit, "implementation.mjs") }] },
		producer: "combined-producer", authors: ["combined-producer"], definitions,
		reviews: [
			{ kind: "implementation", required: true, reason: "Inspect the composed implementation", reviewers: ["implementation-reviewer"] },
			{ kind: "architecture", required: true, reason: "Retain the boundary preservation check", reviewers: ["boundary-reviewer"] },
			{ kind: "security", required: false, reason: "No security applicability in this bounded gate fixture", reviewers: [] },
			{ kind: "visual", required: false, reason: "This fixture has no declared UI output", reviewers: [] },
		],
	};
	const subject = buildAssuranceSubject(subjectInput);
	return { ...f, subjectInput, subject, inputBody };
}

/** @param {ReturnType<typeof buildAssuranceSubject>} subject */
function reportFor(subject) {
	return {
		format: "foundry-package-assurance-v1", subjectDigest: subject.digest, observedAt: new Date().toISOString(),
		evaluations: subject.definitions.map(({ id, revision, evaluation }) => ({
			evaluation: { id, revision }, procedureDigest: evaluation.procedure.digest,
			environment: evaluation.environment, workload: evaluation.workload, outcome: "passed",
			report: "Synthetic gate-only report for the preserved Git evaluator; not authenticated execution provenance.",
			independenceReason: "Separately identified fixture reviewer; no live review is claimed", reviewer: "boundary-reviewer",
		})),
		reviews: subject.reviews.filter((entry) => entry.required).map((entry) => ({
			kind: entry.kind, author: subject.producer, reviewer: entry.reviewers[0], commit: subject.delivery.commit,
			scope: subject.requirements, outcome: "passed", findings: subject.requirements.length ? subject.requirements.map((requirement) => ({
				requirement, observation: "Gate-only fixture binds the composed copy operation to its immutable inputs.",
				evidence: `${subject.delivery.commit}:implementation.mjs`,
			})) : subject.delivery.outputs.map(({ id, artifact }) => ({
				output: id, observation: "Gate-only review identifies the exact producer module, without inventing requirements.",
				evidence: `${artifact.commit}:${artifact.path}`,
			})),
		})),
	};
}

test("package assurance checks real multi-producer Git inputs and the combined delivery without claiming live review", async (t) => {
	const f = await assuranceFixture(t);
	execFileSync(process.execPath, ["evaluators/check.mjs"], { cwd: f.repo, stdio: ["ignore", "pipe", "pipe"] });
	const result = validatePackageAssurance(f.repo, f.subject, reportFor(f.subject));
	assert.equal(result.passed, true);
	assert.equal(result.trust, "independent-claim");
	assert.notEqual(f.subject.delivery.commit, f.commit);
	assert.equal(f.subject.inputs.deliveries.length, 2);
});

test("package assurance rejects changed frozen helper, fixture and lock bytes despite the unchanged evaluator entry point", async (t) => {
	for (const [filename, content] of Object.entries({
		"evaluators/helper.mjs": "export const check = () => true;\n",
		"evaluators/fixture.json": "{\"ids\":[\"substituted\"]}\n",
		"package-lock.json": "{\"lockfileVersion\":3,\"requires\":false,\"packages\":{}}\n",
	})) await t.test(filename, async (t) => {
		const f = await assuranceFixture(t);
		const commit = await commitFiles(f.repo, { [filename]: content });
		const subject = buildAssuranceSubject({
			...f.subjectInput, delivery: { ...f.subject.delivery, commit,
				outputs: [{ id: "implementation", artifact: artifact(f.repo, f.factory.repository.id, commit, "implementation.mjs") }] },
		});
		assert.equal(git(f.repo, "show", `${commit}:evaluators/check.mjs`), git(f.repo, "show", `${f.commit}:evaluators/check.mjs`));
		assert.throws(() => validatePackageAssurance(f.repo, subject, reportFor(subject)), { code: "factory_evaluator_changed" });
	});
});

test("package assurance recomputes the frozen invocation digest from the actual Git bundle", async (t) => {
	const f = await assuranceFixture(t);
	const input = structuredClone(f.subjectInput);
	const procedure = input.definitions[0].evaluation.procedure;
	must(procedure.bundle).invocation.argv = ["node", "--no-warnings", "evaluators/check.mjs"];
	procedure.ref = "node --no-warnings evaluators/check.mjs";
	const subject = buildAssuranceSubject(input);
	assert.throws(() => validatePackageAssurance(f.repo, subject, reportFor(subject)), { code: "factory_evaluator_changed" });
});

test("an output-only package still protects governing evaluator bytes assigned to another package", async (t) => {
	const f = await assuranceFixture(t);
	const delivery = f.inputBody.deliveries[0];
	/** @type {Omit<import("../../types/parallel.js").ReservedInputs, "digest">} */
	const inputBody = { ...f.inputBody, consumer: delivery.attempt, deliveries: [], inputs: [] };
	/** @type {Parameters<typeof buildAssuranceSubject>[0]} */
	const input = {
		...f.subjectInput, packageId: delivery.packageId, delivery, producer: "left-producer", authors: ["left-producer"],
		inputs: { ...inputBody, digest: analysisInputDigest(inputBody) },
		reviews: f.subjectInput.reviews.map((entry) => entry.kind === "implementation" ? entry : {
			...entry, required: false, reason: "No locally assigned evaluator requires this review", reviewers: [],
		}),
	};
	const subject = buildAssuranceSubject(input);
	assert.deepEqual(subject.definitions, []);
	assert.equal(validatePackageAssurance(f.repo, subject, reportFor(subject)).passed, true);
	const commit = await commitFiles(f.repo, { "evaluators/helper.mjs": "export const check = () => true;\n" });
	const changed = buildAssuranceSubject({
		...input, delivery: { ...delivery, commit,
			outputs: [{ id: "module", artifact: artifact(f.repo, f.factory.repository.id, commit, "left.mjs") }] },
	});
	assert.throws(() => validatePackageAssurance(f.repo, changed, reportFor(changed)), { code: "factory_evaluator_changed" });
});

test("package assurance rejects copied input bytes without the reserved bootstrap and every producer commit in ancestry", async (t) => {
	const f = await assuranceFixture(t);
	const tree = git(f.repo, "rev-parse", `${f.subject.delivery.commit}^{tree}`);
	const copied = git(f.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
		"commit-tree", tree, "-p", f.inputBody.deliveries[0].commit, "-m", "Copied bytes omit second producer ancestry");
	const subject = buildAssuranceSubject({
		...f.subjectInput, delivery: { ...f.subject.delivery, commit: copied,
			outputs: [{ id: "implementation", artifact: artifact(f.repo, f.factory.repository.id, copied, "implementation.mjs") }] },
	});
	assert.throws(() => validatePackageAssurance(f.repo, subject, reportFor(subject)), { code: "factory_integration_mismatch" });
	const unrelated = git(f.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
		"commit-tree", tree, "-m", "Isolated unrelated bootstrap");
	const inputBody = structuredClone(f.inputBody);
	inputBody.bootstrap.commit = unrelated;
	const differentBootstrap = buildAssuranceSubject({
		...f.subjectInput, inputs: { ...inputBody, digest: analysisInputDigest(inputBody) },
	});
	assert.throws(() => validatePackageAssurance(f.repo, differentBootstrap, reportFor(differentBootstrap)), { code: "factory_integration_mismatch" });
});

test("package assurance checks reserved input bytes and delivered output bytes and modes in Git, not only descriptor hashes", async (t) => {
	const f = await assuranceFixture(t);
	const inputBody = structuredClone(f.inputBody);
	inputBody.deliveries[0].outputs[0].artifact.digest = sha("substituted producer bytes");
	inputBody.inputs[0].artifact.digest = inputBody.deliveries[0].outputs[0].artifact.digest;
	const inputSubject = buildAssuranceSubject({
		...f.subjectInput, inputs: { ...inputBody, digest: analysisInputDigest(inputBody) },
	});
	assert.throws(() => validatePackageAssurance(f.repo, inputSubject, reportFor(inputSubject)), { code: "parallel_assurance_artifact" });
	for (const change of [{ digest: sha("substituted output bytes") }, { mode: "100755" }]) {
		const delivery = structuredClone(f.subject.delivery);
		Object.assign(delivery.outputs[0].artifact, change);
		const subject = buildAssuranceSubject({ ...f.subjectInput, delivery });
		assert.throws(() => validatePackageAssurance(f.repo, subject, reportFor(subject)), { code: "parallel_assurance_artifact" });
	}
});

test("package assurance rejects stale observation time, environment and workload even when every Git artifact is intact", async (t) => {
	const f = await assuranceFixture(t);
	for (const change of [{ environment: "stale-platform" }, { workload: "stale-workload" }]) {
		const report = reportFor(f.subject);
		Object.assign(report.evaluations[0], change);
		assert.throws(() => validatePackageAssurance(f.repo, f.subject, report), { code: "parallel_assurance_evaluator" });
	}
	const report = reportFor(f.subject);
	const expires = Date.parse(report.observedAt) + f.subject.definitions[0].evaluation.maxAgeSeconds * 1000;
	assert.throws(() => validatePackageAssurance(f.repo, f.subject, report, new Date(expires + 1).toISOString()), { code: "parallel_assurance_stale" });
	assert.equal(validatePackageAssurance(f.repo, f.subject, report).passed, true);
});
