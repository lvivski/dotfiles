import { buildRepairPreparation, checkRepairConservation, inspectRepairCandidate, planningVerdict, repairAuthority, repairLaunchArgs, repairMaterial, repairObject, repairOutcome } from "../analysis/repair.mjs";
import { createAuthority } from "../bridge/authority.mjs";
import { errorMessage, isRecord, property, readJsonValue } from "../data.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { fail } from "../errors.mjs";
import { LIMITS } from "../plan/values.mjs";
import { UNTRUSTED_DATA_WARNING, untrustedBlock } from "../prompt.mjs";
import { createPlanStore } from "../storage.mjs";
import { createRepairJournal } from "../storage/repair.mjs";
import { NON_EMPTY, STRING_LIST, TASK_ID } from "../tools/schema.mjs";
import { createRunReader } from "../native/reader.mjs";
import { assertRepairSource, readRepairSource, repairMarker } from "../native/repair.mjs";

/** @typedef {import("../types/repair.js").RepairPreparation} Preparation */
/** @typedef {import("../types/repair.js").RepairMaterial} Material */
/** @typedef {Pick<import("@github/copilot-sdk").WorkflowContext, "agent">} Agent */
/** @typedef {{runId?: string, session?: unknown}} Runtime */

/** @param {number} maxTasks */
export function planningSchema(maxTasks) {
	return {
		type: "object", additionalProperties: false, required: ["title", "tasks"],
		properties: {
			title: NON_EMPTY(LIMITS.planTitle),
			tasks: {
				type: "array", minItems: 2, maxItems: maxTasks + 1,
				items: {
					type: "object", additionalProperties: false,
					required: ["id", "title", "kind", "description", "dependsOn", "acceptanceCriteria", "expectedFiles", "deliveryRequirement"],
					properties: {
						id: TASK_ID, title: NON_EMPTY(LIMITS.taskTitle), kind: { type: "string", enum: ["implement", "verify"] },
						description: NON_EMPTY(LIMITS.taskDescription),
						dependsOn: { type: "array", maxItems: LIMITS.dependencies, items: TASK_ID },
						acceptanceCriteria: STRING_LIST(LIMITS.acceptanceCriteria, LIMITS.acceptanceCriterion),
						expectedFiles: STRING_LIST(LIMITS.expectedFiles, LIMITS.expectedFile),
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
 * @param {ReturnType<typeof createRepairJournal>} journal @param {string} [guidance] */
export async function executeRepair(workflow, preparation, journal, guidance = "") {
	if (!workflow.runId) fail("repair_runtime_missing", "Missing native run identity");
	const record = journal.begin(preparation.id, preparation.digest, workflow.runId);
	if (record.result) return repairOutcome(record.result);
	const material = preparation.material;
	const context = [
		untrustedBlock("CANONICAL-INPUT", material.input),
		untrustedBlock("ORIGINAL-SYNTHESIS", material.candidate),
		untrustedBlock("CRITIQUES", material.critiques),
		untrustedBlock("VALIDATION-ISSUE", material.diagnostics),
		untrustedBlock("ORIGINAL-VERIFICATION", material.verification),
		untrustedBlock("DECOMPOSITION", material.decomposition),
	].join("\n\n");
	let retained = record.candidate;
	if (!retained) {
		const candidate = readJsonValue(await workflow.agent(
			`Repair this rejected candidate once, not the whole planning process. Return a complete blueprint, not a patch. Do not decompose, research or replace critics. ${UNTRUSTED_DATA_WARNING}
${conservation}
${guidance}
${context}
Return JSON only. If a lossless authorized repair is impossible, retain the conflicting requirement for review.`,
			{ label: material.stage === "structural" ? "plan:synthesis-repair" : "plan:semantic-repair", schema: planningSchema(material.input.maxTasks) },
		));
		let issue = candidate === null ? "The synthesis repair agent returned no valid result"
			: inspectRepairCandidate(candidate, material.input, "Synthesis repair").issue;
		if (candidate !== null) {
			try { checkRepairConservation(material, candidate); }
			catch (error) { issue = [issue, `Repair conservation rejected: ${errorMessage(error)}`].filter(Boolean).join("; "); }
		}
		retained = { candidate, issue };
		journal.candidate(preparation.id, preparation.digest, workflow.runId, retained);
	}
	const reviewed = inspectRepairCandidate(retained.candidate ?? material.candidate, material.input, "Synthesis repair");
	const rawVerdict = await workflow.agent(
		`Independently compare the repaired candidate with the original candidate, full canonical input, original critics and original failure diagnostics. You are a fresh-context conservation reviewer, not the repair author. Check substantive coverage and every required check, not just schema validity. ${UNTRUSTED_DATA_WARNING}
${conservation}
${guidance}
${context}
${untrustedBlock("REPAIR-VALIDATION-ISSUE", retained.issue)}
${untrustedBlock("UNTRUSTED-PLAN", reviewed.plan ?? reviewed.blueprint)}
The original diagnostic is immutable history, not an unresolved issue if genuinely resolved without loss. Any unresolved validation issue, missing repaired output, weakened requirement, authority conflict or uncertainty requires passed:false. Return JSON only.`,
		{ label: material.stage === "structural" ? "plan:verifier" : "plan:conservation-review", schema: CONSERVATION_SCHEMA },
	);
	let verification = null;
	let reviewIssue = null;
	try {
		if (rawVerdict === null) fail("repair_review_missing", "The independent conservation reviewer returned no valid result");
		verification = planningVerdict(rawVerdict);
	} catch (error) { reviewIssue = `Independent conservation review rejected: ${errorMessage(error)}`; }
	const issues = [
		...(retained.issue ? [...material.diagnostics, retained.issue] : []),
		...(verification?.issues ?? []), ...(reviewIssue ? [reviewIssue] : []),
		...(verification && !verification.passed && !verification.issues.length ? ["Independent conservation review did not pass"] : []),
	];
	const result = repairOutcome({
		plan: reviewed.plan ?? reviewed.blueprint, verification, issues,
		synthesisRepair: {
			original: material.candidate, diagnostic: material.diagnostics.join("\n"), candidate: retained.candidate,
			issue: retained.issue, stage: material.stage, originalVerification: material.verification,
		},
		repairBudget: { rootRunId: preparation.rootRunId, used: true, preparationId: preparation.id, preparationDigest: preparation.digest },
	});
	journal.complete(preparation.id, preparation.digest, workflow.runId, readJsonValue(result));
	return result;
}

/** @param {Agent & Runtime} workflow @param {Material} value @param {string} guidance */
export async function repairPlanning(workflow, value, guidance) {
	const material = repairMaterial(value);
	const { journal, owner, sessionId, runId } = await repairJournalFor(workflow);
	const preparation = buildRepairPreparation({
		owner, sessionId, rootRunId: runId, sourceDigest: analysisInputDigest(material), mode: "inline",
		repositoryPath: null, authority: null, source: null, material,
	});
	journal.prepare(preparation);
	return executeRepair(workflow, preparation, journal, guidance);
}

/** @type {import("@github/copilot-sdk").WorkflowMeta & {limits: Required<import("@github/copilot-sdk").WorkflowLimits>}} */
export const meta = {
	name: "plan-repair",
	description: "Repair one owner-prepared completed planning result once, then independently check requirement conservation.",
	phases: [{ title: "repair" }],
	argsSchema: {
		type: "object", additionalProperties: false, required: ["preparationId", "preparationDigest"],
		properties: {
			preparationId: { type: "string", pattern: "^[a-f0-9]{64}$" },
			preparationDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
		},
	},
	limits: { maxConcurrentSubagents: 1, maxTotalSubagents: 2, timeoutSeconds: 7200, maxAiCredits: 10000 },
};

/** @param {Pick<import("@github/copilot-sdk").WorkflowContext, "args" | "phase" | "agent" | "log"> & Runtime} workflow */
export async function run(workflow) {
	const args = repairLaunchArgs(workflow.args);
	const { journal, owner, sessionId, runId } = await repairJournalFor(workflow);
	const preparation = journal.read(args.preparationId, args.preparationDigest).preparation;
	if (preparation.mode !== "recovery" || preparation.owner !== owner || preparation.sessionId !== sessionId || !preparation.source) {
		fail("repair_foreign_owner", "Repair-only execution requires this owner's retained recovery preparation");
	}
	const { api } = createRunReader(() => property(workflow.session, "workflow"));
	assertRepairSource(preparation, await readRepairSource(api(), preparation.rootRunId));
	if (!preparation.repositoryPath || !preparation.authority || typeof preparation.authority.unitId !== "string") fail("repair_authority_missing", "Missing original repository authority");
	const authority = createAuthority({ workspace: () => owner, storageRoot: undefined, clock: undefined });
	const current = repairAuthority(authority.context(preparation.repositoryPath, preparation.authority.unitId, { query: preparation.material.input.objective }));
	if (stableStringify(current) !== stableStringify(preparation.authority)) fail("repair_authority_stale", "Authority changed before repair-only execution");
	workflow.phase("repair");
	workflow.log(repairMarker(preparation));
	const result = await executeRepair(workflow, preparation, journal);
	return repairObject({
		kind: "foundry-plan-repair-result", status: result.verification?.passed && !result.issues.length ? "ready" : "needs-review",
		runId, sourceRunId: preparation.rootRunId, sourceDigest: preparation.sourceDigest,
		input: preparation.material.input, inputDigest: preparation.inputDigest, critiques: preparation.material.critiques,
		preparationId: preparation.id, preparationDigest: preparation.digest, missingPerspectives: [],
		...result,
	});
}
