import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseJson } from "../../data.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { createFactoryService } from "../../factory.mjs";
import { createArtifactDatabase } from "../../storage/database.mjs";
import { must } from "../assertions.mjs";
import { COMMIT, DIGEST, fixture, source } from "../bridge/fixture.mjs";
import { factoryDocument, factoryMutator } from "./accessors.mjs";
import { legacyV2ReceiptHistory } from "./legacy.mjs";

test("record storage retains exact v2 exports across upgrade, former ceiling, archival, and pinned paging", async (t) => {
	const f = await fixture(t);
	const initial = factoryDocument(f.factory.exportFactory());
	const paddingAt = new Date().toISOString();
	while (initial.events.length < 8192) {
		const revision = initial.events.length + 1;
		initial.events.push({
			revision, at: paddingAt, action: "appendKnowledge", input: {
				id: `padding-${revision}`, unitId: "unit", kind: "observation", statement: "Historical observation",
				source: { kind: "discovery", ref: "fixture:history", actor: "fixture", at: paddingAt }, links: [], uncertainty: null,
			}
		});
	}
	initial.revision = initial.events.length;
	const upgradedRoot = path.join(f.root, "upgrade");
	await mkdir(upgradedRoot);
	const oldStore = createArtifactDatabase({
		workspacePath: upgradedRoot, directoryParts: ["repositories", f.factory.repository.id], schemaVersion: 2,
		initialize(db) {
			const version = db.prepare("PRAGMA user_version").get()?.user_version;
			if (version === 2) return;
			if (version !== 0) throw Object.assign(new Error("Cached old writer refuses a newer schema"), { code: "old_writer_closed" });
			db.exec("CREATE TABLE factory(singleton INTEGER PRIMARY KEY, revision INTEGER, document TEXT) STRICT; PRAGMA application_id=1178682196; PRAGMA user_version=2;");
			db.prepare("INSERT INTO factory VALUES(1,?,?)").run(initial.revision, JSON.stringify(initial));
		},
	});
	oldStore.transaction((db) => db.prepare("SELECT revision FROM factory").get());
	const upgraded = createFactoryService({ repositoryPath: f.repo, storageRoot: upgradedRoot, knowledge: "local" });
	assert.deepEqual(parseJson(upgraded.exportFactory()), initial);
	assert.throws(() => oldStore.transaction((db) => db.prepare("UPDATE factory SET revision=0").run(), { write: true }), { code: "old_writer_closed" });
	const mutate = factoryMutator(upgraded);
	mutate("recordDelivery", {
		candidateId: f.candidate.id, commit: COMMIT,
		artifact: { kind: "implementation", ref: "fixture:late-delivery", digest: DIGEST },
		source: { kind: "external-run", ref: "fixture:actual-generation", actor: "producer", owner: "fixture", runId: "late-run", sessionId: "late-session", at: new Date().toISOString() }
	});
	mutate("decideCandidate", { candidateId: f.candidate.id, action: "reject", expectedIncumbentId: null, actor: "owner", reason: "Keep it as a bounded rejected alternative" });
	mutate("retire", { type: "candidate", id: f.candidate.id, actor: "owner", reason: "Superseded", summary: "Retain historical lesson" });
	mutate("compactFactory", { actor: "owner", reason: "Archive retained history without exhausting receipt headroom" });
	const exact = factoryDocument(upgraded.exportFactory());
	let page = upgraded.exportFactoryPage({ limit: 128 });
	const pin = { throughRevision: page.revision, throughDigest: page.throughDigest };
	const exported = [...page.events];
	mutate("appendKnowledge", { id: "after-export-pin", unitId: "unit", kind: "observation", statement: "Not part of the pinned export", source: source() });
	mutate("compactFactory", { actor: "owner", reason: "Relocate records while an export is paging" });
	while (!page.complete) {
		page = upgraded.exportFactoryPage({ ...pin, afterRevision: page.nextRevision });
		exported.push(...page.events);
	}
	assert.deepEqual(exported, exact.events);
	assert.equal(new Set(exported.map((event) => event.revision)).size, exported.length);
	assert.ok(upgraded.snapshot().revision > 8192);
	assert.equal(upgraded.storageInfo().lifetimeEventCeiling, null);
	assert.ok(upgraded.storageInfo().archiveSegments > 0);
	assert.deepEqual(upgraded.generation(f.candidate.id), f.factory.generation(f.candidate.id));
});

test("staged paged import is atomic, restartable and preserves abandoned data", async (t) => {
	const f = await fixture(t);
	const targetRoot = path.join(f.root, "import");
	await mkdir(targetRoot);
	const target = createFactoryService({ repositoryPath: f.repo, storageRoot: targetRoot });
	const first = f.factory.exportFactoryPage({ limit: 2 });
	target.importFactoryPage({ expectedRevision: 0, importId: "transfer", page: first });
	assert.equal(target.snapshot().revision, 0);
	assert.throws(() => target.createUnit({ expectedRevision: 0 }), { code: "factory_import_pending" });
	const resumed = createFactoryService({ repositoryPath: f.repo, storageRoot: targetRoot });
	let page = first;
	while (!page.complete) {
		page = f.factory.exportFactoryPage({ throughRevision: first.revision, throughDigest: first.throughDigest, afterRevision: page.nextRevision, limit: 2 });
		resumed.importFactoryPage({ expectedRevision: 0, importId: "transfer", page });
	}
	assert.equal(resumed.exportFactory(), f.factory.exportFactory());
	assert.equal(resumed.storageInfo().transfers[0].status, "completed");
	const abandonedRoot = path.join(f.root, "abandoned");
	await mkdir(abandonedRoot);
	const abandoned = createFactoryService({ repositoryPath: f.repo, storageRoot: abandonedRoot });
	abandoned.importFactoryPage({ expectedRevision: 0, importId: "partial", page: first });
	abandoned.abandonFactoryImport({ expectedRevision: 0, importId: "partial", actor: "owner", reason: "Keep the received prefix, do not activate it" });
	assert.equal(abandoned.snapshot().revision, 0);
	assert.equal(abandoned.storageInfo().transfers[0].status, "abandoned");
	const db = new DatabaseSync(abandoned.databasePath);
	try { assert.equal(db.prepare("SELECT count(*) AS count FROM factory_transfer_events").get()?.count, first.events.length); }
	finally { db.close(); }
});

test("genuinely old-valid schema-2 duplicate receipts and their accepted selection survive upgrade without fresh support", async (t) => {
	const f = await fixture(t);
	const legacy = legacyV2ReceiptHistory(f.factory.repository);
	const root = path.join(f.root, "old-valid-v2");
	await mkdir(root);
	const oldStore = createArtifactDatabase({
		workspacePath: root, directoryParts: ["repositories", f.factory.repository.id], schemaVersion: 2,
		initialize(db) {
			if (db.prepare("PRAGMA user_version").get()?.user_version === 2) return;
			db.exec("CREATE TABLE factory(singleton INTEGER PRIMARY KEY, revision INTEGER, document TEXT) STRICT; PRAGMA application_id=1178682196; PRAGMA user_version=2;");
			db.prepare("INSERT INTO factory VALUES(1,?,?)").run(legacy.document.revision, JSON.stringify(legacy.document));
		},
	});

	await t.test("schema-4 upgrade copies exact event and staged text and older writers fail closed", async (t) => {
		const f = await fixture(t);
		const original = factoryDocument(f.factory.exportFactory());
		const base = { ...original, revision: original.revision - 1, events: original.events.slice(0, -1) };
		const last = original.events.at(-1);
		assert.ok(last);
		const baseText = ` \n${JSON.stringify(base, null, "\t")} \n`;
		const eventText = ` \n${JSON.stringify(last, null, "\t")} \n`;
		const root = path.join(f.root, "schema-four");
		await mkdir(root);
		const old = createArtifactDatabase({
			workspacePath: root, directoryParts: ["repositories", f.factory.repository.id], schemaVersion: 4,
			initialize(db) {
				const version = db.prepare("PRAGMA user_version").get()?.user_version;
				if (version === 4) return;
				if (version !== 0) throw Object.assign(new Error("Old schema owner refuses upgraded storage"), { code: "old_writer_closed" });
				db.exec(`
					CREATE TABLE factory(singleton INTEGER PRIMARY KEY, revision INTEGER, document TEXT) STRICT;
					CREATE TABLE factory_head(singleton INTEGER PRIMARY KEY, revision INTEGER) STRICT;
					CREATE TABLE factory_events(revision INTEGER PRIMARY KEY, document TEXT NOT NULL CHECK(length(CAST(document AS BLOB))<=131072), digest TEXT NOT NULL) STRICT;
					CREATE TABLE factory_archives(first_revision INTEGER PRIMARY KEY, last_revision INTEGER, document TEXT, digest TEXT) STRICT;
					CREATE TABLE factory_transfers(id TEXT PRIMARY KEY, revision INTEGER, digest TEXT, cursor INTEGER, status TEXT, reason TEXT, actor TEXT, portable INTEGER) STRICT;
					CREATE TABLE factory_transfer_events(transfer_id TEXT, revision INTEGER, document TEXT NOT NULL CHECK(length(CAST(document AS BLOB))<=131072), PRIMARY KEY(transfer_id,revision)) STRICT;
					CREATE TABLE factory_knowledge(singleton INTEGER PRIMARY KEY, mode TEXT, head TEXT) STRICT;
					PRAGMA application_id=1178682196; PRAGMA user_version=4;
				`);
				db.prepare("INSERT INTO factory VALUES(1,?,?)").run(base.revision, baseText);
				db.prepare("INSERT INTO factory_head VALUES(1,?)").run(original.revision);
				db.prepare("INSERT INTO factory_events VALUES(?,?,?)").run(last.revision, eventText, analysisInputDigest(last));
				db.prepare("INSERT INTO factory_transfers VALUES('old-transfer',?,?,?,'abandoned','retained reason','retained actor',0)").run(original.revision, DIGEST, last.revision);
				db.prepare("INSERT INTO factory_transfer_events VALUES('old-transfer',?,?)").run(last.revision, eventText);
				db.exec("INSERT INTO factory_knowledge VALUES(1,'local',NULL)");
			},
		});
		old.transaction(() => {});
		const upgraded = createFactoryService({ repositoryPath: f.repo, storageRoot: root, knowledge: "local" });
		assert.deepEqual(parseJson(upgraded.exportFactory()), original);
		assert.throws(() => old.transaction(db => db.exec("DELETE FROM factory_events"), { write: true }), { code: "old_writer_closed" });
		const db = new DatabaseSync(upgraded.databasePath);
		try {
			assert.equal(db.prepare("SELECT document FROM factory").get()?.document, baseText);
			assert.equal(db.prepare("SELECT document FROM factory_events").get()?.document, eventText);
			assert.equal(db.prepare("SELECT digest FROM factory_events").get()?.digest, analysisInputDigest(last));
			assert.equal(db.prepare("SELECT document FROM factory_transfer_events").get()?.document, eventText);
			assert.equal(db.prepare("SELECT reason FROM factory_transfers").get()?.reason, "retained reason");
			assert.equal(db.prepare("SELECT mode FROM factory_knowledge").get()?.mode, "local");
			assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE sql LIKE '%131072%'").get()?.count, 0);
		} finally { db.close(); }
		const statement = ` \n\t${"🙂資料 ".repeat(20000)}  \n`;
		upgraded.appendKnowledge({ expectedRevision: upgraded.snapshot().revision, id: "large-after-upgrade", unitId: "unit", kind: "inference", statement, source: source() });
		assert.equal(upgraded.snapshot().knowledge.at(-1)?.statement, statement);
	});

	await t.test("oversized first records and whole histories roundtrip through JSON, archive, staged pages and restart", async (t) => {
		const f = await fixture(t);
		const root = path.join(f.root, "oversized");
		await mkdir(root);
		const factory = createFactoryService({ repositoryPath: f.repo, storageRoot: root, knowledge: "local" });
		factory.importFactory({ expectedRevision: 0, source: f.factory.exportFactory() });
		factory.decideCandidate({ expectedRevision: factory.snapshot().revision, candidateId: f.candidate.id, action: "reject", expectedIncumbentId: null, actor: "owner", reason: "Retain the incomplete historical candidate without selecting it" });
		factory.retire({ expectedRevision: factory.snapshot().revision, type: "candidate", id: f.candidate.id, actor: "owner", reason: "Superseded", summary: "Historical candidate remains exportable" });
		const statement = ` \n\t🙂資料 ${"x".repeat(32 * 1024 * 1024 + 1)}  \n`;
		factory.appendKnowledge({ expectedRevision: factory.snapshot().revision, id: "whole-large-record", unitId: "unit", kind: "inference", statement, source: source() });
		const beforeCompaction = factoryDocument(factory.exportFactory());
		factory.compactFactory({ expectedRevision: factory.snapshot().revision, actor: "owner", reason: "Archive an oversized whole record without rejecting or splitting it" });
		const exact = factoryDocument(factory.exportFactory());
		assert.deepEqual(exact.events.slice(0, -1), beforeCompaction.events);
		const restarted = createFactoryService({ repositoryPath: f.repo, storageRoot: root, knowledge: "local" });
		assert.equal(restarted.snapshot().knowledge.at(-1)?.statement, statement);
		assert.deepEqual(parseJson(restarted.exportFactory()), exact);
		const largeRevision = exact.events.find(event => event.action === "appendKnowledge" && event.input.id === "whole-large-record")?.revision;
		assert.ok(largeRevision);
		const largePage = restarted.exportFactoryPage({ afterRevision: largeRevision - 1 });
		assert.equal(largePage.events[0].input.statement, statement);
		assert.equal(largePage.nextRevision, largeRevision);
		assert.equal(largePage.events.length, 1);
		assert.ok(Buffer.byteLength(JSON.stringify(largePage)) > 32 * 1024 * 1024);
		const targetRoot = path.join(f.root, "oversized-pages");
		await mkdir(targetRoot);
		let target = createFactoryService({ repositoryPath: f.repo, storageRoot: targetRoot, knowledge: "local" });
		let page = restarted.exportFactoryPage({ limit: 1000 });
		const pin = { throughRevision: page.revision, throughDigest: page.throughDigest, limit: 1000 };
		const revisions = [];
		while (true) {
			assert.ok(page.events.length);
			revisions.push(...page.events.map(event => event.revision));
			target.importFactoryPage({ expectedRevision: 0, importId: "large", page });
			target = createFactoryService({ repositoryPath: f.repo, storageRoot: targetRoot, knowledge: "local" });
			if (page.complete) break;
			page = restarted.exportFactoryPage({ ...pin, afterRevision: page.nextRevision });
		}
		assert.deepEqual(revisions, exact.events.map(event => event.revision));
		assert.deepEqual(parseJson(target.exportFactory()), exact);
		assert.equal(target.snapshot().knowledge.at(-1)?.statement, statement);
	});

	await t.test("transfer inspection retains every abandoned import beyond the former last-50 window", async (t) => {
		const f = await fixture(t);
		const root = path.join(f.root, "transfer-history");
		await mkdir(root);
		const factory = createFactoryService({ repositoryPath: f.repo, storageRoot: root, knowledge: "local" });
		const page = f.factory.exportFactoryPage({ limit: 1 });
		const reason = ` \n\t${"reason 🙂資料 ".repeat(1000)}  \n`;
		const actor = ` \t${"owner ".repeat(100)} `;
		for (let index = 0; index < 52; index++) {
			factory.importFactoryPage({ expectedRevision: 0, importId: `transfer-${index}`, page });
			factory.abandonFactoryImport({ expectedRevision: 0, importId: `transfer-${index}`, actor, reason });
		}
		const transfers = factory.storageInfo().transfers;
		assert.equal(transfers.length, 52);
		assert.equal(new Set(transfers.map(entry => entry.id)).size, 52);
		assert.ok(transfers.every(entry => entry.actor === actor && entry.reason === reason && entry.status === "abandoned"));
		assert.equal(factory.snapshot().revision, 0);
	});
	oldStore.transaction((db) => db.prepare("SELECT revision FROM factory").get());
	const upgraded = createFactoryService({ repositoryPath: f.repo, storageRoot: root, clock: () => "2026-01-01T00:13:00.000Z", knowledge: "local" });
	assert.deepEqual(parseJson(upgraded.exportFactory()), legacy.document);
	const view = upgraded.inspect({ candidateId: legacy.candidateId });
	assert.equal(view.storage.version, 5);
	assert.equal(view.units[0].currentCandidateId, legacy.candidateId);
	assert.equal(view.candidates[0].selection?.kind, "accept-candidate");
	assert.equal(view.candidates[0].selection?.reason, legacy.selection.reason);
	assert.equal(view.candidates[0].assurance.ready, false);
	assert.equal(view.candidates[0].assurance.evaluationSupport[0].evidenceId, "original-receipt");
	assert.ok(view.candidates[0].assurance.evaluationSupport[0].gaps.includes("renewal-required"));
	assert.equal(view.candidates[0].evidence.find((entry) => entry.id === "renamed-receipt")?.publicationDisposition, "duplicate-origin");
	assert.equal(upgraded.generation(legacy.candidateId).contextDigest, legacy.contextDigest);
	const selection = structuredClone(must(upgraded.snapshot().decisions.at(-1)));
	assert.throws(() => upgraded.recordEvaluation({
		expectedRevision: upgraded.snapshot().revision, ...legacy.duplicate, id: "yet-another-receipt",
		source: { ...legacy.duplicate.source, at: "2026-01-01T00:13:00.000Z" },
	}), { code: "factory_evaluation_origin_reused" });
	assert.deepEqual(parseJson(upgraded.exportFactory()), legacy.document);
	const delivery = legacy.delivery;
	const { candidate } = upgraded.prepareCandidate({
		expectedRevision: upgraded.snapshot().revision, id: "prospective", unitId: "legacy-unit", contractRevision: 1, mode: "adoption", actor: "owner",
		context: { generation: [], comparisonOnly: [delivery.artifact], independence: { method: "existing-artifact", reason: "A new decision must use current support" } },
	});
	assert.throws(() => upgraded.recordDelivery({ expectedRevision: upgraded.snapshot().revision, ...delivery, candidateId: candidate.id }), { code: "factory_commit_missing" });
	upgraded.recordDelivery({ expectedRevision: upgraded.snapshot().revision, ...delivery, candidateId: candidate.id, commit: COMMIT });
	assert.throws(() => upgraded.recordEvaluation({
		expectedRevision: upgraded.snapshot().revision, ...legacy.original, id: "prospective-old-proof",
		candidateId: candidate.id, contractDigest: candidate.contractDigest, contextDigest: candidate.contextDigest, commit: COMMIT,
	}), { code: "factory_evaluator_unpinned" });
	assert.throws(() => upgraded.decideCandidate({
		expectedRevision: upgraded.snapshot().revision, candidateId: candidate.id, action: "accept", expectedIncumbentId: legacy.candidateId, actor: "owner", reason: "Must not use historical admission rules",
	}), { code: "factory_assurance_incomplete" });
	assert.deepEqual(upgraded.snapshot().decisions.find((entry) => entry.id === selection.id), selection);
});
