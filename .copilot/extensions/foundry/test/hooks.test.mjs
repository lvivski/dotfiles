import assert from "node:assert/strict";
import test from "node:test";

import { buildFoundryHooks } from "../hooks.mjs";
import { inspectWriteBoundary } from "../hooks/paths.mjs";
import { classifyShellCommand } from "../hooks/shell.mjs";
import { must } from "./assertions.mjs";

test("guardrail classifiers target only broad destructive behavior", () => {
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
		inspectWriteBoundary("edit", { path: "/outside/file" }, "/repo")?.decision,
		"deny",
	);
	assert.equal(
		inspectWriteBoundary("edit", { path: "/repo/file" }, "/repo"),
		null,
	);
	assert.equal(
		inspectWriteBoundary(
			"edit",
			{ path: "/srv/REPO/file" },
			"/srv/repo",
		)?.decision,
		"deny",
	);
	assert.equal(
		inspectWriteBoundary(
			"edit",
			{ path: "C:\\REPO\\file" },
			"C:\\repo",
		),
		null,
	);
	assert.equal(
		inspectWriteBoundary("edit", { path: "../outside/file" }, "/repo")?.decision,
		"deny",
	);
	assert.equal(
		inspectWriteBoundary(
			"apply_patch",
			"*** Update File: src/a.mjs\n*** Move to: /outside/a.mjs\n",
			"/repo",
		)?.decision,
		"deny",
	);
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
