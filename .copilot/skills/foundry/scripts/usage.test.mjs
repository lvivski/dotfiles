import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { metricsFacts } from "../../../extensions/foundry/work/metrics.mjs";
import { usageQuery } from "./usage.mjs";
import { activation, finished, prompt, run, writer } from "../../../extensions/foundry/test/timing.mjs";

/** Execute the generated native query, not a mock of its attribution algorithm. SQLite represents
 * both timestamps and epoch milliseconds as integers, so both DuckDB epoch_ms overloads are identities here.
 * @param {import("node:test").TestContext} t */
function history(t) {
	const db = new DatabaseSync(":memory:");
	t.after(() => db.close());
	db.function("epoch_ms", v => v);
	db.function("sha256", v => createHash("sha256").update(String(v)).digest("hex"));
	db.exec(`CREATE TABLE sessions(id TEXT, task_id TEXT, created_at INTEGER);
		CREATE TABLE events(session_id TEXT,timestamp INTEGER,type TEXT,user_content TEXT,usage_model TEXT,
		  usage_input_tokens INTEGER,usage_output_tokens INTEGER);`);
	const session = db.prepare("INSERT INTO sessions VALUES (?,?,?)"), event = db.prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?)");
	return {
		/** @param {string} id @param {string|null} task @param {number} [delta] */
		session: (id, task, delta = 1) => session.run(id, task, activation + delta),
		/** @param {string} id @param {number} delta @param {string} content @param {string} [type] */
		input: (id, delta, content, type = "user.message") => event.run(id, activation + delta, type, content, null, null, null),
		/** @param {string} id @param {number} delta @param {number|null} tokens @param {string} [model] */
		usage: (id, delta, tokens, model = "model") => event.run(id, activation + delta, "assistant.usage", null, model, tokens, 2),
		/** @param {string|null} sql */
		rows(sql) { assert.ok(sql); return db.prepare(sql).all(); },
	};
}

test("native IDs resolve through task_id or history id; only verified, bounded writer activity is billed", async t => {
	const h = history(t), r = await finished(t,20,true), a = "app-writer", b = "writer's-history", repair = "Foundry assignment: catalog private-repair\nRepair prices";
	r.effects.push(writer(a), writer(b), { id: "repair", issuer: "owner", kind: "repair", tool: "send_session_message",
		state: "done", args: { session_id: a, message: repair } });
	h.session("history-A", a); h.session(b, "another-task");
	h.session("owner", null, -10); h.session("workflow", null); h.session("helper", null);
	for (const id of ["owner", "workflow", "helper"]) { h.input(id, 2, prompt(a)); h.usage(id, 5, 1000); }
	h.input("history-A", 2, prompt(a)); h.usage("history-A", 2, 500); // kickoff precedes confirmed binding
	h.usage("history-A", 3, 6); h.usage("history-A", 4, 7); h.input("history-A", 5, repair); h.usage("history-A", 5, 100);
	h.input("history-A", 7, "Unrelated user task"); h.usage("history-A", 7, 100); // even a tie is ambiguous
	h.input("history-A", 9, repair); h.usage("history-A", 10, 200); // don't reopen a shared session
	h.input(b, 3, prompt(b)); h.usage(b, 3, 100); h.usage(b, 20, 0); h.usage(b, 21, 400);
	const facts = metricsFacts(r), plan = usageQuery(facts, activation + 999);
	assert.ok(typeof plan.query === "string");
	assert.equal(plan.through, activation + 20);
	assert.equal(plan.ownerUsage, null); assert.equal(plan.separateHelperUsage, null); assert.equal(plan.separateWorkflowUsage, null);
	assert.ok(plan.query && !plan.query.includes(repair) && !plan.query.includes(prompt(a)) && !plan.query.includes("session_usage"));
	const rows = h.rows(plan.query);
	assert.deepEqual(rows.map(x => [x.native_id, x.history_id, x.usage_records, x.input_tokens, x.output_tokens]), [
		[a, "history-A", 2, 13, 4], [b, b, 1, 0, 2],
	]);
	const cli = spawnSync(process.execPath, [fileURLToPath(new URL("./usage.mjs", import.meta.url))],
		{ input: JSON.stringify({ metrics: facts }), encoding: "utf8" });
	assert.equal(cli.status, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout), plan);
});

test("ambiguous links in either direction, missing history and mixed sessions give unknown, not zero", t => {
	const h = history(t), r = run();
	for (const id of ["many", "alias", "other-alias", "absent", "old", "decorated", "empty", "notified", "partial"])
		r.effects.push(writer(id));
	h.session("many", null); h.session("another-record", "many");
	h.session("alias", "other-alias"); h.session("old", null, -10);
	h.session("decorated", null); h.input("decorated", 2, `Copied from: ${prompt("decorated")}`);
	h.session("notified", null); h.input("notified", 2, prompt("notified")); h.input("notified", 4, "", "system.notification");
	for (const id of ["many", "alias", "old", "empty", "partial"]) {
		if (["empty", "partial"].includes(id)) h.session(id, null);
		h.input(id, 2, prompt(id));
	}
	for (const id of ["many", "alias", "another-record", "old", "decorated", "notified"]) h.usage(id, 5, 5);
	h.usage("partial", 4, 9); h.usage("partial", 5, null); h.usage("partial", 7, 100);
	const facts = metricsFacts(r);
	assert.equal(usageQuery(facts).query, null);
	const plan = usageQuery(facts, activation + 6);
	assert.ok(typeof plan.query === "string");
	assert.equal(plan.unfinished, true); assert.equal(facts.qualified.elapsedMs, null);
	const rows = h.rows(plan.query);
	for (const row of rows) {
		if (row.native_id === "partial") {
			assert.equal(row.usage_records, 2); assert.equal(row.input_tokens, null); assert.equal(row.output_tokens, 4);
		} else {
			assert.equal(row.usage_records, null); assert.equal(row.input_tokens, null);
			assert.equal(row.coverage, row.native_id === "decorated" ? "no verified kickoff in history"
				: row.native_id === "empty" || row.native_id === "notified" ? "no attributable usage observed" : "unmapped or ambiguous identity");
		}
	}
	assert.equal(rows.length, facts.history.writers.length);
});

test("verified hosted kickoff precedes a recovered binding; partial evidence cannot name the run's first kickoff", t => {
	const h = history(t), r = run(), twoHours = 7200000;
	r.effects.push(writer("recovered", twoHours), writer("quick-reply", 40));
	h.session("recovered-history", "recovered"); h.input("recovered-history", 20, prompt("recovered"));
	h.session("quick-reply", null); h.input("quick-reply", 50, prompt("quick-reply"));
	const rows = () => h.rows(usageQuery(metricsFacts(r), activation + twoHours).query);
	assert.equal(metricsFacts(r).firstWriter.elapsedMs, 40);
	assert.deepEqual(rows().map(x => [x.native_id, x.hosted_kickoff_elapsed_ms, x.first_hosted_kickoff_elapsed_ms]),
		[["quick-reply", 50, 20], ["recovered", 20, 20]]);
	r.effects.push({ ...writer("pending"), state: "uncertain" });
	assert.ok(rows().every(x => x.first_hosted_kickoff_elapsed_ms === null));
	r.effects.pop(); r.effects.push(writer("shared"));
	h.session("shared", null); h.input("shared", 3, "different task"); h.input("shared", 4, prompt("shared"));
	const partial = rows();
	assert.equal(partial.find(x => x.native_id === "shared")?.hosted_kickoff_elapsed_ms, null);
	assert.ok(partial.every(x => x.first_hosted_kickoff_elapsed_ms === null));
});

test("history's 10,000-row cap cannot turn a truncated result into a run total", t => {
	const h = history(t), r = run();
	r.effects.push(writer("w")); h.session("w", null); h.input("w", 2, prompt("w"));
	for (let i = 0; i <= 10000; i++) h.usage("w", 4, 1, `m${i}`);
	const rows = h.rows(usageQuery(metricsFacts(r), activation + 5).query);
	assert.equal(rows.length, 1); assert.equal(rows[0].result_rows, 10001);
	assert.match(String(rows[0].coverage), /limit/); assert.equal(rows[0].input_tokens, null);
});
