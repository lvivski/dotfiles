/** @module json.test — deterministic JSON helpers: key-order independence and stable serialization. */
import test from "node:test";
import assert from "node:assert/strict";

import { sortKeysDeep, stableStringify } from "./json.mjs";

test("sortKeysDeep sorts nested object keys, preserving array order", () => {
	assert.deepEqual(sortKeysDeep({ b: 1, a: { d: 2, c: 3 } }), { a: { c: 3, d: 2 }, b: 1 });
	assert.deepEqual(sortKeysDeep([{ b: 1, a: 2 }]), [{ a: 2, b: 1 }]);
	assert.equal(sortKeysDeep(5), 5);
});

test("stableStringify is key-order independent; undefined → \"null\"", () => {
	assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
	assert.equal(stableStringify({ a: 2, b: 1 }), '{"a":2,"b":1}');
	assert.equal(stableStringify(undefined), "null");
});

test("sortKeysDeep throws on a cycle (no infinite recursion) but allows diamonds", () => {
	const a = /** @type {any} */ ({});
	a.self = a;
	assert.throws(() => stableStringify(a), /circular/);
	const shared = { x: 1 };
	assert.equal(stableStringify({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
});
