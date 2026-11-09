import { FoundryAnalysisError } from "../errors.mjs";
import { buildPlanningArgs, validatePlanningArgs, validatePlanningResult } from "../analysis/planning.mjs";
import { extractSimplificationProposals } from "../analysis/verdicts.mjs";
import { FOUNDRY_WORKFLOWS } from "../workflows/registry.mjs";
import { fail } from "./guards.mjs";

/**
 * @param {ReturnType<typeof import("./reader.mjs").createRunReader>["loadRun"]} loadRun
 * @param {ReturnType<typeof import("./reader.mjs").createRunReader>["settleRun"]} settleRun
 */
export function createPlanningWorkflow(loadRun, settleRun) {

	/** Build the exact native planning Workflow invocation. @param {unknown} input */
	const preparePlanning = async (input) => {
		const args = buildPlanningArgs(input);
		const specification = FOUNDRY_WORKFLOWS.plan;
		return {
			workflow: specification.meta.name,
			inputDigest: args.inputDigest,
			launchSpec: {
				name: specification.meta.name,
				args,
			},
		};
	};

	/**
	 * Wait for and validate a planning result without starting or resuming its run.
	 * @param {string} runId
	 * @param {{signal?: AbortSignal}} [options]
	 */
	const importPlanning = async (runId, options = {}) => {
		const inspected = await loadRun(runId, FOUNDRY_WORKFLOWS.plan);
		const { run } = await settleRun(runId, FOUNDRY_WORKFLOWS.plan, inspected, options);
		const result = run.result;
		if (!result || typeof result !== "object" || Array.isArray(result)) {
			fail("workflow_result_invalid", `Workflow run ${runId} returned no planning object`);
		}
		const persistedInput = result.input;
		if (!persistedInput || typeof persistedInput !== "object" || Array.isArray(persistedInput)) {
			fail("workflow_input_missing", `Planning run ${runId} did not return its canonical input`);
		}
		let normalized;
		try {
			normalized = validatePlanningArgs(persistedInput);
		} catch (error) {
			if (error instanceof FoundryAnalysisError && error.code === "analysis_input_mismatch") {
				fail("workflow_input_mismatch", `Planning run ${runId} carries an invalid input digest`);
			}
			throw error;
		}
		const { inputDigest } = normalized;
		if (result.inputDigest !== inputDigest) {
			fail("workflow_input_mismatch", `Planning run ${runId} carries an invalid input digest`);
		}
		const conceptualReview = extractSimplificationProposals(result.critiques);
		return {
			runId,
			inputDigest,
			...(conceptualReview ? { conceptualReview } : {}),
			...(normalized.factoryContext ? { factoryContext: normalized.factoryContext } : {}),
			plan: validatePlanningResult(result, normalized, normalized.maxTasks),
		};
	};
	return { preparePlanning, importPlanning };
}
