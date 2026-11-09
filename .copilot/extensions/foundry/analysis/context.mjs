import { isList, isOneOf, isRecord } from "../data.mjs";
import { requiresHumanJudgment } from "../factory/definitions.mjs";
import { validateFactoryBinding, validateFactoryEvaluations } from "../plan/schemas/factory.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { plainObject, stringList, text } from "./fields.mjs";
import { fail } from "../errors.mjs";

/** @typedef {import("../types/analysis.js").VerificationFactory} VerificationFactory */
/** @typedef {import("../types/factory.js").EvaluationDefinition} EvaluationDefinition */
/** @typedef {import("../types/factory.js").KnowledgeRef} KnowledgeRef */

/** Validates without rebuilding JSON: the frozen digest includes unconsumed metadata too.
 * @param {Record<string, unknown>} factory
 * @returns {asserts factory is Record<string, unknown> & VerificationFactory}
 */
export function validateFrozenFactoryContext(factory) {
	validateFactoryBinding(factory.binding);
	validateFactoryEvaluations(factory.evaluations);
	const binding = factory.binding;
	if (!binding) fail("invalid_analysis_input", "Factory verification requires its binding");
	if (factory.context === undefined) {
		if (binding.candidateId) fail("invalid_analysis_input", "Candidate verification requires frozen governing definitions");
		return;
	}
	const context = plainObject(factory.context, "factory.context");
	if (context.version !== 1 || stableStringify(context).length > 256 * 1024
		|| Object.keys(context).some((key) => !["version", "definitions", "humanEvidence", "observations"].includes(key))) fail("invalid_analysis_input", "Invalid bounded factory verification snapshot");
	const definitions = plainObject(context.definitions, "factory definitions");
	const unit = plainObject(definitions.unit, "factory unit");
	if (unit.id !== binding.unitId || unit.revision !== binding.unitRevision) fail("analysis_input_mismatch", "Frozen boundary revision differs from the plan binding");
	text(unit.name, "frozen unit name", 160);
	text(unit.purpose, "frozen unit purpose", 8000);
	const boundary = plainObject(unit.boundary, "frozen unit boundary");
	for (const field of ["owns", "exposes", "consumes", "preserves"]) stringList(boundary[field], `boundary.${field}`, 32, 2048, field === "consumes" ? 0 : 1);
	stringList(unit.dependencies, "frozen unit dependencies", 32, 96);
	/** @param {unknown} ref @returns {KnowledgeRef} */
	const reference = (ref) => {
		const value = plainObject(ref, "frozen knowledge reference");
		const id = text(value.id, "frozen knowledge ID", 96);
		if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(id)
			|| typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) fail("invalid_analysis_input", "Frozen references require stable IDs and positive revisions");
		return { id, revision: value.revision };
	};
	/** @param {unknown} ref */
	const refKey = (ref) => { const value = reference(ref); return `${value.id}@${value.revision}`; };
	/** @param {"obligations" | "evaluations" | "rationale"} field @returns {Array<KnowledgeRef & Record<string, unknown>>} */
	const knowledgeList = (field) => {
		const entries = definitions[field];
		if (!isList(entries) || entries.length > (field === "rationale" ? 128 : 32)) fail("invalid_analysis_input", `Frozen ${field} must be bounded`);
		return entries.map((raw) => {
			const entry = plainObject(raw, `frozen ${field}`);
			const ref = reference(entry);
			if (entry.authority !== (field === "rationale" ? "non-governing" : "accepted")) fail("invalid_analysis_input", `Invalid authority in frozen ${field}`);
			text(entry.statement, "frozen statement", 8000);
			if (field === "obligations" && (entry.kind !== "obligation" || entry.unitId !== unit.id)) fail("invalid_analysis_input", "Frozen obligations must belong to this unit");
			return { ...entry, ...ref };
		});
	};
	const obligations = knowledgeList("obligations");
	const evaluations = knowledgeList("evaluations");
	knowledgeList("rationale");
	const contract = definitions.contract;
	if (binding.contractDigest !== null) {
		if (!isRecord(contract) || contract.digest !== binding.contractDigest || contract.unitId !== binding.unitId
			|| contract.revision !== binding.contractRevision || contract.unitRevision !== unit.revision
			|| !isList(contract.obligations) || !contract.obligations.length || contract.obligations.length > 32
			|| !isList(contract.evaluations) || !contract.evaluations.length || contract.evaluations.length > 32
			|| !evaluations.length
			|| stableStringify(contract.obligations.map(refKey).sort()) !== stableStringify(obligations.map(refKey).sort())) {
			fail("analysis_input_mismatch", "Frozen definitions must refer to the exact accepted contract");
		}
		const accepted = contract.evaluations.map(refKey);
		if (evaluations.some((entry) => !accepted.includes(refKey(entry)))) fail("analysis_input_mismatch", "Frozen definitions must refer to the exact accepted contract");
	} else if (contract !== null || obligations.length || evaluations.length) fail("invalid_analysis_input", "Discovery cannot invent accepted definitions");
	if (new Set(evaluations.map(refKey)).size !== evaluations.length) fail("invalid_analysis_input", "Frozen evaluations contain duplicate revisions");
	const evaluators = evaluations.map((entry) => {
		const evaluation = plainObject(entry.evaluation, "frozen evaluation");
		const procedure = plainObject(evaluation.procedure, "frozen procedure");
		if (entry.kind !== "evaluation" || entry.unitId !== unit.id
			|| !isOneOf(evaluation.modality, ["implementation-test", "boundary", "operational", "human"])
			|| !isOneOf(procedure.kind, ["command", "reference", "judgment"]) || typeof procedure.digest !== "string" || !/^[a-f0-9]{64}$/.test(procedure.digest)
			|| !isList(evaluation.obligations) || !evaluation.obligations.length
			|| evaluation.obligations.some((ref) => !obligations.some((obligation) => refKey(obligation) === refKey(ref)))
			|| typeof evaluation.independent !== "boolean" || typeof evaluation.preservation !== "boolean"
			|| typeof evaluation.maxAgeSeconds !== "number" || !Number.isSafeInteger(evaluation.maxAgeSeconds) || evaluation.maxAgeSeconds < 1 || evaluation.maxAgeSeconds > 31536000
			|| ((evaluation.modality === "boundary" || evaluation.preservation) && !evaluation.independent)) fail("invalid_analysis_input", "Invalid pinned evaluator definition");
		/** @type {EvaluationDefinition} */
		const checked = {
			modality: evaluation.modality, procedure: { kind: procedure.kind, digest: procedure.digest, ref: text(procedure.ref, "frozen procedure reference", 4096) },
			obligations: evaluation.obligations.map(reference), independent: evaluation.independent,
			preservation: evaluation.preservation, maxAgeSeconds: evaluation.maxAgeSeconds,
			environment: text(evaluation.environment, "frozen environment", 2048), workload: text(evaluation.workload, "frozen workload", 2048),
		};
		return { ...entry, evaluation: checked };
	});
	const automatic = evaluators.filter((entry) => !requiresHumanJudgment(entry.evaluation));
	if (binding.candidateId && (factory.evaluations.length !== automatic.length
		|| factory.evaluations.some((report) => !automatic.some((entry) => refKey(entry) === refKey(report.evaluation) && entry.evaluation.procedure.digest === report.procedureDigest)))) {
		fail("invalid_analysis_input", "Executable reports do not cover the frozen pinned evaluators");
	}
	if (context.observations !== undefined) {
		if (!isList(context.observations) || context.observations.length > 32) fail("invalid_analysis_input", "Plan observations must be bounded");
		for (const raw of context.observations) {
			const observation = plainObject(raw, "plan observation");
			if (!automatic.some((entry) => refKey(entry) === refKey(observation.evaluation))
				|| !isOneOf(observation.disposition, ["current", "historical", "duplicate-origin", "conflicting", "corroborating"])) fail("invalid_analysis_input", "Plan observation does not identify a pinned evaluator and publication disposition");
			text(observation.receiptId, "observation receipt ID", 96);
			for (const field of ["observedAt", "publishedAt"]) {
				if (typeof observation[field] !== "string" || !Number.isFinite(Date.parse(observation[field]))
					|| new Date(observation[field]).toISOString() !== observation[field]) fail("invalid_analysis_input", "Observation and publication timestamps must be explicit ISO instants");
			}
			if (observation.currentEvidenceId !== null) text(observation.currentEvidenceId, "current evidence ID", 96);
		}
	}
	if (!isList(context.humanEvidence) || context.humanEvidence.length > 32) fail("invalid_analysis_input", "Human evidence must be bounded");
	const humanIds = new Set();
	for (const raw of context.humanEvidence) {
		const evidence = plainObject(raw, "human evidence");
		const evidenceRef = refKey(evidence.evaluation);
		const definition = evaluators.find((entry) => refKey(entry) === evidenceRef);
		const source = plainObject(evidence.source, "human source");
		const independence = plainObject(evidence.independence, "human independence");
		if (!definition || !requiresHumanJudgment(definition.evaluation) || humanIds.has(evidenceRef)
			|| source.kind !== "human" || independence.method !== "human-review"
			|| evidence.contractDigest !== binding.contractDigest || evidence.contextDigest !== binding.contextDigest
			|| evidence.candidateId !== binding.candidateId || evidence.procedureDigest !== definition.evaluation.procedure.digest
			|| !isOneOf(evidence.outcome, ["passed", "failed", "inconclusive"])) fail("invalid_analysis_input", "Only explicit, attributable human evidence can satisfy a human evaluator");
		humanIds.add(evidenceRef);
		text(source.actor, "human actor", 256);
		text(source.ref, "human source", 4096);
		text(evidence.candidateId, "human candidate", 96);
		text(evidence.contractDigest, "human contract digest", 64);
		text(evidence.contextDigest, "human context digest", 64);
		text(evidence.report, "human report", 16000);
		text(evidence.environment, "human environment", 2048);
		text(evidence.workload, "human workload", 2048);
		if (evidence.reportDigest !== analysisInputDigest(evidence.report)
			|| !isOneOf(evidence.trust, ["claimed", "independent-claim"])
			|| typeof evidence.commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(evidence.commit)
			|| typeof source.at !== "string" || !Number.isFinite(Date.parse(source.at))
			|| new Date(source.at).toISOString() !== source.at) fail("invalid_analysis_input", "Human evidence identity, content digest or timestamp is invalid");
	}
}
