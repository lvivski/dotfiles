import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { mapSnapshot } from "../map/model.mjs";
import { git } from "../work/product.mjs";
import { availableHistory, nextReview } from "../work/reviews.mjs";
import { scoutAgent, scoutDefinition, scoutPacket } from "../work/scouts.mjs";
import { factory, put } from "./fixture.mjs";

/** @param {import("node:test").TestContext} t */
function fixture(t) {
	const source = ".foundry/product.json", charter = ".foundry/charter", boundary = ".foundry/interface";
	const check = ".foundry/unit.mjs", goalCheck = ".foundry/goal.mjs", productCheck = ".foundry/product.mjs", inputSpec = ".foundry/protocol";
	const directory = "src/types", refused = "src/unbuilt", sibling = "src/neighbor", productFile = `${directory}/check.mjs`;
	const direct = "src/consumer", transitive = "src/protocol", directFile = `${direct}/index.ts`, transitiveFile = `${transitive}/schema.ts`;
	const files = [source, charter, boundary, check, goalCheck, productCheck, inputSpec, productFile, directFile, transitiveFile, `${sibling}/private`];
	const repo = factory(t, "product", source, Object.fromEntries(files.map(f => [f, `committed content of ${f}\n`])));
	const base = repo.tip, cwd = git(repo.root, ["rev-parse", "--absolute-git-dir"]).toString().trim();
	put(repo.root, productFile, "private-uncommitted-content"); put(repo.root, `${directory}/draft`, "private-untracked-content");
	const squad = { id: "types", charter, checks: [check], boundary: [boundary], areas: [directory, refused], agent: "not-the-scout-profile" };
	/** @type {import("../work/model.js").Review} */
	const review = { id: "durable-review", base, squad: squad.id, version: base, state: "issued", kind: "scout", tool: "workflow", args: {}, issuer: "private-owner" };
	/** @type {import("../work/model.js").Run} */
	const run = { id: "product", owner: "private-owner", active: true, activatedAt: 1, products: [],
		policy: { id: "product", source, direction: "Check each companion.", target: "refs/heads/main", base,
			productCheck, goalCheck, files: [source, charter, boundary, check, productCheck, goalCheck], squads: [squad], repairs: 1 },
		nodes: {
			types: { grain: { id: "types", directory, specification: charter, check, boundary: [boundary], needs: ["consumer"],
				task: "Check signatures." }, repairs: 0, state: "repeated", candidate: "d".repeat(40) },
			consumer: { grain: { id: "consumer", directory: direct, specification: charter, check, boundary: [boundary],
				needs: ["protocol"], task: "Exercise the consumer." }, state: "writing", repairs: 0, worker: "private-worker", token: "private-token" },
			protocol: { grain: { id: "protocol", directory: transitive, specification: inputSpec, check, boundary: [boundary], needs: [] },
				state: "published", candidate: "c".repeat(40), repairs: 0 },
			refused: { grain: { id: "refused", directory: refused, specification: charter, check, boundary: [boundary], needs: ["neighbor"] },
				state: "blocked", repairs: 0, generation: base, reason: "Native permission refused for the packaging assignment." },
			neighbor: { grain: { id: "neighbor", directory: sibling, specification: charter, check, boundary: [boundary], needs: [] },
				state: "blocked", repairs: 0, reason: "private-foreign-diagnostic" },
		},
		goal: { target: base, commit: base, check: "goal-effect" },
		effects: [{ id: "goal-effect", kind: "goal", issuer: "private-owner", state: "done", tool: "bash", runnerStarted: true,
			commit: base, check: goalCheck, args: { command: "private-call-args" },
			receipt: { commit: base, check: goalCheck, exit: 1, output: "Companion check did not run." } }, review],
	};
	return { cwd, base, run, review, squad, source, charter, boundary, check, productCheck, goalCheck, productFile, sibling,
		directFile, transitiveFile, inputSpec };
}

/** @param {string} prompt */
function filesIn(prompt) {
	return new Map(prompt.split("\n").filter(s => s.startsWith('{"path":')).map(s => {
		const row = JSON.parse(s);
		return [row.path, row];
	}));
}

test("area scout receives pinned Git blobs, its exact goal receipt and safe cross-charter edges, not the checkout", t => {
	const f = fixture(t), { prompt, packet } = scoutPacket(f.cwd, f.run, f.review), files = filesIn(prompt);
	assert.deepEqual(packet.files, Object.fromEntries([...files].filter(([, row]) => "text" in row).map(([path, row]) => [path, row.oid])));
	for (const path of [f.source, f.charter, f.boundary, f.check, f.productCheck, f.goalCheck, f.productFile, f.directFile, f.transitiveFile, f.inputSpec]) {
		const expected = git(f.cwd, ["cat-file", "blob", `${f.base}:${path}`]).toString();
		const row = files.get(path);
		assert.ok(row, `missing ${path}`);
		assert.equal(row.oid, git(f.cwd, ["rev-parse", `${f.base}:${path}`]).toString().trim());
		assert.ok(row.text.startsWith(expected.slice(0, 256)), `no pinned content for ${path}`);
	}
	assert.ok(![...files.keys()].some(p => p.startsWith(`${f.sibling}/`)), "blocked assignments cannot grant historical input scope");
	assert.match(prompt, /Companion check did not run/);
	assert.match(prompt, /"needs":\["consumer"\]/);
	assert.match(prompt, /"state":"repeated","checked":"d{40}"/);
	assert.match(prompt, /combined tree already failed the goal/);
	assert.match(prompt, /Native permission refused for the packaging assignment/);
	assert.match(prompt, /Exercise the consumer/);
	assert.doesNotMatch(prompt, /private-(?:call-args|owner|worker|token|foreign-diagnostic|uncommitted-content|untracked-content)|not-the-scout-profile/);
	assert.throws(() => scoutPacket(f.cwd, f.run, { ...f.review, base: "HEAD" }), /immutable/);
	assert.throws(() => scoutPacket(f.cwd, f.run, { ...f.review, base: "0".repeat(40) }), "must not fall back to HEAD");
});

test("fixed charter includes owned idle grains and their declared inputs but not unrelated idle work", t => {
	const f = fixture(t), { policy, nodes } = f.run;
	delete policy.goalCheck; delete f.run.goal;
	policy.squads = [{ id: f.squad.id, charter: f.charter, grains: ["types"] }];
	nodes.types.state = nodes.consumer.state = "idle";
	nodes.consumer.grain.specification = f.productCheck;
	nodes.unrelated = { ...nodes.consumer, grain: { ...nodes.consumer.grain, id: "unrelated", task: "private-unchartered-idle" } };
	const { prompt } = scoutPacket(f.cwd, f.run, f.review), files = filesIn(prompt);
	assert.match(prompt, /fixed charter[\s\S]*only owned grain IDs/);
	assert.match(prompt, /"ownedGrains":\["types"\]/);
	assert.match(prompt, /"id":"consumer"/);
	assert.doesNotMatch(prompt, /private-unchartered-idle|Companion check did not run/);
	for (const path of [f.charter, f.boundary, f.check, f.productCheck, f.productFile, f.directFile, f.transitiveFile, f.inputSpec]) assert.ok(files.has(path), path);
	assert.ok(![...files.keys()].some(p => p.startsWith(`${f.sibling}/`)));
});

test("a wait on an already visible producer version needs new evidence before another assignment", t => {
	const { cwd, run, review, squad } = fixture(t);
	run.policy.squads.push({ ...squad, id: "library", areas: ["src/protocol"] });
	const history = () => availableHistory(run, [review], squad.id);
	assert.equal(history(), undefined, "the issued review owns this revision");
	review.state = "observed";
	review.observation = { outcome: "waiting", waitFor: "library", reason: "Need a revised protocol.", evidence: [squad.charter], grains: [] };
	review.packet = scoutPacket(cwd, run, review).packet;
	const next = () => { const past = history(); assert.ok(past); return nextReview(run, past, review.base, review.version); };
	assert.equal(next(), undefined);
	run.nodes.protocol.candidate = "f".repeat(40);
	assert.equal(next()?.wake?.review, review.id);
});

test("unavailable or truncated evidence never warrants an exhaustive no-gap", t => {
	const f = fixture(t);
	f.squad.areas.push(...Array.from({ length: 33 }, (_, i) => `src/not-yet-built-${i}`));
	f.run.policy.direction = "D".repeat(150_000);
	f.run.effects[0].commit = "e".repeat(40); // A receipt for a different revision is not evidence.
	const { prompt } = scoutPacket(f.cwd, f.run, f.review);
	assert.ok(prompt.length < 64 * 1024);
	assert.match(prompt, /\[truncated:/);
	assert.match(prompt, /directory roots omitted/);
	assert.match(prompt, /no verified goal receipt/);
	assert.match(prompt, /Coverage: PARTIAL[\s\S]*Do not return no-gap/);
	assert.doesNotMatch(prompt, /Companion check did not run/);
});

/** @param {import("node:test").TestContext} t @param {string[]} [boundary] @param {Record<string,string>} [extra] */
function factoryTrial(t, boundary = ["interface"], extra = {}) {
	const source = ".foundry/pair.json", ids = ["encoder", "display", "unrelated"];
	const both = `import {existsSync,readFileSync} from 'node:fs';process.exit(['encoder','display'].every(p=>existsSync(p+'/value')&&readFileSync(p+'/value','utf8')==='v2')?0:1)`;
	return factory(t, "pair", source, {
		[source]: JSON.stringify({ version: 2, id: "pair", direction: "Display the encoded v2 value.", target: "refs/heads/main",
			squads: ids.map(id => ({ id, charter: "charter", areas: [id], boundary, checks: ["unit.mjs"] })), goalCheck: "goal.mjs", productCheck: "product.mjs" }),
		charter: "Replace one complete directory to implement the shared v2 format.", ...Object.fromEntries(boundary.map(p => [p, p])),
		"goal.mjs": both, "product.mjs": both, "unit.mjs": `import {readFileSync} from 'node:fs';process.exit(readFileSync(process.env.FOUNDRY_DIRECTORY+'/value','utf8')==='v2'?0:1)`, ...extra,
	});
}
const noGap = { outcome: "no-gap", grains: [], evidence: ["charter"], reason: "Nothing owned needs a change." };
/** @param {string} id @param {string[]} [needs] */
const build = (id, needs = []) => ({ ...noGap, outcome: "regenerate", grains: [{ id, directory: id, task: `Implement ${id} v2`, check: "unit.mjs", needs }] });

for (const again of [false, true]) test(`waiting for a producer wakes only the interested charter, still waiting: ${again}`, async t => {
	const f = factoryTrial(t); await f.start();
	const [encoder, display, other] = f.scouts;
	const wait = { ...noGap, outcome: "waiting", waitFor: "encoder", reason: "Display must consume the checked v2 encoder." };
	await display.report(wait); await other.report(noGap);
	assert.deepEqual(mapSnapshot(await f.status()).scoutIssues, ["display waits for encoder: " + wait.reason]);
	await encoder.report(build("encoder"));
	const w = [...f.workers.values()][0]; put(w.cwd, "encoder/value", "v2");
	await f.runtime(w.cwd).operation("submit", { run: "pair", token: w.token }, w.id); await f.settle();
	const half = await f.status();
	assert.equal(half.qualified, null); assert.equal(half.candidate?.receipt?.exit, 1);
	assert.deepEqual(f.scouts.slice(3).map(j => j.squad), ["display"]);
	f.owner.turn("owner"); await f.owner.flush(); await f.settle(); assert.equal(f.scouts.length, 4);
	assert.match(f.scouts[3].prompt, /Checked outputs changed for encoder/);
	if (again) {
		await f.scouts[3].report(wait); f.owner.turn("owner"); await f.owner.flush(); await f.settle();
		assert.equal(f.scouts.length, 4); assert.equal(f.workers.size, 1); assert.equal((await f.status()).qualified, null);
		return;
	}
	await f.scouts[3].report(build("display", ["encoder"]));
	const d = [...f.workers.values()][1]; put(d.cwd, "display/value", "v2");
	await f.runtime(d.cwd).operation("submit", { run: "pair", token: d.token }, d.id);
	const done = await f.status(); assert.ok(done.qualified);
	assert.equal(done.products?.at(-1)?.receipt?.commit, done.qualified); assert.equal(done.goal?.receipt?.commit, done.qualified);
	assert.equal(f.workers.size, 2); assert.equal(f.scouts.length, 4);
});

test("partial packets reject unseen citations and exhaustive no-gap but may obtain a bounded focused read", async t => {
	const boundary = Array.from({ length: 45 }, (_, i) => `doc-${i}`), f = factoryTrial(t, boundary);
	await f.start(); const [first, second, third] = f.scouts;
	assert.equal(first.packet.partial, true); assert.ok(!Object.hasOwn(first.packet.files, "doc-44"));
	await first.report({ ...noGap, evidence: ["doc-44"] });
	await second.report(noGap);
	await third.report({ ...noGap, outcome: "needs-evidence", file: "doc-44" });
	const s = await f.status();
	assert.match(String(s.reviews[0].reason), /doc-44.*not delivered/);
	assert.match(String(s.reviews[1].reason), /partial packet/);
	const focused = f.scouts[3]; assert.equal(focused.squad, third.squad);
	assert.match(focused.prompt, /Requested evidence/); assert.match(focused.packet.files["doc-44"], /^[a-f0-9]+$/);
	await focused.report({ ...build("unrelated"), evidence: ["doc-44"] });
	assert.equal(f.workers.size, 1);
});

test("binary metadata is not delivered text, and a focused read cannot cross a charter boundary or loop", async t => {
	const f = factoryTrial(t, ["binary"], { binary: "a\0b", "display/private": "private display evidence" });
	await f.start(); const [a, b, c] = f.scouts;
	assert.match(a.prompt, /binary or non-UTF-8/); assert.ok(!Object.hasOwn(a.packet.files, "binary"));
	await a.report({ ...noGap, evidence: ["binary"] });
	await b.report({ ...noGap, outcome: "needs-evidence", file: "binary" });
	await c.report({ ...noGap, outcome: "needs-evidence", file: "display/private" });
	const focus = f.scouts[3]; assert.equal(focus.squad, b.squad);
	await focus.report({ ...noGap, outcome: "needs-evidence", file: "binary" });
	const { reviews } = await f.status();
	assert.match(String(reviews[0].reason), /not delivered/);
	assert.match(String(reviews[2].reason), /outside this charter/);
	assert.match(String(reviews[3].reason), /No further focused read/);
	assert.equal(f.scouts.length, 4); assert.equal(f.workers.size, 0);
});

/** @typedef {Parameters<ReturnType<typeof scoutDefinition>["run"]>[0]} Context */
/** @typedef {ReturnType<Parameters<typeof scoutDefinition>[0]>} Runtime */
/** @param {Context["agent"]} agent @param {AbortSignal} [signal] @returns {Context} */
function context(agent, signal = new AbortController().signal) {
	return { args: { run: "product", dispatch: "ticket" }, session: /** @type {Context["session"]} */ ({ sessionId: "issuer" }),
		runId: "workflow-id", signal, agent, phase() {}, log() {}, step: async (_key, produce) => produce(),
		parallel: thunks => Promise.all(thunks.map(async fn => {
			try { return await fn(); } catch (e) { if (e instanceof Error && e.name === "AbortError") throw e; return null; }
		})), pause: () => assert.fail("unexpected pause"), pipeline: () => assert.fail("unexpected pipeline"), workflow: () => assert.fail("nested workflow"),
	};
}

/** @param {string} id */
const item = id => ({ id: `review-${id}`, squad: id, base: "a".repeat(40), prompt: `packet-${id}`, packet: { review: `review-${id}`, base: "a".repeat(40), partial: false, files: {}, outputs: {} } });

test("SDK tool-less scouts deliver fast, null and failed results before a slow sibling", async () => {
	const batch = ["slow", "fast", "empty", "broken"].map(item), calls = new Map(), reports = new Map();
	const observation = { outcome: "no-gap", reason: "Contract met.", evidence: ["charter.md"], grains: [] };
	/** @type {() => void} */ let finish = () => assert.fail("slow scout never started");
	/** @type {Promise<void>} */ const slow = new Promise(resolve => { finish = resolve; });
	/** @type {Runtime} */
	const runtime = {
		async scoutBatch(...identity) { assert.deepEqual(identity, ["product", "ticket", "issuer", "workflow-id"]); return batch; },
		async scoutResult(run, ticket, actor, workflow, id, raw) {
			assert.deepEqual([run, ticket, actor, workflow], ["product", "ticket", "issuer", "workflow-id"]);
			assert.ok(!reports.has(id)); reports.set(id, raw);
		},
	};
	const ctx = context(async (prompt, options) => {
		assert.ok(options); assert.ok(!calls.has(prompt)); calls.set(prompt, options);
		if (prompt === "packet-slow") await slow;
		if (prompt === "packet-empty") return null;
		if (prompt === "packet-broken") throw new Error("soft item failure");
		return observation;
	});
	const definition = scoutDefinition(() => runtime), done = definition.run(ctx);
	try {
		await setImmediate();
		assert.deepEqual(reports, new Map([["review-fast", observation], ["review-empty", null], ["review-broken", null]]));
	} finally { finish(); }
	assert.deepEqual(await done, { reported: 2, failed: ["review-empty", "review-broken"] });
	assert.deepEqual(reports.get("review-slow"), observation);
	assert.equal(calls.size, batch.length);
	assert.deepEqual(scoutAgent.tools, []); // null or omitted means ALL tools in the installed SDK
	assert.notEqual(scoutAgent.infer, false);
	for (const { id, base, prompt } of batch) {
		const options = calls.get(prompt); assert.ok(options);
		assert.deepEqual(Object.keys(options).sort(), ["agent", "label", "schema"]);
		assert.equal(options.agent, scoutAgent.name);
		assert.ok(options.label.includes(id) && options.label.includes(base));
		assert.deepEqual(options.schema.required, ["outcome", "reason", "evidence", "grains"]);
		assert.deepEqual(options.schema.properties.grains.items.anyOf.map((/** @type {{type:string}} */ branch) => branch.type), ["string", "object"]);
		assert.deepEqual(options.schema.properties.replace.items, { type: "string" });
	}
	assert.equal(definition.meta.name, "foundry-scout");
	assert.deepEqual(definition.meta.argsSchema?.required, ["run", "dispatch"]);
});

test("reject forged workflow arguments before binding; cancelled agents never manufacture reports", async () => {
	let reads = 0, writes = 0;
	const definition = scoutDefinition(() => ({ async scoutBatch() { reads++; return [item("only")]; }, async scoutResult() { writes++; } }));
	const bad = context(assert.fail);
	for (const args of [{}, { run: "product", dispatch: 3 }, { run: "../other", dispatch: "ticket" }, { run: "product", dispatch: " " },
		{ run: "product", dispatch: "ticket", actor: "forged" }, { run: "product", dispatch: "ticket", agent: "write" }]) {
		await assert.rejects(definition.run({ ...bad, args: /** @type {Context["args"]} */ (args) }));
	}
	assert.equal(reads, 0);
	const stop = new AbortController();
	await assert.rejects(definition.run(context(async () => { throw new DOMException("hard stop", "AbortError"); })), /hard stop/);
	await assert.rejects(definition.run(context(async () => { stop.abort(); return null; }, stop.signal)), { name: "AbortError" });
	assert.equal(reads, 2); assert.equal(writes, 0);
});

test("resume reauthorizes the charter but does not change a journaled agent's packet or label", async () => {
	const review = item("resumed"), packets = new Map();
	/** @type {[string, string|undefined][]} */ const calls = [];
	let attempts = 0, deliveries = 0;
	const definition = scoutDefinition(() => ({
		async scoutBatch() { attempts++; return deliveries > 1 ? [] : [{ ...review, prompt: `graph at attempt ${attempts}`, packet: { ...review.packet, partial: attempts === 1 } }]; },
		async scoutResult(_run, _ticket, _actor, _workflow, _id, _raw, pinned) {
			assert.deepEqual(pinned, { ...review.packet, partial: true });
			if (++deliveries === 1) throw new Error("interrupted persistence");
		},
	}));
	const ctx = context(async (prompt, options) => {
		calls.push([prompt, options?.label]);
		return { outcome: "needs-decision", reason: "Which contract applies?", evidence: ["charter.md"], grains: [] };
	});
	ctx.step = async (key, produce) => {
		if (!packets.has(key)) packets.set(key, await produce());
		return packets.get(key);
	};
	await assert.rejects(definition.run(ctx), /interrupted persistence/);
	assert.deepEqual(await definition.run(ctx), { reported: 1, failed: [] });
	assert.deepEqual(await definition.run(ctx), { reported: 0, failed: [] });
	assert.equal(attempts, 3);
	assert.equal(calls.length, 2);
	assert.equal(calls[0][0], "graph at attempt 1");
	assert.deepEqual(calls[1], calls[0]);
});
