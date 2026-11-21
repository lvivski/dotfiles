import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { git } from "../work/product.mjs";
import { scoutAgent, scoutDefinition, scoutPrompt } from "../work/scouts.mjs";
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
	const f = fixture(t), prompt = scoutPrompt(f.cwd, f.run, f.review), files = filesIn(prompt);
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
	assert.throws(() => scoutPrompt(f.cwd, f.run, { ...f.review, base: "HEAD" }), /immutable/);
	assert.throws(() => scoutPrompt(f.cwd, f.run, { ...f.review, base: "0".repeat(40) }), "must not fall back to HEAD");
});

test("fixed charter includes owned idle grains and their declared inputs but not unrelated idle work", t => {
	const f = fixture(t), { policy, nodes } = f.run;
	delete policy.goalCheck; delete f.run.goal;
	policy.squads = [{ id: f.squad.id, charter: f.charter, grains: ["types"] }];
	nodes.types.state = nodes.consumer.state = "idle";
	nodes.consumer.grain.specification = f.productCheck;
	nodes.unrelated = { ...nodes.consumer, grain: { ...nodes.consumer.grain, id: "unrelated", task: "private-unchartered-idle" } };
	const prompt = scoutPrompt(f.cwd, f.run, f.review), files = filesIn(prompt);
	assert.match(prompt, /fixed charter[\s\S]*only owned grain IDs/);
	assert.match(prompt, /"ownedGrains":\["types"\]/);
	assert.match(prompt, /"id":"consumer"/);
	assert.doesNotMatch(prompt, /private-unchartered-idle|Companion check did not run/);
	for (const path of [f.charter, f.boundary, f.check, f.productCheck, f.productFile, f.directFile, f.transitiveFile, f.inputSpec]) assert.ok(files.has(path), path);
	assert.ok(![...files.keys()].some(p => p.startsWith(`${f.sibling}/`)));
});

test("unavailable or truncated evidence never warrants an exhaustive no-gap", t => {
	const f = fixture(t);
	f.squad.areas.push(...Array.from({ length: 33 }, (_, i) => `src/not-yet-built-${i}`));
	f.run.policy.direction = "D".repeat(150_000);
	f.run.effects[0].commit = "e".repeat(40); // A receipt for a different revision is not evidence.
	const prompt = scoutPrompt(f.cwd, f.run, f.review);
	assert.ok(prompt.length < 64 * 1024);
	assert.match(prompt, /\[truncated:/);
	assert.match(prompt, /directory roots omitted/);
	assert.match(prompt, /no verified goal receipt/);
	assert.match(prompt, /Coverage: PARTIAL[\s\S]*Do not return no-gap/);
	assert.doesNotMatch(prompt, /Companion check did not run/);
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
const item = id => ({ id: `review-${id}`, squad: id, base: "a".repeat(40), prompt: `packet-${id}` });

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
		async scoutBatch() { attempts++; return deliveries > 1 ? [] : [{ ...review, prompt: `graph at attempt ${attempts}` }]; },
		async scoutResult() { if (++deliveries === 1) throw new Error("interrupted persistence"); },
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
