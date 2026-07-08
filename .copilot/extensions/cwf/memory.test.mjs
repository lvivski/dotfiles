/** @module memory.test — durable text memory: unset no-op, round-trip, dry-run read-only. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { Memory } from "./memory.mjs";
import { tmpDir } from "./fixtures/support.mjs";

test("a bare ~ and a leading ~/ expand to the home directory", () => {
	assert.equal(new Memory("~").path, homedir());
	assert.equal(new Memory("~/mem.txt").path, join(homedir(), "mem.txt"));
});

test("unset memory: not enabled, reads empty, writes are no-ops", () => {
	const m = new Memory(null);
	assert.equal(m.enabled, false);
	assert.equal(m.read(), "");
	m.write("x");
	m.append("y");
	assert.equal(m.read(), "");
});

test("write / read / append / clear round-trip", () => {
	const path = join(tmpDir(), "mem.txt");
	const m = new Memory(path);
	assert.equal(m.enabled, true);
	assert.equal(m.read(), ""); // absent file
	m.write("hello");
	assert.equal(m.read(), "hello");
	m.clear();
	assert.equal(m.read(), "");
	// append newline-terminates each note so successive notes land on their own line
	m.append("first");
	m.append("second");
	assert.equal(m.read(), "first\nsecond\n");
});

test("read-only (dry-run) memory: reads work, writes are skipped", () => {
	const path = join(tmpDir(), "mem.txt");
	new Memory(path).write("seed");
	const logs = /** @type {string[]} */ ([]);
	const m = new Memory(path, { readOnly: true, log: (s) => logs.push(s) });
	assert.equal(m.read(), "seed");
	m.write("nope");
	m.append("nope2");
	assert.equal(readFileSync(path, "utf8"), "seed"); // unchanged
	assert.ok(logs.some((l) => /dry-run/.test(l)));
});

test("append creates parent directories", () => {
	const path = join(tmpDir(), "nested", "deep", "mem.txt");
	const m = new Memory(path);
	m.append("line");
	assert.ok(existsSync(path));
	assert.equal(m.read(), "line\n");
});
