import assert from "node:assert/strict";
import {
	readdir
} from "node:fs/promises";
import test from "node:test";
import { parseJson, readRecord } from "../../data.mjs";
import { createPlanStore } from "../../storage.mjs";
import { UPDATED_AT, makePlan, rejectsCode, startWorker, withDatabase, withWorkspace } from "./fixture.mjs";

test("same-process store instances cannot commit the same expected revision", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		const other = createPlanStore({ workspacePath: workspace, clock: () => UPDATED_AT });
		const results = await Promise.allSettled([
			store.update(plan.id, 1, { ...plan, title: "Writer A" }),
			other.update(plan.id, 1, { ...plan, title: "Writer B" }),
		]);
		assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
		const rejected = results.find((result) => result.status === "rejected");
		assert.equal(rejected?.reason.code, "revision_conflict");
		assert.equal((await store.read(plan.id)).revision, 2);
	})
));

test("separate processes cannot commit the same expected revision", { timeout: 20_000 }, (context) => (
	withWorkspace(async ({ workspace, store }) => {
		await store.create(makePlan(workspace), 0);
		const workers = [startWorker(context, workspace, "update"), startWorker(context, workspace, "update")];
		await Promise.all(workers.map((worker) => worker.event("ready")));
		workers.forEach((worker, index) => worker.child.send({ title: `Process ${index}` }));
		const results = await Promise.all(workers.map((worker) => worker.done));
		assert.deepEqual(results.map(({ code }) => code).sort(), [0, 2], JSON.stringify(results));
		assert.equal(results.filter(({ stdout }) => readRecord(parseJson(stdout)).code === "revision_conflict").length, 1);
		const persisted = await store.read("sample-plan");
		assert.equal(persisted.revision, 2);
		assert.match(persisted.title, /^Process [01]$/);
		assert.deepEqual(await readdir(store.directory), ["foundry.sqlite"]);
	})
));

test("concurrent processes initialize safely and create an ID only once", { timeout: 20_000 }, (context) => (
	withWorkspace(async ({ workspace, store }) => {
		const workers = [startWorker(context, workspace, "create"), startWorker(context, workspace, "create")];
		await Promise.all(workers.map((worker) => worker.event("ready")));
		workers.forEach((worker, index) => worker.child.send({
			plan: { ...makePlan(workspace), title: `Creator ${index}` },
		}));
		const results = await Promise.all(workers.map((worker) => worker.done));
		assert.deepEqual(results.map(({ code }) => code).sort(), [0, 2], JSON.stringify(results));
		assert.equal(results.filter(({ stdout }) => readRecord(parseJson(stdout)).code === "plan_exists").length, 1);
		assert.equal((await store.read("sample-plan")).revision, 1);
		assert.equal((await store.list()).plans.length, 1);
	})
));

test("readers cannot see uncommitted writes and killed writers roll back on restart", { timeout: 20_000 }, (context) => (
	withWorkspace(async ({ workspace, store }) => {
		const original = await store.create(makePlan(workspace), 0);
		const worker = startWorker(context, workspace, "hold-update");
		await worker.event("ready");
		const staged = worker.event("staged");
		worker.child.send({ title: "Must never be visible" });
		await staged;
		assert.deepEqual(await store.read(original.id), original);
		const impatient = createPlanStore({ workspacePath: workspace, busyTimeoutMs: 20 });
		await rejectsCode(impatient.update(original.id, 1, original), "storage_busy");
		worker.child.kill("SIGKILL");
		assert.equal((await worker.done).signal, "SIGKILL");
		const restarted = createPlanStore({ workspacePath: workspace, clock: () => UPDATED_AT });
		assert.deepEqual(await restarted.read(original.id), original);
		assert.equal((await restarted.update(original.id, 1, original)).revision, 2);
		assert.equal(withDatabase(store, (db) => db.prepare("PRAGMA integrity_check").get()?.integrity_check), "ok");
	})
));

test("a commit survives a process exit before acknowledgement", { timeout: 20_000 }, (context) => (
	withWorkspace(async ({ workspace, store }) => {
		await store.create(makePlan(workspace), 0);
		const worker = startWorker(context, workspace, "crash-update-after");
		await worker.event("ready");
		worker.child.send({ title: "Committed before exit" });
		assert.equal((await worker.done).signal, "SIGKILL");
		const restarted = createPlanStore({ workspacePath: workspace });
		const plan = await restarted.read("sample-plan");
		assert.equal(plan.revision, 2);
		assert.equal(plan.title, "Committed before exit");
		await rejectsCode(restarted.update(plan.id, 1, plan), "revision_conflict");
	})
));
