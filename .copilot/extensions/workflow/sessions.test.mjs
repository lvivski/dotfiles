/** @module sessions.test — child-session disposal: id safety, directory removal, store purge, run policy. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deleteSessions, isSafeSessionId, keepSessions, purgeSessionStore, sessionStateDir, sessionStorePath } from "./sessions.mjs";
import { Runtime } from "./runtime.mjs";
import { mkResult, withFakeEnv } from "./fixtures/support.mjs";

/** Create a populated session-state directory. @param {string} id @returns {string} */
function makeSessionDir(id) {
	const dir = sessionStateDir(id);
	mkdirSync(join(dir, "files"), { recursive: true });
	writeFileSync(join(dir, "events.jsonl"), '{"type":"session.start"}\n');
	return dir;
}

/** Build a session store with the CLI's per-session tables. @returns {Promise<any>} */
async function makeStore(/** @type {string[]} */ ids) {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(sessionStorePath());
	db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT)");
	db.exec("CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), user_message TEXT)");
	db.exec("CREATE TABLE session_files (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, file_path TEXT)");
	db.exec("CREATE VIRTUAL TABLE search_index USING fts5(content, session_id UNINDEXED)");
	for (const id of ids) {
		db.prepare("INSERT INTO sessions (id, summary) VALUES (?, ?)").run(id, `summary ${id}`);
		db.prepare("INSERT INTO turns (session_id, user_message) VALUES (?, ?)").run(id, "hi");
		db.prepare("INSERT INTO session_files (session_id, file_path) VALUES (?, ?)").run(id, "/tmp/f");
		db.prepare("INSERT INTO search_index (content, session_id) VALUES (?, ?)").run("hello world", id);
	}
	return db;
}

test("isSafeSessionId rejects anything that could escape session-state/", () => {
	assert.ok(isSafeSessionId("2f1c6f3a-0d84-4c0e-9d2a-4b1c9f0f7a11"));
	assert.ok(isSafeSessionId("fake-abc123"));
	for (const bad of ["", ".", "..", "a/b", "a\\b", "a\u0000b", "x".repeat(256), 42, null, undefined]) {
		assert.ok(!isSafeSessionId(bad), `${String(bad)} must be rejected`);
	}
});

test("deleteSessions removes state directories and reports unsafe ids as skipped", async () => {
	await withFakeEnv({}, async () => {
		const keep = makeSessionDir("keep-me");
		const gone = makeSessionDir("delete-me");
		const res = await deleteSessions(["delete-me", "../escape", "missing-session"]);
		assert.ok(!existsSync(gone), "targeted session directory removed");
		assert.ok(existsSync(keep), "untargeted session untouched");
		assert.deepEqual(res.deleted.sort(), ["delete-me", "missing-session"], "a vanished session counts as deleted");
		assert.deepEqual(res.skipped, ["../escape"]);
	});
});

test("deleteSessions purges every table holding the session's rows", async () => {
	await withFakeEnv({}, async () => {
		makeSessionDir("s1");
		makeSessionDir("s2");
		const db = await makeStore(["s1", "s2"]);
		db.close();

		const res = await deleteSessions(["s1"]);
		assert.deepEqual(res.warnings, []);
		assert.ok(res.purgedRows >= 4, `expected rows across all tables, got ${res.purgedRows}`);

		const { DatabaseSync } = await import("node:sqlite");
		const check = new DatabaseSync(sessionStorePath());
		for (const [sql, expected] of [
			["SELECT count(*) AS n FROM sessions", 1],
			["SELECT count(*) AS n FROM turns", 1],
			["SELECT count(*) AS n FROM session_files", 1],
			["SELECT count(*) AS n FROM search_index", 1],
		]) {
			assert.equal(/** @type {any} */ (check.prepare(String(sql)).get()).n, expected, String(sql));
		}
		assert.equal(/** @type {any} */ (check.prepare("SELECT id FROM sessions").get()).id, "s2", "the untargeted session survives");
		check.close();
	});
});

test("deleteSessions leaves the store alone when purging is disabled", async () => {
	await withFakeEnv({}, async () => {
		makeSessionDir("s1");
		const db = await makeStore(["s1"]);
		db.close();
		const res = await deleteSessions(["s1"], { purgeStore: false });
		assert.equal(res.purgedRows, 0);
		const { DatabaseSync } = await import("node:sqlite");
		const check = new DatabaseSync(sessionStorePath());
		assert.equal(/** @type {any} */ (check.prepare("SELECT count(*) AS n FROM sessions").get()).n, 1);
		check.close();
	});
});

test("purgeSessionStore is a no-op without a store and never throws", async () => {
	await withFakeEnv({}, async () => {
		assert.deepEqual(await purgeSessionStore(["s1"]), { rows: 0, warnings: [] });
		assert.deepEqual(await purgeSessionStore([]), { rows: 0, warnings: [] });
	});
});

test("keepSessions follows CWF_KEEP_SESSIONS", async () => {
	await withFakeEnv({}, () => assert.equal(keepSessions(), false));
	await withFakeEnv({ CWF_KEEP_SESSIONS: "1" }, () => assert.equal(keepSessions(), true));
});

/** Drive a runtime's agents through a stub backend that reports the given results. */
function stubRuntime(/** @type {import("./agent.mjs").AgentResult[]} */ results) {
	let i = 0;
	return new Runtime({
		agentBackend: {
			kind: "stub",
			run: async () => results[Math.min(i++, results.length - 1)],
		},
		progress: () => {},
		log: () => {},
	});
}

test("a complete run disposes of its agent sessions", async () => {
	await withFakeEnv({}, async () => {
		makeSessionDir("child-1");
		const rt = stubRuntime([mkResult({ sessionId: "child-1" })]);
		await rt.agent("hi");
		const res = await rt.cleanupSessions({ status: "complete" });
		assert.deepEqual(res, { deleted: ["child-1"], preserved: [] });
		assert.ok(!existsSync(sessionStateDir("child-1")), "session directory removed");
	});
});

test("a failed agent's session is preserved even when the run completes", async () => {
	await withFakeEnv({}, async () => {
		makeSessionDir("ok-1");
		makeSessionDir("bad-1");
		const rt = stubRuntime([mkResult({ sessionId: "ok-1" }), mkResult({ sessionId: "bad-1", ok: false, error: "boom" })]);
		await rt.agent("first");
		await rt.agent("second");
		const res = await rt.cleanupSessions({ status: "complete" });
		assert.deepEqual(res.deleted, ["ok-1"]);
		assert.deepEqual(res.preserved, ["bad-1"]);
		assert.ok(existsSync(sessionStateDir("bad-1")), "failed session kept for inspection");
	});
});

test("a run that did not complete keeps every session (it may still be resumed)", async () => {
	await withFakeEnv({}, async () => {
		makeSessionDir("child-1");
		const rt = stubRuntime([mkResult({ sessionId: "child-1" })]);
		await rt.agent("hi");
		const res = await rt.cleanupSessions({ status: "partial" });
		assert.deepEqual(res, { deleted: [], preserved: ["child-1"] });
		assert.ok(existsSync(sessionStateDir("child-1")), "session directory kept");
	});
});

test("a failed follow-up preserves the session its earlier turn succeeded on", async () => {
	await withFakeEnv({}, async () => {
		makeSessionDir("child-1");
		const rt = stubRuntime([mkResult({ sessionId: "child-1" }), mkResult({ sessionId: "child-1", ok: false, error: "boom" })]);
		const first = await rt.agent("hi");
		await rt.followUp(first, "more");
		const res = await rt.cleanupSessions({ status: "complete" });
		assert.deepEqual(res, { deleted: [], preserved: ["child-1"] });
	});
});

test("a session the harness asked to resume is never adopted or deleted", async () => {
	await withFakeEnv({}, async () => {
		makeSessionDir("foreign");
		const rt = stubRuntime([mkResult({ sessionId: "foreign" })]);
		await rt.agent({ prompt: "hi", resume: "foreign" });
		const res = await rt.cleanupSessions({ status: "complete" });
		assert.deepEqual(res, { deleted: [], preserved: [] });
		assert.ok(existsSync(sessionStateDir("foreign")), "a session we did not create is left alone");
	});
});

test("CWF_KEEP_SESSIONS=1 preserves everything", async () => {
	await withFakeEnv({ CWF_KEEP_SESSIONS: "1" }, async () => {
		makeSessionDir("child-1");
		const rt = stubRuntime([mkResult({ sessionId: "child-1" })]);
		await rt.agent("hi");
		const res = await rt.cleanupSessions({ status: "complete" });
		assert.deepEqual(res, { deleted: [], preserved: ["child-1"] });
		assert.ok(existsSync(sessionStateDir("child-1")));
	});
});

test("dry runs track no sessions, and cleanup is idempotent", async () => {
	await withFakeEnv({}, async () => {
		const rt = new Runtime({ dryRun: true, progress: () => {}, log: () => {} });
		await rt.agent("hi");
		assert.deepEqual(await rt.cleanupSessions({ status: "complete" }), { deleted: [], preserved: [] });

		makeSessionDir("child-1");
		const live = stubRuntime([mkResult({ sessionId: "child-1" })]);
		await live.agent("hi");
		assert.deepEqual((await live.cleanupSessions({ status: "complete" })).deleted, ["child-1"]);
		assert.deepEqual(await live.cleanupSessions({ status: "complete" }), { deleted: [], preserved: [] });
	});
});
