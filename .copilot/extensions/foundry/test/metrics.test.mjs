import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { metricsFacts } from "../work/metrics.mjs";
import { usageQuery } from "../../../skills/foundry/scripts/usage.mjs";

const activation = 1700000000000, base = "a".repeat(40), tip = "b".repeat(40), commit = "c".repeat(40);
/** @returns {import("../work/model.js").Run} */
function run() {
	return { id: "catalog", owner: "owner", activatedAt: activation, active: true, nodes: {}, effects: [], products: [],
		policy: { id: "catalog", base, target: "refs/heads/main", source: ".foundry/test.json", direction: "Find a price",
			productCheck: "invariants", files: [], squads: [], repairs: 0 } };
}
/** @param {string} id */
const prompt = id => `Foundry assignment: catalog private-token-${id}\nImplement ${id}`;
/** @param {string} nativeId @param {number} [delta] @returns {import("../work/model.js").NativeCall} */
const writer = (nativeId, delta = 3) => ({ id: `effect-${nativeId}`, issuer: "owner", nativeId, state: "done", kind: "writer",
	tool: "create_session", args: { kickoff: { prompt: prompt(nativeId) } }, boundAt: activation + delta });

test("latencies use affirmative bindings and the exact qualifying product, not reservations, nodes or a goal checkpoint", () => {
	const r = run();
	r.goal = { commit, target: tip, check: "goal" };
	r.effects.push({ ...writer("reserved", 1), state: "ready" }, { ...writer("issued", 1), state: "issued" },
		{ ...writer("denied", 1), state: "refused" }, { ...writer("maybe", 1), state: "uncertain" });
	r.products.push({ commit: base, target: tip, outputs: {}, check: "previous" });
	assert.equal(metricsFacts(r).firstWriter.state, "unconfirmed");
	assert.equal(metricsFacts(r).qualified.commit, null);
	r.effects.push(writer("later", 30), writer("retired", 9));
	assert.deepEqual(metricsFacts(r).firstWriter, { state: "bound", boundAt: activation + 9, elapsedMs: 9, nativeIds: ["retired"] });
	r.active = false;
	assert.equal(metricsFacts(r).qualified.commit, null, "a stopped goal is not evidence that a checkpoint qualified");
	r.products.push({ commit, target: tip, outputs: { prices: base }, check: "final", qualifiedAt: activation + 99 });
	assert.deepEqual(metricsFacts(r).qualified, { commit, qualifiedAt: activation + 99, elapsedMs: 99, baseline: false });
	assert.ok(!JSON.stringify(metricsFacts(r)).includes("private-token"));
	delete r.effects.at(-1)?.boundAt;
	assert.equal(metricsFacts(r).firstWriter.elapsedMs, null, "an undated earlier binding cannot be ignored");
});

test("a qualified baseline needs no writer; paused/unfinished work and missing clocks have no finish time", () => {
	const r = run();
	r.active = false;
	r.goal = { commit: tip, target: tip, check: "goal" };
	r.products.push({ commit: tip, target: tip, outputs: {}, check: "product" });
	assert.equal(metricsFacts(r).qualified.elapsedMs, null);
	assert.equal(metricsFacts(r).firstWriter.state, "not-bound");
	r.products[0].qualifiedAt = activation + 10;
	const f = metricsFacts(r);
	assert.deepEqual(f.qualified, { commit: tip, qualifiedAt: activation + 10, elapsedMs: 10, baseline: true });
	assert.equal(f.firstWriter.state, "not-applicable"); assert.equal(f.firstWriter.elapsedMs, null);
	assert.equal(usageQuery(f).query, null); assert.equal(usageQuery(f).totalRunUsage, null);
	r.effects.push(writer("from-another-check"));
	delete r.products[0].qualifiedAt;
	assert.equal(metricsFacts(r).qualified.commit, null, "an undated checkpoint is not an accepted product");
	delete r.goal; r.products[0].qualifiedAt = activation + 6;
	assert.equal(metricsFacts(r).qualified.elapsedMs, 6, "a non-goal product qualifies at publication");
	r.products[0].qualifiedAt = activation - 1;
	assert.equal(metricsFacts(r).qualified.elapsedMs, null, "clock reversal is not zero elapsed time");
});

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

test("native IDs resolve through task_id or history id; only verified, bounded writer activity is billed", t => {
	const h = history(t), r = run(), a = "app-writer", b = "writer's-history", repair = "Foundry assignment: catalog private-repair\nRepair prices";
	r.effects.push(writer(a), writer(b), { id: "repair", issuer: "owner", kind: "repair", tool: "send_session_message",
		state: "done", args: { session_id: a, message: repair } });
	r.products.push({ commit, target: tip, check: "batch", outputs: {}, qualifiedAt: activation + 20 });
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
	const cli = spawnSync(process.execPath, [fileURLToPath(new URL("../../../skills/foundry/scripts/usage.mjs", import.meta.url))],
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
