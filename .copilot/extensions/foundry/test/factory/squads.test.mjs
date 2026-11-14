import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createSquadAuthority, createSquadService } from "../../application/squads.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { createFactoryService } from "../../factory.mjs";
import { operatingRecords } from "../../factory/operating.mjs";
import { validateSquads } from "../../factory/squads.mjs";
import { operatingRecord } from "../../plan/schemas/operating.mjs";
import { createPlanStore } from "../../storage.mjs";
import { charter, historicalIdentity, operatingFixture } from "./operating.mjs";

/** @param {string} [id] @returns {import("../../types/operating.js").OperatingDecision} */
function decision(id = "lesson") {
	return { version: 1, kind: "decision", id, revision: 1, previous: null, source: historicalIdentity, context: [],
		charter: { id: "squad", revision: 1 }, goal: null, category: "observation", status: "observation",
		rationale: "Retain a bounded safe lesson rather than a conversation", governing: [] };
}
/** @param {import("node:test").TestContext} t */
async function fixture(t) {
	const f = await operatingFixture(t, { rules: { charters: validateSquads } });
	f.ports.native = createSquadAuthority({ ownership: f.native, coordinatorSessionId: "fixture-coordinator" });
	const service = createSquadService({ operating: f.factory.operating });
	return { ...f, service, reopen: () => createSquadService({ operating: f.open().operating }) };
}

test("SG-SQUAD-01 immutable charter and decision revisions persist, reopen and transfer without becoming governing", async t => {
	const f = await fixture(t);
	const initial = [charter(), decision(), { ...decision("proposal"), category: /** @type {const} */ ("proposal"), status: /** @type {const} */ ("proposal") }];
	f.service.commit(f.batch("initial", initial), f.authority());
	const next = { ...charter("squad", 2), purpose: "A revised bounded purpose" };
	const revised = { ...decision(), revision: 2, previous: { id: "lesson", revision: 1 }, rationale: "Clarified lesson, unchanged attribution" };
	const secondAuthority = f.authority();
	assert.ok(secondAuthority.binding);
	secondAuthority.binding.charter.revision = 2;
	f.service.commit(f.batch("charter-revision", [next]), secondAuthority);
	f.service.commit(f.batch("decision-revision", [revised]), f.authority());
	const history = f.reopen().history({ id: "squad", revision: 1 });
	assert.equal(history.authority, "historical");
	assert.equal(history.binding.state, "unresolved");
	assert.deepEqual(history.revisions, [initial[0], next]);
	assert.deepEqual(history.decisions, [initial[1], initial[2], revised]);
	assert.equal(f.reopen().generation({ id: "squad", revision: 1 }).charter.purpose, charter().purpose);
	assert.throws(() => f.batch("stale-revision", [charter("squad", 2)]), { code: "operating_revision_conflict" });
	assert.throws(() => f.batch("bad-predecessor", [{ ...charter("squad", 3), previous: { id: "foreign", revision: 2 } }]));
	assert.throws(() => f.batch("escalate", [{ ...revised, revision: 3, previous: { id: "lesson", revision: 2 },
		category: "plan", status: "historical" }]));
	const target = path.join(f.root, "portable-import");
	await mkdir(target);
	const restored = createFactoryService({ repositoryPath: f.repo, storageRoot: target, knowledge: "local", operating: f.ports });
	restored.importFactory({ source: f.factory.exportFactory(), expectedRevision: 0 });
	const imported = createSquadService({ operating: restored.operating });
	assert.deepEqual(imported.history({ id: "squad", revision: 1 }), history);
	assert.deepEqual(restored.snapshot().contracts, []);
	assert.deepEqual(restored.snapshot().decisions, []);
	assert.deepEqual(imported.history({ id: "squad", revision: 1 }).decisions.map(item => item.kind === "decision" && item.status),
		["observation", "proposal", "observation"]);
});

test("SG-SQUAD-02 names never merge distinct squads or resolve an unknown identity", async t => {
	const f = await fixture(t);
	f.service.commit(f.batch("first", [charter()]), f.authority());
	const second = charter("different-squad");
	const authority = f.authority();
	assert.ok(authority.binding);
	authority.binding.charter.id = second.id;
	f.service.commit(f.batch("second", [second]), authority);
	assert.equal(f.service.history({ id: "squad", revision: 1 }).charter.name, f.service.history({ id: second.id, revision: 1 }).charter.name);
	assert.notEqual(f.service.history({ id: "squad", revision: 1 }).charter.id, f.service.history({ id: second.id, revision: 1 }).charter.id);
	assert.throws(() => f.service.history({ id: "fixture-squad", revision: 1 }), { code: "squad_charter_missing" });
	assert.throws(() => f.service.commit(f.batch("missing-binding", [decision()]), { ...f.authority(), binding: null }),
		{ code: "squad_binding_unresolved" });
	assert.equal(f.store.readCurrent(f.planId).operating?.publications.length, 2);
});

test("SG-SQUAD-05 portable export/import excludes local references and active bindings while generation excludes comparison inputs", async t => {
	const f = await fixture(t);
	const record = charter();
	record.context = [
		{ id: "safe", kind: "artifact", digest: analysisInputDigest("public-schema"), usage: "generation",
			knowledge: null, artifact: { kind: "schema", ref: "spec/public-schema", digest: analysisInputDigest("public-schema") } },
		{ id: "private", kind: "knowledge", digest: analysisInputDigest("private-reference"), usage: "private", knowledge: null, artifact: null },
		{ id: "incumbent", kind: "artifact", digest: analysisInputDigest("comparison-reference"), usage: "comparison-only", knowledge: null, artifact: null },
	];
	const authority = f.authority();
	authority.references = [
		{ id: "private", kind: "context", ref: "/private/context-sentinel", digest: analysisInputDigest("private-reference") },
		{ id: "incumbent", kind: "comparison", ref: "/private/incumbent-source-sentinel", digest: analysisInputDigest("comparison-reference") },
	];
	const publication = f.service.commit(f.batch("private-continuity", [record]), authority);
	assert.deepEqual(f.store.readCurrent(f.planId).operating?.local[0].references, authority.references);
	assert.deepEqual(f.reopen().generation({ id: "squad", revision: 1 }).charter.context, [record.context[0]]);
	const portable = f.factory.exportFactory();
	const exportedPlan = await f.store.exportPlan(f.planId);
	for (const serialized of [portable, exportedPlan, JSON.stringify(f.reopen().generation({ id: "squad", revision: 1 }))]) {
		assert.ok(!serialized.includes("/private/context-sentinel"));
		assert.ok(!serialized.includes("/private/incumbent-source-sentinel"));
		assert.ok(!serialized.includes("observationDigest"), "No active binding is portable");
	}
	const head = JSON.parse(await readFile(path.join(f.repo, ".foundry/repository.json"), "utf8"));
	const repositoryObject = await readFile(path.join(f.repo, ".foundry/objects", `${head.head}.json`), "utf8");
	assert.ok(!repositoryObject.includes("/private/"));
	const importedRoot = path.join(f.root, "imported-owner");
	await mkdir(importedRoot);
	const imported = createPlanStore({ workspacePath: importedRoot });
	await imported.importPlan(f.store.readCurrent(f.planId), { expectedRevision: 0 });
	assert.deepEqual(imported.readCurrent(f.planId).operating?.local, []);
	assert.throws(() => imported.operating.require(f.planId, publication.digest), { code: "operating_authorization_missing" });
	assert.equal(await imported.getApprovalDelegation("fixture-grant"), null);
	assert.deepEqual(operatingRecords(f.open().snapshot()), [record]);
});

test("SG-SQUAD-07 closed decision records retain exact source and category without self-independent or human claims", async t => {
	const f = await fixture(t);
	const record = { ...charter(), decisions: /** @type {import("../../types/operating.js").OperatingCategory[]} */ (["observation", "proposal", "human"]) };
	f.service.commit(f.batch("initial", [record]), f.authority());
	for (const entry of [
		{ ...decision(), independent: true },
		{ ...decision(), source: { ...historicalIdentity, authority: "accepted" } },
		{ ...decision(), category: "human", status: "historical" },
		{ ...decision(), category: "observation", status: "historical" },
		{ ...decision(), charter: { id: "squad", revision: 9 } },
		{ ...decision(), governing: [{ id: "invented-acceptance", revision: 1 }] },
		{ ...decision(), rationale: "x".repeat(2049) },
		{ ...decision(), conversation: ["private dialogue"] },
	]) assert.throws(() => f.batch("invalid", [/** @type {import("../../types/operating.js").OperatingDecision} */ (entry)]));
	assert.throws(() => operatingRecord({ ...record, context: [{ ...record.context[0], payload: "credential-sentinel" }] }));
	f.service.commit(f.batch("valid", [decision()]), f.authority());
	const retained = f.reopen().history({ id: "squad", revision: 1 }).decisions[0];
	assert.deepEqual(retained, decision());
	assert.equal(f.open().snapshot().candidates.length, 0, "A decision entry cannot create evaluator evidence");
});

test("SG-SQUAD-01/07 import rejects authority laundering through a decision revision atomically", async t => {
	const f = await fixture(t);
	f.service.commit(f.batch("initial", [charter(), decision("proposal")]), f.authority());
	const revision = { ...decision("proposal"), revision: 2, previous: { id: "proposal", revision: 1 }, rationale: "Clarification" };
	f.service.commit(f.batch("revision", [revision]), f.authority());
	const exported = JSON.parse(f.factory.exportFactory());
	const publication = exported.events.filter(/** @param {{action: string}} entry */ entry => entry.action === "recordOperating").at(-1).input.publication;
	publication.batch.records[0].source.identity = analysisInputDigest("foreign-actor");
	const { digest: ignored, ...payload } = publication;
	publication.digest = analysisInputDigest(payload);
	const target = path.join(f.root, "invalid-import");
	await mkdir(target);
	const imported = createFactoryService({ repositoryPath: f.repo, storageRoot: target, knowledge: "local", operating: f.ports });
	assert.throws(() => imported.importFactory({ source: JSON.stringify(exported), expectedRevision: 0 }), { code: "squad_decision_immutable" });
	assert.equal(imported.snapshot().revision, 0);
	assert.equal(imported.snapshot().operating, undefined);
});

test("SG-SQUAD-05 exact context references are checked and retained privacy labels cannot be downgraded", async t => {
	const f = await fixture(t);
	const record = charter();
	const privateDigest = analysisInputDigest("incumbent");
	record.context = [{ id: "incumbent", kind: "artifact", digest: privateDigest, usage: "comparison-only", knowledge: null, artifact: null }];
	f.service.commit(f.batch("initial", [record, decision()]), f.authority());
	const context = { id: "lesson", kind: /** @type {const} */ ("decision"), usage: /** @type {const} */ ("generation"),
		knowledge: { id: "lesson", revision: 1 }, artifact: null, digest: analysisInputDigest(decision()) };
	const next = { ...charter("squad", 2), context: [context] };
	const authority = f.authority();
	assert.ok(authority.binding);
	authority.binding.charter.revision = 2;
	assert.throws(() => f.batch("wrong-context", [{ ...next, context: [{ ...context, digest: "f".repeat(64) }] }]), { code: "squad_context_invalid" });
	assert.throws(() => f.batch("missing-context", [{ ...next, context: [{ ...context, knowledge: { id: "missing", revision: 1 } }] }]),
		{ code: "squad_context_missing" });
	assert.throws(() => f.batch("privacy-downgrade", [{ ...next, context: [{ id: "fresh-label", kind: "artifact", usage: "generation",
		digest: privateDigest, knowledge: null, artifact: { kind: "implementation", ref: "incumbent/source", digest: privateDigest } }] }]),
		{ code: "squad_comparison_context" });
	f.service.commit(f.batch("pinned-safe-context", [next]), authority);
	assert.deepEqual(f.reopen().generation({ id: "squad", revision: 2 }).charter.context, [context]);
	assert.deepEqual(f.reopen().generation({ id: "squad", revision: 1 }).charter.context, []);
});
