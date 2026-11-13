import assert from "node:assert/strict";
import test from "node:test";
import { assessPackageAssurance, buildAssuranceSubject, packageCoverage } from "../../analysis/assurance.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { COMMIT, DIGEST, PROCEDURE } from "../git.mjs";

const REPO = "e".repeat(64);
const requirement = { id: "preservation", revision: 1 };
const oracle = { id: "oracle", revision: 1 };
/** @param {string} taskId @returns {import("../../types/parallel.js").AttemptIdentity} */
const attempt = (taskId) => ({
	repositoryId: REPO, owner: "fixture-owner", planId: "assurance-fixture", taskId,
	reservationId: `reserve-${taskId}`, attemptId: `${taskId}-A001`,
});

function fixture() {
	/** @type {import("../../types/parallel.js").GoverningBindings} */
	const governing = {
		authority: "accepted-contract", repositoryId: REPO, unit: { id: "synthetic-unit", revision: 1 },
		contract: { revision: 1, digest: DIGEST }, requirements: [requirement],
		evaluators: ["oracle", "beta-oracle", "join-oracle"].map((id) => ({
			id, revision: 1, procedureDigest: DIGEST, requirements: [requirement], independent: true, modality: "boundary",
		})),
		visualEvaluation: null,
	};
	/** @type {import("../../types/parallel.js").PackageDecomposition} */
	const decomposition = { format: "foundry-packages-v1", bindings: governing, target: "product",
		packages: ["alpha", "beta", "product"].map((id, index) => ({
			id, title: id, expectedFiles: [`${id}.mjs`], requirements: [requirement],
			evaluators: [{ id: governing.evaluators[index].id, revision: 1 }],
			inputs: id === "product" ? ["alpha", "beta"].map((producer) => ({ producer, output: "module", destination: `inputs/${producer}.mjs` })) : [],
			outputs: [{ id: "module", path: `${id}.mjs` }],
		})),
	};
	const artifact = (/** @type {string} */ name) => ({
		repositoryId: REPO, commit: COMMIT, path: `${name}.mjs`, mode: /** @type {const} */ ("100644"), digest: DIGEST,
	});
	const deliveries = ["alpha", "beta"].map((packageId, index) => ({
		packageId, attempt: attempt(`T-00${index + 1}`), commit: COMMIT, outputs: [{ id: "module", artifact: artifact(packageId) }],
	}));
	const input = {
		format: /** @type {const} */ ("foundry-reserved-inputs-v1"),
		consumer: attempt("T-003"), bootstrap: { repositoryId: REPO, branch: "bootstrap", commit: COMMIT }, deliveries,
		inputs: decomposition.packages[2].inputs.map((item) => ({ ...item, artifact: artifact(item.producer) })),
	};
	const inputs = { ...input, digest: analysisInputDigest(input) };
	const delivery = { packageId: "product", attempt: input.consumer, commit: COMMIT, outputs: [{ id: "module", artifact: artifact("product") }] };
	/** @type {import("../../analysis/assurance.mjs").Definition[]} */
	const definitions = governing.evaluators.map(({ id, revision }) => ({
		id, revision, evaluation: { modality: "boundary", obligations: [requirement], procedure: PROCEDURE,
			environment: "fixture-node", workload: "synthetic-two-producer-join", independent: true, preservation: true, maxAgeSeconds: 86400 },
	}));
	/** @type {import("../../analysis/assurance.mjs").ReviewObligation[]} */
	const reviews = [
		{ kind: "implementation", required: true, reason: "Executable join must preserve both inputs", reviewers: ["reviewer"] },
		{ kind: "architecture", required: true, reason: "Boundary and preservation review", reviewers: ["reviewer"] },
		{ kind: "security", required: false, reason: "Fixture has no external access or authority-changing operation", reviewers: [] },
		{ kind: "visual", required: false, reason: "No rendered UI in this synthetic contract", reviewers: [] },
	];
	const args = { decomposition, governing, packageId: "product", inputs, delivery, producer: "producer-session",
		authors: ["producer-session", "alpha-session", "beta-session"], definitions, reviews };
	const subject = buildAssuranceSubject(args);
	const report = {
		format: "foundry-package-assurance-v1", subjectDigest: subject.digest, observedAt: new Date().toISOString(),
		evaluations: definitions.map(({ id, revision }) => ({ evaluation: { id, revision }, procedureDigest: DIGEST, environment: "fixture-node", workload: "synthetic-two-producer-join",
			outcome: "passed", report: "Tiny evaluator observed preserved input identity after joining both modules.",
			independenceReason: "Separately identified read-only reviewer", reviewer: "reviewer" })),
		reviews: subject.reviews.filter((entry) => entry.required).map((entry) => ({
			kind: entry.kind, author: subject.producer, reviewer: "reviewer", commit: COMMIT, scope: [requirement], outcome: "passed",
			findings: [{ requirement, observation: "Both modules retain caller-owned input; the integration does not rewrite the protected evaluator.",
				evidence: "fixture: independently inspected immutable product.mjs and executable evaluator output" }],
		})),
	};
	return { args, subject, report };
}

test("synthetic two-producer assurance conserves requirements, evaluators and independent substantive reviews", () => {
	const { args, subject, report } = fixture();
	assert.equal(packageCoverage(args.decomposition, args.governing).packages.length, 3);
	assert.equal(subject.inputs.deliveries.length, 2);
	assert.equal(args.decomposition.packages[2].evaluators.length, 1);
	assert.equal(subject.definitions.length, 3, "The combined target rechecks all governing evaluators, not only its locally owned one");
	const result = assessPackageAssurance(report, subject);
	assert.equal(result.passed, true);
	assert.deepEqual(result.pendingHuman, []);
	assert.equal(result.trust, "independent-claim");
	assert.equal(result.reviews[1].findings[0].requirement?.revision, 1);
	// Synthetic contracts exercise conservation; they do not accept this engineering unit.
	args.governing.authority = "discovery-only";
	args.governing.contract = null;
	const discovery = buildAssuranceSubject(args);
	assert.equal(assessPackageAssurance({ ...report, subjectDigest: discovery.digest }, discovery).authority, "discovery-only");
	assert.equal(discovery.bindings.contract, null);
});

test("package coverage rejects omitted, stale and substituted governing links and final target omissions", () => {
	for (const change of [
		(/** @type {ReturnType<typeof fixture>["args"]} */ args) => { args.decomposition.packages[0].evaluators = []; },
		(/** @type {ReturnType<typeof fixture>["args"]} */ args) => { args.decomposition.packages[0].requirements = []; },
		(/** @type {ReturnType<typeof fixture>["args"]} */ args) => { args.decomposition.packages[2].evaluators = []; },
		(/** @type {ReturnType<typeof fixture>["args"]} */ args) => { args.decomposition.packages[0].evaluators = [{ ...oracle, revision: 2 }]; },
		(/** @type {ReturnType<typeof fixture>["args"]} */ args) => { args.definitions[0].evaluation.procedure = { ...PROCEDURE, digest: "f".repeat(64) }; },
		(/** @type {ReturnType<typeof fixture>["args"]} */ args) => { args.definitions.push(args.definitions[0]); },
		(/** @type {ReturnType<typeof fixture>["args"]} */ args) => { args.decomposition.packages[0].evaluators = [{ id: "join-oracle", revision: 1 }]; },
	]) {
		const { args } = fixture();
		change(args);
		assert.throws(() => buildAssuranceSubject(args));
	}
	const { args } = fixture();
	const substituted = structuredClone(args.decomposition);
	substituted.bindings.unit.revision++;
	assert.throws(() => packageCoverage(substituted, args.governing), { code: "parallel_binding_mismatch" });
});

test("evidence cannot migrate to another delivery, input identity, package, attempt, producer or context", () => {
	for (const change of [
		(/** @type {ReturnType<typeof fixture>["args"]} */ args) => { args.delivery.commit = "f".repeat(40); args.delivery.outputs[0].artifact.commit = args.delivery.commit; },
		(/** @type {ReturnType<typeof fixture>["args"]} */ args) => { args.inputs.inputs[0].artifact.digest = "f".repeat(64); args.inputs.deliveries[0].outputs[0].artifact.digest = "f".repeat(64); },
		(/** @type {ReturnType<typeof fixture>["args"]} */ args) => { args.inputs.consumer = { ...args.inputs.consumer, attemptId: "T-003-A002" }; args.delivery.attempt = args.inputs.consumer; },
		(/** @type {ReturnType<typeof fixture>["args"]} */ args) => { args.producer = "different-producer-session"; args.authors.push(args.producer); },
		(/** @type {ReturnType<typeof fixture>["args"]} */ args) => { args.definitions[0].evaluation.environment = "another-environment"; },
		(/** @type {ReturnType<typeof fixture>["args"]} */ args) => { args.definitions[0].evaluation.workload = "another-workload"; },
	]) {
		const { args, report } = fixture();
		change(args);
		const { digest: _digest, ...body } = args.inputs;
		args.inputs.digest = analysisInputDigest(body);
		const other = buildAssuranceSubject(args);
		assert.throws(() => assessPackageAssurance(report, other), { code: "parallel_assurance_subject" });
	}
	const { args, report } = fixture();
	args.packageId = "alpha";
	args.delivery.packageId = "alpha";
	assert.throws(() => buildAssuranceSubject(args));
	assert.throws(() => assessPackageAssurance({ ...report, packageId: "product" }, fixture().subject));
});

test("omitted producer inputs and output identities cannot be self-attested away", () => {
	const { args } = fixture();
	args.inputs.inputs.pop();
	args.inputs.deliveries.pop();
	const { digest: _digest, ...body } = args.inputs;
	args.inputs.digest = analysisInputDigest(body);
	assert.throws(() => buildAssuranceSubject(args), { code: "parallel_input_coverage" });
	for (const change of [{ outputs: [] }, { commit: "main" }, { packageId: "alpha" },
		{ attempt: attempt("T-002") }]) {
		const next = fixture().args;
		assert.throws(() => buildAssuranceSubject({ ...next, delivery: { ...next.delivery, ...change } }));
	}
});

test("review applicability, independence, scope, commit and substantive findings are mandatory", () => {
	for (const change of [
		(/** @type {ReturnType<typeof fixture>["report"]} */ report) => { report.reviews = []; },
		(/** @type {ReturnType<typeof fixture>["report"]} */ report) => { report.reviews[0].reviewer = "producer-session"; },
		(/** @type {ReturnType<typeof fixture>["report"]} */ report) => { report.reviews[0].reviewer = "alpha-session"; },
		(/** @type {ReturnType<typeof fixture>["report"]} */ report) => { report.reviews[0].reviewer = "unadmitted-reviewer"; },
		(/** @type {ReturnType<typeof fixture>["report"]} */ report) => { report.reviews[0].commit = "f".repeat(40); },
		(/** @type {ReturnType<typeof fixture>["report"]} */ report) => { report.reviews[0].scope = []; },
		(/** @type {ReturnType<typeof fixture>["report"]} */ report) => { report.reviews[0].findings = []; },
		(/** @type {ReturnType<typeof fixture>["report"]} */ report) => { report.reviews[0].findings[0].evidence = ""; },
	]) {
		const { subject, report } = fixture();
		change(report);
		assert.throws(() => assessPackageAssurance(report, subject));
	}
	for (const kind of ["implementation", "architecture"]) {
		const { args } = fixture();
		const review = args.reviews.find((entry) => entry.kind === kind);
		assert.ok(review);
		review.required = false;
		review.reviewers = [];
		assert.throws(() => buildAssuranceSubject(args), { code: "parallel_review_required" });
	}
	const { args } = fixture();
	args.reviews[2].reason = "";
	assert.throws(() => buildAssuranceSubject(args));
	const upstream = fixture().args;
	upstream.reviews[0].reviewers = ["alpha-session"];
	assert.throws(() => buildAssuranceSubject(upstream), { code: "parallel_review_independence" });
});

test("failed review is retained, security applicability is explicit, and no review grants authority", () => {
	const { args, report } = fixture();
	args.reviews[2] = { kind: "security", required: true, reason: "Review changed untrusted-input boundary", reviewers: ["security-reviewer"] };
	const subject = buildAssuranceSubject(args);
	report.subjectDigest = subject.digest;
	assert.throws(() => assessPackageAssurance(report, subject), { code: "parallel_review_required" });
	report.reviews.push({ ...report.reviews[0], kind: "security", reviewer: "security-reviewer", outcome: "failed" });
	const result = assessPackageAssurance(report, subject);
	assert.equal(result.passed, false);
	assert.equal(result.reviews[2].outcome, "failed");
	assert.throws(() => assessPackageAssurance({ ...report, approved: true }, subject));
});

test("stale evaluator revisions/context and self-evaluation cannot satisfy exact package reports", () => {
	for (const change of [
		{ evaluation: { ...oracle, revision: 2 } }, { procedureDigest: "f".repeat(64) },
		{ environment: "wrong-environment" }, { workload: "wrong-workload" },
		{ reviewer: "producer-session" }, { reviewer: "unadmitted-reviewer" },
	]) {
		const { report, subject } = fixture();
		assert.throws(() => assessPackageAssurance({ ...report, evaluations: [{ ...report.evaluations[0], ...change }] }, subject));
	}
	const { report, subject } = fixture();
	assert.throws(() => assessPackageAssurance({ ...report, evaluations: [] }, subject));
	assert.throws(() => assessPackageAssurance({ ...report, evaluations: [report.evaluations[0], report.evaluations[0]] }, subject));
});

test("explicit human obligations remain open rather than becoming agent review or technical approval", () => {
	const { args, report } = fixture();
	const human = { id: "human-rubric", revision: 1 };
	args.governing.evaluators.push({ ...human, procedureDigest: "f".repeat(64), requirements: [requirement], independent: true, modality: "human" });
	args.decomposition.packages[2].evaluators.push(human);
	args.definitions.push({ ...human, evaluation: { ...args.definitions[0].evaluation, modality: "human", preservation: false,
		procedure: { kind: "judgment", ref: "Explicit attributed human design review", digest: "f".repeat(64) } } });
	const subject = buildAssuranceSubject(args);
	report.subjectDigest = subject.digest;
	const result = assessPackageAssurance(report, subject);
	assert.equal(result.passed, false);
	assert.equal(result.executablePassed, true);
	assert.deepEqual(result.pendingHuman, [human]);
	assert.throws(() => assessPackageAssurance({ ...report, evaluations: [...report.evaluations, {
		...report.evaluations[0], evaluation: human, procedureDigest: "f".repeat(64),
	}] }, subject), { code: "parallel_assurance_evaluator" });
});

test("infrastructure packages review exact outputs without inventing governing requirements", () => {
	const { args } = fixture();
	args.decomposition.packages[0].requirements = [];
	args.decomposition.packages[0].evaluators = [];
	args.decomposition.packages[2].evaluators.push(oracle);
	args.packageId = "alpha";
	const { digest: _digest, ...base } = args.inputs;
	const inputs = { ...base, consumer: attempt("T-001"), deliveries: [], inputs: [] };
	args.inputs = { ...inputs, digest: analysisInputDigest(inputs) };
	args.delivery = { packageId: "alpha", attempt: inputs.consumer, commit: COMMIT,
		outputs: [{ id: "module", artifact: { ...args.delivery.outputs[0].artifact, path: "alpha.mjs" } }] };
	args.reviews[1] = { kind: "architecture", required: false, reason: "No boundary change in this support package", reviewers: [] };
	const subject = buildAssuranceSubject(args);
	assert.deepEqual(subject.requirements, []);
	assert.deepEqual(subject.definitions, []);
	assert.equal(subject.protectedDefinitions.length, 3, "All accepted bundles stay protected even without local evaluator ownership");
	const report = { format: "foundry-package-assurance-v1", subjectDigest: subject.digest, observedAt: new Date().toISOString(), evaluations: [], reviews: [{
		kind: "implementation", author: subject.producer, reviewer: "reviewer", commit: COMMIT, scope: [], outcome: "passed",
		findings: [{ output: "module", observation: "The delivered support module exports the declared immutable data without rewriting its inputs.",
			evidence: "fixture: independently inspected alpha.mjs at the exact delivery" }],
	}] };
	assert.equal(assessPackageAssurance(report, subject).passed, true);
	assert.throws(() => assessPackageAssurance({ ...report, reviews: [{ ...report.reviews[0], findings: [] }] }, subject));
	assert.throws(() => assessPackageAssurance({ ...report, reviews: [{ ...report.reviews[0], findings: [
		{ ...report.reviews[0].findings[0], output: "different-output" },
	] }] }, subject), { code: "parallel_review_scope" });
});

test("expired and future-dated exact-delivery observations cannot renew support", () => {
	const { subject, report } = fixture();
	report.observedAt = "2026-11-13T00:00:00.000Z";
	assert.equal(assessPackageAssurance(report, subject, "2026-11-14T00:00:00.000Z").passed, true);
	assert.throws(() => assessPackageAssurance(report, subject, "2026-11-14T00:00:00.001Z"), { code: "parallel_assurance_stale" });
	assert.throws(() => assessPackageAssurance(report, subject, "2026-11-12T23:59:59.999Z"), { code: "parallel_assurance_stale" });
	const { observedAt: _observedAt, ...undated } = report;
	assert.throws(() => assessPackageAssurance(undated, subject));
});
