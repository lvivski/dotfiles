import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { snapshotHost, verifyHostSnapshot } from "./snapshot.mjs";
import { tmpDir } from "./fixtures/support.mjs";

test("host bundle snapshots preserve transitive files and verify hashes", () => {
	const source = tmpDir();
	mkdirSync(join(source, "lib"));
	writeFileSync(join(source, "index.mjs"), `export { ping } from "./lib/ping.mjs";\n`);
	writeFileSync(join(source, "lib", "ping.mjs"), `export const ping = () => "pong";\n`);
	writeFileSync(join(source, "lib", "manifest.json"), `{"nested":true}\n`);
	const target = join(tmpDir(), "host");
	const snapshot = snapshotHost(source, target);
	assert.equal(snapshot.entry, join(target, "index.mjs"));
	assert.match(readFileSync(join(target, "lib", "ping.mjs"), "utf8"), /pong/);
	assert.equal(verifyHostSnapshot(target).manifest.files.length, 3);
	assert.match(readFileSync(join(target, "lib", "manifest.json"), "utf8"), /nested/);
	writeFileSync(join(target, "extra.mjs"), "export const injected = true;");
	assert.throws(() => verifyHostSnapshot(target), /not covered by its manifest/);
	rmSync(join(target, "extra.mjs"));
	writeFileSync(join(target, "lib", "ping.mjs"), "tampered");
	assert.throws(() => verifyHostSnapshot(target), /integrity verification/);
});

test("single-file hosts reject relative imports and direct authors to bundles", () => {
	const source = join(tmpDir(), "host.mjs");
	writeFileSync(source, `export { ping } from "./ping.mjs";\n`);
	assert.throws(() => snapshotHost(source, join(tmpDir(), "snapshot")), /bundle directory/);
});
