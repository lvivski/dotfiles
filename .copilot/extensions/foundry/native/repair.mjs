import { assertRepairComparisonBinding, checkRepairConservation, closedRepairObject, compareRepairProgress, repairComparisonState, repairDigest, repairIdentity, repairMaterial, repairObject, repairOutcome, repairSourceSnapshotsEqual, sameRepairContributor } from "../analysis/repair.mjs";
import { validatePlanningArgs, validatePlanningResult, validatePlanBlueprint } from "../analysis/planning.mjs";
import { extractSimplificationProposals } from "../analysis/verdicts.mjs";
import { isRecord, readJsonValue } from "../data.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { assertRunId, fail, TERMINAL } from "./guards.mjs";

/** @typedef {import("./reader.mjs").WorkflowInspectionApi} Api */
/** @typedef {import("../types/repair.js").RepairPreparation} Preparation */
/** @typedef {import("../types/repair.js").RepairSource} Source */
/** @typedef {import("@github/copilot-sdk").WorkflowRunDetail} Detail */

/** Native agent identities corroborate the registered recipe; result text alone cannot.
 * @param {Detail} detail @param {string[]} labels */
function agentIdentities(detail, labels) {
	if (!Array.isArray(detail.agents)) fail("repair_native_provenance", "Missing native planning agent observations");
	const ids = new Set();
	const calls = new Set();
	const agents = detail.agents.map(agent => {
		const label = agent.label;
		if (typeof label !== "string") fail("repair_native_provenance", "Native contributor label is missing");
		const matches = detail.agents.filter(agent => agent.label === label);
		if ((labels.includes(label) && matches.length !== 1) || agent.runId !== detail.runId || agent.status !== "completed"
			|| !agent.agentId || !agent.toolCallId || ids.has(agent.agentId) || calls.has(agent.toolCallId)) {
			fail("repair_native_provenance", "Planning critics, author and verifier must have distinct completed native identities");
		}
		ids.add(agent.agentId); calls.add(agent.toolCallId);
		return { agentId: agent.agentId, toolCallId: agent.toolCallId, label, runId: agent.runId, status: agent.status };
	});
	for (const label of labels) if (!agents.some(agent => agent.label === label)) fail("repair_native_provenance", "Required original recipe perspective is missing");
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
	const result = closedRepairObject(run.result, ["kind", "inputDigest", "input", "status", "plan", "critiques", "verification", "synthesisRepair", "missingPerspectives", "issues", "repairBudget", "recovery"], "native planning result");
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
		native: repairObject({ run: readJsonValue(run), detail: readJsonValue(detail), runId, workflowName: detail.workflowName, createdAt: detail.createdAt, completedAt: detail.completedAt, agents }),
	};
}

/** @param {Preparation} preparation @param {Source} source */
export function assertRepairSource(preparation, source) {
	if (source.runId !== preparation.rootRunId || source.resultDigest !== preparation.sourceDigest
		|| source.inputDigest !== preparation.inputDigest
		|| stableStringify(source.material) !== stableStringify(preparation.material)
		|| !repairSourceSnapshotsEqual(preparation.source, { result: source.result, native: source.native })) {
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
	const outcome = repairOutcome(Object.fromEntries(["plan", "verification", "synthesisRepair", "issues", "repairBudget", ...(result.recovery === undefined ? [] : ["recovery"])].map(key => [key, result[key]])));
	const agents = agentIdentities(detail, [
		"plan:decomposer", "plan:architecture-critic", "plan:delivery-risk-critic", "plan:synthesizer", "plan:verifier",
		...(outcome.synthesisRepair.stage === "structural" ? ["plan:synthesis-repair"] : ["plan:semantic-repair", "plan:conservation-review"]),
	]);
	if (outcome.recovery) {
		const state = repairComparisonState(outcome.recovery.comparison);
		const reviewer = agents.find(agent => agent.label === (outcome.synthesisRepair.stage === "structural" ? "plan:verifier" : "plan:conservation-review"));
		if (!reviewer || state.reviewer.agentId !== reviewer.agentId || state.reviewer.toolCallId !== reviewer.toolCallId || state.reviewer.runId !== reviewer.runId
			|| agents.some(agent => ![...state.contributors, state.reviewer].some(identity => identity.agentId === agent.agentId
				&& identity.toolCallId === agent.toolCallId && identity.runId === agent.runId))) fail("repair_native_provenance", "Inline comparison omitted or substituted a native contributor/reviewer");
	}
	return outcome;
}

/** @param {() => Api} api @param {import("../types/repair.js").RepairHostPort} [repairHost] */
export function createRepairWorkflow(api, repairHost) {
	return {
		/** @param {string} runId */
		readPlanningRepairSource: runId => readRepairSource(api(), runId),
		/** Modern inline continuation uses the retained exact original material, not a reconstructed legacy baseline.
		 * @param {string} runId @param {Preparation} preparation */
		readPlanningContinuation: runIdWithPreparation,
		/** @param {string} runId @param {Preparation} preparation @param {import("../types/repair.js").RepairEffect} [effect] */
		async importPlanningRepair(runId, preparation, effect) {
			const source = preparation.mode === "inline" ? await runIdWithPreparation(preparation.rootRunId, preparation) : await readRepairSource(api(), preparation.rootRunId);
			if (preparation.mode === "inline") assertRepairContinuationSource(preparation, source, effect?.operation.context);
			else assertRepairSource(preparation, source);
			const { run, detail } = await observe(api(), runId, "plan-repair");
			if (runId === preparation.rootRunId || run.status !== "completed") fail("repair_result_unavailable", "Repair import requires a distinct completed repair-only run");
			const result = closedRepairObject(run.result, [
				"kind", "status", "runId", "sourceRunId", "sourceDigest", "input", "inputDigest", "critiques",
				"preparationId", "preparationDigest", "missingPerspectives", "plan", "verification", "synthesisRepair", "issues", "repairBudget", "recovery",
			], "native repair result");
			if (result.kind !== "foundry-plan-repair-result" || result.status !== "ready"
				|| result.runId !== runId || result.sourceRunId !== preparation.rootRunId || result.sourceDigest !== preparation.sourceDigest
				|| result.preparationId !== preparation.id || result.preparationDigest !== preparation.digest
				|| stableStringify(result.input) !== stableStringify(preparation.material.input)
				|| stableStringify(result.critiques) !== stableStringify(preparation.material.critiques)) {
				fail("repair_result_invalid", "Repair result is not ready or does not bind the exact retained source");
			}
			const nativeAgents = agentIdentities(detail, preparation.material.stage === "structural"
				? ["plan:synthesis-repair", "plan:verifier"] : ["plan:semantic-repair", "plan:conservation-review"]);
			const sourceAgents = isRecord(source.native) && Array.isArray(source.native.agents) ? source.native.agents : [];
			const reviewer = nativeAgents.find(agent => agent.label === (preparation.material.stage === "structural" ? "plan:verifier" : "plan:conservation-review"));
			if (reviewer && sourceAgents.some(agent => isRecord(agent) && (agent.agentId === reviewer.agentId || agent.toolCallId === reviewer.toolCallId))) {
				fail("repair_reviewer_not_independent", "Repair reviewer contributed to the source lineage");
			}
			if (result.recovery !== undefined) {
				const recovery = repairObject(result.recovery);
				if (!repairHost || !await repairHost.authenticate(recovery)) fail("repair_admission_unavailable", "New repair evidence requires authentic host binding");
				const state = assertRepairComparisonBinding(preparation, recovery.comparison);
				if (state.candidateDigest !== analysisInputDigest(result.synthesisRepair && isRecord(result.synthesisRepair) ? result.synthesisRepair.candidate : null)
					|| !Array.isArray(recovery.history) || !compareRepairProgress(state, recovery.history).passed
					|| !reviewer || state.reviewer.agentId !== reviewer.agentId || state.reviewer.toolCallId !== reviewer.toolCallId
					|| state.reviewer.runId !== runId
					|| nativeAgents.some(agent => ![...state.contributors, state.reviewer].some(identity => identity.agentId === agent.agentId && identity.toolCallId === agent.toolCallId && identity.runId === runId))) {
					fail("repair_result_invalid", "Substantive progress or all-contributor native bindings differ");
				}
			}
			const outcome = repairOutcome(Object.fromEntries(["plan", "verification", "synthesisRepair", "issues", "repairBudget", ...(result.recovery === undefined ? [] : ["recovery"])].map(key => [key, result[key]])));
			checkRepairConservation(preparation.material, result.plan);
			if (outcome.repairBudget.rootRunId !== preparation.rootRunId || outcome.repairBudget.preparationId !== preparation.id
				|| outcome.repairBudget.preparationDigest !== preparation.digest
				|| stableStringify(outcome.synthesisRepair.original) !== stableStringify(preparation.material.candidate)
				|| stableStringify(outcome.synthesisRepair.originalVerification) !== stableStringify(preparation.material.verification)
				|| outcome.synthesisRepair.diagnostic !== preparation.material.diagnostics.join("\n")
				|| outcome.synthesisRepair.stage !== preparation.material.stage || outcome.synthesisRepair.issue !== null) {
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
		 * @param {Preparation} preparation @param {{signal?: AbortSignal}} [options] */
		async reconcilePlanningRepair(preparation, options = {}) {
			assertRepairSource(preparation, await readRepairSource(api(), preparation.rootRunId));
			const candidates = new Set();
			/** @type {number | undefined} */
			let beforeSeq;
			const observedRuns = new Map();
			while (true) {
				options.signal?.throwIfAborted();
				const page = await api().listRuns({ limit: 500, ...(beforeSeq === undefined ? {} : { beforeSeq }) });
				if (!Array.isArray(page.runs) || typeof page.omittedOlder !== "number" || !Number.isSafeInteger(page.omittedOlder) || page.omittedOlder < 0) fail("repair_observation_uncertain", "Native inventory completeness is unknown");
				for (const summary of page.runs) {
					options.signal?.throwIfAborted();
					const observed = observedRuns.get(summary.runId);
					if (observed !== undefined) {
						if (observed !== stableStringify(summary) || TERMINAL.has(summary.status)) fail("repair_observation_uncertain", "Native inventory changed a snapshot or repeated a terminal run across cursor pages");
						continue;
					}
					observedRuns.set(summary.runId, stableStringify(summary));
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
					|| page.oldestSeq < 0 || (beforeSeq !== undefined && page.oldestSeq >= beforeSeq)) fail("repair_observation_uncertain", "Native inventory cursor is incomplete");
				beforeSeq = page.oldestSeq;
			}
		},
	};
	/** @param {string} runId @param {Preparation} preparation @returns {Promise<Source>} */
	async function runIdWithPreparation(runId, preparation) {
		const { run, detail } = await observe(api(), runId, "plan");
		if (preparation.mode !== "inline" || preparation.rootRunId !== runId || run.status !== "completed" || !isRecord(run.result)
			|| run.result.status !== "needs-review" || !isRecord(run.result.recovery)
			|| stableStringify(run.result.input) !== stableStringify(preparation.material.input)
			|| stableStringify(run.result.critiques) !== stableStringify(preparation.material.critiques)) fail("repair_continuation_held", "Only authentic modern inline evidence can prepare a new explicit continuation effect");
		await authenticateRepairEvidence(repairHost, run.result.recovery);
		const outcome = inlineRepairEvidence(repairObject(run.result), detail);
		if (!outcome || outcome.repairBudget.preparationId !== preparation.id || outcome.repairBudget.preparationDigest !== preparation.digest
			|| stableStringify(outcome.synthesisRepair.original) !== stableStringify(preparation.material.candidate)
			|| outcome.synthesisRepair.diagnostic !== preparation.material.diagnostics.join("\n")
			|| !Array.isArray(outcome.recovery?.history) || !compareRepairProgress(outcome.recovery.comparison, outcome.recovery.history).passed) {
			fail("repair_continuation_held", "Inline source must match the exact retained material and substantive evidence");
		}
		return { runId, inputDigest: preparation.inputDigest, resultDigest: analysisInputDigest(run.result), result: repairObject(run.result),
			material: preparation.material, native: repairObject({ run: readJsonValue(run), detail: readJsonValue(detail), agents: readJsonValue(detail.agents) }) };
	}
}

/** @param {Preparation} preparation @param {Source} source @param {unknown} value */
export function assertRepairContinuationSource(preparation, source, value) {
	const context = repairObject(value);
	if (preparation.mode !== "inline" || source.runId !== preparation.rootRunId || source.inputDigest !== preparation.inputDigest
		|| stableStringify(source.material) !== stableStringify(preparation.material)
		|| !repairSourceSnapshotsEqual(context.source, { result: source.result, native: source.native })) {
		fail("repair_source_changed", "The explicitly prepared inline continuation's original native source changed");
	}
}

/** @param {import("../types/repair.js").RepairHostPort|undefined} host @param {unknown} evidence */
export async function authenticateRepairEvidence(host, evidence) {
	if (!host || !await host.authenticate(evidence)) fail("repair_admission_unavailable", "Authentic constructor-bound repair admission/review provider is unavailable");
}

/** The local intent is an outbox only. The host owns the actual atomic native once boundary.
 * @param {import("../types/repair.js").RepairHostPort|undefined} host
 * @param {ReturnType<typeof import("../storage/repair.mjs").createRepairJournal>} journal
 * @param {import("../types/repair.js").RepairEffect} effect @param {unknown[]} history
 * @param {() => Promise<unknown>} invoke @param {AbortSignal} [signal] */
export async function admitRepairEffect(host, journal, effect, history, invoke, signal) {
	signal?.throwIfAborted();
	if (!host) fail("repair_admission_unavailable", "Fresh repair effects require atomic native admission; tools.execute is not that capability");
	const { id, ...body } = effect;
	if (effect.format !== "foundry-repair-effect-v1" || !["launch", "author", "review"].includes(effect.kind) || id !== analysisInputDigest(body)) {
		fail("repair_effect_conflict", "Renaming an effect cannot renew an identical native action");
	}
	const preparation = journal.read(effect.preparationId, effect.preparationDigest).preparation;
	if (effect.rootRunId !== preparation.rootRunId || effect.inputDigest !== preparation.inputDigest || effect.sourceDigest !== preparation.sourceDigest
		|| stableStringify(effect.authority) !== stableStringify(preparation.authority)) fail("repair_effect_conflict", "Effect substituted protected preparation or lineage authority");
	const existing = journal.effects(effect.preparationId, effect.preparationDigest).find(row => isRecord(row.effect) && row.effect.id === effect.id);
	journal.effectIntent(effect);
	/** @type {unknown} */
	let raw;
	if (existing && existing.state !== "prepared") {
		const receipt = existing.receipt;
		raw = isRecord(receipt) && (["denied", "unavailable"].includes(String(receipt.disposition))
			|| (receipt.disposition === "admitted" && Object.hasOwn(receipt, "output"))) ? receipt : await host.reconcile(effect);
		if (!raw) fail("repair_admission_uncertain", "Retained effect intent has no matching once receipt; reconcile without invocation");
	} else {
		try {
			const reviewRaw = await host.review(effect, history);
			journal.retain(effect.preparationId, effect.preparationDigest, "effect-review", readJsonValue(reviewRaw));
			await authenticateRepairEvidence(host, reviewRaw);
			const review = repairObject(reviewRaw);
			const reviewer = repairIdentity(review.reviewer);
			const retainedReviewers = journal.events(effect.preparationId, effect.preparationDigest)
				.filter(event => event.event === "effect-review" && event.payload !== reviewRaw && isRecord(event.payload) && event.payload.effectDigest !== effect.id)
				.map(event => repairIdentity(isRecord(event.payload) ? event.payload.reviewer : null));
			if (review.effectDigest !== effect.id || review.passed !== true || stableStringify(review.issues) !== "[]"
				|| [...effect.contributors, ...retainedReviewers].some(identity => sameRepairContributor(identity, reviewer))) fail("repair_effect_review", "Proposed effect lacks independent bound conservation/progress review");
			const states = history.map(repairComparisonState);
			if (!Array.isArray(review.targets) || !review.targets.length || !Array.isArray(review.evidence) || !review.evidence.length) {
				fail("repair_effect_review", "Proposed effect review needs substantive unresolved targets and independent causal evidence");
			}
			for (const value of review.evidence) {
				const item = closedRepairObject(value, ["id", "digest", "evaluatorId", "inputDigest", "producer", "causalFor"], "proposed-effect causal evidence");
				repairDigest(item.digest); repairDigest(item.inputDigest); repairIdentity(item.producer);
				if (typeof item.id !== "string" || !item.id.trim() || item.id.includes("\0") || typeof item.evaluatorId !== "string" || !item.evaluatorId.trim()
					|| !Array.isArray(item.causalFor) || !item.causalFor.length || item.causalFor.some(id => typeof id !== "string" || !id.trim())) fail("repair_effect_review", "Causal evidence identities or substantive references are missing");
			}
			for (const id of review.targets) {
				if (!states.every(state => state.obligations.some(item => item.id === id && item.status === "unresolved"))
					|| !review.evidence.some(item => isRecord(item) && Array.isArray(item.causalFor) && item.causalFor.includes(id)
						&& states.every(state => state.obligations.some(obligation => obligation.id === id
							&& obligation.evaluatorId === item.evaluatorId && obligation.inputDigest === item.inputDigest))
						&& !effect.contributors.some(identity => sameRepairContributor(identity, repairIdentity(item.producer))))) {
					fail("repair_effect_review", "Review does not independently support an existing unresolved obligation");
				}
			}
			signal?.throwIfAborted();
			raw = await host.admit(effect, /** @type {import("../types/repair.js").RepairEffectReview} */ (reviewRaw), invoke, signal);
		} catch (error) {
			journal.retain(effect.preparationId, effect.preparationDigest, "effect-failure", readJsonValue({ effectId: effect.id, error: error instanceof Error ? error.message : String(error) }));
			throw error;
		}
	}
	journal.retain(effect.preparationId, effect.preparationDigest, "native-outcome", readJsonValue(raw));
	await authenticateRepairEvidence(host, raw);
	const receipt = repairObject(raw);
	if (receipt.effectDigest !== effect.id) fail("repair_receipt_conflict", "Native receipt belongs to another effect");
	journal.effectReceipt(effect, receipt);
	const checks = receipt.checks;
	if (receipt.disposition !== "admitted" || receipt.consumed !== true || typeof receipt.transactionId !== "string" || !receipt.transactionId
		|| typeof receipt.nativeRunId !== "string" || !receipt.nativeRunId || !isRecord(checks)
		|| ["authority", "revision", "approval", "revocation", "cancellation", "provider", "resources", "budgets"].some(key => checks[key] !== true)
		|| !isRecord(receipt.resourceClaims) || !Object.keys(receipt.resourceClaims).length || !isRecord(receipt.budgetClaims) || !Array.isArray(receipt.contributors)) {
		fail("repair_admission_held", "Native transaction did not prove fresh authority and durable applicable resource/budget consumption");
	}
	receipt.contributors.forEach(repairIdentity);
	if (effect.kind !== "launch" && Object.hasOwn(receipt, "output") && !receipt.contributors.length) fail("repair_native_provenance", "Settled native author/reviewer effects require their complete contributor identities");
	return receipt;
}
