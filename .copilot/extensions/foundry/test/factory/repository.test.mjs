import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { optional, parseJson, readBoolean, readNumber, readString, recordOf } from "../../data.mjs";
import { createFactoryService } from "../../factory.mjs";
import { fixture } from "./fixture.mjs";
import { factoryDocument } from "./accessors.mjs";

test("repository authority shares worktree identity, rejects stale writers and roundtrips only current-format JSON", async (t) => {
	const f = await fixture(t);
	f.createUnit();
	const other = createFactoryService({ repositoryPath: f.repositoryPath, storageRoot: f.root, clock: f.clock });
	const stale = other.snapshot().revision;
	f.contract();
	assert.throws(() => other.appendKnowledge({
		expectedRevision: stale, id: "stale", unitId: "ledger", kind: "observation", statement: "Stale writer", source: f.source(),
	}), { code: "revision_conflict" });
	await writeFile(path.join(f.repositoryPath, "seed"), "fixture");
	f.git("add", "seed", ".foundry");
	f.git("-c", "user.name=Factory fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "seed");
	const siblingPath = path.join(f.root, "sibling");
	f.git("worktree", "add", "--quiet", "--detach", siblingPath);
	const sibling = createFactoryService({ repositoryPath: siblingPath, storageRoot: f.root, clock: f.clock });
	assert.equal(sibling.repository.id, f.factory.repository.id);
	assert.deepEqual(sibling.snapshot(), f.factory.snapshot());
	const exportJson = f.factory.exportFactory();
	const restoreRoot = path.join(f.root, "restored");
	await mkdir(restoreRoot);
	const restored = createFactoryService({ repositoryPath: siblingPath, storageRoot: restoreRoot, clock: f.clock, knowledge: "local" });
	assert.equal(restored.importFactory({ source: exportJson, expectedRevision: 0 }).executionOwnership, "not-transferred");
	assert.equal(restored.exportFactory(), exportJson);
	assert.throws(() => restored.importFactory({ source: exportJson, expectedRevision: 0 }), { code: "factory_import_conflict" });
	const wrong = factoryDocument(exportJson);
	wrong.repository.id = "0".repeat(64);
	const emptyRoot = path.join(f.root, "empty");
	await mkdir(emptyRoot);
	const empty = createFactoryService({ repositoryPath: f.repositoryPath, storageRoot: emptyRoot, clock: f.clock, knowledge: "local" });
	assert.throws(() => empty.importFactory({ source: JSON.stringify(wrong), expectedRevision: 0 }), { code: "factory_repository_mismatch" });
	assert.equal(empty.snapshot().revision, 0);
	wrong.repository = f.factory.repository;
	wrong.events[0].input.actor = "";
	assert.throws(() => empty.importFactory({ source: JSON.stringify(wrong), expectedRevision: 0 }), { code: "factory_input_invalid" });
	wrong.format = "foundry-factory-v1";
	assert.throws(() => empty.importFactory({ source: JSON.stringify(wrong), expectedRevision: 0 }), { code: "factory_format_unsupported" });
});

test("separate factory processes cannot commit the same repository revision", async (t) => {
	const f = await fixture(t);
	const input = {
		expectedRevision: 0, id: "shared", name: "Shared authority", purpose: "Race one repository mutation",
		boundary: { owns: ["shared-authority"], exposes: ["shared-interface"], consumes: [], preserves: ["one winning mutation"] },
		dependencies: [], relationshipCoverage: "complete", actor: "fixture",
	};
	const script = `
		import {createFactoryService} from ${JSON.stringify(new URL("../../factory.mjs", import.meta.url).href)};
		import {parseJson, readRecord, errorCode} from ${JSON.stringify(new URL("../../data.mjs", import.meta.url).href)};
		const service = createFactoryService({repositoryPath:process.argv[1],storageRoot:process.argv[2]});
		try {
			const result = service.createUnit(readRecord(parseJson(process.argv[3])));
			process.stdout.write(JSON.stringify({ok:true,revision:result.revision}));
		} catch (error) {
			process.stdout.write(JSON.stringify({ok:false,code:errorCode(error)}));
		}`;
	/** @returns {Promise<{ok: boolean, revision?: number, code?: string}>} */
	const writer = () => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", script, f.repositoryPath, f.root, JSON.stringify(input)], { timeout: 10000 });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => {
			if (code !== 0) return reject(new Error(`Factory writer failed (${code}): ${stderr}`));
			try {
				resolve(recordOf({ ok: readBoolean, revision: optional(readNumber), code: optional(readString) })(parseJson(stdout)));
			} catch (error) { reject(error); }
		});
	});
	const outcomes = await Promise.all([writer(), writer()]);
	assert.equal(outcomes.filter((entry) => entry.ok).length, 1);
	const loser = outcomes.find((entry) => !entry.ok);
	assert.ok(loser);
	assert.equal(loser.code, "revision_conflict");
	assert.equal(f.factory.snapshot().revision, 1);
	assert.equal(f.factory.snapshot().units.length, 1);
});
