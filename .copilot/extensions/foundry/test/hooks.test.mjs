import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildFoundryHooks } from "../hooks.mjs";
import { inspectWriteBoundary } from "../hooks/paths.mjs";
import { classifyShellCommand } from "../hooks/shell.mjs";
import { must } from "./assertions.mjs";

test("guardrail classifiers target only broad destructive behavior", async () => {
	assert.equal(
		classifyShellCommand("git reset --hard HEAD", "/repo")?.decision,
		"deny",
	);
	assert.equal(
		classifyShellCommand("git -C /repo reset --hard HEAD", "/repo")?.decision,
		"deny",
	);
	assert.equal(
		classifyShellCommand("git clean -d -f", "/repo")?.decision,
		"deny",
	);
	assert.equal(
		classifyShellCommand("git clean --force -d", "/repo")?.decision,
		"deny",
	);
	assert.equal(
		classifyShellCommand("git --no-pager reset --hard HEAD", "/repo")?.decision,
		"deny",
	);
	assert.equal(
		classifyShellCommand("git status && git clean -fd", "/repo")?.decision,
		"deny",
	);
	assert.equal(
		classifyShellCommand("git -p reset --hard HEAD", "/repo")?.decision,
		"deny",
	);
	assert.equal(
		classifyShellCommand("(git reset --hard HEAD)", "/repo")?.decision,
		"deny",
	);
	assert.equal(
		classifyShellCommand("git --no-advice reset --hard HEAD", "/repo")?.decision,
		"deny",
	);
	assert.equal(
		classifyShellCommand("git --exec-path=/tmp reset --hard HEAD", "/repo")?.decision,
		"deny",
	);
	assert.equal(
		classifyShellCommand('rm -r -f "$HOME"', "/repo")?.decision,
		"deny",
	);
	assert.equal(
		classifyShellCommand("echo 'git clean -fd'", "/repo"),
		null,
	);
	assert.equal(
		classifyShellCommand("rm -rf /", "/repo")?.decision,
		"deny",
	);
	assert.equal(
		classifyShellCommand("rm -rf build-cache", "/repo")?.decision,
		"ask",
	);
	assert.equal(
		classifyShellCommand('rm -rf "$(pwd)"', "/repo")?.decision,
		"deny",
	);
	assert.equal(
		classifyShellCommand("rm -rf `pwd`", "/repo")?.decision,
		"deny",
	);
	assert.equal(
		classifyShellCommand('rm -rf "${BUILD_DIR}"', "/repo")?.decision,
		"ask",
	);
	assert.equal(classifyShellCommand("npm test", "/repo"), null);
	assert.equal(
		(await inspectWriteBoundary("edit", { path: "/outside/file" }, "/repo"))?.decision,
		"deny",
	);
	assert.equal(
		await inspectWriteBoundary("edit", { path: "/repo/file" }, "/repo"),
		null,
	);
	assert.equal(
		(await inspectWriteBoundary(
			"edit",
			{ path: "/srv/REPO/file" },
			"/srv/repo",
		))?.decision,
		"deny",
	);
	assert.equal(
		await inspectWriteBoundary(
			"edit",
			{ path: "C:\\REPO\\file" },
			"C:\\repo",
		),
		null,
	);
	assert.equal(
		(await inspectWriteBoundary("edit", { path: "../outside/file" }, "/repo"))?.decision,
		"deny",
	);
	assert.equal(
		(await inspectWriteBoundary(
			"apply_patch",
			"*** Update File: src/a.mjs\n*** Move to: /outside/a.mjs\n",
			"/repo",
		))?.decision,
		"deny",
	);
});

/** @param {import("node:test").TestContext} t */
async function helperFixture(t) {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "foundry-hooks-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repository = path.join(root, "repository");
	const workspacePath = path.join(root, "owner");
	const helper = path.join(workspacePath, "extensions", "foundry-exact-relay");
	const foreign = path.join(root, "foreign", "extensions", "foundry-exact-relay");
	for (const directory of [repository, helper, foreign]) await mkdir(directory, { recursive: true });
	const entry = path.join(helper, "extension.mjs");
	await writeFile(entry, "// helper fixture\n");
	await writeFile(path.join(foreign, "extension.mjs"), "// foreign fixture\n");
	/** @type {Awaited<ReturnType<import("../hooks/paths.mjs").HelperSession["rpc"]["extensions"]["list"]>>} */
	const registry = { extensions: [{
		id: "session:foundry-exact-relay",
		name: "foundry-exact-relay",
		source: "session",
		status: "running",
	}] };
	let registryReads = 0;
	const session = {
		sessionId: "owner-session",
		workspacePath,
		rpc: { extensions: { list: async () => { registryReads++; return registry; } } },
	};
	const operations = {
		getActive: async () => null,
		getActivation: async () => ({ planId: "active-plan" }),
	};
	const hooks = buildFoundryHooks({ operations, getSession: () => session });
	const identity = { sessionId: session.sessionId };
	/** @param {string} toolName @param {unknown} toolArgs */
	const input = (toolName, toolArgs) => ({ ...identity, toolName, toolArgs, workingDirectory: repository });
	/** @param {string} toolName @param {unknown} toolArgs */
	const call = (toolName, toolArgs) => hooks.onPreToolUse(input(toolName, toolArgs), identity);
	return { root, repository, helper, foreign, entry, session, registry, operations, hooks, identity, input, call, registryReads: () => registryReads };
}

test("registered owner helper writes retain native permission checks and repository behavior", async (t) => {
	const fixture = await helperFixture(t);
	const { repository, helper, entry, registry, call } = fixture;
	assert.deepEqual(await call("edit", { path: entry }), {});
	assert.deepEqual(await call("create", { path: path.join(helper, "new", "transport.mjs") }), {});
	assert.deepEqual(await call("write", { path: entry }), {});
	assert.deepEqual(await call("apply_patch", `*** Update File: ${entry}\n*** Add File: ${path.join(repository, "test.mjs")}\n`), {});
	assert.equal(fixture.registryReads(), 4);

	registry.extensions = [];
	assert.deepEqual(await call("edit", { path: path.join(repository, "file.mjs") }), {});
	assert.deepEqual(await call("run_dynamic_workflow", { name: "plan", args: {} }), {});
	for (const name of ["foundry_dispatch_ready", "foundry_reconcile_parallel", "foundry_materialize_inputs", "foundry_assess_package"]) {
		assert.deepEqual(await call(name, { planId: "active-plan" }), {}, "Parallel tools retain native permission checks");
	}
	assert.equal(fixture.registryReads(), 4);
});

test("helper exception rejects foreign, unregistered, traversing and mixed write targets", async (t) => {
	const { repository, helper, foreign, entry, session, call } = await helperFixture(t);
	for (const candidate of [
		path.join(foreign, "extension.mjs"),
		path.join(session.workspacePath, "extensions", "unregistered", "extension.mjs"),
		path.join(session.workspacePath, "files", "payload.json"),
		path.join(`${helper}-other`, "extension.mjs"),
		`${helper}/../foundry-exact-relay/extension.mjs`,
		path.relative(repository, entry),
		helper,
	]) {
		assert.equal((await call("edit", {
			path: candidate,
			workspacePath: session.workspacePath,
			sessionId: session.sessionId,
			helperRoot: path.dirname(candidate),
		})).permissionDecision, "deny", candidate);
	}
	for (const patch of [
		`*** Update File: ${entry}\n*** Add File: ${path.join(foreign, "new.mjs")}\n`,
		`*** Update File: ${entry}\n*** Move to: ${path.join(foreign, "moved.mjs")}\n`,
		`*** Update File: ${path.join(foreign, "extension.mjs")}\n*** Move to: ${entry}\n`,
		`*** Add File: ${path.join(repository, "file.mjs")}\n*** Delete File: ${path.join(foreign, "extension.mjs")}\n`,
	]) {
		assert.equal((await call("apply_patch", patch)).permissionDecision, "deny");
	}
	assert.equal((await call("edit", { path: entry, destination: path.join(foreign, "file.mjs") })).permissionDecision, "deny");
});

test("helper exception requires matching native identities and trusted workspace context", async (t) => {
	const { entry, session, operations, hooks, identity, input } = await helperFixture(t);
	const write = input("edit", { path: entry });
	assert.equal((await hooks.onPreToolUse(write)).permissionDecision, "deny");
	assert.equal((await hooks.onPreToolUse(write, { sessionId: "foreign-session" })).permissionDecision, "deny");
	assert.equal((await hooks.onPreToolUse({ ...write, sessionId: "foreign-session" }, identity)).permissionDecision, "deny");
	assert.equal((await hooks.onPreToolUse({ ...write, sessionId: undefined }, identity)).permissionDecision, "deny");
	assert.equal((await hooks.onPreToolUse({ ...write, workingDirectory: undefined }, identity)).permissionDecision, "deny");
	for (const getSession of [
		undefined,
		() => null,
		() => ({ ...session, sessionId: "" }),
		() => ({ ...session, workspacePath: undefined }),
		() => ({ ...session, workspacePath: "relative-session" }),
	]) {
		const untrusted = buildFoundryHooks({ operations, getSession });
		assert.equal((await untrusted.onPreToolUse(write, identity)).permissionDecision, "deny");
	}
});

test("helper exception rechecks runtime registration and fails closed on registry errors", async (t) => {
	const { entry, registry, session, call } = await helperFixture(t);
	const registered = must(registry.extensions[0]);
	for (const extensions of [
		[],
		[{ ...registered, source: /** @type {const} */ ("user") }],
		[{ ...registered, source: /** @type {const} */ ("project") }],
		[{ ...registered, source: /** @type {const} */ ("plugin") }],
		[{ ...registered, name: "different-helper" }],
		[{ ...registered, id: "" }],
		[{ ...registered, status: /** @type {const} */ ("disabled") }],
		[{ ...registered, status: /** @type {const} */ ("failed") }],
		[{ ...registered, status: /** @type {const} */ ("starting") }],
		[registered, registered],
	]) {
		registry.extensions = extensions;
		assert.equal((await call("edit", { path: entry })).permissionDecision, "deny");
	}
	registry.extensions = [registered];
	assert.deepEqual(await call("edit", { path: entry }), {});
	registry.extensions = [];
	assert.equal((await call("edit", { path: entry })).permissionDecision, "deny");

	session.rpc.extensions.list = async () => { throw new Error("extensions.list unavailable"); };
	const denied = await call("edit", { path: entry });
	assert.equal(denied.permissionDecision, "deny");
	assert.match(must(denied.permissionDecisionReason), /extensions\.list unavailable/);
});

test("helper exception rejects linked files, ancestors and registered roots", async (t) => {
	const { root, helper, foreign, entry, session, call } = await helperFixture(t);
	const foreignEntry = path.join(foreign, "extension.mjs");
	const linkedFile = path.join(helper, "linked.mjs");
	const linkedDirectory = path.join(helper, "linked");
	const hardlink = path.join(helper, "hardlink.mjs");
	await symlink(foreignEntry, linkedFile, "file");
	await symlink(foreign, linkedDirectory, "dir");
	await link(foreignEntry, hardlink);
	for (const candidate of [linkedFile, path.join(linkedDirectory, "new.mjs"), hardlink]) {
		assert.equal((await call("edit", { path: candidate })).permissionDecision, "deny");
	}
	assert.equal((await call("apply_patch", `*** Update File: ${entry}\n*** Add File: ${path.join(linkedDirectory, "new.mjs")}\n`)).permissionDecision, "deny");

	const missingHelper = path.join(root, "retained-helper");
	await rename(helper, missingHelper);
	assert.equal((await call("create", { path: entry })).permissionDecision, "deny");
	await symlink(foreign, helper, "dir");
	assert.equal((await call("edit", { path: entry })).permissionDecision, "deny");

	const linkedWorkspace = path.join(root, "linked-owner");
	await symlink(session.workspacePath, linkedWorkspace, "dir");
	session.workspacePath = linkedWorkspace;
	assert.equal((await call("edit", { path: path.join(linkedWorkspace, "extensions", "foundry-exact-relay", "extension.mjs") })).permissionDecision, "deny");
});

test("hooks are inert without an explicitly active plan", async () => {
	let activeReads = 0;
	const hooks = buildFoundryHooks({
		operations: {
			getActive: async () => {
				activeReads++;
				return null;
			},
			getActivation: async () => null,
		},
	});
	assert.deepEqual(await hooks.onSessionStart({}), {});
	assert.deepEqual(await hooks.onPreToolUse({
		toolName: "bash",
		toolArgs: { command: "git reset --hard" },
		workingDirectory: "/repo",
	}), {});
	assert.deepEqual(await hooks.onPostToolUse({ toolName: "bash" }), {});
	assert.deepEqual(await hooks.onPostToolUseFailure({ toolName: "view" }), {});
	assert.equal(activeReads, 1);
});

test("active hooks inject coordinator context and revision-conflict guidance", async () => {
	const hooks = buildFoundryHooks({
		operations: {
			getActivation: async () => ({ planId: "active-plan" }),
			getActive: async () => ({
				plan: {
					id: "active-plan",
					revision: 4,
					status: "running",
				},
			}),
		},
	});
	const start = await hooks.onSessionStart({});
	assert.match(must(start.additionalContext), /Foundry plan active-plan/);
	assert.match(must(start.additionalContext), /Reserve before create_session/);
	assert.match(must(start.additionalContext), /Cancellation is two-phase/);

	const denied = await hooks.onPreToolUse({
		toolName: "bash",
		toolArgs: { command: "git clean -fdx" },
		workingDirectory: "/repo",
	});
	assert.equal(denied.permissionDecision, "deny");

	const mutation = await hooks.onPreToolUse({
		toolName: "foundry_complete_task",
		toolArgs: {},
		workingDirectory: "/repo",
	});
	assert.equal(mutation.permissionDecision, undefined);
	const verificationReservation = await hooks.onPreToolUse({
		toolName: "foundry_prepare_verification",
		toolArgs: {},
		workingDirectory: "/repo",
	});
	assert.equal(verificationReservation.permissionDecision, undefined);

	const read = await hooks.onPreToolUse({
		toolName: "foundry_get_status",
		toolArgs: {},
		workingDirectory: "/repo",
	});
	assert.equal(read.permissionDecision, "allow");

	const failure = await hooks.onPostToolUseFailure({
		toolName: "foundry_complete_task",
	});
	assert.match(must(failure.additionalContext), /Re-read the current plan revision/);
});

test("successful hooks stay quiet except for activation and deactivation", async () => {
	/** @type {{plan: {id: string, revision: number, status: string}} | null} */
	let current = { plan: { id: "active-plan", revision: 4, status: "running" } };
	const hooks = buildFoundryHooks({
		operations: { getActive: async () => current, getActivation: async () => current ? { planId: current.plan.id } : null },
	});
	for (const toolName of ["foundry_get_status", "foundry_complete_task", "bash"]) {
		assert.deepEqual(await hooks.onPostToolUse({ toolName }), {});
	}
	const activated = await hooks.onPostToolUse({ toolName: "foundry_activate_plan" });
	assert.match(must(activated.additionalContext), /Foundry plan active-plan/);
	assert.match(must(activated.additionalContext), /Reserve before create_session/);

	current = null;
	const deactivated = await hooks.onPostToolUse({ toolName: "foundry_deactivate_plan" });
	assert.match(must(deactivated.additionalContext), /guardrails are now deactivated/);
	assert.deepEqual(await hooks.onPostToolUse({ toolName: "foundry_get_status" }), {});
	assert.deepEqual(await hooks.onPostToolUseFailure({ toolName: "foundry_complete_task" }), {});
});

test("unreadable activation retains repair guidance and confirmation", async () => {
	const hooks = buildFoundryHooks({
		operations: {
			getActive: async () => {
				throw Object.assign(new Error("Unreadable marker"), { code: "invalid_activation" });
			},
			getActivation: async () => {
				throw Object.assign(new Error("Unreadable marker"), { code: "invalid_activation" });
			},
		},
	});
	const start = await hooks.onSessionStart({});
	assert.match(must(start.additionalContext), /invalid_activation.*repaired or deactivated/);
	const permission = await hooks.onPreToolUse({ toolName: "view" });
	assert.equal(permission.permissionDecision, "ask");
	assert.match(must(permission.permissionDecisionReason), /invalid_activation/);
	const success = await hooks.onPostToolUse({ toolName: "foundry_activate_plan" });
	assert.match(must(success.additionalContext), /Repair or deactivate/);
	const failure = await hooks.onPostToolUseFailure({ toolName: "foundry_complete_task" });
	assert.match(must(failure.additionalContext), /Do not retry plan mutations until it is repaired/);
	assert.deepEqual(await hooks.onPostToolUse({ toolName: "bash" }), {});
	assert.deepEqual(await hooks.onPostToolUseFailure({ toolName: "view" }), {});
});
