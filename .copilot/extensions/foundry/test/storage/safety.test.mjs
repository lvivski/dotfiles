import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import {
	link,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	symlink,
	writeFile
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPlanStore } from "../../storage.mjs";
import { makePlan, rejectsCode, withDatabase, withWorkspace } from "./fixture.mjs";

test("unsafe plan IDs and invalid storage options fail before accessing a database", () => (
	withWorkspace(async ({ workspace, store }) => {
		for (const id of ["../escape", "nested/escape", "", "Uppercase"]) {
			await rejectsCode(store.read(id), "invalid_plan_id");
		}
		for (const revision of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
			await rejectsCode(store.update("sample-plan", revision, makePlan(workspace)), "invalid_expected_revision");
		}
		assert.throws(() => createPlanStore(), { code: "workspace_unavailable" });
		assert.throws(() => createPlanStore({ workspacePath: "relative" }), { code: "invalid_workspace_path" });
		for (const busyTimeoutMs of [0, -1, 1.5, Infinity, 2_147_483_648]) {
			assert.throws(() => createPlanStore({ workspacePath: workspace, busyTimeoutMs }), { code: "invalid_storage_options" });
		}
		assert.deepEqual(await readdir(workspace), []);
	})
));

test("symlinked storage directories cannot escape the session workspace", async () => {
	for (const relative of ["files", path.join("files", "foundry")]) {
		await withWorkspace(async ({ workspace, store }) => {
			const outside = path.join(workspace, "outside");
			await mkdir(outside);
			const target = path.join(workspace, relative);
			await mkdir(path.dirname(target), { recursive: true });
			await symlink(outside, target);
			await rejectsCode(store.create(makePlan(workspace), 0), "path_outside_workspace");
			assert.deepEqual(await readdir(outside), []);
		});
	}
});

test("database and SQLite sidecar symlinks are rejected without touching their targets", async () => {
	for (const suffix of ["", "-journal", "-wal", "-shm"]) {
		await withWorkspace(async ({ workspace, store }) => {
			await store.list();
			const external = path.join(workspace, "external");
			await writeFile(external, "do not modify");
			if (!suffix) await rm(store.databasePath);
			await symlink(external, `${store.databasePath}${suffix}`);
			await rejectsCode(store.create(makePlan(workspace), 0), "artifact_unsafe");
			assert.equal(await readFile(external, "utf8"), "do not modify");
		});
	}
});

test("hard-linked databases and orphan sidecars are rejected", () => (
	withWorkspace(async ({ workspace, store }) => {
		await mkdir(store.directory, { recursive: true });
		const journal = `${store.databasePath}-journal`;
		await writeFile(journal, "orphan journal");
		await rejectsCode(store.list(), "artifact_unsafe");
		assert.equal(await readFile(journal, "utf8"), "orphan journal");
		await rm(journal);
		await store.list();
		await link(store.databasePath, path.join(workspace, "linked.sqlite"));
		await rejectsCode(store.list(), "artifact_unsafe");
	})
));

test("replacing an anchored directory or database is not silently accepted", async () => {
	await withWorkspace(async ({ workspace, store }) => {
		await store.create(makePlan(workspace), 0);
		await rename(store.directory, path.join(workspace, "original-foundry"));
		await mkdir(store.directory);
		await rejectsCode(store.read("sample-plan"), "path_outside_workspace");
		assert.deepEqual(await readdir(store.directory), []);
	});
	await withWorkspace(async ({ workspace, store }) => {
		await store.create(makePlan(workspace), 0);
		await rename(store.databasePath, path.join(workspace, "original.sqlite"));
		await writeFile(store.databasePath, "");
		await rejectsCode(store.read("sample-plan"), "artifact_changed");
		assert.equal((await readFile(store.databasePath)).length, 0);
	});
});

test("mutation callbacks cannot replace the database before the validated write", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		const saved = path.join(workspace, "saved.sqlite");
		await rejectsCode(store.mutate(plan.id, 1, (current) => {
			renameSync(store.databasePath, saved);
			writeFileSync(store.databasePath, "");
			return { ...current, title: "Must not land" };
		}), "artifact_changed");
		assert.equal((await readFile(store.databasePath)).length, 0);
		await rm(store.databasePath);
		await rename(saved, store.databasePath);
		assert.deepEqual(await store.read(plan.id), plan);
		assert.equal((await store.update(plan.id, 1, plan)).revision, 2);
	})
));

test("unknown database schemas and corrupt databases are preserved instead of recreated", async () => {
	await withWorkspace(async ({ workspace, store }) => {
		await store.create(makePlan(workspace), 0);
		withDatabase(store, (db) => db.exec("PRAGMA user_version = 999"));
		await rejectsCode(store.read("sample-plan"), "database_version_unsupported");
		assert.equal(withDatabase(store, (db) => db.prepare("SELECT count(*) AS count FROM plans").get()?.count), 1);
	});
	await withWorkspace(async ({ store }) => {
		await mkdir(store.directory, { recursive: true });
		await writeFile(store.databasePath, "not a SQLite database");
		await rejectsCode(store.list(), "database_error");
		assert.equal(await readFile(store.databasePath, "utf8"), "not a SQLite database");
	});
});
