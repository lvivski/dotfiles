import { parseJson } from "../data.mjs";
import { COMMIT, digest, enumeration, fail, identifier, list, object, reference, text, timestamp } from "./fields.mjs";
import { repositoryPath } from "./procedures.mjs";
import { knowledgeFor } from "./records.mjs";

export const VISUAL_AXES = ["composition", "navigation", "paneBoundaries", "hierarchyDensity", "typography", "actionPlacement"];

/** @param {unknown} value @returns {import("../types/factory.js").VisualSpecification} */
export function visualSpecification(value) {
	object(value, ["capture", "states"], "visual");
	const states = list(value.states, "visual.states", undefined, 1).map((entry) => {
		object(entry, ["id", "intent", "reference"], "visual state");
		object(entry.reference, ["path", "digest"], "visual reference");
		return {
			id: identifier(entry.id), intent: text(entry.intent, "visual state intent"),
			reference: { path: repositoryPath(entry.reference.path, "visual reference path"), digest: digest(entry.reference.digest, "visual reference digest") },
		};
	});
	if (new Set(states.map((entry) => entry.id)).size !== states.length) fail("factory_visual_invalid", "Visual state IDs must be unique");
	return { capture: text(value.capture, "visual.capture"), states };
}

/** @param {import("../types/factory.js").FactoryState} state @param {import("../types/factory.js").CapabilityUnit} unit */
export function declaredVisual(state, unit) {
	if (!unit.visualEvaluation) return null;
	const entry = knowledgeFor(state, unit.visualEvaluation);
	if (entry.unitId !== unit.id || entry.kind !== "evaluation" || !entry.evaluation?.visual) {
		fail("factory_visual_required", "UI applicability must name this unit's exact visual evaluator revision");
	}
	return { id: entry.id, revision: entry.revision, statement: entry.statement, evaluation: entry.evaluation };
}

/** @param {unknown} entry */
export function visualCriterion(entry) {
	object(entry, ["id", "revision", "statement", "evaluation", "authority", "unitId", "kind", "uncertainty", "links"], "visual gate");
	const ref = reference({ id: entry.id, revision: entry.revision });
	object(entry.evaluation, ["modality", "procedure", "obligations", "environment", "workload", "maxAgeSeconds", "independent", "preservation", "visual"], "visual evaluation");
	object(entry.evaluation.procedure, ["kind", "ref", "digest", "bundle"], "visual procedure");
	visualSpecification(entry.evaluation.visual);
	return `Pass declared visual fidelity evaluation ${ref.id}@${ref.revision} (${digest(entry.evaluation.procedure.digest, "visual procedure digest")}) using real output captures and independent reference-to-output assessment.`;
}

/** The report records visual inspection claims, not authenticated capture or perception.
 * @param {import("../types/factory.js").EvaluationDefinition} definition
 * @param {string} report @param {string} commit @param {string} outcome */
export function visualReport(definition, report, commit, outcome) {
	if (!definition.visual) return null;
	let value;
	try { value = parseJson(report); }
	catch { fail("factory_visual_required", "Visual evaluation needs a structured foundry-visual-report-v1, not source/control/geometry-only success"); }
	object(value, ["format", "deliveryCommit", "environment", "states"], "visual report");
	if (value.format !== "foundry-visual-report-v1" || !COMMIT.test(commit)
		|| value.deliveryCommit !== commit || value.environment !== definition.environment) {
		fail("factory_visual_mismatch", "Visual captures must bind the exact delivered commit and declared environment");
	}
	const states = list(value.states, "visual report states", undefined, 1).map((entry) => {
		object(entry, ["id", "referenceDigest", "capture", "blocker", "assessment"], "visual report state");
		const expected = definition.visual?.states.find((state) => state.id === entry.id);
		if (!expected || entry.referenceDigest !== expected.reference.digest) fail("factory_visual_mismatch", "Visual report changed its declared state or reference identity");
		let capture = null;
		if (entry.capture === null) {
			text(entry.blocker, "visual capture blocker");
			if (outcome === "passed") fail("factory_visual_required", "Missing or permission-blocked capture cannot pass");
		} else {
			if (entry.blocker !== undefined) fail("factory_visual_contradiction", "An unresolved capture blocker cannot accompany an available capture");
			object(entry.capture, ["path", "digest", "capturedAt", "method", "viewport"], "visual capture");
			capture = {
				path: text(entry.capture.path, "capture.path"), digest: digest(entry.capture.digest, "capture.digest"),
				capturedAt: timestamp(entry.capture.capturedAt, "capture.capturedAt"),
				method: enumeration(entry.capture.method, ["native-screenshot", "browser-screenshot"], "capture.method"),
				viewport: text(entry.capture.viewport, "capture.viewport"),
			};
		}
		object(entry.assessment, VISUAL_AXES, "visual assessment");
		const rawAssessment = entry.assessment;
		const assessment = VISUAL_AXES.map((axis) => {
			const finding = rawAssessment[axis];
			object(finding, ["outcome", "finding"], `visual assessment.${axis}`);
			return { outcome: enumeration(finding.outcome, ["passed", "failed", "inconclusive"], `visual ${axis} outcome`), finding: text(finding.finding, `visual ${axis} finding`) };
		});
		return { id: expected.id, capture, assessment };
	});
	if (states.length !== definition.visual.states.length || new Set(states.map((entry) => entry.id)).size !== states.length) {
		fail("factory_visual_required", "Visual evaluation must cover every declared ordinary/empty/error state without omissions or duplicates");
	}
	const passed = states.every((entry) => entry.capture && entry.assessment.every((finding) => finding.outcome === "passed"));
	if ((outcome === "passed") !== passed) fail("factory_visual_contradiction", "Visual outcome contradicts capture availability or independent findings");
	return states;
}
