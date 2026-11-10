import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseJson, readRecord, readString } from "../../data.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { fail } from "../../factory/fields.mjs";
import { createPortableLedger, readPublication } from "../../factory/portable.mjs";
import { createFactoryInspection } from "../../factory/projection.mjs";
import { FACTORY_FORMAT, applyEvent, replay } from "../../factory/replay.mjs";
import { resolveRepositoryIdentity } from "../../factory/repository.mjs";
import { createFactoryLedger } from "../../factory/storage.mjs";
import { factoryDocument } from "./accessors.mjs";

/** @param {string} repositoryPath @param {string} storageRoot */
function stores(repositoryPath, storageRoot) {
	const repository = resolveRepositoryIdentity(repositoryPath);
	const local = createFactoryLedger({ repository, storageRoot, format: FACTORY_FORMAT, now: () => new Date().toISOString(), replay, applyEvent, fail });
	return { repository, local, factory: createPortableLedger({ local, repository, repositoryPath }) };
}

/** @param {import("node:test").TestContext} t */
async function fixture(t) {
	const root = await mkdtemp(path.join(os.tmpdir(), "foundry-portable-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = path.join(root, "repo");
	await mkdir(repo);
	/** @param {string[]} args */
	const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "--quiet");
	const { repository, local, factory } = stores(repo, root);
	/** @template {import("../../types/factory.js").FactoryAction} A @param {A} action @param {Record<string, unknown>} input */
	const call = (action, input) => factory.append(action, { expectedRevision: factory.snapshot().revision, ...input });
	const source = () => ({ kind: "discovery", ref: path.join(root, "private-notes"), actor: "fixture", at: new Date().toISOString() });
	const define = () => call("createUnit", {
		id: "unit", name: "Portable capability", purpose: "Preserve capability meaning across clones",
		boundary: { owns: ["behavior"], exposes: ["interface"], consumes: [], preserves: ["user data"] },
		dependencies: [], relationshipCoverage: "complete", actor: "fixture",
	});
	const accept = () => {
		call("appendKnowledge", { id: "obligation", unitId: "unit", kind: "obligation", statement: "Preserve user data", source: source() });
		call("appendKnowledge", {
			id: "evaluation", unitId: "unit", kind: "evaluation", statement: "Evaluate the public boundary", source: source(),
			evaluation: {
				modality: "boundary", procedure: { kind: "reference", ref: "fixture:public-evaluator", digest: "a".repeat(64) },
				obligations: [{ id: "obligation", revision: 1 }], environment: "fixture", workload: "boundary",
				maxAgeSeconds: 86400, independent: true, preservation: true,
			},
		});
		return call("acceptContract", {
			unitId: "unit", unitRevision: 1, obligations: [{ id: "obligation", revision: 1 }], evaluations: [{ id: "evaluation", revision: 1 }],
			actor: "fixture", reason: "Accept portable behavior",
		}).contract;
	};
	return { root, repo, repository, local, factory, git, call, source, define, accept };
}

test("accepted knowledge survives a clone without the original database or private source paths", async (t) => {
	const f = await fixture(t);
	assert.equal(f.factory.snapshot().revision, 0);
	await assert.rejects(readFile(path.join(f.repo, ".foundry/repository.json")), { code: "ENOENT" });
	f.define();
	const contract = f.accept();
	const report = "A private source report retained only in the local journal";
	f.call("ingestAnalysis", {
		unitId: "unit", report,
		source: { kind: "audit", ref: "fixture:private", actor: "fixture", at: new Date().toISOString(), runId: "private", owner: f.root, digest: analysisInputDigest(report) },
	});
	const manifest = readRecord(parseJson(await readFile(path.join(f.repo, ".foundry/repository.json"), "utf8")));
	const object = await readFile(path.join(f.repo, ".foundry/objects", `${readString(manifest.head)}.json`), "utf8");
	assert.ok(!object.includes(f.root));
	assert.equal(readPublication(parseJson(object)).document.portable, true);
	f.git("add", ".foundry");
	f.git("-c", "user.name=Foundry fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Portable knowledge fixture");
	const clone = path.join(f.root, "clone");
	execFileSync("git", ["clone", "--quiet", f.repo, clone], { stdio: ["ignore", "pipe", "pipe"] });
	const other = stores(clone, f.root);
	assert.equal(other.repository.id, f.repository.id);
	assert.notEqual(other.local.databasePath, f.local.databasePath);
	const recovered = other.factory.snapshot();
	assert.deepEqual(recovered.contracts, f.factory.snapshot().contracts);
	assert.equal(recovered.contracts[0].digest, contract.digest);
	assert.deepEqual(recovered.bindings, []);
	assert.deepEqual(recovered.candidates, []);
	assert.match(recovered.knowledge[0].source.ref, /^local-source:/);
	const before = recovered.revision;
	other.factory.append("appendKnowledge", {
		expectedRevision: before, id: "clone-lesson", unitId: "unit", kind: "inference", statement: "Clones retain knowledge, not runtime ownership",
		source: { kind: "discovery", ref: "fixture:clone", actor: "fixture", at: new Date().toISOString() },
	});
	assert.equal(f.factory.snapshot().knowledge.some((entry) => entry.id === "clone-lesson"), false);
	const restoreRoot = path.join(f.root, "paged-restore");
	await mkdir(restoreRoot);
	const target = stores(clone, restoreRoot).local;
	let page = other.local.exportFactoryPage({ limit: 2 });
	const pin = { throughRevision: page.revision, throughDigest: page.throughDigest, limit: 2 };
	while (true) {
		assert.equal(page.portable, true);
		target.importFactoryPage({ expectedRevision: 0, importId: "portable", page });
		if (page.complete) break;
		page = other.local.exportFactoryPage({ ...pin, afterRevision: page.nextRevision });
	}
	assert.equal(target.exportFactory(), other.local.exportFactory());
	const inspect = createFactoryInspection(other.factory, other.repository, () => new Date().toISOString());
	let inspected = inspect({ unitId: "unit", limit: 1 });
	const pinnedRevision = inspected.revision;
	const collected = [...inspected.knowledge];
	other.factory.append("appendKnowledge", {
		expectedRevision: other.factory.snapshot().revision, id: "after-inspection", unitId: "unit",
		kind: "observation", statement: "This later record is outside the pinned inspection",
		source: { kind: "discovery", ref: "fixture:later", actor: "fixture", at: new Date().toISOString() },
	});
	assert.ok(inspected.page.nextCursor);
	while (inspected.page.nextCursor) {
		inspected = inspect({ unitId: "unit", limit: 1, cursor: inspected.page.nextCursor });
		assert.equal(inspected.revision, pinnedRevision);
		collected.push(...inspected.knowledge);
	}
	assert.ok(collected.some((entry) => entry.statement.startsWith("Local report omitted")));
	assert.equal(collected.some((entry) => entry.id === "after-inspection"), false);
	assert.equal(new Set(collected.map((entry) => `${entry.id}@${entry.revision}`)).size, collected.length);
});

test("knowledge rehydrates after moving a repository or losing only its rebuildable cache", async (t) => {
	const f = await fixture(t);
	f.define();
	const contract = f.accept();
	await unlink(f.local.databasePath);
	const restored = stores(f.repo, f.root);
	assert.equal(restored.factory.snapshot().contracts[0].digest, contract.digest);
	assert.equal(restored.factory.snapshot().bindings.length, 0);
	assert.equal(restored.factory.storageInfo().knowledge.importedExecutionOwnership, false);
	const moved = path.join(f.root, "moved");
	await rename(f.repo, moved);
	const relocated = stores(moved, f.root);
	assert.equal(relocated.repository.id, f.repository.id);
	assert.equal(relocated.factory.snapshot().contracts[0].digest, contract.digest);
});

test("publication recovers after the portable head commits but cache bookkeeping fails", async (t) => {
	const f = await fixture(t);
	let interrupted = false;
	const local = {
		...f.local,
		setKnowledgeMetadata(/** @type {Parameters<typeof f.local.setKnowledgeMetadata>[0]} */ input) {
			if (input.head && !interrupted) { interrupted = true; throw new Error("Injected cache bookkeeping interruption"); }
			f.local.setKnowledgeMetadata(input);
		},
	};
	const factory = createPortableLedger({ local, repository: f.repository, repositoryPath: f.repo });
	assert.throws(() => factory.append("createUnit", {
		expectedRevision: 0, id: "unit", name: "Recover", purpose: "Recover the published mutation",
		boundary: { owns: ["behavior"], exposes: ["api"], consumes: [], preserves: ["meaning"] },
		dependencies: [], relationshipCoverage: "complete", actor: "fixture",
	}), { code: "factory_publication_pending" });
	const recovered = stores(f.repo, f.root).factory;
	assert.equal(recovered.snapshot().revision, 1);
	assert.equal(recovered.snapshot().units.length, 1);
	assert.throws(() => recovered.append("createUnit", { expectedRevision: 0 }), { code: "revision_conflict" });
});

test("a divergent checked-out knowledge head holds writers instead of silently merging authority", async (t) => {
	const f = await fixture(t);
	f.define();
	const previous = await readFile(path.join(f.repo, ".foundry/repository.json"), "utf8");
	f.accept();
	await writeFile(path.join(f.repo, ".foundry/repository.json"), previous);
	assert.throws(() => f.factory.snapshot(), { code: "factory_knowledge_conflict" });
});

test("legacy authority requires explicit attributed migration and retains its exact original journal", async (t) => {
	const f = await fixture(t);
	f.local.append("createUnit", {
		expectedRevision: 0, id: "old", name: "Legacy", purpose: "Retain local history",
		boundary: { owns: ["old"], exposes: ["old-api"], consumes: [], preserves: ["history"] },
		dependencies: [], relationshipCoverage: "complete", actor: "fixture",
	});

	const original = f.local.exportFactory();
	assert.equal(f.factory.snapshot().revision, 1);
	assert.throws(() => f.factory.append("appendKnowledge", { expectedRevision: 1 }), { code: "factory_migration_required" });
	const result = f.factory.migrateFactory({ expectedRevision: 1, actor: "owner", reason: "Publish the retained knowledge explicitly" });
	assert.equal(result.originalJournalRetained, true);
	assert.equal(f.local.exportFactory(), original);
	const manifest = readRecord(parseJson(await readFile(path.join(f.repo, ".foundry/repository.json"), "utf8")));
	const publication = readPublication(parseJson(await readFile(path.join(f.repo, ".foundry/objects", `${readString(manifest.head)}.json`), "utf8")));
	assert.equal(publication.migration?.sourceDigest, analysisInputDigest(parseJson(original)));
});

test("v2 accepted seals survive migration while their local provenance is represented by commitments", async (t) => {
	const f = await fixture(t);
	f.define();
	f.accept();
	const directory = path.join(f.root, "legacy");
	await mkdir(directory);
	execFileSync("git", ["-C", directory, "init", "--quiet"], { stdio: ["ignore", "pipe", "pipe"] });
	const legacy = stores(directory, f.root);
	const document = factoryDocument(f.local.exportFactory());
	document.repository = legacy.repository;
	for (const entry of document.events) {
		delete entry.input.sourceCommitment;
		delete entry.input.statementCommitment;
		delete entry.input.sealVersion;
	}
	const historical = replay(document, legacy.repository).contracts[0];
	assert.equal(historical.sealVersion, 2);
	legacy.local.importFactory({ source: JSON.stringify(document), expectedRevision: 0 });
	const original = legacy.local.exportFactory();
	legacy.factory.migrateFactory({ expectedRevision: document.revision, actor: "owner", reason: "Retain the original v2 acceptance" });
	assert.equal(legacy.local.exportFactory(), original);
	const info = readRecord(parseJson(await readFile(path.join(directory, ".foundry/repository.json"), "utf8")));
	const publication = readPublication(parseJson(await readFile(path.join(directory, ".foundry/objects", `${readString(info.head)}.json`), "utf8")));
	const knowledge = replay(publication.document, publication.document.repository);
	assert.deepEqual(knowledge.contracts[0], historical);
	assert.ok(knowledge.knowledge.every((entry) => entry.sourceCommitment));
});

test("modified immutable objects and mismatched repository identities fail closed", async (t) => {
	const f = await fixture(t);
	f.define();
	const file = path.join(f.repo, ".foundry/repository.json");
	const info = readRecord(parseJson(await readFile(file, "utf8")));
	const object = path.join(f.repo, ".foundry/objects", `${readString(info.head)}.json`);
	const original = await readFile(object, "utf8");
	await writeFile(object, "{}");
	assert.throws(() => f.factory.snapshot(), { code: "factory_knowledge_integrity" });
	await writeFile(object, original);
	await writeFile(file, JSON.stringify({ ...info, id: "f".repeat(64) }));
	assert.throws(() => f.factory.snapshot(), { code: "factory_repository_mismatch" });
});

test("private native reports retain linked commitments without exporting raw report content", async (t) => {
	const f = await fixture(t);
	f.define();
	const report = "Private raw report with an absolute session path /Users/example/private-session";
	f.call("ingestAnalysis", {
		unitId: "unit", report,
		source: { kind: "audit", ref: "run:private", actor: "fixture", at: new Date().toISOString(), runId: "private-run", owner: f.root, digest: analysisInputDigest(report) },
	});
	const retained = f.local.snapshot().knowledge[0];
	assert.ok(retained);
	f.call("appendKnowledge", {
		id: "portable-lesson", unitId: "unit", kind: "inference", statement: "An explicit portable lesson is retained",
		source: f.source(), links: [{ relation: "derived-from", target: { id: retained.id, revision: retained.revision } }],
	});
	f.accept();
	const contract = f.call("acceptContract", {
		unitId: "unit", unitRevision: 1, obligations: [{ id: "obligation", revision: 1 }], evaluations: [{ id: "evaluation", revision: 1 }],
		rationale: [{ id: "portable-lesson", revision: 1 }], actor: "owner", reason: "Accept the portable lesson, not its raw local report",
	}).contract;
	const manifest = readRecord(parseJson(await readFile(path.join(f.repo, ".foundry/repository.json"), "utf8")));
	const serialized = await readFile(path.join(f.repo, ".foundry/objects", `${readString(manifest.head)}.json`), "utf8");
	assert.ok(!serialized.includes(report));
	const publication = readPublication(parseJson(serialized));
	const restored = replay(publication.document, publication.document.repository);
	assert.equal(restored.contracts.at(-1)?.digest, contract.digest);
	assert.match(restored.knowledge[0].statement, /^Local report omitted/);
	assert.equal(f.local.snapshot().knowledge[0].statement, report);
});

test("private v2 context stays historical through republication until explicit portable re-acceptance", async (t) => {
	const f = await fixture(t);
	f.define();
	const report = "Legacy private rationale";
	f.call("ingestAnalysis", {
		unitId: "unit", report,
		source: { kind: "audit", ref: "fixture:legacy-private", actor: "fixture", at: new Date().toISOString(), runId: "legacy-private", owner: f.root, digest: analysisInputDigest(report) },
	});
	const rationale = f.local.snapshot().knowledge[0];
	f.accept();
	f.call("acceptContract", {
		unitId: "unit", unitRevision: 1, obligations: [{ id: "obligation", revision: 1 }], evaluations: [{ id: "evaluation", revision: 1 }],
		rationale: [{ id: rationale.id, revision: 1 }], actor: "owner", reason: "Historical acceptance of local rationale",
	});
	f.call("createUnit", {
		id: "dependent", name: "Dependent capability", purpose: "Reuse a historically accepted foundation",
		boundary: { owns: ["dependent-behavior"], exposes: ["dependent-api"], consumes: ["interface"], preserves: ["user data"] },
		dependencies: ["unit"], relationshipCoverage: "complete", actor: "owner",
	});
	f.call("appendKnowledge", {
		id: "dependent-obligation", unitId: "dependent", kind: "obligation", statement: "Preserve the foundation's behavior", source: f.source(),
	});
	f.call("appendKnowledge", {
		id: "dependent-evaluation", unitId: "dependent", kind: "evaluation", statement: "Check dependency composition", source: f.source(),
		evaluation: {
			modality: "boundary", procedure: { kind: "reference", ref: "fixture:dependent-oracle", digest: "b".repeat(64) },
			obligations: [{ id: "dependent-obligation", revision: 1 }], environment: "fixture", workload: "composition",
			maxAgeSeconds: 86400, independent: true, preservation: true,
		},
	});
	const dependentAcceptance = {
		unitId: "dependent", unitRevision: 1, obligations: [{ id: "dependent-obligation", revision: 1 }],
		evaluations: [{ id: "dependent-evaluation", revision: 1 }], actor: "owner", reason: "Accept the current foundation contract",
	};
	f.call("acceptContract", dependentAcceptance);
	const directory = path.join(f.root, "legacy-private");
	await mkdir(directory);
	execFileSync("git", ["-C", directory, "init", "--quiet"], { stdio: ["ignore", "pipe", "pipe"] });
	const legacy = stores(directory, f.root);
	const document = factoryDocument(f.local.exportFactory());
	document.repository = legacy.repository;
	for (const entry of document.events) {
		delete entry.input.sourceCommitment;
		delete entry.input.statementCommitment;
		delete entry.input.sealVersion;
	}
	const historical = replay(document, legacy.repository).contracts.find((entry) => entry.unitId === "unit" && entry.revision === 2);
	legacy.local.importFactory({ source: JSON.stringify(document), expectedRevision: 0 });
	legacy.factory.migrateFactory({ expectedRevision: document.revision, actor: "owner", reason: "Keep private context historical" });
	const freshCache = path.join(f.root, "private-cache");
	await mkdir(freshCache);
	const restored = stores(directory, freshCache).factory;
	assert.equal(restored.snapshot().contracts[1].historyOnly, true);
	assert.equal(restored.snapshot().contracts[1].digest, historical?.digest);
	assert.equal(restored.snapshot().contracts[2].unitId, "dependent");
	const candidate = {
		id: "candidate", unitId: "unit", contractRevision: 2, actor: "fixture",
		context: { generation: [], comparisonOnly: [], independence: { method: "fresh-session", reason: "Only accepted portable inputs" } },
	};
	assert.throws(() => restored.append("prepareCandidate", { ...candidate, expectedRevision: restored.snapshot().revision }),
		{ code: "factory_contract_reacceptance_required" });
	const dependentCandidate = { ...candidate, id: "dependent-candidate", unitId: "dependent", contractRevision: 1 };
	assert.throws(() => restored.append("prepareCandidate", { ...dependentCandidate, expectedRevision: restored.snapshot().revision }),
		{ code: "factory_contract_reacceptance_required" });
	const accepted = restored.append("acceptContract", {
		expectedRevision: restored.snapshot().revision, unitId: "unit", unitRevision: 1,
		obligations: [{ id: "obligation", revision: 1 }], evaluations: [{ id: "evaluation", revision: 1 }],
		rationale: [{ id: rationale.id, revision: 1 }], actor: "owner", reason: "Explicitly accept portable context with an opaque local source",
	}).contract;
	assert.equal(accepted.historyOnly, undefined);
	assert.equal(accepted.sealVersion, 3);
	assert.equal(restored.snapshot().contracts[1].historyOnly, true);
	assert.throws(() => restored.append("prepareCandidate", { ...dependentCandidate, expectedRevision: restored.snapshot().revision }),
		{ code: "factory_contract_reacceptance_required" });
	const refreshedDependent = restored.append("acceptContract", { ...dependentAcceptance, expectedRevision: restored.snapshot().revision }).contract;
	assert.equal(restored.append("prepareCandidate", {
		...dependentCandidate, contractRevision: refreshedDependent.revision, expectedRevision: restored.snapshot().revision,
	}).candidate.contractDigest, refreshedDependent.digest);
	assert.equal(restored.append("prepareCandidate", {
		...candidate, contractRevision: accepted.revision, expectedRevision: restored.snapshot().revision,
	}).candidate.contractDigest, accepted.digest);
});

test("a correctly hashed knowledge publication cannot bootstrap live execution authority", async (t) => {
	const f = await fixture(t);
	f.define();
	const contract = f.accept();
	const candidate = f.call("prepareCandidate", {
		id: "private-candidate", unitId: "unit", contractRevision: 1, actor: "fixture",
		context: { generation: [], comparisonOnly: [], independence: { method: "fresh-session", reason: "Local runtime only" } },
	}).candidate;
	f.call("bindPlan", {
		unitId: "unit", unitRevision: 1, contractRevision: 1, contractDigest: contract.digest, contextDigest: candidate.contextDigest,
		candidateId: candidate.id, planId: "private-plan", owner: f.root, blueprintDigest: "a".repeat(64),
	});
	const document = { ...factoryDocument(f.local.exportFactory()), portable: true };
	document.repository = { id: f.repository.id, commonDirectory: `repository:${f.repository.id}` };
	const publication = { format: "foundry-knowledge-v1", parent: null, document, selections: [], migration: null };
	assert.throws(() => readPublication(publication), { code: "factory_execution_not_portable" });
	const head = analysisInputDigest(publication);
	await writeFile(path.join(f.repo, ".foundry/objects", `${head}.json`), JSON.stringify(publication));
	await writeFile(path.join(f.repo, ".foundry/repository.json"), JSON.stringify({ format: "foundry-repository-v1", id: f.repository.id, head }));
	const emptyCache = path.join(f.root, "untrusted-cache");
	await mkdir(emptyCache);
	const restored = stores(f.repo, emptyCache);
	assert.throws(() => restored.factory.snapshot(), { code: "factory_execution_not_portable" });
	await assert.rejects(readFile(restored.local.databasePath), { code: "ENOENT" });
	for (const action of ["recordDelivery", "recordEvaluation", "decideCandidate", "retire"]) {
		assert.throws(() => readPublication({
			...publication,
			document: { ...document, revision: 1, events: [{
				revision: 1, at: new Date().toISOString(), action, input: { type: "candidate" },
			}] },
		}), { code: "factory_execution_not_portable" });
	}
});

test("repository knowledge rejects symlinked storage", async (t) => {
	const f = await fixture(t);
	const target = path.join(f.root, "elsewhere");
	await mkdir(target);
	await symlink(target, path.join(f.repo, ".foundry"));
	assert.throws(() => stores(f.repo, f.root), { code: "factory_knowledge_unsafe" });
});
