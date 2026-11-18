import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { openWorkStore } from "./store.mjs";
import { createRuntime } from "./runtime.mjs";
import { advanceRetirements, archiveProtocol } from "./retirement.mjs";
import { inspectRetirementTree } from "./preservation.mjs";
import { record } from "./values.mjs";

/** @typedef {Parameters<typeof advanceRetirements>[1]} Host */
/** @typedef {ReturnType<typeof openWorkStore>} Store */
/** @param {string} cwd @param {...string} args */
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false",
	"-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8" }).trimEnd();
/** @param {Store} db @param {string} goalId @param {string} taskId @param {string} creator @param {string} child */
function worker(db, goalId, taskId, creator, child) {
	const task = db.createTask({ goalId, id: taskId, title: taskId, assignment: taskId, workType: "code" }, creator);
	const attempt = db.prepareAttempt(task.id, creator);
	db.issueAttempt(attempt.id, creator, `create:${attempt.id}`, { workspace_type: "worktree", coordinate_with_creator: true, name: "fixture" });
	return db.bindAttempt(attempt.id, child, creator, { id: child });
}
/** @param {import("node:test").TestContext} t */
function fixture(t) {
	const root = path.resolve(`.retirement-fixture-${randomUUID()}`);
	mkdirSync(root);
	const main = path.join(root, "main"), child = path.join(root, "child");
	git(root, "init", "-q", "-b", "main", main);
	writeFileSync(path.join(main, "original"), "preserve this\n");
	mkdirSync(path.join(main, "nested"));
	writeFileSync(path.join(main, "nested", "tracked"), "tracked\n");
	writeFileSync(path.join(main, ".gitignore"), "*.valuable\n");
	git(main, "add", "."); git(main, "commit", "-qm", "disposable fixture");
	git(main, "worktree", "add", "-qb", "worker", child);
	const db = openWorkStore(main);
	t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
	const scope = /** @type {const} */ ({ mode: "autopilot", delegation: true });
	db.createGoal({ id: "g", projectId: "p", title: "job", scope: { ...scope, restrictions: [], workTypes: ["code"], paths: ["."] }, limits: {} }, "owner");
	const attempt = worker(db, "g", "task", "owner", "child");
	const complete = () => db.recordResult({ id: "done", attemptId: attempt.id, state: "done", outputs: [], evidence: [], findings: [], summary: "finished" }, "child");
	const guard = { protocol: archiveProtocol, token: "native-token", noOpenPr: true, noAgentMerge: true, noAutomation: true, noUserInput: true,
		noUserRetention: true, noUserDrafts: true, noDescendants: true, noRunningWork: true, noPendingMessages: true, exclusiveWorkspace: true, archiveAllowed: true };
	const detail = { id: "child", name: "fixture", creator_session_id: "owner", coordinating_creator_session_id: "owner", project_id: "p", path: child,
		awaiting_user_input: false, was_interrupted: false, activity: { status: "idle" }, archive_guard: guard };
	const run = (/** @type {Host} */ host) => advanceRetirements(db, { readSession: async () => detail,
		readCommand: async () => { throw Error("history missing"); }, ...host }, "owner", "g", () => true);
	return { root, main, child, db, attempt, complete, guard, detail, run };
}

test("whole-worktree inspection retains changed, staged, skipped, ignored, untracked and unlanded work without writing refs", t => {
	const { child, main, db } = fixture(t);
	const inspect = () => inspectRetirementTree(child, db.databasePath);
	const file = path.join(child, "original");
	assert.ok(inspect().proof);
	assert.equal(inspectRetirementTree(main, db.databasePath).reason, "not-an-isolated-linked-worktree");
	writeFileSync(file, "private\n");
	assert.equal(inspect().reason, "tracked-changes");
	git(child, "update-index", "--assume-unchanged", "original");
	assert.equal(inspect().reason, "hidden-or-nested-index-work");
	git(child, "update-index", "--no-assume-unchanged", "original");
	git(child, "add", "original");
	assert.equal(inspect().reason, "tracked-index-changes");
	git(child, "commit", "-qm", "unique disposable tip");
	assert.equal(inspect().reason, "unique-or-unproven-tip");
	writeFileSync(path.join(child, "private.valuable"), "never delete");
	assert.equal(inspect().reason, "ignored-files");
	writeFileSync(path.join(child, "a-note"), "keep");
	assert.equal(inspect().reason, "untracked-files");
	assert.notEqual(git(main, "rev-parse", "HEAD"), git(child, "rev-parse", "HEAD"));
});

test("cancellation enqueues only the creator; legacy id-only archival and unproven native safeguards never issue", async t => {
	const { db, complete, detail, run, child } = fixture(t);
	complete();
	assert.deepEqual(db.retirements("owner"), []); // publication is not landing
	db.cancelTask("task", "owner");
	db.cancelTask("task", "owner");
	assert.equal(db.retirements("owner").length, 1);
	assert.deepEqual(db.retirements("child"), []);
	const execute = async () => assert.fail("must not issue");
	for (const [changes, reason] of /** @type {Array<[Record<string,unknown>,string]>} */ ([
		[{ archive_guard: undefined }, "host-lacks-atomic-archive-guard"],
		[{ creator_session_id: "other" }, "native-owner-or-project-unverified"],
		[{ activity: { status: "unknown" } }, "session-not-confirmed-idle"],
		[{ pr_number: 1 }, "linked-pull-request"],
		[{ awaiting_user_input: true }, "user-input-or-approval-unresolved"],
		...["noOpenPr", "noAgentMerge", "noAutomation", "noUserRetention", "noUserDrafts", "noDescendants", "exclusiveWorkspace"]
			.map(field => [{ archive_guard: { ...detail.archive_guard, [field]: undefined } }, `unproven-native-safeguard:${field}`]),
	])) {
		const [result] = await run({ execute, readSession: async () => ({ ...detail, ...changes }) });
		assert.equal(result.reason, reason);
	}
	assert.equal(existsSync(child), true);
});

test("live effects and claims retain the native child across cancellation", async t => {
	const { db, attempt, run } = fixture(t);
	const claim = db.claim({ attemptId: attempt.id, surface: "shared", resource: "file" }, "child");
	db.recordEffect({ id: "cmd", attemptId: attempt.id, kind: "command", state: "issued", request: {} }, "child");
	db.cancelTask("task", "owner");
	assert.match(String((await run({}))[0].reason), /live|claim|pending/u);
	const effect = db.getEffect("cmd");
	assert.equal(effect.state, "issued");
	assert.throws(() => db.releaseClaim(claim.id, "child"), { code: "effects_outstanding" });
	assert.equal(db.snapshot().claims.length, 1);
	assert.throws(() => db.reserveArchive(`archive:${attempt.id}`, "child", { reason: "override" }), { code: "foreign_archive" });
});

test("all creator/child effects are rechecked after inspection and immediately before native issuance", async t => {
	const { db, complete, detail, run } = fixture(t);
	complete(); db.cancelTask("task", "owner");
	const [result] = await run({ execute: async () => assert.fail("new owner obligation blocks issuance"),
		readSession: async () => {
			db.createTask({ id: "second", goalId: "g", title: "second", assignment: "more work", workType: "code" }, "owner");
			db.reassignTask("second", "child", "owner");
			return detail;
		} });
	assert.equal(result.reason, "live-task-or-repair");
});

test("creator working inside the target worktree, including through an alias, retains it before issuance", async t => {
	const { child, complete, db, detail, root } = fixture(t);
	complete(); db.cancelTask("task", "owner");
	const nested = path.join(child, "nested"), alias = path.join(root, "alias");
	symlinkSync(nested, alias, "dir");
	for (const directory of [child, nested, alias]) {
		const creator = openWorkStore(directory);
		try {
			const [retirement] = await advanceRetirements(creator, { readSession: async () => detail,
				readCommand: async () => assert.fail("not issued"), execute: async () => assert.fail("do not archive the creator's checkout") },
			"owner", "g", () => true);
			assert.equal(retirement.reason, "creator-shares-workspace");
			assert.equal(retirement.state, "prepared");
		} finally { creator.close(); }
	}
});

test("owner advancement processes cancellation through the canonical store without archiving a spawned descendant", async t => {
	const { db, main, complete, detail } = fixture(t);
	const descendant = db.createTask({ id: "descendant", goalId: "g", parentId: "task", title: "descendant", assignment: "nested work", workType: "code" }, "child");
	const attempt = db.prepareAttempt(descendant.id, "child");
	db.issueAttempt(attempt.id, "child", `create:${attempt.id}`, {workspace_type: "worktree", coordinate_with_creator: true, name: "nested"});
	db.bindAttempt(attempt.id, "grandchild", "child", { id: "grandchild" });
	complete(); db.cancelTask("task", "owner");
	assert.equal(db.retirements("child")[0].owner, "child");
	for (const wake of db.pendingWakes("child")) db.consumeWake(wake.id, wake.generation, "child");
	const runtime = createRuntime({ directory: main, log: () => {}, readSession: async () => detail,
		execute: async name => {
			assert.equal(name, "send_session_message");
			return { resultType: "success" };
		} });
	t.after(() => runtime.close());
	const results = record(await runtime.operation("advance", { goalId: "g" }, "owner")).retirements;
	assert.ok(Array.isArray(results));
	assert.equal(results.length, 1);
	assert.equal(results[0].reason, "unretired-descendant");
	assert.equal(record(db.retirements("owner")[0].result).reason, "unretired-descendant");
});

test("owner archive survives transport loss and restart; missing, foreign, or mismatched history never licenses retry", async t => {
	const { db, complete, main, run, child } = fixture(t);
	complete(); db.cancelTask("task", "owner");
	let issued = 0;
	const [[result]] = await Promise.all([0, 1].map(() => run({ execute: async (name, args, callId) => {
		assert.equal(name, "archive_session_if_safe");
		assert.equal(record(record(args).guard).operationId, callId);
		issued++;
		throw Error("lost after issuance");
	} })));
	assert.equal(issued, 1);
	assert.equal(result.state, "uncertain");
	const resumed = openWorkStore(main);
	t.after(() => resumed.close());
	const original = db.retirements("owner")[0];
	const request = record(original.request);
	const receipt = { protocol: archiveProtocol, operationId: request.callId, owner: "owner", sessionId: "child", receiptId: "native-1", outcome: "archived" };
	const history = { start: { type: "tool.execution_start", data: { toolCallId: request.callId, toolName: "archive_session_if_safe", arguments: request.arguments } },
		completion: { type: "tool.execution_complete", data: { toolCallId: request.callId, success: true, result: { content: JSON.stringify({ archive_receipt: receipt }) } } } };
	const execute = async () => assert.fail("do not replay");
	let response = await advanceRetirements(resumed, { execute, readCommand: async () => ({ ...history, start: { ...history.start, agentId: "foreign" } }) },
		"owner", undefined, () => true);
	assert.equal(response[0].state, "uncertain");
	response = await advanceRetirements(resumed, { execute, readCommand: async () => history }, "owner", undefined, () => true);
	assert.equal(response[0].receiptId, "native-1");
	assert.equal(response[0].disposition, "archived");
	db.createTask({ id: "later", goalId: "g", title: "later", assignment: "new work", workType: "code" }, "owner");
	assert.throws(() => db.reassignTask("later", "child", "owner"), { code: "workspace_retired" });
	assert.equal(existsSync(child), true); // no native or Git removal in tests
});

test("reconciliation of an explicitly unapplied guard conflict requires a new token before one fresh issuance", async t => {
	const { db, complete, run, detail } = fixture(t);
	complete(); db.cancelTask("task", "owner");
	await run({ execute: async () => ({ resultType: "failure" }) });
	const request = record(db.retirements("owner")[0].request);
	const receipt = { protocol: archiveProtocol, operationId: request.callId, sessionId: "child", owner: "owner", receiptId: "not-applied",
		outcome: "not-applied", reason: "guard-expired" };
	const noIssue = async () => assert.fail("no retry on old guard");
	await run({ execute: noIssue, readCommand: async () => ({
		start: { type: "tool.execution_start", data: { toolCallId: request.callId, toolName: "archive_session_if_safe", arguments: request.arguments } },
		completion: { type: "tool.execution_complete", data: { toolCallId: request.callId, success: true, result: { structuredContent: { archive_receipt: receipt } } } },
	}) });
	assert.equal((await run({ execute: noIssue }))[1].reason, "fresh-native-archive-guard-required");
	detail.archive_guard.token = "fresh";
	const results = await run({ execute: async (_name, _args, id) => {
		assert.notEqual(id, request.callId);
		return { resultType: "success", structuredContent: { archive_receipt: { ...receipt, outcome: "archived", operationId: id, receiptId: "actual" } } };
	} });
	assert.deepEqual(results.map(r => [r.disposition, r.receiptId]), [["retained", "not-applied"], ["archived", "actual"]]);
});
