import { isRecord, readJsonValue } from "../data.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { fail } from "../errors.mjs";
import { plainObject, stringList, text } from "./fields.mjs";
import { validatePlanningArgs, validatePlanBlueprint } from "./planning.mjs";

/** @typedef {import("../types/json.js").JsonObject} JsonObject */
/** @typedef {import("../types/repair.js").RepairMaterial} Material */
/** @typedef {import("../types/repair.js").RepairPreparation} Preparation */

/** @param {unknown} value @param {string[]} keys @param {string} label */
export function closedRepairObject(value, keys, label) {
	const object = plainObject(value, label);
	if (Object.keys(object).some(key => !keys.includes(key))) fail("repair_input_invalid", `${label} contains unknown fields`);
	return object;
}

/** @param {unknown} value @returns {JsonObject} */
export function repairObject(value) {
	const json = readJsonValue(value);
	if (!isRecord(json)) fail("repair_input_invalid", "Repair evidence must be a JSON object");
	return json;
}

/** @param {unknown} value */
export function repairDigest(value) {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("repair_input_invalid", "Expected a SHA-256 repair identity");
	return value;
}

/** @param {unknown} value @returns {import("../types/repair.js").PlanningVerdict} */
export function planningVerdict(value) {
	const object = closedRepairObject(value, ["passed", "issues"], "verification");
	if (typeof object.passed !== "boolean") fail("repair_review_invalid", "Independent review requires a boolean verdict");
	return { passed: object.passed, issues: stringList(object.issues, "verification.issues") };
}

/** @param {unknown} value @returns {import("../types/repair.js").PlanningCritique} */
function critique(value) {
	const object = closedRepairObject(value, ["verdict", "risks", "requiredChanges"], "critic");
	if (object.verdict !== "accept" && object.verdict !== "revise") fail("repair_critics_missing", "Repair requires the original complete critics");
	return {
		verdict: object.verdict,
		risks: stringList(object.risks, "critic.risks"),
		requiredChanges: stringList(object.requiredChanges, "critic.requiredChanges"),
	};
}

/** @param {unknown} value @returns {Material} */
export function repairMaterial(value) {
	const object = closedRepairObject(value, ["input", "candidate", "critiques", "diagnostics", "verification", "decomposition", "stage"], "repair material");
	if (!Array.isArray(object.critiques) || object.critiques.length !== 2 || object.critiques.some(item => item == null)) {
		fail("repair_critics_missing", "Repair requires exactly two original critics");
	}
	if (object.stage !== "structural" && object.stage !== "semantic") fail("repair_input_invalid", "Unknown repair stage");
	const input = validatePlanningArgs(object.input);
	if (stableStringify(input) !== stableStringify(object.input)) fail("repair_input_invalid", "Repair must retain the full canonical input");
	if (!isRecord(object.candidate)) fail("repair_candidate_missing", "Repair requires an original candidate, not an upstream substitute");
	const verification = object.verification === null ? null : planningVerdict(object.verification);
	if (object.stage === "semantic" && (!verification || verification.passed || !verification.issues.length)) {
		fail("repair_source_ineligible", "Semantic repair requires the original failed semantic verdict");
	}
	return {
		input, candidate: readJsonValue(object.candidate),
		critiques: [critique(object.critiques[0]), critique(object.critiques[1])],
		diagnostics: stringList(object.diagnostics, "diagnostics", undefined, undefined, 1),
		verification, decomposition: readJsonValue(object.decomposition), stage: object.stage,
	};
}

/** Normalize only the injected objective/constraints; never substitute a decomposition.
 * @param {unknown} value @param {import("./planning.mjs").PlanningArgs} input @param {string} stage */
export function inspectRepairCandidate(value, input, stage) {
	const json = readJsonValue(value);
	const blueprint = { ...(isRecord(json) ? json : {}), objective: input.objective, constraints: input.constraints };
	try {
		return { plan: validatePlanBlueprint(blueprint, input.maxTasks, input.factoryContext?.visualEvaluation), blueprint, issue: null };
	} catch (error) {
		return { plan: null, blueprint, issue: `${stage} rejected: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Structural invariants are not an agent verdict about substantive conservation.
 * @param {Material} material @param {unknown} candidate */
export function checkRepairConservation(material, candidate) {
	const original = plainObject(material.candidate, "original candidate");
	const repaired = plainObject(candidate, "repair candidate");
	if (!Array.isArray(original.tasks) || !Array.isArray(repaired.tasks) || original.tasks.length !== repaired.tasks.length) {
		fail("repair_conservation", "Repair cannot add or remove tasks");
	}
	if (("objective" in repaired && repaired.objective !== material.input.objective)
		|| ("constraints" in repaired && stableStringify(repaired.constraints) !== stableStringify(material.input.constraints))) {
		fail("repair_conservation", "Repair cannot change objective or constraints");
	}
	for (const [index, raw] of original.tasks.entries()) {
		const before = plainObject(raw, "original task");
		const after = plainObject(repaired.tasks[index], "repaired task");
		for (const field of ["id", "kind", "dependsOn", "expectedFiles", "deliveryRequirement"]) {
			if (stableStringify(before[field]) !== stableStringify(after[field])) fail("repair_conservation", `Repair changed task ${field}`);
		}
	}
}

/** Authority projection excludes retrieved observations/proposals, never governing definitions.
 * @param {unknown} value */
export function repairAuthority(value) {
	const context = plainObject(value, "factory context");
	for (const field of ["repositoryId", "owner", "unitId", "unitRevision", "unit", "contract", "governing", "authority"]) {
		if (!Object.hasOwn(context, field)) fail("repair_authority_missing", `Factory context is missing ${field}`);
	}
	if (context.authority !== "discovery-only" && context.authority !== "accepted-contract") fail("repair_authority_missing", "Unknown factory authority");
	if (context.authority === "discovery-only" && (context.contract !== null || context.governing !== null)) fail("repair_authority_missing", "Discovery cannot acquire governing authority");
	if (context.authority === "accepted-contract" && (!isRecord(context.contract) || !isRecord(context.governing))) fail("repair_authority_missing", "Accepted authority is incomplete");
	repairDigest(context.repositoryId);
	text(context.owner, "owner");
	text(context.unitId, "unitId");
	if (!Number.isSafeInteger(context.unitRevision) || Number(context.unitRevision) < 1) fail("repair_authority_missing", "Invalid capability revision");
	return repairObject(Object.fromEntries(["repositoryId", "owner", "unitId", "unitRevision", "unit", "contract", "governing", "authority", "visualEvaluation"]
		.filter(field => Object.hasOwn(context, field)).map(field => [field, context[field]])));
}

/** @param {Omit<Preparation, "format" | "id" | "digest" | "inputDigest">} value @returns {Preparation} */
export function buildRepairPreparation(value) {
	const material = repairMaterial(value.material);
	const { owner, sessionId, rootRunId, sourceDigest, mode, repositoryPath, authority, source } = value;
	const body = { owner, sessionId, rootRunId, sourceDigest, mode, repositoryPath, authority, source,
		format: /** @type {const} */ ("foundry-plan-repair-v1"), inputDigest: material.input.inputDigest, material };
	const id = analysisInputDigest([body.owner, body.sessionId, body.rootRunId]);
	return { ...body, id, digest: analysisInputDigest({ ...body, id }) };
}

/** @param {unknown} value @returns {Preparation} */
export function validateRepairPreparation(value) {
	const object = closedRepairObject(value, ["format", "id", "digest", "owner", "sessionId", "rootRunId", "inputDigest", "sourceDigest", "mode", "repositoryPath", "authority", "source", "material"], "preparation");
	if (object.format !== "foundry-plan-repair-v1" || (object.mode !== "inline" && object.mode !== "recovery")) fail("repair_input_invalid", "Unknown repair preparation");
	const preparation = buildRepairPreparation({
		owner: text(object.owner, "owner"), sessionId: text(object.sessionId, "sessionId"),
		rootRunId: text(object.rootRunId, "rootRunId"), sourceDigest: repairDigest(object.sourceDigest), mode: object.mode,
		repositoryPath: object.repositoryPath === null ? null : text(object.repositoryPath, "repositoryPath"),
		authority: object.authority === null ? null : repairAuthority(object.authority),
		source: object.source === null ? null : repairObject(object.source), material: repairMaterial(object.material),
	});
	if (stableStringify(preparation) !== stableStringify(object)) fail("repair_identity_mismatch", "Repair preparation content or identity changed");
	return preparation;
}

/** @param {Preparation} preparation @param {string} [effectId] @returns {import("../types/repair.js").RepairLaunch} */
export function repairLaunch(preparation, effectId) {
	return { name: "plan-repair", args: { preparationId: preparation.id, preparationDigest: preparation.digest, ...(effectId === undefined ? {} : { effectId: repairDigest(effectId) }) } };
}

/** @param {unknown} value */
export function repairLaunchArgs(value) {
	const object = closedRepairObject(value, ["preparationId", "preparationDigest", "effectId"], "repair launch");
	return { preparationId: repairDigest(object.preparationId), preparationDigest: repairDigest(object.preparationDigest),
		...(object.effectId === undefined ? {} : { effectId: repairDigest(object.effectId) }) };
}

/** @param {unknown} value @returns {import("../types/repair.js").RepairOutcome} */
export function repairOutcome(value) {
	const object = closedRepairObject(value, ["plan", "verification", "synthesisRepair", "issues", "repairBudget", "recovery"], "repair outcome");
	const repair = closedRepairObject(object.synthesisRepair, ["original", "diagnostic", "candidate", "issue", "stage", "originalVerification"], "repair evidence");
	const budget = closedRepairObject(object.repairBudget, ["rootRunId", "used", "preparationId", "preparationDigest"], "repair budget");
	if (budget.used !== true || (repair.stage !== "structural" && repair.stage !== "semantic")
		|| (repair.issue !== null && typeof repair.issue !== "string")) fail("repair_result_invalid", "Invalid repair result evidence");
	return {
		plan: repairObject(object.plan),
		verification: object.verification === null ? null : planningVerdict(object.verification),
		synthesisRepair: {
			original: readJsonValue(repair.original), diagnostic: text(repair.diagnostic, "diagnostic"),
			candidate: readJsonValue(repair.candidate), issue: repair.issue, stage: repair.stage,
			originalVerification: repair.originalVerification === null ? null : planningVerdict(repair.originalVerification),
		},
		issues: stringList(object.issues, "issues"),
		repairBudget: {
			rootRunId: text(budget.rootRunId, "rootRunId"), used: true,
			preparationId: repairDigest(budget.preparationId), preparationDigest: repairDigest(budget.preparationDigest),
		},
		...(object.recovery === undefined ? {} : { recovery: repairObject(object.recovery) }),
	};
}

/** Native identities are claims until authenticated by the constructor-bound host.
 * @param {unknown} value @returns {import("../types/repair.js").RepairIdentity} */
export function repairIdentity(value) {
	const raw = closedRepairObject(value, ["agentId", "toolCallId", "runId"], "repair identity");
	return { agentId: text(raw.agentId, "agentId"), toolCallId: text(raw.toolCallId, "toolCallId"), runId: text(raw.runId, "runId") };
}

/** @param {import("../types/repair.js").RepairIdentity} a @param {import("../types/repair.js").RepairIdentity} b */
export function sameRepairContributor(a, b) {
	return a.agentId === b.agentId || a.toolCallId === b.toolCallId;
}

/** Full raw observations remain in the journal; this projection contains only comparison inputs.
 * @param {unknown} value @returns {import("../types/repair.js").RepairComparisonState} */
export function repairComparisonState(value) {
	if (!isRecord(value)) fail("repair_comparison_missing", "Legacy or missing structured comparison inputs remain history/hold");
	const raw = plainObject(value, "comparison state");
	if (raw.format !== "foundry-repair-comparison-v1" || !Array.isArray(raw.obligations) || !raw.obligations.length
		|| !Array.isArray(raw.contributors)) fail("repair_comparison_missing", "Structured substantive obligations and contributors are required");
	const ids = new Set();
	const obligations = raw.obligations.map(value => {
		const item = plainObject(value, "obligation");
		const id = text(item.id, "obligation.id");
		if (ids.has(id) || !["unresolved", "supported", "uncertain"].includes(String(item.status)) || !Array.isArray(item.evidence)) {
			fail("repair_comparison_invalid", "Obligation identities, status or evidence are invalid");
		}
		ids.add(id);
		return {
			id, evaluatorId: text(item.evaluatorId, "evaluatorId"), evaluatorDigest: repairDigest(item.evaluatorDigest),
			inputDigest: repairDigest(item.inputDigest), status: /** @type {"unresolved"|"supported"|"uncertain"} */ (item.status),
			evidence: item.evidence.map(value => {
				const evidence = plainObject(value, "causal evidence");
				return { id: text(evidence.id, "evidence.id"), digest: repairDigest(evidence.digest),
					evaluatorId: text(evidence.evaluatorId, "evidence.evaluatorId"), inputDigest: repairDigest(evidence.inputDigest),
					producer: repairIdentity(evidence.producer), causalFor: stringList(evidence.causalFor, "causalFor", undefined, undefined, 1) };
			}),
		};
	});
	return {
		format: "foundry-repair-comparison-v1", protected: repairObject(raw.protected),
		candidateDigest: repairDigest(raw.candidateDigest), diagnosticsDigest: repairDigest(raw.diagnosticsDigest),
		obligations, contributors: raw.contributors.map(repairIdentity), reviewer: repairIdentity(raw.reviewer),
	};
}

/** @param {import("../types/repair.js").RepairComparisonState} state */
export function repairSubstantiveSignature(state) {
	return analysisInputDigest({ protected: state.protected, obligations: state.obligations.map(item => ({
		id: item.id, evaluatorId: item.evaluatorId, evaluatorDigest: item.evaluatorDigest, inputDigest: item.inputDigest,
		status: item.status, evidence: item.evidence.map(evidence => ({
			digest: evidence.digest, evaluatorId: evidence.evaluatorId, inputDigest: evidence.inputDigest,
			causalFor: [...evidence.causalFor].sort(),
		})).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
	})).sort((a, b) => a.id.localeCompare(b.id)) });
}

/** Compare every retained state, not a last-state or prose similarity heuristic.
 * @param {unknown} candidate @param {unknown[]} history */
export function compareRepairProgress(candidate, history) {
	/** @type {string[]} */
	const issues = [];
	/** @type {string[]} */
	const resolved = [];
	try {
		if (!history.length) fail("repair_comparison_missing", "No authentic retained comparison baseline");
		const next = repairComparisonState(candidate);
		const previous = history.map(repairComparisonState);
		const latest = previous.at(-1);
		const contributors = previous.flatMap(state => [...state.contributors, state.reviewer]).concat(next.contributors);
		if (contributors.some(identity => sameRepairContributor(identity, next.reviewer))) {
			fail("repair_reviewer_not_independent", "Reviewer participated anywhere in the retained recovery lineage");
		}
		const signature = repairSubstantiveSignature(next);
		const evidenceIdentities = new Map();
		for (const state of [...previous, next]) {
			for (const obligation of state.obligations) {
				for (const evidence of obligation.evidence) {
					const identity = stableStringify({ ...evidence, causalFor: [...evidence.causalFor].sort() });
					const retained = evidenceIdentities.get(evidence.id);
					if (retained !== undefined && retained !== identity) fail("repair_evidence_regression", "A retained evidence identity was substituted");
					evidenceIdentities.set(evidence.id, identity);
				}
				if (obligation.status === "supported" && (!obligation.evidence.length || obligation.evidence.some(item =>
					item.evaluatorId !== obligation.evaluatorId || item.inputDigest !== obligation.inputDigest || !item.causalFor.includes(obligation.id)
					|| state.contributors.some(identity => sameRepairContributor(identity, item.producer))))) {
					fail("repair_evidence_missing", "Supported history requires evaluator/input-bound independent causal evidence");
				}
			}
		}
		for (const before of previous) {
			if (stableStringify(before.protected) !== stableStringify(next.protected)) fail("repair_protected_changed", "Protected authority, evaluator or input identities changed");
			if (repairSubstantiveSignature(before) === signature) fail("repair_equivalent", "Equivalent, repeated or alternating substantive state");
			if (before.obligations.length !== next.obligations.length) fail("repair_incomparable", "Substantive obligation inventory changed");
			for (const old of before.obligations) {
				const current = next.obligations.find(item => item.id === old.id);
				if (!current || current.evaluatorId !== old.evaluatorId || current.evaluatorDigest !== old.evaluatorDigest
					|| current.inputDigest !== old.inputDigest) fail("repair_evaluator_changed", "Obligation, protected evaluator or evaluator input substituted");
				if (old.status === "uncertain" || current.status === "uncertain") fail("repair_incomparable", "Uncertain obligation evidence cannot establish conservation");
				if (old.status === "supported" && current.status !== "supported") fail("repair_regression", "A supported substantive obligation regressed");
				for (const evidence of old.evidence) {
					const original = stableStringify({ ...evidence, causalFor: [...evidence.causalFor].sort() });
					if (!current.evidence.some(item => stableStringify({ ...item, causalFor: [...item.causalFor].sort() }) === original)) {
						fail("repair_evidence_regression", "Retained supported evidence was lost or substituted");
					}
				}
				if (current.status === "supported" && !current.evidence.length) fail("repair_evidence_missing", "Supported obligations need independent causal evidence");
				if (old.status === "unresolved" && current.status === "supported") {
					const causal = current.evidence.some(item => item.causalFor.includes(current.id)
						&& item.evaluatorId === current.evaluatorId && item.inputDigest === current.inputDigest
						&& !old.evidence.some(prior => prior.digest === item.digest)
						&& !contributors.some(identity => sameRepairContributor(identity, item.producer)));
					if (!causal) fail("repair_evidence_missing", "Progress requires new independent causal evidence of a resolved obligation");
					if (before === latest && !resolved.includes(current.id)) resolved.push(current.id);
				}
			}
		}
		if (!resolved.length) fail("repair_no_progress", "No substantive issue or evidence obligation unresolved in the latest predecessor was newly resolved");
		return { passed: true, issues, resolved, signature };
	} catch (error) {
		issues.push(error instanceof Error ? error.message : String(error));
		return { passed: false, issues, resolved: [], signature: null };
	}
}

/** @param {Preparation} preparation @param {unknown} value */
export function assertRepairComparisonBinding(preparation, value) {
	const state = repairComparisonState(value);
	const expected = { preparationId: preparation.id, preparationDigest: preparation.digest, rootRunId: preparation.rootRunId,
		inputDigest: preparation.inputDigest, sourceDigest: preparation.sourceDigest, authority: preparation.authority };
	for (const [key, value] of Object.entries(expected)) {
		if (stableStringify(state.protected[key]) !== stableStringify(value)) fail("repair_comparison_binding", `Comparison does not bind ${key}`);
	}
	return state;
}

/** Effect identity is content-addressed; changing an ID cannot renew the same action.
 * @param {Preparation} preparation @param {"launch"|"author"|"review"} kind
 * @param {unknown[]} history @param {unknown} candidate @param {unknown} diagnostics
 * @param {string|null} runId @param {JsonObject} operation @param {import("../types/repair.js").RepairIdentity[]} [additionalContributors] */
export function buildRepairEffect(preparation, kind, history, candidate, diagnostics, runId, operation, additionalContributors = []) {
	const states = history.map(value => assertRepairComparisonBinding(preparation, value));
	const contributors = states.flatMap(state => [...state.contributors, state.reviewer]).concat(additionalContributors);
	const body = {
		format: /** @type {const} */ ("foundry-repair-effect-v1"), kind,
		preparationId: preparation.id, preparationDigest: preparation.digest, rootRunId: preparation.rootRunId,
		inputDigest: preparation.inputDigest, sourceDigest: preparation.sourceDigest, authority: preparation.authority,
		historyDigest: analysisInputDigest(history), candidate: readJsonValue(candidate), diagnostics: readJsonValue(diagnostics),
		contributors, runId, operation,
	};
	return { ...body, id: analysisInputDigest(body) };
}

/** Old source records retained the exact selected native identities, not full envelopes.
 * Compare that original projection without rewriting or rehabilitating its history.
 * @param {unknown} recorded @param {unknown} observed */
export function repairSourceSnapshotsEqual(recorded, observed) {
	if (stableStringify(recorded) === stableStringify(observed)) return true;
	if (!isRecord(recorded) || !isRecord(observed) || !isRecord(recorded.native) || !isRecord(observed.native)
		|| Object.hasOwn(recorded.native, "run") || Object.hasOwn(recorded.native, "detail")) return false;
	const recordedNative = recorded.native;
	const observedNative = observed.native;
	const keys = ["runId", "workflowName", "createdAt", "completedAt", "agents"];
	if (Object.keys(recordedNative).length !== keys.length || !keys.every(key => Object.hasOwn(recordedNative, key))
		|| !Array.isArray(recordedNative.agents) || !Array.isArray(observedNative.agents)
		|| recordedNative.agents.length !== observedNative.agents.length) return false;
	const native = Object.fromEntries(keys.map(key => [key, observedNative[key]]));
	const observedAgents = observedNative.agents;
	native.agents = recordedNative.agents.map(agent => observedAgents.find(candidate => stableStringify(agent) === stableStringify(candidate)) ?? null);
	return stableStringify(recorded) === stableStringify({ result: observed.result, native });
}
