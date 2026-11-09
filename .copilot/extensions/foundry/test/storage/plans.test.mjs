import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	lstat,
	mkdir,
	readFile,
	readdir,
	symlink,
	writeFile
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseJson, readRecord, readString } from "../../data.mjs";
import { PLAN_STATUS } from "../../plan/values.mjs";
import { createPlanStore } from "../../storage.mjs";
import { CREATED_AT, UPDATED_AT, makePlan, rejectsCode, withDatabase, withWorkspace } from "./fixture.mjs";

test("native SQLite is required explicitly, with no package fallback", async () => {
	const moduleUrl = new URL("../../storage.mjs", import.meta.url).href;
	const { stdout } = await promisify(execFile)(process.execPath, [
		"--no-experimental-sqlite",
		"--input-type=module",
		"-e",
		`try { await import(${JSON.stringify(moduleUrl)}); process.exitCode = 1; }
		catch (error) { console.log(JSON.stringify({code: error.code, message: error.message})); }`,
	]);
	const error = readRecord(parseJson(stdout));
	assert.equal(error.code, "sqlite_unavailable");
	assert.match(readString(error.message), /Node\.js 22\.13\+/);
	assert.match(readString(error.message), /node:sqlite/);
});

test("create, restart, read, and list use a real SQLite database", () => withWorkspace(async ({ workspace, store }) => {
	const plan = makePlan(workspace);
	await rejectsCode(store.create(plan), "invalid_expected_revision");
	assert.deepEqual(await store.create(plan, 0), plan);
	const restarted = createPlanStore({ workspacePath: workspace });
	assert.deepEqual(await restarted.read(plan.id), plan);
	assert.deepEqual((await restarted.list()).plans.map(({ id, revision }) => ({ id, revision })), [
		{ id: plan.id, revision: 1 },
	]);
	assert.equal((await readFile(store.databasePath)).subarray(0, 16).toString(), "SQLite format 3\0");
	assert.deepEqual(await readdir(store.directory), ["foundry.sqlite"]);
	assert.deepEqual(withDatabase(store, (db) => db.prepare(
		"SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
	).all().map(({ name }) => name)), ["activation", "plans", "quarantine"]);
	assert.equal(withDatabase(store, (db) => db.prepare("PRAGMA integrity_check").get()?.integrity_check), "ok");
}));

test("old JSON, markers, links, leases, and temporary files are ignored and preserved", () => (
	withWorkspace(async ({ workspace, store }) => {
		await mkdir(store.directory, { recursive: true });
		const originals = new Map([
			["sample-plan.json", JSON.stringify({ ...makePlan(workspace), title: "Old authority" })],
			["broken-plan.json", "not JSON"],
			[".active-plan.json", JSON.stringify({ planId: "sample-plan", activatedAt: CREATED_AT })],
			[".sample-plan.json.lock", JSON.stringify({ pid: process.pid })],
			[".foundry-recovery.lock", "old recovery state"],
			[".sample-plan.json.old.tmp", "unfinished old write"],
		]);
		for (const [filename, source] of originals) await writeFile(path.join(store.directory, filename), source);
		const external = path.join(workspace, "external.json");
		await writeFile(external, "external bytes");
		const linked = path.join(store.directory, "linked-plan.json");
		await symlink(external, linked);
		assert.deepEqual(await store.list(), { plans: [], invalid: [], truncated: false });
		assert.equal(await store.getActivation(), null);
		assert.equal(await store.getActive(), null);
		await rejectsCode(store.read("sample-plan"), "plan_not_found");
		await store.create(makePlan(workspace), 0);
		assert.equal((await store.read("sample-plan")).title, "Plan sample-plan");
		for (const [filename, source] of originals) {
			assert.equal(await readFile(path.join(store.directory, filename), "utf8"), source);
		}
		await writeFile(path.join(store.directory, "sample-plan.json"), "{ changed by an old writer");
		assert.equal((await store.read("sample-plan")).revision, 1);
		assert.equal((await lstat(linked)).isSymbolicLink(), true);
		assert.equal(await readFile(external, "utf8"), "external bytes");
		assert.equal(Object.hasOwn(store, "migrateLegacy"), false);
		assert.equal(Object.hasOwn(store, "recoverStaleLocks"), false);
	})
));

test("stored documents and results own all nested data", () => withWorkspace(async ({ workspace, store }) => {
	const input = makePlan(workspace);
	const expected = structuredClone(input);
	const created = await store.create(input, 0);
	input.tasks[0].acceptanceCriteria[0] = "Input mutation";
	assert.deepEqual(created, expected);
	created.tasks[0].expectedFiles.push("result.mjs");
	assert.deepEqual(await store.read(input.id), expected);
	const candidate = await store.read(input.id);
	candidate.tasks[0].acceptanceCriteria[0] = "Updated criterion";
	const updated = await store.update(input.id, 1, candidate);
	const expectedUpdated = structuredClone(updated);
	assert.equal(candidate.revision, 1);
	assert.equal(candidate.updatedAt, CREATED_AT);
	candidate.tasks[0].acceptanceCriteria[0] = "Candidate mutation";
	updated.tasks[0].expectedFiles.push("another.mjs");
	assert.deepEqual(await store.read(input.id), expectedUpdated);
}));

test("mutate receives one owned snapshot and commits one stamped revision", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		/** @type {import("../../types/plan.js").FoundryPlan[]} */
		const received = [];
		let calls = 0;
		const updated = await store.mutate(plan.id, 1, (current) => {
			calls += 1;
			assert.deepEqual(current, plan);
			received.push(current);
			current.title = "Synchronous mutation";
			current.revision = 100;
			return current;
		});
		assert.equal(calls, 1);
		assert.equal(updated.revision, 2);
		assert.equal(updated.updatedAt, UPDATED_AT);
		assert.equal(received.length, 1);
		received[0].tasks[0].expectedFiles.push("late.mjs");
		assert.deepEqual(await store.read(plan.id), updated);
	})
));

test("stale revisions never call the mutator or overwrite the winner", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		await store.update(plan.id, 1, { ...plan, title: "Winner" });
		await rejectsCode(store.mutate(plan.id, 1, () => assert.fail("stale callback ran")), "revision_conflict",
			(error) => assert.deepEqual(error.details, { id: plan.id, expectedRevision: 1, latestRevision: 2 }));
		assert.equal((await store.read(plan.id)).title, "Winner");
	})
));

test("invalid candidates, invalid clocks, and immutable identities roll back", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		await rejectsCode(store.mutate(plan.id, 1, (current) => {
			current.tasks[0].acceptanceCriteria = [];
			return current;
		}), "candidate_invalid", (error) => assert.equal(readRecord(error.details).validationCode, "array_too_short"));
		for (const changes of [{ id: "replacement-id" }, { createdAt: "2026-08-05T15:00:00.000Z" }]) {
			await rejectsCode(store.mutate(plan.id, 1, (current) => Object.assign(current, changes)), "immutable_plan_identity");
		}
		const badClock = createPlanStore({ workspacePath: workspace, clock: () => "not a timestamp" });
		await rejectsCode(badClock.update(plan.id, 1, plan), "invalid_clock");
		assert.deepEqual(await store.read(plan.id), plan);
		assert.equal((await store.update(plan.id, 1, plan)).revision, 2);
	})
));

test("thrown values survive rollback and do not leave a writer lock", async () => {
	for (const failure of [new Error("clock failed"), { code: 17 }, "", null, undefined, false, 0]) {
		await withWorkspace(async ({ workspace, store }) => {
			const plan = await store.create(makePlan(workspace), 0);
			const failing = createPlanStore({ workspacePath: workspace, clock: () => { throw failure; } });
			await assert.rejects(failing.update(plan.id, 1, plan), (error) => {
				assert.equal(error, failure);
				return true;
			});
			await assert.rejects(store.mutate(plan.id, 1, () => { throw failure; }), (error) => {
				assert.equal(error, failure);
				return true;
			});
			assert.deepEqual(await store.read(plan.id), plan);
			assert.equal((await store.update(plan.id, 1, plan)).revision, 2);
		});
	}
});

test("async and thenable mutations are rejected without committing", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		await rejectsCode(store.mutate(plan.id, 1, async () => {
			assert.fail("async callback must not execute");
		}), "invalid_mutation");
		await rejectsCode(store.mutate(plan.id, 1, () => Promise.reject(new Error("async failure"))), "invalid_mutation");
		await rejectsCode(store.mutate(plan.id, 1, () => ({ then: (/** @type {(value: unknown) => void} */ resolve) => resolve(plan) })), "invalid_mutation");
		for (const value of [null, undefined, "invalid", []]) {
			await rejectsCode(store.mutate(plan.id, 1, () => value), "candidate_invalid");
		}
		assert.deepEqual(await store.read(plan.id), plan);
	})
));

test("custom JSON hooks cannot change the validated persisted candidate", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		const candidate = { ...plan, title: "Owned serialization" };
		Object.defineProperty(candidate, "toJSON", { value: () => ({ invalid: true }), enumerable: false });
		const updated = await store.update(plan.id, 1, candidate);
		assert.equal(updated.title, "Owned serialization");
		assert.deepEqual(await store.read(plan.id), updated);
	})
));

test("create and import reject invalid input without reserving the ID", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = makePlan(workspace);
		await rejectsCode(store.create({ ...plan, revision: 2 }, 0), "invalid_new_plan");
		await rejectsCode(store.create({ ...plan, status: PLAN_STATUS.AWAITING_APPROVAL }, 0), "invalid_new_plan");
		await rejectsCode(store.importPlan("{", { expectedRevision: 0 }), "import_invalid");
		await rejectsCode(store.importPlan({ ...plan, unexpected: true }, { expectedRevision: 0 }), "import_invalid");
		// @ts-expect-error Exercise missing optimistic-concurrency evidence at the JSON boundary.
		await rejectsCode(store.importPlan(plan, {}), "invalid_expected_revision");
		// @ts-expect-error Import must reject a nonzero creation revision.
		await rejectsCode(store.importPlan(plan, { expectedRevision: 1 }), "invalid_expected_revision");
		assert.equal((await store.list()).plans.length, 0);
		assert.deepEqual(await store.create(plan, 0), plan);
	})
));

test("JSON export/import roundtrips ordinary plan JSON, preserving status and revision", () => (
	withWorkspace(async ({ workspace, store }) => {
		const draft = await store.create(makePlan(workspace), 0);
		const plan = await store.update(draft.id, 1, { ...draft, status: PLAN_STATUS.AWAITING_APPROVAL });
		const json = await store.exportPlan(plan.id);
		assert.equal(json, `${JSON.stringify(plan, null, 2)}\n`);
		assert.deepEqual(parseJson(json), plan);
		await withWorkspace(async ({ store: destination }) => {
			assert.deepEqual(await destination.importPlan(json, { expectedRevision: 0 }), plan);
			assert.equal(await destination.exportPlan(plan.id), json);
			await rejectsCode(destination.importPlan(json, { expectedRevision: 0 }), "plan_exists");
			const next = await destination.mutate(plan.id, plan.revision, (current) => ({ ...current, title: "Imported update" }));
			assert.equal(next.revision, plan.revision + 1);
		});
		const object = { ...plan, id: "object-import" };
		const imported = await store.importPlan(object, { expectedRevision: 0 });
		object.tasks[0].expectedFiles.push("caller.mjs");
		assert.deepEqual(await store.read(imported.id), imported);
	})
));

test("revision overflow fails validation instead of writing an unsafe integer", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = { ...makePlan(workspace), revision: Number.MAX_SAFE_INTEGER };
		await store.importPlan(plan, { expectedRevision: 0 });
		await rejectsCode(store.update(plan.id, plan.revision, plan), "candidate_invalid");
		assert.deepEqual(await store.read(plan.id), plan);
	})
));

test("corrupt stored plans are never silently overwritten or exported", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		withDatabase(store, (db) => db.prepare("UPDATE plans SET document = ? WHERE id = ?").run("{ corrupted", plan.id));
		await rejectsCode(store.read(plan.id), "artifact_invalid");
		await rejectsCode(store.exportPlan(plan.id), "artifact_invalid");
		await rejectsCode(store.update(plan.id, 1, plan), "artifact_invalid");
		await rejectsCode(store.create(plan, 0), "artifact_invalid");
		await rejectsCode(store.importPlan(plan, { expectedRevision: 0 }), "artifact_invalid");
		assert.equal(withDatabase(store, (db) => db.prepare("SELECT document FROM plans WHERE id = ?").get(plan.id)?.document),
			"{ corrupted");
	})
));

test("stored identity and revision inconsistencies are rejected", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		withDatabase(store, (db) => db.prepare("UPDATE plans SET document = ? WHERE id = ?")
			.run(JSON.stringify({ ...plan, id: "different-id" }), plan.id));
		await rejectsCode(store.read(plan.id), "artifact_identity_mismatch");
		withDatabase(store, (db) => db.prepare("UPDATE plans SET document = ? WHERE id = ?")
			.run(JSON.stringify({ ...plan, revision: 2 }), plan.id));
		await rejectsCode(store.read(plan.id), "artifact_invalid");
		await rejectsCode(store.quarantineInvalidPlan(plan.id, { reason: "Valid JSON", requestedBy: "tester" }), "artifact_valid");
	})
));

test("bounded listing includes invalid records without hiding them or exposing full documents", () => (
	withWorkspace(async ({ workspace, store }) => {
		const alpha = { ...makePlan(workspace, "alpha-plan"), objective: "a".repeat(240) };
		alpha.planning = { runId: "planning-run", inputDigest: "a".repeat(64) };
		await store.create(alpha, 0);
		await store.create({ ...makePlan(workspace, "beta-plan"), objective: "b".repeat(241) }, 0);
		withDatabase(store, (db) => db.prepare("INSERT INTO plans (id, revision, document) VALUES (?, 1, ?)")
			.run("broken-plan", "{"));
		const page = await store.list({ limit: 2 });
		assert.equal(page.truncated, true);
		assert.deepEqual(page.plans.map(({ id }) => id), ["alpha-plan", "beta-plan"]);
		assert.equal(page.plans[0].objective.length, 240);
		assert.equal(page.plans[0].planningRunId, "planning-run");
		assert.equal(page.plans[1].objective, `${"b".repeat(237)}...`);
		assert.equal(Object.hasOwn(page.plans[0], "tasks"), false);
		const full = await store.list({ limit: 3 });
		assert.equal(full.truncated, false);
		assert.equal(full.invalid[0].id, "broken-plan");
		assert.equal(full.invalid[0].code, "artifact_invalid");
		assert.equal(readRecord(full.invalid[0].details).id, "broken-plan");
		for (const limit of [0, -1, 101, 1.5, NaN]) await rejectsCode(store.list({ limit }), "invalid_list_limit");
	})
));

test("default and maximum list limits bound the combined result", () => (
	withWorkspace(async ({ workspace, store }) => {
		for (let index = 0; index < 101; index += 1) {
			await store.create(makePlan(workspace, `plan-${String(index).padStart(3, "0")}`), 0);
		}
		const defaultPage = await store.list();
		assert.equal(defaultPage.plans.length + defaultPage.invalid.length, 50);
		assert.equal(defaultPage.truncated, true);
		const maximumPage = await store.list({ limit: 100 });
		assert.equal(maximumPage.plans.length + maximumPage.invalid.length, 100);
		assert.equal(maximumPage.truncated, true);
	})
));
