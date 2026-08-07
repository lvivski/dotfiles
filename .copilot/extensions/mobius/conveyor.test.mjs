import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    buildPlanningArgs,
    buildVerificationInput,
} from "./analysis.mjs";
import {
    importPlanningConveyor,
    inspectVerificationConveyor,
    preparePlanningConveyor,
    prepareVerificationConveyor,
    verificationRunCanBeReplaced,
    verificationRunIsTerminal,
} from "./conveyor.mjs";
import {
    ATTEMPT_STATUS,
    EVIDENCE_TYPE,
    PLAN_STATUS,
    approvePlan,
    attachTaskAttempt,
    completeTaskAttempt,
    createDraftPlan,
    reserveTaskAttempt,
    transitionPlan,
} from "./domain.mjs";

const CONVEYORS = path.resolve(
    fileURLToPath(new URL("./conveyors", import.meta.url)),
);

async function withRuns(operation) {
    const runs = await mkdtemp(path.join(os.tmpdir(), "mobius-conveyor-runs-"));
    const saved = process.env.CONVEYOR_RUNS_DIR;
    process.env.CONVEYOR_RUNS_DIR = runs;
    try {
        return await operation(runs);
    } finally {
        if (saved === undefined) delete process.env.CONVEYOR_RUNS_DIR;
        else process.env.CONVEYOR_RUNS_DIR = saved;
        await rm(runs, { recursive: true, force: true });
    }
}

async function writeRun(runs, options) {
    const dir = path.join(runs, options.runId);
    await mkdir(dir, { recursive: true });
    if (options.active) {
        await mkdir(path.join(dir, ".lock"), { recursive: true });
    }
    const verification = options.name === "mobius-verify";
    const script = options.script ?? await readFile(
        path.join(
            CONVEYORS,
            options.name === "mobius-plan" ? "plan.mjs" : "verify.mjs",
        ),
        "utf8",
    );
    await Promise.all([
        writeFile(path.join(dir, "script.js"), script),
        writeFile(path.join(dir, "manifest.json"), JSON.stringify({
            formatVersion: options.formatVersion ?? 4,
            runId: options.runId,
            restricted: options.restricted ?? true,
            enableMcp: options.enableMcp ?? false,
            hostPath: options.hostPath ?? null,
            conveyor: { name: options.name },
            args: options.args,
            strictBudget: true,
            model: "gpt-5-mini",
            effort: "medium",
            context: null,
            planId: options.previewPlanId === undefined
                ? "preview-plan"
                : options.previewPlanId,
            progressMode: "dashboard",
            maxAgents: verification ? 9 : 15,
            declaredLimits: {
                maxConcurrentAgents: 2,
                maxTotalAgents: verification ? 6 : 8,
                timeoutSeconds: 300,
                maxAiCredits: verification ? 100 : 30,
            },
        })),
        writeFile(path.join(dir, "meta.json"), JSON.stringify({
            conveyor: { name: options.name },
            restricted: options.restricted ?? true,
            args: options.args,
        })),
        writeFile(path.join(dir, "run.json"), JSON.stringify({
            runId: options.runId,
            status: options.status ?? "complete",
            revision: 1,
            ...(options.result === undefined ? {} : { result: options.result }),
            preservedWorktrees: options.preservedWorktrees ?? [],
        })),
        ...(options.active
            ? [
                writeFile(path.join(dir, "state.json"), JSON.stringify({
                    runId: options.runId,
                    status: "running",
                    revision: 1,
                    heartbeatAt: new Date().toISOString(),
                })),
                writeFile(path.join(dir, ".lock", "owner.json"), JSON.stringify({
                    token: "mobius-test-owner",
                    generation: 1,
                    pid: process.pid,
                })),
            ]
            : []),
    ]);
}

function completedPlan() {
    let plan = createDraftPlan({
        id: "adapter-plan",
        title: "Adapter plan",
        objective: "Validate Conveyor imports",
        constraints: [],
        repository: {
            workingDirectory: "/tmp/adapter-plan",
            baseBranch: "main",
        },
        tasks: [{
            id: "T-001",
            title: "Implement",
            description: "Implement",
            dependsOn: [],
            acceptanceCriteria: ["Tests pass"],
            expectedFiles: ["src/change.mjs"],
        }],
    }, { now: "2026-08-05T00:00:00.000Z" });
    plan = transitionPlan(plan, PLAN_STATUS.AWAITING_APPROVAL, {
        at: "2026-08-05T00:01:00.000Z",
    });
    plan = approvePlan(plan, "tester", { at: "2026-08-05T00:02:00.000Z" });
    plan = reserveTaskAttempt(plan, "T-001", {
        reservationId: "adapter-reservation",
        at: "2026-08-05T00:03:00.000Z",
    });
    plan = attachTaskAttempt(plan, "T-001", "T-001-A001", {
        sessionId: "session-1",
        branch: "work/adapter",
        at: "2026-08-05T00:04:00.000Z",
    });
    return completeTaskAttempt(plan, "T-001", "T-001-A001", ATTEMPT_STATUS.DONE, {
        resultSummary: "Implemented",
        evidence: [{
            type: EVIDENCE_TYPE.TEST,
            summary: "node --test passed",
            source: "node --test",
            outcome: "passed",
        }],
        branch: "work/adapter",
        commit: "a".repeat(40),
        at: "2026-08-05T00:05:00.000Z",
    });
}

test("prepare tools return absolute pinned restricted launch specs", async () => {
    const planning = await preparePlanningConveyor({
        objective: "Build",
        constraints: [],
        repositoryContext: "Node repository",
        maxTasks: 2,
    });
    assert.equal(path.isAbsolute(planning.launchSpec.scriptPath), true);
    assert.equal(planning.launchSpec.restricted, true);
    assert.equal(planning.launchSpec.enableMcp, false);
    assert.equal(planning.launchSpec.strictBudget, true);

    const verification = await prepareVerificationConveyor(completedPlan());
    assert.equal(path.isAbsolute(verification.launchSpec.scriptPath), true);
    assert.equal(verification.launchSpec.args.tasks[0].criteria[0].id, "T-001-C001");
});

test("script pinning canonicalizes CRLF line endings", () => (
    withRuns(async (runs) => {
        const args = buildPlanningArgs({
            objective: "Build",
            constraints: [],
            repositoryContext: "Node repository",
            maxTasks: 1,
        });
        const source = await readFile(
            path.join(CONVEYORS, "plan.mjs"),
            "utf8",
        );
        await writeRun(runs, {
            runId: "crlf-run",
            name: "mobius-plan",
            args,
            script: source.replaceAll("\n", "\r\n"),
            result: {
                kind: "mobius-plan-result-v1",
                inputDigest: args.inputDigest,
                status: "needs-review",
                plan: null,
                critiques: [null, null],
                verification: null,
                missingPerspectives: ["decomposition"],
                issues: ["synthetic"],
            },
        });
        await assert.rejects(
            importPlanningConveyor("crlf-run"),
            (/** @type {any} */ error) => error.code === "analysis_needs_review",
        );
    })
));

test("planning import accepts only a pinned complete ready run", () => (
    withRuns(async (runs) => {
        const args = buildPlanningArgs({
            objective: "Build",
            constraints: [],
            repositoryContext: "Node repository",
            maxTasks: 2,
        });
        const plan = {
            title: "Plan",
            objective: "Build",
            constraints: [],
            tasks: [{
                id: "T-001",
                title: "Implement",
                kind: "implement",
                description: "Implement",
                dependsOn: [],
                acceptanceCriteria: ["Tests pass"],
                expectedFiles: ["src/change.mjs"],
            }],
        };
        await writeRun(runs, {
            runId: "planning-run",
            name: "mobius-plan",
            args,
            result: {
                kind: "mobius-plan-result-v1",
                inputDigest: args.inputDigest,
                status: "ready",
                plan,
                critiques: [
                    { verdict: "accept", risks: [], requiredChanges: [] },
                    { verdict: "accept", risks: [], requiredChanges: [] },
                ],
                verification: { passed: true, issues: [] },
                missingPerspectives: [],
                issues: [],
            },
        });
        const imported = await importPlanningConveyor("planning-run");
        assert.equal(imported.plan.tasks[0].id, "T-001");

        await writeRun(runs, {
            runId: "shadowed-run",
            name: "mobius-plan",
            args,
            script: "return { kind: 'mobius-plan-result-v1' };\n",
            result: {
                kind: "mobius-plan-result-v1",
                inputDigest: args.inputDigest,
                status: "ready",
                plan,
            },
        });
        await assert.rejects(
            importPlanningConveyor("shadowed-run"),
            (/** @type {any} */ error) => error.code === "conveyor_run_identity_mismatch",
        );

        await writeRun(runs, {
            runId: "direct-run",
            name: "mobius-plan",
            args,
            previewPlanId: null,
            result: {
                kind: "mobius-plan-result-v1",
                inputDigest: args.inputDigest,
                status: "ready",
                plan,
                critiques: [
                    { verdict: "accept", risks: [], requiredChanges: [] },
                    { verdict: "accept", risks: [], requiredChanges: [] },
                ],
                verification: { passed: true, issues: [] },
                missingPerspectives: [],
                issues: [],
            },
        });
        await assert.rejects(
            importPlanningConveyor("direct-run"),
            (/** @type {any} */ error) => error.code === "conveyor_launch_mismatch",
        );
    })
));

test("verification import binds canonical args and criterion coverage", () => (
    withRuns(async (runs) => {
        const plan = completedPlan();
        const args = buildVerificationInput(plan);
        await writeRun(runs, {
            runId: "verification-run",
            name: "mobius-verify",
            args,
            result: {
                kind: "mobius-verification-result-v1",
                inputDigest: args.inputDigest,
                planId: plan.id,
                passed: true,
                summary: "Verified",
                evidenceIds: ["T-001-A001-E001"],
                missingEvidence: [],
                correctionTaskIds: [],
                reviews: [
                    {
                        coverage: [{
                            criterionId: "T-001-C001",
                            evidenceIds: ["T-001-A001-E001"],
                        }],
                        missingEvidence: [],
                        integrationFindings: [],
                        risks: [],
                    },
                    {
                        coverage: [],
                        missingEvidence: [],
                        integrationFindings: [],
                        risks: [],
                    },
                ],
            },
        });
        const inspected = await inspectVerificationConveyor(
            "verification-run",
            plan,
            { requireComplete: true },
        );
        assert.equal(inspected.result.passed, true);

        await writeRun(runs, {
            runId: "timed-out-run",
            name: "mobius-verify",
            args,
            status: "timeout",
        });
        assert.equal(
            await verificationRunCanBeReplaced("timed-out-run", plan),
            true,
        );
        assert.equal(await verificationRunIsTerminal("timed-out-run"), true);
        await assert.rejects(
            inspectVerificationConveyor(
                "timed-out-run",
                plan,
                { requireComplete: true },
            ),
            (/** @type {any} */ error) => error.code === "conveyor_result_unavailable",
        );
        await writeRun(runs, {
            runId: "active-run",
            name: "mobius-verify",
            args,
            status: "running",
            active: true,
        });
        assert.equal(await verificationRunIsTerminal("active-run"), false);

        await writeRun(runs, {
            runId: "old-pinned-run",
            name: "mobius-verify",
            args,
            script: "return { passed: true };\n",
            result: {
                kind: "mobius-verification-result-v1",
                inputDigest: args.inputDigest,
                planId: plan.id,
                passed: true,
                summary: "Old script result",
                evidenceIds: ["T-001-A001-E001"],
                missingEvidence: [],
                correctionTaskIds: [],
                reviews: [],
            },
        });
        assert.equal(
            await verificationRunCanBeReplaced("old-pinned-run", plan),
            true,
        );

        await writeRun(runs, {
            runId: "old-format-run",
            name: "mobius-verify",
            args,
            formatVersion: 3,
            status: "timeout",
        });
        assert.equal(
            await verificationRunCanBeReplaced("old-format-run", plan),
            true,
        );
    })
));
