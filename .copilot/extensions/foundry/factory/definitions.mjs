import { property } from "../data.mjs";
import { digest, enumeration, fail, integer, list, object, reference, text, timestamp } from "./fields.mjs";
import { key, knowledgeFor } from "./records.mjs";
import { evaluatorBundle } from "./procedures.mjs";

/** @typedef {import("../types/factory.js").FactoryState} FactoryState */
/** @typedef {import("../types/factory.js").EvaluationDefinition} EvaluationDefinition */
/** @typedef {import("../types/factory.js").Provenance} Provenance */

/** @type {import("../types/factory.js").SourceKind[]} */
const SOURCE_KINDS = [
	"discovery", "implementation", "audit", "research", "review", "security", "triage",
	"command", "human", "operational", "app-task", "external-run", "native-workflow",
];

/** @type {EvaluationDefinition["modality"][]} */
const MODALITIES = ["implementation-test", "boundary", "operational", "human"];

/** @param {unknown} value @param {string} at @returns {Provenance} */
export function source(value, at) {
	object(value, ["kind", "ref", "actor", "at", "sessionId", "planId", "taskId", "attemptId", "runId", "owner", "digest", "judgmentId"], "source");
	/** @type {Provenance} */
	const result = {
		kind: enumeration(value.kind, SOURCE_KINDS, "source.kind"),
		ref: text(value.ref, "source.ref", 4096),
		actor: text(value.actor, "source.actor", 256),
		at: timestamp(value.at, "source.at"),
	};
	if (Date.parse(result.at) > Date.parse(at)) fail("factory_provenance_future", "Source evidence cannot be dated after its capture");
	for (const field of /** @type {const} */ (["sessionId", "planId", "taskId", "attemptId", "runId", "owner", "judgmentId"])) {
		if (value[field] !== undefined) result[field] = text(value[field], `source.${field}`, field === "owner" ? 4096 : 512);
	}
	if (value.digest !== undefined) result["digest"] = digest(value.digest, "source.digest");
	if (result.kind === "app-task"
		&& ["sessionId", "planId", "taskId", "attemptId", "owner"].some((field) => !property(result, field))) {
		fail("factory_provenance_incomplete", "App task provenance requires owner, plan, task, attempt and session identities");
	}
	if (["external-run", "native-workflow"].includes(result.kind) && (!result["runId"] || !result["owner"])) {
		fail("factory_provenance_incomplete", "Run provenance requires runId and owner; it never conveys native run ownership");
	}
	return result;
}

/** @param {unknown} value @returns {import("../types/factory.js").ContextArtifact} */
export function artifact(value) {
	object(value, ["kind", "ref", "digest"], "context artifact");
	return {
		kind: enumeration(value.kind, ["knowledge", "schema", "test", "reference", "foundation", "implementation", "data"], "artifact.kind"),
		ref: text(value.ref, "artifact.ref", 4096),
		digest: digest(value.digest, "artifact.digest"),
	};
}

/** @param {unknown} value @param {FactoryState} state @param {string} unitId @returns {EvaluationDefinition} */
export function evaluation(value, state, unitId) {
	object(value, ["modality", "procedure", "obligations", "environment", "workload", "maxAgeSeconds", "independent", "preservation"], "evaluation");
	object(value.procedure, ["kind", "ref", "digest", "bundle"], "evaluation.procedure");
	const kind = enumeration(value.procedure.kind, ["command", "reference", "judgment"], "procedure.kind");
	if (value.procedure.bundle !== undefined && (kind !== "command" || value.modality === "human")) {
		fail("factory_evaluation_modality", "Executable bundles cannot relabel a human rubric or non-executable reference");
	}
	const refs = list(value.obligations, "evaluation.obligations", 32, 1).map(reference);
	if (new Set(refs.map(key)).size !== refs.length) fail("factory_input_invalid", "Evaluation obligations contain duplicates");
	for (const ref of refs) {
		const obligation = knowledgeFor(state, ref);
		if (obligation.unitId !== unitId || obligation.kind !== "obligation") fail("factory_contract_invalid", "Evaluation must refer to this unit's obligation revisions");
	}
	if (typeof value.independent !== "boolean" || typeof value.preservation !== "boolean") {
		fail("factory_input_invalid", "Evaluation independent and preservation must be booleans");
	}
	const modality = enumeration(value.modality, MODALITIES, "evaluation.modality");
	if ((modality === "boundary" || value.preservation) && !value.independent) {
		fail("factory_independence_required", "Boundary and preservation evaluations require independent evidence");
	}
	return {
		modality,
		procedure: {
			kind,
			ref: text(value.procedure.ref, "procedure.ref", 4096),
			digest: digest(value.procedure.digest, "procedure.digest"),
			...(value.procedure.bundle === undefined ? {} : { bundle: evaluatorBundle(value.procedure.bundle) }),
		},
		obligations: refs,
		environment: text(value.environment, "evaluation.environment", 2048),
		workload: text(value.workload, "evaluation.workload", 2048),
		maxAgeSeconds: integer(value.maxAgeSeconds, "evaluation.maxAgeSeconds", 1, 31536000),
		independent: value.independent,
		preservation: value.preservation,
	};
}

/** @param {import("../types/factory.js").EvaluationDefinition} definition */
export const requiresHumanJudgment = (definition) => definition.modality === "human" || definition.procedure.kind === "judgment";
