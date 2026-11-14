import { createHash } from "node:crypto";
import { analysisInputDigest } from "../digest.mjs";
import { parseJson } from "../data.mjs";
import { resolveEvaluatorBundle, materialManifest } from "../evidence/bundles.mjs";
import { validateApprovalDelegation } from "../plan/schemas/approval.mjs";
import { validateVerification } from "../plan/schemas/verification.mjs";
import { digest, enumeration, fail, identifier, integer, list, object, reference, strings, text, timestamp } from "./fields.mjs";
import { contractFor, evaluationFor, knowledgeFor, same, unitFor } from "./records.mjs";

/** @typedef {import("../types/plan.js").TechnicalDecision} TechnicalDecision */
/** @typedef {import("../types/factory.js").FactoryState} FactoryState */
/** @typedef {import("../types/factory.js").ConsumerAgreement} ConsumerAgreement */
/** @typedef {import("../types/factory.js").TechnicalCase} TechnicalCase */
/** @typedef {import("../types/factory.js").TechnicalRenewal} TechnicalRenewal */

/** @param {unknown} value @returns {ConsumerAgreement} */
export function consumerAgreement(value) {
	object(value, ["format", "obligation", "scenarioId", "casesPath", "referencePath", "assertion", "from", "to"], "consumer agreement");
	if (value.format !== "foundry-cancellation-agreement-v1" || value.assertion !== "expected.outcome"
		|| value.from !== "denied" || value.to !== "cancelled") {
		fail("technical_transformation_unsupported", "Only the frozen cancellation-over-late-denial outcome assertion is supported");
	}
	return {
		format: value.format, obligation: reference(value.obligation),
		scenarioId: identifier(value.scenarioId), casesPath: text(value.casesPath, "casesPath"),
		referencePath: text(value.referencePath, "referencePath"),
		assertion: value.assertion, from: value.from, to: value.to,
	};
}

/** @param {unknown} value @returns {TechnicalCase[]} */
function cases(value) {
	const result = list(value, "consumer cases", undefined, 3).map(entry => {
		object(entry, ["id", "input", "expected"], "consumer case");
		object(entry.input, ["cancelled", "lateResult", "access", "data", "focus"], "scenario input");
		object(entry.expected, ["outcome", "access", "data", "focus"], "scenario assertions");
		if (typeof entry.input.cancelled !== "boolean"
			|| !["granted", "denied"].includes(String(entry.input.lateResult))
			|| !["granted", "denied"].includes(String(entry.input.access))
			|| !["granted", "denied"].includes(String(entry.expected.access))
			|| !["cancelled", "granted", "denied"].includes(String(entry.expected.outcome))) {
			fail("technical_assertion_unsupported", "Unrecognized consumer input or assertion shape");
		}
		const input = {
			cancelled: entry.input.cancelled,
			lateResult: enumeration(entry.input.lateResult, ["granted", "denied"], "lateResult"),
			access: enumeration(entry.input.access, ["granted", "denied"], "input access"),
			data: strings(entry.input.data, "input data"), focus: text(entry.input.focus, "input focus"),
		};
		const expected = {
			outcome: enumeration(entry.expected.outcome, ["cancelled", "granted", "denied"], "outcome"),
			access: enumeration(entry.expected.access, ["granted", "denied"], "expected access"),
			data: strings(entry.expected.data, "data assertions"), focus: text(entry.expected.focus, "focus assertion"),
		};
		if (!same(entry.input.data, entry.expected.data) || entry.input.focus !== entry.expected.focus) {
			fail("technical_conservation_required", "Every case must assert conservation of data and focus");
		}
		return { id: identifier(entry.id), input, expected };
	});
	if (new Set(result.map(entry => entry.id)).size !== result.length) fail("technical_mapping_invalid", "Scenario identities must be unique");
	return result;
}

/** @param {unknown} value @returns {import("../types/factory.js").TechnicalMaterial[]} */
function manifest(value) {
	const result = list(value, "protected material", undefined, 1).map(entry => {
		object(entry, ["path", "mode", "digest"], "protected file");
		if (entry.mode !== "100644" && entry.mode !== "100755") fail("technical_material_invalid", "Protected material must be regular files");
		return { path: text(entry.path, "protected path"), mode: entry.mode, digest: digest(entry.digest, "protected digest") };
	});
	if (new Set(result.map(entry => entry.path)).size !== result.length) fail("technical_material_invalid", "Protected paths must be unique");
	return result;
}

/** @param {Pick<TechnicalRenewal, "agreement" | "before" | "after">} renewal */
function validateMaterial(renewal) {
	const agreement = consumerAgreement(renewal.agreement);
	const before = cases(renewal.before.cases), after = cases(renewal.after.cases);
	const index = before.findIndex(entry => entry.id === agreement.scenarioId);
	const target = before[index];
	if (!target || target.input.cancelled !== true || target.input.lateResult !== "denied"
		|| target.input.access !== "granted" || target.expected.access !== "granted"
		|| target.expected.outcome !== agreement.from) {
		fail("technical_mapping_invalid", "The pinned scenario must be cancellation with previously granted access and an obsolete late-denial assertion");
	}
	if (!before.some(entry => !entry.input.cancelled && entry.input.lateResult === "denied" && entry.expected.outcome === "denied")) {
		fail("technical_conservation_required", "The noncancelled-denial control is required");
	}
	const permitted = structuredClone(before);
	permitted[index].expected.outcome = agreement.to;
	if (!same(permitted, after)) fail("technical_extra_edit", "Only the prescribed expected.outcome slot may change; all inputs, data/focus assertions and other cases are frozen");
	const oldFiles = manifest(renewal.before.material), newFiles = manifest(renewal.after.material);
	for (const side of [renewal.before, renewal.after]) {
		const actual = createHash("sha256").update(`${JSON.stringify(cases(side.cases), null, 2)}\n`).digest("hex");
		if (side.material.find(file => file.path === agreement.casesPath)?.digest !== actual) {
			fail("technical_material_invalid", "Assertion bytes disagree with the protected material manifest");
		}
	}
	const unchanged = newFiles.map(file => file.path === agreement.casesPath
		? { ...file, digest: oldFiles.find(old => old.path === file.path)?.digest } : file);
	if (!same(oldFiles, unchanged)
		|| oldFiles.find(file => file.path === agreement.casesPath)?.digest === newFiles.find(file => file.path === agreement.casesPath)?.digest
		|| !oldFiles.some(file => file.path === agreement.referencePath)) {
		fail("technical_extra_edit", "Protected executable material, inventory, modes and reference must be unchanged except the assertion file");
	}
}

/** Pure conservation checks are replayed as well as executed before authorization.
 * @param {TechnicalRenewal} renewal */
export function validateAlignment(renewal) {
	validateMaterial(renewal);
	const execution = renewal.execution;
	object(execution, ["source", "environment", "beforeExitCode", "afterExitCode", "before", "after"], "technical execution");
	text(execution.source, "execution source"); text(execution.environment, "execution environment");
	const expected = cases(renewal.after.cases).map(({ id, expected: actual }) => ({ id, actual }));
	if (execution.beforeExitCode !== 1 || execution.afterExitCode !== 0
		|| !same(execution.before, expected) || !same(execution.after, expected)) {
		fail("technical_execution_failed", "Both immutable references must execute every conserved case with the prescribed result");
	}
}

/** @param {unknown} value @returns {asserts value is TechnicalDecision} */
export function validateTechnicalDecision(value) {
	object(value, ["id", "kind", "digest", "delegation", "planId", "planRevision", "blueprintDigest", "sessionId", "toolCallId",
		"at", "reason", "failures", "factoryRevision", "contractDigest", "oldScope", "newScope", "verification", "renewal"], "technical decision");
	identifier(value.id); identifier(value.planId); integer(value.planRevision, "planRevision", 1);
	integer(value.factoryRevision, "factoryRevision", 1); digest(value.blueprintDigest, "blueprintDigest");
	text(value.sessionId, "sessionId"); text(value.toolCallId, "toolCallId"); timestamp(value.at, "at");
	text(value.reason, "technical reason"); strings(value.failures, "triggering failures", undefined, 1);
	validateApprovalDelegation(value.delegation);
	const scope = value.delegation.scope;
	if (value.kind !== "retry" && value.kind !== "consumer-expectation") fail("technical_kind_unsupported", "Unsupported technical decision");
	if (scope.approvalType !== "technical" || !scope.technical || value.delegation.revocation !== null
		|| scope.coordinatorSessionId !== value.sessionId || !scope.technical.kinds.includes(value.kind)) {
		fail("technical_authority_invalid", "An exact native owner decision under explicit technical authority is required");
	}
	if (value.contractDigest !== null) digest(value.contractDigest, "contractDigest");
	if (!same(value.oldScope, scope.technical.files) || !same(value.newScope, value.oldScope)) {
		fail("technical_scope_changed", "A technical decision cannot broaden its frozen source scope");
	}
	if (value.kind === "retry") {
		validateVerification(value.verification);
		if (value.verification.status !== "failed" || value.renewal !== null) {
			fail("technical_retry_unsupported", "Technical retry is limited to failed discovery verification");
		}
	} else if (value.kind === "consumer-expectation") {
		object(value.renewal, ["previous", "next", "agreement", "before", "after", "execution", "publication"], "technical renewal");
		reference(value.renewal.previous); reference(value.renewal.next);
		for (const side of [value.renewal.before, value.renewal.after]) {
			object(side, ["commit", "procedureDigest", "material", "cases"], "renewal artifact");
			if (typeof side.commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(side.commit)) fail("technical_material_invalid", "A full immutable commit is required");
			digest(side.procedureDigest, "procedureDigest"); manifest(side.material); cases(side.cases);
		}
		object(value.renewal.publication, ["unitId", "unitRevision", "obligations", "evaluations", "rationale", "resolutions", "renewalSignalIds", "actor", "reason"], "technical publication");
		const publication = value.renewal.publication;
		identifier(publication.unitId); integer(publication.unitRevision, "publication unitRevision", 1);
		for (const field of ["obligations", "evaluations", "rationale"]) {
			list(publication[field], field, undefined, field === "rationale" ? 0 : 1).forEach(reference);
		}
		for (const resolution of list(publication.resolutions, "resolutions")) {
			object(resolution, ["knowledge", "reason"], "resolution");
			reference(resolution.knowledge); text(resolution.reason, "resolution reason");
		}
		strings(publication.renewalSignalIds, "renewalSignalIds");
		if (publication.unitId !== scope.unitId || publication.unitRevision !== scope.unitRevision
			|| publication.actor !== `agent-session:${value.sessionId}` || publication.reason !== value.reason) {
			fail("technical_receipt_tampered", "The publication must retain the decision's native attribution, capability and reason");
		}
		if (value.verification !== null || value.contractDigest === null) fail("technical_agreement_required", "Renewal requires a pre-existing accepted contract");
		validateAlignment(/** @type {TechnicalRenewal} */ (value.renewal));
	} else fail("technical_kind_unsupported", "Unsupported technical decision");
	const { digest: supplied, ...payload } = value;
	if (supplied !== analysisInputDigest(payload)) fail("technical_receipt_tampered", "Technical decision content no longer matches its immutable receipt");
}

/** Check exact definitions and lineage independently of the caller's equivalence claim.
 * @param {FactoryState} state @param {TechnicalDecision} decision */
export function validateRenewal(state, decision) {
	validateTechnicalDecision(decision);
	const renewal = decision.renewal;
	if (!renewal || decision.kind !== "consumer-expectation") fail("technical_renewal_required", "Expected an exact consumer renewal decision");
	validateRenewalProposal(state, {
		scope: decision.delegation.scope, contractDigest: decision.contractDigest,
		sessionId: decision.sessionId, reason: decision.reason, renewal,
	});
	if (renewal.execution.environment !== evaluationFor(state, renewal.previous).environment) {
		fail("technical_evaluator_changed", "The trusted execution must retain the accepted evaluator environment");
	}
}

/** Shared pre-execution and replay eligibility; this never manufactures an execution verdict.
 * @param {FactoryState} state
 * @param {{scope: import("../types/plan.js").ApprovalScope, contractDigest: string | null,
 * sessionId: string, reason: string, renewal: Omit<TechnicalRenewal, "execution">}} proposal */
export function validateRenewalProposal(state, { scope, contractDigest, sessionId, reason, renewal }) {
	validateMaterial(renewal);
	const previous = contractFor(state, scope.unitId);
	const input = renewal.publication;
	const agreement = scope.technical?.agreement;
	if (previous.digest !== contractDigest || previous.unitRevision !== scope.unitRevision || !agreement
		|| input.unitId !== previous.unitId || input.unitRevision !== previous.unitRevision
		|| !same(input.obligations, previous.obligations) || !same(input.rationale, previous.rationale)
		|| input.actor !== `agent-session:${sessionId}` || input.reason !== reason) {
		fail("technical_contract_changed", "Renewal must conserve the current exact capability, obligations and decision attribution");
	}
	const oldDecision = state.decisions.find(entry => entry.id === previous.decisionId);
	if (!oldDecision || oldDecision.kind !== "accept-contract" || !same(input.resolutions, oldDecision.resolutions)
		|| !same(input.renewalSignalIds, oldDecision.renewalSignalIds ?? [])) fail("technical_contract_changed", "Accepted resolutions and incident links cannot change during assertion alignment");
	assertTechnicalLineage(state, scope, previous.digest);
	const oldEntry = knowledgeFor(state, renewal.previous), nextEntry = knowledgeFor(state, renewal.next);
	const successors = nextEntry.links.filter(link => link.relation === "supersedes");
	if (renewal.previous.id !== agreement.evaluation.id || renewal.previous.revision < agreement.evaluation.revision
		|| !previous.evaluations.some(ref => same(ref, renewal.previous)) || renewal.next.id !== renewal.previous.id
		|| renewal.next.revision !== renewal.previous.revision + 1
		|| oldEntry.statement !== nextEntry.statement || oldEntry.uncertainty !== nextEntry.uncertainty
		|| successors.length !== 1 || !same(successors[0]?.target, renewal.previous)
		|| !same(oldEntry.links.filter(link => link.relation !== "supersedes"), nextEntry.links.filter(link => link.relation !== "supersedes"))
		|| !same(input.evaluations, previous.evaluations.map(ref => same(ref, renewal.previous) ? renewal.next : ref))) {
		fail("technical_lineage_invalid", "Only a new revision of the selected evaluator may replace its exact predecessor");
	}
	const old = evaluationFor(state, renewal.previous), next = evaluationFor(state, renewal.next);
	const normalized = { ...next, procedure: { ...next.procedure, digest: old.procedure.digest,
		bundle: next.procedure.bundle ? { ...next.procedure.bundle, commit: old.procedure.bundle?.commit } : undefined } };
	if (!same(old, normalized) || old.procedure.digest !== renewal.before.procedureDigest
		|| next.procedure.digest !== renewal.after.procedureDigest || old.procedure.bundle?.commit !== renewal.before.commit
		|| next.procedure.bundle?.commit !== renewal.after.commit) {
		fail("technical_evaluator_changed", "Coverage, independence, preservation, human/UI/native reference, workload, freshness and invocation are conserved");
	}
	const obligation = knowledgeFor(state, renewal.agreement.obligation);
	const anchor = state.contracts.find(entry => entry.unitId === scope.unitId && entry.digest === scope.contractDigest);
	if (!previous.obligations.some(ref => same(ref, renewal.agreement.obligation))
		|| !anchor?.evaluations.some(ref => same(ref, agreement.evaluation))
		|| obligation.source.digest !== agreement.digest || !old.obligations.some(ref => same(ref, renewal.agreement.obligation))
		|| renewal.before.material.find(file => file.path === agreement.path)?.digest !== agreement.digest) {
		fail("technical_mapping_invalid", "The accepted obligation must independently pin the pre-existing executable agreement");
	}
	if (createHash("sha256").update(`${JSON.stringify(consumerAgreement(renewal.agreement), null, 2)}\n`).digest("hex") !== agreement.digest) {
		fail("technical_mapping_invalid", "Retained agreement content differs from its pinned pre-change bytes");
	}
	const unit = unitFor(state, previous.unitId, previous.unitRevision);
	if (!same(previous.dependencies, unit.dependencies.map(unitId => {
		const contract = contractFor(state, unitId);
		return { unitId, unitRevision: contract.unitRevision, contractRevision: contract.revision, contractDigest: contract.digest };
	}))) fail("technical_contract_changed", "Dependency contracts changed");
}

/** Reuse is limited to a chain of conserved technical successors, never arbitrary newer contracts.
 * @param {FactoryState} state @param {import("../types/plan.js").ApprovalScope} scope @param {string | null} target */
export function assertTechnicalLineage(state, scope, target) {
	if (target === scope.contractDigest) return;
	let current = state.contracts.find(entry => entry.unitId === scope.unitId && entry.digest === target);
	const visited = new Set();
	while (current && !visited.has(current.digest)) {
		visited.add(current.digest);
		const receipt = state.decisions.find(entry => entry.id === current?.decisionId);
		if (receipt?.kind !== "accept-contract" || !receipt.technical || !same(receipt.technical.delegation.scope, scope)
			|| receipt.technical.contractDigest !== current.previousDigest) break;
		if (current.previousDigest === scope.contractDigest) return;
		current = state.contracts.find(entry => entry.unitId === scope.unitId && entry.digest === current?.previousDigest);
	}
	fail("technical_lineage_invalid", "No conserved technical-decision lineage connects this contract to the grant");
}

/** Read protected bytes, not a caller's hashes or claimed coverage.
 * @param {string} repository @param {FactoryState} state
 * @param {import("../types/plan.js").ApprovalScope} scope
 * @param {import("../types/factory.js").KnowledgeRef} previous @param {import("../types/factory.js").KnowledgeRef} next */
export function renewalArtifacts(repository, state, scope, previous, next) {
	const pin = scope.technical?.agreement;
	if (!pin) fail("technical_agreement_required", "A frozen executable agreement is required");
	const old = evaluationFor(state, previous), updated = evaluationFor(state, next);
	if (!old.procedure.bundle || !updated.procedure.bundle) fail("technical_agreement_required", "Both evaluator revisions must be complete immutable Git bundles");
	const before = resolveEvaluatorBundle(repository, old.procedure.bundle), after = resolveEvaluatorBundle(repository, updated.procedure.bundle);
	/** @param {typeof before} bundle @param {string} path */
	const bytes = (bundle, path) => {
		const file = bundle.files.find(entry => entry.path === path);
		if (!file) fail("technical_conservation_required", `Missing protected material: ${path}`);
		return Buffer.from(file.content, "base64");
	};
	const agreementBytes = bytes(before, pin.path);
	if (createHash("sha256").update(agreementBytes).digest("hex") !== pin.digest) fail("technical_mapping_invalid", "Frozen agreement digest differs");
	const agreement = consumerAgreement(parseJson(agreementBytes.toString("utf8")));
	const beforeBytes = bytes(before, agreement.casesPath), afterBytes = bytes(after, agreement.casesPath);
	const oldCases = cases(parseJson(beforeBytes.toString("utf8"))), newCases = cases(parseJson(afterBytes.toString("utf8")));
	// A byte-identifiable slot excludes formatting edits, duplicate keys and hidden executable edits.
	if (beforeBytes.toString("utf8") !== `${JSON.stringify(oldCases, null, 2)}\n`
		|| afterBytes.toString("utf8") !== `${JSON.stringify(newCases, null, 2)}\n`) {
		fail("technical_assertion_unsupported", "Supported assertion material is canonical closed JSON, not arbitrary source syntax");
	}
	return {
		agreement, bundles: { before: before.bundle, after: after.bundle },
		before: { commit: before.bundle.commit, procedureDigest: before.digest, material: materialManifest(before.files), cases: oldCases },
		after: { commit: after.bundle.commit, procedureDigest: after.digest, material: materialManifest(after.files), cases: newCases },
	};
}
