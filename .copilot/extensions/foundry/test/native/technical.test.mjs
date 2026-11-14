import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseJson, readRecord } from "../../data.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { consumerAgreement } from "../../factory/technical.mjs";
import { createNativeTechnicalExecutor, TECHNICAL_EXECUTION_SUPPORT } from "../../native/technical.mjs";
import { technicalFixture, technicalOwner } from "../application/fixture.mjs";
import { must } from "../assertions.mjs";

/** @typedef {import("../../types/factory.js").TechnicalExecutor} Executor */
/** @typedef {import("../../native/technical.mjs").TechnicalFixturePort} FixturePort */
/** @typedef {import("../../native/technical.mjs").TechnicalRequest} Request */
/** @typedef {import("../../types/factory.js").TechnicalExecution} Execution */

/** @param {Request} request @param {Execution} execution */
const completed = (request, execution) => ({
	requestId: request.id, requestDigest: analysisInputDigest(request), status: "completed",
	source: execution.source, permissionSource: `fixture:permission:${request.id}`, execution,
});

/** Real immutable processes come from the unchanged canonical fixture. All owner and
 * permission observations below are simulated, not App or extension-RPC evidence.
 * @param {import("node:test").TestContext} t
 * @param {Parameters<typeof technicalFixture>[1]} [options] */
async function setup(t, options) {
	const f = await technicalFixture(t, options);
	const bytes = Buffer.from(must(f.before.files.find(file => file.path === "technical/agreement.json")).content, "base64");
	const input = {
		repositoryPath: f.repositoryPath, before: f.before.bundle, after: f.after.bundle,
		agreement: consumerAgreement(parseJson(bytes.toString("utf8"))),
	};
	const binding = { owner: f.workspacePath, sessionId: technicalOwner.sessionId, projectId: "fixture-dotfiles", repositoryPath: f.repositoryPath };
	const workload = {
		input, beforeDigest: f.before.digest, afterDigest: f.after.digest,
		agreementPath: "technical/agreement.json", agreementDigest: createHash("sha256").update(bytes).digest("hex"),
		environment: f.definition.environment,
	};
	/** @type {Record<string, unknown>} */
	const current = { ...binding, toolCallId: technicalOwner.toolCallId, agentId: null, inWorkflow: false };
	/** @type {{operation: string, request: Request, signal?: AbortSignal}[]} */
	const calls = [];
	/** @type {FixturePort} */
	const port = {
		route: "fixture-process",
		async authorize(request, signal) {
			calls.push({ operation: "authorize", request: structuredClone(request), signal });
			return { requestId: request.id, requestDigest: analysisInputDigest(request), status: "granted", source: `fixture:permission:${request.id}` };
		},
		async execute(request, permissionSource, signal) {
			calls.push({ operation: "execute", request: structuredClone(request), signal });
			assert.equal(permissionSource, `fixture:permission:${request.id}`);
			return completed(request, await f.executor(request.workload.input, signal));
		},
	};
	/** @param {Partial<Parameters<typeof createNativeTechnicalExecutor>[0]>} [overrides] */
	const make = (overrides = {}) => createNativeTechnicalExecutor({ binding, workload, current: () => current, fixture: port, ...overrides });
	t.diagnostic(JSON.stringify({
		kind: "technical-pins", evidence: "confined fixture processes; simulated native identity and permission",
		binding, workload, before: f.before, after: f.after,
	}));
	return { ...f, input, binding, workload, current, calls, port, make };
}

test("NB-TECH-01/03/04/05: exact adapter executes immutable old-failing/new-passing workload and preserves every control", async t => {
	const f = await setup(t);
	const signal = new AbortController().signal;
	/** @type {Executor} */
	const execute = f.make();
	const before = f.factory.snapshot();
	const result = await execute(f.input, signal);
	assert.equal(result.beforeExitCode, 1);
	assert.equal(result.afterExitCode, 0);
	assert.equal(result.environment, f.definition.environment);
	assert.equal(result.source, `fixture:confined-node:${f.before.bundle.commit}:${f.after.bundle.commit}`);
	const expected = f.afterCases.map(({ id, expected: actual }) => ({ id, actual }));
	assert.deepEqual(result.before, expected);
	assert.deepEqual(result.after, expected);
	assert.equal(expected.length, 4);
	assert.deepEqual(f.calls.map(call => call.operation), ["authorize", "execute"]);
	assert.ok(f.calls.every(call => call.signal === signal));
	assert.deepEqual(f.calls[0].request, f.calls[1].request);
	assert.deepEqual(f.calls[0].request.workload, f.workload);
	assert.deepEqual(f.executions.map(run => run.exitCode), [1, 0]);
	assert.match(f.executions[0].stderr, /cancel-late-denial/);
	assert.equal(f.executions[0].stderr.trim().split("\n").length, 1);
	assert.equal(f.executions[1].stderr, "");
	assert.deepEqual(JSON.parse(f.executions[0].stdout), result.before);
	assert.deepEqual(JSON.parse(f.executions[1].stdout), result.after);
	assert.deepEqual(f.factory.snapshot(), before, "The adapter cannot publish acceptance");
	t.diagnostic(JSON.stringify({ kind: "technical-adapter-result", calls: f.calls, result, executions: f.executions }));

	const operations = f.reopen({ executeTechnical: execute });
	await f.grant(operations);
	await operations.factoryAction(await f.request(operations), { invocation: technicalOwner, signal });
	const plan = await operations.getPlan({ planId: f.plan.id });
	const decision = must(plan.technicalDecisions?.[0]);
	assert.equal(decision.sessionId, technicalOwner.sessionId);
	assert.deepEqual(decision.renewal?.execution, result);
	assert.deepEqual(decision.oldScope, decision.newScope);
	assert.equal(f.ui.calls, 0);
	assert.equal(f.factory.snapshot().contracts.length, before.contracts.length + 1);
});

test("NB-TECH-02: production is explicitly unsupported; neither primary tools nor extension RPC can be selected as a fixture route", async t => {
	const f = await setup(t);
	await assert.rejects(f.make({ fixture: undefined })(f.input), {
		code: "technical_execution_unavailable", details: TECHNICAL_EXECUTION_SUPPORT,
	});
	for (const route of ["primary-app-tool", "extension-rpc"]) {
		assert.throws(() => f.make({ fixture: Object.assign({}, f.port, { route }) }), { code: "technical_execution_unavailable" });
	}
	assert.deepEqual(f.calls, []);
	assert.deepEqual(f.executions, []);
	assert.equal(TECHNICAL_EXECUTION_SUPPORT.status, "unsupported");
	assert.match(TECHNICAL_EXECUTION_SUPPORT.missing, /permission.*procedure.*source\/environment\/exit\/case/);
	assert.match(TECHNICAL_EXECUTION_SUPPORT.provider, /host-provider.*foundry-operating-integration-v1/);
});

test("NB-TECH-01: every input identity is closed and pinned before permission or execution", async t => {
	const f = await setup(t);
	/** @type {[string, (value: Parameters<Executor>[0]) => void][]} */
	const mutations = [
		["repository", value => { value.repositoryPath += "/foreign"; }],
		["before commit", value => { value.before.commit = value.after.commit; }],
		["after commit", value => { value.after.commit = value.before.commit; }],
		["mutable ref", value => { value.before.commit = "main"; }],
		["version", value => { Object.assign(value.before, { version: 2 }); }],
		["root", value => { value.before.root = "different"; }],
		["entry", value => { value.after.entryPoint = "technical/foreign.mjs"; }],
		["support", value => { value.before.support = []; }],
		["argv", value => { value.after.invocation.argv.push("--unapproved"); }],
		["cwd", value => { value.before.invocation.cwd = "technical"; }],
		["agreement scenario", value => { value.agreement.scenarioId = "grant-control"; }],
		["agreement obligation", value => { value.agreement.obligation.revision++; }],
		["agreement cases", value => { value.agreement.casesPath = "different.json"; }],
		["agreement reference", value => { value.agreement.referencePath = "different.mjs"; }],
		["agreement assertion", value => { Object.assign(value.agreement, { assertion: "expected.access" }); }],
		["unknown input", value => { Object.assign(value, { publish: true }); }],
		["unknown bundle", value => { Object.assign(value.after, { shell: true }); }],
	];
	const execute = f.make();
	for (const [name, mutate] of mutations) await t.test(name, async () => {
		const changed = structuredClone(f.input);
		mutate(changed);
		await assert.rejects(execute(changed));
		assert.deepEqual(f.calls, []);
	});
});

test("NB-TECH-01/02: missing native observations, foreign repository bindings and caller-supplied support flags fail closed", async t => {
	const f = await setup(t);
	assert.throws(() => f.make({ current: undefined }), { code: "technical_identity_invalid" });
	assert.throws(() => f.make({ binding: { ...f.binding, repositoryPath: `${f.repositoryPath}/foreign` } }), { code: "technical_identity_invalid" });
	assert.throws(() => f.make({ fixture: Object.assign({}, f.port, { skipPermission: true }) }));
	assert.throws(() => f.make({ fixture: Object.assign({}, f.port, { execute: undefined }) }), { code: "technical_execution_unavailable" });
	for (const field of Object.keys(f.current)) {
		const incomplete = { ...f.current };
		delete incomplete[field];
		await assert.rejects(f.make({ current: () => incomplete })(f.input));
	}
	await assert.rejects(f.make({ current: () => ({ ...f.current, supported: true }) })(f.input));
	assert.deepEqual(f.calls, []);
	assert.deepEqual(f.executions, []);
});

test("NB-TECH-01/04: trusted pins cannot admit another procedure, agreement, executable edit or weakened conservation", async t => {
	const f = await setup(t);
	for (const change of [
		{ beforeDigest: "a".repeat(64) }, { afterDigest: "b".repeat(64) },
		{ agreementDigest: "c".repeat(64) }, { agreementPath: "technical/missing.json" },
	]) {
		await assert.rejects(f.make({ workload: { ...f.workload, ...change } })(f.input));
		assert.deepEqual(f.calls, []);
	}
	for (const argv of [["node", "--eval", "technical/run.mjs"], ["sh", "technical/run.mjs"]]) {
		const changed = structuredClone(f.workload);
		changed.input.before.invocation.argv = argv;
		changed.input.after.invocation.argv = argv;
		await assert.rejects(f.make({ workload: changed })(changed.input), { code: "technical_workload_unsupported" });
	}
	/** @type {[string, Parameters<typeof technicalFixture>[1]][]} */
	const changes = [
		["reference implementation", { changeFiles: files => { files["technical/reference.mjs"] += "\n"; } }],
		["extra material", { changeFiles: files => { files["technical/extra.mjs"] = "throw new Error('not admitted');\n"; } }],
		["focus", { changeCases: values => { values[0].expected.focus = "#foreign"; } }],
		["caller data", { changeCases: values => { values[0].expected.data = []; } }],
		["denial control", { changeCases: values => { values.splice(1, 1); } }],
		["other case", { changeCases: values => { values[2].expected.outcome = "denied"; } }],
	];
	for (const [name, options] of changes) await t.test(name, async t => {
		const changed = await setup(t, options);
		await assert.rejects(changed.make()(changed.input));
		assert.deepEqual(changed.calls, []);
		assert.deepEqual(changed.executions, []);
	});
});

test("NB-TECH-01/03: all current identity fields are checked before and after each asynchronous boundary", async t => {
	const f = await setup(t);
	const captured = await f.executor(f.input);
	const initial = structuredClone(f.current);
	const authorize = f.port.authorize;
	/** @type {FixturePort["execute"]} */
	const execute = async request => {
		f.calls.push({ operation: "execute", request: structuredClone(request) });
		return completed(request, structuredClone(captured));
	};
	const changes = {
		owner: `${f.binding.owner}/foreign`, sessionId: "foreign", projectId: "foreign",
		repositoryPath: `${f.repositoryPath}/foreign`, toolCallId: "changed-call", agentId: "subagent", inWorkflow: true,
	};
	for (const phase of ["before", "permission", "execution"]) for (const [field, value] of Object.entries(changes)) {
		// A new call may legitimately have a new toolCallId; drift within a call may not.
		if (phase === "before" && field === "toolCallId") continue;
		await t.test(`${phase}/${field}`, async () => {
			Object.assign(f.current, initial);
			f.calls.length = 0;
			f.port.authorize = async (request, signal) => {
				const result = await authorize(request, signal);
				if (phase === "permission") f.current[field] = value;
				return result;
			};
			f.port.execute = async (request, permissionSource, signal) => {
				const result = await execute(request, permissionSource, signal);
				if (phase === "execution") f.current[field] = value;
				return result;
			};
			if (phase === "before") f.current[field] = value;
			await assert.rejects(f.make()(f.input), error => {
				assert.ok(error instanceof Error);
				return /owning coordinator|binding differs|ownership changed/.test(error.message);
			});
			assert.deepEqual(f.calls.map(call => call.operation),
				phase === "before" ? [] : phase === "permission" ? ["authorize"] : ["authorize", "execute"]);
		});
	}
});

test("NB-TECH-03: closed correlated output rejects missing, duplicate, foreign, truncated and malformed evidence without replay", async t => {
	const f = await setup(t);
	const captured = await f.executor(f.input);
	/** @type {[string, (value: ReturnType<typeof completed>) => unknown][]} */
	const changes = [
		["missing", () => null],
		["truncated JSON", () => '{"status":"completed"'],
		["foreign request", value => ({ ...value, requestId: "foreign" })],
		["foreign digest", value => ({ ...value, requestDigest: "d".repeat(64) })],
		["foreign permission", value => ({ ...value, permissionSource: "fixture:foreign" })],
		["unknown envelope", value => ({ ...value, native: true })],
		["non-native source claim", value => ({ ...value, source: "native:forged" })],
		["missing execution", ({ execution, ...value }) => value],
		["missing environment", value => { const { environment, ...execution } = value.execution; return { ...value, execution }; }],
		["missing source", value => { const { source, ...execution } = value.execution; return { ...value, execution }; }],
		["source mismatch", value => ({ ...value, source: "fixture:foreign" })],
		["environment mismatch", value => ({ ...value, execution: { ...value.execution, environment: "native" } })],
		["missing before status", value => { const { beforeExitCode, ...execution } = value.execution; return { ...value, execution }; }],
		["string status", value => ({ ...value, execution: { ...value.execution, afterExitCode: "0" } })],
		["old unexpectedly passed", value => ({ ...value, execution: { ...value.execution, beforeExitCode: 0 } })],
		["new failed", value => ({ ...value, execution: { ...value.execution, afterExitCode: 1 } })],
		["unknown execution", value => ({ ...value, execution: { ...value.execution, accepted: true } })],
		["missing before case", value => { value.execution.before.pop(); return value; }],
		["missing after case", value => { value.execution.after.pop(); return value; }],
		["duplicate case", value => { value.execution.after[1] = value.execution.after[0]; return value; }],
		["foreign case", value => { value.execution.before[0].id = "foreign"; return value; }],
		["extra case", value => { value.execution.after.push(value.execution.after[0]); return value; }],
		["reordered cases", value => { value.execution.after.reverse(); return value; }],
		["truncated cases", value => ({ ...value, execution: { ...value.execution, after: "[truncated]" } })],
		["unknown case result", value => { Object.assign(value.execution.after[0], { passed: true }); return value; }],
		["unknown actual", value => { Object.assign(value.execution.after[0].actual, { native: true }); return value; }],
		["bad outcome", value => { Object.assign(value.execution.after[0].actual, { outcome: "success" }); return value; }],
		["access loss", value => { value.execution.after[0].actual.access = "denied"; return value; }],
		["caller data loss", value => { value.execution.before[0].actual.data = []; return value; }],
		["focus loss", value => { value.execution.after[0].actual.focus = "#foreign"; return value; }],
		["denial control weakened", value => { value.execution.after[1].actual.outcome = "cancelled"; return value; }],
	];
	for (const [name, mutate] of changes) await t.test(name, async () => {
		f.calls.length = 0;
		f.port.execute = async request => {
			f.calls.push({ operation: "execute", request: structuredClone(request) });
			return mutate(completed(request, structuredClone(captured)));
		};
		await assert.rejects(f.make()(f.input));
		assert.deepEqual(f.calls.map(call => call.operation), ["authorize", "execute"]);
	});
	assert.equal(f.executions.length, 2, "Decoder mutations reuse retained real traces, never launch alternate executions");
});

test("NB-TECH-02/03/04: unsupported, denied, uncertain and mismatched calls never publish or retry", async t => {
	const f = await setup(t);
	const captured = await f.executor(f.input);
	await f.grant();
	const before = f.factory.snapshot();
	const initialPermission = f.port.authorize;
	for (const mode of ["unsupported", "denied", "cancelled", "uncertain", "malformed-permission", "foreign-permission", "incomplete", "mismatched", "throw"]) {
		await t.test(mode, async () => {
			f.calls.length = 0;
			const failure = new Error("Uncertain native transport failure; do not retry");
			f.port.authorize = async (request, signal) => {
				const result = readRecord(await initialPermission(request, signal));
				if (["denied", "cancelled", "uncertain"].includes(mode)) return { ...result, status: mode };
				if (mode === "malformed-permission") return { ...result, execution: captured };
				if (mode === "foreign-permission") return { ...result, requestId: "foreign" };
				return result;
			};
			f.port.execute = async request => {
				f.calls.push({ operation: "execute", request: structuredClone(request) });
				if (mode === "throw") throw failure;
				const result = completed(request, structuredClone(captured));
				return mode === "incomplete" ? { ...result, status: "uncertain" } : { ...result, requestDigest: "0".repeat(64) };
			};
			const operations = f.reopen({ executeTechnical: f.make(mode === "unsupported" ? { fixture: undefined } : {}) });
			const invocation = operations.factoryAction(await f.request(operations), { invocation: technicalOwner });
			if (mode === "throw") await assert.rejects(invocation, error => error === failure);
			else await assert.rejects(invocation);
			assert.deepEqual(f.factory.snapshot(), before);
			assert.deepEqual((await operations.getPlan({ planId: f.plan.id })).technicalDecisions ?? [], []);
			assert.deepEqual(f.calls.map(call => call.operation), mode === "unsupported" ? []
				: ["incomplete", "mismatched", "throw"].includes(mode) ? ["authorize", "execute"] : ["authorize"]);
			assert.equal(f.ui.calls, 0);
		});
	}
});

test("NB-TECH-03/04: cancellation wins over late denied results and rejections at both boundaries without publication", async t => {
	const f = await setup(t);
	const captured = await f.executor(f.input);
	await f.grant();
	const before = f.factory.snapshot();
	const authorize = f.port.authorize;
	for (const phase of ["before", "permission-result", "permission-error", "execution-result", "execution-error"]) {
		await t.test(phase, async () => {
			f.calls.length = 0;
			const controller = new AbortController();
			const cancellation = new Error("cancelled by caller");
			const denial = new Error("late native denial");
			if (phase === "before") controller.abort(cancellation);
			f.port.authorize = async (request, signal) => {
				assert.equal(signal, controller.signal);
				const result = readRecord(await authorize(request, signal));
				if (phase.startsWith("permission")) {
					controller.abort(cancellation);
					if (phase.endsWith("error")) throw denial;
					return { ...result, status: "denied" };
				}
				return result;
			};
			f.port.execute = async (request, permissionSource, signal) => {
				assert.equal(signal, controller.signal);
				f.calls.push({ operation: "execute", request: structuredClone(request), signal });
				controller.abort(cancellation);
				if (phase.endsWith("error")) throw denial;
				return { ...completed(request, structuredClone(captured)), status: "denied" };
			};
			const operations = f.reopen({ executeTechnical: f.make() });
			await assert.rejects(operations.factoryAction(await f.request(operations), { invocation: technicalOwner, signal: controller.signal }),
				error => error === cancellation);
			assert.deepEqual(f.factory.snapshot(), before);
			assert.deepEqual((await operations.getPlan({ planId: f.plan.id })).technicalDecisions ?? [], []);
			assert.deepEqual(f.calls.map(call => call.operation), phase === "before" ? []
				: phase.startsWith("permission") ? ["authorize"] : ["authorize", "execute"]);
		});
	}
});

test("NB-TECH-01/03: caller input, exact request and port substitution are rejected across awaits", async t => {
	const f = await setup(t);
	const captured = await f.executor(f.input);
	const authorize = f.port.authorize;
	for (const phase of ["permission", "execution"]) for (const mutation of ["input", "request", "port"]) {
		await t.test(`${phase}/${mutation}`, async () => {
			f.calls.length = 0;
			const supplied = structuredClone(f.input);
			/** @param {Request} request */
			const mutate = request => {
				if (mutation === "input") supplied.after.invocation.argv.push("--changed");
				else if (mutation === "request") request.workload.afterDigest = "0".repeat(64);
				else f.port.execute = async () => { assert.fail("Substituted executor must not run"); };
			};
			f.port.authorize = async (request, signal) => {
				const result = await authorize(request, signal);
				if (phase === "permission") mutate(request);
				return result;
			};
			f.port.execute = async request => {
				f.calls.push({ operation: "execute", request: structuredClone(request) });
				const result = completed(request, structuredClone(captured));
				if (phase === "execution") mutate(request);
				return result;
			};
			await assert.rejects(f.make()(supplied), { code: "technical_workload_changed" });
			assert.deepEqual(f.calls.map(call => call.operation), phase === "permission" ? ["authorize"] : ["authorize", "execute"]);
		});
	}
});
