import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { mapSnapshot } from "../map/model.mjs";
import { openDatabase } from "../work/database.mjs";
import { observe } from "../work/graph.mjs";
import { git } from "../work/product.mjs";
import { availableHistory, nextReview, reviews } from "../work/reviews.mjs";
import { scoutAgent, scoutDefinition, scoutPacket } from "../work/scouts.mjs";
import { factory, loadEntry, put } from "./fixture.mjs";

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

test("an oversized current goal diagnostic fits the scout budget without shortening its proof", t => {
	const f = fixture(t), receipt = f.run.effects[0].receipt; assert.ok(receipt);
	const output = "First failed action: open row\n" + "雪😀".repeat(22000) + "\nLast diagnostic: row missing\n";
	receipt.output = output;
	const { prompt, packet } = scoutPacket(f.cwd, f.run, f.review, 18000);
	assert.ok(Buffer.byteLength(prompt) <= 18000 && packet.partial && packet.files[f.charter]);
	assert.match(prompt, /goal-effect/); assert.match(prompt, /First failed action/); assert.match(prompt, /Last diagnostic/);
	assert.ok(!prompt.includes("\uFFFD") && !prompt.includes(output)); assert.equal(receipt.output, output);
});

test("delivery receipts name checked pins only when the packet shows the graph", t => {
	const { cwd, run, review, squad, charter } = fixture(t);
	run.policy.squads = [{ ...squad, researchAgent: "foundry-research" }];
	const goal = run.effects[0].receipt; assert.ok(goal);
	goal.output = "diagnostic\n".repeat(5000);
	review.state = "observed";
	review.packet = scoutPacket(cwd, run, review).packet;
	const previous = structuredClone(review.packet);
	review.observation = { outcome: "needs-research", reason: "Check this interface.", evidence: [charter], grains: [] };
	const research = { ...review, id: "investigation", state: /** @type {const} */ ("issued"), observation: undefined, packet: undefined,
		wake: { review: review.id, key: "research" } };
	run.effects.push(research);
	for (const budget of [Infinity, 16000]) {
		const scout = scoutPacket(cwd, run, review, budget), investigator = scoutPacket(cwd, run, research, budget);
		assert.match(scout.prompt, /"checked":"c{40}"/);
		assert.deepEqual(scout.packet.outputs, { types: "d".repeat(40), protocol: "c".repeat(40) });
		assert.doesNotMatch(investigator.prompt, /Current graph|"checked":"c{40}"/);
		assert.deepEqual(investigator.packet.outputs, {});
		assert.equal(investigator.packet.files[charter], previous.files[charter]);
		assert.equal(investigator.packet.partial, Number.isFinite(budget));
	}
	assert.deepEqual(review.packet, previous);
});

test("historical receipt, owner question and owned blocker are scoped pageable context, never file citations", t => {
	const f = fixture(t), { run, review, cwd, base } = f, goal = run.effects[0], budget = 16000;
	assert.ok(goal.kind === "goal" && goal.receipt);
	const old = "a".repeat(40), mid = "first unseen cause:", fill = "雪😃".repeat(20000);
	const output = `historical head ${fill}${mid} old${fill} historical tail`, question = `question head ${fill}${mid} question${fill}`;
	const receipt = "historical-goal", reason = `Writer reports missing input: ${fill}${mid} owned${fill}`;
	run.effects.unshift({ ...goal, id: receipt, commit: old, receipt: { ...goal.receipt, commit: old, output } });
	review.note = { receipt, question }; run.nodes.refused.reason = reason;
	const initial = scoutPacket(cwd, run, review, budget);
	assert.ok(Buffer.byteLength(initial.prompt) <= budget && initial.prompt.includes("historical head") && !initial.prompt.includes(mid));
	const graph = initial.prompt.split("\n").filter(l => l.startsWith('{"id":')).map(l => JSON.parse(l)).find(g => g.id === "refused");
	const details = initial.packet.sources?.filter(s => s.startsWith("detail:")).map(s => s.slice(7));
	const questionId = JSON.parse(initial.prompt.split("\n").find(l => l.startsWith(`{"receipt":"${receipt}"`)) ?? "{}").detail;
	assert.ok(details && details.includes(graph.detail) && details.includes(questionId));
	for (const [target, expected] of /** @type {const} */([[{ receipt }, "old"], [{ detail: questionId }, "question"], [{ detail: graph.detail }, "owned"]])) {
		review.state = "observed"; review.packet = initial.packet;
		review.observation = { outcome: "needs-evidence", ...target, match: mid, evidence: [f.charter], reason: "Locate the cause", grains: [] };
		const wake = nextReview(run, [review], base, review.version)?.wake; assert.ok(wake);
		const next = { ...review, id: `follow-${expected}`, note: undefined, state: /** @type {const} */ ("issued"), packet: undefined, observation: undefined, wake };
		run.effects.push(next);
		const response = scoutPacket(cwd, run, next, budget);
		assert.ok(response.prompt.includes(`${mid} ${expected}`) && Buffer.byteLength(response.prompt) <= budget);
		assert.ok(response.prompt.includes(old) && response.prompt.includes("not re-observed"));
		assert.ok(!Object.hasOwn(response.packet.files, receipt) && response.packet.excerpt?.path !== receipt);
		assert.throws(() => observe(cwd, run, { ...next, packet: response.packet }, { outcome: "unresolved", grains: [], reason: "unknown", evidence: [receipt] }), /outside this charter/);
		run.effects.pop();
		for (const change of [{ version: "stale-inputs" }, { base: old }, { squad: "another" }, { evaluatorRevision: old }]) {
			const foreign = { ...next, ...change }; run.effects.push(foreign);
			assert.throws(() => scoutPacket(cwd, run, foreign, budget), /charter|immutable|revision|tree|reference|context/i);
			run.effects.pop();
		}
	}
	assert.equal(run.nodes.refused.reason, reason); assert.equal(review.note.question, question);
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

test("a long direction and all areas reach the scout; an unavailable receipt still forbids no-gap", t => {
	const f = fixture(t);
	f.squad.areas.push(...Array.from({ length: 33 }, (_, i) => `src/not-yet-built-${i}`));
	f.run.policy.direction = "D".repeat(150_000);
	f.run.effects[0].commit = "e".repeat(40); // A receipt for a different revision is not evidence.
	const { prompt } = scoutPacket(f.cwd, f.run, f.review);
	assert.ok(prompt.includes(f.run.policy.direction));
	assert.ok(prompt.includes("src/not-yet-built-32"));
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
for (const source of ["receipt", "file"]) test(`scoped ${source} lookup continues at a later occurrence and pages from the hit`, async t => {
	const file = "encoder/catalog", match = "項😀".repeat(100), body = "x".repeat(32000) + match + "y".repeat(32000) + match + "z".repeat(32000);
	const f = factoryTrial(t, ["interface"], { [file]: body, "goal.mjs": `import {writeFileSync} from "node:fs";writeFileSync(1,${JSON.stringify(body)});process.exitCode=1` });
	const budget = 16000;
	await f.start(f.runtime(f.root, { scoutBudget: async () => budget }));
	const first = f.scouts[0], [goal] = (await f.owner.operation("status", { run: "pair", detail: "proof" }, "owner")).goalChecks ?? [];
	const target = source === "file" ? { file } : { receipt: goal.id };
	const indexed = filesIn(first.prompt).get(file); assert.ok(indexed.oid && indexed.preview, "budgeted blob preview");
	const request = { ...noGap, outcome: "needs-evidence", ...target, match };
	await first.report(request);
	const hit = f.scouts.at(-1); assert.ok(hit?.squad === first.squad && hit.id !== first.id, "first lookup");
	assert.equal(hit.packet.read?.hit, body.indexOf(match)); assert.ok(Buffer.byteLength(hit.prompt) <= budget);
	assert.ok(!hit.packet.files[goal.id] && (source === "file" || hit.packet.excerpt?.path !== goal.id));
	await hit.report({ ...request, offset: hit.packet.read.hit + 1 });
	const later = f.scouts.at(-1); assert.ok(later && later.id !== hit.id, String((await f.status()).reviews.at(-1)?.reason));
	assert.equal(later.packet.read?.hit, body.lastIndexOf(match));
	const offset = later.packet.read.end;
	await later.report({ ...request, match: undefined, offset });
	const more = f.scouts.at(-1); assert.ok(more && more.id !== later.id, `${(await f.status()).reviews.at(-1)?.reason}: ${JSON.stringify(later.packet.read)}`);
	assert.equal(more.packet.read?.start, offset); assert.ok(more.packet.read.end > offset);
	const count = f.scouts.length;
	await more.report({ ...request, match: undefined, offset });
	assert.equal(f.scouts.length, count, "do not replay a consumed range");
	assert.match(String((await f.status()).reviews.at(-1)?.reason), /repeat|progress|cursor|unchanged/i);
});

test("different literals returning the same range cannot sustain another read", async t => {
	const file = "encoder/catalog", body = "pre".repeat(12000) + "needle" + "post".repeat(12000);
	const f = factoryTrial(t, ["interface"], { [file]: body });
	await f.start(f.runtime(f.root, { scoutBudget: async () => 10000 }));
	const request = { ...noGap, outcome: "needs-evidence", file, match: "needle" };
	await f.scouts[0].report(request); const first = f.scouts.at(-1); assert.ok(first?.packet.read);
	await first.report({ ...request, match: "need" }); const again = f.scouts.at(-1); assert.ok(again?.packet.read);
	const count = f.scouts.length; await again.report({ ...request, match: "nee" });
	assert.equal(f.scouts.length, count);
	assert.match(String((await f.status()).reviews.at(-1)?.reason), /progress|must decide/);
});
for (const found of [true, false]) test(`literal lookup decides in one bounded follow-up: ${found ? "matching range" : "absent"}`, async t => {
	const file = "encoder/catalog", match = "operation.[publish]", budget = 18000;
	const contents = "unrelated row\n".repeat(45000) + (found ? `{"name":"${match}","state":"pending"}\n` : "end\n") + "other\n".repeat(3000);
	const f = factoryTrial(t, ["interface"], { [file]: contents, "display/catalog": "private foreign result" });
	await f.start(f.runtime(f.root, { scoutBudget: async () => budget }));
	const [first] = f.scouts, before = f.scouts.length;
	put(f.root, file, found ? "not in dirty checkout" : match);
	const request = { ...noGap, outcome: "needs-evidence", file, match };
	const outsider = f.scouts.find(j => j.squad === "display"); assert.ok(outsider);
	await outsider.report(request);
	assert.match(String((await f.status()).reviews.find(r => r.id === outsider.id)?.reason), /outside this charter/);
	await first.report(request);
	const next = f.scouts.at(-1);
	assert.ok(next?.squad === first.squad && f.scouts.length === before + 1, "one lookup, not sequential pages");
	assert.ok(next.packet.partial && !Object.hasOwn(next.packet.files, file) && Buffer.byteLength(next.prompt) <= budget);
	assert.ok(!next.prompt.includes("private foreign result"));
	const row = filesIn(next.prompt).get(file);
	assert.equal(row.oid, git(f.root, ["rev-parse", `${first.base}:${file}`]).toString().trim());
	if (found) {
		const range = next.packet.excerpt; assert.ok(range);
		assert.equal(row.excerpt, contents.slice(range.start, range.end)); assert.ok(row.excerpt.includes(`"${match}"`));
		await next.report({ ...noGap, outcome: "unresolved", evidence: [file] });
		assert.equal((await f.status()).reviews.find(r => r.id === next.id)?.state, "observed");
	} else {
		assert.match(row.omitted, /no literal match/i); assert.equal(next.packet.excerpt, undefined);
		await next.report(request);
		assert.match(String((await f.status()).reviews.find(r => r.id === next.id)?.reason), /must decide/);
	}
	assert.equal(f.scouts.length, before + 1);
});

for (const budget of [18000, 36000]) test(`session-sized evidence pages deliver the exact pinned inventory and no unseen evidence: ${budget}`, async t => {
	const file = "encoder/inventory.json", inventory = "quote:\" snow:雪 smile:😀\n".repeat(2800);
	const f = factoryTrial(t, ["interface"], { [file]: inventory, "encoder/other": "x".repeat(70000) });
	const owner = f.runtime(f.root, { scoutBudget: async () => budget });
	await f.start(owner); put(f.root, file, "dirty checkout");
	const first = f.scouts[0]; assert.equal(first.squad, "encoder");
	assert.ok(Buffer.byteLength(first.prompt) <= budget, "send only what this session can fit");
	assert.equal(first.packet.partial, true); assert.ok(!Object.hasOwn(first.packet.files, file)); assert.ok(first.prompt.includes(file));
	const request = { ...noGap, outcome: "needs-evidence", file };
	await first.report(request);
	let read = "", pages = 0;
	while (read !== inventory && pages++ < 40) {
		const job = f.scouts.at(-1); assert.ok(job && job.id !== first.id); assert.equal(job.squad, "encoder");
		assert.ok(Buffer.byteLength(job.prompt) <= budget);
		const row = filesIn(job.prompt).get(file); assert.equal(row.start, read.length);
		assert.ok(row.excerpt.length > 0); read += row.excerpt;
		assert.ok(inventory.startsWith(read)); assert.equal(row.end, read.length);
		assert.ok(job.packet.partial && !Object.hasOwn(job.packet.files, file));
		if (read === inventory) await job.report({ ...noGap, evidence: [file], outcome: "unresolved" });
		else await job.report({ ...request, evidence: [file] });
	}
	assert.equal(read, inventory); assert.ok(pages > 1);
	assert.equal((await f.status()).reviews.at(-1)?.state, "observed");
});

for (const limit of [24000, 400000]) test(`SDK session budget gates unseen citations and no-gap; a null scout retains its own native failure: ${limit}`, async t => {
	const inventory = "⚑".repeat(30000), file = "encoder/items";
	const f = factoryTrial(t, ["interface"], { [file]: inventory, "display/items": inventory });
	await f.start(); const [a, , c] = f.scouts;
	const why = "Request exceeds the model's prompt budget after reserving output.", wrong = "another agent failed";
	const agents = f.scouts.map(j => ({ runId: j.workflowId, label: `scout:${j.squad}:${j.id}@${j.base}`, toolCallId: `launch:${j.id}` }));
	const extension = await loadEntry({ sessionId: "owner", on() {}, workflow: { getRunDetail: async () => ({ runId: a.workflowId, workflowName: "foundry-scout", agents }) },
		rpc: { mode: { get: async () => "interactive" }, managedSettings: { get: async () => ({ failClosed: false }) },
			permissions: { getMode: async () => ({ mode: "assisted" }) },
			metadata: { getContextAttribution: async () => ({ contextAttribution: { promptTokenLimit: limit, categories: { systemPrompt: 500, customInstructions: 50, systemTools: 250, mcpTools: 0 } } }) },
			eventLog: { read: async () => ({ cursorStatus: "ok", hasMore: false, events: [[c.id, why], [a.id, wrong]].map(([id, error]) =>
				({ type: "subagent.failed", data: { toolCallId: `launch:${id}`, error } })) }) } } });
	const hook = { sessionId: "owner", timestamp: new Date(), workingDirectory: f.root };
	await extension.hooks?.onSessionStart?.({ ...hook, source: "startup" }, hook);
	t.after(() => extension.hooks?.onSessionEnd?.({ ...hook, reason: "complete" }, hook));
	const workflow = extension.workflows?.[0];
	assert.ok(workflow && "run" in workflow && typeof workflow.run === "function");
	const ctx = context(async (prompt, options) => {
		assert.ok(Buffer.byteLength(prompt) < limit);
		if (options?.label?.includes(a.id)) {
			assert.equal(prompt.includes(inventory), limit === 400000);
			return { ...noGap, outcome: "unresolved", evidence: [file] };
		}
		return options?.label?.includes(c.id) ? null : noGap;
	});
	await workflow.run({ ...ctx, session: /** @type {Context["session"]} */ ({ sessionId: "owner" }),
		runId: a.workflowId, args: { run: "pair", dispatch: a.dispatch } });
	f.owner.turn("owner"); await f.owner.flush();
	const s = await f.status();
	assert.ok(s.reviews[2].reason?.includes(why)); assert.ok(!s.reviews[2].reason?.includes(wrong));
	if (limit === 24000) {
		assert.match(String(s.reviews[0].reason), /not delivered/); assert.match(String(s.reviews[1].reason), /partial packet/);
	} else assert.deepEqual(s.reviews.slice(0, 2).map(r => r.state), ["observed", "observed"]);
});
/** @param {string} id @param {string[]} [needs] */
const build = (id, needs = []) => ({ ...noGap, outcome: "regenerate", grains: [{ id, directory: id, task: `Implement ${id} v2`, check: "unit.mjs", needs }] });

for (const saved of [false, true]) test(`switching between partial files resumes each pinned read: ${saved ? "previously stalled" : "live"}`, async t => {
	const a = "encoder/format", b = "encoder/examples", format = "A".repeat(24000) + "\nformat=v2";
	const check = `import {existsSync,readFileSync} from "node:fs";process.exit(existsSync("encoder/value") && readFileSync("encoder/value","utf8")==="v2" ? 0 : 1)`;
	const f = factoryTrial(t, ["interface"], { [a]: format, [b]: "B".repeat(24000), "product.mjs": check, "goal.mjs": check });
	const issuer = () => f.runtime(f.root, { scoutBudget: async () => 9000 }), owner = issuer();
	await f.start(owner);
	let [job, ...others] = f.scouts, cite = "charter";
	for (const other of others) await other.report({ ...noGap, outcome: "unresolved" });
	/** @type {Map<string,string>} */ const received = new Map();
	/** @param {string} file @param {boolean} [restore] */
	async function page(file, restore) {
		const before = f.scouts.length;
		const request = { ...noGap, outcome: /** @type {const} */ ("needs-evidence"), evidence: [cite], file };
		if (restore) {
			owner.close();
			const db = openDatabase(f.root);
			try {
				db.mutateLocked("pair", run => {
					const r = reviews(run).find(r => r.id === job.id); assert.ok(r?.workflowId && run.goal);
					r.state = "blocked"; r.packet = job.packet; r.observation = request;
					r.error = `No further focused read of ${file}: the pinned evidence is unchanged`;
					run.goal.stall = "No actionable grain remains on this revision.";
				});
			} finally { db.close(); }
			const reloaded = issuer();
			reloaded.turn("owner"); await reloaded.flush(); await f.settle();
		} else await job.report(request);
		const next = f.scouts.at(-1);
		assert.ok(next && next.id !== job.id, `Missing next page of ${file}`);
		assert.equal(f.scouts.length, before + 1, "one continuation, no replay of the earlier review");
		const part = next.packet.excerpt, prior = received.get(file) ?? "";
		assert.equal(part?.path, file); assert.equal(part.start, prior.length);
		const text = prior + filesIn(next.prompt).get(file).excerpt;
		assert.ok(text.length > prior.length); assert.equal(part.end, text.length);
		received.set(file, text);
		job = next; cite = file;
	}
	await page(a); await page(b); await page(a, saved); await page(b);
	do { await page(a); } while ((received.get(a)?.length ?? 0) < format.length);
	assert.equal(received.get(a), format);
	await job.report({ ...build("encoder"), evidence: [a] });
	const [writer] = f.workers.values();
	put(writer.cwd, "encoder/value", "v2");
	await f.runtime(writer.cwd).operation("submit", { run: "pair", token: writer.token }, writer.id);
	assert.ok((await f.status()).qualified);
});

for (const decides of [true, false]) test(`a redundant read gets one decision from earlier delivered text; proposes work: ${decides}`, async t => {
	const a = "encoder/format", b = "encoder/consumer", extra = "encoder/appendix";
	const f = factoryTrial(t, ["interface"], { [a]: "A".repeat(12000), [b]: "B".repeat(13000), [extra]: "C".repeat(8000) });
	const budget = 22000, owner = f.runtime(f.root, { scoutBudget: async () => budget });
	await f.start(owner);
	const request = (/** @type {string} */ file) => ({ ...noGap, outcome: "needs-evidence", file });
	const [first] = f.scouts;
	assert.ok(!first.packet.files[a]); await first.report(request(a));
	const readA = f.scouts[3]; assert.ok(readA.packet.files[a]); await readA.report(request(b));
	const readB = f.scouts[4]; assert.ok(readB.packet.files[b]); assert.ok(!readB.packet.files[a]);
	await readB.report(request(a));
	assert.match(String((await f.status()).reviews[4].reason), /No further focused read/);
	const decision = f.scouts[5]; assert.ok(decision, "same checkpoint needs a decision, not a terminal duplicate-read stall");
	assert.equal(decision.squad, first.squad); assert.equal(decision.base, first.base);
	assert.ok(Buffer.byteLength(decision.prompt) <= budget);
	assert.equal(decision.packet.files[a], readA.packet.files[a]); assert.match(decision.prompt, /already delivered/i);
	assert.equal(f.workers.size, 0);
	await decision.report(decides ? { ...build("encoder"), evidence: [a] } : request(extra));
	owner.turn("owner"); await owner.flush(); await f.settle();
	assert.equal(f.workers.size, decides ? 1 : 0);
	assert.equal((await f.status()).reviews[5].state, decides ? "observed" : "blocked");
	assert.equal(f.scouts.length, 6, "no second decision, file request, or sibling retry");
});

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

test("all declared files and full charter text reach every scout", async t => {
	const charter = "charter detail\n".repeat(20000) + "Required ending";
	const boundary = Array.from({ length: 45 }, (_, i) => `doc-${i}`), f = factoryTrial(t, boundary, { charter });
	await f.start();
	for (const s of f.scouts) {
		assert.equal(s.packet.partial, false); assert.equal(filesIn(s.prompt).get("charter")?.text === charter, true);
		assert.ok(boundary.every(p => s.packet.files[p])); await s.report({ ...noGap, evidence: ["doc-44"] });
	}
	assert.ok((await f.status()).reviews.every(r => r.state === "observed"));
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
