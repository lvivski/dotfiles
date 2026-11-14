import { checkRepairConservation, closedRepairObject, repairMaterial, repairObject, repairOutcome } from "../analysis/repair.mjs";
import { validatePlanningArgs, validatePlanningResult, validatePlanBlueprint } from "../analysis/planning.mjs";
import { extractSimplificationProposals } from "../analysis/verdicts.mjs";
import { isRecord, readJsonValue } from "../data.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { assertRunId, fail } from "./guards.mjs";

/** @typedef {import("./reader.mjs").WorkflowInspectionApi} Api */
/** @typedef {import("../types/repair.js").RepairPreparation} Preparation */
/** @typedef {import("../types/repair.js").RepairSource} Source */
/** @typedef {import("@github/copilot-sdk").WorkflowRunDetail} Detail */

/** Native agent identities corroborate the registered recipe; result text alone cannot.
 * @param {Detail} detail @param {string[]} labels */
function agentIdentities(detail, labels) {
	if (!Array.isArray(detail.agents) || detail.agents.length !== labels.length) fail("repair_native_provenance", "Missing or unexpected native planning agent observations");
	const ids = new Set();
	const calls = new Set();
	const agents = labels.map(label => {
		const matches = detail.agents.filter(agent => agent.label === label);
		const agent = matches[0];
		if (matches.length !== 1 || !agent || agent.runId !== detail.runId || agent.status !== "completed"
			|| !agent.agentId || !agent.toolCallId || ids.has(agent.agentId) || calls.has(agent.toolCallId)) {
			fail("repair_native_provenance", "Planning critics, author and verifier must have distinct completed native identities");
		}
		ids.add(agent.agentId); calls.add(agent.toolCallId);
		return { agentId: agent.agentId, toolCallId: agent.toolCallId, label, runId: agent.runId, status: agent.status };
	});
	return agents;
}

/** @param {Api} api @param {string} runId @param {string} name */
async function observe(api, runId, name) {
	assertRunId(runId);
	const [run, detail] = await Promise.all([api.getRun(runId), api.getRunDetail(runId)]);
	if (run.runId !== runId || detail.runId !== runId || detail.workflowName !== name || run.status !== detail.status) {
		fail("repair_native_identity", "Native detail/result identity or registered workflow name differs");
	}
	return { run, detail };
}

/** Read only a complete native source through the invoking owner's API.
 * @param {Api} api @param {string} runId @returns {Promise<Source>} */
export async function readRepairSource(api, runId) {
	const { run, detail } = await observe(api, runId, "plan");
	if (run.status !== "completed" || !Number.isFinite(detail.createdAt) || !Number.isFinite(detail.completedAt)
		|| detail.completedAt === null || detail.completedAt < detail.createdAt) {
		fail("repair_source_ineligible", "Recovery requires a completed registered planning result with native completion identity");
	}
	const result = closedRepairObject(run.result, ["kind", "inputDigest", "input", "status", "plan", "critiques", "verification", "synthesisRepair", "missingPerspectives", "issues", "repairBudget"], "native planning result");
	if (result.kind !== "foundry-plan-result" || result.status !== "needs-review" || result.synthesisRepair !== null
		|| stableStringify(result.missingPerspectives) !== "[]" || !isRecord(result.verification)
		|| result.verification.passed !== false || stableStringify(result.issues) !== stableStringify(result.verification.issues)) {
		fail("repair_source_ineligible", "Only an unused semantic rejection with complete original perspectives is repairable");
	}
	if (result.repairBudget !== undefined) {
		const budget = closedRepairObject(result.repairBudget, ["rootRunId", "used"], "original repair budget");
		if (budget.rootRunId !== runId || budget.used !== false) fail("repair_budget_spent", "Unknown or consumed planning lineage cannot be repaired");
	}
	const input = validatePlanningArgs(result.input);
	if (input.inputDigest !== result.inputDigest) fail("repair_input_mismatch", "Native source input digest differs");
	const plan = validatePlanBlueprint(result.plan, input.maxTasks, input.factoryContext?.visualEvaluation);
	if (stableStringify(plan) !== stableStringify(result.plan) || plan.objective !== input.objective
		|| stableStringify(plan.constraints) !== stableStringify(input.constraints)) fail("repair_input_mismatch", "Native source candidate is not the canonical structurally valid plan");
	const material = repairMaterial({
		input: result.input, candidate: result.plan, critiques: result.critiques, diagnostics: result.issues,
		verification: result.verification, decomposition: null, stage: "semantic",
	});
	const agents = agentIdentities(detail, ["plan:decomposer", "plan:architecture-critic", "plan:delivery-risk-critic", "plan:synthesizer", "plan:verifier"]);
	const source = repairObject(result);
	return {
		runId, inputDigest: input.inputDigest, resultDigest: analysisInputDigest(source), result: source, material,
		native: repairObject({ runId, workflowName: detail.workflowName, createdAt: detail.createdAt, completedAt: detail.completedAt, agents }),
	};
}

/** @param {Preparation} preparation @param {Source} source */
export function assertRepairSource(preparation, source) {
	if (source.runId !== preparation.rootRunId || source.resultDigest !== preparation.sourceDigest
		|| source.inputDigest !== preparation.inputDigest
		|| stableStringify(source.material) !== stableStringify(preparation.material)
		|| stableStringify({ result: source.result, native: source.native }) !== stableStringify(preparation.source)) {
		fail("repair_source_changed", "Source result, critics, input, failure or native lineage differs from its immutable preparation");
	}
}

/** @param {Preparation} preparation */
export const repairMarker = preparation => `foundry-plan-repair:${preparation.id}:${preparation.digest}`;

/** @param {import("../types/json.js").JsonObject} result @param {Detail} detail */
export function inlineRepairEvidence(result, detail) {
	if (result.repairBudget === undefined) return null;
	const budget = repairObject(result.repairBudget);
	if (budget.rootRunId !== detail.runId || typeof budget.used !== "boolean"
		|| budget.used !== (result.synthesisRepair !== null)) fail("repair_native_identity", "Planning budget is not bound to this original native run");
	if (!budget.used) {
		closedRepairObject(budget, ["rootRunId", "used"], "unused planning budget");
		return null;
	}
	const outcome = repairOutcome(Object.fromEntries(["plan", "verification", "synthesisRepair", "issues", "repairBudget"].map(key => [key, result[key]])));
	agentIdentities(detail, [
		"plan:decomposer", "plan:architecture-critic", "plan:delivery-risk-critic", "plan:synthesizer", "plan:verifier",
		...(outcome.synthesisRepair.stage === "structural" ? ["plan:synthesis-repair"] : ["plan:semantic-repair", "plan:conservation-review"]),
	]);
	return outcome;
}

/** @param {() => Api} api */
export function createRepairWorkflow(api) {
	return {
		/** @param {string} runId */
		readPlanningRepairSource: runId => readRepairSource(api(), runId),
		/** @param {string} runId @param {Preparation} preparation */
		async importPlanningRepair(runId, preparation) {
			const source = await readRepairSource(api(), preparation.rootRunId);
			assertRepairSource(preparation, source);
			const { run, detail } = await observe(api(), runId, "plan-repair");
			if (runId === preparation.rootRunId || run.status !== "completed") fail("repair_result_unavailable", "Repair import requires a distinct completed repair-only run");
			const result = closedRepairObject(run.result, [
				"kind", "status", "runId", "sourceRunId", "sourceDigest", "input", "inputDigest", "critiques",
				"preparationId", "preparationDigest", "missingPerspectives", "plan", "verification", "synthesisRepair", "issues", "repairBudget",
			], "native repair result");
			if (result.kind !== "foundry-plan-repair-result" || result.status !== "ready"
				|| result.runId !== runId || result.sourceRunId !== preparation.rootRunId || result.sourceDigest !== preparation.sourceDigest
				|| result.preparationId !== preparation.id || result.preparationDigest !== preparation.digest
				|| stableStringify(result.input) !== stableStringify(preparation.material.input)
				|| stableStringify(result.critiques) !== stableStringify(preparation.material.critiques)) {
				fail("repair_result_invalid", "Repair result is not ready or does not bind the exact retained source");
			}
			agentIdentities(detail, ["plan:semantic-repair", "plan:conservation-review"]);
			const outcome = repairOutcome(Object.fromEntries(["plan", "verification", "synthesisRepair", "issues", "repairBudget"].map(key => [key, result[key]])));
			checkRepairConservation(preparation.material, result.plan);
			if (outcome.repairBudget.rootRunId !== preparation.rootRunId || outcome.repairBudget.preparationId !== preparation.id
				|| outcome.repairBudget.preparationDigest !== preparation.digest
				|| stableStringify(outcome.synthesisRepair.original) !== stableStringify(preparation.material.candidate)
				|| stableStringify(outcome.synthesisRepair.originalVerification) !== stableStringify(preparation.material.verification)
				|| outcome.synthesisRepair.diagnostic !== preparation.material.diagnostics.join("\n")
				|| outcome.synthesisRepair.stage !== "semantic" || outcome.synthesisRepair.issue !== null) {
				fail("repair_result_invalid", "Repair conservation provenance differs");
			}
			const plan = validatePlanningResult({ ...result, kind: "foundry-plan-result" }, preparation.material.input, preparation.material.input.maxTasks);
			const conceptualReview = extractSimplificationProposals(result.critiques);
			return {
				runId, inputDigest: preparation.inputDigest, plan, outcome, resultDigest: analysisInputDigest(result),
				factoryContext: preparation.material.input.factoryContext,
				...(conceptualReview ? { conceptualReview } : {}),
			};
		},
		/** Unique, bounded native observation, not tool-call correlation or a launch.
		 * @param {Preparation} preparation */
		async reconcilePlanningRepair(preparation) {
			assertRepairSource(preparation, await readRepairSource(api(), preparation.rootRunId));
			const candidates = new Set();
			/** @type {number | undefined} */
			let beforeSeq;
			for (let pageIndex = 0; pageIndex < 16; pageIndex++) {
				const page = await api().listRuns({ limit: 500, ...(beforeSeq === undefined ? {} : { beforeSeq }) });
				if (!Array.isArray(page.runs) || typeof page.omittedOlder !== "number") fail("repair_observation_uncertain", "Native inventory completeness is unknown");
				for (const summary of page.runs) {
					if (summary.workflowName !== "plan-repair") continue;
					const { run, detail } = await observe(api(), summary.runId, "plan-repair");
					const result = isRecord(run.result) ? run.result : null;
					const marker = detail.progress?.records?.some(entry => entry.text === repairMarker(preparation));
					if (result?.preparationId === preparation.id || marker) {
						if (result && (result.preparationDigest !== preparation.digest || result.sourceRunId !== preparation.rootRunId)) fail("repair_observation_conflict", "Observed repair has a different preparation");
						candidates.add(run.runId);
					}
				}
				if (!page.omittedOlder) {
					if (candidates.size !== 1) fail("repair_observation_uncertain", "Repair admission requires one unique matching owner-native observation");
					return { runId: [...candidates][0], evidence: readJsonValue({ method: "owner-native-inventory", preparationId: preparation.id, preparationDigest: preparation.digest, candidates: [...candidates] }) };
				}
				if (!Number.isSafeInteger(page.oldestSeq) || page.oldestSeq === null || page.oldestSeq === undefined
					|| (beforeSeq !== undefined && page.oldestSeq >= beforeSeq)) fail("repair_observation_uncertain", "Native inventory cursor is incomplete");
				beforeSeq = page.oldestSeq;
			}
			fail("repair_observation_uncertain", "Native inventory exceeds the bounded reconciliation window");
		},
	};
}
