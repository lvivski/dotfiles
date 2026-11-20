import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDatabase, ledgerPath, protocol } from "./database.mjs";
import { readPolicy } from "./contract.mjs";
import { assignment } from "./native.mjs";
import { withProduct } from "./product.mjs";
import { recover } from "./recovery.mjs";
import { createRuntime } from "./runtime.mjs";
import { digest, record, text } from "./values.mjs";

/** @typedef {Parameters<typeof createRuntime>[1]} Host */
/** @typedef {import("./model.js").Effect} Effect */
/** @param {string} cwd @param {...string} args */
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=test@invalid", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** @param {string} dir @param {string} p @param {string} bytes */
function put(dir, p, bytes) { mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); writeFileSync(path.join(dir, p), bytes); }

const grainIds = ["left", "right"];
const source = ".foundry/policy.json", run = "sum";
const policy = () => ({
	version: 1, id: run, direction: "Make the joined exports sum to three", target: "refs/heads/main", productCheck: ".foundry/product.mjs",
	grains: grainIds.map(id => ({ id, directory: `lib/${id}`, specification: `.foundry/${id}.md`, boundary: [".foundry/api.md"], check: `.foundry/${id}.mjs`, needs: /** @type {string[]} */ ([]) })),
	limits: /** @type {{workers?:number,repairs?:number,deadline?:string}|undefined} */ (undefined), seed: /** @type {string[]|undefined} */ ([...grainIds]),
	squads: grainIds.map(id => ({ id, charter: `.foundry/${id}.md`, grains: [id], agent: `${id}-specialist` }))
});

/** @typedef {ReturnType<typeof policy>} FixturePolicy */
/** @param {import("node:test").TestContext} t @param {(p:FixturePolicy)=>void} [configure]
 * @param {Record<string,string>} [files] */
function fixture(t, configure, files = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "foundry-graph-")), root = path.join(dir, "repo");
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(root);
	git(root, "init", "-q", "-b", "main");
	const p = policy();
	configure?.(p);
	put(root, source, JSON.stringify(p));
	put(root, ".foundry/api.md", "Default-export an integer.");
	put(root, "neighbor.txt", "not owned\n");
	for (const [i, id] of grainIds.entries()) {
		put(root, `lib/${id}/old.mjs`, "export default 0;\n");
		put(root, `.foundry/${id}.md`, `Implement ${id} with value ${i + 1}.`);
		put(root, `.foundry/${id}.mjs`, `import n from "../lib/${id}/index.mjs"; if(n!==${i + 1}) throw Error("wrong ${id}");`);
	}
	put(root, p.productCheck, 'import a from "../lib/left/index.mjs";import b from "../lib/right/index.mjs";if(a+b!==3)throw Error("bad join");');
	for (const [name, bytes] of Object.entries(files))
		put(root, name, bytes);
	git(root, "add", ".");
	git(root, "commit", "-qm", "fixture");
	const tip = git(root, "rev-parse", "HEAD");
	/** @type {Map<string,{id:string,token:string,cwd:string,prompt:string}>} */ const workers = new Map();
	/** @type {string[]} */ const checks = [];
	/** @type {Host["execute"]} */
	const execute = async (tool, args) => {
		if (tool === "bash") {
			checks.push(String(args.description));
			const result = spawnSync("/bin/sh", ["-c", text(args.command, "runner")], { cwd: root, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			return { resultType: "success", textResultForLlm: result.stdout };
		}
		if (tool === "send_session_message")
			return { resultType: "success", structuredContent: { status: "accepted" } };
		assert.equal(tool, "create_session");
		const prompt = text(record(args.kickoff).prompt, "kickoff"), marker = assignment(prompt);
		assert.ok(marker);
		const id = `worker-${workers.size + 1}`, cwd = path.join(dir, id);
		git(root, "worktree", "add", "-q", "--detach", cwd, text(args.base_branch, "generation"));
		workers.set(id, { id, token: marker.token, cwd, prompt });
		return { resultType: "success", structuredContent: { project_session_id: id, path: cwd } };
	};
	/** @param {string} cwd @param {Partial<Host>} [options] */
	function runtime(cwd, options) { const r = createRuntime(cwd, { mode: async () => "interactive", confirm: async () => true, select: async () => null, execute, ...options }); t.after(() => r.close()); return r; }
	const owner = runtime(root);
	/** @param {string} [actor] */
	const status = (actor = "owner") => owner.operation("status", { run }, actor);
	/** @param {string} id @param {number} [value] */
	async function submit(id, value, /** @type {Partial<Host>} */ options = {}) {
		const w = workers.get(id);
		assert.ok(w);
		const wRuntime = runtime(w.cwd, options), s = await wRuntime.operation("status", { run }, id);
		const node = s.nodes.find(n => n.worker === id && n.state === "writing");
		assert.ok(node);
		put(w.cwd, `lib/${node.grain}/index.mjs`, `export default ${value ?? grainIds.indexOf(node.grain) + 1};\n`);
		return wRuntime.operation("submit", { run, token: node.token }, id);
	}
	/** @param {string} worker @param {string} grain @param {string[]} [grains] */
	async function observe(worker, grain, grains = [grain]) {
		const w = workers.get(worker);
		assert.ok(w);
		return runtime(w.cwd).operation("observe", { run, token: w.token, outcome: grains.length ? "regenerate" : "no-gap", reason: `Review ${grain}`, evidence: [`.foundry/${grain}.md`], grains }, w.id);
	}
	return { root, tip, p, owner, workers, checks, execute, runtime, submit, status, observe, start: () => owner.operation("start", { source }, "owner") };
}

for (const slots of [1, 2])
	test(`whole-tree replacement, ${slots} slot(s), no qualification worker`, async (t) => {
		const f = fixture(t, p => { p.limits = { workers: slots }; });
		f.owner.turn("ordinary");
		await f.owner.flush();
		assert.equal(existsSync(ledgerPath(f.root)), false);
		await f.start();
		assert.equal(f.workers.size, slots);
		const first = f.workers.get("worker-1");
		assert.ok(first);
		assert.equal(existsSync(path.join(first.cwd, "lib/left")), false);
		assert.equal(git(first.cwd, "rev-list", "--count", "HEAD"), "1");
		put(first.cwd, "neighbor.txt", "ignore this change\n");
		await f.submit("worker-1");
		await f.submit("worker-2");
		const s = await f.status();
		const product = text(s.qualified, "qualified commit");
		assert.equal(f.workers.size, 2);
		assert.equal(f.checks.length, 3);
		assert.deepEqual(git(f.root, "ls-tree", "-r", "--name-only", product, "--", "lib").split("\n"), ["lib/left/index.mjs", "lib/right/index.mjs"]);
		assert.equal(git(f.root, "show", `${product}:neighbor.txt`), "not owned");
		assert.equal(git(f.root, "rev-parse", "main"), f.tip);
		assert.equal(git(f.root, "show", "-s", "--format=%P", product), f.tip);
		const consumer = path.join(path.dirname(f.root), "consume");
		git(f.root, "worktree", "add", "-q", "--detach", consumer, f.tip);
		git(consumer, "cherry-pick", "--no-commit", product);
		assert.equal(git(consumer, "write-tree"), git(f.root, "rev-parse", `${product}^{tree}`), "normal Git must preserve both deletions");
		await f.runtime(first.cwd).operation("submit", { run, token: first.token }, first.id);
		assert.equal(f.checks.length, 3, "a replay cannot re-evaluate");
	});

test("dependent generation includes the pinned producer but none of its own old source", async (t) => {
	const f = fixture(t, p => { p.seed = ["right"]; p.grains[1].needs = ["left"]; });
	await f.start();
	assert.equal(f.workers.size, 1);
	await f.submit("worker-1");
	const w = f.workers.get("worker-2");
	assert.ok(w);
	assert.equal(existsSync(path.join(w.cwd, "lib/right")), false);
	assert.equal(readFileSync(path.join(w.cwd, "lib/left/index.mjs"), "utf8"), "export default 1;\n");
	const { nodes } = await f.status();
	assert.equal(nodes.find(n => n.grain === "right")?.inputs?.left, nodes.find(n => n.grain === "left")?.checked);
	await f.submit(w.id);
	assert.ok((await f.status()).qualified);
});

test("bounded component repair retains the worker and rejects prior or foreign submissions", async (t) => {
	const f = fixture(t);
	await f.start();
	const w = f.workers.get("worker-1");
	assert.ok(w);
	await assert.rejects(f.runtime(w.cwd).operation("submit", { run, token: w.token }, "impostor"), /assignment/i);
	await f.submit(w.id, 0);
	const r = f.runtime(w.cwd);
	await assert.rejects(r.operation("submit", { run, token: w.token }, w.id), /assignment/i);
	await f.submit(w.id, 0);
	const s = await f.status();
	assert.equal(s.nodes[0].state, "blocked");
	assert.match(String(s.nodes[0].reason), /repair limit/);
	assert.equal(f.workers.size, 2);
});

test("a concurrent target edit conflicts instead of restoring old code over it", async (t) => {
	const f = fixture(t);
	await f.start();
	put(f.root, "lib/left/concurrent", "user work");
	git(f.root, "add", "lib");
	git(f.root, "commit", "-qm", "concurrent");
	await f.submit("worker-1");
	await f.submit("worker-2");
	const s = await f.status();
	assert.equal(s.qualified, null);
	assert.match(String(s.blocker), /Concurrent modification of lib\/left/);
	assert.equal(f.checks.length, 2);
});

test("only the exact evaluated tree qualifies, including rejecting files added by the evaluator", async (t) => {
	const f = fixture(t, undefined, { ".foundry/product.mjs": `import {writeFileSync} from "node:fs";writeFileSync("extra.txt","not in Git");` });
	await f.start();
	await f.submit("worker-1");
	await f.submit("worker-2");
	const s = await f.status();
	assert.equal(s.qualified, null);
	assert.match(String(s.blocker), /extra.txt/);
});

test("checks stream raw blobs larger than 128 MiB and detect byte changes after evaluation", async t => {
	const f = fixture(t), size = 129 * 1024 * 1024;
	const large = path.join(f.root, "large.bin");
	put(f.root, "large.bin", "raw");
	truncateSync(large, size);
	put(f.root, "empty", "");
	put(f.root, "executable", "");
	chmodSync(path.join(f.root, "executable"), 0o755);
	git(f.root, "add", "large.bin", "empty", "executable");
	git(f.root, "commit", "-qm", "large product");
	const commit = git(f.root, "rev-parse", "HEAD");
	await withProduct(f.root, commit, root => {
		assert.equal(statSync(path.join(root, "large.bin")).size, size);
		assert.equal(statSync(path.join(root, "empty")).size, 0);
		assert.ok(statSync(path.join(root, "executable")).mode & 0o100);
	});
	await assert.rejects(withProduct(f.root, f.tip, root => {
		put(root, "neighbor.txt", "not owned!");
	}), /Evaluator changed neighbor.txt/);
});

test("pause preserves issued workers; changed contracts cannot resume or qualify", async (t) => {
	const f = fixture(t);
	await f.start();
	await assert.rejects(f.owner.operation("pause", { run }, "other"), /owner/);
	await f.owner.operation("pause", { run }, "owner");
	await assert.rejects(f.submit("worker-1"), /paused/);
	await f.start();
	assert.equal(f.workers.size, 2);
	put(f.root, ".foundry/api.md", "changed interface");
	git(f.root, "add", ".foundry");
	git(f.root, "commit", "-qm", "revised interface");
	await f.submit("worker-1");
	await f.submit("worker-2");
	assert.match(String((await f.status()).blocker), /contract changed/);
	await assert.rejects(f.start(), /contract/i);
});

test("lost creation reply survives process restart; no second create or forged binding", async (t) => {
	const f = fixture(t, p => { p.seed = ["left"]; });
	let sends = 0;
	const lost = f.runtime(f.root, { execute: async (...args) => { sends++; await f.execute(...args); throw Error("connection lost"); } });
	const s = await lost.operation("start", { source }, "owner");
	assert.equal(s.pending[0].state, "uncertain");
	const child = f.workers.get("worker-1");
	assert.ok(child);
	await assert.rejects(f.runtime(child.cwd).operation("submit", { run, token: child.token }, child.id), /assignment/i);
	const recovered = f.runtime(f.root, {
		execute: async () => { throw Error("unexpected second start"); },
		recover: async (e) => ({ resultType: "success", textResultForLlm: `Created session '${e.args.name}' (id: 6feaa83a-039b-482b-be33-2f683aa18d37) in project 'fixture'.` })
	});
	recovered.turn("owner");
	await recovered.flush();
	assert.equal((await f.status()).nodes[0].worker, "6feaa83a-039b-482b-be33-2f683aa18d37");
	assert.equal(sends, 1);
});

test("denying a prepared scout frees the only slot for another squad, without replay", async (t) => {
	const f = fixture(t, p => { delete p.seed; p.limits = { workers: 1 }; });
	const r = f.runtime(f.root, { execute: async () => ({ resultType: "failure", error: "This session management tool is disabled" }) });
	const s = await r.operation("start", { source }, "owner"), prepared = s.prepared[0];
	assert.ok(prepared);
	assert.throws(() => r.pre(prepared.tool, { ...prepared.arguments, base_branch: "main" }, "owner", "changed"), /prepared/i);
	r.pre(prepared.tool, prepared.arguments, "owner", "native-1");
	assert.throws(() => r.pre(prepared.tool, prepared.arguments, "owner", "duplicate"), /prepared/i);
	const refusal = { type: "permission.completed", data: { toolCallId: "native-1", result: { kind: "denied-interactively-by-user" } } };
	r.refusal({ ...refusal, agentId: "nested" }, "owner");
	r.refusal(refusal, "peer");
	r.refusal({ ...refusal, data: { ...refusal.data, result: { kind: "approved" } } }, "owner");
	assert.equal((await f.status()).reviews[0].state, "reading");
	r.refusal(refusal, "owner");
	await r.flush();
	const stopped = await f.status();
	assert.equal(stopped.reviews[0].state, "blocked");
	assert.match(String(stopped.reviews[0].reason), /permission refused/i);
	assert.equal(stopped.prepared.length, 0);
	assert.throws(() => r.pre(prepared.tool, prepared.arguments, "owner", "again"), /prepared/i);
	r.turn("owner");
	await r.flush();
	assert.deepEqual((await f.status()).reviews.map(x => [x.squad, x.state]), [["left", "blocked"], ["right", "reading"]]);
});

test("after restart only an evidenced denial of the original prepared call is final", async t => {
	const f = fixture(t, p => { p.seed = ["left"]; });
	const r = f.runtime(f.root, { execute: async () => ({ resultType: "failure", error: "This session management tool is disabled" }) });
	const [p] = (await r.operation("start", { source }, "owner")).prepared;
	r.pre(p.tool, p.arguments, "owner", "original");
	const start = { type: "tool.execution_start", id: "s", data: { toolName: p.tool, arguments: p.arguments, toolCallId: "original", turnId: "t" } };
	const end = { type: "tool.execution_complete", id: "e", data: { toolCallId: "original", turnId: "t", success: false, error: { code: "timeout", message: "no reply" } } };
	const permission = { type: "permission.completed", id: "p", data: { toolCallId: "original", result: { kind: "denied-interactively-by-user" } } };
	/** @type {unknown[]} */ let events = [start, { ...permission, data: { ...permission.data, toolCallId: "other" } }, end];
	const resumed = f.runtime(f.root, { recover: e => recover(async () => ({ cursor: "c", cursorStatus: "ok", hasMore: false, events }), e) });
	resumed.turn("owner");
	await resumed.flush();
	assert.equal((await f.status()).pending[0].state, "uncertain");
	events = [{ ...start, data: { ...start.data, arguments: {} } }, permission, end];
	resumed.turn("owner");
	await resumed.flush();
	assert.equal((await f.status()).pending[0].state, "uncertain");
	events = [start, permission, end];
	resumed.turn("owner");
	await resumed.flush();
	const s = await f.status();
	assert.equal(s.nodes[0].state, "blocked");
	assert.match(String(s.nodes[0].reason), /permission refused/i);
	assert.equal(s.prepared.length, 0);
	assert.equal(f.workers.size, 0);
});

for (const kind of ["component", "product"])
	test(`a live denial settles the automatic ${kind} check even if its RPC reply is lost`, async t => {
		const f = fixture(t, p => { p.seed = ["left"]; });
		await f.start();
		const w = f.workers.get("worker-1");
		assert.ok(w);
		let denied = "";
		const worker = f.runtime(w.cwd, { execute: async (tool, args, callId) => {
			if (kind === "product" && !String(args.description).startsWith("Check joined product"))
				return f.execute(tool, args, callId);
			denied = callId;
			if (kind === "component") worker.refusal({ type: "permission.completed", data: {
				toolCallId: callId, result: { kind: "denied-interactively-by-user" }
			} }, w.id);
			throw Error("reply lost");
		} });
		put(w.cwd, "lib/left/index.mjs", "export default 1;");
		await worker.operation("submit", { run, token: w.token }, w.id);
		assert.ok(denied);
		if (kind === "product") {
			assert.ok((await f.status()).pending.some(e => e.kind === kind && e.state === "uncertain"));
			worker.refusal({ type: "tool.execution_complete", data: { toolCallId: denied, success: false, error: { code: "permission_denied" } } }, w.id);
		}
		worker.post(denied, { resultType: "success" }, w.id);
		worker.turn(w.id);
		await worker.flush();
		const s = await f.status();
		assert.equal(s.qualified, null);
		assert.match(String(kind === "product" ? s.blocker : s.nodes[0].reason), /permission refused/i);
		assert.equal(s.nodes[0].state, kind === "component" ? "blocked" : "published");
		assert.equal(s.nodes[0].repairs, 0);
		assert.equal(s.pending.length, 0);
		assert.equal(f.checks.length, kind === "component" ? 0 : 1);
	});

test("after restart shell history can prove refusal but not evaluator success", async t => {
	const f = fixture(t, p => { p.seed = ["left"]; });
	await f.start();
	const w = f.workers.get("worker-1");
	assert.ok(w);
	let issued = 0, denied = false;
	await f.submit(w.id, 1, { execute: async () => { issued++; throw Error("reply lost"); } });
	const resumed = f.runtime(w.cwd, { recover: e => {
		const start = { type: "tool.execution_start", id: "s", data: { toolName: "bash", arguments: e.args, toolCallId: e.callId, turnId: "t" } };
		const end = denied ? { type: "permission.completed", id: "p", data: { toolCallId: e.callId, result: { kind: "denied-by-rules" } } } :
			{ type: "tool.execution_complete", id: "e", data: { toolCallId: e.callId, turnId: "t", success: true, result: { content: "passed" } } };
		return recover(async () => ({ cursor: "c", cursorStatus: "ok", hasMore: false, events: [start, end] }), e);
	} });
	resumed.turn(w.id);
	await resumed.flush();
	assert.match(String((await f.status()).pending[0].reason), /runner has not finished/);
	denied = true;
	resumed.turn(w.id);
	await resumed.flush();
	const s = await f.status();
	assert.equal(s.nodes[0].state, "blocked");
	assert.equal(s.nodes[0].receipt, undefined);
	assert.equal(s.qualified, null);
	assert.equal(issued, 1);
});

test("reads, native callbacks and rejected activations do not initialize unrelated work", async (t) => {
	const f = fixture(t);
	const r = f.runtime(f.root, { mode: async () => "plan" });
	r.turn("stranger");
	await r.flush();
	await assert.rejects(r.operation("start", { source }, "stranger"), /mode|interactive/);
	await assert.rejects(r.operation("status", { run }, "stranger"), /No Foundry/);
	assert.equal(existsSync(ledgerPath(f.root)), false);
	const denied = f.runtime(f.root, { confirm: async () => false });
	await assert.rejects(denied.operation("start", { source }, "owner"), /not activated/);
	assert.equal(existsSync(ledgerPath(f.root)), false);
});

test("charter scope, no-gap and cross-squad prerequisites use the same deliverable graph as a seed", async (t) => {
	const f = fixture(t, p => { delete p.seed; p.grains[1].needs = ["left"]; });
	const start = await f.start();
	assert.equal(start.nodes.length, 0);
	assert.equal(start.reviews.length, 2);
	const scouts = [...f.workers.values()], left = scouts[0], right = scouts[1];
	const claim = { run, token: right.token, outcome: "regenerate", reason: "right still exports zero", evidence: ["lib/right/old.mjs"], grains: ["right"] };
	const scout = f.runtime(right.cwd), noGap = { run, token: left.token, outcome: "no-gap", reason: "no local gap", evidence: [".foundry/left.md"], grains: [] };
	await assert.rejects(scout.operation("observe", { ...claim, grains: ["left"] }, right.id), /another squad/);
	await assert.rejects(scout.operation("observe", { ...claim, evidence: [] }, right.id), /evidence/);
	await assert.rejects(scout.operation("observe", { ...claim, evidence: ["neighbor.txt"] }, right.id), /outside this charter/);
	await f.runtime(left.cwd).operation("observe", noGap, left.id);
	await scout.operation("observe", claim, right.id);
	await scout.operation("observe", claim, right.id);
	assert.equal(f.workers.size, 3);
	const producer = f.workers.get("worker-3");
	assert.ok(producer);
	assert.match(producer.prompt, /complete lib\/left/);
	await f.submit(producer.id);
	const next = await f.status();
	assert.equal(next.nodes.find(n => n.grain === "right")?.inputs?.left, next.nodes.find(n => n.grain === "left")?.checked);
	await f.submit("worker-4");
	assert.ok((await f.status()).qualified);
	await assert.rejects(scout.operation("observe", { ...claim, reason: "different decision" }, right.id), /immutable/);
	f.owner.turn("owner");
	await f.owner.flush();
	assert.equal(f.workers.size, 6, "changed product inputs justify rediscovery");
	for (const [localIndex, w] of [...f.workers.values()].slice(4).entries()) {
		const id = grainIds[localIndex];
		await f.runtime(w.cwd).operation("observe", { ...noGap, token: w.token, evidence: [`.foundry/${id}.md`] }, w.id);
	}
	put(f.root, "neighbor.txt", "unrelated commit");
	git(f.root, "add", "neighbor.txt");
	git(f.root, "commit", "-qm", "neighbor only");
	f.owner.turn("owner");
	await f.owner.flush();
	assert.equal(f.workers.size, 6, "unrelated target change is not a discovery signal");
});

test("a scout can raise a contract question without staffing work; only a fresh later report supersedes it", async t => {
	const f = fixture(t, p => { delete p.seed; p.grains[1].needs = ["left"]; }, { ".foundry/product.mjs": 'import "../lib/left/index.mjs";' });
	await f.start();
	const scout = f.workers.get("worker-2");
	assert.ok(scout);
	const r = f.runtime(scout.cwd);
	const question = { run, token: scout.token, outcome: "needs-decision", reason: "Which behavior should right use from left?",
		evidence: [".foundry/right.md", ".foundry/left.md", "lib/left/old.mjs"], grains: [] };
	for (const change of [{ outcome: undefined }, { outcome: "unknown" }, { outcome: "regenerate" }, { grains: ["right"] }, { outcome: "no-gap", grains: ["right"] }])
		await assert.rejects(r.operation("observe", { ...question, ...change }, scout.id), /outcome/);
	await assert.rejects(r.operation("observe", question, "worker-1"), /bound squad/);
	await assert.rejects(r.operation("observe", { ...question, evidence: ["neighbor.txt"] }, scout.id), /outside this charter/);
	await assert.rejects(r.operation("observe", { ...question, evidence: [] }, scout.id), /evidence/);
	await assert.rejects(r.operation("observe", { ...question, outcome: "regenerate", grains: ["left"] }, scout.id), /another squad/);
	await r.operation("observe", question, scout.id);
	await r.operation("observe", question, scout.id);
	await assert.rejects(r.operation("observe", { ...question, outcome: "no-gap" }, scout.id), /immutable/);
	const reported = await f.status();
	assert.deepEqual(reported.questions, [{ squad: "right", base: f.tip, question: question.reason, evidence: question.evidence }]);
	assert.equal(reported.nodes.length, 0);
	assert.equal(f.workers.size, 2);
	assert.equal((await f.status("worker-1")).questions, undefined);
	await f.observe("worker-1", "left");
	await f.submit("worker-3");
	assert.ok((await f.status()).qualified, "a question is not a veto on independently accepted work");
	f.owner.turn("owner");
	await f.owner.flush();
	assert.deepEqual((await f.status()).questions, reported.questions, "a pending re-review is not an answer");
	put(f.root, "lib/right/old.mjs", "export default 3;");
	git(f.root, "commit", "-qam", "right changed while the scout was reading");
	await f.observe("worker-5", "right", []);
	const stale = await f.status();
	assert.deepEqual(stale.questions, reported.questions);
	assert.ok(stale.reviews.some(v => v.state === "blocked" && v.reason?.includes("inputs changed")));
	await f.observe("worker-6", "right", []);
	const done = await f.status();
	assert.deepEqual(done.questions, []);
	assert.equal(done.reviews.find(v => v.worker === scout.id)?.observation?.outcome, "needs-decision");
});

test("a declared product failure repairs only the implicated worker without rerunning its peer", async (t) => {
	const f = fixture(t, undefined, { ".foundry/product.mjs": `import {existsSync} from "node:fs";if(!existsSync("lib/left/ready")){console.log("FOUNDRY_REPAIR=left");process.exit(1);}` });
	await f.start();
	await f.submit("worker-1");
	await f.submit("worker-2");
	let s = await f.status();
	const nodes = s.nodes;
	assert.equal(s.qualified, null);
	assert.equal(nodes[0].state, "writing");
	assert.equal(nodes[0].repairs, 1);
	assert.equal(nodes[1].state, "published");
	const w = f.workers.get("worker-1");
	assert.ok(w);
	put(w.cwd, "lib/left/ready", "");
	await f.submit(w.id);
	s = await f.status();
	assert.ok(s.qualified);
	assert.equal(f.workers.size, 2);
	assert.equal(f.checks.filter(c => c.startsWith("Check right ")).length, 1);
	assert.equal(f.checks.length, 5);
});

test("a target change at product receipt requires a new joined check, never a new writer", async (t) => {
	const f = fixture(t);
	await f.start();
	await f.submit("worker-1");
	let changed = false;
	await f.submit("worker-2", undefined, {
		execute: async (...args) => {
			const receipt = await f.execute(...args);
			if (!changed && String(args[1].description).startsWith("Check joined product")) {
				changed = true;
				put(f.root, "neighbor.txt", "changed during check");
				git(f.root, "add", "neighbor.txt");
				git(f.root, "commit", "-qm", "concurrent neighbor");
			}
			return receipt;
		}
	});
	const s = await f.status();
	assert.ok(s.qualified);
	assert.equal(f.checks.length, 4);
	assert.equal(f.workers.size, 2);
	assert.equal(git(f.root, "show", `${s.qualified}:neighbor.txt`), "changed during check");
	assert.equal(git(f.root, "show", "-s", "--format=%P", s.qualified), git(f.root, "rev-parse", "main"));
});

test("exclusive durable check receipt survives a lost host reply and pause", async (t) => {
	const f = fixture(t);
	await f.start();
	await f.submit("worker-1");
	await f.submit("worker-2", undefined, {
		execute: async (...args) => {
			await f.execute(...args);
			if (String(args[1].description).startsWith("Check joined product"))
				await f.owner.operation("pause", { run }, "owner");
			throw Error("reply lost");
		}
	});

	assert.equal((await f.status()).qualified, null);
	await f.runtime(f.root).operation("start", { source }, "owner");
	assert.ok((await f.status()).qualified);
	assert.equal(f.checks.length, 3);
	assert.equal(f.workers.size, 2);
});

for (const kind of ["left", "joined product"])
	test(`pause after issuing the ${kind} check lets that runner finish exactly once`, async t => {
		const f = fixture(t, p => { p.seed = ["left"]; }, { ".foundry/product.mjs": 'import "../lib/left/index.mjs";' });
		await f.start();
		const w = f.workers.get("worker-1");
		assert.ok(w);
		const worker = f.runtime(w.cwd, { execute: async (tool, args, callId) => {
			if (String(args.description).startsWith(`Check ${kind} `)) {
				await f.owner.operation("pause", { run }, "owner");
				worker.pre(tool, args, w.id, callId);
			}
			return f.execute(tool, args, callId);
		} });
		put(w.cwd, "lib/left/index.mjs", "export default 1;");
		await worker.operation("submit", { run, token: w.token }, w.id);
		const paused = await f.status();
		assert.equal(paused.active, false);
		assert.equal(paused.qualified, null);
		assert.equal(f.checks.length, kind === "left" ? 1 : 2);
		const resumed = await f.start();
		assert.ok(resumed.qualified);
		assert.equal(f.checks.length, 2);
		assert.equal(f.workers.size, 1);
	});

test("independent starts overlap by default without a capacity prompt; a racing owner turn cannot issue them again", async (t) => {
	const f = fixture(t);
	let active = 0, peak = 0, total = 0, offers = 0;
	const owner = f.runtime(f.root, {
		select: async () => { offers++; return null; },
		execute: async (...args) => {
			total++;
			peak = Math.max(peak, ++active);
			f.owner.turn("owner");
			await new Promise(resolve => setTimeout(resolve, 20));
			active--;
			return f.execute(...args);
		}
	});
	await owner.operation("start", { source }, "owner");
	await f.owner.flush();
	assert.equal(peak, 2);
	assert.equal(total, 2);
	assert.equal(offers, 0);
	assert.equal(f.workers.size, 2);
});

/** @param {FixturePolicy} p */
function addIndependent(p) {
	p.grains.push({ ...p.grains[0], id: "extra", directory: "lib/extra", check: ".foundry/extra.mjs" });
	p.seed?.push("extra");
	p.squads[0].grains.push("extra");
}
const extraCheck = { ".foundry/extra.mjs": 'import "../lib/extra/index.mjs";' };

for (const raise of [false, true])
	test(`saturation offers only ready work; ${raise ? "increase" : "keep"} survives resume`, async t => {
		const f = fixture(t, p => {
			addIndependent(p);
			// A fourth writer belongs to the graph, but its input is not ready.
			p.grains.push({ ...p.grains[0], id: "last", directory: "lib/last", needs: ["left"] });
			p.seed?.push("last");
		}, extraCheck);
		/** @type {(choice:string)=>void} */ let answer = () => assert.fail("no worker-cap question");
		/** @type {string[][]} */ const choices = [];
		const owner = f.runtime(f.root, { select: (_message, options) => {
			choices.push(options);
			return new Promise(resolve => { answer = resolve; });
		} });
		await owner.operation("start", { source }, "owner");
		assert.equal(f.workers.size, 2, "launch the authorized workers before asking");
		owner.turn("owner");
		await owner.operation("start", { source }, "owner");
		assert.deepEqual(choices, [["Keep 2", "Increase to 3"]]);
		answer(choices[0][raise ? 1 : 0]);
		await owner.flush();
		const cap = raise ? 3 : 2;
		assert.equal((await f.status()).limit, cap);
		assert.equal(f.workers.size, cap);
		await owner.operation("pause", { run }, "owner");
		const restarted = f.runtime(f.root, { select: async (_msg, options) => { choices.push(options); return null; } });
		assert.equal((await restarted.operation("start", { source }, "owner")).limit, cap);
		await f.submit("worker-1");
		assert.equal(f.workers.size, cap + 1, "keeping the cap must not stall queued work");
		restarted.turn("owner");
		await restarted.flush();
		assert.equal(choices.length, 1, "no repeat after Keep, or for work merely waiting on an input");
	});

test("work drains under the old cap while a decision is open; an obsolete approval cannot raise it", async t => {
	const f = fixture(t, addIndependent, extraCheck);
	/** @type {()=>void} */ let answer = () => assert.fail("no worker-cap question");
	const owner = f.runtime(f.root, { select: (_message, options) => new Promise(resolve => { answer = () => resolve(options[1]); }) });
	await owner.operation("start", { source }, "owner");
	await f.submit("worker-1");
	assert.equal(f.workers.size, 3);
	await f.submit("worker-2");
	await f.submit("worker-3");
	assert.ok((await f.status()).qualified);
	answer();
	await owner.flush();
	assert.equal((await f.status()).limit, 2);
});

test("reopening an unanswered choice still requires consent for the exact cap shown", async t => {
	const f = fixture(t, p => {
		addIndependent(p);
		p.grains.push({ ...p.grains[0], id: "fourth", directory: "lib/fourth" });
		p.seed?.push("fourth");
	}, extraCheck);
	/** @type {()=>void} */ let oldYes = () => assert.fail("no original dialog");
	const old = f.runtime(f.root, { select: (_msg, options) => new Promise(resolve => { oldYes = () => resolve(options[1]); }) });
	await old.operation("start", { source }, "owner");
	old.close();
	oldYes();
	await old.flush();
	assert.equal((await f.status()).limit, 2);
	/** @type {()=>void} */ let yes = () => assert.fail("no new dialog");
	const owner = f.runtime(f.root, { select: (_msg, options) => new Promise(resolve => {
		assert.deepEqual(options, ["Keep 2", "Increase to 4"]);
		yes = () => resolve(options[1]);
	}) });
	await owner.operation("start", { source }, "owner");
	await f.submit("worker-1");
	assert.equal((await f.status()).proposedLimit, 3);
	yes();
	await owner.flush();
	assert.equal((await f.status()).limit, 4);
	assert.equal(f.workers.size, 4);
});

test("a scout that discovers overflow wakes the owner; only the owner's choice can grant more slots", async t => {
	const f = fixture(t, p => { delete p.seed; addIndependent(p); }, extraCheck);
	await f.start();
	const scout = f.workers.get("worker-1");
	assert.ok(scout);
	let notices = 0, childPrompts = 0, ownerPrompts = 0;
	const child = f.runtime(scout.cwd, {
		select: async (_msg, options) => { childPrompts++; return options[1]; },
		execute: async (tool, args, id) => {
			if (tool === "send_session_message") { notices++; assert.equal(args.session_id, "owner"); }
			return f.execute(tool, args, id);
		}
	});
	await child.operation("observe", { run, token: scout.token, outcome: "regenerate", grains: ["left", "extra"], reason: "missing implementations", evidence: [".foundry/left.md"] }, scout.id);
	assert.equal(notices, 1);
	assert.equal(childPrompts, 0);
	assert.equal(f.workers.size, 3, "one scout and one writer occupy the two slots");
	const owner = f.runtime(f.root, { select: async (_msg, options) => { ownerPrompts++; return options[1]; } });
	owner.turn("owner");
	await owner.flush();
	assert.equal(ownerPrompts, 1);
	assert.equal((await f.status()).limit, 3);
	assert.equal(f.workers.size, 4);
});

test("only the original top-level call, arguments and turn can recover an uncertain start", async (t) => {
	const f = fixture(t, p => { p.seed = ["left"]; });
	const owner = f.runtime(f.root, { execute: async () => { throw Error("transport lost"); } });
	await owner.operation("start", { source }, "owner");
	const db = openDatabase(f.root);
	t.after(() => db.close());
	const e = db.read(run)?.effects[0];
	assert.ok(e);
	const start = { id: "a", type: "tool.execution_start", data: { toolName: "functions.create_session", arguments: e.args, toolCallId: e.callId, turnId: "t" } };
	const end = { id: "b", type: "tool.execution_complete", data: { toolCallId: e.callId, turnId: "t", success: true, result: { content: JSON.stringify({ id: "worker" }) } } };
	const page = (/** @type {unknown[]} */ events) => ({ cursor: "history", cursorStatus: "ok", hasMore: false, events });
	assert.equal((await recover(async (p) => p.cursor ? page([start]) : { ...page([end]), hasMore: true }, e)).textResultForLlm, end.data.result.content);
	for (const changed of [{ arguments: {} }, { turnId: "other" }, { parentToolCallId: "nested" }, { toolCallId: "peer" }])
		await assert.rejects(recover(async () => page([end, { ...start, data: { ...start.data, ...changed } }]), e), /matching|not confirmed/);
	const rejected = { ...end, data: { ...end.data, success: false, error: { code: "rejected", message: "user declined" } } };
	assert.equal((await recover(async () => page([start, rejected]), e)).resultType, "denied");
	await assert.rejects(recover(async () => page([start, { ...rejected, data: { ...rejected.data, error: { message: "looks like a denial" } } }]), e), /not confirmed/);
});

test("unknown protocols are not migrated and invalid nested records are refused, even with a matching checksum", async (t) => {
	const f = fixture(t, p => { delete p.seed; }), file = ledgerPath(f.root);
	openDatabase(f.root, file, true).close();
	const old = new DatabaseSync(file);
	old.exec(`PRAGMA user_version=${protocol - 1};`);
	old.close();
	const bytes = readFileSync(file);
	assert.throws(() => openDatabase(f.root), /Incompatible/);
	assert.deepEqual(readFileSync(file), bytes);
	rmSync(file);
	await f.start();
	await f.observe("worker-1", "left", []);
	const db = openDatabase(f.root);
	t.after(() => db.close());
	const initial = db.read(run);
	assert.ok(initial);
	assert.throws(() => db.update(run, r => { r.active = false; throw Error("rollback"); }), /rollback/);
	assert.deepEqual(db.read(run), initial);
	const review = initial.reviews[0];
	const raw = new DatabaseSync(file);
	for (const broken of [
		{ ...initial, nodes: { left: { state: "finished-by-claim", repairs: 0 } } },
		{ ...initial, capacity: { ...initial.capacity, limit: 0 } },
		{ ...initial, reviews: [{ ...review, observation: { ...review.observation, outcome: "needs-decision", grains: ["left"] } }] },
		{ ...initial, reviews: [{ ...review, observation: { reason: "missing outcome", evidence: [".foundry/left.md"], grains: [] } }] },
	]) {
		raw.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(JSON.stringify(broken), digest(broken), run);
		assert.throws(() => db.read(run), /Invalid Foundry execution snapshot/);
	}
	raw.close();
});

test("independent squad observations staff two writers and qualify a single combined product", async t => {
	const f = fixture(t, p => { delete p.seed; });
	await f.start();
	await f.observe("worker-1", "left");
	await f.observe("worker-2", "right");
	assert.equal(f.workers.size, 4, "both writers can start before either submits");
	assert.deepEqual((await f.status()).nodes.map(n => n.inputs), [{}, {}]);
	await f.submit("worker-3"); await f.submit("worker-4");
	const s = await f.status();
	assert.ok(s.qualified);
	assert.deepEqual(s.outputs, Object.fromEntries(s.nodes.map(n => [n.grain, n.checked])));
	assert.deepEqual(s.reviews.map(r => r.observation?.grains), [["left"], ["right"]]);
	assert.equal(s.products?.length, 1);
	assert.equal(f.checks.length, 3);
});

for (const seeded of [true, false])
	test(`a blocked grain ${seeded ? "holds its seed" : "does not veto an independent discovered product"}`, async t => {
		const f = fixture(t, p => { if (!seeded) delete p.seed; }, { ".foundry/product.mjs": 'import "../lib/right/index.mjs";' });
		await f.start();
		if (!seeded) {
			await f.observe("worker-1", "left");
			await f.observe("worker-2", "right");
		}
		await f.submit(seeded ? "worker-1" : "worker-3", 1, { execute: async () => ({ resultType: "denied" }) });
		await f.submit(seeded ? "worker-2" : "worker-4");
		const s = await f.status();
		assert.equal(s.nodes.find(n => n.grain === "left")?.state, "blocked");
		assert.equal(Boolean(s.qualified), !seeded);
		assert.deepEqual(Object.keys(s.outputs ?? {}), seeded ? [] : ["right"]);
	});

test("a later observation adds to an unattributed failed product without rerunning its checked writer", async t => {
	const f = fixture(t, p => { delete p.seed; });
	await f.start();
	await f.observe("worker-1", "left");
	await f.submit("worker-3");
	assert.match(String((await f.status()).blocker), /without identifying/);
	await f.observe("worker-2", "right");
	await f.submit("worker-4");
	const s = await f.status();
	assert.ok(s.qualified);
	assert.equal(s.blocker, undefined);
	assert.equal(f.checks.filter(c => c.startsWith("Check left ")).length, 1);
	assert.equal(f.workers.size, 4);
});

test("a later blocked observation cannot reissue a denied check of the identical candidate", async t => {
	const f = fixture(t, p => { delete p.seed; });
	await f.start();
	await f.observe("worker-1", "left");
	let productCalls = 0;
	/** @type {Host["execute"]} */
	const refuse = (...args) => {
		if (String(args[1].description).startsWith("Check left ")) return f.execute(...args);
		if (String(args[1].description).startsWith("Check joined product")) productCalls++;
		return Promise.resolve({ resultType: "denied" });
	};
	await f.submit("worker-3", 1, { execute: refuse });
	const held = (await f.status()).candidate;
	assert.ok(held);
	await f.observe("worker-2", "right");
	await f.submit("worker-4", 2, { execute: refuse });
	const s = await f.status();
	assert.deepEqual(s.candidate, held);
	assert.match(String(s.blocker), /permission refused/);
	assert.equal(productCalls, 1);
});

test("a passing check on a frozen candidate cannot qualify work admitted while its reply is in flight", async t => {
	const f = fixture(t, p => { delete p.seed; }, { ".foundry/product.mjs": 'import "../lib/left/index.mjs";' });
	await f.start();
	await f.observe("worker-1", "left");
	let oldCommit;
	await f.submit("worker-3", 1, { execute: async (...args) => {
		const result = await f.execute(...args);
		if (String(args[1].description).startsWith("Check joined product")) {
			oldCommit = (await f.status()).candidate?.commit;
			await f.observe("worker-2", "right");
		}
		return result;
	} });
	assert.ok(oldCommit);
	assert.equal((await f.status()).qualified, null);
	await f.submit("worker-4");
	const s = await f.status();
	assert.notEqual(s.qualified, oldCommit);
	assert.equal(s.products?.length, 1);
	assert.equal(git(f.root, "show", `${s.qualified}:lib/right/index.mjs`), "export default 2;");
});

for (const first of grainIds)
	test(`shared repair after ${first} reports first invalidates only consumers of the superseded input`, async t => {
		const f = fixture(t, p => { delete p.seed; p.grains[1].needs = ["left"]; }, {
			".foundry/product.mjs": `import {existsSync} from "node:fs";
				if (!existsSync("lib/left/ready")) {console.log("FOUNDRY_REPAIR=left");process.exit(1);}`
		});
		await f.start();
		for (const id of [first, ...grainIds.filter(id => id !== first)])
			await f.observe(id === "left" ? "worker-1" : "worker-2", id);
		assert.equal(f.workers.size, 3, "one active supplier for the shared prerequisite");
		await f.submit("worker-3");
		const before = await f.status();
		assert.ok(before.nodes.find(n => n.grain === "right")?.inputs?.left);
		await f.submit("worker-4");
		const s = await f.status();
		assert.ok(s.nodes.some(n => n.grain === "left" && n.repairs === 1 && n.state === "writing"));
		const old = f.workers.get("worker-4"), left = f.workers.get("worker-3");
		assert.ok(old && left);
		await assert.rejects(f.runtime(old.cwd).operation("submit", { run, token: old.token }, old.id), /assignment/i);
		put(left.cwd, "lib/left/ready", "fixed");
		await f.submit(left.id);
		const next = f.workers.get("worker-5");
		assert.ok(next);
		assert.equal(readFileSync(path.join(next.cwd, "lib/left/ready"), "utf8"), "fixed");
		await f.submit(next.id);
		const done = await f.status();
		assert.equal(done.products?.length, 1);
		assert.equal(git(f.root, "show", `${done.qualified}:lib/left/ready`), "fixed");
		assert.equal(f.workers.size, 5);
	});

test("a later product can repair a qualified input without changing the prior product or its receipt", async t => {
	const f = fixture(t, p => { delete p.seed; p.grains[1].needs = ["left"]; }, {
		".foundry/product.mjs": `import {existsSync} from "node:fs";
			if (existsSync("lib/right/index.mjs") && !existsSync("lib/left/ready")) { console.log("FOUNDRY_REPAIR=left");process.exit(1); }`
	});
	await f.start();
	await f.observe("worker-2", "right", []);
	await f.observe("worker-1", "left");
	await f.submit("worker-3");
	const qualified = (await f.status()).products?.[0];
	assert.ok(qualified?.receipt);
	f.owner.turn("owner");
	await f.owner.flush();
	await f.observe("worker-4", "left", []);
	await f.observe("worker-5", "right");
	await f.submit("worker-6");
	const left = f.workers.get("worker-3");
	assert.ok(left);
	put(left.cwd, "lib/left/ready", "fixed");
	await f.submit(left.id);
	await f.submit("worker-7");
	const s = await f.status();
	assert.deepEqual(s.products?.[0], qualified);
	assert.equal(s.products?.length, 2);
	assert.equal(git(f.root, "show", `${s.qualified}:lib/left/ready`), "fixed");
	assert.equal(git(f.root, "show", "-s", "--format=%P", text(s.qualified, "qualified commit")), f.tip);
});

test("contracts reject overlapping ownership, missing boundaries and dependency cycles before starting", t => {
	const f = fixture(t);
	const check = (/** @type {(p:ReturnType<typeof policy>)=>void} */ mutate, /** @type {RegExp} */ expected) => {
		const p = policy(); mutate(p); put(f.root, source, JSON.stringify(p));
		git(f.root, "add", source); git(f.root, "commit", "-qm", "change contract");
		assert.throws(() => readPolicy(f.root, source), expected);
	};
	check(p => { p.grains[1].directory = "lib/Left/nested"; }, /disjoint/);
	check(p => { p.grains[0].boundary = []; }, /boundary/);
	check(p => { p.grains[0].needs = ["right"]; p.grains[1].needs = ["left"]; }, /cycle/);
	check(p => { p.productCheck = "lib/left/old.mjs"; }, /overlap/);
	check(p => { p.limits = { workers: 0 }; }, /worker limit/);
	check(p => { p.limits = { repairs: -1 }; }, /repair limit/);
	assert.equal(existsSync(ledgerPath(f.root)), false);
});
