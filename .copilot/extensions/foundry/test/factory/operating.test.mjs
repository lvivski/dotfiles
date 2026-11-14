import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { analysisInputDigest } from "../../digest.mjs";
import { parseJson, readRecord, readString } from "../../data.mjs";
import { createFactoryService } from "../../factory.mjs";
import { operatingGeneration, operatingRecords } from "../../factory/operating.mjs";
import { regenerationGoal } from "../../factory/goals.mjs";
import { replay } from "../../factory/replay.mjs";
import { readKnowledgeDocument } from "../../factory/portable.mjs";
import { operatingBatch, operatingRecord } from "../../plan/schemas/operating.mjs";
import { attachTaskAttempt, completeTaskAttempt, reserveTaskAttempt, retryTask } from "../../plan/execution.mjs";
import { admissionFence } from "../../storage/admission.mjs";
import { COMMIT, DIGEST, PROCEDURE, seedRepository } from "../git.mjs";
import { factoryDocument, factoryMutator } from "./accessors.mjs";
import { charter, fixtureRules, goal, historicalIdentity, operatingFixture } from "./operating.mjs";

/** @param {string} id @param {string} from @param {string | null} to
 * @returns {import("../../types/operating.js").OperatingRelationship} */
function dependency(id, from, to) {
	return { version: 1, kind: "relationship", id, revision: 1, previous: null, source: historicalIdentity, context: [],
		relation: "depends-on", from: { id: from, revision: 1 }, to: to ? { id: to, revision: 1 } : null,
		requirement: "Resolve the exact input", criterionIds: ["criterion"], producer: null };
}

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
	const revisionAuthority = f.authority();
	assert.ok(revisionAuthority.binding);
	revisionAuthority.binding.charter.revision = 2;
	f.open().operating.commit(f.batch("revision", [next]), revisionAuthority);
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

test("whole-graph import always composes domain validation and rolls back an invalid effective graph", async t => {
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
	noRules.importFactory({ source: f.factory.exportFactory(), expectedRevision: 0 });
	assert.deepEqual(operatingRecords(noRules.snapshot()), operatingRecords(f.factory.snapshot()));
	assert.throws(() => noRules.operating.commit(noRules.operating.prepare({
		version: 1, id: "import-is-not-authority", snapshot: noRules.operating.snapshot().token,
		source: historicalIdentity, records: [charter("squad", 2)],
	}), f.authority()), { code: "operating_authority_unavailable" });
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
	assert.throws(() => uncomposed.operating.commit(batch, f.authority()), { code: "operating_authority_unavailable" });
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

test("composed services retain exact evidence, cross-squad inputs and decisions through replacement and selective reopening", async t => {
	const f = await operatingFixture(t, { rules: {} });
	let clock = new Date(Date.now() + 1).toISOString();
	const open = () => createFactoryService({ repositoryPath: f.repo, storageRoot: f.storageRoot, operating: f.ports, clock: () => clock });
	const factory = open();
	const mutate = factoryMutator(factory);
	/** @param {string} id @param {import("../../types/operating.js").OperatingRecord[]} records
	 * @param {import("../../types/operating.js").OperatingIdentity} [source] */
	const batch = (id, records, source = historicalIdentity) => factory.operating.prepare({
		version: 1, id, records, source, snapshot: factory.operating.snapshot().token,
	});
	/** @type {import("../../types/operating.js").OperatingDecision} */
	const lesson = { version: 1, kind: "decision", id: "lesson", revision: 1, previous: null, source: historicalIdentity,
		context: [], charter: { id: "squad", revision: 1 }, goal: null, category: "observation", status: "observation",
		rationale: "Retain the original bounded decision across replaceable workers", governing: [] };
	factory.squads.commit(batch("charter", [charter(), lesson]), f.authority());
	const source = () => ({ kind: "discovery", ref: "fixture:composed", actor: "fixture", at: clock });
	for (const id of ["input", "order"]) {
		mutate("appendKnowledge", { id, unitId: "unit", kind: "obligation", statement: `Preserve ${id}`, source: source() });
		mutate("appendKnowledge", { id: `${id}-oracle`, unitId: "unit", kind: "evaluation", statement: `Evaluate ${id}`, source: source(),
			evaluation: { modality: "boundary", procedure: PROCEDURE, obligations: [{ id, revision: 1 }],
				environment: "fixture-node", workload: "fixture", independent: true, preservation: true, maxAgeSeconds: 3600 } });
	}
	const { contract } = mutate("acceptContract", { unitId: "unit", unitRevision: 1,
		obligations: ["input", "order"].map(id => ({ id, revision: 1 })),
		evaluations: ["input-oracle", "order-oracle"].map(id => ({ id, revision: 1 })), actor: "fixture", reason: "Synthetic source fixture, not user acceptance" });
	const artifact = { kind: /** @type {const} */ ("implementation"), ref: "fixture:producer", digest: DIGEST };
	for (const id of ["producer", "consumer"]) {
		const { candidate } = mutate("prepareCandidate", { id, unitId: "unit", contractRevision: 1, mode: "implementation", actor: "fixture",
			context: { generation: id === "consumer" ? [artifact] : [], comparisonOnly: [],
				independence: { method: "fresh-session", reason: "Synthetic separate context" } } });
		const binding = { unitId: "unit", unitRevision: 1, candidateId: id, contractRevision: 1, contractDigest: contract.digest,
			contextDigest: candidate.contextDigest, blueprintDigest: DIGEST };
		mutate("bindPlan", { ...binding, planId: `generate-${id}`, owner: "fixture-producer" });
		mutate("recordDelivery", { candidateId: id, commit: COMMIT, artifact: { ...artifact, ref: `fixture:${id}` },
			source: { kind: "app-task", ref: `fixture:${id}`, actor: "fixture", at: clock, owner: "fixture-producer",
				planId: `generate-${id}`, taskId: "T-001", attemptId: "T-001-A001", sessionId: `producer-${id}` } });
		mutate("recordCompletion", { candidateId: id, passed: true, commit: COMMIT, evidenceIds: ["fixture-complete"],
			source: { kind: "native-workflow", ref: `fixture:${id}-complete`, actor: "fixture", at: clock,
				owner: "fixture-producer", planId: `generate-${id}`, runId: `complete-${id}` } });
		for (const criterion of ["input", "order"]) {
			const evaluation = { id: `${criterion}-oracle`, revision: 1 };
			const planId = `evaluate-${id}-${criterion}`;
			mutate("bindEvaluationPlan", { ...binding, planId, owner: "fixture-reviewer", evaluations: [evaluation], targetCommit: COMMIT });
			const { evidence } = mutate("recordEvaluation", { id: `evidence-${id}-${criterion}`, candidateId: id, evaluation,
				procedureDigest: PROCEDURE.digest, contractDigest: contract.digest, contextDigest: candidate.contextDigest, commit: COMMIT,
				outcome: "passed", environment: "fixture-node", workload: "fixture", report: "Synthetic exact-boundary result, not live service evidence",
				independence: { method: "separate-session", reason: "Synthetic independently attributed result" },
				source: { kind: "app-task", ref: `fixture:${planId}`, actor: "fixture-reviewer", at: clock, owner: "fixture-reviewer",
					planId, taskId: "T-002", attemptId: "T-002-A001", sessionId: planId } });
			mutate("recordEvaluationCompletion", { candidateId: id, passed: true, commit: COMMIT, evidenceIds: [evidence.id],
				source: { kind: "native-workflow", ref: `fixture:${planId}`, actor: "fixture-reviewer", at: clock,
					owner: "fixture-reviewer", planId, runId: planId } });
		}
	}
	const producer = goal("producer");
	producer.authority = "accepted";
	producer.contract = { unitId: "unit", unitRevision: 1, contractRevision: 1, contractDigest: contract.digest };
	producer.candidateId = "producer";
	producer.relationshipCoverage = "complete";
	producer.criteria = ["input", "order"].map(id => ({ id, statement: `Preserve ${id}`, obligation: { id, revision: 1 },
		evaluations: [{ id: `${id}-oracle`, revision: 1 }], dependsOn: [], environment: "fixture-node", workload: "fixture" }));
	factory.goals.commit(batch("producer", [producer, { ...producer, id: "unrelated" }]), f.authority());
	const siblingAuthority = f.authority();
	assert.ok(siblingAuthority.binding);
	siblingAuthority.binding.charter = { id: "sibling", revision: 1 };
	factory.squads.commit(batch("sibling", [charter("sibling")]), siblingAuthority);
	siblingAuthority.expectedPlanRevision = f.store.readCurrent(f.planId).revision;
	const consumer = { ...producer, id: "consumer", candidateId: "consumer", charter: { id: "sibling", revision: 1 } };
	const input = { ...dependency("artifact", "consumer", "producer"), relation: /** @type {const} */ ("artifact"), criterionIds: ["input"],
		producer: { goal: { id: "producer", revision: 1 }, charter: producer.charter, planId: "generate-producer", taskId: "T-001",
			attemptId: "T-001-A001", commit: COMMIT, artifact, contract: producer.contract,
			evaluators: contract.evaluations.map(evaluation => ({ evaluation, procedureDigest: PROCEDURE.digest })) } };
	factory.goals.commit(batch("consumer", [consumer, input]), siblingAuthority);
	factory.goals.commit(batch("parent", [{ ...producer, id: "parent" },
		{ ...dependency("decomposition", "parent", "consumer"), relation: "subgoal", criterionIds: ["input"] }]), f.authority());
	assert.equal(open().goals.inspect({ id: "parent", revision: 1 }).rollup.status, "closed");
	const unchanged = open().goals.inspect({ id: "consumer", revision: 1 }).rollup.criteria[1];
	assert.throws(() => batch("substituted-producer", [{ ...input, revision: 2, previous: { id: input.id, revision: 1 },
		producer: { ...input.producer, attemptId: "T-001-A999" } }]), { code: "goal_producer_mismatch" });

	const oldPlan = f.store.readCurrent(f.planId);
	const cancelled = f.admission.cancel(f.fence);
	assert.ok(cancelled.attempt);
	const observed = f.admission.retainObservation(admissionFence(cancelled), { attempt: cancelled.attempt,
		sessionIds: ["fixture-worker"], runIds: [], source: "Synthetic terminal observation", capturedAt: clock });
	const settled = f.admission.settle(admissionFence(observed), observed.obligations.map(obligation => ({
		...obligation, disposition: /** @type {const} */ ("session-terminated"),
		inventory: { complete: true, source: "Synthetic terminal inventory, not live App", capturedAt: "2099-01-01T00:00:00.000Z" },
	})));
	f.admission.release(admissionFence(settled));
	let plan = completeTaskAttempt(oldPlan, "T-001", "T-001-A001", "failed", { error: "Fixture worker stopped", sessionTerminatedAt: clock });
	plan = reserveTaskAttempt(retryTask(plan, "T-001"), "T-001", { reservationId: "replacement" });
	plan = attachTaskAttempt(plan, "T-001", "T-001-A002", { sessionId: "replacement-worker", branch: "fixture/replacement" });
	await f.store.update(f.planId, oldPlan.revision, plan);
	const identity = { ...f.fence.admission, reservationId: "replacement" };
	const claimed = f.admission.claim({ identity, expectedRevision: 0, resources: [], team: null });
	const reserved = f.admission.bindReservation(admissionFence(claimed), { ...identity, attemptId: "T-001-A002" });
	f.observation.sessionId = "replacement-worker";
	const authority = f.authority();
	assert.ok(authority.binding);
	authority.attemptId = "T-001-A002";
	authority.fence = admissionFence(reserved);
	authority.binding = { ...authority.binding, attemptId: authority.attemptId, sessionId: "replacement-worker", observationDigest: analysisInputDigest("replacement") };
	const replacementSource = { ...historicalIdentity, identity: analysisInputDigest("replacement-worker") };
	clock = new Date(Date.parse(clock) + 1).toISOString();
	factory.squads.commit(batch("replacement-decision", [{ ...lesson, id: "replacement-lesson", source: replacementSource }], replacementSource), authority);
	authority.expectedPlanRevision = f.store.readCurrent(f.planId).revision;
	factory.goals.commit(batch("producer-change", [{ ...producer, revision: 2, previous: { id: producer.id, revision: 1 },
		source: replacementSource, intent: "Changed input contract still requires explicit consumer revalidation" }], replacementSource), authority);
	const reopened = open();
	const result = reopened.goals.inspect({ id: "consumer", revision: 1 }).rollup;
	assert.equal(result.criteria[0].status, "open");
	assert.ok(result.criteria[0].reasons.some(reason => reason.includes("producer-revision-changed")));
	assert.deepEqual(result.criteria[1], unchanged);
	assert.equal(reopened.goals.inspect({ id: "unrelated", revision: 1 }).rollup.status, "closed");
	assert.deepEqual(reopened.squads.history({ id: "squad", revision: 1 }).decisions, [lesson, { ...lesson, id: "replacement-lesson", source: replacementSource }]);
	assert.equal(f.store.readCurrent(f.planId).operating?.local[0].binding?.sessionId, "fixture-worker");
	assert.equal(f.store.readCurrent(f.planId).operating?.local.at(-1)?.binding?.sessionId, "replacement-worker");
	const exported = reopened.goals.exportHistory();
	const targetRoot = path.join(f.root, "portable-model");
	await mkdir(targetRoot);
	const imported = createFactoryService({ repositoryPath: f.repo, storageRoot: targetRoot, knowledge: "local", clock: () => clock });
	imported.goals.importHistory(exported, 0);
	assert.deepEqual(parseJson(imported.goals.exportHistory()), parseJson(exported));
	assert.equal(imported.goals.inspect({ id: "consumer", revision: 1 }).rollup.status, "open");
	assert.deepEqual(imported.snapshot().candidates, []);
	assert.deepEqual(imported.snapshot().bindings, []);
});

test("canonical direct writes, replay and both import routes cannot bypass complete graph policy", async t => {
	const f = await operatingFixture(t, { rules: { charters() {}, goals() {} } });
	f.factory.operating.commit(f.batch("initial", [
		charter(), goal("left"), goal("right"), dependency("lr", "left", "right"), dependency("rl", "right", null),
	]), f.authority());
	const bad = { ...dependency("rl", "right", "left"), revision: 2, previous: { id: "rl", revision: 1 } };
	const raw = { version: /** @type {const} */ (1), id: "cycle", snapshot: f.factory.operating.snapshot().token,
		source: historicalIdentity, records: [bad] };
	const before = f.factory.exportFactory();
	const owner = f.store.readCurrent(f.planId);
	assert.throws(() => f.factory.operating.commit(raw, f.authority()), { code: "goal_cycle" });
	const document = factoryDocument(before);
	const event = document.events.find(entry => entry.action === "recordOperating");
	assert.ok(event);
	const intent = readRecord(event.input.publication);
	const records = readRecord(intent.batch).records;
	assert.ok(Array.isArray(records));
	const edge = records.map(readRecord).find(record => record.id === "rl");
	assert.ok(edge);
	edge.to = { id: "left", revision: 1 };
	const { digest: ignored, ...originalPayload } = intent;
	intent.digest = analysisInputDigest(originalPayload);
	assert.throws(() => replay(document, f.factory.repository), { code: "goal_cycle" });
	assert.throws(() => readKnowledgeDocument({ ...document, portable: true }), { code: "goal_cycle" });
	const targetRoot = path.join(f.root, "invalid-canonical-import");
	await mkdir(targetRoot);
	const target = createFactoryService({ repositoryPath: f.repo, storageRoot: targetRoot, knowledge: "local" });
	assert.throws(() => target.importFactory({ source: JSON.stringify(document), expectedRevision: 0 }), { code: "goal_cycle" });
	const page = f.factory.exportFactoryPage();
	assert.throws(() => target.importFactoryPage({ importId: "invalid-graph", expectedRevision: 0,
		page: { ...page, events: document.events } }), { code: "goal_cycle" });
	assert.equal(target.snapshot().revision, 0);
	assert.deepEqual(target.storageInfo().transfers, []);
	assert.deepEqual(f.store.readCurrent(f.planId), owner);
	assert.equal(f.factory.exportFactory(), before);
});

test("composed portable regeneration remains durably open with nine unresolved program needs", async t => {
	const f = await operatingFixture(t, { rules: {} });
	f.factory.squads.commit(f.batch("charter", [charter()]), f.authority());
	const model = regenerationGoal(historicalIdentity, { id: "squad", revision: 1 });
	f.factory.goals.commit(f.batch("regeneration", model.records), { ...f.authority(), references: model.references });
	const portable = f.open().goals.exportHistory();
	const projection = f.open().goals.inspect({ id: "hyper-regeneration", revision: 1 });
	assert.equal(projection.rollup.status, "open");
	assert.equal(projection.blockers.filter(reason => reason.includes("unresolved-requirement")).length, 9);
	assert.ok(!portable.includes("69c3dcd"));
	assert.ok(!JSON.stringify(f.open().goals.generation({ id: "hyper-regeneration", revision: 1 })).includes("calendar-comparison"));
	const retained = path.resolve("composed-regeneration");
	await mkdir(retained);
	await cp(f.root, path.join(retained, "stores"), { recursive: true });
	await writeFile(path.join(retained, "portable-v1.json"), `${portable}\n`);
	await writeFile(path.join(retained, "projection.json"), `${JSON.stringify(projection, null, 2)}\n`);
	await writeFile(path.join(retained, "provenance.json"), `${JSON.stringify({
		authority: "isolated-source-model", originalRoot: f.root, retainedRoot: retained,
		liveAppRegistered: false, sharedBoundary: "six-resource SR1; preserve Mail/Chat and shared limits",
		unresolved: ["accepted boundary/contract/evaluators", "incumbent selection", "fresh generation", "independent evaluation",
			"replacement acceptance", "consumer use", "public registration/lifecycle wiring", "supported App ownership", "data-preserving real cleanup"],
	}, null, 2)}\n`);
	const clone = path.join(retained, "reopened-repository");
	const cache = path.join(retained, "reopened-cache");
	await mkdir(clone); await mkdir(cache); seedRepository(clone);
	await cp(path.join(f.repo, ".foundry"), path.join(clone, ".foundry"), { recursive: true });
	const reopened = createFactoryService({ repositoryPath: clone, storageRoot: cache });
	assert.equal(reopened.goals.inspect({ id: "hyper-regeneration", revision: 1 }).rollup.status, "open");
	assert.deepEqual(parseJson(reopened.goals.exportHistory()), parseJson(portable));
});
