import assert from "node:assert/strict";
import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { analysisInputDigest } from "../../digest.mjs";
import { parseJson, readRecord, readString } from "../../data.mjs";
import { createFactoryService } from "../../factory.mjs";
import { operatingGeneration, operatingRecords } from "../../factory/operating.mjs";
import { operatingBatch, operatingRecord } from "../../plan/schemas/operating.mjs";
import { seedRepository } from "../git.mjs";
import { charter, fixtureRules, goal, historicalIdentity, operatingFixture } from "./operating.mjs";

test("closed versioned DTOs reject unknown, malformed and forged authority fields", () => {
	for (const bad of [
		{ ...charter(), version: 2 }, { ...charter(), active: true },
		{ ...charter(), source: { ...historicalIdentity, authority: "active" } },
		{ ...charter(), previous: { id: "squad", revision: 0 } },
		{ ...charter(), revision: 2, previous: { id: "different", revision: 1 } },
		{ ...charter(), credentials: "credential-sentinel" }, { ...charter(), conversation: ["private-content-sentinel"] },
		{ ...charter(), context: [{ id: "unsafe", kind: "artifact", digest: "a".repeat(64), usage: "comparison-only",
			knowledge: null, artifact: { kind: "implementation", ref: "comparison-source-sentinel", digest: "b".repeat(64) } }] },
	]) assert.throws(() => operatingRecord(bad));
	assert.throws(() => operatingBatch({ version: 1, id: "forged", snapshot: { version: 99 }, records: [charter()], source: historicalIdentity }));
});

test("real canonical history reopens and transfers safely into an independently seeded repository", async t => {
	const f = await operatingFixture(t);
	const first = f.batch("initial", [charter()]);
	const publication = f.factory.operating.commit(first, f.authority());
	const next = charter("squad", 2);
	next.purpose = "Retain the original immutable charter revision";
	f.open().operating.commit(f.batch("revision", [next]), f.authority());
	const reopened = f.open();
	assert.deepEqual(operatingRecords(reopened.snapshot()), [charter(), next]);
	assert.deepEqual(reopened.snapshot().operating?.[0], publication);
	assert.throws(() => reopened.operating.commit(first, f.authority()), { code: "operating_snapshot_changed" });
	const clone = path.join(f.root, "seeded-clone");
	const cache = path.join(f.root, "clone-cache");
	await mkdir(clone); await mkdir(cache);
	seedRepository(clone);
	await cp(path.join(f.repo, ".foundry"), path.join(clone, ".foundry"), { recursive: true });
	const imported = createFactoryService({ repositoryPath: clone, storageRoot: cache, operating: f.ports });
	assert.notEqual(imported.databasePath, reopened.databasePath);
	assert.deepEqual(operatingRecords(imported.snapshot()), [charter(), next]);
	const info = imported.storageInfo();
	assert.ok("knowledge" in info);
	assert.equal(readRecord(info.knowledge).importedExecutionOwnership, false);
	const target = path.join(f.root, "export-import");
	await mkdir(target);
	const restored = createFactoryService({ repositoryPath: f.repo, storageRoot: target, knowledge: "local", operating: f.ports });
	restored.importFactory({ source: reopened.exportFactory(), expectedRevision: 0 });
	assert.equal(restored.exportFactory(), reopened.exportFactory());
});

test("real stores reject multi-record write skew at the whole-snapshot barrier without partial intent", async t => {
	const f = await operatingFixture(t);
	f.factory.operating.commit(f.batch("initial", [charter(), goal("left"), goal("right")]), f.authority());
	const left = { ...goal("left", 2), intent: "exclusive" };
	const right = { ...goal("right", 2), intent: "exclusive" };
	const preparedLeft = f.batch("left-change", [left]);
	const preparedRight = f.batch("right-change", [right]);
	const secondConnection = f.open();
	secondConnection.operating.commit(preparedLeft, f.authority());
	const before = f.store.readCurrent(f.planId);
	const factoryBefore = f.factory.exportFactory();
	assert.throws(() => f.factory.operating.commit(preparedRight, f.authority()), { code: "operating_snapshot_changed" });
	assert.deepEqual(f.store.readCurrent(f.planId), before);
	assert.equal(f.factory.exportFactory(), factoryBefore);
	assert.throws(() => f.batch("rebased-invalid", [right]), /fixture cross-record invariant/);
	assert.equal(f.open().exportFactory(), factoryBefore);
	assert.deepEqual(operatingRecords(f.factory.snapshot()).filter(record => record.id === "right"), [goal("right")]);
});

test("whole-graph import requires domain validation and rolls back an invalid effective graph", async t => {
	const f = await operatingFixture(t);
	f.factory.operating.commit(f.batch("initial", [charter(), goal("left"), goal("right")]), f.authority());
	const original = readRecord(parseJson(f.factory.exportFactory()));
	assert.ok(Array.isArray(original.events));
	const events = original.events.map(readRecord);
	const operating = events.find(event => event.action === "recordOperating");
	assert.ok(operating);
	const input = readRecord(operating.input);
	const publication = readRecord(input.publication);
	const batch = readRecord(publication.batch);
	assert.ok(Array.isArray(batch.records));
	for (const value of batch.records) {
		const record = readRecord(value);
		if (record.kind === "goal") record.intent = "exclusive";
	}
	const { digest: ignored, ...payload } = publication;
	publication.digest = analysisInputDigest(payload);
	const targetRoot = path.join(f.root, "invalid-import");
	await mkdir(targetRoot);
	const target = createFactoryService({ repositoryPath: f.repo, storageRoot: targetRoot, knowledge: "local", operating: f.ports });
	assert.throws(() => target.importFactory({ source: JSON.stringify(original), expectedRevision: 0 }), /fixture cross-record invariant/);
	assert.equal(target.snapshot().revision, 0);
	assert.deepEqual(target.snapshot().operating, undefined);
	const noRulesRoot = path.join(f.root, "missing-rules");
	await mkdir(noRulesRoot);
	const noRules = createFactoryService({ repositoryPath: f.repo, storageRoot: noRulesRoot, knowledge: "local" });
	assert.throws(() => noRules.importFactory({ source: f.factory.exportFactory(), expectedRevision: 0 }), { code: "operating_validation_unavailable" });
	assert.equal(noRules.snapshot().revision, 0);
});

test("canonical writer detects a change after preparation but before its locked snapshot validation", async t => {
	const f = await operatingFixture(t);
	f.factory.operating.commit(f.batch("initial", [charter(), goal("left"), goal("right")]), f.authority());
	const left = f.batch("left", [{ ...goal("left", 2), intent: "exclusive" }]);
	const right = f.batch("right", [{ ...goal("right", 2), intent: "exclusive" }]);
	const authority = f.authority();
	const competitor = f.open();
	const interleaved = createFactoryService({ repositoryPath: f.repo, storageRoot: f.storageRoot, operating: {
		...f.ports, admission: {
			withFence(fence, operation) {
				competitor.operating.commit(left, f.authority());
				return f.admission.withFence(fence, operation);
			},
		},
	} });
	assert.throws(() => interleaved.operating.commit(right, authority), { code: "revision_conflict" });
	assert.deepEqual(f.store.readCurrent(f.planId).operating?.publications.map(entry => entry.batch.id), ["initial", "left"]);
	assert.deepEqual(f.open().snapshot().operating?.map(entry => entry.batch.id), ["initial", "left"]);
});

test("missing or mutating domain validators expose no unchecked production mutation", async t => {
	const f = await operatingFixture(t);
	const batch = f.batch("initial", [charter()]);
	assert.throws(() => f.batch("forged-acceptance", [charter(), { ...goal("invented-contract"), authority: "accepted" }]),
		{ code: "operating_contract_missing" });
	const uncomposed = createFactoryService({ repositoryPath: f.repo, storageRoot: f.storageRoot });
	assert.throws(() => uncomposed.operating.commit(batch, f.authority()), { code: "operating_validation_unavailable" });
	const mutating = createFactoryService({ repositoryPath: f.repo, storageRoot: f.storageRoot, operating: {
		...f.ports, rules: { charters(state) { state.revision++; } },
	} });
	assert.throws(() => mutating.operating.commit(batch, f.authority()), { code: "operating_validator_invalid" });
	const asynchronous = createFactoryService({ repositoryPath: f.repo, storageRoot: f.storageRoot, operating: {
		...f.ports, rules: { charters: async () => { } },
	} });
	assert.throws(() => asynchronous.operating.commit(batch, f.authority()), { code: "operating_validator_invalid" });
	assert.equal(f.store.readCurrent(f.planId).operating, undefined);
});

test("portable records and generation projections omit private and comparison references", async t => {
	const f = await operatingFixture(t);
	const record = charter();
	record.context = [{ id: "comparison", kind: "artifact", usage: "comparison-only", digest: "d".repeat(64), knowledge: null, artifact: null }];
	const authority = f.authority();
	const sentinels = ["private-content-sentinel", "credential-sentinel", "conversation-sentinel", "/private/local-path-sentinel", "comparison-source-sentinel"];
	authority.references = sentinels.map((ref, index) => ({ id: `reference-${index}`, kind: "source", ref, digest: analysisInputDigest(ref) }));
	f.factory.operating.commit(f.batch("private", [record]), authority);
	const local = f.store.readCurrent(f.planId).operating?.local[0].references;
	assert.deepEqual(local, authority.references);
	const head = readRecord(parseJson(await readFile(path.join(f.repo, ".foundry/repository.json"), "utf8")));
	const object = await readFile(path.join(f.repo, ".foundry/objects", `${readString(head.head)}.json`), "utf8");
	const outputs = [object, f.factory.exportFactory(), JSON.stringify(operatingGeneration(record)), await f.store.exportPlan(f.planId)];
	for (const output of outputs) for (const sentinel of sentinels) assert.ok(!output.includes(sentinel), sentinel);
	assert.deepEqual(operatingGeneration(record).context, []);
	assert.equal(f.open().snapshot().operating?.[0].batch.records[0].context[0].usage, "comparison-only");
});

test("schema-3 factory lineage upgrades intact; unsupported writers and failed upgrades remain closed", async t => {
	const f = await operatingFixture(t, { local: true });
	const original = f.factory.exportFactory();
	let db = new DatabaseSync(f.factory.databasePath);
	db.exec("DROP TABLE factory_knowledge; ALTER TABLE factory_transfers DROP COLUMN portable; PRAGMA user_version=3");
	db.close();
	assert.equal(f.open().exportFactory(), original);
	assert.equal(f.open().storageInfo().version, 4);
	db = new DatabaseSync(f.factory.databasePath);
	db.exec("PRAGMA user_version=99");
	db.close();
	assert.throws(() => f.open().snapshot(), { code: "factory_database_unsupported" });
	db = new DatabaseSync(f.factory.databasePath);
	assert.equal(db.prepare("SELECT count(*) AS count FROM factory_events").get()?.count, 1);
	db.exec("PRAGMA user_version=4");
	db.close();
	assert.equal(f.open().exportFactory(), original);
	// A malformed old v2 source must roll back initialization, leaving its exact row.
	const targetRoot = path.join(f.root, "failed-migration");
	await mkdir(targetRoot);
	const target = createFactoryService({ repositoryPath: f.repo, storageRoot: targetRoot, knowledge: "local", operating: { ...f.ports, rules: fixtureRules } });
	target.snapshot();
	db = new DatabaseSync(target.databasePath);
	db.exec("DROP TABLE factory_head; DROP TABLE factory_events; DROP TABLE factory_archives; DROP TABLE factory_transfers; DROP TABLE factory_transfer_events; DROP TABLE factory_knowledge; PRAGMA user_version=2");
	db.prepare("UPDATE factory SET document=? WHERE singleton=1").run("{invalid");
	db.close();
	assert.throws(() => target.snapshot(), { code: "factory_document_invalid" });
	db = new DatabaseSync(target.databasePath);
	assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
	assert.equal(db.prepare("SELECT document FROM factory").get()?.document, "{invalid");
	assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='factory_head'").get(), undefined);
	db.prepare("UPDATE factory SET document=?, revision=? WHERE singleton=1").run(original, f.factory.snapshot().revision);
	db.exec("CREATE TABLE factory_events (injected INTEGER)");
	db.close();
	assert.throws(() => target.snapshot(), /SQLite|database|already exists/);
	db = new DatabaseSync(target.databasePath);
	assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
	assert.equal(db.prepare("SELECT document FROM factory").get()?.document, original);
	assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='factory_head'").get(), undefined);
	db.exec("DROP TABLE factory_events");
	db.close();
	assert.equal(target.exportFactory(), original);
});
