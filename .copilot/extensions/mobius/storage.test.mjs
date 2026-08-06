// Storage tests use disposable session-workspace lookalikes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { appendPlanGeneration, createDraftPlan } from "./domain.mjs";
import {
    STORAGE_PROCESS_INSTANCE_ID,
    createPlanStore,
} from "./storage.mjs";

const CREATED_AT = "2026-08-05T16:00:00.000Z";
const UPDATED_AT = "2026-08-05T16:01:00.000Z";
const WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));

function makePlan(repositoryPath, id = "sample-plan") {
    return createDraftPlan({
        id,
        title: `Plan ${id}`,
        objective: "Prove durable Mobius storage",
        constraints: [],
        repository: {
            workingDirectory: repositoryPath,
            baseBranch: "main",
        },
        tasks: [{
            id: "T-001",
            title: "Implement storage",
            description: "Persist the plan safely",
            dependsOn: [],
            acceptanceCriteria: ["The plan survives a fresh read"],
            expectedFiles: ["src/storage.mjs"],
        }],
    }, { now: CREATED_AT });
}

function makeLegacyPlan(repositoryPath, id = "sample-plan") {
    const plan = structuredClone(makePlan(repositoryPath, id));
    plan.schemaVersion = 1;
    delete plan.generation;
    delete plan.evidenceRecords;
    delete plan.observations;
    delete plan.integrationRefs;
    for (const task of plan.tasks) {
        delete task.reservation;
        delete task.deliveries;
    }
    return plan;
}

async function withWorkspace(operation) {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "mobius-storage-"));
    try {
        return await operation(workspace);
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
}

async function rejectsCode(promise, code, check) {
    await assert.rejects(promise, (error) => {
        assert.equal(error.code, code);
        check?.(error);
        return true;
    });
}

function runUpdateWorker(workspace, title) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            WORKER_PATH,
            workspace,
            "sample-plan",
            title,
        ], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => {
            let result;
            try {
                result = JSON.parse(stdout);
            } catch {
                reject(new Error(`Worker returned invalid JSON: ${stdout}\n${stderr}`));
                return;
            }
            resolve({ code, result, stderr });
        });
    });
}

test("create, read, and list persist validated plans under the session workspace", () => (
    withWorkspace(async (workspace) => {
        const store = createPlanStore({
            workspacePath: workspace,
            clock: () => UPDATED_AT,
        });
        const plan = makePlan(workspace);

        await rejectsCode(store.create(plan), "invalid_expected_revision");
        await store.create(plan, 0);
        const read = await store.read(plan.id);
        assert.deepEqual(read, plan);

        read.title = "Caller mutation";
        assert.equal((await store.read(plan.id)).title, plan.title);

        const listed = await store.list();
        assert.equal(listed.invalid.length, 0);
        assert.equal(listed.truncated, false);
        assert.deepEqual(listed.plans.map((summary) => summary.id), [plan.id]);
        assert.equal(listed.plans[0].revision, 1);

        const artifactPath = path.join(workspace, "files", "mobius", `${plan.id}.json`);
        assert.deepEqual(JSON.parse(await readFile(artifactPath, "utf8")), plan);
    })
));

test("explicit upgrade snapshots exact v1 bytes before replacing with v2 defaults", () => (
    withWorkspace(async (workspace) => {
        const store = createPlanStore({
            workspacePath: workspace,
            clock: () => UPDATED_AT,
        });
        await mkdir(store.directory, { recursive: true });
        const legacy = makeLegacyPlan("/tmp/schema-v1-source");
        const source = `\n${JSON.stringify(legacy, null, 1)} \n`;
        const sourceBytes = Buffer.from(source, "utf8");
        const digest = createHash("sha256").update(sourceBytes).digest("hex");
        assert.equal(
            digest,
            "fe86c9d2a1f87b51aad7dde4fe590aa802cbab50c1c30a5745a8bd027b5c1724",
        );
        const artifactPath = path.join(store.directory, "sample-plan.json");
        await writeFile(artifactPath, sourceBytes);

        assert.deepEqual(await store.read("sample-plan"), legacy);
        const candidate = structuredClone(legacy);
        candidate.title = "Mutation must not land";
        await rejectsCode(
            store.update("sample-plan", legacy.revision, candidate),
            "upgrade_required",
        );
        assert.deepEqual(await readFile(artifactPath), sourceBytes);

        const upgraded = await store.upgrade("sample-plan", legacy.revision);
        assert.equal(upgraded.schemaVersion, 2);
        assert.equal(upgraded.revision, legacy.revision + 1);
        assert.equal(upgraded.updatedAt, UPDATED_AT);
        assert.deepEqual(upgraded.generation, {
            current: 1,
            history: [{
                number: 1,
                createdAt: CREATED_AT,
                createdBy: null,
                planningRunId: null,
                feedback: null,
                diffDigest: null,
            }],
        });
        assert.equal(upgraded.tasks[0].reservation, null);
        assert.deepEqual(upgraded.tasks[0].deliveries, []);
        assert.deepEqual(upgraded.evidenceRecords, []);
        assert.deepEqual(upgraded.observations, []);
        assert.deepEqual(upgraded.integrationRefs, []);

        const historyDirectory = path.join(store.directory, ".history", legacy.id);
        const expectedFilename = `schema-v1-r1-${digest}.json`;
        assert.deepEqual(await readdir(historyDirectory), [expectedFilename]);
        const snapshotPath = path.join(historyDirectory, expectedFilename);
        assert.deepEqual(await readFile(snapshotPath), sourceBytes);
        assert.equal((await stat(snapshotPath)).mode & 0o777, 0o600);
        assert.equal(JSON.parse(await readFile(artifactPath, "utf8")).schemaVersion, 2);
        await rejectsCode(
            store.upgrade("sample-plan", upgraded.revision),
            "already_upgraded",
        );
    })
));

test("injected pre-replace failure leaves authoritative v1 bytes unchanged", () => (
    withWorkspace(async (workspace) => {
        const injected = Object.assign(new Error("stop before replacement"), {
            code: "injected_pre_replace",
        });
        const store = createPlanStore({
            workspacePath: workspace,
            clock: () => UPDATED_AT,
            beforeUpgradeReplace: () => {
                throw injected;
            },
        });
        await mkdir(store.directory, { recursive: true });
        const legacy = makeLegacyPlan("/tmp/schema-v1-source");
        const sourceBytes = Buffer.from(`\n${JSON.stringify(legacy, null, 1)} \n`, "utf8");
        const artifactPath = path.join(store.directory, "sample-plan.json");
        await writeFile(artifactPath, sourceBytes);

        await rejectsCode(
            store.upgrade("sample-plan", legacy.revision),
            "injected_pre_replace",
        );
        assert.deepEqual(await readFile(artifactPath), sourceBytes);
        assert.equal((await store.read("sample-plan")).schemaVersion, 1);
    })
));

test("stale revisions fail with the latest revision and preserve the winning write", () => (
    withWorkspace(async (workspace) => {
        const store = createPlanStore({
            workspacePath: workspace,
            clock: () => UPDATED_AT,
        });
        const plan = makePlan(workspace);
        await store.create(plan, 0);

        const winning = await store.read(plan.id);
        winning.title = "Winning update";
        const updated = await store.update(plan.id, 1, winning);
        assert.equal(updated.revision, 2);
        assert.equal(updated.updatedAt, UPDATED_AT);

        await rejectsCode(
            store.update(plan.id, 1, {
                ...plan,
                title: "Stale update",
            }),
            "revision_conflict",
            (error) => assert.equal(error.details.latestRevision, 2),
        );
        assert.equal((await store.read(plan.id)).title, "Winning update");
    })
));

test("generation replacement stops at 16 without changing plan or history", () => (
    withWorkspace(async (workspace) => {
        const store = createPlanStore({
            workspacePath: workspace,
            clock: () => UPDATED_AT,
        });
        let plan = await store.create(makePlan(workspace), 0);
        while (plan.generation.current < 16) {
            const candidate = appendPlanGeneration(plan, {
                createdBy: null,
                planningRunId: null,
                feedback: null,
                diffDigest: null,
            }, { at: CREATED_AT });
            plan = await store.replaceGeneration(plan.id, plan.revision, candidate);
        }
        assert.equal(plan.generation.current, 16);

        const artifactPath = path.join(store.directory, `${plan.id}.json`);
        const historyDirectory = path.join(store.directory, ".history", plan.id);
        const beforeSource = await readFile(artifactPath);
        const beforeHistory = (await readdir(historyDirectory)).sort();
        await rejectsCode(
            store.replaceGeneration(plan.id, plan.revision, structuredClone(plan)),
            "generation_limit",
        );
        assert.deepEqual(await readFile(artifactPath), beforeSource);
        assert.deepEqual((await readdir(historyDirectory)).sort(), beforeHistory);
    })
));

test("parallel writers with the same revision cannot silently overwrite each other", () => (
    withWorkspace(async (workspace) => {
        const store = createPlanStore({
            workspacePath: workspace,
            clock: () => UPDATED_AT,
        });
        const plan = makePlan(workspace);
        await store.create(plan, 0);

        const writerA = await store.read(plan.id);
        const writerB = await store.read(plan.id);
        writerA.title = "Writer A";
        writerB.title = "Writer B";
        const results = await Promise.allSettled([
            store.update(plan.id, 1, writerA),
            store.update(plan.id, 1, writerB),
        ]);

        const fulfilled = results.filter((result) => result.status === "fulfilled");
        const rejected = results.filter((result) => result.status === "rejected");
        assert.equal(fulfilled.length, 1);
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].reason.code, "revision_conflict");

        const stored = await store.read(plan.id);
        assert.equal(stored.revision, 2);
        assert.ok(stored.title === "Writer A" || stored.title === "Writer B");
        assert.deepEqual(
            (await readdir(store.directory)).filter((name) => name.startsWith(".")),
            [],
        );
    })
));

test("separate processes cannot commit the same expected revision", () => (
    withWorkspace(async (workspace) => {
        const store = createPlanStore({
            workspacePath: workspace,
            clock: () => UPDATED_AT,
        });
        await store.create(makePlan(workspace), 0);

        const results = await Promise.all([
            runUpdateWorker(workspace, "Process A"),
            runUpdateWorker(workspace, "Process B"),
        ]);
        assert.deepEqual(results.map((result) => result.code).sort(), [0, 2]);
        assert.equal(results.filter((result) => result.result.code === "revision_conflict").length, 1);

        const stored = await store.read("sample-plan");
        assert.equal(stored.revision, 2);
        assert.ok(stored.title === "Process A" || stored.title === "Process B");
        assert.deepEqual(
            (await readdir(store.directory)).filter((name) => name.startsWith(".")),
            [],
        );
    })
));

test("invalid candidate documents are rejected before atomic replacement", () => (
    withWorkspace(async (workspace) => {
        const store = createPlanStore({
            workspacePath: workspace,
            clock: () => UPDATED_AT,
        });
        const plan = makePlan(workspace);
        await store.create(plan, 0);

        const candidate = await store.read(plan.id);
        candidate.tasks[0].acceptanceCriteria = [];
        await rejectsCode(
            store.update(plan.id, 1, candidate),
            "candidate_invalid",
            (error) => assert.equal(error.details.validationCode, "array_too_short"),
        );

        const stored = await store.read(plan.id);
        assert.equal(stored.revision, 1);
        assert.deepEqual(stored.tasks[0].acceptanceCriteria, ["The plan survives a fresh read"]);
    })
));

test("custom JSON serialization cannot bypass validation", () => (
    withWorkspace(async (workspace) => {
        const store = createPlanStore({
            workspacePath: workspace,
            clock: () => UPDATED_AT,
        });
        const plan = makePlan(workspace);
        await store.create(plan, 0);
        const candidate = await store.read(plan.id);
        candidate.title = "Store-owned snapshot";
        Object.defineProperty(candidate, "toJSON", {
            enumerable: false,
            value: () => ({ invalid: true }),
        });

        const updated = await store.update(plan.id, 1, candidate);
        assert.equal(updated.title, "Store-owned snapshot");
        assert.equal(updated.revision, 2);
        assert.equal((await store.read(plan.id)).title, "Store-owned snapshot");
    })
));

test("an unreadable or invalid existing artifact is never overwritten", () => (
    withWorkspace(async (workspace) => {
        const store = createPlanStore({
            workspacePath: workspace,
            clock: () => UPDATED_AT,
        });
        const plan = makePlan(workspace);
        await mkdir(store.directory, { recursive: true });
        const artifactPath = path.join(store.directory, `${plan.id}.json`);
        const invalidSource = "{ definitely-not-json";
        await writeFile(artifactPath, invalidSource, "utf8");

        await rejectsCode(store.create(plan, 0), "artifact_invalid");
        assert.equal(await readFile(artifactPath, "utf8"), invalidSource);
    })
));

test("an artifact corrupted before an update is preserved instead of overwritten", () => (
    withWorkspace(async (workspace) => {
        const store = createPlanStore({
            workspacePath: workspace,
            clock: () => UPDATED_AT,
        });
        const plan = makePlan(workspace);
        await store.create(plan, 0);
        const artifactPath = path.join(store.directory, `${plan.id}.json`);
        const corrupted = "{ corrupted-during-update";
        const candidate = await store.read(plan.id);
        candidate.title = "Must not land";
        await writeFile(artifactPath, corrupted, "utf8");

        await rejectsCode(
            store.update(plan.id, 1, candidate),
            "artifact_invalid",
        );
        assert.equal(await readFile(artifactPath, "utf8"), corrupted);
        assert.deepEqual(
            (await readdir(store.directory)).filter((name) => name.endsWith(".tmp")),
            [],
        );
    })
));

test("plan IDs cannot traverse outside the Mobius artifact directory", () => (
    withWorkspace(async (workspace) => {
        const store = createPlanStore({ workspacePath: workspace });
        await rejectsCode(store.read("../escape"), "invalid_plan_id");
        await rejectsCode(store.read("nested/escape"), "invalid_plan_id");
    })
));

test("symlinked storage directories cannot escape the session workspace", () => (
    withWorkspace(async (workspace) => {
        const outside = await mkdtemp(path.join(os.tmpdir(), "mobius-outside-"));
        try {
            await symlink(
                outside,
                path.join(workspace, "files"),
                process.platform === "win32" ? "junction" : "dir",
            );
            const store = createPlanStore({ workspacePath: workspace });
            await rejectsCode(
                store.create(makePlan(workspace), 0),
                "path_outside_workspace",
            );
            assert.deepEqual(await readdir(outside), []);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    })
));

test("symlinked plan artifacts are reported and never followed", () => (
    withWorkspace(async (workspace) => {
        const outside = await mkdtemp(path.join(os.tmpdir(), "mobius-artifact-"));
        try {
            const store = createPlanStore({ workspacePath: workspace });
            await mkdir(store.directory, { recursive: true });
            const externalFile = path.join(outside, "external.json");
            await writeFile(externalFile, JSON.stringify(makePlan(workspace)), "utf8");
            await symlink(externalFile, path.join(store.directory, "sample-plan.json"), "file");

            await rejectsCode(store.read("sample-plan"), "artifact_unsafe");
            const listed = await store.list();
            assert.equal(listed.plans.length, 0);
            assert.equal(listed.invalid.length, 1);
            assert.equal(listed.invalid[0].code, "artifact_unsafe");
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    })
));

test("bounded listing reports malformed artifacts instead of hiding them", () => (
    withWorkspace(async (workspace) => {
        const store = createPlanStore({
            workspacePath: workspace,
            clock: () => UPDATED_AT,
        });
        await store.create(makePlan(workspace, "alpha-plan"), 0);
        await store.create(makePlan(workspace, "beta-plan"), 0);
        await writeFile(path.join(store.directory, "broken-plan.json"), "{", "utf8");

        const firstPage = await store.list({ limit: 2 });
        assert.equal(firstPage.truncated, true);
        assert.deepEqual(firstPage.plans.map((summary) => summary.id), [
            "alpha-plan",
            "beta-plan",
        ]);

        const complete = await store.list({ limit: 10 });
        assert.equal(complete.truncated, false);
        assert.equal(complete.invalid.length, 1);
        assert.equal(complete.invalid[0].filename, "broken-plan.json");
        assert.equal(complete.invalid[0].code, "artifact_invalid");
    })
));

test("bounded summaries preserve planning provenance and objective boundaries", () => (
    withWorkspace(async (workspace) => {
        const store = createPlanStore({
            workspacePath: workspace,
            clock: () => UPDATED_AT,
        });
        const exact = makePlan(workspace, "exact-plan");
        exact.objective = "x".repeat(240);
        exact.planning = {
            backend: "conveyor",
            runId: "planning-run-1",
            inputDigest: "a".repeat(64),
        };
        const truncated = makePlan(workspace, "truncated-plan");
        truncated.objective = "y".repeat(241);
        await store.create(exact, 0);
        await store.create(truncated, 0);

        const listed = await store.list();
        const exactSummary = listed.plans.find((plan) => plan.id === "exact-plan");
        const truncatedSummary = listed.plans.find((plan) => plan.id === "truncated-plan");
        assert.equal(exactSummary.objective.length, 240);
        assert.equal(exactSummary.planningRunId, exact.planning.runId);
        assert.equal(truncatedSummary.objective, `${"y".repeat(237)}...`);
        assert.equal(truncatedSummary.objective.length, 240);
        assert.equal(truncatedSummary.planningRunId, null);
    })
));

test("startup recovery immediately removes locks whose owner process is gone", () => (
    withWorkspace(async (workspace) => {
        const store = createPlanStore({ workspacePath: workspace });
        await store.create(makePlan(workspace), 0);
        const staleLock = path.join(store.directory, ".sample-plan.json.lock");
        await writeFile(staleLock, JSON.stringify({
            token: "stale-token",
            pid: 99_999_999,
            instanceId: "dead-instance",
            createdAt: new Date().toISOString(),
        }), "utf8");
        const staleBarrier = path.join(store.directory, ".mobius-recovery.lock");
        await writeFile(staleBarrier, JSON.stringify({
            token: "stale-recovery",
            pid: 99_999_999,
            instanceId: "dead-instance",
            createdAt: new Date().toISOString(),
        }), "utf8");

        const recovery = await store.recoverStaleLocks({ staleMs: 30_000 });
        assert.deepEqual(recovery.recovered, [".sample-plan.json.lock"]);
        assert.ok(!(await readdir(store.directory)).includes(".sample-plan.json.lock"));
        assert.ok(!(await readdir(store.directory)).includes(".mobius-recovery.lock"));

        const liveLock = path.join(store.directory, ".live.lock");
        await writeFile(liveLock, JSON.stringify({
            token: "live-token",
            pid: process.pid,
            instanceId: STORAGE_PROCESS_INSTANCE_ID,
            createdAt: new Date().toISOString(),
        }), "utf8");
        const liveRecovery = await store.recoverStaleLocks({ staleMs: 1 });
        assert.equal(liveRecovery.recovered.length, 0);
        assert.ok((await readdir(store.directory)).includes(".live.lock"));

        const reusedPidLock = path.join(store.directory, ".reused-pid.lock");
        await writeFile(reusedPidLock, JSON.stringify({
            token: "reused-token",
            pid: process.pid,
            instanceId: "previous-extension-instance",
            createdAt: new Date().toISOString(),
        }), "utf8");
        const reusedRecovery = await store.recoverStaleLocks({
            staleMs: 30_000,
        });
        assert.deepEqual(reusedRecovery.recovered, [".reused-pid.lock"]);
    })
));
