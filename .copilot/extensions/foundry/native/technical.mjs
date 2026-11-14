import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { readJsonValue, parseJson } from "../data.mjs";
import { analysisInputDigest } from "../digest.mjs";
import { materialManifest, resolveEvaluatorBundle } from "../evidence/bundles.mjs";
import { digest, enumeration, identifier, list, object, strings, text } from "../factory/fields.mjs";
import { evaluatorBundle, repositoryPath } from "../factory/procedures.mjs";
import { same } from "../factory/records.mjs";
import { consumerAgreement } from "../factory/technical.mjs";
import { fail } from "./guards.mjs";

/** @typedef {import("../types/factory.js").TechnicalExecutor} TechnicalExecutor */
/** @typedef {Parameters<TechnicalExecutor>[0]} TechnicalInput */
/** @typedef {import("../types/factory.js").TechnicalExecution} TechnicalExecution */
/** @typedef {import("../types/factory.js").TechnicalCase} TechnicalCase */
/** @typedef {{owner: string, sessionId: string, projectId: string, repositoryPath: string}} TechnicalBinding */
/** @typedef {TechnicalBinding & {toolCallId: string, agentId: null, inWorkflow: false}} TechnicalContext */
/** @typedef {{input: TechnicalInput, beforeDigest: string, afterDigest: string,
 * agreementPath: string, agreementDigest: string, environment: string}} TechnicalWorkload */
/** @typedef {{id: string, context: TechnicalContext, workload: TechnicalWorkload}} TechnicalRequest */
/** Fixture-only operation port, not a public tool schema or evidence of native availability.
 * The host provider must supply a real permission-bound operation before a production route can be added.
 * @typedef {{route: "fixture-process",
 * authorize: (request: TechnicalRequest, signal?: AbortSignal) => Promise<unknown>,
 * execute: (request: TechnicalRequest, permissionSource: string, signal?: AbortSignal) => Promise<unknown>}} TechnicalFixturePort */

export const TECHNICAL_EXECUTION_SUPPORT = Object.freeze({
	status: "unsupported",
	primaryApp: "No offered operation binds both immutable evaluator procedures, current owner/project/repository, resource permission and complete correlated TechnicalExecution results.",
	extensionRpc: "tools.execute dispatches offered tools only; it is not a bounded evaluator API. The retained disabled session-management route is not an alternative execution route.",
	missing: "A public cancellation-aware evaluator execution operation with current native identity, normal resource permission, exact procedure binding and complete source/environment/exit/case evidence.",
	provider: "Separately authorized host-provider work, then foundry-operating-integration-v1 common wiring and real-host proof.",
	observations: [
		"types/factory.d.ts:TechnicalExecutor and application/technical.mjs:renewContract require an injected trusted executor.",
		"test/parallel/fixtures/native-capabilities.json and native-tools.json capture no such operation; native-rpc-failure.json retains the distinct disabled route.",
		"Bundled SDK generated/rpc.d.ts:SessionRpc.tools.execute accepts a tool name/arguments, not a TechnicalExecutor workload/result contract.",
	],
});

/** @param {unknown} value @param {string} field */
function absolutePath(value, field) {
	const result = text(value, field, 4096);
	if (!path.isAbsolute(result) || path.resolve(result) !== result || result.includes("\0")) {
		fail("technical_identity_invalid", `${field} must be an exact absolute path`);
	}
	return result;
}

/** @param {unknown} value @returns {TechnicalBinding} */
function binding(value) {
	object(value, ["owner", "sessionId", "projectId", "repositoryPath"], "technical binding");
	return {
		owner: absolutePath(value.owner, "owner"), sessionId: text(value.sessionId, "sessionId", 256),
		projectId: text(value.projectId, "projectId", 256), repositoryPath: absolutePath(value.repositoryPath, "repositoryPath"),
	};
}

/** @param {unknown} value @returns {TechnicalContext} */
function context(value) {
	object(value, ["owner", "sessionId", "projectId", "repositoryPath", "toolCallId", "agentId", "inWorkflow"], "technical context");
	if (value.agentId !== null || value.inWorkflow !== false) {
		fail("technical_identity_invalid", "Technical execution requires the owning coordinator, never a subagent or Workflow");
	}
	const { toolCallId, agentId, inWorkflow, ...owner } = value;
	return { ...binding(owner), toolCallId: text(toolCallId, "toolCallId", 512), agentId, inWorkflow };
}

/** @param {unknown} value @returns {TechnicalInput} */
function input(value) {
	object(value, ["repositoryPath", "before", "after", "agreement"], "technical input");
	return {
		repositoryPath: absolutePath(value.repositoryPath, "repositoryPath"),
		before: evaluatorBundle(value.before), after: evaluatorBundle(value.after),
		agreement: consumerAgreement(value.agreement),
	};
}

/** @param {unknown} value @returns {TechnicalWorkload} */
function workload(value) {
	object(value, ["input", "beforeDigest", "afterDigest", "agreementPath", "agreementDigest", "environment"], "technical workload");
	return {
		input: input(value.input), beforeDigest: digest(value.beforeDigest, "before procedure"),
		afterDigest: digest(value.afterDigest, "after procedure"),
		agreementPath: repositoryPath(value.agreementPath, "agreementPath"),
		agreementDigest: digest(value.agreementDigest, "agreementDigest"), environment: text(value.environment, "environment"),
	};
}

/** @param {unknown} value @returns {TechnicalCase["expected"]} */
function actual(value) {
	object(value, ["outcome", "access", "data", "focus"], "technical case result");
	return {
		outcome: enumeration(value.outcome, ["cancelled", "granted", "denied"], "outcome"),
		access: enumeration(value.access, ["granted", "denied"], "access"),
		data: strings(value.data, "caller data"), focus: text(value.focus, "focus"),
	};
}

/** @param {unknown} value @returns {TechnicalCase[]} */
function cases(value) {
	const result = list(value, "cases", 64, 3).map(entry => {
		object(entry, ["id", "input", "expected"], "technical case");
		object(entry.input, ["cancelled", "lateResult", "access", "data", "focus"], "technical case input");
		if (typeof entry.input.cancelled !== "boolean") fail("technical_workload_invalid", "Cancellation must be explicit");
		const supplied = {
			cancelled: entry.input.cancelled,
			lateResult: enumeration(entry.input.lateResult, ["granted", "denied"], "lateResult"),
			access: enumeration(entry.input.access, ["granted", "denied"], "input access"),
			data: strings(entry.input.data, "input data"), focus: text(entry.input.focus, "input focus"),
		};
		const expected = actual(entry.expected);
		if (!same(supplied.data, expected.data) || supplied.focus !== expected.focus
			|| expected.access !== (supplied.cancelled ? supplied.access : supplied.lateResult)) {
			fail("technical_workload_invalid", "Access, caller data and focus must be conserved");
		}
		return { id: identifier(entry.id), input: supplied, expected };
	});
	if (new Set(result.map(entry => entry.id)).size !== result.length) fail("technical_workload_invalid", "Case identities must be unique");
	return result;
}

/** Only reads immutable Git material. This does not materialize or execute code.
 * @param {TechnicalWorkload} pinned */
function inspectWorkload(pinned) {
	const { input: request } = pinned;
	if (request.before.commit === request.after.commit
		|| !same(request.before, { ...request.after, commit: request.before.commit })) {
		fail("technical_workload_invalid", "Only the immutable commit may change between evaluator procedures");
	}
	for (const bundle of [request.before, request.after]) {
		const entry = bundle.invocation.cwd === "." ? bundle.entryPoint : bundle.entryPoint.slice(bundle.invocation.cwd.length + 1);
		if (!same(bundle.invocation.argv, ["node", entry])) {
			fail("technical_workload_unsupported", "Only the pinned literal Node evaluator entry point is supported");
		}
	}
	const before = resolveEvaluatorBundle(request.repositoryPath, request.before);
	const after = resolveEvaluatorBundle(request.repositoryPath, request.after);
	if (before.digest !== pinned.beforeDigest || after.digest !== pinned.afterDigest) {
		fail("technical_workload_changed", "Immutable evaluator material or procedures differ from the trusted pins");
	}
	/** @param {typeof before} resolved @param {string} filename */
	const bytes = (resolved, filename) => {
		const file = resolved.files.find(entry => entry.path === filename);
		if (!file) fail("technical_workload_invalid", `Missing protected material: ${filename}`);
		return Buffer.from(file.content, "base64").toString("utf8");
	};
	const agreement = bytes(before, pinned.agreementPath);
	if (agreement !== bytes(after, pinned.agreementPath)
		|| agreement !== `${JSON.stringify(request.agreement, null, 2)}\n`
		|| createHash("sha256").update(agreement).digest("hex") !== pinned.agreementDigest) {
		fail("technical_workload_changed", "The exact canonical cancellation agreement must remain protected");
	}
	const oldCases = cases(parseJson(bytes(before, request.agreement.casesPath)));
	const newCases = cases(parseJson(bytes(after, request.agreement.casesPath)));
	if (bytes(before, request.agreement.casesPath) !== `${JSON.stringify(oldCases, null, 2)}\n`
		|| bytes(after, request.agreement.casesPath) !== `${JSON.stringify(newCases, null, 2)}\n`) {
		fail("technical_workload_invalid", "Consumer cases must be canonical closed JSON");
	}
	const permitted = structuredClone(oldCases);
	const target = permitted.find(entry => entry.id === request.agreement.scenarioId);
	if (!target || !target.input.cancelled || target.input.lateResult !== "denied" || target.input.access !== "granted"
		|| target.expected.outcome !== request.agreement.from
		|| !permitted.some(entry => !entry.input.cancelled && entry.input.lateResult === "denied" && entry.expected.outcome === "denied")) {
		fail("technical_workload_invalid", "The cancelled late-denial scenario and noncancelled denial control are required");
	}
	target.expected.outcome = request.agreement.to;
	if (!same(permitted, newCases)) fail("technical_workload_changed", "Only the obsolete cancelled outcome assertion may change");
	const oldMaterial = materialManifest(before.files), newMaterial = materialManifest(after.files);
	if (!oldMaterial.some(file => file.path === request.agreement.referencePath)
		|| !same(oldMaterial, newMaterial.map(file => file.path === request.agreement.casesPath
			? { ...file, digest: oldMaterial.find(old => old.path === file.path)?.digest } : file))) {
		fail("technical_workload_changed", "All protected executable, dependency, reference and mode identities must be conserved");
	}
	return newCases.map(({ id, expected: result }) => ({ id, actual: result }));
}

/** @param {unknown} value @param {TechnicalRequest} request */
function receipt(value, request) {
	object(value, ["requestId", "requestDigest", "status", "source", "permissionSource", "execution"], "technical receipt");
	if (value.requestId !== request.id || value.requestDigest !== analysisInputDigest(request)) {
		fail("technical_receipt_mismatch", "The outcome must correlate the exact request, owner and immutable workload");
	}
	const source = text(value.source, "receipt source");
	if (!source.startsWith("fixture:")) fail("technical_receipt_mismatch", "Fixture evidence cannot claim a native source");
	return { value, source };
}

/** No production route is currently offered. An explicitly fixture-only port exercises the
 * same input, ownership, permission and result checks without manufacturing native support.
 * Pins and observations come from trusted composition after canonical authority validation,
 * never public request JSON. This constructor neither grants authority nor publishes acceptance.
 * @param {{binding: TechnicalBinding, workload: TechnicalWorkload, current: () => unknown,
 * fixture?: TechnicalFixturePort}} options
 * @returns {TechnicalExecutor} */
export function createNativeTechnicalExecutor(options) {
	object(options, ["binding", "workload", "current", "fixture"], "technical adapter");
	const owner = binding(options.binding), pinned = workload(options.workload);
	if (typeof options.current !== "function" || pinned.input.repositoryPath !== owner.repositoryPath) {
		fail("technical_identity_invalid", "A current owner observation and the exact bound repository are required");
	}
	const observe = options.current;
	const fixture = options.fixture;
	if (fixture !== undefined) {
		object(fixture, ["route", "authorize", "execute"], "technical fixture port");
		if (fixture.route !== "fixture-process" || typeof fixture.authorize !== "function" || typeof fixture.execute !== "function") {
			fail("technical_execution_unavailable", TECHNICAL_EXECUTION_SUPPORT.missing, TECHNICAL_EXECUTION_SUPPORT);
		}
	}
	return async (supplied, signal) => {
		signal?.throwIfAborted();
		const initial = context(observe());
		const { toolCallId, agentId, inWorkflow, ...currentOwner } = initial;
		if (!same(owner, currentOwner)) fail("technical_identity_changed", "The current coordinator/project/owner binding differs");
		const decoded = input(supplied);
		if (!same(readJsonValue(supplied), pinned.input) || !same(decoded, pinned.input)) {
			fail("technical_workload_changed", "Only the exact trusted consumer-expectation workload can execute");
		}
		if (!fixture) fail("technical_execution_unavailable", TECHNICAL_EXECUTION_SUPPORT.missing, TECHNICAL_EXECUTION_SUPPORT);
		const expected = inspectWorkload(pinned);
		const request = { id: randomUUID(), context: initial, workload: structuredClone(pinned) };
		const requestDigest = analysisInputDigest(request);
		const authorize = fixture.authorize, execute = fixture.execute;
		const check = () => {
			signal?.throwIfAborted();
			if (!same(context(observe()), initial)) fail("technical_identity_changed", "Native ownership changed during technical execution");
			if (!same(readJsonValue(supplied), pinned.input) || analysisInputDigest(request) !== requestDigest
				|| fixture.route !== "fixture-process" || fixture.authorize !== authorize || fixture.execute !== execute) {
				fail("technical_workload_changed", "Technical input or the bound execution port changed during execution");
			}
		};
		/** Cancellation takes precedence even when a pending host call rejects with a late denial.
		 * @template T @param {() => Promise<T>} operation */
		async function boundary(operation) {
			check();
			try { return await operation(); }
			finally { check(); }
		}
		const permission = receipt(await boundary(() => authorize(request, signal)), request);
		if (Object.hasOwn(permission.value, "execution") || Object.hasOwn(permission.value, "permissionSource")
			|| permission.value.status !== "granted") {
			fail("technical_permission_rejected", "Fixture permission was denied, aborted, uncertain or malformed", permission.value);
		}
		const result = receipt(await boundary(() => execute(request, permission.source, signal)), request);
		if (result.value.status !== "completed") fail("technical_execution_incomplete", "Execution did not produce a correlated complete outcome", result.value);
		if (result.value.permissionSource !== permission.source) fail("technical_receipt_mismatch", "Execution must retain the exact permission receipt");
		const value = result.value.execution;
		object(value, ["source", "environment", "beforeExitCode", "afterExitCode", "before", "after"], "technical execution");
		const source = text(value.source, "execution source"), environment = text(value.environment, "execution environment");
		if (source !== result.source || environment !== pinned.environment
			|| value.beforeExitCode !== 1 || value.afterExitCode !== 0) {
			fail("technical_execution_failed", "The exact environment and actual old-failing/new-passing statuses are required");
		}
		/** @param {unknown} traces */
		const results = traces => list(traces, "case results", 64, 3).map(entry => {
			object(entry, ["id", "actual"], "case result");
			return { id: identifier(entry.id), actual: actual(entry.actual) };
		});
		const before = results(value.before), after = results(value.after);
		if (!same(before, expected) || !same(after, expected)) {
			fail("technical_execution_failed", "Every ordered case must retain its exact identity, access, data and focus result");
		}
		check();
		return { source, environment, beforeExitCode: value.beforeExitCode, afterExitCode: value.afterExitCode, before, after };
	};
}
