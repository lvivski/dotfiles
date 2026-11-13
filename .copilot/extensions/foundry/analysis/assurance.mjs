import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { evaluation, requiresHumanJudgment } from "../factory/definitions.mjs";
import { digest, enumeration, fail, identifier, list, object, reference, strings, text, timestamp } from "../factory/fields.mjs";
import { visualReport } from "../factory/visual.mjs";
import { artifactIdentity, assertConservedBindings, assertInputCoverage, attemptIdentity, commitId, packageDecomposition, refKey, reservedInputs } from "../plan/parallel-contracts.mjs";

/** @typedef {import("../types/parallel.js").GoverningBindings} GoverningBindings */
/** @typedef {import("../types/factory.js").KnowledgeRef} KnowledgeRef */
/** @typedef {KnowledgeRef & {evaluation: import("../types/factory.js").EvaluationDefinition}} Definition */
/** @typedef {"implementation" | "architecture" | "security" | "visual"} ReviewKind */
/** @typedef {{kind: ReviewKind, required: boolean, reason: string, reviewers: string[]}} ReviewObligation */

const REVIEW_KINDS = /** @type {const} */ (["implementation", "architecture", "security", "visual"]);
/** @param {unknown} left @param {unknown} right */
const same = (left, right) => stableStringify(left) === stableStringify(right);
/** @param {KnowledgeRef[]} left @param {KnowledgeRef[]} right */
const sameRefs = (left, right) => same(left.map(refKey).sort(), right.map(refKey).sort());

/** Conservation is checked against the owner's frozen definitions, never a report's labels.
 * The caller supplies authority; this pure port cannot accept contracts or authorize reviewers.
 * @param {unknown} value @param {GoverningBindings} governing */
export function packageCoverage(value, governing) {
	const decomposition = packageDecomposition(value);
	assertConservedBindings(decomposition.bindings, governing);
	for (const pkg of decomposition.packages) {
		const evaluators = decomposition.bindings.evaluators.filter((entry) => pkg.evaluators.some((ref) => refKey(ref) === refKey(entry)));
		if (evaluators.some((entry) => entry.requirements.some((ref) => !pkg.requirements.some((required) => refKey(required) === refKey(ref))))) {
			fail("parallel_assurance_coverage", "Every package needs complete requirement-to-evaluator links, including human obligations");
		}
	}
	if (governing.requirements.some((ref) => !decomposition.packages.some((pkg) => pkg.requirements.some((item) => refKey(item) === refKey(ref))))
		|| governing.evaluators.some((ref) => !decomposition.packages.some((pkg) => pkg.evaluators.some((item) => refKey(item) === refKey(ref))))) {
		fail("parallel_assurance_coverage", "The decomposition must account for every governing requirement and evaluator");
	}
	return decomposition;
}

/**
 * Freeze the subject before review using owner-resolved input/delivery and reviewer identities.
 * authors comes from all contributing native attempts, not the submitted review.
 * T-007 composes this with native ownership and T-002's actual Git input resolution.
 * No wire fields are added to historical plans, grants or reports.
 * @param {{
 * decomposition: unknown, governing: GoverningBindings, packageId: string,
 * inputs: unknown, delivery: unknown, producer: string, authors: string[],
 * definitions: Definition[], reviews: ReviewObligation[]
 * }} input
 */
export function buildAssuranceSubject(input) {
	const decomposition = packageCoverage(input.decomposition, input.governing);
	const pkg = decomposition.packages.find((entry) => entry.id === input.packageId);
	if (!pkg) fail("parallel_assurance_subject", "Unknown package");
	const inputs = reservedInputs(input.inputs);
	assertInputCoverage(inputs, pkg.inputs);
	for (const delivered of inputs.deliveries) {
		const predecessor = decomposition.packages.find((entry) => entry.id === delivered.packageId);
		if (!predecessor || delivered.outputs.length !== predecessor.outputs.length
			|| delivered.outputs.some((output) => !predecessor.outputs.some((entry) => entry.id === output.id && entry.path === output.artifact.path))) {
			fail("parallel_assurance_subject", "Predecessor artifacts must retain their declared package/output paths");
		}
	}
	object(input.delivery, ["packageId", "attempt", "commit", "outputs"], "assurance delivery");
	const attempt = attemptIdentity(input.delivery.attempt);
	const commit = commitId(input.delivery.commit);
	if (input.delivery.packageId !== pkg.id || !same(attempt, inputs.consumer)
		|| attempt.repositoryId !== decomposition.bindings.repositoryId) {
		fail("parallel_assurance_subject", "Delivery must belong to this package's exact reserved consumer attempt");
	}
	const outputs = list(input.delivery.outputs, "assurance outputs", 128, 1).map((output) => {
		object(output, ["id", "artifact"], "assurance output");
		const artifact = artifactIdentity(output.artifact);
		const id = identifier(output.id);
		if (artifact.repositoryId !== attempt.repositoryId || artifact.commit !== commit
			|| !pkg.outputs.some((entry) => entry.id === id && entry.path === artifact.path)) {
			fail("parallel_assurance_subject", "Output identity differs from the declared delivered artifact");
		}
		return { id, artifact };
	});
	if (outputs.length !== pkg.outputs.length || new Set(outputs.map((entry) => entry.id)).size !== outputs.length) {
		fail("parallel_assurance_subject", "Every declared output must be accounted for exactly once");
	}
	const definitions = input.definitions.map((entry) => ({
		...reference({ id: entry.id, revision: entry.revision }),
		evaluation: evaluation(entry.evaluation, null, decomposition.bindings.unit.id),
	}));
	if (!sameRefs(definitions, decomposition.bindings.evaluators)) fail("parallel_assurance_coverage", "Frozen evaluator definitions are missing or duplicated");
	for (const entry of definitions) {
		const binding = decomposition.bindings.evaluators.find((item) => refKey(item) === refKey(entry));
		if (!binding || entry.evaluation.procedure.digest !== binding.procedureDigest || entry.evaluation.modality !== binding.modality
			|| entry.evaluation.independent !== binding.independent || !sameRefs(entry.evaluation.obligations, binding.requirements)) {
			fail("parallel_binding_mismatch", "Evaluator definitions changed the governing identity or obligations");
		}
	}
	const declaredVisual = decomposition.bindings.visualEvaluation;
	if (declaredVisual && !definitions.find((entry) => refKey(entry) === refKey(declaredVisual))?.evaluation.visual) {
		fail("parallel_visual_binding", "Declared UI applicability must retain the actual visual definition");
	}
	const finalTarget = pkg.id === decomposition.target;
	const selected = finalTarget ? definitions : definitions.filter((entry) => pkg.evaluators.some((ref) => refKey(ref) === refKey(entry)));
	const producer = text(input.producer, "producer session", 512);
	const authors = strings(input.authors, "contributing producer sessions", 128, 1);
	if (!authors.includes(producer)) fail("parallel_review_independence", "The owner-resolved contributing authors must include this producer");
	const reviews = list(input.reviews, "review obligations", 4, 4).map((raw) => {
		object(raw, ["kind", "required", "reason", "reviewers"], "review obligation");
		const kind = enumeration(raw.kind, REVIEW_KINDS, "review kind");
		if (typeof raw.required !== "boolean") fail("parallel_review_required", "Review applicability must be explicit");
		const reason = text(raw.reason, "review applicability reason", 2048);
		const reviewers = strings(raw.reviewers, "authorized independent reviewers", 32, raw.required ? 1 : 0);
		if (reviewers.some((reviewer) => authors.includes(reviewer)) || (!raw.required && reviewers.length)) {
			fail("parallel_review_independence", "Reviewers must be independently identified, not any contributing producer");
		}
		const required = kind === "implementation"
			|| (kind === "architecture" && selected.some((entry) => entry.evaluation.modality === "boundary" || entry.evaluation.preservation))
			|| (kind === "visual" && selected.some((entry) => entry.evaluation.visual));
		if (required && !raw.required) fail("parallel_review_required", `Applicable ${kind} review cannot be waived`);
		return { kind, required: raw.required, reason, reviewers };
	});
	if (new Set(reviews.map((entry) => entry.kind)).size !== REVIEW_KINDS.length) fail("parallel_review_required", "Each review modality needs an explicit applicability decision");
	const subject = {
		format: /** @type {const} */ ("foundry-assurance-subject-v1"),
		decompositionDigest: analysisInputDigest(decomposition),
		bindings: decomposition.bindings, packageId: pkg.id, finalTarget,
		producer, authors, inputs, delivery: { packageId: pkg.id, attempt, commit, outputs },
		requirements: finalTarget ? decomposition.bindings.requirements : pkg.requirements,
		definitions: selected, protectedDefinitions: definitions, reviews,
	};
	return { ...subject, digest: analysisInputDigest(subject) };
}

/** @typedef {ReturnType<typeof buildAssuranceSubject>} AssuranceSubject */

/** Pure, bounded report validation. Artifact bytes are checked by the bridge, not this parser.
 * Human judgments remain with the existing explicit human-evidence gate.
 * @param {unknown} value @param {AssuranceSubject} subject @param {string} [at] */
export function assessPackageAssurance(value, subject, at = new Date().toISOString()) {
	object(value, ["format", "subjectDigest", "observedAt", "evaluations", "reviews"], "package assurance");
	const { digest: subjectDigest, ...body } = subject;
	if (digest(subjectDigest, "subject digest") !== analysisInputDigest(body)
		|| value.format !== "foundry-package-assurance-v1" || value.subjectDigest !== subjectDigest) {
		fail("parallel_assurance_subject", "Evidence belongs to another package, attempt, input set, evaluator context or delivery");
	}
	const observedAt = timestamp(value.observedAt, "assurance observation time");
	const age = Date.parse(timestamp(at, "assurance assessment time")) - Date.parse(observedAt);
	if (age < 0 || subject.definitions.some((entry) => age > entry.evaluation.maxAgeSeconds * 1000)) {
		fail("parallel_assurance_stale", "Future-dated or expired package evaluations cannot support completion");
	}
	const automatic = subject.definitions.filter((entry) => !requiresHumanJudgment(entry.evaluation));
	const evaluations = list(value.evaluations, "package evaluation reports", 128).map((raw) => {
		object(raw, ["evaluation", "procedureDigest", "environment", "workload", "outcome", "report", "independenceReason", "reviewer"], "package evaluation");
		const ref = reference(raw.evaluation);
		const definition = automatic.find((entry) => refKey(entry) === refKey(ref))?.evaluation;
		if (!definition || raw.procedureDigest !== definition.procedure.digest
			|| raw.environment !== definition.environment || raw.workload !== definition.workload) {
			fail("parallel_assurance_evaluator", "Report changed the pinned evaluator, environment or workload; human judgments are separate");
		}
		const reviewer = text(raw.reviewer, "evaluation reviewer", 512);
		const kind = definition.visual ? "visual" : definition.modality === "boundary" || definition.preservation ? "architecture" : "implementation";
		if (definition.independent && (subject.authors.includes(reviewer)
			|| !subject.reviews.some((entry) => entry.kind === kind && entry.required && entry.reviewers.includes(reviewer)))) {
			fail("parallel_review_independence", "Independent evaluation requires an authorized reviewer distinct from the author");
		}
		const outcome = enumeration(raw.outcome, ["passed", "failed", "inconclusive"], "evaluation outcome");
		if (definition.procedure.kind === "reference" && outcome !== "inconclusive") fail("factory_evaluator_unsupported", "References cannot stand in for executed checks");
		const report = text(raw.report, "evaluation findings", 16000);
		visualReport(definition, report, subject.delivery.commit, outcome);
		return { evaluation: ref, procedureDigest: definition.procedure.digest, environment: definition.environment,
			workload: definition.workload, outcome, report, reviewer, independenceReason: text(raw.independenceReason, "independence reason", 2048) };
	});
	if (evaluations.length !== automatic.length || new Set(evaluations.map((entry) => refKey(entry.evaluation))).size !== automatic.length) {
		fail("parallel_assurance_coverage", "Every executable evaluator needs exactly one report");
	}
	const required = subject.reviews.filter((entry) => entry.required);
	const reviews = list(value.reviews, "independent reviews", 4).map((raw) => {
		object(raw, ["kind", "author", "reviewer", "commit", "scope", "outcome", "findings"], "independent review");
		const kind = enumeration(raw.kind, REVIEW_KINDS, "review kind");
		const obligation = required.find((entry) => entry.kind === kind);
		if (!obligation || raw.author !== subject.producer || subject.authors.includes(text(raw.reviewer, "reviewer", 512))
			|| !obligation.reviewers.includes(text(raw.reviewer, "reviewer", 512))
			|| raw.commit !== subject.delivery.commit || !sameRefs(list(raw.scope, "review scope", 128).map(reference), subject.requirements)) {
			fail("parallel_review_independence", "Review must identify an authorized independent reviewer, exact commit and complete requirement scope");
		}
		const findings = list(raw.findings, "substantive review findings", 128, 1).map((finding) => {
			object(finding, ["requirement", "output", "observation", "evidence"], "review finding");
			const requirement = finding.requirement === undefined ? null : reference(finding.requirement);
			const output = finding.output === undefined ? null : identifier(finding.output);
			if ((requirement === null) === (output === null)
				|| (requirement && !subject.requirements.some((ref) => refKey(ref) === refKey(requirement)))
				|| (output && !subject.delivery.outputs.some((entry) => entry.id === output))) {
				fail("parallel_review_scope", "Review findings must name an exact requirement or declared output");
			}
			return { requirement, output, observation: text(finding.observation, "review observation", 2048),
				evidence: text(finding.evidence, "review evidence source", 4096) };
		});
		if (subject.requirements.some((ref) => !findings.some((finding) => finding.requirement && refKey(finding.requirement) === refKey(ref)))
			|| (!subject.requirements.length && subject.delivery.outputs.some((output) => !findings.some((finding) => finding.output === output.id)))) {
			fail("parallel_review_scope", "Status acknowledgements cannot replace substantive requirement findings");
		}
		return { kind, author: subject.producer, reviewer: text(raw.reviewer, "reviewer", 512), commit: subject.delivery.commit,
			scope: subject.requirements, findings, outcome: enumeration(raw.outcome, ["passed", "failed", "inconclusive"], "review outcome") };
	});
	if (reviews.length !== required.length || new Set(reviews.map((entry) => entry.kind)).size !== required.length) {
		fail("parallel_review_required", "Missing independent review is missing evidence");
	}
	const pendingHuman = subject.definitions.filter((entry) => requiresHumanJudgment(entry.evaluation)).map(({ id, revision }) => ({ id, revision }));
	const executablePassed = evaluations.every((entry) => entry.outcome === "passed") && reviews.every((entry) => entry.outcome === "passed");
	return { subjectDigest, observedAt, authority: subject.bindings.authority, evaluations, reviews, pendingHuman,
		executablePassed, passed: !pendingHuman.length && executablePassed,
		trust: /** @type {const} */ ("independent-claim") };
}
