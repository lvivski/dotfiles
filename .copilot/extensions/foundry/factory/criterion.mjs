import { key as refKey } from "./records.mjs";
import { visualCriterion } from "./visual.mjs";

/** @param {import("../types/factory.js").ProjectedEvaluation} entry */
export const evaluationCriterion = (entry) => entry.evaluation.visual ? visualCriterion(entry)
	: `Pass pinned ${entry.evaluation.modality} evaluation ${refKey(entry)} (${entry.evaluation.procedure.digest}).`;
