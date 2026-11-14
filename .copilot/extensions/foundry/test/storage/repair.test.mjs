import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildPlanningArgs } from "../../analysis/planning.mjs";
import { buildRepairEffect, buildRepairPreparation, repairMaterial } from "../../analysis/repair.mjs";
import { createPlanStore } from "../../storage.mjs";
import { createRepairJournal } from "../../storage/repair.mjs";
import { createFixtureRepairHost, planningResult } from "../native/plans.mjs";
import { admitRepairEffect } from "../../native/repair.mjs";
import { readJsonValue } from "../../data.mjs";
import { deferred } from "../promises.mjs";

async function fixture() {
	const workspacePath = mkdtempSync(path.join(process.cwd(), "repair-store-"));
	const sessionId = "synthetic-owner";
	await createPlanStore({ workspacePath }).list();
	const input = buildPlanningArgs({ objective: "Conserve checks", constraints: [], repositoryContext: "Synthetic persistence fixture" });
	const original = planningResult(input);
	const preparation = buildRepairPreparation({
		owner: workspacePath, sessionId, rootRunId: "source", sourceDigest: "a".repeat(64), mode: "recovery",
		repositoryPath: null, authority: null, source: null,
		material: repairMaterial({ input, candidate: original.plan, critiques: original.critiques, diagnostics: ["semantic failure"], verification: { passed: false, issues: ["semantic failure"] }, stage: "semantic", decomposition: null }),
	});
	return { workspacePath, sessionId, preparation, journal: createRepairJournal({ workspacePath, sessionId }) };
}

/** @param {Awaited<ReturnType<typeof fixture>>} f @param {"prepare"|"intent"} operation */
function child(f, operation) {
	const module = new URL("../../storage/repair.mjs", import.meta.url).href;
	const code = `import {createRepairJournal} from ${JSON.stringify(module)};
const preparation=${JSON.stringify(f.preparation)};
const journal=createRepairJournal(${JSON.stringify({ workspacePath: f.workspacePath, sessionId: f.sessionId })});
try { const result=journal.${operation}(${operation === "prepare" ? "preparation" : "preparation.id, preparation.digest"}); console.log(JSON.stringify({state:result.state,id:result.preparation.id})); }
catch(error){ console.log(JSON.stringify({code:error.code,message:error.message})); }`;
	return new Promise((resolve, reject) => {
		const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		process.stdout.on("data", data => { stdout += data; });
		process.stderr.on("data", data => { stderr += data; });
		process.on("error", reject);
		process.on("close", exit => exit === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
	});
}

test("SPR-11/12/20: canonical schema3 journal serializes multiple connections/processes and survives restart", async () => {
	const f = await fixture();
	const rows = await Promise.all([child(f, "prepare"), child(f, "prepare"), child(f, "prepare")]);
	assert.equal(new Set(rows.map(row => JSON.stringify(row))).size, 1);
	const admissions = await Promise.all([child(f, "intent"), child(f, "intent"), child(f, "intent")]);
	assert.equal(admissions.filter(row => row.state === "intent").length, 1);
	assert.equal(admissions.filter(row => row.code === "repair_admission_held").length, 2);
	const restarted = createRepairJournal({ workspacePath: f.workspacePath, sessionId: f.sessionId });
	assert.equal(restarted.read(f.preparation.id, f.preparation.digest).state, "intent");
	assert.throws(() => restarted.intent(f.preparation.id, f.preparation.digest), { code: "repair_admission_held" });
	assert.equal(restarted.events(f.preparation.id, f.preparation.digest).filter(event => event.event === "intent").length, 1);
	const db = new DatabaseSync(f.journal.databasePath);
	assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 3);
	assert.equal(db.prepare("PRAGMA application_id").get()?.application_id, 0x464e4452);
	assert.equal(db.prepare("SELECT COUNT(*) AS count FROM planning_repairs").get()?.count, 1);
	assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE name='approval_delegations'").get());
	db.close();
});

test("SPR-12/20: transaction failure rolls back atomically without erasing a prior claim", async () => {
	const f = await fixture();
	f.journal.prepare(f.preparation);
	const db = new DatabaseSync(f.journal.databasePath);
	db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON planning_repair_events WHEN NEW.event='intent' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END");
	assert.throws(() => f.journal.intent(f.preparation.id, f.preparation.digest));
	assert.equal(f.journal.read(f.preparation.id, f.preparation.digest).state, "prepared");
	assert.equal(f.journal.events(f.preparation.id, f.preparation.digest).length, 1);
	db.exec("DROP TRIGGER reject_event");
	db.close();
	f.journal.intent(f.preparation.id, f.preparation.digest);
	f.journal.outcome(f.preparation.id, f.preparation.digest, "uncertain", null, { error: "interrupted native result recording" });
	const restarted = createRepairJournal({ workspacePath: f.workspacePath, sessionId: f.sessionId });
	assert.equal(restarted.prepare(f.preparation).state, "uncertain");
	assert.throws(() => restarted.intent(f.preparation.id, f.preparation.digest), { code: "repair_admission_held" });
	assert.throws(() => restarted.prepare(buildRepairPreparation({ ...f.preparation, rootRunId: "fresh-id" })), { code: "repair_budget_claimed" });
});

test("SPR-11/12/20: denial, unavailable route and foreign/schema authority never reset claims", async () => {
	for (const state of /** @type {const} */ (["denied", "unavailable", "uncertain"])) {
		const f = await fixture();
		f.journal.prepare(f.preparation);
		f.journal.intent(f.preparation.id, f.preparation.digest);
		f.journal.outcome(f.preparation.id, f.preparation.digest, state, null, { resultType: state });
		const restarted = createRepairJournal({ workspacePath: f.workspacePath, sessionId: f.sessionId });
		assert.equal(restarted.prepare(f.preparation).state, state);
		assert.throws(() => restarted.intent(f.preparation.id, f.preparation.digest), { code: "repair_admission_held" });
		const foreign = createRepairJournal({ workspacePath: f.workspacePath, sessionId: "foreign" });
		assert.throws(() => foreign.read(f.preparation.id, f.preparation.digest), { code: "repair_foreign_owner" });
	}
	const f = await fixture();
	for (const [version, application] of [[4, 0x464e4452], [3, 0x464e4144], [2, 0x464e4452]]) {
		const db = new DatabaseSync(f.journal.databasePath);
		db.exec(`PRAGMA user_version=${version}; PRAGMA application_id=${application}`);
		db.close();
		assert.throws(() => createRepairJournal({ workspacePath: f.workspacePath, sessionId: f.sessionId }), { code: "repair_storage_authority" });
	}
});

test("LP09/10/12: legacy consumed claims cannot acquire a fabricated comparator baseline or another author effect", async () => {
	const f = await fixture();
	f.journal.prepare(f.preparation);
	f.journal.intent(f.preparation.id, f.preparation.digest);
	f.journal.outcome(f.preparation.id, f.preparation.digest, "uncertain", null, { original: "immutable failed admission" });
	const events = f.journal.events(f.preparation.id, f.preparation.digest);
	const native = createFixtureRepairHost(f.journal.databasePath, { remaining: 1, resourceId: "legacy-must-not-consume" });
	try {
		f.journal.prepare(f.preparation, readJsonValue(await native.host.prepare(f.preparation)));
		assert.deepEqual(f.journal.comparisonHistory(f.preparation.id, f.preparation.digest), [null]);
		assert.deepEqual(f.journal.events(f.preparation.id, f.preparation.digest), events);
		assert.throws(() => f.journal.begin(f.preparation.id, f.preparation.digest, "fresh-run"), { code: "repair_admission_unavailable" });
		assert.equal(native.remaining(), 1);
	} finally { native.close(); }
});

test("LP10-12/16: distinct native effects sharing one explicitly remaining resource cannot overspend", async () => {
	const f = await fixture();
	const native = createFixtureRepairHost(f.journal.databasePath, { remaining: 1, resourceId: "one-native-resource" });
	try {
		f.journal.prepare(f.preparation, readJsonValue(await native.host.prepare(f.preparation)));
		const history = f.journal.comparisonHistory(f.preparation.id, f.preparation.digest);
		const effect = buildRepairEffect(f.preparation, "author", history, f.preparation.material.candidate, f.preparation.material.diagnostics, "run-one", { native: "author" });
		const other = buildRepairEffect(f.preparation, "author", history, f.preparation.material.candidate, f.preparation.material.diagnostics, "run-two", { native: "author" });
		let calls = 0;
		const receipts = await Promise.allSettled([effect, other].map(value => admitRepairEffect(native.host, f.journal, value, history, async () => { calls++; return { original: "native output" }; })));
		assert.equal(receipts.filter(value => value.status === "fulfilled").length, 1);
		assert.equal(calls, 1);
		assert.equal(native.remaining(), 0);
		assert.equal(f.journal.effects(f.preparation.id, f.preparation.digest).length, 2);
	} finally { native.close(); }
});

test("LP10-12: native consumed receipt survives local journal conflict/restart and uncertain execution never duplicates", async () => {
	const f = await fixture();
	const grant = { remaining: 2, resourceId: "restart-native-resource" };
	let native = createFixtureRepairHost(f.journal.databasePath, grant);
	f.journal.prepare(f.preparation, readJsonValue(await native.host.prepare(f.preparation)));
	const history = f.journal.comparisonHistory(f.preparation.id, f.preparation.digest);
	const effect = buildRepairEffect(f.preparation, "author", history, f.preparation.material.candidate, f.preparation.material.diagnostics, "once-run", { native: "author" });
	const db = new DatabaseSync(f.journal.databasePath);
	db.exec("CREATE TRIGGER reject_native_receipt BEFORE INSERT ON planning_repair_events WHEN NEW.event='effect-receipt' BEGIN SELECT RAISE(ABORT,'synthetic receipt write conflict'); END");
	let calls = 0;
	await assert.rejects(admitRepairEffect(native.host, f.journal, effect, history, async () => { calls++; return { full: "output" }; }));
	assert.equal(native.remaining(), 1);
	db.exec("DROP TRIGGER reject_native_receipt");
	db.close();
	native.close();
	native = createFixtureRepairHost(f.journal.databasePath, grant);
	try {
		const replay = await admitRepairEffect(native.host, f.journal, effect, history, async () => { calls++; return {}; });
		assert.deepEqual(replay.output, { full: "output" });
		assert.equal(calls, 1);
		assert.equal(native.remaining(), 1);
		const conflicting = { ...effect, operation: { native: "changed" } };
		await assert.rejects(admitRepairEffect(native.host, f.journal, conflicting, history, async () => { calls++; return {}; }), { code: "repair_effect_conflict" });
		const uncertain = buildRepairEffect(f.preparation, "author", history, f.preparation.material.candidate, f.preparation.material.diagnostics, "uncertain-run", { native: "author" });
		await assert.rejects(admitRepairEffect(native.host, f.journal, uncertain, history, async () => { calls++; throw new Error("uncertain native outcome"); }));
		await assert.rejects(admitRepairEffect(native.host, f.journal, uncertain, history, async () => { calls++; return {}; }), { code: "repair_admission_held" });
		assert.equal(calls, 2);
		assert.equal(native.remaining(), 0);
	} finally { native.close(); }
});

test("LP10-12: reconstructed observation retains pending and settled once receipts without renewing consumption", async () => {
	const f = await fixture();
	const grant = { remaining: 1, resourceId: "pending-native-resource" };
	const native = createFixtureRepairHost(f.journal.databasePath, grant);
	const reconstructed = createFixtureRepairHost(f.journal.databasePath, grant);
	try {
		f.journal.prepare(f.preparation, readJsonValue(await native.host.prepare(f.preparation)));
		const history = f.journal.comparisonHistory(f.preparation.id, f.preparation.digest);
		const effect = buildRepairEffect(f.preparation, "author", history, f.preparation.material.candidate, f.preparation.material.diagnostics, "pending-run", { native: "author" });
		const started = deferred();
		const output = deferred();
		let calls = 0;
		const execution = admitRepairEffect(native.host, f.journal, effect, history, async () => {
			calls++; started.resolve(undefined); return output.promise;
		});
		await started.promise;
		const pending = await admitRepairEffect(reconstructed.host, f.journal, effect, history, async () => { calls++; return {}; });
		assert.equal(Object.hasOwn(pending, "output"), false);
		output.resolve({ exact: "settled output" });
		const settled = await execution;
		const reconciled = await admitRepairEffect(reconstructed.host, f.journal, effect, history, async () => { calls++; return {}; });
		assert.deepEqual(reconciled, settled);
		assert.equal(calls, 1);
		assert.equal(native.remaining(), 0);
		const receipts = f.journal.effects(f.preparation.id, f.preparation.digest)[0].receipts;
		assert.ok(Array.isArray(receipts));
		assert.equal(receipts.length, 2);
	} finally { native.close(); reconstructed.close(); }
});
