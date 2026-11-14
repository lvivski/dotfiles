import { assertRepairComparisonBinding, buildRepairEffect, buildRepairPreparation, checkRepairConservation, compareRepairProgress, inspectRepairCandidate, planningVerdict, repairAuthority, repairLaunchArgs, repairMaterial, repairObject, repairOutcome } from "../analysis/repair.mjs";
import { createAuthority } from "../bridge/authority.mjs";
import { errorMessage, isRecord, property, readJsonValue } from "../data.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { fail } from "../errors.mjs";
import { UNTRUSTED_DATA_WARNING, untrustedBlock } from "../prompt.mjs";
import { createPlanStore } from "../storage.mjs";
import { createRepairJournal } from "../storage/repair.mjs";
import { NON_EMPTY, STRING_LIST, TASK_ID } from "../tools/schema.mjs";
import { createRunReader } from "../native/reader.mjs";
import { admitRepairEffect, assertRepairContinuationSource, assertRepairSource, authenticateRepairEvidence, createRepairWorkflow, readRepairSource, repairMarker } from "../native/repair.mjs";

/** @typedef {import("../types/repair.js").RepairPreparation} Preparation */
/** @typedef {import("../types/repair.js").RepairMaterial} Material */
/** @typedef {Pick<import("@github/copilot-sdk").WorkflowContext, "agent">} Agent */
/** @typedef {{runId?: string, session?: unknown, signal?: AbortSignal}} Runtime */

/** maxTasks is an explicit topology choice or namespace capacity, never a resource grant.
 * @param {number} [maxTasks] */
export function planningSchema(maxTasks) {
	return {
		type: "object", additionalProperties: false, required: ["title", "tasks"],
		properties: {
			title: NON_EMPTY(),
			tasks: {
				type: "array", minItems: 2, ...(maxTasks === undefined ? {} : { maxItems: maxTasks + 1 }),
				items: {
					type: "object", additionalProperties: false,
					required: ["id", "title", "kind", "description", "dependsOn", "acceptanceCriteria", "expectedFiles", "deliveryRequirement"],
					properties: {
						id: TASK_ID, title: NON_EMPTY(), kind: { type: "string", enum: ["implement", "verify"] },
						description: NON_EMPTY(),
						dependsOn: { type: "array", items: TASK_ID },
						acceptanceCriteria: STRING_LIST(),
						expectedFiles: STRING_LIST(),
						deliveryRequirement: { type: "string", enum: ["branch", "commit", "pr"] },
					},
				},
			},
		},
	};
}

export const CONSERVATION_SCHEMA = {
	type: "object", additionalProperties: false, required: ["passed", "issues"],
	properties: { passed: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } },
};

const conservation = `Preserve every requirement and check, task identity, dependency intent, file scope, delivery commitment, full canonical objective/constraints and pinned governing authority. Do not truncate or drop content, add tasks, invent scope exceptions or Git permissions, or promote observations/proposals into authority.
Separate producer-authored evidence from the existing later independent final verification when a producer incorrectly requires its dependent verifier to finish first. Preserve the independent obligation and every substantive check; never require a downstream task before producer completion.
A required support matrix may move to an artifact only if the ORIGINAL authority already permits that artifact disposition. Preserve its complete contents and checks. Without that existing authorization, retain needs-review; do not manufacture a source-scope exception, merge permission or other grant.
The read-only final verifier retains empty acceptanceCriteria and expectedFiles. Any uncertain conservation even if the candidate is structurally valid must fail review.`;

/** @param {Runtime} workflow */
export async function repairJournalFor(workflow) {
	const session = workflow.session;
	if (!workflow.runId || !isRecord(session) || typeof session.sessionId !== "string" || !session.sessionId
		|| typeof session.workspacePath !== "string" || !session.workspacePath) {
		fail("repair_runtime_missing", "Bounded repair requires the current native run and owner workspace");
	}
	const owner = session.workspacePath;
	await createPlanStore({ workspacePath: owner }).list();
	return { journal: createRepairJournal({ workspacePath: owner, sessionId: session.sessionId }), owner, sessionId: session.sessionId, runId: workflow.runId };
}

/** The same author/reviewer mechanism serves structural, semantic and repair-only execution.
 * @param {Agent & Runtime} workflow @param {Preparation} preparation
 * @param {ReturnType<typeof createRepairJournal>} journal @param {string} [guidance]
 * @param {import("../types/repair.js").RepairHostPort} [repairHost] */
export async function executeRepair(workflow, preparation, journal, guidance = "", repairHost) {
	if (!workflow.runId) fail("repair_runtime_missing", "Missing native run identity");
	const record = journal.read(preparation.id, preparation.digest);
	const saved = journal.events(preparation.id, preparation.digest).find(event => event.event === "recovery-result"
		&& isRecord(event.payload) && event.payload.runId === workflow.runId);
	if (saved && isRecord(saved.payload)) return repairOutcome(saved.payload.result);
	if (record.result && record.runId === workflow.runId) return repairOutcome(record.result);
	if (!repairHost) fail("repair_admission_unavailable", "Fresh recovery is held: authentic atomic native admission/review provider unavailable; no tools.execute fallback");
	const existingAuthor = journal.effects(preparation.id, preparation.digest).find(row => isRecord(row.effect)
		&& row.effect.kind === "author" && row.effect.runId === workflow.runId);
	const allHistory = journal.comparisonHistory(preparation.id, preparation.digest);
	let history = allHistory;
	if (existingAuthor) {
		const author = existingAuthor.effect;
		const prefix = allHistory.findIndex((_state, index) => isRecord(author) && analysisInputDigest(allHistory.slice(0, index + 1)) === author.historyDigest);
		if (prefix < 0) fail("repair_history_conflict", "Existing effect history cannot be reconstructed");
		history = allHistory.slice(0, prefix + 1);
	}
	history.forEach(state => assertRepairComparisonBinding(preparation, state));
	const material = preparation.material;
	const previousResult = journal.events(preparation.id, preparation.digest).findLast(event => event.event === "recovery-result"
		&& isRecord(event.payload) && event.payload.runId !== workflow.runId);
	const previous = previousResult && isRecord(previousResult.payload) && isRecord(previousResult.payload.result)
		? previousResult.payload.result : null;
	const previousRepair = previous && isRecord(previous.synthesisRepair) ? previous.synthesisRepair : null;
	const authorInput = previousRepair ? previousRepair.candidate : material.candidate;
	const authorDiagnostics = previous ? { original: material.diagnostics, subsequent: previous.issues } : material.diagnostics;
	checkRepairConservation(material, authorInput);
	const context = [
		untrustedBlock("CANONICAL-INPUT", material.input),
		untrustedBlock("ORIGINAL-SYNTHESIS", material.candidate),
		untrustedBlock("CRITIQUES", material.critiques),
		untrustedBlock("VALIDATION-ISSUE", material.diagnostics),
		untrustedBlock("ORIGINAL-VERIFICATION", material.verification),
		untrustedBlock("DECOMPOSITION", material.decomposition),
		...(previous ? [untrustedBlock("RETAINED-SUBSEQUENT-CANDIDATE", authorInput), untrustedBlock("RETAINED-SUBSEQUENT-DIAGNOSTICS", authorDiagnostics)] : []),
	].join("\n\n");
	const authorEffect = existingAuthor && isRecord(existingAuthor.effect) ? /** @type {import("../types/repair.js").RepairEffect} */ (existingAuthor.effect)
		: buildRepairEffect(preparation, "author", history, authorInput, authorDiagnostics, workflow.runId,
			repairObject({ label: material.stage === "structural" ? "plan:synthesis-repair" : "plan:semantic-repair", schema: planningSchema(material.input.maxTasks) }));
	const authorReceipt = await admitRepairEffect(repairHost, journal, authorEffect, history, async () => workflow.agent(
			`Repair this rejected candidate under the reviewed proposed effect, not the whole planning process. Return a complete blueprint, not a patch. Do not decompose, research or replace critics. ${UNTRUSTED_DATA_WARNING}
${conservation}
${guidance}
${context}
Return JSON only. If a lossless authorized repair is impossible, retain the conflicting requirement for review.`,
			{ label: material.stage === "structural" ? "plan:synthesis-repair" : "plan:semantic-repair", schema: planningSchema(material.input.maxTasks) },
		), workflow.signal);
	if (!Object.hasOwn(authorReceipt, "output")) fail("repair_admission_uncertain", "Native author output is not durably settled; reconcile without generation");
	const candidate = readJsonValue(authorReceipt.output);
	journal.retain(preparation.id, preparation.digest, "author-output", candidate);
	let issue = candidate === null ? "The synthesis repair agent returned no valid result"
			: inspectRepairCandidate(candidate, material.input, "Synthesis repair").issue;
	if (candidate !== null) {
		try { checkRepairConservation(material, candidate); }
		catch (error) { issue = [issue, `Repair conservation rejected: ${errorMessage(error)}`].filter(Boolean).join("; "); }
	}
	const retained = { candidate, issue };
	journal.retain(preparation.id, preparation.digest, "candidate-diagnostics", readJsonValue(retained));
	const reviewed = inspectRepairCandidate(retained.candidate ?? material.candidate, material.input, "Synthesis repair");
	if (issue) {
		journal.retain(preparation.id, preparation.digest, "comparison-state", null);
		const held = repairOutcome({
			plan: reviewed.plan ?? reviewed.blueprint, verification: null, issues: [...material.diagnostics, issue],
			synthesisRepair: { original: material.candidate, diagnostic: material.diagnostics.join("\n"), candidate,
				issue, stage: material.stage, originalVerification: material.verification },
			repairBudget: { rootRunId: preparation.rootRunId, used: true, preparationId: preparation.id, preparationDigest: preparation.digest },
			recovery: { history: readJsonValue(history), comparison: null, receipts: [authorReceipt], structuralHold: issue },
		});
		journal.retain(preparation.id, preparation.digest, "recovery-result", readJsonValue({ runId: workflow.runId, result: held }));
		return held;
	}
	const diagnostics = { original: material.diagnostics, ...(previous ? { subsequent: previous.issues } : {}), candidate: issue };
	const reviewEffect = buildRepairEffect(preparation, "review", history, candidate, diagnostics, workflow.runId,
		repairObject({ label: material.stage === "structural" ? "plan:verifier" : "plan:conservation-review", schema: CONSERVATION_SCHEMA, authorEffect: authorEffect.id }),
		Array.isArray(authorReceipt.contributors) ? authorReceipt.contributors.map(value => {
			if (!isRecord(value) || typeof value.agentId !== "string" || typeof value.toolCallId !== "string" || typeof value.runId !== "string") fail("repair_native_provenance", "Author native contributor identity is missing");
			return { agentId: value.agentId, toolCallId: value.toolCallId, runId: value.runId };
		}) : []);
	const reviewReceipt = await admitRepairEffect(repairHost, journal, reviewEffect, history, async () => workflow.agent(
		`Independently compare the repaired candidate with the original candidate, full canonical input, original critics and original failure diagnostics. You are a fresh-context conservation reviewer, not the repair author. Check substantive coverage and every required check, not just schema validity. ${UNTRUSTED_DATA_WARNING}
${conservation}
${guidance}
${context}
${untrustedBlock("REPAIR-VALIDATION-ISSUE", retained.issue)}
${untrustedBlock("UNTRUSTED-PLAN", reviewed.plan ?? reviewed.blueprint)}
The original diagnostic is immutable history, not an unresolved issue if genuinely resolved without loss. Any unresolved validation issue, missing repaired output, weakened requirement, authority conflict or uncertainty requires passed:false. Return JSON only.`,
		{ label: material.stage === "structural" ? "plan:verifier" : "plan:conservation-review", schema: CONSERVATION_SCHEMA },
	), workflow.signal);
	if (!Object.hasOwn(reviewReceipt, "output")) fail("repair_admission_uncertain", "Native review output is not durably settled; reconcile without reviewer re-entry");
	const rawVerdict = readJsonValue(reviewReceipt.output);
	journal.retain(preparation.id, preparation.digest, "raw-conservation-review", rawVerdict);
	let verification = null;
	let reviewIssue = null;
	try {
		if (rawVerdict === null) fail("repair_review_missing", "The independent conservation reviewer returned no valid result");
		verification = planningVerdict(rawVerdict);
	} catch (error) { reviewIssue = `Independent conservation review rejected: ${errorMessage(error)}`; }
	let comparison = null;
	let progress = { passed: false, issues: ["Missing independent substantive comparison"], resolved: /** @type {string[]} */ ([]), signature: /** @type {string|null} */ (null) };
	try {
		const rawComparison = await repairHost.observeCandidate(preparation, candidate, rawVerdict, history, [authorReceipt, reviewReceipt], readJsonValue(diagnostics));
		journal.retain(preparation.id, preparation.digest, "comparison-state", readJsonValue(rawComparison));
		await authenticateRepairEvidence(repairHost, rawComparison);
		const boundComparison = assertRepairComparisonBinding(preparation, rawComparison);
		comparison = boundComparison;
		const reviewerIdentities = Array.isArray(reviewReceipt.contributors) ? reviewReceipt.contributors : [];
		const contributorIdentities = [...(Array.isArray(authorReceipt.contributors) ? authorReceipt.contributors : []), ...reviewerIdentities];
		if (!reviewerIdentities.some(value => isRecord(value) && value.agentId === boundComparison.reviewer.agentId && value.toolCallId === boundComparison.reviewer.toolCallId && value.runId === boundComparison.reviewer.runId)
			|| contributorIdentities.some(value => !isRecord(value) || ![...boundComparison.contributors, boundComparison.reviewer].some(identity => identity.agentId === value.agentId
				&& identity.toolCallId === value.toolCallId && identity.runId === value.runId))) fail("repair_native_provenance", "Comparison omitted or substituted admitted native contributor/reviewer identities");
		if (comparison.candidateDigest !== analysisInputDigest(candidate) || comparison.diagnosticsDigest !== analysisInputDigest(diagnostics)) {
			fail("repair_comparison_binding", "Comparison does not bind the actual candidate and full diagnostics");
		}
		progress = compareRepairProgress(comparison, history);
	} catch (error) {
		journal.retain(preparation.id, preparation.digest, "comparison-failure", readJsonValue({ error: errorMessage(error) }));
		progress.issues = [errorMessage(error)];
	}
	const issues = [
		...(retained.issue ? [...material.diagnostics, retained.issue] : []),
		...(verification?.issues ?? []), ...(reviewIssue ? [reviewIssue] : []),
		...(verification && !verification.passed && !verification.issues.length ? ["Independent conservation review did not pass"] : []),
		...progress.issues,
		...(comparison?.obligations.some(item => item.status !== "supported")
			? [`Unresolved substantive obligations: ${comparison.obligations.filter(item => item.status !== "supported").map(item => item.id).join(", ")}`] : []),
	];
	const result = repairOutcome({
		plan: reviewed.plan ?? reviewed.blueprint, verification, issues,
		synthesisRepair: {
			original: material.candidate, diagnostic: material.diagnostics.join("\n"), candidate: retained.candidate,
			issue: retained.issue, stage: material.stage, originalVerification: material.verification,
		},
		repairBudget: { rootRunId: preparation.rootRunId, used: true, preparationId: preparation.id, preparationDigest: preparation.digest },
		recovery: { history: readJsonValue(history), comparison: readJsonValue(comparison), progress: readJsonValue(progress), receipts: [authorReceipt, reviewReceipt] },
	});
	journal.retain(preparation.id, preparation.digest, "recovery-result", readJsonValue({ runId: workflow.runId, result }));
	return result;
}

/** @param {Agent & Runtime} workflow @param {Material} value @param {string} guidance
 * @param {import("../types/repair.js").RepairHostPort} [repairHost] */
export async function repairPlanning(workflow, value, guidance, repairHost) {
	const material = repairMaterial(value);
	const { journal, owner, sessionId, runId } = await repairJournalFor(workflow);
	const preparation = buildRepairPreparation({
		owner, sessionId, rootRunId: runId, sourceDigest: analysisInputDigest(material), mode: "inline",
		repositoryPath: null, authority: null, source: null, material,
	});
	const baseline = repairHost ? await repairHost.prepare(preparation) : undefined;
	if (baseline !== undefined) {
		await authenticateRepairEvidence(repairHost, baseline);
		assertRepairComparisonBinding(preparation, baseline);
	}
	journal.prepare(preparation, baseline === undefined ? undefined : readJsonValue(baseline));
	return executeRepair(workflow, preparation, journal, guidance, repairHost);
}

/** @type {import("@github/copilot-sdk").WorkflowMeta} */
export const meta = {
	name: "plan-repair",
	description: "Execute an independently reviewed owner-prepared recovery effect and check substantive progress without automatic continuation.",
	phases: [{ title: "repair" }],
	argsSchema: {
		type: "object", additionalProperties: false, required: ["preparationId", "preparationDigest"],
		properties: {
			preparationId: { type: "string", pattern: "^[a-f0-9]{64}$" },
			preparationDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
			effectId: { type: "string", pattern: "^[a-f0-9]{64}$" },
		},
	},
};

/** @param {Pick<import("@github/copilot-sdk").WorkflowContext, "args" | "phase" | "agent" | "log"> & Runtime} workflow
 * @param {import("../types/repair.js").RepairHostPort} [repairHost] */
export async function run(workflow, repairHost) {
	const args = repairLaunchArgs(workflow.args);
	const { journal, owner, sessionId, runId } = await repairJournalFor(workflow);
	const preparation = journal.read(args.preparationId, args.preparationDigest).preparation;
	if (preparation.owner !== owner || preparation.sessionId !== sessionId) {
		fail("repair_foreign_owner", "Repair-only execution requires this owner's retained recovery preparation");
	}
	const launch = journal.effects(preparation.id, preparation.digest).find(row => isRecord(row.effect)
		&& row.effect.kind === "launch" && (args.effectId === undefined || row.effect.id === args.effectId));
	if (launch) {
		await authenticateRepairEvidence(repairHost, launch.receipt);
		if (!isRecord(launch.receipt) || launch.receipt.disposition !== "admitted" || launch.receipt.consumed !== true || launch.receipt.nativeRunId !== runId) {
			fail("repair_admission_held", "Execution requires this exact native run's authentic consumed launch receipt");
		}
	} else if (!journal.read(args.preparationId, args.preparationDigest).result) {
		fail("repair_admission_unavailable", "No authentic consumed launch effect; legacy intent is not native permission");
	}
	const { api } = createRunReader(() => property(workflow.session, "workflow"));
	let repositoryPath = preparation.repositoryPath;
	let preparedAuthority = preparation.authority;
	if (preparation.mode === "inline") {
		if (!args.effectId || !launch || !isRecord(launch.effect)) fail("repair_admission_held", "Inline continuation requires its explicit independently prepared launch effect");
		const context = repairObject(isRecord(launch.effect.operation) ? launch.effect.operation.context : null);
		const source = await createRepairWorkflow(api, repairHost).readPlanningContinuation(preparation.rootRunId, preparation);
		assertRepairContinuationSource(preparation, source, context);
		repositoryPath = typeof context.repositoryPath === "string" ? context.repositoryPath : null;
		preparedAuthority = repairAuthority(context.authority);
		if (stableStringify(preparedAuthority) !== stableStringify(repairAuthority(preparation.material.input.factoryContext))) fail("repair_authority_stale", "Inline continuation changed pinned governing authority");
	} else {
		if (!preparation.source) fail("repair_authority_missing", "Missing original native source");
		assertRepairSource(preparation, await readRepairSource(api(), preparation.rootRunId));
	}
	if (!repositoryPath || !preparedAuthority || typeof preparedAuthority.unitId !== "string") fail("repair_authority_missing", "Missing original repository authority");
	const authority = createAuthority({ workspace: () => owner, storageRoot: undefined, clock: undefined });
	const current = repairAuthority(authority.context(repositoryPath, preparedAuthority.unitId, { query: preparation.material.input.objective }));
	if (stableStringify(current) !== stableStringify(preparedAuthority)) fail("repair_authority_stale", "Authority changed before repair-only execution");
	workflow.phase("repair");
	workflow.log(repairMarker(preparation));
	const result = await executeRepair(workflow, preparation, journal, "", repairHost);
	return repairObject({
		kind: "foundry-plan-repair-result", status: result.verification?.passed && !result.issues.length ? "ready" : "needs-review",
		runId, sourceRunId: preparation.rootRunId, sourceDigest: preparation.sourceDigest,
		input: preparation.material.input, inputDigest: preparation.inputDigest, critiques: preparation.material.critiques,
		preparationId: preparation.id, preparationDigest: preparation.digest, missingPerspectives: [],
		...result,
	});
}
