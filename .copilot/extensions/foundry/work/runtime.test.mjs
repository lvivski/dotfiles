import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntime } from "./runtime.mjs";
import { renderBoard, startBoard } from "./board.mjs";
import { record, text } from "./values.mjs";
import { readCandidate } from "./artifacts.mjs";
import { createIssueSource } from "./issues.mjs";
import { buildHooks } from "../hooks.mjs";
import { admittedEvidence } from "./native.mjs";
import { readCommandEvents } from "./recovery.mjs";

/** @param {import("node:test").TestContext} t @param {Partial<Omit<Parameters<typeof createRuntime>[0],"directory">>} [hooks] */
function fixture(t, hooks = {}) {
	const directory = mkdtempSync(path.join(os.tmpdir(), "foundry-runtime-"));
	execFileSync("git", ["init", "--quiet", directory]);
	const runtime = createRuntime({ directory, log: message => { throw new Error(message); }, ...hooks });
	t.after(() => { runtime.close(); rmSync(directory, { recursive: true, force: true }); });
	return { runtime, directory };
}

const definition = {
	title: "One independently evaluated assignment",
	scope: { mode: "autopilot", delegation: true, workTypes: ["analysis"], paths: ["."], restrictions: ["Do not commit or push"] },
	tasks: [{
		title: "Evaluate assigned behavior", workType: "analysis", assignment: "Run the assigned inline oracle and report its raw output.",
		checks: [{ id: "behavior", origin: "contract", requirement: "The assigned calculation holds", kind: "command", command: "node -e 'if (1 + 1 !== 2) process.exit(1)'" }],
	}],
};

/** @param {string} directory @param {Record<string,unknown>} [overrides] */
function factorySource(directory, overrides = {}) {
	mkdirSync(path.join(directory, ".foundry"), { recursive: true });
	const policy = {
		format: "foundry-factory", version: 2, id: "fixture-factory", mechanism: "stop-hook",
		maximumJobs: 1, blocks: 3, completionTaskId: "complete",
		goal: { ...definition, scope: { ...definition.scope, mode: "interactive" },
			tasks: [{ ...definition.tasks[0], id: "complete" }] },
		...overrides,
	};
	writeFileSync(path.join(directory, ".foundry/factory.json"), JSON.stringify(policy));
	return ".foundry/factory.json";
}

test("factory activation still requires actual native mode and observed stop-hook capability", async t => {
	const { runtime, directory } = fixture(t);
	const source = factorySource(directory);
	await assert.rejects(runtime.operation("start_factory", { source }, "director"), /actual stop hook/);
	runtime.agentStop("director");
	await assert.rejects(runtime.operation("start_factory", { source }, "director"), { code: "native_inspection_unavailable" });
	assert.equal(runtime.store().snapshot().goals.length, 0);
	const mismatched = fixture(t, { stopHookQualified: true, readMode: async () => "autopilot" });
	await assert.rejects(mismatched.runtime.operation("start_factory", { source: factorySource(mismatched.directory) }, "director"),
		{ code: "native_mode_mismatch" });
	assert.equal(mismatched.runtime.store().snapshot().factories?.length, 0);
});

for (const [mechanism, mode] of [["native", "autopilot"], ["native", "interactive"], ["stop-hook", "interactive"]]) for (const unavailable of [true, false]) {
	test(`${mechanism} factory starts and restarts with ${mode} coordinator and ${unavailable ? "unavailable" : "unusable"} native confirmation`, async t => {
		const workerMode = mechanism === "native" ? "autopilot" : "interactive";
		const { runtime, directory } = fixture(t, { stopHookQualified: mechanism === "stop-hook", readMode: async () => mode,
			...(unavailable ? {} : { confirm: async () => { assert.fail("Activation must not request a confirmation dialog"); } }) });
		const source = factorySource(directory, { mechanism, blocks: mechanism === "native" ? undefined : 3,
			goal: { ...definition, scope: { ...definition.scope, mode: workerMode }, tasks: [{ ...definition.tasks[0], id: "complete" }] } });
		const started = record(await runtime.operation("start_factory", { source }, "director"));
		assert.equal(record(started.factory).state, "active");
		const dispatch = record(await runtime.operation("advance", {}, "director"));
		assert.ok(Array.isArray(dispatch.prepared));
		assert.equal(record(record(record(dispatch.prepared[0]).arguments).kickoff).mode, workerMode);
		if (mechanism === "native") {
			assert.equal(runtime.store().factory("fixture-factory", "director").blocks, undefined);
			assert.equal(runtime.agentStop("director"), undefined);
			assert.equal(runtime.store().factory("fixture-factory", "director").state, "active");
		}
		runtime.nativeAbort({ reason: "user_initiated" }, "director");
		assert.equal(runtime.store().factory("fixture-factory", "director").state, "paused");
		await runtime.operation("start_factory", { source }, "director");
		assert.equal(runtime.store().factory("fixture-factory", "director").state, "active");
	});
}

test("native factory activation rejects plan mode without requiring an unused stop-hook bound", async t => {
	const { runtime, directory } = fixture(t, { readMode: async () => "plan" });
	await assert.rejects(runtime.operation("start_factory", { source: factorySource(directory, {
		mechanism: "native", blocks: undefined,
		goal: { ...definition, tasks: [{ ...definition.tasks[0], id: "complete" }] },
	}) }, "director"), { code: "native_mode_mismatch" });
	assert.equal(runtime.store().snapshot().factories?.length, 0);
});

for (const blocks of [0, -1]) test(`stop-hook factory rejects a ${blocks === 0 ? "zero" : "negative"} continuation bound`, async t => {
	const { runtime, directory } = fixture(t, { stopHookQualified: true, readMode: async () => "interactive" });
	await assert.rejects(runtime.operation("start_factory", { source: factorySource(directory, { blocks }) }, "director"),
		{ code: "invalid_field", message: /stop-hook continuation blocks/ });
	assert.equal(runtime.store().snapshot().factories?.length, 0);
});

test("omitted tuning is resolved, reported, and enforced without changing recorded settings on reload", async t => {
	/** @type {string[]} */
	const warnings = [];
	const options = { stopHookQualified: true, readMode: async () => "interactive", log: (/** @type {string} */ message) => { warnings.push(message); } };
	const { runtime, directory } = fixture(t, options);
	const source = factorySource(directory, { maximumJobs: undefined, blocks: undefined });
	const original = readFileSync(path.join(directory, source), "utf8");
	const started = record(await runtime.operation("start_factory", { source }, "director"));
	const expected = { maximumJobs: { value: 1, origin: "default" }, blocks: { value: 3, origin: "default" }, perJobLimits: {} };
	assert.deepEqual(started.settings, expected);
	assert.equal(readFileSync(path.join(directory, source), "utf8"), original);
	const saved = runtime.store().factory("fixture-factory", "director");
	assert.equal(record(saved.definition).maximumJobs, 1);
	assert.equal(record(saved.definition).blocks, 3);
	assert.deepEqual(saved.settingOrigins, { maximumJobs: "default", blocks: "default" });
	await runtime.operation("start_factory", { source }, "director");
	factorySource(directory, { blocks: 9 });
	runtime.close();
	const resumed = createRuntime({ directory, ...options });
	t.after(() => resumed.close());
	const context = record(await resumed.operation("get_context", {}, "director"));
	assert.ok(Array.isArray(context.factories));
	assert.deepEqual(record(context.factories[0]).settings, expected);
	for (let index = 0; index < 3; index++) assert.equal(resumed.agentStop("director")?.decision, "block");
	assert.equal(resumed.agentStop("director"), undefined);
	assert.equal(resumed.store().factory("fixture-factory", "director").state, "paused");
	assert.equal(warnings.length, 1);
	await assert.rejects(resumed.operation("start_factory", { source }, "director"), { code: "factory_conflict" });
});

/** @type {Array<[Record<string,unknown>,string]>} */
const invalidFactorySettings = [
	[{ maximumJobs: 0 }, "invalid_field"],
	[{ maximumJobs: 1.5 }, "invalid_field"],
	[{ maximumJobs: null }, "invalid_field"],
	[{ maximumJobs: 2 }, "factory_capacity_scope"],
	[{ settingOrigins: { maximumJobs: "user" } }, "unsupported_fields"],
];
for (const [overrides, code] of invalidFactorySettings) test(`invalid or unsupported factory settings are not silently defaulted: ${JSON.stringify(overrides)}`, async t => {
	const { runtime, directory } = fixture(t, { stopHookQualified: true, readMode: async () => "interactive" });
	await assert.rejects(runtime.operation("start_factory", { source: factorySource(directory, overrides) }, "director"), { code });
	assert.equal(runtime.store().snapshot().factories?.length, 0);
	assert.equal(runtime.store().snapshot().goals.length, 0);
});

test("native factories reject irrelevant stop-hook settings instead of requesting a bound", async t => {
	const { runtime, directory } = fixture(t, { readMode: async () => "interactive" });
	await assert.rejects(runtime.operation("start_factory", { source: factorySource(directory, {
		mechanism: "native", goal: { ...definition, tasks: [{ ...definition.tasks[0], id: "complete" }] },
	}) }, "director"), { code: "continuation_setting_conflict" });
	assert.equal(runtime.store().snapshot().factories?.length, 0);
});

for (const change of ["directory", "close"]) test(`factory activation rejects a runtime ${change} during native mode inspection`, async t => {
	const alternate = fixture(t).directory;
	const { runtime, directory } = fixture(t, { stopHookQualified: true, readMode: async () => {
		if (change === "directory") runtime.setDirectory(alternate);
		else runtime.close();
		return "interactive";
	} });
	await assert.rejects(runtime.operation("start_factory", { source: factorySource(directory) }, "director"),
		{ code: "factory_context_changed" });
	assert.equal(existsSync(path.join(directory, ".git/foundry/work.sqlite")), false);
	assert.equal(existsSync(path.join(alternate, ".git/foundry/work.sqlite")), false);
});

test("coordinator abort fences prepared creation across reload and only an explicit restart admits fresh work", async t => {
	const options = { stopHookQualified: true, readMode: async () => "interactive" };
	const { runtime, directory } = fixture(t, options);
	const source = factorySource(directory);
	await runtime.operation("start_factory", { source }, "director");
	const dispatch = record(await runtime.operation("advance", {}, "director"));
	assert.ok(Array.isArray(dispatch.prepared));
	const call = record(dispatch.prepared[0]);
	runtime.nativeAbort({ reason: "user_initiated" }, "director");
	assert.throws(() => runtime.pre("create_session", call.arguments, "director", "revoked-creation"), /current|cancelled|paused/);
	runtime.close();
	const resumed = createRuntime({ directory, log: message => { throw new Error(message); }, ...options });
	t.after(() => resumed.close());
	resumed.attachUsage("director");
	assert.equal(resumed.agentStop("director"), undefined);
	const paused = record(await resumed.operation("advance", {}, "director"));
	assert.ok(Array.isArray(paused.prepared));
	assert.equal(paused.prepared.length, 0);
	await resumed.operation("start_factory", { source }, "director");
	const fresh = record(await resumed.operation("advance", {}, "director"));
	assert.ok(Array.isArray(fresh.prepared));
	assert.notEqual(record(fresh.prepared[0]).attemptId, call.attemptId);
});

test("exclusive stop-hook continuation pauses unchanged execution without inventing a failed check", async t => {
	const warnings = [];
	const { runtime, directory } = fixture(t, { stopHookQualified: true, readMode: async () => "interactive",
		confirm: async () => true, log: message => { warnings.push(message); } });
	await runtime.operation("start_factory", { source: factorySource(directory) }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	assert.equal(runtime.agentStop("director")?.decision, "block");
	assert.equal(runtime.agentStop("director", true), undefined);
	assert.equal(runtime.store().getTask(task.id).state, "blocked");
	assert.equal(runtime.store().getTask(task.id).waiting?.cause, "stalled");
	assert.equal(runtime.store().snapshot().attempts[0].slot, false);
	assert.equal(runtime.store().evidenceForAttempt(text(runtime.store().getTask(task.id).currentAttemptId, "attempt")).length, 0);
	assert.equal(runtime.store().snapshot().factories?.[0].state, "paused");
	assert.equal(warnings.length, 1);
});

for (const stalled of [true, false]) test(`explicit ${stalled ? "stalled" : "active"} factory restart retires only its unissued stale create`, async t => {
	const { runtime, directory } = fixture(t, { ...authorizedFactory, log: () => {} });
	const source = factorySource(directory);
	await runtime.operation("start_factory", { source }, "director");
	const original = record(await runtime.operation("advance", {}, "director"));
	assert.ok(Array.isArray(original.prepared));
	const old = record(original.prepared[0]);
	if (stalled) {
		assert.equal(runtime.agentStop("director")?.decision, "block");
		assert.equal(runtime.agentStop("director", true), undefined);
		assert.equal(runtime.store().factory("fixture-factory", "director").state, "paused");
	}
	await runtime.operation("start_factory", { source }, "director");
	const restarted = record(await runtime.operation("advance", {}, "director"));
	assert.ok(Array.isArray(restarted.prepared));
	const fresh = record(restarted.prepared[0]);
	assert.notEqual(fresh.attemptId, old.attemptId);
	assert.notEqual(fresh.token, old.token);
	const retired = runtime.store().getEffect(text(old.effectId, "old create"));
	assert.equal(retired.state, "settled");
	assert.equal(record(retired.result).neverIssued, true);
	assert.equal(runtime.store().getAttempt(text(old.attemptId, "old attempt")).slot, false);
	assert.equal(runtime.store().getTask(text(old.taskId, "task")).repairs ?? 0, 0);
	runtime.pre("create_session", fresh.arguments, "director", "fresh-generation-create");
	assert.equal(runtime.store().getEffect(text(fresh.effectId, "fresh create")).state, "issued");
	assert.throws(() => runtime.pre("create_session", old.arguments, "director", "revoked-create"), /current|cancelled|stale/);
});

test("explicit restart retains an already-issued creation and its late native identity", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	const source = factorySource(directory);
	await runtime.operation("start_factory", { source }, "director");
	const batch = record(await runtime.operation("advance", {}, "director"));
	assert.ok(Array.isArray(batch.prepared));
	const call = record(batch.prepared[0]);
	runtime.pre("create_session", call.arguments, "director", "original-create");
	await runtime.operation("start_factory", { source }, "director");
	const restarted = record(await runtime.operation("advance", {}, "director"));
	assert.deepEqual(restarted.prepared, []);
	assert.equal(runtime.store().snapshot().attempts.length, 1);
	assert.equal(runtime.store().getEffect(text(call.effectId, "issued create")).state, "issued");
	runtime.post("create_session", call.arguments, { id: "existing-worker" }, "director");
	assert.equal(runtime.store().getAttempt(text(call.attemptId, "existing attempt")).nativeId, "existing-worker");
	assert.equal(runtime.store().snapshot().attempts.length, 1);
});

test("factory advancement alone retries known failed owner wakes without replaying queue acceptance", async t => {
	const requests = [];
	const errors = [];
	const { runtime, directory } = fixture(t, { ...authorizedFactory, readSession: async id => ({ id }),
		log: message => errors.push(message), execute: async (name, args) => {
			assert.equal(name, "send_session_message");
			requests.push(args);
			return requests.length === 1 ? { resultType: "failure", error: "Transient queue rejection" }
				: { resultType: "success", textResultForLlm: "Queued" };
		} });
	await runtime.operation("start_factory", { source: factorySource(directory) }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("reassign_task", { taskId: task.id, newOwner: "worker-b" }, "director");
	const failed = record(await runtime.operation("advance", {}, "director"));
	assert.ok(Array.isArray(failed.delivery));
	assert.equal(record(failed.delivery[0]).state, "failed-native-delivery");
	const retried = record(await runtime.operation("advance", {}, "director"));
	assert.ok(Array.isArray(retried.delivery));
	assert.equal(record(retried.delivery[0]).state, "native-queue-accepted");
	await runtime.operation("advance", {}, "director");
	assert.equal(requests.length, 2);
	assert.equal(errors.length, 1);
	assert.equal(runtime.store().getTask(task.id).owner, "worker-b");
});

for (const mechanism of ["native", "stop-hook"]) for (const nativeFlag of [false, true]) test(`${mechanism} factory advancement observes ${nativeFlag ? "the native input flag" : "nullable input clearance"} before resuming the same attempt`, async t => {
	let answered = false;
	const { runtime, directory } = fixture(t, { ...authorizedFactory,
		readSession: async id => ({ id, ...(nativeFlag ? { awaiting_user_input: !answered, ...(answered ? {} : { awaiting_input: null }) }
			: answered ? { awaiting_input: null } : {}) }) });
	await runtime.operation("start_factory", { source: factorySource(directory, mechanism === "native" ? {
		mechanism, blocks: undefined, goal: { ...definition, tasks: [{ ...definition.tasks[0], id: "complete" }] },
	} : {}) }, "director");
	const task = runtime.store().snapshot().tasks[0];
	const attempt = record(await runtime.operation("start_task", { taskId: task.id }, "director"));
	await runtime.operation("wait_task", { taskId: task.id, kind: "input", reason: "Actual decision",
		requestId: "native-question" }, "director");
	const waiting = record(await runtime.operation("advance", {}, "director"));
	assert.ok(Array.isArray(waiting.advancement));
	assert.equal(record(waiting.advancement[0]).disposition, "needs-input");
	assert.equal(runtime.store().getTask(task.id).waiting?.kind, "input");
	answered = true;
	const cleared = record(await runtime.operation("advance", {}, "director"));
	assert.ok(Array.isArray(cleared.advancement));
	assert.deepEqual(record(cleared.advancement[0]).actions, [{ taskId: task.id, kind: "resume" }]);
	assert.deepEqual(cleared.prepared, []);
	assert.equal(runtime.store().openInputRequests("director").length, 0);
	const resumed = record(await runtime.operation("resume_task", { taskId: task.id }, "director"));
	assert.equal(resumed.id, attempt.id);
	assert.equal(resumed.nativeId, "director");
	assert.equal(runtime.store().snapshot().attempts.length, 1);
});

for (const changedDirectory of [false, true]) test(`owner input recovery refuses ${changedDirectory ? "a changed repository context" : "a foreign native identity"}`, async t => {
	const { runtime, directory } = fixture(t, { ...authorizedFactory, readSession: async id => {
		if (changedDirectory) runtime.setDirectory(path.join(directory, "replacement"));
		return { id: changedDirectory ? id : "another-native-session", awaiting_input: null };
	} });
	mkdirSync(path.join(directory, "replacement"));
	execFileSync("git", ["init", "--quiet", path.join(directory, "replacement")]);
	await runtime.operation("start_factory", { source: factorySource(directory) }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	await runtime.operation("wait_task", { taskId: task.id, kind: "input", reason: "Actual decision", requestId: "native-question" }, "director");
	const databasePath = runtime.store().databasePath;
	await assert.rejects(runtime.operation("advance", {}, "director"), {
		code: changedDirectory ? "context_changed" : "native_identity_mismatch",
	});
	const db = new DatabaseSync(databasePath, { readOnly: true });
	const saved = record(JSON.parse(text(db.prepare("SELECT document FROM tasks WHERE id=?").get(task.id)?.document, "original task")));
	assert.equal(record(saved.waiting).kind, "input");
	db.close();
});

test("factory completion seals actual acceptance, protects inputs, and preserves historical delivery on reopen", async t => {
	const { runtime, directory } = fixture(t, { stopHookQualified: true, readMode: async () => "interactive", confirm: async () => true });
	const source = factorySource(directory, { goal: { ...definition, scope: { ...definition.scope, mode: "interactive" }, tasks: [
		{ ...definition.tasks[0], id: "producer", checks: [] },
		{ ...definition.tasks[0], id: "complete", inputs: [{ taskId: "producer", output: "result" }] },
	] } });
	await runtime.operation("start_factory", { source }, "director");
	const [producer, complete] = runtime.store().snapshot().tasks;
	await runtime.operation("start_task", { taskId: producer.id }, "director");
	await runtime.operation("report_result", { taskId: producer.id, summary: "Input ready",
		outputs: [{ name: "result", kind: "analysis", reference: "immutable:fixture", version: "v1" }] }, "director");
	await assert.rejects(runtime.operation("evolve_task", { taskId: complete.id, expectedVersion: 1, inputs: [] }, "director"), /requirements cannot be removed/);
	await runtime.operation("start_task", { taskId: complete.id }, "director");
	assert.equal(runtime.store().snapshot().completions?.[0].delivered, false);
	const prepared = record(await runtime.operation("prepare_check", { taskId: complete.id, checkId: "behavior" }, "director"));
	runtime.pre("bash", prepared.arguments, "director", "completion-check");
	const stdout = execFileSync("/bin/sh", ["-c", text(record(prepared.arguments).command, "command")], { encoding: "utf8" });
	runtime.post("bash", prepared.arguments, { resultType: "success", textResultForLlm: stdout }, "director");
	await runtime.operation("report_result", { taskId: complete.id, summary: "Final behavior accepted",
		outputs: [{ name: "accepted", kind: "analysis", reference: "immutable:completion", version: "v1" }] }, "director");
	assert.equal(runtime.store().snapshot().completions?.[0].delivered, true);
	await assert.rejects(runtime.operation("create_task", { goalId: producer.goalId, title: "Late work", assignment: "Unaccounted work", workType: "analysis" }, "director"), { code: "job_closed" });
	await runtime.operation("reopen_job", { goalId: producer.goalId }, "director");
	assert.equal(runtime.store().snapshot().completions?.[0].delivered, false);
	assert.equal(runtime.store().outputForInput({ taskId: complete.id, output: "accepted", version: "v1" })?.version, "v1");
});

test("qualified native refusal settles only its actual pre-start command, not a rejected follow-up read", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	runtime.pre("bash", { command: "echo inspected", shellId: "refused-shell" }, "director", "refused-call");
	runtime.nativeAbort({ finalTool: { status: "denied", toolCallId: "refused-call" } }, "director");
	assert.equal(runtime.store().getEffect("command:refused-call").state, "settled");
	assert.equal(record(runtime.store().getEffect("command:refused-call").result).neverIssued, true);
	runtime.pre("bash", { command: "sleep 1", shellId: "live-shell" }, "director", "live-call");
	runtime.pre("read_bash", { shellId: "live-shell" }, "director", "rejected-read");
	runtime.nativeAbort({ finalTool: { status: "rejected", toolCallId: "rejected-read" } }, "director");
	assert.equal(runtime.store().getEffect("command:live-call").state, "issued");
});

const authorizedFactory = { stopHookQualified: true, readMode: async () => "interactive", confirm: async () => true };
const issuePolicy = { kind: "github-issue", repository: "example/project", actors: ["trusted"], maximumEvents: 2 };
const sourceEvent = { number: 1, state: "open", user: { login: "trusted" }, title: "Requested outcome", body: "Source data", last_edited_at: null, updated_at: "2026-01-01T00:00:00Z" };

/** @param {ReturnType<typeof createRuntime>} runtime @param {string} taskId @param {string} [actor] */
async function acceptInline(runtime, taskId, actor = "director") {
	await runtime.operation("start_task", { taskId }, actor);
	const prepared = record(await runtime.operation("prepare_check", { taskId, checkId: "behavior" }, actor));
	runtime.pre("bash", prepared.arguments, actor, `native:${String(prepared.effectId)}`);
	const stdout = execFileSync("/bin/sh", ["-c", text(record(prepared.arguments).command, "command")], { encoding: "utf8" });
	runtime.post("bash", prepared.arguments, { resultType: "success", textResultForLlm: stdout }, actor);
	return runtime.operation("report_result", { taskId, summary: "Accepted inline behavior" }, actor);
}

test("factory templates staff three native coordinator levels locally under a one-worker ceiling", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	const source = factorySource(directory, { goal: {
		...definition, scope: { ...definition.scope, mode: "interactive" }, limits: { workers: 1 },
		units: [{ id: "auth", name: "Authentication", parentId: "mail" },
			{ id: "organization", name: "<Product>", kind: "organization" }, { id: "mail", name: "Mail", parentId: "organization" }],
		tasks: [
			{ id: "org-lead", unitId: "organization", role: "coordinator", title: "Organization lead", workType: "analysis", assignment: "Coordinate the organization" },
			{ id: "mail-lead", parentId: "org-lead", unitId: "mail", role: "coordinator", title: "Mail lead", workType: "analysis", assignment: "Coordinate mail" },
			{ id: "auth-lead", parentId: "mail-lead", unitId: "auth", role: "coordinator", title: "Auth lead", workType: "analysis", assignment: "Coordinate authentication" },
			{ ...definition.tasks[0], id: "complete", parentId: "auth-lead", unitId: "auth" },
		],
	} });
	await runtime.operation("start_factory", { source }, "director");
	let batch = record(await runtime.operation("advance", {}, "director"));
	let actor = "director";
	for (const nativeId of ["native-org", "native-mail", "native-auth"]) {
		assert.ok(Array.isArray(batch.prepared));
		assert.equal(batch.prepared.length, 1);
		const call = record(batch.prepared[0]);
		const args = record(call.arguments);
		assert.match(text(record(args.kickoff).prompt, "coordinator prompt"), /continuing coordination/);
		runtime.pre("create_session", args, actor, `create:${nativeId}`);
		runtime.post("create_session", args, { id: nativeId }, actor);
		const attempt = runtime.store().getAttempt(text(call.attemptId, "attempt"));
		assert.equal(attempt.creator, actor);
		actor = nativeId;
		const task = runtime.store().getTask(attempt.taskId);
		await runtime.operation("wait_task", { taskId: task.id, attemptId: attempt.id, kind: "events",
			reason: "Staff the authorized child", handledGeneration: task.coordination?.generation }, actor);
		assert.throws(() => runtime.pre("bash", { command: "echo unadmitted" }, actor, "unadmitted-command"), { code: "capacity_required" });
		assert.throws(() => runtime.pre("apply_patch", {}, actor, "unadmitted-edit"), { code: "capacity_required" });
		batch = record(await runtime.operation("prepare_dispatch", { goalId: task.goalId }, actor));
	}
	assert.ok(Array.isArray(batch.prepared));
	assert.equal(batch.prepared.length, 1);
	const snapshot = runtime.store().snapshot();
	assert.equal(snapshot.attempts.filter(attempt => attempt.slot).length, 1);
	assert.equal(snapshot.units.length, 3);
	const board = renderBoard(snapshot);
	assert.match(board, /&lt;Product&gt;/);
	assert.match(board, /within Mail/);
	assert.match(board, /Original native creator/);
	assert.match(board, /Coordination work: handled/);
});

test("a natural coordinator stop parks one attempt and does not create a stop-hook bookkeeping loop", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await runtime.operation("start_factory", { source: factorySource(directory, { goal: { ...definition,
		scope: { ...definition.scope, mode: "interactive" }, tasks: [
			{ id: "lead", title: "Lead", assignment: "Coordinate", workType: "analysis", role: "coordinator" },
			{ ...definition.tasks[0], id: "complete", parentId: "lead" },
		] } }) }, "director");
	const lead = runtime.store().snapshot().tasks.find(task => task.role === "coordinator");
	assert.ok(lead);
	const attempt = record(await runtime.operation("start_task", { taskId: lead.id }, "director"));
	const final = runtime.store().snapshot().tasks.find(task => task.role === "producer");
	assert.ok(final);
	const batch = record(await runtime.operation("prepare_dispatch", { taskIds: [final.id] }, "director"));
	assert.ok(Array.isArray(batch.prepared));
	const call = record(batch.prepared[0]);
	runtime.pre("create_session", call.arguments, "director", "staff-final");
	runtime.post("create_session", call.arguments, { id: "native-final-worker" }, "director");
	runtime.agentStop("director");
	assert.equal(runtime.store().getTask(lead.id).waiting?.kind, "events");
	assert.equal(runtime.store().getAttempt(text(attempt.id, "attempt")).slot, false);
	const count = runtime.store().snapshot().attempts.length;
	runtime.agentStop("director", true);
	assert.equal(runtime.store().snapshot().attempts.length, count);
	assert.equal(runtime.store().snapshot().factories?.[0].state, "active");
});

test("product acceptance retires a coordinator lease and explicit reopen restores its existing session without repair", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await runtime.operation("start_factory", { source: factorySource(directory, { goal: { ...definition,
		scope: { ...definition.scope, mode: "interactive" }, tasks: [
			{ id: "lead", title: "Lead", assignment: "Coordinate", workType: "analysis", role: "coordinator" },
			{ ...definition.tasks[0], id: "complete", parentId: "lead" },
		] } }) }, "director");
	const lead = runtime.store().snapshot().tasks.find(task => task.role === "coordinator");
	const final = runtime.store().snapshot().tasks.find(task => task.role === "producer");
	assert.ok(lead && final);
	const original = record(await runtime.operation("start_task", { taskId: lead.id }, "director"));
	await runtime.operation("wait_task", { taskId: lead.id, attemptId: original.id, kind: "events", reason: "Await checked acceptance",
		handledGeneration: runtime.store().getTask(lead.id).coordination?.generation }, "director");
	await acceptInline(runtime, final.id);
	assert.equal(runtime.store().getTask(lead.id).state, "done");
	assert.equal(runtime.store().snapshot().completions?.[0].settled, true);
	await runtime.operation("reopen_job", { goalId: final.goalId }, "director");
	const restored = runtime.store().getTask(lead.id);
	const lease = runtime.store().getAttempt(restored.currentAttemptId ?? "");
	assert.notEqual(lease.id, original.id);
	assert.equal(lease.nativeId, "director");
	assert.equal(lease.slot, false);
	assert.equal(restored.waiting?.kind, "events");
	assert.equal(restored.repairs ?? 0, 0);
	assert.equal(runtime.store().getAttempt(text(original.id, "old lease")).state, "done");
});

for (const state of ["prepared", "issued", "uncertain"]) test(`job sealing retires only unissued coordinator creations: ${state}`, async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await runtime.operation("start_factory", { source: factorySource(directory, { goal: { ...definition,
		scope: { ...definition.scope, mode: "interactive" }, tasks: [
			{ id: "lead", title: "Lead", assignment: "Coordinate", workType: "analysis", role: "coordinator" },
			{ ...definition.tasks[0], id: "complete" },
		] } }) }, "director");
	const lead = runtime.store().snapshot().tasks.find(task => task.role === "coordinator");
	const final = runtime.store().snapshot().tasks.find(task => task.role === "producer");
	assert.ok(lead && final);
	const batch = record(await runtime.operation("prepare_dispatch", { taskIds: [lead.id] }, "director"));
	assert.ok(Array.isArray(batch.prepared));
	const call = record(batch.prepared[0]);
	const effectId = text(call.effectId, "creation effect");
	const attemptId = text(call.attemptId, "coordinator attempt");
	if (state !== "prepared") runtime.pre("create_session", call.arguments, "director", "original-create");
	if (state === "uncertain") {
		runtime.store().recordEffect({ ...runtime.store().getEffect(effectId), state: "uncertain",
			result: { pending: true } }, "director");
	}
	const original = runtime.store().getEffect(effectId);
	await acceptInline(runtime, final.id);
	assert.equal(runtime.store().getTask(lead.id).state, "done");
	if (state === "prepared") {
		const retired = runtime.store().getEffect(effectId);
		assert.equal(retired.state, "settled");
		assert.deepEqual(retired.request, original.request);
		assert.equal(record(retired.result).neverIssued, true);
		assert.equal(runtime.store().getAttempt(attemptId).slot, false);
		assert.throws(() => runtime.pre("create_session", call.arguments, "director", "late-create"), { code: "creation_retired" });
		await runtime.operation("reopen_job", { goalId: final.goalId }, "director");
		const fresh = record(await runtime.operation("prepare_dispatch", { taskIds: [lead.id] }, "director"));
		assert.ok(Array.isArray(fresh.prepared));
		assert.notEqual(record(fresh.prepared[0]).attemptId, attemptId);
		assert.throws(() => runtime.pre("create_session", call.arguments, "director", "replayed-create"), { code: "creation_retired" });
	} else {
		assert.deepEqual(runtime.store().getEffect(effectId), original);
		assert.equal(runtime.store().getAttempt(attemptId).slot, true);
		assert.equal(runtime.store().snapshot().completions?.[0].settled, false);
		assert.throws(() => runtime.post("create_session", call.arguments, { pending: true }, "director"), { code: "creation_identity_pending" });
		assert.equal(runtime.store().getAttempt(attemptId).state, "done");
		runtime.post("create_session", call.arguments, { id: "late-native-lead" }, "director");
		const settled = runtime.store().getAttempt(attemptId);
		assert.equal(settled.nativeId, "late-native-lead");
		assert.equal(settled.state, "done");
		assert.equal(settled.slot, false);
		assert.deepEqual(runtime.store().getEffect(effectId).result, { id: "late-native-lead" });
		assert.equal(runtime.store().snapshot().completions?.[0].settled, true);
	}
});

test("job sealing preserves issued coordinator commands, native inputs and claims while retiring prepared commands", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await runtime.operation("start_factory", { source: factorySource(directory, { goal: { ...definition,
		scope: { ...definition.scope, mode: "interactive" }, tasks: [
			{ id: "lead", title: "Lead", assignment: "Coordinate", workType: "analysis", role: "coordinator" },
			{ ...definition.tasks[0], id: "complete" },
		] } }) }, "director");
	const lead = runtime.store().snapshot().tasks.find(task => task.role === "coordinator");
	const final = runtime.store().snapshot().tasks.find(task => task.role === "producer");
	assert.ok(lead && final);
	const batch = record(await runtime.operation("prepare_dispatch", { taskIds: [lead.id] }, "director"));
	assert.ok(Array.isArray(batch.prepared));
	const call = record(batch.prepared[0]);
	runtime.pre("create_session", call.arguments, "director", "create-lead");
	runtime.post("create_session", call.arguments, { id: "native-lead" }, "director");
	const attemptId = text(call.attemptId, "lead attempt");
	const claim = runtime.store().claim({ attemptId, surface: directory, resource: "shared" }, "native-lead");
	const prepared = record(await runtime.operation("prepare_command", { taskId: lead.id, command: "echo unissued" }, "native-lead"));
	runtime.pre("bash", { command: "echo issued", shellId: "lead-shell" }, "native-lead", "lead-command");
	await runtime.operation("wait_task", { taskId: lead.id, kind: "input", requestId: "real-native-input",
		reason: "Await the native user's answer" }, "native-lead");
	await acceptInline(runtime, final.id);
	const lease = runtime.store().getAttempt(attemptId);
	assert.equal(lease.state, "done");
	assert.equal(lease.waiting?.requestId, "real-native-input");
	assert.equal(lease.slot, true);
	assert.deepEqual(runtime.store().snapshot().claims, [claim]);
	assert.equal(record(runtime.store().getEffect(text(prepared.effectId, "prepared command")).result).neverIssued, true);
	assert.equal(runtime.store().getEffect("command:lead-command").state, "issued");
	runtime.toolComplete({ toolCallId: "lead-command", success: true, shellExecution: { exitCode: 0 } }, "native-lead");
	assert.equal(runtime.store().getEffect("command:lead-command").state, "settled");
	assert.equal(runtime.store().getAttempt(attemptId).slot, false);
	assert.deepEqual(runtime.store().snapshot().claims, [claim]);
	assert.equal(runtime.store().snapshot().completions?.[0].settled, false);
});

test("required cross-goal commitments fence both final acceptances until actual producer fulfillment", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	/** @param {string} id */
	const policy = id => factorySource(directory, { id, goal: { ...definition,
		scope: { ...definition.scope, mode: "interactive" }, tasks: [
			{ id: "lead", title: `${id} lead`, assignment: "Coordinate", workType: "analysis", role: "coordinator" },
			{ ...definition.tasks[0], id: "complete", parentId: "lead" },
		] } });
	await runtime.operation("start_factory", { source: policy("source-org") }, "source-owner");
	await runtime.operation("start_factory", { source: policy("destination-org") }, "destination-owner");
	const snapshot = runtime.store().snapshot();
	const source = snapshot.tasks.find(task => task.title === "source-org lead");
	const destination = snapshot.tasks.find(task => task.title === "destination-org lead");
	assert.ok(source && destination);
	const consumer = snapshot.tasks.find(task => task.parentId === source.id);
	const final = snapshot.tasks.find(task => task.parentId === destination.id);
	assert.ok(consumer && final);
	await runtime.operation("start_task", { taskId: source.id }, "source-owner");
	await runtime.operation("start_task", { taskId: destination.id }, "destination-owner");
	const proposed = record(record(await runtime.operation("request_collaboration", { id: "peer-contract", sourceTaskId: source.id,
		destinationTaskId: destination.id, consumerTaskId: consumer.id, expectedVersion: consumer.version,
		title: "Peer interface", output: "interface" }, "source-owner")).request);
	const accepted = record(record(await runtime.operation("respond_collaboration", { collaborationId: proposed.id, expectedRevision: proposed.revision,
		action: "accept", producer: { title: "Produce interface", assignment: "Publish the interface", workType: "analysis" } }, "destination-owner")).request);
	await assert.rejects(runtime.operation("start_task", { taskId: consumer.id }, "source-owner"), { code: "inputs_unavailable" });
	const early = record(await acceptInline(runtime, final.id, "destination-owner"));
	assert.equal(early.promoted, false);
	const producerId = text(accepted.producerTaskId, "committed producer");
	await runtime.operation("start_task", { taskId: producerId }, "destination-owner");
	await runtime.operation("report_result", { taskId: producerId, summary: "Interface published",
		outputs: [{ name: "interface", kind: "analysis", reference: "immutable:peer-interface", version: "peer-v1" }] }, "destination-owner");
	await runtime.operation("respond_collaboration", { collaborationId: proposed.id, expectedRevision: accepted.revision, action: "fulfill" }, "destination-owner");
	assert.match(renderBoard(runtime.store().snapshot()), /Collaboration commitments/);
	assert.match(renderBoard(runtime.store().snapshot()), /peer-v1/);
	await runtime.operation("report_result", { taskId: final.id, summary: "Accepted inline behavior" }, "destination-owner");
	assert.equal(runtime.store().snapshot().completions?.find(completion => completion.goalId === final.goalId)?.delivered, true);
	await acceptInline(runtime, consumer.id, "source-owner");
	assert.equal(runtime.store().snapshot().completions?.find(completion => completion.goalId === consumer.goalId)?.delivered, true);
});

test("old factory and source-contract protocols are rejected rather than silently reinterpreted", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await assert.rejects(runtime.operation("start_factory", { source: factorySource(directory, { version: 1 }) }, "director"), { code: "unsupported_factory" });
	writeFileSync(path.join(directory, ".foundry/contract.json"), JSON.stringify({ ...definition, format: "foundry-contract", version: 1 }));
	await assert.rejects(runtime.operation("start_goal", { source: ".foundry/contract.json" }, "director"), { code: "unsupported_contract" });
	assert.equal(runtime.store().snapshot().goals.length, 0);
});

test("coordinator replacement inspects native absence and rejects caller claims or temporary offline status", async t => {
	let state = "available";
	const { runtime, directory } = fixture(t, { readSession: async id => state === "available" ? { id }
		: { resultType: "failure", error: state === "offline" ? "Session offline" : "Session archived" } });
	execFileSync("git", ["-C", directory, "-c", "user.name=Foundry tests", "-c", "user.email=foundry@example.invalid",
		"commit", "--quiet", "--allow-empty", "-m", "fixture"]);
	await runtime.operation("start_goal", { ...definition, tasks: [
		{ id: "lead", title: "Lead", assignment: "Coordinate", workType: "analysis", role: "coordinator" },
	] }, "director");
	const batch = record(await runtime.operation("prepare_dispatch", { taskIds: ["lead"] }, "director"));
	assert.ok(Array.isArray(batch.prepared));
	const call = record(batch.prepared[0]);
	runtime.pre("create_session", call.arguments, "director", "old-lead-create");
	runtime.post("create_session", call.arguments, { id: "old-lead" }, "director");
	runtime.store().captureUsageAffinity("native-baseline", "old-lead");
	const request = { taskId: "lead", attemptId: call.attemptId, newOwner: "director", unavailable: true };
	await assert.rejects(runtime.operation("handoff_task", request, "director"), { code: "foreign_execution" });
	state = "offline";
	await assert.rejects(runtime.operation("handoff_task", request, "director"), { code: "foreign_execution" });
	state = "archived";
	await runtime.operation("handoff_task", request, "director");
	assert.equal(runtime.store().getTask("lead").owner, "director");
	assert.equal(runtime.store().getTask("lead").repairs ?? 0, 0);
});

test("execution handoff conserves its baseline when the project's branch advances before replacement", async t => {
	const { runtime, directory } = fixture(t, { readSession: async id => ({ id }) });
	const commit = () => execFileSync("git", ["-C", directory, "-c", "user.name=Foundry tests",
		"-c", "user.email=foundry@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
	commit();
	await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0], id: "work" }] }, "director");
	await runtime.operation("start_task", { taskId: "work" }, "director");
	const attemptId = runtime.store().getTask("work").currentAttemptId;
	assert.ok(attemptId);
	const original = runtime.store().getAttempt(attemptId);
	await runtime.operation("handoff_task", { taskId: "work", attemptId, newOwner: "replacement" }, "director");
	commit();
	await assert.rejects(runtime.operation("start_task", { taskId: "work" }, "replacement"), { code: "execution_base_mismatch" });
	assert.equal(runtime.store().getTask("work").state, "ready");
	const batch = record(await runtime.operation("prepare_dispatch", { taskIds: ["work"] }, "replacement"));
	assert.ok(Array.isArray(batch.prepared));
	const call = record(batch.prepared[0]);
	assert.equal(record(call.arguments).base_branch, original.baseCommit);
	runtime.pre("create_session", call.arguments, "replacement", "replacement-create");
	runtime.post("create_session", call.arguments, { id: "replacement-worker" }, "replacement");
	assert.throws(() => runtime.pre("bash", { command: "true" }, "replacement-worker", "wrong-baseline-command"),
		{ code: "execution_base_mismatch" });
});

test("one recorded human input wait does not suppress another coordinator's ready factory work", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await runtime.operation("start_factory", { source: factorySource(directory, { goal: {
		...definition, scope: { ...definition.scope, mode: "interactive" },
		tasks: [{ ...definition.tasks[0], id: "human" }, { ...definition.tasks[0], id: "complete" }],
	} }) }, "director");
	const tasks = runtime.store().snapshot().tasks;
	const human = tasks.find(task => task.id.endsWith(":human"));
	const ready = tasks.find(task => task.id.endsWith(":complete"));
	assert.ok(human && ready);
	await runtime.operation("start_task", { taskId: human.id }, "director");
	await runtime.operation("wait_task", { taskId: human.id, kind: "input", requestId: "real-native-question", reason: "A human decision" }, "director");
	runtime.store().reassignTask(ready.id, "independent-coordinator", "director");
	const advanced = record(await runtime.operation("advance", {}, "independent-coordinator"));
	assert.ok(Array.isArray(advanced.prepared));
	assert.equal(advanced.prepared.length, 1);
	assert.equal(runtime.store().getTask(human.id).waiting?.requestId, "real-native-question");
});

for (const workers of [undefined, 1]) test(`one default job ${workers === undefined ? "dispatches independent workers in parallel" : "retains its explicit worker ceiling"}`, async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	const started = record(await runtime.operation("start_factory", { source: factorySource(directory, {
		mechanism: "native", maximumJobs: undefined, blocks: undefined, goal: {
			...definition, ...(workers === undefined ? {} : { limits: { workers } }),
			tasks: [
				...["one", "two"].map(id => ({ ...definition.tasks[0], id })),
				{ ...definition.tasks[0], id: "complete", inputs: [
					{ taskId: "one", output: "result" }, { taskId: "two", output: "result" },
				] },
			],
		},
	}) }, "director"));
	assert.deepEqual(started.settings, { maximumJobs: { value: 1, origin: "default" },
		perJobLimits: workers === undefined ? {} : { workers: { value: 1, origin: "policy" } } });
	const result = record(await runtime.operation("advance", {}, "director"));
	assert.ok(Array.isArray(result.prepared) && Array.isArray(result.blocked));
	assert.equal(result.prepared.length, workers === undefined ? 2 : 1);
	assert.equal(result.blocked.length, workers === undefined ? 0 : 1);
	if (workers !== undefined) assert.match(text(record(result.blocked[0]).code, "capacity code"), /capacity/);
	for (const request of result.prepared) assert.equal(record(record(record(request).arguments).kickoff).mode, "autopilot");
	assert.equal(runtime.store().snapshot().goals.length, 1);
	assert.equal(runtime.store().snapshot().goals[0].limits.workers, workers);
	assert.equal(runtime.store().snapshot().attempts.filter(attempt => attempt.slot).length, workers === undefined ? 2 : 1);
	assert.equal(runtime.store().snapshot().tasks.find(task => task.id.endsWith(":complete"))?.currentAttemptId, undefined);
});

test("invalid final acceptance and incompatible task modes roll back initial activation and job admission together", async t => {
	for (const final of [
		{ ...definition.tasks[0], id: "complete", checks: [] },
		{ ...definition.tasks[0], id: "complete", scope: { mode: "plan" } },
	]) {
		const { runtime, directory } = fixture(t, authorizedFactory);
		await assert.rejects(runtime.operation("start_factory", { source: factorySource(directory, { goal: {
			...definition, scope: { ...definition.scope, mode: "interactive" }, tasks: [final],
		} }) }, "director"), /acceptance checks|scope.mode/);
		assert.equal(runtime.store().snapshot().factories?.length, 0);
		assert.equal(runtime.store().snapshot().goals.length, 0);
	}
});

test("source contracts preserve genuinely partial task scope instead of widening omitted fields", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await runtime.operation("start_factory", { source: factorySource(directory, { goal: {
		...definition, scope: { ...definition.scope, mode: "interactive" },
		tasks: [{ ...definition.tasks[0], id: "complete", scope: { paths: ["unit"] } }],
	} }) }, "director");
	assert.deepEqual(runtime.store().snapshot().tasks[0].scope.paths, ["unit"]);
	assert.deepEqual(runtime.store().snapshot().tasks[0].scope.restrictions, definition.scope.restrictions);
});

test("a real bound worker is continued locally and a cap/restart resumes its same attempt without a repair debit", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	const source = factorySource(directory, { goal: { ...definition, scope: { ...definition.scope, mode: "interactive" },
		limits: { workers: 1, repairs: 0 }, tasks: [{ ...definition.tasks[0], id: "complete" }] } });
	await runtime.operation("start_factory", { source }, "director");
	const task = runtime.store().snapshot().tasks[0];
	const attempt = runtime.store().prepareAttempt(task.id, "director");
	runtime.store().issueAttempt(attempt.id, "director", `create:${attempt.id}`, {});
	runtime.store().bindAttempt(attempt.id, "worker", "director", { session_id: "worker" });
	assert.equal(runtime.agentStop("worker")?.decision, "block");
	runtime.nativeAbort({ stopReason: "agent_stop_block_limit" }, "worker");
	assert.equal(runtime.store().getTask(task.id).state, "blocked");
	assert.equal(runtime.store().getAttempt(attempt.id).slot, false);
	await runtime.operation("start_factory", { source }, "director");
	const resumed = record(await runtime.operation("resume_task", { taskId: task.id }, "worker"));
	assert.equal(resumed.id, attempt.id);
	assert.equal(runtime.store().getTask(task.id).repairs, undefined);
	assert.equal(runtime.store().getAttempt(attempt.id).slot, true);
});

test("recurring source activation validates its template but admits no synthetic seed job", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await runtime.operation("start_factory", { source: factorySource(directory, { source: issuePolicy }) }, "director");
	assert.equal(runtime.store().snapshot().factories?.[0].state, "active");
	assert.equal(runtime.store().snapshot().goals.length, 0);
	assert.equal(runtime.store().snapshot().tasks.length, 0);
});

test("multi-job intake retains policy overrides and reports them without claiming user or runtime provenance", async t => {
	const { runtime, directory } = fixture(t, { ...authorizedFactory,
		readEvent: async (_repository, number) => ({ ...sourceEvent, number }) });
	const started = record(await runtime.operation("start_factory", { source: factorySource(directory, {
		source: issuePolicy, maximumJobs: 2, blocks: 7,
		goal: { ...definition, scope: { ...definition.scope, mode: "interactive" },
			limits: { workers: 1, repairs: 0 }, tasks: [{ ...definition.tasks[0], id: "complete" }] },
	}) }, "director"));
	const expected = {
		maximumJobs: { value: 2, origin: "policy" }, blocks: { value: 7, origin: "policy" },
		perJobLimits: { workers: { value: 1, origin: "policy" }, repairs: { value: 0, origin: "policy" } },
	};
	assert.deepEqual(started.settings, expected);
	for (const eventId of [1, 2]) await runtime.operation("ingest", { factoryId: "fixture-factory", eventId }, "director");
	await assert.rejects(runtime.operation("ingest", { factoryId: "fixture-factory", eventId: 3 }, "director"), { code: "factory_capacity" });
	const context = record(await runtime.operation("get_context", {}, "director"));
	assert.ok(Array.isArray(context.factories));
	assert.deepEqual(record(context.factories[0]).settings, expected);
	assert.equal(runtime.store().snapshot().goals.length, 2);
	for (const goal of runtime.store().snapshot().goals) assert.deepEqual(goal.limits, { workers: 1, repairs: 0 });
});

test("trusted source content is deduplicated across concurrent ingress and comment-only updates", async t => {
	let event = { ...sourceEvent };
	const { runtime, directory } = fixture(t, { ...authorizedFactory, readEvent: async () => event });
	await runtime.operation("start_factory", { source: factorySource(directory, { source: issuePolicy, maximumJobs: undefined }) }, "director");
	const args = { factoryId: "fixture-factory", eventId: 1 };
	const responses = await Promise.all([runtime.operation("ingest", args, "director"), runtime.operation("ingest", args, "director")]);
	assert.equal(responses.filter(value => record(value).replay === false).length, 1);
	event = { ...event, updated_at: "2026-02-01T00:00:00Z" };
	assert.equal(record(await runtime.operation("ingest", args, "director")).replay, true);
	assert.equal(runtime.store().snapshot().goals.length, 1);
});

test("untrusted authors and last editors cannot consume source admission or an active-job allowance", async t => {
	let event = { ...sourceEvent, user: { login: "untrusted" }, editor: { login: "trusted" }, last_edited_at: "2026-02-01" };
	const { runtime, directory } = fixture(t, { ...authorizedFactory, readEvent: async () => event });
	await runtime.operation("start_factory", { source: factorySource(directory, { source: issuePolicy }) }, "director");
	await assert.rejects(runtime.operation("ingest", { factoryId: "fixture-factory", eventId: 1 }, "director"), /author\/editor policy/);
	event = { ...event, user: { login: "trusted" }, editor: { login: "untrusted" } };
	await assert.rejects(runtime.operation("ingest", { factoryId: "fixture-factory", eventId: 1 }, "director"), /author\/editor policy/);
	assert.equal(runtime.store().snapshot().goals.length, 0);
});

test("distinct source events respect the factory-wide active-job bound; settled cancellation is not delivery", async t => {
	const { runtime, directory } = fixture(t, { ...authorizedFactory, readEvent: async (_repository, number) => ({ ...sourceEvent, number }) });
	await runtime.operation("start_factory", { source: factorySource(directory, { source: issuePolicy, maximumJobs: undefined }) }, "director");
	const first = record(await runtime.operation("ingest", { factoryId: "fixture-factory", eventId: 1 }, "director"));
	await assert.rejects(runtime.operation("ingest", { factoryId: "fixture-factory", eventId: 2 }, "director"), /active-job bound/);
	const goalId = text(record(first.goal).id, "first job");
	await runtime.operation("cancel_job", { goalId }, "director");
	assert.equal(runtime.store().advance("director", goalId)[0].cancelled, true);
	assert.equal(runtime.store().advance("director", goalId)[0].delivered, false);
	await runtime.operation("ingest", { factoryId: "fixture-factory", eventId: 2 }, "director");
	assert.equal(runtime.store().snapshot().goals.length, 2);
});

test("paged intake retains deferred events, then moves only its actual provider cursor after capacity clears", async t => {
	/** @type {Array<{maximum:number,cursor:string|undefined}>} */
	const seen = [];
	const { runtime, directory } = fixture(t, { ...authorizedFactory, readEvents: async (_repository, maximum, cursor) => {
		seen.push({ maximum, cursor });
		return { events: [sourceEvent, { ...sourceEvent, number: 2 }], hasNextPage: true, cursor: "native-next-page" };
	} });
	await runtime.operation("start_factory", { source: factorySource(directory, { source: issuePolicy }) }, "director");
	const args = { factoryId: "fixture-factory" };
	const first = record(await runtime.operation("poll", args, "director"));
	assert.ok(Array.isArray(first.jobs) && Array.isArray(first.blocked));
	assert.equal(first.jobs.length, 1);
	assert.equal(record(first.blocked[0]).code, "factory_capacity");
	assert.equal(runtime.store().factory("fixture-factory", "director").sourceCursor, undefined);
	await runtime.operation("cancel_job", { goalId: runtime.store().snapshot().goals[0].id }, "director");
	await runtime.operation("poll", args, "director");
	assert.equal(runtime.store().factory("fixture-factory", "director").sourceCursor, "native-next-page");
	await runtime.operation("poll", args, "director");
	assert.equal(seen[2].cursor, "native-next-page");
	assert.equal(runtime.store().snapshot().goals.length, 2);
});

test("an in-flight native source observation cannot admit work after pause and a newer explicit restart", async t => {
	/** @type {((value:unknown)=>void)|undefined} */
	let finish;
	const { runtime, directory } = fixture(t, { ...authorizedFactory, readEvent: () => new Promise(resolve => { finish = resolve; }) });
	const source = factorySource(directory, { source: issuePolicy });
	await runtime.operation("start_factory", { source }, "director");
	const pending = runtime.operation("ingest", { factoryId: "fixture-factory", eventId: 1 }, "director");
	runtime.nativeAbort({ reason: "user_initiated" }, "director");
	await runtime.operation("start_factory", { source }, "director");
	assert.ok(finish);
	finish(sourceEvent);
	await assert.rejects(pending, /revoked activation/);
	assert.equal(runtime.store().snapshot().goals.length, 0);
});

test("accepted completion remains delivered-but-unsettled while an unused native execution still holds its slot", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await runtime.operation("start_factory", { source: factorySource(directory, { goal: {
		...definition, scope: { ...definition.scope, mode: "interactive" },
		tasks: ["alternative", "complete"].map(id => ({ ...definition.tasks[0], id })),
	} }) }, "director");
	const [alternative, complete] = runtime.store().snapshot().tasks;
	await runtime.operation("start_task", { taskId: alternative.id }, "director");
	await acceptInline(runtime, complete.id);
	const status = runtime.store().advance("director", complete.goalId)[0];
	assert.equal(status.delivered, true);
	assert.equal(status.settled, false);
});

test("native source receipt parsing rejects foreign identity and provider failure rather than inventing empty intake", async () => {
	const provider = createIssueSource(async () => ({
		resultType: "success", textResultForLlm: `FOUNDRY_SOURCE_EVENT:${Buffer.from(JSON.stringify({ issue: {
			number: 1, url: "https://github.com/wrong/project/issues/1", state: "OPEN", lastEditedAt: null,
		} })).toString("base64")}`,
	}));
	await assert.rejects(provider.readEvent("example/project", 1), /different repository issue/);
	const failed = createIssueSource(async () => ({ resultType: "failure", textResultForLlm: "Provider unavailable" }));
	await assert.rejects(failed.readEvents("example/project", 2), /inspection failed/);
});

test("declared charter knowledge remains an immutable assignment snapshot after its repository file changes", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	mkdirSync(path.join(directory, ".foundry"), { recursive: true });
	const content = "Originally curated and evidenced decision";
	writeFileSync(path.join(directory, ".foundry/knowledge.txt"), content);
	const source = factorySource(directory, { charters: [{
		name: "Shared context", taskIds: ["complete"], context: ["Shared charter context"], knowledgeFiles: [],
	}, {
		name: "Reviewer", taskIds: ["complete"], agent: "declared-specialist", context: [],
		knowledgeFiles: [{ path: ".foundry/knowledge.txt", sha256: createHash("sha256").update(content).digest("hex") }],
	}] });
	await runtime.operation("start_factory", { source }, "director");
	writeFileSync(path.join(directory, ".foundry/knowledge.txt"), "A later unrelated decision");
	const dispatch = record(await runtime.operation("prepare_dispatch", {}, "director"));
	assert.ok(Array.isArray(dispatch.prepared));
	const kickoff = record(record(record(dispatch.prepared[0]).arguments).kickoff);
	assert.equal(kickoff.agent, "declared-specialist");
	assert.match(text(kickoff.prompt, "assignment"), /Originally curated and evidenced/);
	assert.doesNotMatch(text(kickoff.prompt, "assignment"), /later unrelated/);
});

test("empty captured knowledge stays valid during activation, dispatch and reopening the current store", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	mkdirSync(path.join(directory, ".foundry"), { recursive: true });
	writeFileSync(path.join(directory, ".foundry/empty.txt"), "");
	const source = factorySource(directory, { charters: [{
		name: "Empty curated context", taskIds: ["complete"], context: [], knowledgeFiles: [{
			path: ".foundry/empty.txt", sha256: createHash("sha256").update("").digest("hex"),
		}],
	}] });
	await runtime.operation("start_factory", { source }, "director");
	const batch = record(await runtime.operation("prepare_dispatch", {}, "director"));
	assert.ok(Array.isArray(batch.prepared));
	const kickoff = record(record(record(batch.prepared[0]).arguments).kickoff);
	assert.match(text(kickoff.prompt, "assignment"), /Declared context \.foundry\/empty\.txt/);
	runtime.close();
	const reopened = createRuntime({ directory, log: message => { throw new Error(message); }, ...authorizedFactory });
	t.after(() => reopened.close());
	assert.equal(reopened.store().snapshot().tasks.length, 1);
});

test("factory work missing its admitted snapshot is rejected without reconstructing or rewriting native work", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await runtime.operation("start_factory", { source: factorySource(directory, { charters: [{
		name: "Reviewer", taskIds: ["complete"], agent: "declared-specialist", context: ["Captured charter"], knowledgeFiles: [],
	}] }) }, "director");
	const task = runtime.store().snapshot().tasks[0];
	const batch = record(await runtime.operation("prepare_dispatch", {}, "director"));
	assert.ok(Array.isArray(batch.prepared));
	const original = runtime.store().getTask(task.id);
	const effects = runtime.store().effectsForAttempt(text(original.currentAttemptId, "attempt"));
	const databasePath = runtime.store().databasePath;
	runtime.close();
	const db = new DatabaseSync(databasePath);
	const { dispatch: _snapshot, ...legacy } = original;
	db.prepare("UPDATE tasks SET document=? WHERE id=?").run(JSON.stringify(legacy), task.id);
	db.close();
	const resumed = createRuntime({ directory, log: message => { throw new Error(message); }, ...authorizedFactory });
	t.after(() => resumed.close());
	assert.deepEqual(resumed.store().getTask(task.id), legacy);
	assert.deepEqual(resumed.store().effectsForAttempt(text(original.currentAttemptId, "attempt")), effects);
	const rejected = record(await resumed.operation("prepare_dispatch", {}, "director"));
	assert.deepEqual(rejected.prepared, []);
	assert.ok(Array.isArray(rejected.blocked));
	assert.equal(record(rejected.blocked[0]).code, "assignment_snapshot_required");
	assert.deepEqual(resumed.store().effectsForAttempt(text(original.currentAttemptId, "attempt")), effects);
});

test("delayed native observations use canonical admission order rather than command completion time", async t => {
	const { runtime, directory } = fixture(t);
	const allowed = path.join(directory, "allowed");
	writeFileSync(allowed, "");
	await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0],
		checks: [{ ...definition.tasks[0].checks[0], command: `test -f ${JSON.stringify(allowed)}` }] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const passing = record(await runtime.operation("prepare_check", { taskId: task.id, checkId: "behavior" }, "director"));
	runtime.pre("bash", passing.arguments, "director", "passing-check");
	const pass = execFileSync("/bin/sh", ["-c", text(record(passing.arguments).command, "command")], { encoding: "utf8" });
	rmSync(allowed);
	const failing = record(await runtime.operation("prepare_check", { taskId: task.id, checkId: "behavior" }, "director"));
	runtime.pre("bash", failing.arguments, "director", "failing-check");
	const fail = execFileSync("/bin/sh", ["-c", text(record(failing.arguments).command, "command")], { encoding: "utf8" });
	runtime.post("bash", failing.arguments, { resultType: "success", textResultForLlm: fail }, "director");
	runtime.post("bash", passing.arguments, { resultType: "success", textResultForLlm: pass }, "director");
	const attemptId = text(runtime.store().getTask(task.id).currentAttemptId, "attempt");
	const canonical = runtime.store().evidenceForAttempt(attemptId);
	assert.deepEqual(canonical.map(item => item.outcome), ["failed", "passed"]);
	assert.deepEqual(admittedEvidence(runtime.store(), attemptId), canonical);
	assert.equal(record(await runtime.operation("report_result", { taskId: task.id, state: "done",
		summary: "Latest admitted evaluation passed" }, "director")).promoted, true);
});

test("grain generation pins an implementation-free commit and excludes implicit history while deduplicating conserved oracles", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	mkdirSync(path.join(directory, ".foundry"), { recursive: true });
	const files = [
		{ path: ".foundry/spec.txt", content: "Declared behavioral specification" },
		{ path: ".foundry/evaluator.mjs", content: "process.exit(0);\n" },
		{ path: ".foundry/boundary.txt", content: "Conserved public boundary" },
	];
	const references = files.map(file => {
		writeFileSync(path.join(directory, file.path), file.content);
		return { path: file.path, sha256: createHash("sha256").update(file.content).digest("hex") };
	});
	execFileSync("git", ["-C", directory, "add", ...files.map(file => file.path)]);
	execFileSync("git", ["-C", directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Conserved grain contract"]);
	const base = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const source = factorySource(directory, {
		goal: { ...definition, scope: { ...definition.scope, mode: "interactive" },
			tasks: [{ ...definition.tasks[0], id: "complete", checks: [{ ...definition.tasks[0].checks[0], oracleFiles: [references[0]] }] }] },
		grains: [{ id: "unit", taskIds: ["complete"], generators: ["complete"], baseBranch: "HEAD",
			specification: references[0], evaluators: [references[1]], boundary: [references[2]], context: [] }],
	});
	await runtime.operation("start_factory", { source }, "director");
	const task = runtime.store().snapshot().tasks[0];
	runtime.store().recordLesson({ goalId: task.goalId, workType: task.workType, summary: "PRIOR_IMPLEMENTATION_DETAILS", references: ["fixture:history"] }, "director");
	const prepared = record(await runtime.operation("prepare_dispatch", { taskIds: [task.id] }, "director"));
	assert.ok(Array.isArray(prepared.prepared));
	const args = record(record(prepared.prepared[0]).arguments);
	assert.equal(args.base_branch, base);
	assert.equal(task.checks[0].oracleFiles?.length, 3);
	assert.match(text(record(args.kickoff).prompt, "generator assignment"), /Declared behavioral specification/);
	assert.doesNotMatch(text(record(args.kickoff).prompt, "generator assignment"), /PRIOR_IMPLEMENTATION_DETAILS/);
});

test("completion sealing prevents new execution of an unused alternative until explicit reopening", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await runtime.operation("start_factory", { source: factorySource(directory, { goal: {
		...definition, scope: { ...definition.scope, mode: "interactive" },
		tasks: ["alternative", "complete"].map(id => ({ ...definition.tasks[0], id })),
	} }) }, "director");
	const [alternative, complete] = runtime.store().snapshot().tasks;
	await acceptInline(runtime, complete.id);
	await assert.rejects(runtime.operation("start_task", { taskId: alternative.id }, "director"), { code: "job_closed" });
	assert.equal(runtime.store().advance("director", complete.goalId)[0].settled, true);
});

test("paused recorded ordinary commands are denied by native hooks without denying unrelated shell work", async t => {
	const { runtime, directory } = fixture(t, { ...authorizedFactory, log: () => {} });
	const hooks = buildHooks(runtime);
	const actor = { sessionId: "director" };
	const native = { sessionId: "director", timestamp: new Date() };
	await hooks.onPreToolUse({ ...native, toolName: "foundry_start_factory", toolArgs: {}, toolCallId: "activate",
		workingDirectory: directory }, actor);
	await runtime.operation("start_factory", { source: factorySource(directory) }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const prepared = record(await runtime.operation("prepare_command", { taskId: task.id, command: "echo recorded" }, "director"));
	runtime.nativeAbort({ reason: "user_initiated" }, "director");
	const rejected = await hooks.onPreToolUse({ ...native, toolName: "bash", toolArgs: record(prepared.arguments),
		toolCallId: "retired-command", workingDirectory: directory }, actor);
	assert.equal(rejected?.permissionDecision, "deny");
	const unrelated = await hooks.onPreToolUse({ ...native, toolName: "bash", toolArgs: { command: "echo unrelated" },
		toolCallId: "unrelated-command", workingDirectory: directory }, actor);
	assert.equal(unrelated?.permissionDecision, undefined);
});

test("explicit aggregate repair allowance is shared by independent descendants without erasing checked failures", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await runtime.operation("start_factory", { source: factorySource(directory, { aggregateRepairs: 1, goal: {
		...definition, scope: { ...definition.scope, mode: "interactive" }, limits: { repairs: 3 },
		tasks: ["one", "complete"].map(id => ({ ...definition.tasks[0], id,
			checks: [{ ...definition.tasks[0].checks[0], command: "node -e 'process.exit(1)'" }] })),
	} }) }, "director");
	const [one, complete] = runtime.store().snapshot().tasks;
	for (const task of [one, complete]) await runtime.operation("start_task", { taskId: task.id }, "director");
	for (const [index, task] of [one, complete].entries()) {
		const prepared = record(await runtime.operation("prepare_check", { taskId: task.id, checkId: "behavior" }, "director"));
		runtime.pre("bash", prepared.arguments, "director", `failure:${index}`);
		const execution = spawnSync("/bin/sh", ["-c", text(record(prepared.arguments).command, "command")], { encoding: "utf8" });
		runtime.post("bash", prepared.arguments, { resultType: "success", textResultForLlm: execution.stdout }, "director");
		const result = record(await runtime.operation("report_result", { taskId: task.id, summary: "Recorded genuine failure", repair: true }, "director"));
		assert.equal(record(result.continuation).state, index === 0 ? "running" : "blocked");
		if (index === 1) assert.equal(record(result.continuation).code, "repair_limit");
	}
	assert.equal(runtime.store().snapshot().completions?.[0].delivered, false);
	assert.equal(runtime.store().getTask(complete.id).state, "failed");
	assert.equal(runtime.store().getTask(complete.id).repairs, undefined);
});

/** @param {import("./model.d.ts").Json} [initial] */
function nativeSchedule(initial) {
	/** @type {import("./model.d.ts").Json|undefined} */
	let automation = initial;
	/** @type {Array<{name:string,args:import("./model.d.ts").Json}>} */
	const calls = [];
	return {
		calls,
		/** @param {string} name @param {import("./model.d.ts").Json} args */
		async execute(name, args) {
			calls.push({ name, args });
			if (name === "save_session_automation") {
				const request = record(args);
				if (request.clear === true) automation = undefined;
				else automation = { id: "observed-native-automation", execution: "session", sessionId: "director",
					prompt: text(request.prompt, "native prompt"), interval: "minutes", everyMinutes: Number(request.every_minutes) };
			}
			if (!["get_session_automation", "save_session_automation"].includes(name)) throw new Error(`Unexpected native tool ${name}`);
			return { resultType: "success", textResultForLlm: JSON.stringify({
				sessionId: "director", ...(automation === undefined ? {} : { automation }),
			}) };
		},
		/** @param {import("./model.d.ts").Json|undefined} value */
		replace(value) { automation = value; },
	};
}

test("heartbeat uses observed same-session casing, binds native identity, and clears only its owned automation", async t => {
	const scheduler = nativeSchedule();
	const { runtime, directory } = fixture(t, { ...authorizedFactory, ...scheduler });
	await runtime.operation("start_factory", { source: factorySource(directory) }, "director");
	const args = { factoryId: "fixture-factory", everyMinutes: 1 };
	await runtime.operation("set_heartbeat", args, "director");
	const factory = runtime.store().factory("fixture-factory", "director");
	assert.equal(factory.heartbeat?.state, "bound");
	assert.equal(factory.heartbeat?.id, "observed-native-automation");
	assert.match(factory.heartbeat?.request.prompt ?? "", /never activate or restart/);
	await runtime.operation("set_heartbeat", args, "director");
	assert.equal(scheduler.calls.filter(call => call.name === "save_session_automation").length, 1);
	await runtime.operation("pause_factory", { factoryId: "fixture-factory" }, "director");
	assert.equal(runtime.store().factory("fixture-factory", "director").state, "paused");
	assert.equal(runtime.store().factory("fixture-factory", "director").heartbeat, undefined);
	assert.deepEqual(record(scheduler.calls.filter(call => call.name === "save_session_automation")[1].args), { clear: true });
});

test("unrelated or externally changed native automations are never deliberately replaced or removed", async t => {
	const scheduler = nativeSchedule({ id: "unrelated", prompt: "User-owned work" });
	const { runtime, directory } = fixture(t, { ...authorizedFactory, ...scheduler });
	await runtime.operation("start_factory", { source: factorySource(directory) }, "director");
	const args = { factoryId: "fixture-factory", everyMinutes: 1 };
	await assert.rejects(runtime.operation("set_heartbeat", args, "director"), { code: "heartbeat_conflict" });
	assert.equal(scheduler.calls.filter(call => call.name === "save_session_automation").length, 0);
	scheduler.replace(undefined);
	await runtime.operation("set_heartbeat", args, "director");
	scheduler.replace({ id: "observed-native-automation", prompt: "Changed by the user" });
	await assert.rejects(runtime.operation("pause_factory", { factoryId: "fixture-factory" }, "director"), { code: "heartbeat_conflict" });
	assert.equal(runtime.store().factory("fixture-factory", "director").state, "paused");
	assert.equal(scheduler.calls.filter(call => call.name === "save_session_automation").length, 1);
});

test("lost native schedule acknowledgment is reconciled from actual ownership instead of issuing another save", async t => {
	const scheduler = nativeSchedule();
	const { runtime, directory } = fixture(t, { ...authorizedFactory, execute: async (name, args) => {
		const result = await scheduler.execute(name, args);
		if (name === "save_session_automation") throw new Error("Lost native return");
		return result;
	} });
	await runtime.operation("start_factory", { source: factorySource(directory) }, "director");
	const args = { factoryId: "fixture-factory", everyMinutes: 1 };
	await assert.rejects(runtime.operation("set_heartbeat", args, "director"), /Lost native return/);
	assert.equal(runtime.store().factory("fixture-factory", "director").heartbeat?.state, "uncertain");
	await runtime.operation("set_heartbeat", args, "director");
	assert.equal(runtime.store().factory("fixture-factory", "director").heartbeat?.state, "bound");
	assert.equal(scheduler.calls.filter(call => call.name === "save_session_automation").length, 1);
});

test("directory changes during native schedule save preserve uncertainty and expose its actual receipt", async t => {
	const alternate = fixture(t).directory;
	const scheduler = nativeSchedule();
	const { runtime, directory } = fixture(t, { ...authorizedFactory, execute: async (name, args) => {
		const result = await scheduler.execute(name, args);
		if (name === "save_session_automation") runtime.setDirectory(alternate);
		return result;
	} });
	await runtime.operation("start_factory", { source: factorySource(directory) }, "director");
	await assert.rejects(runtime.operation("set_heartbeat", { factoryId: "fixture-factory", everyMinutes: 1 }, "director"),
		{ code: "factory_context_changed", message: /observed-native-automation/ });
	runtime.setDirectory(directory);
	assert.equal(runtime.store().factory("fixture-factory", "director").heartbeat?.state, "uncertain");
	await runtime.operation("set_heartbeat", { factoryId: "fixture-factory", everyMinutes: 1 }, "director");
	assert.equal(runtime.store().factory("fixture-factory", "director").heartbeat?.state, "bound");
	assert.equal(scheduler.calls.filter(call => call.name === "save_session_automation").length, 1);
});

test("pause during native heartbeat save fences admission and retains the returned identity for cleanup", async t => {
	const scheduler = nativeSchedule();
	/** @type {((value:unknown)=>void)|undefined} */
	let finish;
	const { runtime, directory } = fixture(t, { ...authorizedFactory, execute: async (name, args) => {
		const result = await scheduler.execute(name, args);
		return name === "save_session_automation" ? new Promise(resolve => { finish = () => resolve(result); }) : result;
	} });
	await runtime.operation("start_factory", { source: factorySource(directory) }, "director");
	const pending = runtime.operation("set_heartbeat", { factoryId: "fixture-factory", everyMinutes: 1 }, "director");
	// Let the ordinary native save enter its pending return without polling.
	await new Promise(resolve => setImmediate(resolve));
	assert.ok(finish);
	runtime.nativeAbort({ reason: "user_initiated" }, "director");
	finish(undefined);
	await assert.rejects(pending, { code: "stale_activation" });
	const factory = runtime.store().factory("fixture-factory", "director");
	assert.equal(factory.state, "paused");
	assert.equal(factory.heartbeat?.state, "uncertain");
	assert.equal(factory.heartbeat?.id, "observed-native-automation");
});

test("an explicit restart during heartbeat inspection prevents a stale pause from clearing its native binding", async t => {
	const scheduler = nativeSchedule();
	let restartNextRead = false;
	/** @type {()=>Promise<void>} */
	let restart = async () => {};
	const { runtime, directory } = fixture(t, { ...authorizedFactory, execute: async (name, args) => {
		if (name === "get_session_automation" && restartNextRead) {
			restartNextRead = false;
			await restart();
		}
		return scheduler.execute(name, args);
	} });
	const source = factorySource(directory);
	restart = async () => { await runtime.operation("start_factory", { source }, "director"); };
	await restart();
	await runtime.operation("set_heartbeat", { factoryId: "fixture-factory", everyMinutes: 1 }, "director");
	restartNextRead = true;
	await assert.rejects(runtime.operation("pause_factory", { factoryId: "fixture-factory" }, "director"), { code: "stale_activation" });
	assert.equal(runtime.store().factory("fixture-factory", "director").state, "active");
	assert.equal(scheduler.calls.filter(call => call.name === "save_session_automation").length, 1);
});

test("continuation cap retains an unsettled command, then releases only its actual settled execution capacity", async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await runtime.operation("start_factory", { source: factorySource(directory) }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	runtime.pre("bash", { command: "sleep 1", shellId: "cap-process" }, "director", "cap-native-call");
	runtime.nativeAbort({ stopReason: "agent_stop_block_limit" }, "director");
	const id = text(runtime.store().getTask(task.id).currentAttemptId, "attempt");
	assert.equal(runtime.store().getAttempt(id).slot, true);
	assert.equal(runtime.store().getTask(task.id).state, "running");
	runtime.toolComplete({ toolCallId: "cap-native-call", success: true, shellExecution: { exitCode: 0 } }, "director");
	assert.equal(runtime.store().getAttempt(id).slot, false);
	assert.equal(runtime.store().getTask(task.id).state, "blocked");
	assert.equal(runtime.store().getTask(task.id).waiting?.reason, "factory_paused");
	assert.equal(runtime.store().getTask(task.id).waiting?.kind, "factory");
	assert.equal(runtime.store().getTask(task.id).waiting?.cause, "paused");
	assert.equal(runtime.store().evidenceForAttempt(id).length, 0);
});

/** @param {number} sequence @param {number|undefined} credits @param {string} [id] */
function usageEvent(sequence, credits, id = `native-event-${sequence}`) {
	return { type: "assistant.usage", id, timestamp: new Date().toISOString(), data: {
		accounting: { sourceSessionId: "director", sequence, usageId: `call-${sequence}` },
		...(credits === undefined ? {} : { copilotUsage: { totalNanoAiu: credits * 1_000_000_000 }, aiCreditsStatus: "complete" }),
	} };
}

function usageTurn() {
	return { type: "assistant.turn_start", id: `turn-${randomUUID()}`, timestamp: new Date().toISOString() };
}

test("native accounting keeps missing billing unknown, refines explicit zero and survives reload without double-debit", async t => {
	const { runtime, directory } = fixture(t);
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	runtime.usageTurn(usageTurn(), "director");
	runtime.usage(usageEvent(1, undefined), "director");
	const unknown = runtime.context({ taskId: task.id }, "director").accounting;
	assert.equal(unknown.byGoal[0].reportedCredits, null);
	assert.equal(unknown.byGoal[0].billing, "unavailable");
	assert.equal(unknown.missingBilling, 1);
	runtime.usage(usageEvent(1, 0, "completed-zero"), "director");
	assert.equal(runtime.context({ taskId: task.id }, "director").accounting.byGoal[0].reportedCredits, 0);
	const charged = runtime.usage(usageEvent(2, 2), "director");
	assert.equal(charged?.attemptId, runtime.store().getTask(task.id).currentAttemptId);
	assert.equal(runtime.store().getGoal(task.goalId).credits, 2);
	runtime.close();
	const restarted = createRuntime({ directory, log: message => { throw new Error(message); } });
	t.after(() => restarted.close());
	restarted.attachUsage("director");
	restarted.usage(usageEvent(2, 2, "redelivered-receipt"), "director");
	const accounting = restarted.context({ taskId: task.id }, "director").accounting;
	assert.equal(accounting.capturedReceipts, 2);
	assert.equal(accounting.byGoal[0].reportedCredits, 2);
	assert.equal(accounting.missingBilling, 0);
	assert.equal(accounting.captureComplete, false);
	assert.equal(accounting.complete, false);
	assert.throws(() => restarted.usage(usageEvent(2, 3), "director"), /cannot change/);
	assert.equal(restarted.store().getGoal(task.goalId).credits, 2);
});

test("shared native calls debit a known goal once and leave cross-goal attribution explicitly unallocated", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", { ...definition, tasks: ["one", "two"].map(title => ({
		...definition.tasks[0], title,
	})) }, "director");
	const tasks = runtime.store().snapshot().tasks;
	for (const task of tasks) await runtime.operation("start_task", { taskId: task.id }, "director");
	runtime.usageTurn(usageTurn(), "director");
	const shared = runtime.usage(usageEvent(1, 4), "director");
	assert.equal(shared?.goalId, tasks[0].goalId);
	assert.equal(shared?.attemptId, undefined);
	assert.equal(runtime.store().getGoal(tasks[0].goalId).credits, 4);
	await runtime.operation("start_goal", definition, "director");
	const other = runtime.store().snapshot().tasks.at(-1);
	assert.ok(other);
	await runtime.operation("start_task", { taskId: other.id }, "director");
	runtime.usageTurn(usageTurn(), "director");
	assert.equal(runtime.usage(usageEvent(2, 7), "director")?.goalId, undefined);
	const accounting = runtime.store().accounting("director", [tasks[0].goalId, other.goalId]);
	assert.equal(accounting.unallocatedReceipts, 1);
	assert.equal(accounting.unallocatedCredits, 7);
	assert.equal(runtime.store().getGoal(tasks[0].goalId).credits, 4);
	assert.equal(runtime.store().getGoal(other.goalId).credits, 0);
	assert.equal(accounting.byGoal[1].reportedCredits, null);
});

test("idle turns have one durable boundary while late charges and receipt refinements retain their actual work", async t => {
	const { runtime, directory } = fixture(t);
	await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0], checks: [] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	const attempt = record(await runtime.operation("start_task", { taskId: task.id }, "director"));
	const time = Date.now();
	const at = (/** @type {number} */ offset) => new Date(time + offset).toISOString();
	runtime.usageTurn({ ...usageTurn(), timestamp: at(0) }, "director");
	runtime.usage({ ...usageEvent(1, undefined), timestamp: at(1) }, "director");
	await runtime.operation("report_result", { taskId: task.id, summary: "Finished" }, "director");
	runtime.usageTurn({ ...usageTurn(), timestamp: at(10) }, "director");
	for (let index = 0; index < 50; index++) {
		runtime.usageTurn({ ...usageTurn(), timestamp: at(20 + index) }, "director");
		assert.equal(runtime.usage({ ...usageEvent(100 + index, 9), timestamp: at(20 + index) }, "director"), undefined);
	}
	assert.equal(runtime.usage({ ...usageEvent(1, 2, "refined-after-idle"), timestamp: at(80) }, "director")?.attemptId, attempt.id);
	runtime.close();
	const resumed = createRuntime({ directory, log: message => { throw new Error(message); } });
	t.after(() => resumed.close());
	resumed.attachUsage("director");
	const late = resumed.usage({ ...usageEvent(2, 3, "late-active-request"), timestamp: at(2) }, "director");
	assert.equal(late?.attemptId, attempt.id);
	resumed.usageTurn({ ...usageTurn(), timestamp: at(90) }, "director");
	assert.equal(resumed.usage({ ...usageEvent(999, 20), timestamp: at(91) }, "director"), undefined);
	const db = new DatabaseSync(resumed.store().databasePath, { readOnly: true });
	assert.equal(db.prepare("SELECT count(*) AS n FROM usage_affinity").get()?.n, 2);
	assert.equal(db.prepare("SELECT count(*) AS n FROM native_usage").get()?.n, 2);
	db.close();
	assert.equal(resumed.store().getGoal(task.goalId).credits, 5);
});

test("an attached session with no executing assignment records one idle boundary rather than every unrelated turn", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", definition, "director");
	for (let index = 0; index < 25; index++) {
		runtime.usageTurn(usageTurn(), "director");
		assert.equal(runtime.usage(usageEvent(index, 1), "director"), undefined);
	}
	const db = new DatabaseSync(runtime.store().databasePath, { readOnly: true });
	assert.equal(db.prepare("SELECT count(*) AS n FROM usage_affinity").get()?.n, 1);
	assert.equal(db.prepare("SELECT count(*) AS n FROM native_usage").get()?.n, 0);
	db.close();
});

test("a completed assignment token is removed at the idle boundary without losing pre-binding charges", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0], checks: [] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	const prepared = runtime.store().prepareAttempt(task.id, "director");
	runtime.beginUsage("worker", prepared.token);
	assert.equal(runtime.usage(usageEvent(1, 2), "worker")?.goalId, undefined);
	runtime.store().issueAttempt(prepared.id, "director", `create:${prepared.id}`, {});
	runtime.store().bindAttempt(prepared.id, "worker", "director", { id: "worker" });
	assert.equal(runtime.store().getGoal(task.goalId).credits, 2);
	await runtime.operation("report_result", { taskId: task.id, summary: "Finished" }, "worker");
	const boundary = runtime.usageTurn(usageTurn(), "worker");
	assert.equal(boundary?.token, undefined);
	assert.deepEqual(boundary?.attemptIds, []);
	assert.equal(runtime.usage(usageEvent(2, 7), "worker"), undefined);
	assert.equal(runtime.store().getGoal(task.goalId).credits, 2);
});

test("focused accounting excludes another goal's lifetime charges but retains correlated cross-goal ambiguity", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", definition, "director");
	const first = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: first.id }, "director");
	runtime.usageTurn(usageTurn(), "director");
	runtime.usage(usageEvent(1, 2), "director");
	await runtime.operation("start_goal", definition, "director");
	const second = runtime.store().snapshot().tasks.at(-1);
	assert.ok(second);
	await runtime.operation("start_task", { taskId: second.id }, "director");
	runtime.usageTurn(usageTurn(), "director");
	runtime.usage(usageEvent(2, 3), "director");
	runtime.store().recordNativeUsage({ id: "second-only-charge", nativeId: "director", sourceSessionId: "director",
		aliases: [], attemptIds: [text(runtime.store().getTask(second.id).currentAttemptId, "second attempt")],
		credits: 100, billing: "complete" }, "director");
	const focused = runtime.context({ taskId: first.id }, "director").accounting;
	assert.equal(focused.capturedReceipts, 2);
	assert.equal(focused.byGoal[0].reportedCredits, 2);
	assert.equal(focused.unallocatedReceipts, 1);
	assert.equal(focused.unallocatedCredits, 3);
	assert.equal(focused.complete, false);
});

test("new goal definitions reject removed priority configuration and omit it from returned scope", async t => {
	const { runtime } = fixture(t);
	await assert.rejects(runtime.operation("start_goal", { ...definition, priority: 10 }, "director"), /priority/);
	const created = record(await runtime.operation("start_goal", definition, "director"));
	assert.equal("priority" in record(created.goal), false);
	assert.equal("priority" in runtime.context({}, "director").goals[0], false);
});

test("a native checked failure records and fairly starts one same-worker repair without a model bookkeeping chain", async t => {
	let calls = 0;
	const { runtime, directory } = fixture(t, { execute: async (name, args) => {
		assert.equal(name, "bash");
		runtime.pre(name, args, "director", `native-check-${++calls}`);
		const command = spawnSync("/bin/sh", ["-c", text(record(args).command, "command")], { encoding: "utf8" });
		const result = calls === 2 ? command.stdout : { resultType: "success", textResultForLlm: command.stdout };
		runtime.post(name, args, result, "director");
		return result;
	} });
	await runtime.operation("start_goal", { ...definition, limits: { workers: 1, repairs: 1 }, tasks: [{
		...definition.tasks[0], checks: [{ ...definition.tasks[0].checks[0],
			command: "node -e 'process.exit(require(\"node:fs\").existsSync(\"fixed\") ? 0 : 1)'",
		}],
	}] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	const initial = runtime.store().startLocalTask(task.id, "director");
	runtime.usageTurn(usageTurn(), "director");
	const oldCharge = usageEvent(1, 2);
	const failed = record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior", repair: true }, "director"));
	const failedResult = record(failed.result);
	const fresh = runtime.store().getAttempt(text(record(record(failed.continuation).attempt).id, "fresh attempt"));
	assert.equal(failedResult.state, "failed");
	assert.equal(failedResult.attemptId, initial.id);
	assert.equal(fresh.nativeId, initial.nativeId);
	assert.notEqual(fresh.token, initial.token);
	assert.equal(fresh.repairOf, initial.id);
	assert.equal(fresh.state, "running");
	assert.equal(runtime.store().getAttempt(initial.id).slot, false);
	assert.equal(runtime.store().snapshot().attempts.filter(attempt => attempt.slot).length, 1);
	const replay = record(await runtime.operation("report_result", { taskId: task.id, attemptId: initial.id,
		resultId: failedResult.id, summary: failedResult.summary, repair: true }, "director"));
	assert.equal(record(record(replay.continuation).attempt).id, fresh.id);
	assert.equal(runtime.store().snapshot().attempts.length, 2);
	assert.equal(calls, 1);
	runtime.usageTurn(usageTurn(), "director");
	assert.equal(runtime.usage(oldCharge, "director")?.attemptId, initial.id);
	assert.equal(runtime.usage(usageEvent(1, 2, "same-native-charge"), "director")?.attemptId, initial.id);
	assert.equal(runtime.store().recordUsage(initial.id, 2, "same-native-charge", "director").credits, 2);
	runtime.usageTurn(usageTurn(), "director");
	assert.equal(runtime.usage(usageEvent(2, 3), "director")?.attemptId, fresh.id);
	assert.equal(runtime.store().getGoal(task.goalId).credits, 5);
	writeFileSync(path.join(directory, "fixed"), "");
	await runtime.operation("run_check", { taskId: task.id, checkId: "behavior", repair: true }, "director");
	const done = await runtime.operation("report_result", { taskId: task.id, summary: "Actual repaired behavior passed" }, "director");
	assert.ok(done && typeof done === "object" && "verdict" in done);
	assert.equal(done.verdict.passed, true);
	assert.equal(runtime.store().getTask(task.id).state, "done");
	assert.equal(calls, 2);
	assert.equal(runtime.store().snapshot().effects.filter(effect => effect.kind === "create").length, 0);
	assert.ok(runtime.store().snapshot().attempts.every(attempt => !attempt.slot));
});

test("automatic repair is not blocked by another ready goal and still preserves explicit repair limits", async t => {
	for (const capped of [false, true]) {
		const { runtime } = fixture(t, { execute: async (name, args) => {
			if (name === "send_session_message") return { resultType: "success" };
			runtime.pre(name, args, "director", `native-failure-${capped}`);
			const command = spawnSync("/bin/sh", ["-c", text(record(args).command, "command")], { encoding: "utf8" });
			const result = { resultType: "success", textResultForLlm: command.stdout };
			runtime.post(name, args, result, "director");
			return result;
		} });
		await runtime.operation("start_goal", { ...definition, limits: capped ? { repairs: 0 } : {},
			tasks: [{ ...definition.tasks[0], checks: [{ ...definition.tasks[0].checks[0], command: "node -e 'process.exit(1)'" }] }],
		}, "director");
		const task = runtime.store().snapshot().tasks[0];
		await runtime.operation("start_task", { taskId: task.id }, "director");
		if (!capped) await runtime.operation("start_goal", definition, "competitor");
		const result = record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior", repair: true }, "director"));
		assert.equal(record(result.continuation).state, capped ? "blocked" : "running");
		if (capped) assert.equal(record(result.continuation).code, "repair_limit");
		assert.equal(record(result.result).state, "failed");
		assert.equal(result.promoted, true);
		assert.equal(runtime.store().snapshot(task.goalId).attempts.length, capped ? 1 : 2);
		assert.equal(runtime.store().getTask(task.id).state, capped ? "failed" : "running");
		assert.equal(runtime.store().snapshot().attempts.filter(attempt => attempt.slot).length, capped ? 0 : 1);
	}
});

test("a pending chained check cannot reuse a previous check's failed evidence to start repair", async t => {
	let calls = 0;
	const { runtime } = fixture(t, { execute: async (name, args) => {
		runtime.pre(name, args, "director", `native-check-${++calls}`);
		if (calls === 2) return { resultType: "success", textResultForLlm: "The native command is still running" };
		const command = spawnSync("/bin/sh", ["-c", text(record(args).command, "command")], { encoding: "utf8" });
		const result = { resultType: "success", textResultForLlm: command.stdout };
		runtime.post(name, args, result, "director");
		return result;
	} });
	await runtime.operation("start_goal", { ...definition,
		tasks: [{ ...definition.tasks[0], checks: [{ ...definition.tasks[0].checks[0], command: "node -e 'process.exit(1)'" }] }],
	}, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	await runtime.operation("run_check", { taskId: task.id, checkId: "behavior" }, "director");
	const pending = record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior", repair: true }, "director"));
	assert.equal(pending.state, "pending-native-evidence");
	assert.equal(runtime.store().getTask(task.id).state, "running");
	assert.equal(runtime.store().snapshot().attempts.length, 1);
	assert.equal(runtime.store().resultsForAttempt(text(runtime.store().getTask(task.id).currentAttemptId, "attempt")).length, 0);
	assert.equal(runtime.store().getEffect(text(pending.effectId, "effect")).state, "issued");
});

/** @param {import("node:test").TestContext} t @param {Partial<Pick<Parameters<typeof createRuntime>[0], "execute"|"log">>} [hooks] */
async function delegatedRepairFixture(t, hooks = {}) {
	/** @type {Array<{name:string,args:Record<string,unknown>}>} */
	const notifications = [];
	const { runtime: director, directory } = fixture(t, {
		execute: async (name, args) => {
			notifications.push({ name, args: record(args) });
			if (name !== "send_session_message") throw new Error("The coordinator must never stop another session's shell");
			return { resultType: "success" };
		}, ...hooks,
	});
	let commands = 0;
	const worker = createRuntime({ directory, log: message => { throw new Error(message); }, execute: async (name, args) => {
		if (name === "send_session_message") return { resultType: "success" };
		assert.equal(name, "bash");
		worker.pre(name, args, "worker", `native-check-${++commands}`);
		const command = spawnSync("/bin/sh", ["-c", text(record(args).command, "command")], { encoding: "utf8" });
		const result = { resultType: "success", textResultForLlm: command.stdout };
		worker.post(name, args, result, "worker");
		return result;
	} });
	t.after(() => worker.close());
	await director.operation("start_goal", { ...definition, limits: { workers: 1, repairs: 3 },
		tasks: [{ ...definition.tasks[0], checks: [{ ...definition.tasks[0].checks[0], command: "node -e 'process.exit(1)'" }] }],
	}, "director");
	const task = director.store().snapshot().tasks[0];
	const dispatch = record(await director.operation("prepare_dispatch", { taskIds: [task.id] }, "director"));
	assert.ok(Array.isArray(dispatch.prepared));
	const args = record(dispatch.prepared[0]).arguments;
	director.pre("create_session", args, "director", "worker-creation");
	director.post("create_session", args, { id: "worker" }, "director");
	return { director, worker, task, directory, notifications };
}

test("each warm repair stays quiet while exhausted repairs produce one coalesced accountable wake", async t => {
	const { director, worker, task, notifications } = await delegatedRepairFixture(t);
	for (let index = 0; index < 3; index++) {
		const result = record(await worker.operation("run_check", { taskId: task.id, checkId: "behavior", repair: true }, "worker"));
		assert.equal(record(result.continuation).state, "running");
		assert.deepEqual(director.store().pendingWakes("director"), []);
	}
	const exhausted = record(await worker.operation("run_check", { taskId: task.id, checkId: "behavior", repair: true }, "worker"));
	await worker.flushNotifications();
	assert.equal(record(exhausted.continuation).code, "repair_limit");
	const wakes = director.store().pendingWakes("director");
	assert.equal(wakes.length, 1);
	assert.equal(wakes[0].generation, 1);
	assert.equal(wakes[0].sent, 1);
	assert.equal(director.store().getTask(task.id).repairs, 3);
	assert.equal(notifications.length, 0);
});

test("the coordinator sends cancellation or supersession to the actual repairing worker even without a shell", async t => {
	for (const evolve of [false, true]) for (const runningCommand of [false, true]) {
		const { director, worker, task, notifications } = await delegatedRepairFixture(t);
		const result = record(await worker.operation("run_check", { taskId: task.id, checkId: "behavior", repair: true }, "worker"));
		const freshId = text(record(record(result.continuation).attempt).id, "repair attempt");
		if (runningCommand) worker.pre("bash", { command: "sleep 1", shellId: "worker-only" }, "worker", "worker-process");
		if (evolve) await director.operation("evolve_task", { taskId: task.id, expectedVersion: 2,
			checks: [...worker.store().getTask(task.id).checks, { id: "derived-observation", origin: "derived",
				requirement: "Check the changed observation", kind: "command", command: "node -e 'process.exit(0)'" }],
		}, "director");
		else await director.operation("cancel_task", { taskId: task.id }, "director");
		const stop = notifications.find(item => String(item.args.message).startsWith("Foundry stop assignments:"));
		assert.ok(stop, `Missing ${evolve ? "supersession" : "cancellation"} notice with shell=${runningCommand}`);
		assert.equal(stop.name, "send_session_message");
		assert.equal(stop.args.session_id, "worker");
		assert.ok(String(stop.args.message).includes(freshId));
		assert.ok(String(stop.args.message).includes(evolve ? "superseded" : "cancelled"));
		assert.equal(String(stop.args.message).includes("worker-only"), runningCommand);
		assert.equal(director.store().getAttempt(freshId).state, "cancelled");
		assert.equal(director.store().getAttempt(freshId).slot, runningCommand);
		if (runningCommand) {
			worker.toolComplete({ toolCallId: "worker-process", success: true, shellExecution: { exitCode: 1 } }, "worker");
			assert.equal(director.store().getAttempt(freshId).slot, false);
		}
		await director.operation("get_context", { goalId: task.goalId }, "director");
		assert.equal(notifications.filter(item => String(item.args.message).startsWith("Foundry stop assignments:")).length, 1);
	}
});

test("a reserved repair survives reload and cannot be dispatched or locally started by its coordinator", async t => {
	const { director, worker, task, directory } = await delegatedRepairFixture(t);
	await worker.operation("run_check", { taskId: task.id, checkId: "behavior" }, "worker");
	const failed = record(await worker.operation("report_result", { taskId: task.id, resultId: "recorded-failure",
		summary: "Actual failed check" }, "worker"));
	director.store().reassignTask(task.id, "replacement", "director");
	const competitor = director.store().createTask({ goalId: task.goalId, title: "Own-slot competitor",
		assignment: "Occupy the actual goal slot", workType: "analysis" }, "director");
	const occupied = director.store().startLocalTask(competitor.id, "director");
	const repair = record(await worker.operation("report_result", { taskId: task.id,
		attemptId: record(failed.result).attemptId, resultId: "recorded-failure", summary: "Actual failed check", repair: true }, "worker"));
	assert.equal(record(repair.continuation).code, "capacity_wait");
	assert.equal(director.store().getTask(task.id).owner, "replacement");
	assert.equal(director.store().getTask(task.id).repairs, 1);
	assert.equal(worker.context({ taskId: task.id }, "worker").ready[0].id, task.id);
	assert.ok(!director.context({ goalId: task.goalId }, "director").ready.some(item => item.id === task.id));
	const dispatch = record(await director.operation("prepare_dispatch", { taskIds: [task.id] }, "director"));
	assert.ok(Array.isArray(dispatch.blocked));
	assert.equal(record(dispatch.blocked[0]).code, "repair_reserved");
	await assert.rejects(director.operation("start_task", { taskId: task.id }, "director"), /reserved/);
	worker.close();
	const resumed = createRuntime({ directory, log: message => { throw new Error(message); } });
	t.after(() => resumed.close());
	assert.equal(resumed.context({ taskId: task.id }, "worker").ready[0].id, task.id);
	director.store().recordResult({ id: "slot-freed", attemptId: occupied.id, state: "done",
		summary: "Finished actual competing unit", evidence: [], outputs: [], findings: [] }, "director");
	assert.ok(director.store().pendingWakes("worker").some(wake => wake.relatedReasons?.includes("capacity")));
	const fresh = record(await resumed.operation("start_task", { taskId: task.id }, "worker"));
	assert.equal(fresh.nativeId, "worker");
	assert.equal(fresh.assignedOwner, "replacement");
	assert.equal(director.store().getTask(task.id).owner, "replacement");
	assert.equal(director.store().getTask(task.id).repairs, 1);
	assert.equal(director.store().getTask(task.id).repairReservation, undefined);
	const replay = record(await resumed.operation("report_result", { taskId: task.id,
		attemptId: record(failed.result).attemptId, resultId: "recorded-failure", summary: "Actual failed check", repair: true }, "worker"));
	assert.equal(record(record(replay.continuation).attempt).id, fresh.id);
	assert.equal(director.store().snapshot(task.goalId).attempts.filter(attempt => attempt.taskId === task.id).length, 2);
});

test("cancel stops multiple active units in one worker message and never wakes settled finished attempts", async t => {
	const { director, worker, task, notifications } = await delegatedRepairFixture(t);
	const completed = worker.store().createTask({ goalId: task.goalId, parentId: task.id, title: "Finished child",
		assignment: "Finish locally", workType: "analysis" }, "worker");
	worker.store().waitTask(task.id, "worker", { kind: "children", reason: "Delegate local work" });
	const finished = worker.store().startLocalTask(completed.id, "worker");
	worker.store().recordResult({ id: "finished-child", attemptId: finished.id, state: "done",
		summary: "Finished", evidence: [], findings: [], outputs: [] }, "worker");
	worker.store().resumeTask(task.id, "worker");
	const active = worker.store().createTask({ goalId: task.goalId, parentId: task.id, title: "Active child",
		assignment: "Work locally", workType: "analysis" }, "worker");
	worker.store().waitTask(task.id, "worker", { kind: "children", reason: "Await active child" });
	const child = worker.store().startLocalTask(active.id, "worker");
	await director.operation("cancel_task", { taskId: task.id }, "director");
	const stops = notifications.filter(item => String(item.args.message).startsWith("Foundry stop assignments:"));
	assert.equal(stops.length, 1);
	assert.ok(String(stops[0].args.message).includes(child.id));
	assert.ok(String(stops[0].args.message).includes(text(worker.store().getTask(task.id).currentAttemptId, "parent attempt")));
	assert.ok(!String(stops[0].args.message).includes(finished.id));
	assert.equal(worker.store().getAttempt(finished.id).state, "done");
});

test("an unavailable stop recipient is retained once without retrying or inventing command settlement", async t => {
	let sends = 0;
	const { director, worker, task } = await delegatedRepairFixture(t, {
		log: () => {},
		execute: async () => { sends++; return { resultType: "failure", error: "Session not found" }; },
	});
	worker.pre("bash", { command: "sleep 1", shellId: "owned-by-missing-session" }, "worker", "pending-process");
	await director.operation("cancel_task", { taskId: task.id }, "director");
	for (let index = 0; index < 3; index++) await director.operation("get_context", { goalId: task.goalId }, "director");
	assert.equal(sends, 1);
	const stops = director.store().snapshot().effects.filter(effect => effect.kind === "stop");
	assert.equal(stops.length, 1);
	assert.equal(record(stops[0].result).unavailable, true);
	assert.equal(director.store().getEffect("command:pending-process").state, "issued");
	assert.equal(director.store().getAttempt(text(director.store().getTask(task.id).currentAttemptId, "attempt")).slot, true);
});

test("a declined native check does not fabricate evidence or start a repair", async t => {
	const warnings = [];
	const { runtime } = fixture(t, { log: message => warnings.push(message), execute: async (name, args) => {
		runtime.pre(name, args, "director", "native-denied");
		return { resultType: "denied", textResultForLlm: "Actual native permission was declined" };
	} });
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const result = await runtime.operation("run_check", { taskId: task.id, checkId: "behavior", repair: true }, "director");
	assert.ok(result && typeof result === "object" && "state" in result);
	assert.equal(result.state, "native-execution-rejected");
	assert.equal(warnings.length, 1);
	assert.equal(runtime.store().snapshot().attempts.length, 1);
	assert.equal(runtime.store().snapshot().effects[0].state, "settled");
	assert.deepEqual(runtime.store().evidenceForAttempt(text(task.currentAttemptId ?? runtime.store().getTask(task.id).currentAttemptId, "attempt")), []);
});

test("ambiguous local commands retain both attempts and are not stopped with an unrelated unit", async t => {
	let stops = 0;
	const { runtime } = fixture(t, { execute: async () => { stops++; return { resultType: "success" }; } });
	await runtime.operation("start_goal", { ...definition, tasks: ["one", "two"].map(title => ({
		title, workType: "analysis", assignment: "Execute local work", checks: [],
	})) }, "director");
	const tasks = runtime.store().snapshot().tasks;
	for (const task of tasks) await runtime.operation("start_task", { taskId: task.id }, "director");
	runtime.pre("bash", { command: "sleep 1" }, "director", "shared-bash");
	runtime.toolComplete({ toolCallId: "shared-bash", success: true, toolTelemetry: {
		restrictedProperties: { shell_id: "generated-shell" },
	} }, "director");
	const effect = runtime.store().getEffect("command:shared-bash");
	assert.equal(effect?.relatedAttemptIds?.length, 1);
	await runtime.operation("cancel_task", { taskId: tasks[1].id }, "director");
	assert.equal(stops, 0);
	assert.equal(runtime.store().getAttempt(text(runtime.store().getTask(tasks[1].id).currentAttemptId, "attempt")).slot, true);
	assert.ok(runtime.context({ goalId: tasks[0].goalId }, "director").tasks.some(task => task.id === tasks[1].id));
	const focused = runtime.context({ taskId: tasks[0].id }, "director");
	assert.equal(focused.commands[0].shellId, "generated-shell");
	runtime.toolComplete({ toolCallId: "shared-bash", success: true, shellExecution: { exitCode: 0 } }, "director");
	assert.equal(runtime.store().getAttempt(text(runtime.store().getTask(tasks[1].id).currentAttemptId, "attempt")).slot, false);
	assert.equal(runtime.store().getTask(tasks[0].id).state, "running");
});

test("explicit command affinity and shared follow-up IDs settle only the exact native shell", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", { ...definition, tasks: ["one", "two"].map(title => ({
		title, workType: "analysis", assignment: "Execute local work", checks: [],
	})) }, "director");
	const tasks = runtime.store().snapshot().tasks;
	for (const task of tasks) await runtime.operation("start_task", { taskId: task.id }, "director");
	const prepared = [];
	for (const task of tasks) {
		const command = await runtime.operation("prepare_command", { taskId: task.id, command: "echo local" }, "director");
		assert.ok(command && typeof command === "object" && "arguments" in command && "effectId" in command);
		prepared.push(command);
	}
	for (const [index, command] of prepared.entries()) {
		runtime.pre("bash", command.arguments, "director", `bash:${tasks[index].id}`);
		runtime.pre("read_bash", { shellId: command.effectId }, "director", "direct-read_bash");
	}
	runtime.toolComplete({ toolCallId: "direct-read_bash", success: true, shellExecution: { exitCode: 0 } }, "director");
	assert.equal(runtime.store().getEffect(prepared[0].effectId)?.state, "issued");
	runtime.toolComplete({ toolCallId: "direct-read_bash", success: true, shellExecution: { exitCode: 0 },
		toolTelemetry: { restrictedProperties: { shell_id: prepared[1].effectId } },
	}, "director");
	assert.equal(runtime.store().getEffect(prepared[1].effectId)?.state, "settled");
	assert.equal(runtime.store().getEffect(prepared[0].effectId)?.state, "issued");
});

for (const kind of ["check", "command"]) test(`exact ${kind} affinity admits a live successor without executing sealed old work`, async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await runtime.operation("start_factory", { source: factorySource(directory, { goal: { ...definition,
		scope: { ...definition.scope, mode: "interactive" }, tasks: [
			{ ...definition.tasks[0], id: "unfinished" }, { ...definition.tasks[0], id: "complete" },
		] } }) }, "director");
	const [old, final] = runtime.store().snapshot().tasks;
	await runtime.operation("start_task", { taskId: old.id }, "director");
	const oldCommand = record(await runtime.operation("prepare_command", { taskId: old.id, command: "echo old" }, "director"));
	await acceptInline(runtime, final.id);
	const oldAttempt = runtime.store().getAttempt(text(runtime.store().getTask(old.id).currentAttemptId, "old attempt"));
	assert.equal(oldAttempt.state, "running");
	assert.equal(oldAttempt.slot, true);
	await runtime.operation("start_goal", definition, "director");
	const successor = runtime.store().snapshot().tasks.find(task => task.goalId !== old.goalId);
	assert.ok(successor);
	await runtime.operation("start_task", { taskId: successor.id }, "director");
	const prepared = record(await runtime.operation(kind === "check" ? "prepare_check" : "prepare_command",
		{ taskId: successor.id, ...(kind === "check" ? { checkId: "behavior" } : { command: "echo successor" }) }, "director"));
	assert.throws(() => runtime.pre("bash", prepared.arguments, "stranger", "wrong-owner"), { code: "foreign_execution" });
	assert.throws(() => runtime.pre("bash", { ...record(prepared.arguments), shellId: "wrong-shell" }, "director", "wrong-shell"),
		{ code: "assignment_changed" });
	assert.throws(() => runtime.pre("bash", oldCommand.arguments, "director", "closed-command"), { code: "job_closed" });
	assert.throws(() => runtime.pre("bash", { command: "echo ambiguous" }, "director", "ambiguous-command"), { code: "job_closed" });
	assert.throws(() => runtime.pre("apply_patch", {}, "director", "ambiguous-edit"), { code: "job_closed" });
	runtime.pre("bash", prepared.arguments, "director", "successor-command");
	const effect = runtime.store().getEffect(text(prepared.effectId, "successor effect"));
	assert.equal(effect.state, "issued");
	assert.equal(effect.attemptId, runtime.store().getTask(successor.id).currentAttemptId);
	assert.equal(effect.relatedAttemptIds, undefined);
	assert.equal(runtime.store().getEffect(text(oldCommand.effectId, "old effect")).state, "prepared");
	assert.deepEqual(runtime.store().getAttempt(oldAttempt.id), oldAttempt);
});

for (const disposition of ["waiting", "paused", "superseded"]) test(`exact prepared commands cannot execute a ${disposition} attempt`, async t => {
	const { runtime, directory } = fixture(t, authorizedFactory);
	await runtime.operation("start_factory", { source: factorySource(directory) }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const prepared = record(await runtime.operation("prepare_command", { taskId: task.id, command: "echo scoped" }, "director"));
	if (disposition === "waiting") {
		await runtime.operation("wait_task", { taskId: task.id, kind: "capacity", reason: "Yield execution capacity" }, "director");
	} else if (disposition === "paused") {
		await runtime.operation("pause_factory", { factoryId: "fixture-factory" }, "director");
	} else {
		await runtime.operation("evolve_task", { taskId: task.id, expectedVersion: task.version,
			checks: [...task.checks, { id: "extra", origin: "derived", kind: "command", requirement: "New assigned behavior", command: "true" }] }, "director");
	}
	assert.throws(() => runtime.pre("bash", prepared.arguments, "director", "inactive-command"),
		{ code: disposition === "waiting" ? "capacity_required" : "command_retired" });
	assert.notEqual(runtime.store().getEffect(text(prepared.effectId, "effect")).state, "issued");
});

test("prepared effect ownership cannot substitute for the actual executing native identity", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	const batch = record(await runtime.operation("prepare_dispatch", { taskIds: [task.id] }, "director"));
	assert.ok(Array.isArray(batch.prepared));
	const call = record(batch.prepared[0]);
	runtime.pre("create_session", call.arguments, "director", "create-worker");
	runtime.post("create_session", call.arguments, { id: "native-worker" }, "director");
	const request = { command: "echo creator", shellId: "creator-command" };
	runtime.store().recordEffect({ id: "creator-command", attemptId: text(call.attemptId, "attempt"),
		kind: "command", state: "prepared", request }, "director");
	assert.throws(() => runtime.pre("bash", request, "director", "creator-execution"), { code: "foreign_execution" });
	assert.equal(runtime.store().getEffect("creator-command").state, "prepared");
});

test("unknown replacements are inspected once and mismatched native metadata never grants ownership", async t => {
	let calls = 0;
	const { runtime } = fixture(t, { readSession: async id => { calls++; return { structuredContent: { id: id === "bad" ? "someone-else" : id } }; } });
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	await assert.rejects(runtime.operation("reassign_task", { taskId: task.id, newOwner: "bad" }, "director"), /actual replacement/);
	assert.equal(runtime.store().getTask(task.id).owner, "director");
	await runtime.operation("reassign_task", { taskId: task.id, newOwner: "replacement" }, "director");
	await runtime.operation("reassign_task", { taskId: task.id, newOwner: "replacement" }, "director");
	assert.equal(calls, 2);
});

test("retired native input clears only on an explicit actual native observation", async t => {
	let answered = false;
	const { runtime } = fixture(t, { readSession: async id => ({ structuredContent: { id, ...(answered ? { awaiting_input: null } : {}) } }) });
	await runtime.operation("start_goal", { ...definition, tasks: [{ title: "Input boundary", workType: "analysis", assignment: "Preserve the real question", checks: [] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	await runtime.operation("wait_task", { taskId: task.id, kind: "input", reason: "Actual decision", requestId: "native-request" }, "director");
	await runtime.operation("evolve_task", { taskId: task.id, expectedVersion: 1, checks: [{
		id: "derived", origin: "derived", requirement: "A changed executable procedure", kind: "command", command: "true",
	}] }, "director");
	const before = await runtime.operation("get_context", { goalId: task.goalId }, "director");
	assert.ok(before && typeof before === "object" && "inputRequests" in before);
	assert.equal(before.inputRequests[0].retired, true);
	answered = true;
	const after = await runtime.operation("get_context", { goalId: task.goalId }, "director");
	assert.ok(after && typeof after === "object" && "inputRequests" in after);
	assert.equal(after.inputRequests.length, 0);
	assert.equal(runtime.store().getTask(task.id).state, "ready");
});

test("a rejected unavailable-owner wake survives runtime restart without replay or adopting its work", async t => {
	let deliveries = 0;
	const failures = [];
	const execute = async () => {
		deliveries++;
		return { resultType: "failure", textResultForLlm: "The native session is archived" };
	};
	const { runtime, directory } = fixture(t, { execute, log: message => failures.push(message) });
	await runtime.operation("start_goal", { ...definition, tasks: [{
		id: "coordinator", title: "Existing coordinator", workType: "analysis", assignment: "Retain ownership", checks: [],
	}] }, "director");
	const task = runtime.store().getTask("coordinator");
	const dispatch = await runtime.operation("prepare_dispatch", { taskIds: [task.id] }, "director");
	assert.ok(dispatch && typeof dispatch === "object" && "prepared" in dispatch && dispatch.prepared);
	const call = dispatch.prepared[0];
	runtime.pre("create_session", call.arguments, "director", "coordinator-create");
	runtime.post("create_session", call.arguments, { id: "unavailable-coordinator" }, "director");
	await runtime.operation("create_task", { goalId: task.goalId, parentId: task.id, title: "Completed local leaf",
		workType: "analysis", assignment: "Finish only this local observation", checks: [] }, "unavailable-coordinator");
	const leaf = runtime.store().snapshot(task.goalId).tasks.find(candidate => candidate.parentId === task.id);
	assert.ok(leaf);
	await runtime.operation("start_task", { taskId: leaf.id }, "unavailable-coordinator");
	await runtime.operation("report_result", { taskId: leaf.id, summary: "Local leaf completed" }, "unavailable-coordinator");
	// Publishing from this coordinator does not send itself a wake; another accountable owner does.
	await runtime.operation("get_context", { goalId: task.goalId }, "director");
	assert.equal(deliveries, 1);
	assert.equal(failures.length, 1);
	const rejected = runtime.store().snapshot(task.goalId).wakes.find(wake => wake.owner === "unavailable-coordinator");
	assert.ok(rejected?.unavailable);
	assert.equal(rejected.unavailable.fallback, "director");
	runtime.close();
	const restarted = createRuntime({ directory, execute, log: message => failures.push(message) });
	t.after(() => restarted.close());
	const context = await restarted.operation("get_context", { goalId: task.goalId }, "director");
	assert.ok(context && typeof context === "object" && "unavailableOwners" in context);
	assert.equal(context.unavailableOwners[0].owner, "unavailable-coordinator");
	assert.equal(deliveries, 1);
	assert.equal(restarted.store().getTask(task.id).owner, "unavailable-coordinator");
	assert.equal(restarted.store().getTask(leaf.id).state, "done");
	assert.equal(restarted.store().snapshot(task.goalId).attempts.length, 2);
	assert.equal(restarted.store().snapshot(task.goalId).effects.filter(effect => effect.kind === "create").length, 1);
	assert.equal(restarted.store().getDelivery(rejected.unavailable.effectId).state, "settled");
});

test("the assigned runner supplies actual versioned inputs and retains them in raw evidence", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", { ...definition, tasks: [
		{ id: "producer", title: "Produce data", workType: "analysis", assignment: "Publish fixture input", checks: [] },
		{ id: "consumer", title: "Evaluate input", workType: "analysis", assignment: "Use the actual assigned metadata",
			inputs: [{ taskId: "producer", output: "data", version: "fixture-v1" }], checks: [{
				id: "input-procedure", origin: "user", requirement: "The evaluator consumes its actual assigned input",
				kind: "command", command: "node -e 'const assert=require(\"node:assert/strict\"); const inputs=JSON.parse(process.env.FOUNDRY_INPUTS_JSON); assert.equal(inputs[0].taskId,\"producer\"); assert.equal(inputs[0].output.version,\"fixture-v1\"); assert.equal(process.env.FOUNDRY_TASK_ID,\"consumer\"); assert.ok(process.env.FOUNDRY_ATTEMPT_ID);'",
			}] },
	] }, "director");
	await runtime.operation("start_task", { taskId: "producer" }, "director");
	await runtime.operation("report_result", { taskId: "producer", summary: "Published fixture data",
		outputs: [{ name: "data", kind: "analysis", reference: "artifact:fixture", version: "fixture-v1" }] }, "director");
	await runtime.operation("start_task", { taskId: "consumer" }, "director");
	const prepared = await runtime.operation("prepare_check", { taskId: "consumer", checkId: "input-procedure" }, "director");
	assert.ok(prepared && typeof prepared === "object" && "arguments" in prepared);
	runtime.pre("bash", prepared.arguments, "director", "actual-input-procedure");
	const stdout = execFileSync("/bin/sh", ["-c", text(record(prepared.arguments).command, "command")], { encoding: "utf8" });
	runtime.post("bash", prepared.arguments, { resultType: "success", textResultForLlm: stdout }, "director");
	const result = await runtime.operation("report_result", { taskId: "consumer", summary: "Actual inputs consumed" }, "director");
	assert.ok(result && typeof result === "object" && "promoted" in result && result.promoted);
	assert.equal(result.result.state, "done");
	assert.equal(result.verdict.passed, true);
	assert.deepEqual(JSON.parse(readFileSync(result.result.evidence[0].reference, "utf8")).inputs,
		runtime.store().getAttempt(result.result.attemptId).inputs);
});

test("coordinator context summarizes procedures while the assigned task retains its executable definition", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	const parent = runtime.context({ goalId: task.goalId }, "director");
	assert.equal(parent.tasks[0].assignment, undefined);
	assert.equal("command" in parent.tasks[0].checks[0], false);
	assert.equal("command" in parent.ready[0].checks[0], false);
	assert.equal(parent.ready[0].assignment, undefined);
	assert.equal(parent.tasks[0].checks[0].requirement, task.checks[0].requirement);
	const worker = runtime.context({ taskId: task.id }, "director");
	assert.equal(worker.tasks[0].assignment, task.assignment);
	assert.equal("command" in worker.tasks[0].checks[0] && worker.tasks[0].checks[0].command, task.checks[0].command);
});

test("inspecting an original native session preserves a fresh warm attempt and its completed history", async t => {
	const { runtime } = fixture(t);
	const worker = "55555555-5555-4555-8555-555555555555";
	await runtime.operation("start_goal", { ...definition, tasks: [{ title: "Warm worker", workType: "analysis",
		assignment: "Preserve original native provenance", checks: [] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	const prepared = await runtime.operation("prepare_dispatch", { taskIds: [task.id] }, "director");
	assert.ok(prepared && typeof prepared === "object" && "prepared" in prepared);
	assert.ok(Array.isArray(prepared.prepared));
	const call = prepared.prepared[0];
	runtime.pre("create_session", call.arguments, "director", "original-create");
	runtime.post("create_session", call.arguments, { textResultForLlm:
		`Created session '${record(call.arguments).name}' (id: ${worker}) in project 'fixture' with a kickoff prompt.` }, "director");
	await runtime.operation("report_result", { taskId: task.id, summary: "Original milestone" }, worker);
	await runtime.operation("evolve_task", { taskId: task.id, expectedVersion: 1, checks: [{
		id: "follow-up", origin: "derived", requirement: "A fresh scoped procedure", kind: "command", command: "true",
	}] }, "director");
	const fresh = await runtime.operation("start_task", { taskId: task.id }, worker);
	assert.ok(fresh && typeof fresh === "object" && "id" in fresh);
	runtime.post("get_session", { project_session_id: worker }, { structuredContent: {
		id: worker, name: record(call.arguments).name, creator_session_id: "director", coordinating_creator_session_id: "director",
	} }, "director");
	assert.equal(runtime.store().getTask(task.id).currentAttemptId, fresh.id);
	assert.equal(runtime.store().getAttempt(call.attemptId).state, "done");
	assert.equal(runtime.store().getAttempt(text(fresh.id, "attempt")).state, "running");
});

test("native name whitespace normalization recovers an issued child without granting identity from its name", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", { ...definition, tasks: [{ title: "Native   normalized child",
		workType: "analysis", assignment: "Execute without activation", checks: [] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	const attempt = runtime.store().prepareAttempt(task.id, "director");
	const originalName = `Native   normalized child  ${attempt.token.slice(0, 8)}`;
	runtime.store().issueAttempt(attempt.id, "director", `create:${attempt.id}`, { name: originalName });
	const detail = { id: "native-worker", name: originalName.replace(/\s+/gu, " "),
		creator_session_id: "foreign", coordinating_creator_session_id: "director" };
	assert.throws(() => runtime.post("get_session", { project_session_id: detail.id }, detail, "director"), /actual native detail/i);
	runtime.post("get_session", { project_session_id: detail.id }, { ...detail, creator_session_id: "director" }, "director");
	assert.equal(runtime.store().getAttempt(attempt.id).nativeId, detail.id);
	assert.equal(runtime.store().getTask(task.id).state, "running");
});

test("complete kickoff, captured native identity and actual command evidence produce a result without activation", async t => {
	const { runtime } = fixture(t);
	const created = await runtime.operation("start_goal", definition, "director");
	const goal = runtime.store().snapshot().goals[0];
	const task = runtime.store().snapshot().tasks[0];
	assert.ok(created);
	const calls = await runtime.operation("prepare_dispatch", { taskIds: [task.id] }, "director");
	assert.ok(calls && typeof calls === "object" && "prepared" in calls);
	assert.ok(calls.prepared);
	const call = calls.prepared[0];
	const kickoff = record(record(call.arguments).kickoff);
	assert.equal(kickoff.mode, "autopilot");
	assert.match(text(kickoff.prompt, "complete kickoff"), /Execute this complete assignment now/);
	runtime.pre("create_session", call.arguments, "director", "native-create");
	const worker = "22222222-2222-4222-8222-222222222222";
	const receipt = { textResultForLlm: `Created session '${record(call.arguments).name}' (id: ${worker}) in project 'fixture' with a kickoff prompt. The session will start automatically.`, resultType: "success" };
	runtime.post("create_session", call.arguments, receipt, "director");
	runtime.post("create_session", call.arguments, receipt, "director");
	assert.equal(runtime.store().getTask(task.id).owner, worker);
	const check = await runtime.operation("prepare_check", { taskId: task.id, checkId: "behavior" }, worker);
	assert.ok(check && typeof check === "object" && "arguments" in check);
	const args = check.arguments;
	assert.ok(args && typeof args === "object" && "command" in args && typeof args.command === "string");
	assert.match(args.command, /^'node' /);
	runtime.pre("bash", args, worker, "native-check");
	const stdout = execFileSync("/bin/sh", ["-c", args.command], { encoding: "utf8" });
	runtime.post("bash", args, { textResultForLlm: stdout, resultType: "success" }, worker);
	const reported = await runtime.operation("report_result", {
		taskId: task.id, summary: "Assigned behavior passed",
		findings: [{ summary: "Architecture might need more review", evidenceIds: [] }],
	}, worker);
	assert.ok(reported && typeof reported === "object" && "promoted" in reported && reported.promoted);
	assert.equal(runtime.store().getTask(task.id).state, "done");
	assert.equal(runtime.store().pendingWakes(goal.owner).length, 1);
});

test("ordinary freeform edits are not intercepted by native creation bookkeeping", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", definition, "director");
	assert.doesNotThrow(() => runtime.pre("apply_patch", "*** Begin Patch\n", "director", "ordinary-edit"));
});

test("a replacement coordinator reconciles original issuance and reports the actual worker's admitted result", async t => {
	let name = "";
	const worker = "33333333-3333-4333-8333-333333333333";
	const { runtime } = fixture(t, { readSession: async id => ({ textResultForLlm: JSON.stringify({
		id: id === "replacement" ? id : worker, name, creator_session_id: "director", coordinating_creator_session_id: "director",
	}) }) });
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	const dispatch = await runtime.operation("prepare_dispatch", { taskIds: [task.id] }, "director");
	assert.ok(dispatch && typeof dispatch === "object" && "prepared" in dispatch);
	assert.ok(dispatch.prepared);
	const args = dispatch.prepared[0].arguments;
	name = text(record(args).name, "native name");
	runtime.pre("create_session", args, "director", "original-creation");
	await runtime.operation("reassign_task", { taskId: task.id, newOwner: "replacement" }, "director");
	await assert.rejects(runtime.operation("reconcile_native", { sessionId: worker }, "sibling"), /accountable coordinator/);
	await runtime.operation("reconcile_native", { sessionId: worker }, "replacement");
	assert.equal(runtime.store().getTask(task.id).owner, "replacement");
	const attempt = runtime.store().getAttempt(text(runtime.store().getTask(task.id).currentAttemptId, "attempt"));
	assert.equal(attempt.creator, "director");
	await assert.rejects(runtime.operation("prepare_check", { taskId: task.id, checkId: "behavior" }, "replacement"), /actual native worker/);
	const prepared = await runtime.operation("prepare_check", { taskId: task.id, checkId: "behavior" }, worker);
	assert.ok(prepared && typeof prepared === "object" && "arguments" in prepared);
	const command = text(record(prepared.arguments).command, "native command");
	assert.throws(() => runtime.pre("bash", prepared.arguments, "replacement", "foreign-check"), /another actual native worker/);
	runtime.pre("bash", prepared.arguments, worker, "actual-worker-check");
	const stdout = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" });
	runtime.post("bash", prepared.arguments, { textResultForLlm: stdout, resultType: "success" }, worker);
	const result = await runtime.operation("report_result", { taskId: task.id, summary: "Admitted assigned result" }, "replacement");
	assert.ok(result && typeof result === "object" && "result" in result && "promoted" in result && result.promoted);
	assert.equal(result.result.sender, worker);
	assert.equal(result.result.reportedBy, "replacement");
	assert.equal(runtime.store().getTask(task.id).state, "done");
});

test("coordinator handoff does not hide a worker's actual outstanding shell or grant it ownership", async t => {
	/** @type {Array<{name:string,args:import("./model.d.ts").Json}>} */
	const calls = [];
	const { runtime } = fixture(t, {
		readSession: async id => ({ id }),
		execute: async (name, args) => { calls.push({ name, args }); return { resultType: "success" }; },
	});
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	const dispatch = await runtime.operation("prepare_dispatch", { taskIds: [task.id] }, "director");
	assert.ok(dispatch && typeof dispatch === "object" && "prepared" in dispatch && dispatch.prepared);
	const args = dispatch.prepared[0].arguments;
	runtime.pre("create_session", args, "director", "worker-creation");
	runtime.post("create_session", args, { id: "worker" }, "director");
	runtime.pre("bash", { command: "sleep 1", shellId: "worker-owned-shell" }, "worker", "worker-process");
	await runtime.operation("reassign_task", { taskId: task.id, newOwner: "replacement" }, "director");
	await assert.rejects(runtime.operation("reassign_task", { taskId: task.id, newOwner: "worker" }, "worker"), /does not own|accountable/);
	assert.equal(runtime.context({ taskId: task.id }, "worker").commands[0].shellId, "worker-owned-shell");
	await runtime.operation("wait_task", { taskId: task.id, kind: "capacity", reason: "Settle the actual command before yielding" }, "worker");
	assert.equal(runtime.store().getAttempt(dispatch.prepared[0].attemptId).slot, true);
	runtime.toolComplete({ toolCallId: "worker-process", success: true, shellExecution: { exitCode: 0 } }, "worker");
	assert.equal(runtime.store().getAttempt(dispatch.prepared[0].attemptId).slot, false);
	await runtime.operation("resume_task", { taskId: task.id }, "worker");
	assert.equal(runtime.store().getAttempt(dispatch.prepared[0].attemptId).slot, true);
	runtime.pre("bash", { command: "sleep 1", shellId: "resumed-worker-shell" }, "worker", "resumed-worker-process");
	await runtime.operation("cancel_task", { taskId: task.id }, "director");
	const recovery = runtime.context({ goalId: task.goalId }, "worker");
	assert.equal(recovery.commands[0].shellId, "resumed-worker-shell");
	assert.equal(recovery.tasks[0].owner, "replacement");
	assert.equal(runtime.store().getAttempt(dispatch.prepared[0].attemptId).slot, true);
	runtime.post("stop_bash", { shellId: "resumed-worker-shell" }, {
		resultType: "success", textResultForLlm: "<command with id: resumed-worker-shell stopped>",
		toolTelemetry: { properties: { shell_status: "stopped" } },
	}, "worker");
	assert.equal(runtime.store().getAttempt(dispatch.prepared[0].attemptId).slot, false);
	assert.equal(runtime.store().getTask(task.id).state, "cancelled");
	assert.ok(calls.every(call => call.name !== "stop_bash"));
});

test("scoped check evolution produces fresh native evaluation without changing a contract check", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const checks = [...task.checks, { id: "follow-up", origin: "derived", kind: "command", requirement: "Observed follow-up", command: "node -e 'if (2 * 3 !== 6) process.exit(1)'" }];
	const changed = await runtime.operation("evolve_task", { taskId: task.id, expectedVersion: 1, checks }, "director");
	assert.ok(changed && typeof changed === "object" && "affected" in changed);
	assert.deepEqual(changed.affected, [task.id]);
	assert.deepEqual(runtime.store().getTask(task.id).checks[0], task.checks[0]);
	await runtime.operation("start_task", { taskId: task.id }, "director");
	for (const check of runtime.store().getTask(task.id).checks) {
		const prepared = await runtime.operation("prepare_check", { taskId: task.id, checkId: check.id }, "director");
		assert.ok(prepared && typeof prepared === "object" && "arguments" in prepared);
		runtime.pre("bash", prepared.arguments, "director", `check-${check.id}`);
		const stdout = execFileSync("/bin/sh", ["-c", text(record(prepared.arguments).command, "check command")], { encoding: "utf8" });
		runtime.post("bash", prepared.arguments, { textResultForLlm: stdout, resultType: "success" }, "director");
	}
	const reported = await runtime.operation("report_result", { taskId: task.id, summary: "Reevaluated only the changed task" }, "director");
	assert.ok(reported && typeof reported === "object" && "promoted" in reported && reported.promoted);
	assert.equal(runtime.store().getTask(task.id).version, 2);
});

test("initial source order does not become an execution dependency", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", {
		...definition, tasks: [
			{ ...definition.tasks[0], id: "consumer", inputs: [{ taskId: "producer", output: "result" }] },
			{ ...definition.tasks[0], id: "leaf", parentId: "parent" },
			{ ...definition.tasks[0], id: "producer" },
			{ ...definition.tasks[0], id: "parent" },
		],
	}, "director");
	const ready = runtime.store().readyTasks("director").map(task => task.id);
	assert.ok(ready.includes("leaf"));
	assert.ok(ready.includes("producer"));
	assert.ok(!ready.includes("consumer"));
});

test("local cancellation stops only known owned shells and retains capacity until actual completion", async t => {
	/** @type {Array<{name:string,args:import("./model.d.ts").Json}>} */
	const calls = [];
	const { runtime } = fixture(t, { execute: async (name, args) => { calls.push({ name, args }); return { resultType: "success" }; } });
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	runtime.pre("bash", { command: "sleep 1", shellId: "owned-only" }, "director", "owned-process");
	await runtime.operation("cancel_task", { taskId: task.id }, "director");
	assert.deepEqual(calls, [{ name: "stop_bash", args: { shellId: "owned-only" } }]);
	const attemptId = text(runtime.store().getTask(task.id).currentAttemptId, "attempt");
	assert.equal(runtime.store().getAttempt(attemptId).slot, true);
	const waiting = await runtime.operation("get_context", { taskId: task.id }, "director");
	assert.ok(waiting && typeof waiting === "object" && "commands" in waiting);
	assert.equal(waiting.commands[0].shellId, "owned-only");
	runtime.toolComplete({ toolCallId: "owned-process", success: true, shellExecution: { exitCode: 1 }, result: { content: "Stopped" } }, "director");
	assert.equal(runtime.store().getAttempt(attemptId).slot, false);
	await runtime.operation("get_context", { taskId: task.id }, "director");
	assert.equal(calls.length, 1);
});

test("a definitely rejected stop retries on an owner turn without reopening or replaying ambiguous delivery", async t => {
	let accepted = false;
	let calls = 0;
	const { runtime } = fixture(t, {
		log: () => {},
		execute: async () => { calls++; return { resultType: accepted ? "success" : "failure" }; },
	});

	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	const dispatch = await runtime.operation("prepare_dispatch", { taskIds: [task.id] }, "director");
	assert.ok(dispatch && typeof dispatch === "object" && "prepared" in dispatch && dispatch.prepared);
	const args = dispatch.prepared[0].arguments;
	runtime.pre("create_session", args, "director", "created-worker");
	await runtime.post("create_session", args, { id: "actual-worker" }, "director");
	await runtime.operation("cancel_task", { taskId: task.id }, "director");
	assert.equal(calls, 1);
	accepted = true;
	await runtime.operation("get_context", { goalId: task.goalId }, "director");
	assert.equal(calls, 2);
	await runtime.operation("get_context", { goalId: task.goalId }, "director");
	assert.equal(calls, 2);
	const stops = runtime.store().snapshot().effects.filter(effect => effect.kind === "stop");
	assert.equal(stops.length, 2);
	assert.equal(record(stops[0].result).accepted, false);
	assert.equal(record(stops[1].result).accepted, true);
});

test("native stopped-shell evidence settles cancellation without an invented process exit or a passing check", async t => {
	const { runtime } = fixture(t, { execute: async (_name, args) => ({
		resultType: "success", textResultForLlm: `<command with id: ${record(args).shellId} stopped>`,
		toolTelemetry: { properties: { shell_status: "stopped" } },
	}) });
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	runtime.pre("bash", { command: "sleep 1", shellId: "actually-stopped" }, "director", "original-process");
	await runtime.operation("cancel_task", { taskId: task.id }, "director");
	const attempt = runtime.store().getAttempt(text(runtime.store().getTask(task.id).currentAttemptId, "attempt"));
	assert.equal(attempt.slot, false);
	const command = runtime.store().getEffect("command:original-process");
	assert.equal(command?.state, "settled");
	assert.equal(record(command?.result).stopped, true);
	assert.equal(record(command?.result).evidence, undefined);
	assert.equal(runtime.store().getTask(task.id).outputs.length, 0);
});

test("a retained native stopped-read reconciles its own shell, never a missing or different shell", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	runtime.pre("bash", { command: "sleep 1", shellId: "stopped-read" }, "director", "original-process");
	await runtime.operation("cancel_task", { taskId: task.id }, "director");
	runtime.pre("read_bash", { shellId: "stopped-read", delay: 5 }, "director", "read-result");
	const event = {
		toolCallId: "read-result", success: false,
		toolTelemetry: {
			properties: { shell_error_category: "shell_stopped", shell_operation: "read", read_target_state: "stopped" },
			restrictedProperties: { shell_id: "different-shell" },
		},
	};
	runtime.toolComplete(event, "director");
	assert.equal(runtime.store().getEffect("command:original-process")?.state, "issued");
	event.toolTelemetry.restrictedProperties.shell_id = "stopped-read";
	runtime.toolComplete(event, "director");
	assert.equal(runtime.store().getEffect("command:original-process")?.state, "settled");
	assert.equal(runtime.store().getAttempt(text(runtime.store().getTask(task.id).currentAttemptId, "attempt")).slot, false);
});

test("native asynchronous follow-up settles its original command, not another attempt", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	runtime.pre("bash", { command: "sleep 1", shellId: "owned-shell" }, "director", "original-command");
	runtime.toolComplete({ toolCallId: "original-command", success: true, result: { content: "Still running" } }, "director");
	runtime.pre("read_bash", { shellId: "owned-shell", delay: 10 }, "director", "native-follow-up");
	runtime.toolComplete({
		toolCallId: "native-follow-up", success: true, shellExecution: { exitCode: 1 }, result: { content: "Process exited" },
	}, "director");
	const effects = runtime.store().snapshot().effects;
	assert.equal(effects.length, 1);
	assert.equal(effects[0].state, "settled");
	assert.equal(record(record(effects[0].result).nativeCompletion).toolCallId, "native-follow-up");
});

/** @param {string} toolCallId @param {Record<string,unknown>} args */
function retainedCommandEvents(toolCallId, args) {
	return {
		start: { id: "original-start", type: "tool.execution_start", timestamp: "2030-01-01T00:00:00Z",
			data: { toolCallId, toolName: "bash", arguments: args, turnId: "original-turn" } },
		completion: { id: "original-completion", type: "tool.execution_complete", timestamp: "2030-01-01T00:00:01Z",
			data: { toolCallId, turnId: "original-turn", success: true, shellExecution: { exitCode: 0 },
				result: { content: '{"old":"FOUNDRY_CHECK_RESULT:bm90LWpzb24="}',
					detailedContent: '{"old":"FOUNDRY_CHECK_RESULT:bm90LWpzb24="}\n<shellId: 447 completed with exit code 0>' } } },
	};
}

test("ordinary native commands ignore quoted check markers and retain their actual completion", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const args = { command: "Read ordinary metadata" };
	const events = retainedCommandEvents("ordinary-metadata", args);
	runtime.pre("bash", args, "director", "ordinary-metadata");
	assert.doesNotThrow(() => runtime.post("bash", args, { resultType: "success",
		textResultForLlm: events.completion.data.result.content }, "director"));
	runtime.toolComplete(events.completion.data, "director");
	const effect = runtime.store().getEffect("command:ordinary-metadata");
	assert.equal(effect?.state, "settled");
	assert.deepEqual(record(effect?.result).nativeCompletion, events.completion.data);
	assert.equal(record(effect?.result).evidence, undefined);
	assert.equal(runtime.store().evidenceForAttempt(text(task.currentAttemptId ?? runtime.store().getTask(task.id).currentAttemptId, "attempt")).length, 0);
});

test("own-session native recovery settles a retired ordinary command without replay or releasing a successor's claim", async t => {
	const args = { command: "Read ordinary metadata", description: "Inspect previous check receipts" };
	const events = retainedCommandEvents("retired-metadata", args);
	let reads = 0;
	const { runtime } = fixture(t, { readSession: async id => ({ id, project_id: "actual-project" }),
		readCommand: async () => { reads++; return events; } });
	await runtime.operation("start_goal", { ...definition, projectId: "actual-project" }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const oldId = text(runtime.store().getTask(task.id).currentAttemptId, "old attempt");
	runtime.store().claim({ attemptId: oldId, surface: "worktree:integration", resource: "apps" }, "director");
	runtime.pre("bash", args, "director", "retired-metadata");
	await runtime.operation("evolve_task", { taskId: task.id, expectedVersion: 1, checks: [...task.checks,
		{ id: "joined-behavior", origin: "derived", kind: "command", requirement: "Check joined behavior", command: "node -e 'process.exit(0)'" }],
	}, "director");
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const currentId = text(runtime.store().getTask(task.id).currentAttemptId, "successor");
	assert.throws(() => runtime.store().claim({ attemptId: currentId, surface: "worktree:integration", resource: "apps" }, "director"), { code: "claim_conflict" });
	const request = { sessionId: "director", toolCallId: "retired-metadata" };
	const recovered = record(await runtime.operation("reconcile_native", request, "director"));
	assert.equal(recovered.state, "settled");
	assert.equal(recovered.attemptId, oldId);
	assert.equal(record(recovered.nativeRecovery).completionEventId, events.completion.id);
	assert.equal(runtime.store().getTask(task.id).currentAttemptId, currentId);
	assert.equal(runtime.store().getAttempt(oldId).slot, false);
	const claim = runtime.store().claim({ attemptId: currentId, surface: "worktree:integration", resource: "apps" }, "director");
	await runtime.operation("reconcile_native", request, "director");
	assert.equal(reads, 2);
	assert.ok(runtime.store().snapshot().claims.some(item => item.id === claim.id));
	assert.equal(runtime.store().snapshot().effects.filter(effect => effect.kind === "command").length, 1);
	assert.equal(runtime.store().evidenceForAttempt(oldId).length, 0);
});

for (const mismatch of ["project", "arguments", "call", "pending"]) test(`native command recovery rejects ${mismatch} mismatch without settling`, async t => {
	const args = { command: "Read metadata" };
	const original = retainedCommandEvents("native-command", args);
	const events = mismatch === "arguments" ? { ...original, start: { ...original.start,
		data: { ...original.start.data, arguments: { command: "Different command" } } } }
		: mismatch === "call" ? { ...original, completion: { ...original.completion, data: { ...original.completion.data, toolCallId: "different-call" } } }
			: mismatch === "pending" ? { ...original, completion: { ...original.completion, data: { ...original.completion.data, shellExecution: undefined } } }
				: original;
	const { runtime } = fixture(t, { readSession: async id => ({ id, project_id: mismatch === "project" ? "other-project" : "actual-project" }),
		readCommand: async () => events });
	await runtime.operation("start_goal", { ...definition, projectId: "actual-project" }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	runtime.pre("bash", args, "director", "native-command");
	await assert.rejects(runtime.operation("reconcile_native", { sessionId: "director", toolCallId: "native-command" }, "director"),
		{ code: mismatch === "project" ? "native_identity_mismatch" : mismatch === "pending" ? "native_completion_pending" : "native_receipt_mismatch" });
	assert.equal(runtime.store().getEffect("command:native-command")?.state, "issued");
});

test("native recovery rejects foreign callers and never accepts caller-supplied completion JSON", async t => {
	let reads = 0;
	const { runtime } = fixture(t, { readSession: async id => ({ id }),
		readCommand: async () => { reads++; throw new Error("No native receipt retained"); } });
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const args = { command: "Read metadata" };
	runtime.pre("bash", args, "director", "native-command");
	const supplied = { sessionId: "director", toolCallId: "native-command", ...retainedCommandEvents("native-command", args) };
	await assert.rejects(runtime.operation("reconcile_native", supplied, "stranger"), { code: "foreign_execution" });
	assert.equal(reads, 0);
	await assert.rejects(runtime.operation("reconcile_native", supplied, "director"), /No native receipt retained/);
	assert.equal(reads, 1);
	assert.equal(runtime.store().getEffect("command:native-command")?.state, "issued");
});

test("native history pages backwards for an exact pair and rejects expired or stalled cursors", async () => {
	const events = retainedCommandEvents("wanted-call", { command: "Read metadata" });
	/** @type {Array<Parameters<import("@github/copilot-sdk").CopilotSession["rpc"]["eventLog"]["read"]>[0]>} */
	const calls = [];
	const pages = [
		{ events: [events.completion], cursor: "older", hasMore: true, cursorStatus: "ok" },
		{ events: [events.start], cursor: "beginning", hasMore: false, cursorStatus: "ok" },
	];
	const recovered = await readCommandEvents(async args => {
		calls.push(args);
		const page = pages.shift();
		assert.ok(page);
		return page;
	}, "wanted-call");
	assert.deepEqual(recovered, events);
	assert.equal(calls[1].cursor, "older");
	assert.ok(calls.every(call => call.direction === "backward" && call.view === "history" && call.includeEphemeral === false));
	for (const [status, code] of [["expired", "native_history_expired"], ["ok", "native_history_stalled"]]) {
		await assert.rejects(readCommandEvents(async () => ({ events: [], cursor: "same", hasMore: true, cursorStatus: status }), "wanted-call"), { code });
	}
	await assert.rejects(readCommandEvents(async () => ({ events: [events.start], cursor: "end", hasMore: false, cursorStatus: "ok" }), "wanted-call"),
		{ code: "native_receipt_unavailable" });
});

test("cancelling an issued child queues a direct stop without pretending its command settled", async t => {
	let stopMessages = 0;
	const { runtime } = fixture(t, { execute: async () => { stopMessages++; return { resultType: "success" }; } });
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	const calls = await runtime.operation("prepare_dispatch", {}, "director");
	assert.ok(calls && typeof calls === "object" && "prepared" in calls && calls.prepared);
	const worker = "22222222-2222-4222-8222-222222222222";
	const call = calls.prepared[0];
	runtime.pre("create_session", call.arguments, "director", "create-worker");
	runtime.post("create_session", call.arguments, {
		resultType: "success", textResultForLlm: `Created session '${record(call.arguments).name}' (id: ${worker}) in project 'fixture' with a kickoff prompt.`,
	}, "director");
	runtime.pre("bash", { command: "sleep 30", shellId: "worker-command" }, worker, "worker-command");
	await runtime.operation("cancel_task", { taskId: task.id }, "director");
	await runtime.operation("cancel_task", { taskId: task.id }, "director");
	assert.equal(stopMessages, 1);
	assert.equal(runtime.store().getTask(task.id).state, "cancelled");
	assert.equal(runtime.store().snapshot().effects.find(effect => effect.kind === "command")?.state, "issued");
	assert.equal(runtime.store().getAttempt(text(task.currentAttemptId ?? runtime.store().getTask(task.id).currentAttemptId, "attempt")).slot, true);
});

for (const kind of ["artifact", "judgment"]) {
	test(`${kind} acceptance executes its assigned procedure rather than trusting its label`, async t => {
		const { runtime } = fixture(t);
		await runtime.operation("start_goal", {
			...definition, tasks: [{ ...definition.tasks[0], checks: [{ ...definition.tasks[0].checks[0], kind }] }],
		}, "director");
		const task = runtime.store().snapshot().tasks[0];
		await runtime.operation("start_task", { taskId: task.id }, "director");
		const check = await runtime.operation("prepare_check", { taskId: task.id, checkId: "behavior" }, "director");
		assert.ok(check && typeof check === "object" && "arguments" in check);
		const args = record(check.arguments);
		runtime.pre("bash", args, "director", `native-${kind}`);
		const stdout = execFileSync("/bin/sh", ["-c", text(args.command, "assigned procedure")], { encoding: "utf8" });
		runtime.post("bash", args, { textResultForLlm: stdout, resultType: "success" }, "director");
		await runtime.operation("report_result", { taskId: task.id, summary: "Assigned procedure passed" }, "director");
		assert.equal(runtime.store().getTask(task.id).state, "done");
	});
}

test("non-executable artifact acceptance fails before any work is created", async t => {
	const { runtime } = fixture(t);
	await assert.rejects(runtime.operation("start_goal", {
		...definition, tasks: [{ ...definition.tasks[0], checks: [{
			id: "presence", origin: "contract", kind: "artifact", requirement: "Validate the output", path: "output.json",
		}] }],
	}, "director"), /assigned check procedure/);
	assert.equal(runtime.store().snapshot().goals.length, 0);
});

test("reading one goal does not consume another goal's unseen wake", async t => {
	const { runtime } = fixture(t);
	for (let i = 0; i < 2; i++) {
		await runtime.operation("start_goal", {
			...definition, tasks: [{ ...definition.tasks[0], checks: [] }],
		}, "director");
		const task = runtime.store().snapshot().tasks[i];
		await runtime.operation("start_task", { taskId: task.id }, "director");
		await runtime.operation("report_result", { taskId: task.id, summary: "Scoped work delivered" }, "director");
	}
	const goals = runtime.store().snapshot().goals;
	await runtime.operation("get_context", { goalId: goals[0].id }, "director");
	assert.deepEqual(runtime.store().pendingWakes("director").map(wake => wake.goalId), [goals[1].id]);
});

test("unrelated delivered history does not grow a focused task context", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", definition, "director");
	const focused = runtime.store().snapshot().tasks[0];
	const before = await runtime.operation("get_context", { taskId: focused.id }, "director");
	for (let index = 0; index < 5; index++) {
		const unrelated = runtime.store().createTask({
			goalId: focused.goalId, title: `Past work ${index}`, assignment: "Unrelated completed work", workType: "analysis",
		}, "director");
		await runtime.operation("start_task", { taskId: unrelated.id }, "director");
		await runtime.operation("report_result", { taskId: unrelated.id, summary: "Delivered unrelated work" }, "director");
	}
	await runtime.operation("get_context", { goalId: focused.goalId }, "director");
	const after = await runtime.operation("get_context", { taskId: focused.id }, "director");
	assert.deepEqual(after, before);
});

test("concurrent leaf outputs share one queued wake without swallowing the later generation", async t => {
	/** @type {(value: unknown) => void} */
	let accept = () => {};
	let messages = 0;
	const queued = new Promise(resolve => { accept = resolve; });
	const { runtime } = fixture(t, { execute: async () => {
		messages++;
		return messages === 1 ? queued : { resultType: "success" };
	} });
	await runtime.operation("start_goal", {
		...definition, tasks: Array.from({ length: 3 }, () => ({ ...definition.tasks[0], checks: [] })),
	}, "director");
	const tasks = runtime.store().snapshot().tasks;
	const prepared = await runtime.operation("prepare_dispatch", {}, "director");
	assert.ok(prepared && typeof prepared === "object" && "prepared" in prepared && prepared.prepared);
	const workers = tasks.map((_, index) => `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`);
	for (const [index, call] of prepared.prepared.entries()) {
		runtime.pre("create_session", call.arguments, "director", `create-${index}`);
		runtime.post("create_session", call.arguments, {
			resultType: "success", textResultForLlm: `Created session '${record(call.arguments).name}' (id: ${workers[index]}) in project 'fixture' with a kickoff prompt.`,
		}, "director");
	}
	const first = runtime.operation("report_result", { taskId: tasks[0].id, summary: "First output" }, workers[0]);
	await new Promise(resolve => setImmediate(resolve));
	await runtime.operation("report_result", { taskId: tasks[1].id, summary: "Second output" }, workers[1]);
	assert.equal(messages, 1);
	accept({ resultType: "success" });
	await first;
	await runtime.flushNotifications();
	const pending = runtime.store().pendingWakes("director");
	assert.equal(pending.length, 1);
	assert.equal(pending[0].generation, 2);
	assert.equal(pending[0].sent, 1);
	assert.equal(pending[0].consumed, 0);
	await runtime.operation("get_context", { goalId: tasks[0].goalId }, "director");
	await runtime.operation("report_result", { taskId: tasks[2].id, summary: "Third output" }, workers[2]);
	await runtime.flushNotifications();
	assert.equal(messages, 2);
});

test("a contract compilation failure rolls back its goal and every initial task", async t => {
	const { runtime } = fixture(t);
	const duplicate = definition.tasks[0].checks[0];
	await assert.rejects(runtime.operation("start_goal", {
		...definition, tasks: [definition.tasks[0], { ...definition.tasks[0], checks: [duplicate, duplicate] }],
	}, "director"), /Check identities must be unique/);
	assert.equal(runtime.store().snapshot().goals.length, 0);
	assert.equal(runtime.store().snapshot().tasks.length, 0);
	await assert.rejects(runtime.operation("start_goal", {
		...definition, tasks: [{ ...definition.tasks[0], accidentallyIgnored: true }],
	}, "director"), /Unsupported source fields/);
	assert.equal(runtime.store().snapshot().goals.length, 0);
	await assert.rejects(runtime.operation("start_goal", { ...definition, limits: { worker: 2 } }, "director"), /Unsupported source fields/);
	assert.equal(runtime.store().snapshot().goals.length, 0);
});

test("shared finding parsing retains the runtime's omitted evidence default", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0], checks: [] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const result = record(await runtime.operation("report_result", { taskId: task.id, summary: "Unsupported opinion remains advisory",
		findings: [{ summary: "Consider a different strategy" }] }, "director"));
	assert.equal(result.promoted, true);
	assert.deepEqual(record(result.result).findings,
		[{ summary: "Consider a different strategy", evidenceIds: [] }]);
});

/** @param {import("node:test").TestContext} t @param {Parameters<typeof fixture>[1]} [hooks] */
async function settlementFixture(t, hooks) {
	const fixtureResult = fixture(t, hooks);
	const { runtime } = fixtureResult;
	await runtime.operation("start_goal", { ...definition, limits: { workers: 1 },
		tasks: Array.from({ length: 2 }, () => ({ ...definition.tasks[0], checks: [] })) }, "director");
	const task = runtime.store().snapshot().tasks[0];
	const dispatch = record(await runtime.operation("prepare_dispatch", { taskIds: [task.id] }, "director"));
	assert.ok(Array.isArray(dispatch.prepared));
	const args = record(dispatch.prepared[0]).arguments;
	runtime.pre("create_session", args, "director", "settlement-worker-creation");
	runtime.post("create_session", args, { id: "worker" }, "director");
	runtime.pre("bash", { command: "sleep 1", shellId: "settlement-shell" }, "worker", "settlement-command");
	await runtime.operation("report_result", { taskId: task.id, summary: "Output reported before shell settlement" }, "worker");
	runtime.context({ goalId: task.goalId }, "director");
	return { ...fixtureResult, task };
}

test("a disabled management route is tried once, retains manual wakes and returns stable cooperative-stop arguments", async t => {
	let calls = 0;
	const errors = [];
	const { runtime, task } = await settlementFixture(t, {
		log: message => { errors.push(message); },
		execute: async () => {
			calls++;
			return { resultType: "failure", error: "This session management tool is disabled" };
		},
	});
	await runtime.flushNotifications();
	runtime.toolComplete({ toolCallId: "settlement-command", success: true, shellExecution: { exitCode: 0 } }, "worker");
	await runtime.flushNotifications();
	const context = record(await runtime.operation("get_context", { taskId: task.id }, "worker"));
	assert.equal(context.messageRouteDisabled, "This session management tool is disabled");
	assert.ok(Array.isArray(context.wakes) && context.wakes.length === 1);
	assert.equal(record(context.wakes[0]).tool, "send_session_message");
	assert.equal(runtime.store().pendingWakes("director")[0].unavailable, undefined);
	const extra = runtime.store().createTask({ goalId: task.goalId, title: "Active worker", assignment: "Keep actual work tracked", workType: "analysis" }, "director");
	const dispatch = record(await runtime.operation("prepare_dispatch", { taskIds: [extra.id] }, "director"));
	assert.ok(Array.isArray(dispatch.prepared));
	const args = record(dispatch.prepared[0]).arguments;
	runtime.pre("create_session", args, "director", "disabled-stop-create");
	runtime.post("create_session", args, { id: "other-worker" }, "director");
	runtime.pre("bash", { command: "sleep 1", shellId: "disabled-stop-shell" }, "other-worker", "disabled-stop-command");
	const cancelled = record(await runtime.operation("cancel_task", { taskId: extra.id }, "director"));
	assert.ok(Array.isArray(cancelled.delivery));
	const first = record(cancelled.delivery[0]);
	assert.equal(first.state, "native-route-disabled");
	assert.equal(first.tool, "send_session_message");
	const again = record(await runtime.operation("get_context", { goalId: task.goalId }, "director"));
	assert.ok(Array.isArray(again.stops));
	assert.deepEqual(record(again.stops[0]).arguments, first.arguments);
	assert.equal(calls, 1);
	assert.equal(errors.length, 1);
	assert.equal(runtime.store().getEffect("command:disabled-stop-command").state, "issued");
});

test("successful reporting returns while native delivery is still waiting for queue acceptance", async t => {
	/** @type {(value:unknown)=>void} */
	let accept = () => {};
	const held = new Promise(resolve => { accept = resolve; });
	t.after(() => accept({ resultType: "success" }));
	const { runtime, task } = await settlementFixture(t, { execute: async () => held });
	assert.equal(runtime.store().getTask(task.id).state, "done");
	assert.equal(runtime.store().snapshot().wakes[0].inFlight, undefined);
	assert.equal(runtime.store().snapshot().wakes[0].consumed, 1);
	accept({ resultType: "success" });
	await runtime.flushNotifications();
	assert.equal(runtime.store().snapshot().wakes[0].inFlight, undefined);
});

test("an initially disabled cooperative stop creates one retained fallback instead of repeated retries", async t => {
	let calls = 0;
	const errors = [];
	const { runtime } = fixture(t, {
		log: message => { errors.push(message); },
		execute: async () => { calls++; return { resultType: "failure", error: "This session management tool is disabled" }; },
	});
	await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0], checks: [] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	const prepared = record(await runtime.operation("prepare_dispatch", {}, "director"));
	assert.ok(Array.isArray(prepared.prepared));
	const args = record(prepared.prepared[0]).arguments;
	runtime.pre("create_session", args, "director", "first-disabled-stop");
	runtime.post("create_session", args, { id: "worker" }, "director");
	runtime.pre("bash", { command: "sleep 1", shellId: "first-disabled-shell" }, "worker", "first-disabled-command");
	await runtime.operation("cancel_task", { taskId: task.id }, "director");
	const first = record(await runtime.operation("get_context", { goalId: task.goalId }, "director"));
	const again = record(await runtime.operation("get_context", { goalId: task.goalId }, "director"));
	assert.deepEqual(again.stops, first.stops);
	assert.equal(runtime.store().snapshot().effects.filter(effect => effect.kind === "stop").length, 2);
	assert.equal(runtime.store().getEffect("command:first-disabled-command").state, "issued");
	assert.equal(calls, 1);
	assert.equal(errors.length, 1);
});

for (const route of ["completion", "post-stop"]) {
	test(`${route} sends one capacity wake after late settlement without needing a current executing attempt`, async t => {
		let messages = 0;
		const { runtime, task } = await settlementFixture(t, { execute: async () => { messages++; return { resultType: "success" }; } });
		assert.equal(messages, 1);
		assert.equal(runtime.store().getAttempt(text(runtime.store().getTask(task.id).currentAttemptId, "attempt")).slot, true);
		if (route === "post-stop") {
			runtime.post("stop_bash", { shellId: "settlement-shell" }, {
				resultType: "success", textResultForLlm: "<command with id: settlement-shell stopped>",
				toolTelemetry: { properties: { shell_status: "stopped" } },
			}, "worker");
		}
		runtime.toolComplete({ toolCallId: "settlement-command", success: true, shellExecution: { exitCode: 0 } }, "worker");
		await runtime.flushNotifications();
		assert.equal(messages, 2);
		assert.equal(runtime.store().pendingWakes("director")[0].sent, 2);
		assert.equal(runtime.store().snapshot().attempts[0].slot, false);
	});
}

test("cancelled command settlement releases capacity and a failed send does not recursively resend", async t => {
	let messages = 0;
	const errors = [];
	const { runtime, task } = await settlementFixture(t, {
		log: message => { errors.push(message); },
		execute: async () => ({ resultType: ++messages === 1 ? "success" : "failure", error: "queue rejected" }),
	});
	runtime.store().cancelTask(task.id, "director");
	const event = { toolCallId: "settlement-command", success: true, shellExecution: { exitCode: 0 } };
	runtime.toolComplete(event, "worker");
	await runtime.flushNotifications();
	runtime.toolComplete(event, "worker");
	runtime.toolComplete({ toolCallId: "wake-delivery", success: false }, "worker");
	await runtime.flushNotifications();
	assert.equal(messages, 2);
	assert.equal(errors.length, 1);
	assert.equal(runtime.store().pendingWakes("director")[0].inFlight, undefined);
	assert.equal(runtime.store().snapshot().attempts[0].slot, false);
});

test("a second actual settlement queues a fresh generation when its owner consumed the in-flight notification", async t => {
	/** @type {(value:unknown)=>void} */
	let accept = () => {};
	/** @type {()=>void} */
	let entered = () => {};
	const held = new Promise(resolve => { accept = resolve; });
	const sending = new Promise(resolve => { entered = () => resolve(undefined); });
	let messages = 0;
	const { runtime } = fixture(t, { execute: async () => {
		if (++messages !== 3) return { resultType: "success" };
		entered();
		return held;
	} });
	await runtime.operation("start_goal", { ...definition, limits: { workers: 2 },
		tasks: Array.from({ length: 3 }, () => ({ ...definition.tasks[0], checks: [] })) }, "director");
	const tasks = runtime.store().snapshot().tasks;
	const workers = ["first-worker", "second-worker"];
	const dispatch = record(await runtime.operation("prepare_dispatch", { taskIds: tasks.slice(0, 2).map(task => task.id) }, "director"));
	assert.ok(Array.isArray(dispatch.prepared));
	for (const [index, call] of dispatch.prepared.entries()) {
		const args = record(call).arguments;
		runtime.pre("create_session", args, "director", `generation-create-${index}`);
		runtime.post("create_session", args, { id: workers[index] }, "director");
		runtime.pre("bash", { command: "sleep 1", shellId: `generation-shell-${index}` }, workers[index], `generation-command-${index}`);
		await runtime.operation("report_result", { taskId: tasks[index].id, summary: "Reported before actual process exit" }, workers[index]);
		await runtime.flushNotifications();
		runtime.context({ goalId: tasks[index].goalId }, "director");
	}
	runtime.toolComplete({ toolCallId: "generation-command-0", success: true, shellExecution: { exitCode: 0 } }, workers[0]);
	await sending;
	runtime.context({ goalId: tasks[0].goalId }, "director");
	runtime.toolComplete({ toolCallId: "generation-command-1", success: true, shellExecution: { exitCode: 0 } }, workers[1]);
	accept({ resultType: "success" });
	await runtime.flushNotifications();
	assert.equal(messages, 4);
	assert.equal(runtime.store().pendingWakes("director")[0].sent, 4);
	assert.equal(runtime.store().pendingWakes("director")[0].consumed, 3);
});

for (const transition of ["directory", "close"]) {
	test(`an in-flight settlement wake settles in its original store across ${transition}`, async t => {
		/** @type {(value:unknown)=>void} */
		let accept = () => {};
		/** @type {()=>void} */
		let entered = () => {};
		const queued = new Promise(resolve => { accept = resolve; });
		const sending = new Promise(resolve => { entered = () => resolve(undefined); });
		let messages = 0;
		const { runtime, task } = await settlementFixture(t, { execute: async () => {
			if (++messages === 1) return { resultType: "success" };
			entered();
			return queued;
		} });
		const databasePath = runtime.store().databasePath;
		runtime.toolComplete({ toolCallId: "settlement-command", success: true, shellExecution: { exitCode: 0 } }, "worker");
		await sending;
		runtime.context({ goalId: task.goalId }, "director");
		runtime.store().recordSignal({ goalId: task.goalId, kind: "observation", summary: "A newer observation arrived", references: [] }, "worker");
		if (transition === "close") runtime.close();
		else {
			const other = mkdtempSync(path.join(os.tmpdir(), "foundry-directory-"));
			execFileSync("git", ["init", "--quiet", other]);
			t.after(() => rmSync(other, { recursive: true, force: true }));
			runtime.setDirectory(other);
			await runtime.operation("start_goal", definition, "director");
			assert.deepEqual(runtime.store().pendingWakes("director"), []);
		}
		accept({ resultType: "success" });
		await runtime.flushNotifications();
		const db = new DatabaseSync(databasePath, { readOnly: true });
		const wake = JSON.parse(text(db.prepare("SELECT document FROM wakes WHERE owner='director'").get()?.document, "wake"));
		db.close();
		assert.equal(wake.sent, 2);
		assert.equal(wake.generation, 3);
		assert.equal(wake.inFlight, undefined);
		assert.equal(messages, 2);
	});
}

/** @param {import("node:test").TestContext} t @param {(message:string)=>void} [log] */
function evaluatedFixture(t, log) {
	let calls = 0;
	const { runtime, directory } = fixture(t, { ...(log ? { log } : {}), execute: async (name, args) => {
		assert.equal(name, "bash");
		runtime.pre(name, args, "director", `artifact-check-${++calls}`);
		const command = spawnSync("/bin/sh", ["-c", text(record(args).command, "command")], { encoding: "utf8" });
		assert.equal(command.status, 0, command.stderr);
		const result = { resultType: "success", textResultForLlm: command.stdout };
		runtime.post(name, args, result, "director");
		return result;
	} });
	return { runtime, directory };
}

const artifactCheck = { ...definition.tasks[0].checks[0], artifactFiles: ["unit.mjs"],
	command: `node --input-type=module -e 'import { value } from "./unit.mjs"; if (value < 2) process.exit(1)'` };

/** @param {import("node:test").TestContext} t */
async function issuedFileCheck(t) {
	const { runtime, directory } = fixture(t);
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 2;\n");
	await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0], checks: [artifactCheck] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const prepared = record(await runtime.operation("prepare_check", { taskId: task.id, checkId: "behavior" }, "director"));
	const args = record(prepared.arguments);
	runtime.pre("bash", args, "director", "issued-file-check");
	const effectId = text(prepared.effectId, "effect");
	const receipt = text(record(runtime.store().getEffect(effectId).request).receipt, "receipt");
	return { runtime, directory, task: runtime.store().getTask(task.id), args, effectId, receipt };
}

test("runner executes an issued command once and duplicate or legacy invocations cannot overwrite its result", async t => {
	const { runtime, task, args, effectId, receipt } = await issuedFileCheck(t);
	assert.ok(Number(args.initial_wait) >= 90);
	const first = spawnSync("/bin/sh", ["-c", text(args.command, "command")], { encoding: "utf8" });
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stdout, /FOUNDRY_CHECK_RESULT:/);
	const captured = readFileSync(receipt, "utf8");
	const duplicate = spawnSync("/bin/sh", ["-c", text(args.command, "command")], { encoding: "utf8" });
	assert.equal(duplicate.status, 1);
	assert.equal(duplicate.stdout, "");
	assert.match(duplicate.stderr, /EEXIST/);
	assert.equal(readFileSync(receipt, "utf8"), captured);
	assert.deepEqual(readdirSync(path.dirname(receipt)), [path.basename(receipt)]);
	runtime.post("bash", args, { resultType: "success", textResultForLlm: first.stdout }, "director");
	assert.equal(runtime.store().getEffect(effectId).state, "settled");
	const attempt = runtime.store().getAttempt(text(task.currentAttemptId, "attempt"));
	const legacyId = "check:legacy";
	const command = text(args.command, "command").replaceAll(effectId, legacyId);
	runtime.store().recordEffect({ id: legacyId, attemptId: attempt.id, kind: "command", state: "issued",
		request: { command, shellId: legacyId, checkId: "behavior", checkVersion: attempt.checks[0].version } }, "director");
	const legacy = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
	assert.equal(legacy.status, 1);
	assert.equal(legacy.stdout, "");
	assert.match(legacy.stderr, /receipt-bound/);
	assert.equal(runtime.store().getEffect(legacyId).state, "issued");
	assert.deepEqual(readdirSync(path.dirname(receipt)), [path.basename(receipt)]);
});

test("legacy flat check receipts are rejected rather than admitted as current runner evidence", async t => {
	const { runtime, task, args, receipt } = await issuedFileCheck(t);
	const executed = spawnSync("/bin/sh", ["-c", text(args.command, "command")], { encoding: "utf8" });
	assert.equal(executed.status, 0, executed.stderr);
	const { state: _state, sha256: _digest, ...flat } = record(JSON.parse(readFileSync(receipt, "utf8")));
	const content = JSON.stringify(flat);
	writeFileSync(receipt, content);
	const encoded = executed.stdout.match(/FOUNDRY_CHECK_RESULT:([a-zA-Z0-9+/=]+)/u)?.[1];
	assert.ok(encoded);
	const observation = record(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
	observation.sha256 = createHash("sha256").update(content).digest("hex");
	const output = `FOUNDRY_CHECK_RESULT:${Buffer.from(JSON.stringify(observation)).toString("base64")}`;
	assert.throws(() => runtime.post("bash", args, { resultType: "success", textResultForLlm: output }, "director"),
		{ code: "unsupported_receipt" });
	assert.equal(runtime.store().evidenceForAttempt(text(runtime.store().getTask(task.id).currentAttemptId, "attempt")).length, 0);
});

test("quoted historical check results cannot block or become evidence for an ordinary metadata command", async t => {
	const { runtime, args, effectId } = await issuedFileCheck(t);
	const command = spawnSync("/bin/sh", ["-c", text(args.command, "assigned command")], { encoding: "utf8" });
	assert.equal(command.status, 0, command.stderr);
	runtime.post("bash", args, { resultType: "success", textResultForLlm: command.stdout }, "director");
	const metadata = { command: "Inspect previous check receipt metadata" };
	const content = JSON.stringify({ nativeResult: command.stdout, copy: command.stdout });
	runtime.pre("bash", metadata, "director", "metadata-after-check");
	assert.doesNotThrow(() => runtime.post("bash", metadata, { resultType: "success", textResultForLlm: content }, "director"));
	runtime.toolComplete({ toolCallId: "metadata-after-check", success: true, shellExecution: { exitCode: 0 }, result: { content } }, "director");
	const ordinary = runtime.store().getEffect("command:metadata-after-check");
	assert.equal(ordinary?.state, "settled");
	assert.equal(record(ordinary?.result).evidence, undefined);
	assert.equal(runtime.store().getEffect(effectId).state, "settled");
});

test("lost tool output recovers the original finished receipt once and can publish without rerunning", async t => {
	const { runtime, task, args, effectId } = await issuedFileCheck(t);
	const command = spawnSync("/bin/sh", ["-c", text(args.command, "command")], { encoding: "utf8" });
	assert.equal(command.status, 0, command.stderr);
	runtime.toolComplete({ toolCallId: "issued-file-check", success: true, result: { content: "" }, shellExecution: { exitCode: 0 } }, "director");
	assert.equal(runtime.store().getEffect(effectId).state, "uncertain");
	const recovered = record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior", publish: "unit" }, "director"));
	assert.equal(recovered.effectId, effectId);
	assert.equal(recovered.promoted, true);
	assert.equal(record(recovered.evidence).source, "runner-receipt");
	assert.equal(runtime.store().snapshot().effects.filter(effect => effect.kind === "command").length, 1);
	assert.equal(runtime.store().evidenceForAttempt(text(recovered.attemptId, "attempt")).length, 1);
	assert.ok(record(runtime.store().getEffect(effectId).result).nativeCompletion);
	runtime.post("bash", args, { resultType: "success", textResultForLlm: command.stdout }, "director");
	const repeated = record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior", publish: "unit" }, "director"));
	assert.equal(record(repeated.publication).state, "already-published");
	assert.equal(runtime.store().snapshot().effects.filter(effect => effect.kind === "command").length, 1);
});

test("a finished receipt cannot be admitted by another worker or an unrelated shell", async t => {
	const { runtime, task, args, effectId } = await issuedFileCheck(t);
	const command = spawnSync("/bin/sh", ["-c", text(args.command, "command")], { encoding: "utf8" });
	assert.equal(command.status, 0, command.stderr);
	const result = { resultType: "success", textResultForLlm: command.stdout };
	assert.throws(() => runtime.post("bash", args, result, "foreign"), /actual worker and assigned shell/);
	assert.throws(() => runtime.post("bash", { ...args, shellId: "foreign-shell" }, result, "director"), /actual worker and assigned shell/);
	await assert.rejects(runtime.operation("get_context", { goalId: task.goalId }, "foreign"), /no assignment/);
	assert.equal(runtime.store().getEffect(effectId).state, "issued");
});

test("context admits finished receipts, keeps started commands unknown and rejects changed receipt contents", async t => {
	const { runtime, task, args, effectId, receipt } = await issuedFileCheck(t);
	mkdirSync(path.dirname(receipt), { recursive: true });
	writeFileSync(receipt, JSON.stringify({ state: "started", effectId }), { flag: "wx" });
	await runtime.operation("get_context", { taskId: task.id }, "director");
	assert.equal(record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior" }, "director")).state, "pending-native-evidence");
	assert.equal(runtime.store().getEffect(effectId).state, "issued");
	rmSync(receipt);
	const command = spawnSync("/bin/sh", ["-c", text(args.command, "command")], { encoding: "utf8" });
	assert.equal(command.status, 0, command.stderr);
	const content = readFileSync(receipt, "utf8");
	const changed = record(/** @type {unknown} */ (JSON.parse(content)));
	changed.exitCode = 99;
	writeFileSync(receipt, JSON.stringify(changed));
	await assert.rejects(runtime.operation("get_context", { taskId: task.id }, "director"), /receipt content changed/);
	assert.equal(runtime.store().getEffect(effectId).state, "issued");
	writeFileSync(receipt, content);
	await runtime.operation("get_context", { taskId: task.id }, "director");
	assert.equal(runtime.store().getEffect(effectId).state, "settled");
	assert.equal(record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior" }, "director")).state, "passed");
	assert.equal(runtime.store().snapshot().effects.filter(effect => effect.kind === "command").length, 1);
});

test("a replaced attempt retains its finished receipt as history and a first-run refusal records no executed work", async t => {
	for (const finishBeforeRevision of [false, true]) {
		const { runtime, task, args, effectId, receipt } = await issuedFileCheck(t);
		if (finishBeforeRevision) assert.equal(spawnSync("/bin/sh", ["-c", text(args.command, "command")]).status, 0);
		await runtime.operation("evolve_task", { taskId: task.id, expectedVersion: 1,
			checks: [artifactCheck, { ...artifactCheck, id: "additional", origin: "derived" }] }, "director");
		if (!finishBeforeRevision) assert.equal(spawnSync("/bin/sh", ["-c", text(args.command, "command")]).status, 0);
		await runtime.operation("get_context", { goalId: task.goalId }, "director");
		const evidence = runtime.store().evidenceForAttempt(text(task.currentAttemptId, "attempt"));
		assert.equal(evidence.length, 1);
		assert.equal(evidence[0].outcome, finishBeforeRevision ? "passed" : "failed");
		assert.equal(runtime.store().getEffect(effectId).state, "settled");
		assert.equal(runtime.store().getTask(task.id).state, "ready");
		assert.deepEqual(runtime.store().getTask(task.id).outputs, []);
		const historical = record(await runtime.operation("run_check", { taskId: task.id, attemptId: task.currentAttemptId,
			checkId: "behavior", publish: "unit", repair: true }, "director"));
		assert.equal(finishBeforeRevision ? record(historical.publication).state : record(historical.continuation).state,
			finishBeforeRevision ? "historical" : "not-repaired");
		assert.equal(runtime.store().getTask(task.id).state, "ready");
		if (!finishBeforeRevision) assert.equal(JSON.parse(readFileSync(receipt, "utf8")).stdout, "");
	}
});

test("opt-in publication waits for complete checks, preserves pinned deliveries and leaves partial work running", async t => {
	const { runtime, directory } = evaluatedFixture(t);
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 2;\n");
	await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0], checks: [artifactCheck, { ...artifactCheck, id: "second" }] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const partial = record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior", publish: "unit" }, "director"));
	assert.deepEqual(record(partial.publication).missing, ["second"]);
	assert.equal(runtime.store().getTask(task.id).state, "running");
	assert.equal(runtime.store().resultsForAttempt(text(task.currentAttemptId ?? runtime.store().getTask(task.id).currentAttemptId, "attempt")).length, 0);
	const final = record(await runtime.operation("run_check", { taskId: task.id, checkId: "second", publish: "unit" }, "director"));
	assert.equal(final.promoted, true);
	const output = runtime.store().getTask(task.id).outputs[0];
	assert.equal(output.version, record(record(final.evidence).candidate).version);
	await runtime.operation("evolve_task", { taskId: task.id, expectedVersion: 1,
		checks: [artifactCheck, { ...artifactCheck, id: "second" }, { ...artifactCheck, id: "third", origin: "derived" }] }, "director");
	assert.deepEqual(runtime.store().outputForInput({ taskId: task.id, output: "unit", version: output.version }), output);
});

for (const reevaluateOther of [false, true]) test(`paused publication ${reevaluateOther ? "uses a fresh receipt-set identity" : "replays the unchanged receipt-set identity"} after restart`, async t => {
	let executions = 0;
	const { runtime, directory } = fixture(t, { ...authorizedFactory, execute: async (name, args) => {
		if (name === "send_session_message") return { resultType: "success", textResultForLlm: "Queued" };
		assert.equal(name, "bash");
		runtime.pre(name, args, "worker-b", `publication-check-${++executions}`);
		const command = spawnSync("/bin/sh", ["-c", text(record(args).command, "command")], { encoding: "utf8" });
		assert.equal(command.status, 0, command.stderr);
		const lost = { resultType: "success", textResultForLlm: "Native output was lost" };
		runtime.post(name, args, lost, "worker-b");
		return lost;
	} });
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 2;\n");
	const source = factorySource(directory, { goal: { ...definition,
		scope: { ...definition.scope, mode: "interactive" },
		tasks: [{ ...definition.tasks[0], id: "complete", checks: [artifactCheck, { ...artifactCheck, id: "second" }] }],
	} });
	await runtime.operation("start_factory", { source }, "director");
	const task = runtime.store().snapshot().tasks[0];
	const batch = record(await runtime.operation("prepare_dispatch", {}, "director"));
	assert.ok(Array.isArray(batch.prepared));
	const call = record(batch.prepared[0]);
	runtime.pre("create_session", call.arguments, "director", "publication-worker");
	runtime.post("create_session", call.arguments, { id: "worker-b" }, "director");
	await runtime.operation("run_check", { taskId: task.id, checkId: "second" }, "worker-b");
	await runtime.operation("run_check", { taskId: task.id, checkId: "second" }, "worker-b");
	await runtime.operation("run_check", { taskId: task.id, checkId: "behavior", publish: "unit" }, "worker-b");
	const db = runtime.store();
	const save = db.recordResult;
	db.recordResult = (...args) => {
		db.pauseFactories("director", "Pause after runtime validation and before canonical promotion", "fixture-factory");
		return save(...args);
	};
	const paused = record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior", publish: "unit" }, "worker-b"));
	db.recordResult = save;
	assert.equal(paused.promoted, false);
	const original = record(paused.result);
	assert.equal(runtime.store().getTask(task.id).state, "running");
	assert.equal(executions, 2);
	await runtime.operation("start_factory", { source }, "director");
	if (reevaluateOther) {
		const prepared = record(await runtime.operation("prepare_check", { taskId: task.id, checkId: "second" }, "worker-b"));
		const args = record(prepared.arguments);
		runtime.pre("bash", args, "worker-b", "reevaluated-other-check");
		const command = spawnSync("/bin/sh", ["-c", text(args.command, "command")], { encoding: "utf8" });
		assert.equal(command.status, 0, command.stderr);
	}
	const retried = record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior", publish: "unit" }, "worker-b"));
	assert.equal(retried.promoted, true);
	assert.equal(retried.effectId, paused.effectId);
	assert.equal(record(retried.result).id === original.id, !reevaluateOther);
	assert.equal(runtime.store().resultsForAttempt(text(call.attemptId, "attempt")).length, reevaluateOther ? 2 : 1);
	assert.equal(executions, 2);
	assert.equal(runtime.store().getTask(task.id).state, "done");
	assert.equal(readFileSync(path.join(runtime.store().getTask(task.id).outputs[0].reference, "unit.mjs"), "utf8"), "export const value = 2;\n");
});

test("mixed-candidate publication preserves the check result without failing or publishing its task", async t => {
	const errors = [];
	const { runtime, directory } = evaluatedFixture(t, message => { errors.push(message); });
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 2;\n");
	await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0], checks: [artifactCheck, { ...artifactCheck, id: "second" }] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	await runtime.operation("run_check", { taskId: task.id, checkId: "behavior", publish: "unit" }, "director");
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 3;\n");
	const mixed = record(await runtime.operation("run_check", { taskId: task.id, checkId: "second", publish: "unit" }, "director"));
	assert.equal(mixed.state, "passed");
	assert.equal(record(mixed.publication).code, "mixed_candidate_checks");
	assert.equal(runtime.store().getTask(task.id).state, "running");
	assert.equal(runtime.store().resultsForAttempt(text(runtime.store().getTask(task.id).currentAttemptId, "attempt")).length, 0);
	assert.equal(errors.length, 1);
});

test("publication without declared artifacts is rejected before executing a native command", async t => {
	let calls = 0;
	const { runtime } = fixture(t, { execute: async () => { calls++; return { resultType: "success" }; } });
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	await assert.rejects(runtime.operation("run_check", { taskId: task.id, checkId: "behavior", publish: "unit" }, "director"), /artifact-bound/);
	assert.equal(calls, 0);
});

for (const transition of ["directory", "close"]) {
	test(`an admitted native evaluator retains its original evidence store across ${transition}`, async t => {
		/** @type {()=>void} */
		let entered = () => {};
		/** @type {()=>void} */
		let continueNative = () => {};
		const issuing = new Promise(resolve => { entered = () => resolve(undefined); });
		const held = new Promise(resolve => { continueNative = () => resolve(undefined); });
		const { runtime, directory } = fixture(t, { execute: async (name, args) => {
			runtime.pre(name, args, "director", "directory-check");
			entered();
			await held;
			const command = spawnSync("/bin/sh", ["-c", text(record(args).command, "command")], { encoding: "utf8" });
			assert.equal(command.status, 0, command.stderr);
			return { resultType: "success", textResultForLlm: command.stdout };
		} });
		writeFileSync(path.join(directory, "unit.mjs"), "export const value = 2;\n");
		await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0], checks: [artifactCheck] }] }, "director");
		const task = runtime.store().snapshot().tasks[0];
		await runtime.operation("start_task", { taskId: task.id }, "director");
		const databasePath = runtime.store().databasePath;
		const checking = runtime.operation("run_check", { taskId: task.id, checkId: "behavior" }, "director");
		await issuing;
		if (transition === "close") runtime.close();
		else {
			const other = mkdtempSync(path.join(os.tmpdir(), "foundry-check-directory-"));
			execFileSync("git", ["init", "--quiet", other]);
			t.after(() => rmSync(other, { recursive: true, force: true }));
			runtime.setDirectory(other);
			await runtime.operation("start_goal", definition, "director");
			assert.equal(runtime.store().snapshot().effects.length, 0);
		}
		continueNative();
		assert.equal(record(await checking).state, "passed");
		const db = new DatabaseSync(databasePath, { readOnly: true });
		assert.equal(db.prepare("SELECT count(*) AS n FROM evidence_admissions").get()?.n, 1);
		assert.equal(db.prepare("SELECT state FROM effects WHERE kind='command'").get()?.state, "settled");
		db.close();
	});
}

test("file checks run on captured code and publication cannot substitute the later working-tree version", async t => {
	const { runtime, directory } = evaluatedFixture(t);
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 2;\n");
	const command = `node --input-type=module -e 'import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(directory, "unit.mjs"))}, "export const value = 99;\\n"); const { value } = await import("./unit.mjs"); if (value !== 2) process.exit(1)'`;
	await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0], checks: [{ ...artifactCheck, command }] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const checked = record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior" }, "director"));
	const candidate = record(record(checked.evidence).candidate);
	assert.equal(checked.state, "passed");
	assert.equal(readFileSync(path.join(directory, "unit.mjs"), "utf8"), "export const value = 99;\n");
	await assert.rejects(runtime.operation("report_result", { taskId: task.id, summary: "Substituted untested version",
		outputs: [{ name: "unit", kind: "code", reference: "unit.mjs", version: "untested" }] }, "director"), /candidate version/);
	await runtime.operation("report_result", { taskId: task.id, summary: "Publish exactly evaluated code",
		outputs: [{ name: "unit", kind: "code", reference: "unit.mjs", version: candidate.version }] }, "director");
	const output = runtime.store().getTask(task.id).outputs[0];
	assert.notEqual(output.reference, path.join(directory, "unit.mjs"));
	assert.equal(readFileSync(output.reference, "utf8"), "export const value = 2;\n");
	assert.equal(readCandidate(output.reference, output.version, runtime.store().databasePath)?.version, candidate.version);
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 2;\n");
	await runtime.operation("evolve_task", { taskId: task.id, expectedVersion: 1, checks: [
		{ ...artifactCheck, command }, { ...artifactCheck, id: "additional", origin: "derived",
			command: `node --input-type=module -e 'import { value } from "./unit.mjs"; if (value !== 2) process.exit(1)'` },
	] }, "director");
	await runtime.operation("start_task", { taskId: task.id }, "director");
	await runtime.operation("run_check", { taskId: task.id, checkId: "behavior" }, "director");
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 2;\n");
	await runtime.operation("run_check", { taskId: task.id, checkId: "additional" }, "director");
	await runtime.operation("report_result", { taskId: task.id, summary: "Reevaluated identical code",
		outputs: [{ name: "unit", kind: "code", reference: "unit.mjs", version: candidate.version }] }, "director");
	assert.deepEqual(runtime.store().getTask(task.id).outputs[0], output);
});

test("canonical publication selects latest admitted candidates and replay never rematerializes them", async t => {
	const { runtime, directory } = evaluatedFixture(t);
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 2;\n");
	await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0], checks: [artifactCheck] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	await runtime.operation("run_check", { taskId: task.id, checkId: "behavior" }, "director");
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 3;\n");
	const candidate = record(record(record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior" }, "director")).evidence).candidate);
	const attemptId = text(runtime.store().getTask(task.id).currentAttemptId, "attempt");
	const observation = { id: "canonical-publication", attemptId, state: /** @type {const} */ ("done"),
		summary: "Publish the latest admitted candidate", evidence: runtime.store().evidenceForAttempt(attemptId).reverse(), findings: [],
		outputs: [{ name: "unit", kind: /** @type {const} */ ("code"), reference: "unit.mjs", version: text(candidate.version, "candidate version") }] };
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 4;\n");
	const later = record(await runtime.operation("prepare_check", { taskId: task.id, checkId: "behavior" }, "director"));
	const args = record(later.arguments);
	runtime.pre("bash", args, "director", "late-candidate");
	const finished = spawnSync("/bin/sh", ["-c", text(args.command, "command")], { encoding: "utf8" });
	assert.equal(finished.status, 0, finished.stderr);
	const published = runtime.store().recordResult(observation, "director");
	assert.equal(published.promoted, true);
	const output = published.result.outputs[0];
	assert.equal(readFileSync(output.reference, "utf8"), "export const value = 3;\n");
	runtime.post("bash", args, { resultType: "success", textResultForLlm: finished.stdout }, "director");
	assert.equal(runtime.store().evidenceForAttempt(attemptId).length, 3);
	rmSync(path.join(text(candidate.reference, "original captured candidate"), "unit.mjs"));
	assert.deepEqual(runtime.store().recordResult(observation, "director"), published);
	assert.equal(readFileSync(output.reference, "utf8"), "export const value = 3;\n");
});

test("damaged historical candidate files do not block a newer genuine failed report", async t => {
	const { runtime, directory } = evaluatedFixture(t);
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 2;\n");
	await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0], checks: [artifactCheck] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const earlier = record(record(record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior" }, "director")).evidence).candidate);
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 1;\n");
	assert.equal(record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior" }, "director")).state, "failed");
	writeFileSync(path.join(text(earlier.reference, "historical candidate"), "unit.mjs"), "damaged old candidate");
	assert.equal(record(await runtime.operation("report_result", { taskId: task.id, state: "failed",
		summary: "Latest assigned evaluation genuinely failed" }, "director")).promoted, true);
	assert.equal(runtime.store().getTask(task.id).state, "failed");
});

test("mixed passing candidate checks require final reevaluation rather than publishing the last passing file", async t => {
	const { runtime, directory } = evaluatedFixture(t);
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 2;\n");
	await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0],
		checks: [artifactCheck, { ...artifactCheck, id: "second" }] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const earlier = record(record(record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior" }, "director")).evidence).candidate);
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 3;\n");
	await runtime.operation("run_check", { taskId: task.id, checkId: "second" }, "director");
	await assert.rejects(runtime.operation("report_result", { taskId: task.id, summary: "Both checks passed" }, "director"), /different candidates/);
	await runtime.operation("run_check", { taskId: task.id, checkId: "behavior" }, "director");
	const attemptId = text(runtime.store().getTask(task.id).currentAttemptId, "attempt");
	assert.throws(() => runtime.store().recordResult({ id: "older-candidate-cannot-override-latest", attemptId, state: "done",
		summary: "Includes every real pass but tries publishing an earlier candidate", findings: [],
		evidence: runtime.store().evidenceForAttempt(attemptId),
		outputs: [{ name: "unit", kind: "code", reference: path.join(text(earlier.reference, "old materialization"), "unit.mjs"),
			version: text(earlier.version, "old version") }] }, "director"), /declared evaluated artifact/);
	assert.equal(record(await runtime.operation("report_result", { taskId: task.id, summary: "One final candidate checked" }, "director")).promoted, true);
});

test("integration evaluates its own final bundle and detects mutation of a published versioned input", async t => {
	const { runtime, directory } = evaluatedFixture(t);
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 2;\n");
	writeFileSync(path.join(directory, "combined.mjs"), `import { pathToFileURL } from "node:url";\nconst [{ output }] = JSON.parse(process.env.FOUNDRY_INPUTS_JSON);\nexport const value = (await import(pathToFileURL(output.reference).href)).value + 1;\n`);
	await runtime.operation("start_goal", { ...definition, tasks: [
		{ ...definition.tasks[0], id: "source-unit", checks: [artifactCheck] },
		{ ...definition.tasks[0], id: "integration", inputs: [{ taskId: "source-unit", output: "unit" }],
			checks: [{ ...artifactCheck, artifactFiles: ["combined.mjs"], command: `node --input-type=module -e 'import { value } from "./combined.mjs"; if (value !== 3) process.exit(1)'` }] },
	] }, "director");
	await runtime.operation("start_task", { taskId: "source-unit" }, "director");
	const checked = record(await runtime.operation("run_check", { taskId: "source-unit", checkId: "behavior" }, "director"));
	const source = record(record(checked.evidence).candidate);
	await runtime.operation("report_result", { taskId: "source-unit", summary: "Delivered source",
		outputs: [{ name: "unit", kind: "code", reference: "unit.mjs", version: source.version }] }, "director");
	await runtime.operation("start_task", { taskId: "integration" }, "director");
	const integrated = record(await runtime.operation("run_check", { taskId: "integration", checkId: "behavior" }, "director"));
	assert.equal(integrated.state, "passed");
	assert.notEqual(record(record(integrated.evidence).candidate).version, source.version);
	writeFileSync(runtime.store().getTask("source-unit").outputs[0].reference, "export const value = 9;\n");
	const mutated = record(await runtime.operation("run_check", { taskId: "integration", checkId: "behavior" }, "director"));
	assert.equal(mutated.state, "failed");
	assert.match(text(record(mutated.evidence).summary, "failure summary"), /Evaluated artifact changed/);
	await assert.rejects(runtime.operation("report_result", { taskId: "integration", summary: "Reusing old pass", state: "done" }, "director"), /incomplete or failed/);
	const blocked = record(await runtime.operation("run_check", { taskId: "integration", checkId: "behavior", repair: true }, "director"));
	assert.equal(blocked.state, "blocked");
	assert.equal(record(blocked.result).state, "blocked");
	assert.equal(runtime.store().getTask("integration").state, "blocked");
	assert.equal(runtime.store().snapshot().attempts.length, 2);
});

test("artifact failures remain checked failures for same-worker repair, while escaped candidates are never captured", async t => {
	const { runtime, directory } = evaluatedFixture(t);
	await assert.rejects(runtime.operation("start_goal", { ...definition, scope: { ...definition.scope, paths: ["allowed"] },
		tasks: [{ ...definition.tasks[0], checks: [artifactCheck] }] }, "director"), /inside this task's paths/);
	assert.equal(runtime.store().snapshot().goals.length, 0);
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 1;\n");
	await runtime.operation("start_goal", { ...definition, tasks: [{ ...definition.tasks[0], checks: [artifactCheck] }] }, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	const failed = record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior", repair: true }, "director"));
	assert.equal(record(failed.result).state, "failed");
	writeFileSync(path.join(directory, "unit.mjs"), "export const value = 2;\n");
	assert.equal(record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior" }, "director")).state, "passed");
	writeFileSync(path.join(directory, "outside.mjs"), "export const value = 3;\n");
	rmSync(path.join(directory, "unit.mjs"));
	symlinkSync(path.join(directory, "outside.mjs"), path.join(directory, "unit.mjs"));
	const escaped = record(await runtime.operation("run_check", { taskId: task.id, checkId: "behavior" }, "director"));
	assert.equal(escaped.state, "failed");
	assert.match(text(record(escaped.evidence).summary, "scope failure"), /contained regular file/);
});

test("partial dispatch returns the reserved call when another task reaches capacity", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", { ...definition, limits: { workers: 1 }, tasks: [definition.tasks[0], definition.tasks[0]] }, "director");
	const prepared = await runtime.operation("prepare_dispatch", {}, "director");
	assert.ok(prepared && typeof prepared === "object" && "prepared" in prepared && prepared.prepared && "blocked" in prepared && prepared.blocked);
	assert.equal(prepared.prepared.length, 1);
	assert.equal(prepared.blocked.length, 1);
	assert.equal(runtime.store().snapshot().attempts.length, 1);
});

test("native process completion settles an ordinary command without inventing passed check evidence", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	await runtime.operation("start_task", { taskId: task.id }, "director");
	runtime.pre("bash", { command: "node -e 'process.exit(1)'" }, "director", "ordinary-command");
	assert.equal(runtime.store().snapshot().effects[0].state, "issued");
	runtime.toolComplete({
		toolCallId: "ordinary-command", success: true, shellExecution: { exitCode: 1 },
		result: { content: "<shellId: test-shell completed with exit code 1>" },
	}, "director");
	assert.equal(runtime.store().snapshot().effects[0].state, "settled");
	const result = await runtime.operation("report_result", { taskId: task.id, state: "failed", summary: "The ordinary command failed; the assigned check did not run" }, "director");
	assert.ok(result && typeof result === "object" && "promoted" in result && result.promoted);
	const attemptId = runtime.store().getTask(task.id).currentAttemptId;
	assert.ok(attemptId);
	assert.equal(runtime.store().getAttempt(attemptId).slot, false);
	await runtime.operation("retry_task", { taskId: task.id, attemptId }, "director");
	await runtime.operation("start_task", { taskId: task.id }, "director");
	assert.notEqual(runtime.store().getTask(task.id).currentAttemptId, attemptId);
});

test("a native creation cannot be issued twice with different call identities", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", definition, "director");
	const task = runtime.store().snapshot().tasks[0];
	const calls = await runtime.operation("prepare_dispatch", { taskIds: [task.id] }, "director");
	assert.ok(calls && typeof calls === "object" && "prepared" in calls);
	assert.ok(calls.prepared);
	runtime.pre("create_session", calls.prepared[0].arguments, "director", "first-call");
	assert.throws(() => runtime.pre("create_session", calls.prepared[0].arguments, "director", "second-call"), /already issued/);
});

test("board escapes stored content and protects its scoped loopback endpoint", async t => {
	const { runtime } = fixture(t);
	await runtime.operation("start_goal", { ...definition, title: "<script>alert(1)</script>" }, "director");
	const snapshot = runtime.store().snapshot();
	assert.match(renderBoard(snapshot), /&lt;script&gt;/);
	assert.doesNotMatch(renderBoard(snapshot), /<script>alert/);
	const board = await startBoard({ snapshot: () => snapshot, log: message => { throw new Error(message); } });
	t.after(() => board.close());
	assert.equal((await fetch(board.url)).status, 200);
	assert.equal((await fetch(new URL("/not-the-token", board.url))).status, 404);
});
