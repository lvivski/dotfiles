import assert from "node:assert/strict";
import test from "node:test";

import {
    buildMobiusHooks,
    classifyShellCommand,
    inspectWriteBoundary,
} from "./hooks.mjs";

test("guardrail classifiers target only broad destructive behavior", () => {
    assert.equal(
        classifyShellCommand("git reset --hard HEAD", "/repo").decision,
        "deny",
    );
    assert.equal(
        classifyShellCommand("git -C /repo reset --hard HEAD", "/repo").decision,
        "deny",
    );
    assert.equal(
        classifyShellCommand("git clean -d -f", "/repo").decision,
        "deny",
    );
    assert.equal(
        classifyShellCommand("git clean --force -d", "/repo").decision,
        "deny",
    );
    assert.equal(
        classifyShellCommand("git --no-pager reset --hard HEAD", "/repo").decision,
        "deny",
    );
    assert.equal(
        classifyShellCommand("git status && git clean -fd", "/repo").decision,
        "deny",
    );
    assert.equal(
        classifyShellCommand("echo 'git clean -fd'", "/repo"),
        null,
    );
    assert.equal(
        classifyShellCommand("rm -rf /", "/repo").decision,
        "deny",
    );
    assert.equal(
        classifyShellCommand("rm -rf build-cache", "/repo").decision,
        "ask",
    );
    assert.equal(classifyShellCommand("npm test", "/repo"), null);
    assert.equal(
        inspectWriteBoundary("edit", { path: "/outside/file" }, "/repo").decision,
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
        ).decision,
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
        inspectWriteBoundary("edit", { path: "../outside/file" }, "/repo").decision,
        "deny",
    );
    assert.equal(
        inspectWriteBoundary(
            "apply_patch",
            "*** Update File: src/a.mjs\n*** Move to: /outside/a.mjs\n",
            "/repo",
        ).decision,
        "deny",
    );
});

test("hooks are inert without an explicitly active plan", async () => {
    const hooks = buildMobiusHooks({
        operations: { getActive: async () => null },
    });
    assert.deepEqual(await hooks.onSessionStart({}), {});
    assert.deepEqual(await hooks.onPreToolUse({
        toolName: "bash",
        toolArgs: { command: "git reset --hard" },
        workingDirectory: "/repo",
    }), {});
});

test("active hooks inject coordinator context and revision-conflict guidance", async () => {
    const hooks = buildMobiusHooks({
        operations: {
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
    assert.match(start.additionalContext, /Mobius plan active-plan/);
    assert.match(start.additionalContext, /mobius_next_tasks/);

    const denied = await hooks.onPreToolUse({
        toolName: "bash",
        toolArgs: { command: "git clean -fdx" },
        workingDirectory: "/repo",
    });
    assert.equal(denied.permissionDecision, "deny");

    const mutation = await hooks.onPreToolUse({
        toolName: "mobius_complete_task",
        toolArgs: {},
        workingDirectory: "/repo",
    });
    assert.equal(mutation.permissionDecision, undefined);

    const read = await hooks.onPreToolUse({
        toolName: "mobius_get_plan",
        toolArgs: {},
        workingDirectory: "/repo",
    });
    assert.equal(read.permissionDecision, "allow");

    const failure = await hooks.onPostToolUseFailure({
        toolName: "mobius_complete_task",
    });
    assert.match(failure.additionalContext, /Re-read the current plan revision/);
});
