import { isList, isOneOf } from "../../data.mjs";
import { assertCommit, assertKnownKeys, assertNullableString, assertPlainObject, assertString, assertStringArray, fail } from "../fields.mjs";
import { LIMITS } from "../values.mjs";

/** @typedef {import("../../types/plan.js").EvaluationTarget} EvaluationTarget */

/** @param {unknown} factory @returns {asserts factory is import("../../types/plan.js").PlanFactoryBinding | null | undefined} */
export function validateFactoryBinding(factory) {
	if (factory == null) return;
	assertPlainObject(factory, "factory");
	assertKnownKeys(factory, new Set(["repositoryId", "unitId", "unitRevision", "candidateId", "contractRevision", "contractDigest", "contextDigest", "blueprintDigest", "owner", "purpose"]), "factory");
	if (factory.purpose !== undefined && !isOneOf(factory.purpose, ["generation", "evaluation"])) fail("invalid_factory_binding", "Factory purpose must be generation or evaluation");
	for (const field of ["repositoryId", "blueprintDigest"]) {
		if (typeof factory[field] !== "string" || !/^[a-f0-9]{64}$/.test(factory[field])) fail("invalid_factory_binding", `factory.${field} must be a SHA-256 digest`);
	}
	for (const field of ["unitId", "owner"]) assertString(factory[field], `factory.${field}`, field === "owner" ? 4096 : 96);
	assertNullableString(factory.candidateId, "factory.candidateId", 96);
	if (typeof factory.unitRevision !== "number" || !Number.isSafeInteger(factory.unitRevision) || factory.unitRevision < 1) fail("invalid_factory_binding", "Factory unitRevision is required");
	for (const field of ["contractDigest", "contextDigest"]) {
		if (factory[field] !== null && (typeof factory[field] !== "string" || !/^[a-f0-9]{64}$/.test(factory[field]))) fail("invalid_factory_binding", `factory.${field} is invalid`);
	}
	if (factory.contractRevision !== null && (typeof factory.contractRevision !== "number" || !Number.isSafeInteger(factory.contractRevision) || factory.contractRevision < 1)) fail("invalid_factory_binding", "Factory contractRevision is invalid");
	if (factory.candidateId !== null && (!factory.contractRevision || !factory.contractDigest || !factory.contextDigest)) fail("invalid_factory_binding", "Candidates require pinned contract and context identities");
}

/** @param {unknown} target @returns {asserts target is EvaluationTarget | null | undefined} */
export function validateEvaluationTarget(target) {
	if (target == null) return;
	assertPlainObject(target, "evaluationTarget");
	assertKnownKeys(target, new Set(["candidateId", "commit", "criteria", "evaluations"]), "evaluationTarget");
	assertString(target.candidateId, "evaluationTarget.candidateId", 96);
	assertCommit(target.commit, "evaluationTarget.commit");
	if (target.commit === null) fail("invalid_evaluation_target", "Read-only evaluation requires the exact delivered commit");
	assertStringArray(target.criteria, "evaluationTarget.criteria", { minimum: 1, maximum: 32, itemMaximum: LIMITS.acceptanceCriterion });
	if (!isList(target.evaluations) || target.evaluations.length < 1 || target.evaluations.length > 32) fail("invalid_evaluation_target", "Evaluation references must be bounded and nonempty");
	const refs = new Set();
	for (const ref of target.evaluations) {
		assertPlainObject(ref, "evaluation reference");
		assertKnownKeys(ref, new Set(["id", "revision"]), "evaluation reference");
		assertString(ref.id, "evaluation id", 96);
		if (typeof ref.revision !== "number" || !Number.isSafeInteger(ref.revision) || ref.revision < 1) fail("invalid_evaluation_target", "Evaluation revision must be positive");
		const key = `${ref.id}@${ref.revision}`;
		if (refs.has(key)) fail("invalid_evaluation_target", "Evaluation references must be unique");
		refs.add(key);
	}
}

/** @param {unknown} learning @returns {asserts learning is import("../../types/plan.js").Learning[]} */
export function validateFactoryLearning(learning) {
	if (!isList(learning) || learning.length > 32) fail("invalid_factory_learning", "Learning must be a bounded list");
	for (const entry of learning) {
		assertPlainObject(entry, "learning");
		assertKnownKeys(entry, new Set(["kind", "statement", "uncertainty"]), "learning");
		if (!isOneOf(entry.kind, ["observation", "inference", "proposal"])) fail("invalid_factory_learning", "Implementation learning cannot establish governing obligations");
		assertString(entry.statement, "learning.statement", 8000);
		assertNullableString(entry.uncertainty ?? null, "learning.uncertainty", 8000);
	}
}

/** @param {unknown} evaluations @returns {asserts evaluations is import("../../types/plan.js").EvaluationReport[]} */
export function validateFactoryEvaluations(evaluations) {
	if (!isList(evaluations) || evaluations.length > 32) fail("invalid_factory_evidence", "Factory evaluations must be a bounded list");
	const refs = new Set();
	for (const entry of evaluations) {
		assertPlainObject(entry, "factoryEvaluation");
		assertKnownKeys(entry, new Set(["evaluation", "procedureDigest", "environment", "workload", "outcome", "report", "independenceReason"]), "factoryEvaluation");
		assertPlainObject(entry.evaluation, "factoryEvaluation.evaluation");
		assertKnownKeys(entry.evaluation, new Set(["id", "revision"]), "factoryEvaluation.evaluation");
		assertString(entry.evaluation.id, "evaluation.id", 96);
		if (typeof entry.evaluation.revision !== "number" || !Number.isSafeInteger(entry.evaluation.revision) || entry.evaluation.revision < 1) fail("invalid_factory_evidence", "Evaluation revision is invalid");
		const ref = `${entry.evaluation.id}@${entry.evaluation.revision}`;
		if (refs.has(ref)) fail("invalid_factory_evidence", "Evaluation reports must be unique");
		refs.add(ref);
		if (typeof entry.procedureDigest !== "string" || !/^[a-f0-9]{64}$/.test(entry.procedureDigest)) fail("invalid_factory_evidence", "Evaluation procedureDigest is required");
		if (!isOneOf(entry.outcome, ["passed", "failed", "inconclusive"])) fail("invalid_factory_evidence", "Evaluation outcome is invalid");
		for (const field of ["environment", "workload", "report", "independenceReason"]) {
			assertString(entry[field], `factoryEvaluation.${field}`, field === "report" ? 16000 : 2048);
		}
	}
}
