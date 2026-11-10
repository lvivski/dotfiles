import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanningArgs } from "../../analysis/planning.mjs";
import { createAuthority } from "../../bridge/authority.mjs";
import { parseJson, readRecord } from "../../data.mjs";
import { stableStringify } from "../../digest.mjs";
import { createFactoryService } from "../../factory.mjs";
import { DISCOVERY_BOUNDS, discoveryContext, retrieveKnowledge } from "../../factory/context.mjs";
import { createFoundryOperations } from "../../operations.mjs";
import { decodeRequest } from "../../requests.mjs";
import { buildFoundryTools } from "../../tools.mjs";
import { must } from "../assertions.mjs";
import { analysisFixture } from "../native/fixture.mjs";
import { fixture } from "./fixture.mjs";

test("old causal knowledge survives more than 100 operational observations with safe repeatable discovery inputs", async (t) => {
	const f = await fixture(t);
	f.createUnit();
	f.call("appendKnowledge", {
		id: "allocation-lesson", unitId: "ledger", kind: "inference", statement: "Allocation must conserve caller-owned records",
		source: { ...f.source(), ref: "comparison-only/incumbent/private.mjs", sessionId: "/private/transcript" },
	});
	f.call("appendKnowledge", {
		id: "allocation-proposal", unitId: "ledger", kind: "proposal", statement: "Use a separate allocation result",
		source: f.source(), links: [{ relation: "derived-from", target: { id: "allocation-lesson", revision: 1 } }],
	});
	for (let index = 0; index < 115; index++) f.call("appendKnowledge", {
		id: `attempt-${index}`, unitId: "ledger", kind: "observation", statement: "Allocation task completed",
		source: f.source("implementation"), uncertainty: "Task report is an implementation claim, not an accepted obligation.",
	});
	const state = f.factory.snapshot();
	const context = discoveryContext(state, "ledger", { query: "allocation" });
	assert.equal(context.rationale[0].id, "allocation-proposal");
	assert.ok(context.rationale.some((entry) => entry.id === "allocation-lesson" && entry.selectionReasons.some((reason) => reason.startsWith("linked:"))));
	assert.equal(context.rationale.length, DISCOVERY_BOUNDS.knowledge);
	assert.equal(context.retrieval.omitted, 117 - DISCOVERY_BOUNDS.knowledge);
	assert.ok(context.rationale.every((entry) => entry.authority === "non-governing"));
	assert.doesNotMatch(JSON.stringify(context), /comparison-only\/incumbent|private\/transcript|"source"|"evaluation"/);
	assert.deepEqual(discoveryContext(state, "ledger", { query: "allocation" }), context);
	const ops = createFoundryOperations({
		getWorkspacePath: () => f.root, factoryStorageRoot: f.root,
		analysis: analysisFixture({ preparePlanning: async (input) => {
			const args = buildPlanningArgs(input);
			return { workflow: "plan", inputDigest: args.inputDigest, launchSpec: { name: "plan", args } };
		} }),
	});
	const prepared = await ops.preparePlan({ repositoryPath: f.repositoryPath, unitId: "ledger", objective: "allocation", repositoryContext: "Discovery fixture" });
	assert.deepEqual(readRecord(readRecord(prepared.launchSpec.args).factoryContext).rationale, context.rationale);
	assert.equal(readRecord(readRecord(readRecord(prepared.launchSpec.args).factoryContext).retrieval).query, "allocation");
});

test("contradictions, signals and superseded revisions are explained without expanding an accepted seal", async (t) => {
	const f = await fixture(t);
	f.createUnit();
	f.contract();
	const candidate = f.prepare("sealed-before-learning", 1);
	const original = f.factory.generation(candidate.id);
	f.call("appendKnowledge", {
		id: "input-discovery", unitId: "ledger", kind: "inference", statement: "Caller input mutation contradicts preservation",
		source: f.source(), links: [{ relation: "contradicts", target: { id: "balance-contract", revision: 1 } }],
	});
	f.call("recordSignal", {
		id: "caller-incident", kind: "incident", summary: "Caller-owned records were modified", unitIds: ["ledger"],
		knowledgeRefs: [{ id: "input-discovery", revision: 1 }], source: f.source("operational"),
	});
	const beforeAcceptance = discoveryContext(f.factory.snapshot(), "ledger");
	assert.ok(beforeAcceptance.rationale.some((entry) => entry.id === "input-discovery" && entry.selectionReasons.includes("active-signal")));
	assert.ok(beforeAcceptance.rationale.some((entry) => entry.selectionReasons.includes("unresolved-knowledge")));
	f.contract(2);
	const retrieved = discoveryContext(f.factory.snapshot(), "ledger");
	const old = must(retrieved.rationale.find((entry) => entry.id === "balance-contract" && entry.revision === 1));
	const current = must(retrieved.rationale.find((entry) => entry.id === "balance-contract" && entry.revision === 2));
	assert.equal(old.revisionStatus, "superseded");
	assert.deepEqual(old.supersededBy, [{ id: "balance-contract", revision: 2 }]);
	assert.equal(current.revisionStatus, "current");
	assert.equal(old.authority, "non-governing");
	assert.equal(current.authority, "non-governing");
	assert.equal(retrieved.signals[0].id, "caller-incident");
	assert.deepEqual(f.factory.generation(candidate.id), original);
	assert.equal(f.factory.snapshot().candidates[0].contextDigest, candidate.contextDigest);
	const inspected = f.factory.inspect({ kinds: ["obligation"] }).knowledge;
	assert.equal(inspected.find((entry) => entry.revision === 1)?.authority, "historically-accepted");
	assert.equal(inspected.find((entry) => entry.revision === 2)?.authority, "accepted");
});

test("connected retrieval terminates on cycles and reports its explicit traversal and byte bounds", async (t) => {
	const f = await fixture(t);
	f.createUnit();
	const state = f.factory.snapshot();
	state.knowledge = Array.from({ length: 150 }, (_, index) => ({
		id: `cycle-${String(index).padStart(3, "0")}`, revision: 1, unitId: "ledger", kind: "inference",
		statement: index === 0 ? "Requested cycle root" : "A retained causal lesson",
		source: f.source(), recordedAt: "2026-01-01T00:00:00.000Z", uncertainty: null, evaluation: null,
		links: [{ relation: "derived-from", target: { id: `cycle-${String((index + 1) % 150).padStart(3, "0")}`, revision: 1 } }],
	}));
	const selection = retrieveKnowledge(state, { unitId: "ledger", relatedTo: [{ id: "cycle-000", revision: 1 }] });
	assert.equal(selection.traversal.visited, DISCOVERY_BOUNDS.connectedRevisions);
	assert.equal(selection.traversal.complete, false);
	assert.ok(selection.traversal.omittedFrontier > 0);
	assert.equal(new Set(selection.entries.map(({ entry }) => entry.id)).size, selection.entries.length);
	assert.deepEqual(retrieveKnowledge(state, { unitId: "ledger", relatedTo: [{ id: "cycle-000", revision: 1 }] }), selection);
	state.knowledge.forEach((entry) => { entry.statement += "🙂".repeat(1900); });
	const context = discoveryContext(state, "ledger", { query: "Requested cycle root" });
	assert.ok(Buffer.byteLength(stableStringify(context.rationale)) <= DISCOVERY_BOUNDS.knowledgeBytes);
	assert.ok(context.retrieval.omittedByBytes > 0);
	assert.ok(context.retrieval.omitted > 0);
	assert.equal(context.rationale[0].id, "cycle-000");
	assert.equal(context.rationale[0].statement, state.knowledge[0].statement, "Whole records are selected; statements are not clipped");
});

test("discovery fails explicitly when its whole pinned boundary and bounded knowledge cannot fit", async (t) => {
	const f = await fixture(t);
	const declarations = Array.from({ length: 16 }, (_, index) => `${index}:`.padEnd(2048, "x"));
	f.call("createUnit", {
		id: "large", name: "Large boundary", purpose: "Exercise the explicit context capacity",
		boundary: { owns: declarations, exposes: declarations, consumes: [], preserves: declarations },
		dependencies: [], relationshipCoverage: "complete", actor: "owner",
	});
	for (let index = 0; index < 8; index++) f.call("appendKnowledge", {
		id: `large-lesson-${index}`, unitId: "large", kind: "inference", statement: "Retained lesson ".padEnd(7800, "x"), source: f.source(),
	});
	const authority = createAuthority({ workspace: () => f.root, storageRoot: f.root, clock: f.clock });
	assert.throws(() => authority.context(f.repositoryPath, "large"), { code: "factory_context_capacity" });
	assert.deepEqual(f.factory.snapshot().units[0].boundary.owns, declarations);
});

test("inspection pages keep one immutable snapshot through appends, acceptance and provider restart", async (t) => {
	const f = await fixture(t);
	f.createUnit();
	f.call("appendKnowledge", {
		id: "old-obligation", unitId: "ledger", kind: "obligation", statement: "Preserve the old allocation lesson", source: f.source(),
	});
	f.call("appendKnowledge", {
		id: "reference-evaluator", unitId: "ledger", kind: "evaluation", statement: "Check preserved allocation behavior", source: f.source(),
		evaluation: {
			modality: "boundary", procedure: { kind: "reference", ref: "fixture:allocation-rubric", digest: "b".repeat(64) },
			obligations: [{ id: "old-obligation", revision: 1 }], environment: "fixture", workload: "fixture",
			maxAgeSeconds: 86400, independent: true, preservation: true,
		},
	});
	for (let index = 0; index < 110; index++) f.call("appendKnowledge", {
		id: `noise-${index}`, unitId: "ledger", kind: "observation", statement: "Completed ordinary attempt", source: f.source("implementation"),
	});
	const first = f.factory.inspect({ unitId: "ledger", limit: 25 });
	assert.equal(first.knowledge.some((entry) => entry.id === "old-obligation"), false);
	assert.equal(first.page.omittedAfter.knowledge, 87);
	assert.equal(first.page.bounds.perCollection, 100);
	f.call("acceptContract", {
		unitId: "ledger", unitRevision: 1, obligations: [{ id: "old-obligation", revision: 1 }], evaluations: [{ id: "reference-evaluator", revision: 1 }],
		actor: "owner", reason: "Acceptance after the inspection snapshot must not rewrite that page",
	});
	f.call("appendKnowledge", { id: "after-snapshot", unitId: "ledger", kind: "observation", statement: "New append", source: f.source() });
	const restarted = createFactoryService({ repositoryPath: f.repositoryPath, storageRoot: f.root, clock: f.clock });
	let page = first;
	const all = [...first.knowledge];
	while (page.page.nextCursor) {
		const input = { unitId: "ledger", limit: 25, cursor: page.page.nextCursor };
		page = restarted.inspect(input);
		assert.equal(page.revision, first.revision);
		assert.equal(page.observedAt, first.observedAt);
		assert.equal(page.page.throughDigest, first.page.throughDigest);
		const { storage: previousStorage, ...stablePage } = page;
		const { storage: currentStorage, ...repeatedPage } = restarted.inspect(input);
		assert.deepEqual(repeatedPage, stablePage);
		all.push(...page.knowledge);
	}
	assert.equal(all.length, 112);
	assert.equal(new Set(all.map((entry) => `${entry.id}@${entry.revision}`)).size, 112);
	assert.equal(all.some((entry) => entry.id === "after-snapshot"), false);
	assert.equal(all.find((entry) => entry.id === "old-obligation")?.authority, "non-governing");
	assert.equal(restarted.inspect({ kinds: ["obligation"] }).knowledge[0].authority, "accepted");
	assert.throws(() => restarted.inspect({ unitId: "ledger", limit: 26, cursor: must(first.page.nextCursor) }), { code: "factory_inspection_cursor" });
	assert.throws(() => restarted.inspect({ cursor: "not-a-cursor" }), { code: "factory_inspection_cursor" });
	const altered = readRecord(parseJson(Buffer.from(must(first.page.nextCursor), "base64url").toString("utf8")));
	altered.throughDigest = "0".repeat(64);
	assert.throws(() => restarted.inspect({
		unitId: "ledger", limit: 25, cursor: Buffer.from(JSON.stringify(altered)).toString("base64url"),
	}), { code: "factory_export_changed" });
});

test("public inspection tool and decoder wire every retrieval filter and continuation cursor", async (t) => {
	const f = await fixture(t);
	f.createUnit();
	for (const [id, links] of /** @type {[string, import("../../types/factory.js").KnowledgeLink[]][]} */ ([
		["allocation-root", []], ["allocation-cause", [{ relation: "derived-from", target: { id: "allocation-root", revision: 1 } }]],
		["unrelated-inference", []],
	])) f.call("appendKnowledge", { id, unitId: "ledger", kind: "inference", statement: id, links, source: f.source() });
	f.call("appendKnowledge", { id: "allocation-noise", unitId: "ledger", kind: "observation", statement: "allocation", source: f.source("implementation") });
	const ops = createFoundryOperations({ getWorkspacePath: () => f.root, factoryStorageRoot: f.root, analysis: analysisFixture() });
	const tool = must(buildFoundryTools(ops).find((entry) => entry.name === "foundry_get_factory"));
	for (const field of ["kinds", "query", "relatedTo", "cursor"]) assert.ok(tool.parameters.properties[field]);
	const input = {
		unitId: "ledger", kinds: ["inference"], query: "allocation", relatedTo: [{ id: "allocation-root", revision: 1 }],
		limit: 1, includeRetired: false, environment: "fixture", workload: "fixture",
	};
	assert.deepEqual(decodeRequest("factoryInspect", input).relatedTo, input.relatedTo);
	/** @param {Record<string, unknown>} input */
	const invoke = async (input) => {
		const args = { repositoryPath: f.repositoryPath, ...input };
		const result = await tool.handler(args, { sessionId: "fixture", toolCallId: "inspect", toolName: tool.name, arguments: args });
		assert.equal(result.resultType, "success", result.textResultForLlm);
		return readRecord(readRecord(parseJson(result.textResultForLlm)).value);
	};
	const first = await invoke(input);
	const cursor = readRecord(first.page).nextCursor;
	assert.equal(typeof cursor, "string");
	const second = await invoke({ ...input, cursor });
	assert.equal(readRecord(first.page).revision, readRecord(second.page).revision);
	assert.deepEqual([first.knowledge, second.knowledge].flat().map((entry) => readRecord(entry).id), ["allocation-cause", "allocation-root"]);
	const longQuery = await invoke({ ...input, query: `allocation ${Array.from({ length: 40 }, (_, index) => `term${index}`).join(" ")}` });
	assert.equal(readRecord(longQuery.retrieval).omittedTerms, 9);
	assert.equal(readRecord(longQuery.page).limit, 1);
	assert.equal(readRecord(readRecord(longQuery.page).bounds).queryTerms, DISCOVERY_BOUNDS.queryTerms);
	for (const invalid of [{ kinds: ["unknown"] }, { query: 1 }, { relatedTo: [{ id: "allocation-root", revision: "1" }] }, { cursor: 1 }]) {
		await assert.rejects(ops.factoryAction({ repositoryPath: f.repositoryPath, action: "inspect", input: invalid }));
	}
	const authority = createAuthority({ workspace: () => f.root, storageRoot: f.root, clock: f.clock });
	assert.ok(authority.context(f.repositoryPath, "ledger", { query: "allocation" }).rationale.some((entry) => entry.id === "allocation-root"));
});
