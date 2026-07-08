/** @module patterns.test — structured/verify/consensus/classify/tournament/generateAndFilter/synthesize. */
import test from "node:test";
import assert from "node:assert/strict";

import { structured, verify, consensus, classify, tournament, generateAndFilter, synthesize, extractLastJson, checkSchemaDef, validateShape, asText } from "./patterns.mjs";
import { mkResult } from "./fixtures/support.mjs";

/**
 * A programmable mock runtime: `responder(prompt, opts, callIndex)` returns `{ content?, ok?, error? }`.
 * @param {(prompt: string, opts: any, i: number) => ({ content?: string, ok?: boolean, error?: string } | void)} responder
 */
function mockRt(responder) {
	let calls = 0;
	const rt = {
		calls: /** @type {{ prompt: string, opts: any }[]} */ ([]),
		log() {},
		/** @param {string} prompt @param {any} [opts] */
		async agent(prompt, opts = {}) {
			const i = calls++;
			rt.calls.push({ prompt, opts });
			const r = responder(prompt, opts, i) || {};
			const ok = r.ok ?? true;
			return mkResult({ content: r.content ?? "", ok, error: ok ? null : r.error ?? "agent failed", label: opts.label, model: opts.model });
		},
		/** @param {any[]} items @param {(it: any, i: number) => any} fn */
		async fanOut(items, fn) {
			return Promise.all([...items].map((it, i) => fn(it, i)));
		},
	};
	return /** @type {any} */ (rt);
}

test("extractLastJson: last-line value, fenced, embedded, scalar, none", () => {
	assert.deepEqual(extractLastJson('blah blah\n{"a":1}'), { a: 1 });
	assert.deepEqual(extractLastJson("text `{\"a\":1}`"), { a: 1 });
	assert.deepEqual(extractLastJson("here [1,2,3] done\nnot json"), [1, 2, 3]);
	assert.equal(extractLastJson("answer: 42\n7"), 7);
	assert.equal(typeof extractLastJson("no json at all here"), "symbol"); // NOT_FOUND sentinel
});

test("checkSchemaDef rejects unsupported keywords; validateShape reports violations", () => {
	assert.throws(() => checkSchemaDef({ type: "object", anyOf: [] }), /unsupported shape-schema keyword/);
	assert.deepEqual(validateShape(3, { type: "integer" }), []);
	assert.equal(validateShape("x", { type: "integer" }).length, 1);
	assert.equal(validateShape({}, { type: "object", required: ["a"] }).length, 1);
	assert.equal(validateShape("z", { enum: ["a", "b"] }).length, 1);
});

test("structured: valid JSON matching a shape schema", async () => {
	const rt = mockRt(() => ({ content: 'here you go\n{"name":"x","n":3}' }));
	const s = await structured(rt, "give", { type: "object", properties: { name: { type: "string" }, n: { type: "integer" } }, required: ["name", "n"] });
	assert.equal(s.ok, true);
	assert.equal(s.value.name, "x");
	assert.equal(s.attempts, 1);
});

test("structured: retries with the error, then succeeds", async () => {
	const rt = mockRt((_p, _o, i) => (i === 0 ? { content: "nope not json" } : { content: '{"ok":true}' }));
	const s = await structured(rt, "x", { type: "object" });
	assert.equal(s.ok, true);
	assert.equal(s.attempts, 2);
});

test("structured: agent failure returns immediately (no wasted retries)", async () => {
	const rt = mockRt(() => ({ ok: false, error: "boom" }));
	const s = await structured(rt, "x", { type: "object" });
	assert.equal(s.ok, false);
	assert.equal(s.error, "boom");
	assert.equal(s.attempts, 1);
});

test("structured: wrong-shape output retries then fails visibly", async () => {
	const rt = mockRt(() => ({ content: '{"n":"not an int"}' }));
	const s = await structured(rt, "x", { type: "object", properties: { n: { type: "integer" } }, required: ["n"] });
	assert.equal(s.ok, false);
	assert.equal(s.attempts, 3); // default retries=2 -> 3 attempts
	assert.match(s.error, /expected integer/);
});

test("structured: unsupported schema keyword rejects before spending", async () => {
	const rt = mockRt(() => ({ content: "{}" }));
	await assert.rejects(structured(rt, "x", { type: "object", patternProperties: {} }), /unsupported shape-schema keyword/);
});

test("verify: passing verdict; verifier failure is fail-closed (ok:false)", async () => {
	const pass = mockRt(() => ({ content: '{"passed":true,"score":0.9,"reasons":"good"}' }));
	const v = await verify(pass, "work", "rubric");
	assert.equal(v.ok, true);
	assert.equal(v.passed, true);
	assert.equal(v.score, 0.9);

	const down = mockRt(() => ({ ok: false, error: "verifier down" }));
	const v2 = await verify(down, "work", "rubric");
	assert.equal(v2.ok, false);
	assert.equal(v2.passed, false);
	assert.match(v2.error, /verifier down/);
});

test("consensus: majority pass; quorum failure when reviewers error", async () => {
	const rt = mockRt(() => ({ content: '{"passed":true}' }));
	const c = await consensus(rt, "w", "r", { reviewers: 3 });
	assert.equal(c.ok, true);
	assert.equal(c.passed, true);
	assert.equal(c.passedCount, 3);

	const broken = mockRt(() => ({ ok: false, error: "x" }));
	const c2 = await consensus(broken, "w", "r", { reviewers: 3 });
	assert.equal(c2.ok, false);
	assert.match(c2.error, /quorum/);
});

test("classify: valid category; invalid or failed classifier throws", async () => {
	assert.equal(await classify(mockRt(() => ({ content: '{"category":"bug"}' })), "t", ["bug", "feature"]), "bug");
	await assert.rejects(classify(mockRt(() => ({ content: '{"category":"other"}' })), "t", ["bug", "feature"]), /did not return exactly one valid/);
	await assert.rejects(classify(mockRt(() => ({ ok: false, error: "z" })), "t", ["a"]), /classifier agent failed/);
});

test("tournament: bracket winner; single candidate; judge failure throws", async () => {
	const rt = mockRt(() => ({ content: '{"winner":"A"}' })); // always the left candidate
	assert.equal(await tournament(rt, ["a", "b", "c", "d"], "quality"), "a");
	assert.equal(await tournament(mockRt(() => ({})), ["solo"]), "solo");
	await assert.rejects(tournament(mockRt(() => ({ ok: false, error: "j" })), ["a", "b"], "q"), /judge agent failed/);
});

test("generateAndFilter: dedupe, keep filter, and rubric filter", async () => {
	const dedup = mockRt((_p, _o, i) => ({ content: i < 2 ? "same" : "diff" }));
	assert.equal((await generateAndFilter(dedup, "g", { n: 3 })).length, 2);

	const kept = mockRt((_p, _o, i) => ({ content: "c" + i }));
	const out = await generateAndFilter(kept, "g", { n: 3, dedupe: false, keep: (r) => r.content === "c1" });
	assert.deepEqual(out.map((r) => r.content), ["c1"]);

	const gens = ["keep me", "drop me"];
	const rubric = mockRt((p, o, i) => (o.label === "verify" ? { content: `{"passed":${p.includes("keep me")}}` } : { content: gens[i] ?? "x" }));
	const filtered = await generateAndFilter(rubric, "g", { n: 2, rubric: "r" });
	assert.deepEqual(filtered.map((r) => r.content), ["keep me"]);
});

test("synthesize: single agent call merging labeled inputs", async () => {
	const rt = mockRt((p) => ({ content: "MERGED " + (p.includes("=== Input 1 ===") ? "y" : "n") }));
	const r = await synthesize(rt, ["a", "b"]);
	assert.equal(r.content, "MERGED y");
	assert.equal(rt.calls.length, 1);
});

test("asText: AgentResult -> content, otherwise String()", () => {
	assert.equal(asText({ content: "hi" }), "hi");
	assert.equal(asText(42), "42");
});
