import { FoundryAnalysisError } from "../errors.mjs";
import { buildPlanningArgs, validatePlanningArgs, validatePlanningResult } from "../analysis/planning.mjs";
import { extractSimplificationProposals } from "../analysis/verdicts.mjs";
import { FOUNDRY_WORKFLOWS } from "../workflows/registry.mjs";
import { fail } from "./guards.mjs";
import { authenticateRepairEvidence, inlineRepairEvidence } from "./repair.mjs";
import { compareRepairProgress } from "../analysis/repair.mjs";
import { isRecord } from "../data.mjs";
import { pendingWorkflow } from "./reader.mjs";

/**
 * @param {ReturnType<typeof import("./reader.mjs").createRunReader>["loadRun"]} loadRun
 * @param {ReturnType<typeof import("./reader.mjs").createRunReader>["settleRun"]} settleRun
 * @param {import("../types/repair.js").RepairHostPort} [repairHost]
 */
export function createPlanningWorkflow(loadRun, settleRun, repairHost) {

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
	 * Inspect once; import only an exact completed result without starting or resuming its run.
	 * @param {string} runId
	 * @param {{signal?: AbortSignal}} [options]
	 */
	const importPlanning = async (runId, options = {}) => {
		options.signal?.throwIfAborted();
		const inspected = await loadRun(runId, FOUNDRY_WORKFLOWS.plan);
		options.signal?.throwIfAborted();
		const pending = pendingWorkflow(inspected.run, inspected.detail);
		if (pending) return pending;
		const { run, detail } = await settleRun(runId, FOUNDRY_WORKFLOWS.plan, inspected, options);
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
		const repair = inlineRepairEvidence(result, detail);
		if (repair?.recovery) {
			await authenticateRepairEvidence(repairHost, repair.recovery);
			const recovery = repair.recovery;
			if (!Array.isArray(recovery.history) || !compareRepairProgress(recovery.comparison, recovery.history).passed) fail("repair_result_invalid", "Inline repair lacks conserved substantive progress");
		}
		return {
			runId,
			inputDigest,
			...(conceptualReview ? { conceptualReview } : {}),
			...(normalized.factoryContext ? { factoryContext: normalized.factoryContext } : {}),
			...(repair ? { repair } : {}),
			plan: validatePlanningResult(result, normalized, normalized.maxTasks),
		};
	};
	return { preparePlanning, importPlanning };
}
