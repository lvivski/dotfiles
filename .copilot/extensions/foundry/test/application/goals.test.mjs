import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createGoalService } from "../../application/goals.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { readRecord, readString, parseJson } from "../../data.mjs";
import { createFactoryService } from "../../factory.mjs";
import { goalGraph, regenerationGoal, validateGoals } from "../../factory/goals.mjs";
import { operatingRecords } from "../../factory/operating.mjs";
import { projectKnowledge } from "../../factory/portable.mjs";
import { factoryDocument } from "../factory/accessors.mjs";
import { charter, fixtureRules, goal, historicalIdentity, operatingFixture } from "../factory/operating.mjs";
import { seedRepository } from "../git.mjs";

const rules = { ...fixtureRules, goals: validateGoals };
/** @param {ReturnType<typeof createFactoryService>} factory
 * @param {(() => Parameters<typeof import("../../factory/rollup.mjs").goalReadiness>[3])} [admission] */
function service(factory, admission) {
	return createGoalService({ operating: factory.operating, now: () => new Date().toISOString(), admission,
		transfer: {
			export: () => JSON.stringify(projectKnowledge(factoryDocument(factory.exportFactory())).document),
			import: (source, expectedRevision) => {
				const document = readRecord(parseJson(source));
				assert.equal(readRecord(document.repository).id, factory.repository.id);
				return factory.importFactory({ source: JSON.stringify({ ...document, repository: factory.repository }), expectedRevision });
			},
		} });
}
/** @param {string} id @param {string} from @param {string | null} to @param {number} [revision]
 * @returns {import("../../types/operating.js").OperatingRelationship} */
function relation(id, from, to, revision = 1) {
	return { version: 1, kind: "relationship", id, revision, previous: revision === 1 ? null : { id, revision: revision - 1 },
		source: historicalIdentity, context: [], relation: "depends-on", from: { id: from, revision: 1 },
		to: to ? { id: to, revision: 1 } : null, requirement: "Resolve exact input before use", criterionIds: ["criterion"], producer: null };
}
/** @param {Awaited<ReturnType<typeof operatingFixture>>} f */
async function initialize(f) {
	f.factory.operating.commit(f.batch("charter", [charter()]), f.authority());
	const goals = service(f.factory);
	goals.commit(f.batch("goals", [goal("left"), goal("right"), relation("lr", "left", null), relation("rl", "right", null)]), f.authority());
	return goals;
}

test("service uses canonical snapshot, native owner and fence rather than historical names", async t => {
	const f = await operatingFixture(t, { rules });
	const goals = await initialize(f);
	f.factory.operating.commit(f.batch("other-charter", [charter("other")]), f.authority());
	const before = goals.exportHistory();
	const ownerBefore = f.store.readCurrent(f.planId);
	const batch = goals.prepare(f.batch("revision", [goal("left", 2)]));
	assert.throws(() => goals.commit(batch, { ...f.authority(), binding: null }), { code: "goal_owner_missing" });
	assert.throws(() => goals.commit(batch, { ...f.authority(), binding: { ...f.authority().binding, charter: { id: "another", revision: 1 } } }),
		{ code: "goal_owner_mismatch" });
	assert.throws(() => goals.commit({ ...batch, records: [{ ...goal("left", 2), charter: { id: "other", revision: 1 } }] },
		{ ...f.authority(), binding: { ...f.authority().binding, charter: { id: "other", revision: 1 } } }), { code: "goal_owner_mismatch" });
	f.observation.allowed = false;
	assert.throws(() => goals.commit(batch, f.authority()), /fixture native denial/);
	f.observation.allowed = true;
	assert.equal(goals.exportHistory(), before);
	assert.deepEqual(f.store.readCurrent(f.planId), ownerBefore);
	const forged = { ...batch, records: [{ ...goal("left", 2), activeOwner: "fixture-worker" }] };
	assert.throws(() => goals.commit(forged, f.authority()), { code: "factory_input_invalid" });
	assert.throws(() => goals.prepare({ ...batch, records: [charter("squad", 2)] }), { code: "goal_scope_invalid" });
	goals.commit(batch, f.authority());
	assert.equal(goalGraph(f.open().snapshot()).goals.find(entry => entry.id === "left")?.revision, 2);
	assert.throws(() => goals.commit(batch, f.authority()), { code: "operating_snapshot_changed" });
});

test("two canonical connections reject barrier-controlled cross-record graph write skew", async t => {
	const f = await operatingFixture(t, { rules });
	const first = await initialize(f);
	const second = service(f.open());
	const snapshot = first.snapshot().token;
	const left = first.prepare({ version: 1, id: "left-resolved", snapshot, source: historicalIdentity, records: [relation("lr", "left", "right", 2)] });
	const right = second.prepare({ version: 1, id: "right-resolved", snapshot, source: historicalIdentity, records: [relation("rl", "right", "left", 2)] });
	// Both validations finish at the barrier before either real writer publishes.
	assert.deepEqual(left.snapshot, right.snapshot);
	first.commit(left, f.authority());
	const committed = first.exportHistory();
	const owner = f.store.readCurrent(f.planId);
	assert.throws(() => second.commit(right, f.authority()), { code: "operating_snapshot_changed" });
	assert.equal(second.exportHistory(), committed);
	assert.deepEqual(f.store.readCurrent(f.planId), owner);
	assert.throws(() => second.prepare({ ...right, snapshot: second.snapshot().token }), { code: "goal_cycle" });
	const reopened = service(f.open());
	assert.equal(reopened.exportHistory(), committed);
	assert.deepEqual(goalGraph(reopened.snapshot().state).relationships.find(entry => entry.id === "rl")?.to, null);
});

test("a competing graph publication inside the admission barrier cannot bypass locked revalidation", async t => {
	const f = await operatingFixture(t, { rules });
	await initialize(f);
	const first = f.batch("first", [relation("lr", "left", "right", 2)]);
	const second = f.batch("second", [relation("rl", "right", "left", 2)]);
	const authority = f.authority();
	const other = service(f.open());
	const interleaved = createFactoryService({ repositoryPath: f.repo, storageRoot: f.storageRoot, operating: {
		...f.ports, admission: { withFence(fence, operation) {
			other.commit(first, f.authority());
			return f.admission.withFence(fence, operation);
		} },
	} });
	assert.throws(() => service(interleaved).commit(second, authority), { code: "revision_conflict" });
	assert.deepEqual(f.store.readCurrent(f.planId).operating?.publications.map(entry => entry.batch.id), ["charter", "goals", "first"]);
	assert.deepEqual(f.open().snapshot().operating?.map(entry => entry.batch.id), ["charter", "goals", "first"]);
});

test("invalid whole-graph import publishes no records, revisions, or owner outbox and cannot pass on replay", async t => {
	const f = await operatingFixture(t, { rules });
	const goals = await initialize(f);
	const document = readRecord(parseJson(goals.exportHistory()));
	assert.ok(Array.isArray(document.events));
	const events = document.events.map(readRecord);
	const event = events.filter(entry => entry.action === "recordOperating").at(-1);
	assert.ok(event);
	const publication = readRecord(readRecord(event.input).publication);
	const batch = readRecord(publication.batch);
	assert.ok(Array.isArray(batch.records));
	for (const value of batch.records) {
		const record = readRecord(value);
		if (record.id === "lr") record.to = { id: "right", revision: 1 };
		if (record.id === "rl") record.to = { id: "left", revision: 1 };
	}
	const { digest, ...payload } = publication;
	publication.digest = analysisInputDigest(payload);
	const targetRoot = path.join(f.root, "import");
	await mkdir(targetRoot);
	const open = () => createFactoryService({ repositoryPath: f.repo, storageRoot: targetRoot, knowledge: "local", operating: f.ports });
	const target = service(open());
	const before = target.exportHistory();
	const ownerBefore = f.store.readCurrent(f.planId);
	assert.throws(() => target.importHistory(f.factory.exportFactory(), 0), { code: "goal_transfer_not_portable" });
	for (const current of [target, service(open())]) {
		assert.throws(() => current.importHistory(JSON.stringify(document), 0), { code: "goal_cycle" });
		assert.equal(current.exportHistory(), before);
		assert.equal(current.snapshot().state.revision, 0);
		assert.deepEqual(f.store.readCurrent(f.planId), ownerBefore);
	}
	target.importHistory(goals.exportHistory(), 0);
	assert.equal(target.exportHistory(), goals.exportHistory());
	assert.throws(() => target.importHistory(JSON.stringify(document), target.snapshot().state.revision), { code: "factory_import_conflict" });
	assert.equal(target.exportHistory(), goals.exportHistory());
});

test("restart reconciles exact committed intent, while conflicting intervening graph changes hold it", async t => {
	for (const competing of [false, true]) {
		await t.test(competing ? "stale recovery holds" : "exact recovery publishes once", async child => {
			const f = await operatingFixture(child, { rules });
			await initialize(f);
			const before = f.factory.exportFactory();
			const crashing = createFactoryService({ repositoryPath: f.repo, storageRoot: f.storageRoot, operating: {
				...f.ports, persistence: { ...f.store.operating, commit(publication, authority, native, permit) {
					f.store.operating.commit(publication, authority, native, permit);
					throw new Error("Simulated interruption after durable owner commit");
				} },
			} });
			assert.throws(() => service(crashing).commit(f.batch("pending", [relation("lr", "left", "right", 2)]), f.authority()), /Simulated interruption/);
			assert.equal(f.factory.exportFactory(), before);
			const publication = f.store.readCurrent(f.planId).operating?.publications.at(-1);
			assert.ok(publication);
			const restarted = service(f.open());
			if (competing) {
				restarted.commit(f.batch("competing", [relation("rl", "right", "left", 2)]), f.authority());
				const won = restarted.exportHistory();
				assert.throws(() => restarted.reconcile(f.planId, publication.digest), { code: "revision_conflict" });
				assert.equal(restarted.exportHistory(), won);
				assert.equal(goalGraph(f.open().snapshot()).relationships.find(entry => entry.id === "lr")?.revision, 1);
			} else {
				assert.deepEqual(restarted.reconcile(f.planId, publication.digest), publication);
				assert.deepEqual(restarted.reconcile(f.planId, publication.digest), publication);
				assert.equal(goalGraph(f.open().snapshot()).relationships.find(entry => entry.id === "lr")?.revision, 2);
			}
		});
	}
});

test("readiness observes existing cancellation without reserving, granting or launching", async t => {
	const f = await operatingFixture(t, { rules });
	await initialize(f);
	let observations = 0;
	const goals = service(f.factory, () => {
		observations++;
		const admission = f.admission.read(f.fence.admission);
		return { phase: admission?.phase === "reserved" ? "available" : "cancelled", reason: "Existing canonical fence snapshot; synthetic native attachment" };
	});
	const before = f.admission.list();
	const projection = goals.inspect({ id: "left", revision: 1 });
	assert.equal(projection.readyForExistingAdmission, false);
	assert.ok(projection.blockers.some(reason => reason.includes("unresolved-requirement")));
	assert.deepEqual(f.admission.list(), before);
	const cancelled = f.admission.cancel(f.fence);
	assert.ok(goals.inspect({ id: "left", revision: 1 }).blockers.some(reason => reason.startsWith("admission-cancelled")));
	assert.equal(observations, 2);
	assert.equal(service(f.open()).inspect({ id: "left", revision: 1 }).admission.phase, "unknown");
	assert.throws(() => goals.commit(f.batch("cancelled", [goal("left", 2)]), f.authority()), { code: "revision_conflict" });
	assert.throws(() => goals.commit(f.batch("cancelled", [goal("left", 2)]),
		{ ...f.authority(), fence: { ...f.fence, revision: cancelled.revision, epoch: cancelled.epoch } }), { code: "operating_authority_changed" });
});

test("retained regeneration store reopens and exports portable open dependencies without private comparison inputs", async t => {
	const f = await operatingFixture(t, { rules });
	f.factory.operating.commit(f.batch("charter", [charter()]), f.authority());
	const goals = service(f.factory);
	const regeneration = regenerationGoal(historicalIdentity, { id: "squad", revision: 1 });
	const authority = f.authority();
	authority.references = [...regeneration.references,
		{ id: "private-context", kind: "context", ref: "private-conversation-payload-sentinel", digest: analysisInputDigest("private-conversation-payload-sentinel") }];
	goals.commit(f.batch("regeneration-open", regeneration.records), authority);
	const reopened = service(f.open());
	const projection = reopened.inspect({ id: "hyper-regeneration", revision: 1 });
	assert.equal(projection.rollup.status, "open");
	assert.equal(projection.rollup.criteria.length, 9);
	assert.equal(projection.blockers.filter(reason => reason.includes("unresolved-requirement")).length, 9);
	const generation = JSON.stringify(reopened.generation({ id: "hyper-regeneration", revision: 1 }));
	const full = reopened.exportHistory();
	const head = readRecord(parseJson(await readFile(path.join(f.repo, ".foundry/repository.json"), "utf8")));
	const object = readRecord(parseJson(await readFile(path.join(f.repo, ".foundry/objects", `${readString(head.head)}.json`), "utf8")));
	const portable = JSON.stringify(object.document);
	for (const output of [portable, generation, full]) {
		assert.ok(!output.includes("69c3dcd"));
		assert.ok(!output.includes("private-conversation-payload-sentinel"));
	}
	assert.ok(portable.includes("SR1 account/access/generations/budgets"));
	assert.ok(portable.includes("Mail/Chat"));
	assert.equal(generation.includes("calendar-comparison"), false);
	assert.ok(f.store.readCurrent(f.planId).operating?.local.some(entry => entry.references.some(ref => ref.ref.includes("69c3dcd"))));
	const importRoot = path.join(f.root, "portable-import");
	await mkdir(importRoot);
	const imported = createFactoryService({ repositoryPath: f.repo, storageRoot: importRoot, knowledge: "local", operating: f.ports });
	service(imported).importHistory(portable, 0);
	assert.equal(service(imported).inspect({ id: "hyper-regeneration", revision: 1 }).rollup.status, "open");
	assert.deepEqual(operatingRecords(imported.snapshot()), operatingRecords(f.factory.snapshot()));
	assert.deepEqual(imported.snapshot().bindings, []);
	assert.deepEqual(imported.snapshot().candidates, []);
	const directory = path.resolve("retained-regeneration");
	await mkdir(directory);
	await cp(f.root, path.join(directory, "source-stores"), { recursive: true });
	const durableRepo = path.join(directory, "canonical-repository");
	const durableCache = path.join(directory, "canonical-cache");
	await mkdir(durableRepo); await mkdir(durableCache);
	seedRepository(durableRepo);
	await cp(path.join(f.repo, ".foundry"), path.join(durableRepo, ".foundry"), { recursive: true });
	const durable = () => createFactoryService({ repositoryPath: durableRepo, storageRoot: durableCache, operating: f.ports });
	assert.equal(service(durable()).inspect({ id: "hyper-regeneration", revision: 1 }).rollup.status, "open");
	assert.deepEqual(parseJson(service(durable()).exportHistory()), parseJson(portable));
	await writeFile(path.join(directory, "portable-v1.json"), `${portable}\n`);
	await writeFile(path.join(directory, "projection.json"), `${JSON.stringify(projection, null, 2)}\n`);
	await writeFile(path.join(directory, "provenance.json"), `${JSON.stringify({
		format: "foundry-goal-delivery-v1", goal: projection.goal, authority: "isolated-source-fixture-only",
		comparison: "owner-local canonical references only", fixtureRoot: f.root, retainedRepository: durableRepo, retainedCache: durableCache,
		checkpoint: "8dcecea93862e45be39e5d326f15c5da60490025",
		productionRegistration: false, unavailable: ["live App execution", "native Windows/macOS runtime", "human verdict", "service evidence", "replacement", "regeneration"],
	}, null, 2)}\n`);
});
