import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { factory, git, put } from "../test/fixture.mjs";
import { openDatabase, ledgerPath, protocol } from "./database.mjs";
import { readPolicy } from "./contract.mjs";
import { advance } from "./graph.mjs";
import { withProduct } from "./product.mjs";
import { recover } from "./recovery.mjs";
import { createRuntime } from "./runtime.mjs";
import { digest, record, text } from "./values.mjs";

/** @typedef {Parameters<typeof createRuntime>[1]} Host */
/** @typedef {import("./model.js").Effect} Effect */
const grainIds = ["left", "right"];
const source = ".foundry/policy.json", run = "sum";
const policy = () => ({
	version: 1, id: run, direction: "Make the joined exports sum to three", target: "refs/heads/main", productCheck: ".foundry/product.mjs",
	goalCheck: /** @type {string|undefined} */ (undefined),
	grains: grainIds.map(id => ({ id, directory: `lib/${id}`, specification: `.foundry/${id}.md`, boundary: [".foundry/api.md"], check: `.foundry/${id}.mjs`, needs: /** @type {string[]} */ ([]) })),
	limits: /** @type {{workers?:number,repairs?:number,deadline?:string}|undefined} */ (undefined), seed: /** @type {string[]|undefined} */ ([...grainIds]),
	squads: grainIds.map(id => ({ id, charter: `.foundry/${id}.md`, grains: [id], agent: `${id}-specialist` }))
});

/** @typedef {ReturnType<typeof policy>} FixturePolicy */
/** @param {import("node:test").TestContext} t @param {(p:FixturePolicy)=>void} [configure]
 * @param {Record<string,string>} [files] */
function fixture(t, configure, files = {}) {
	const p = policy();
	configure?.(p);
	const baseline = { [source]: JSON.stringify(p), ".foundry/api.md": "Default-export an integer.", "neighbor.txt": "not owned\n",
		[p.productCheck]: 'import a from "../lib/left/index.mjs";import b from "../lib/right/index.mjs";if(a+b!==3)throw Error("bad join");' };
	for (const [i, id] of grainIds.entries()) {
		baseline[`lib/${id}/old.mjs`] = "export default 0;\n";
		baseline[`.foundry/${id}.md`] = `Implement ${id} with value ${i + 1}.`;
		baseline[`.foundry/${id}.mjs`] = `import n from "../lib/${id}/index.mjs"; if(n!==${i + 1}) throw Error("wrong ${id}");`;
	}
	const f = factory(t, run, source, { ...baseline, ...files }), { workers, runtime } = f;
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
	return { ...f, p, submit, observe };
}

const goalCheck = ".foundry/final.mjs";
/** @param {FixturePolicy} p */
function goal(p) { p.goalCheck = goalCheck; delete p.seed; }
const goalFiles = {
	".foundry/product.mjs": 'import n from "../lib/left/index.mjs"; if (n !== 1) throw Error("left regressed");',
	[goalCheck]: `import { existsSync } from "node:fs";
		const checked = async side => existsSync("lib/"+side+"/index.mjs") ? (await import("../lib/"+side+"/index.mjs")).default : 0;
		const left = await checked("left"), right = await checked("right");
		if (left + right !== 3) { console.log(left === 1 ? "Left is ready; right does not contribute two." : "Left does not contribute one."); process.exit(1); }
		console.log("Observed the joined result: 3");`
};

for (const lateWork of [false, true])
	test(`a ready product is checked before the other scout reports / ${lateWork ? "superseded" : "accepted"}`, async t => {
		const f = fixture(t, goal, { ...goalFiles, [goalCheck]: 'import {existsSync} from "node:fs"; process.exit(existsSync("lib/left/index.mjs") ? 0 : 1)' });
		await f.start();
		const [left, right] = f.workers.values();
		await f.observe(left.id, "left");
		let first;
		await f.submit("worker-3", 1, { execute: async (...args) => {
			const reply = await f.execute(...args);
			if (String(args[1].description).startsWith("Check joined product")) {
				const s = await f.status();
				assert.equal(s.reviews.find(r => r.worker === right.id)?.state, "reading");
				first = s.candidate?.commit;
				if (lateWork) await f.observe(right.id, "right");
			}
			return reply;
		} });
		assert.ok(first, "the evaluator must not wait for an unrelated report");
		if (!lateWork) {
			const done = await f.status();
			assert.equal(done.qualified, first);
			assert.equal(done.goal?.receipt?.commit, first);
			await assert.rejects(f.observe(right.id, "right"), /goal met/i);
			assert.equal(f.workers.size, 3);
			return;
		}
		const stale = await f.status();
		assert.equal(stale.qualified, null);
		assert.equal(stale.checkpoint, null, "new work arrived before the earlier check was applied");
		const w = stale.nodes.find(n => n.grain === "right")?.worker;
		assert.ok(w);
		await f.submit(w);
		const done = await f.status();
		assert.ok(done.qualified);
		assert.notEqual(done.qualified, first);
		assert.equal(done.products?.length, 1);
		assert.equal(done.products[0].receipt?.commit, done.goal?.receipt?.commit);
	});

test("an attributed goal gap staffs only its squad and widens discovery if that scout has no work", async t => {
	const f = fixture(t, goal, { ...goalFiles, [goalCheck]: `import {existsSync} from "node:fs";
		if (!existsSync("lib/left/index.mjs")) console.log("FOUNDRY_SQUAD=left\\nFOUNDRY_SQUAD=right");
		else console.log("FOUNDRY_SQUAD=right");
		process.exit(1);` });
	await f.start();
	const [left, right] = f.workers.values();
	await f.observe(left.id, "left");
	await f.submit("worker-3");
	const focused = await f.status();
	assert.deepEqual(focused.reviews.filter(r => r.base === focused.checkpoint).map(r => r.squad), ["right"]);
	await f.observe(right.id, "right");
	assert.equal((await f.status()).nodes.some(n => n.grain === "right"), false, "an older review cannot add work to the checkpoint");
	await f.observe("worker-4", "right", []);
	const full = await f.status();
	assert.deepEqual(full.reviews.filter(r => r.base === full.checkpoint).map(r => r.squad), ["right", "left"]);
	assert.equal(full.blocker, undefined);
	await f.observe("worker-5", "left", []);
	assert.match(String((await f.status()).blocker), /no actionable grain/i);
});

test("an early failed milestone widens a focused search and preserves its checked writer", async t => {
	const f = fixture(t, goal, { [goalCheck]: 'import {existsSync} from "node:fs"; console.log("FOUNDRY_SQUAD=left"); process.exit(existsSync("lib/right/index.mjs") ? 0 : 1)' });
	const start = await f.start();
	assert.deepEqual(start.reviews.map(r => r.squad), ["left"]);
	await f.observe("worker-1", "left");
	await f.submit("worker-2");
	const failed = await f.status();
	assert.equal(failed.candidate?.receipt?.exit, 1);
	assert.match(String(failed.blocker), /without identifying/);
	assert.deepEqual(failed.reviews.map(r => r.squad), ["left", "right"]);
	await f.observe("worker-3", "right");
	await f.submit("worker-4");
	const done = await f.status();
	assert.ok(done.qualified);
	assert.equal(done.goal?.receipt?.commit, done.qualified);
	assert.equal(done.products?.length, 1);
	assert.equal(f.checks.filter(c => c.startsWith("Check left ")).length, 1);
});

const unitCheck = ".foundry/unit.mjs";
const areaPolicy = () => ({
	version: 2, id: run, direction: "Reply in the selected account; keep the draft when the send outcome is unknown.", target: "refs/heads/main",
	productCheck: ".foundry/product.mjs", goalCheck,
	squads: ["engine", "mail"].map((id, i) => ({ id, charter: `.foundry/${grainIds[i]}.md`, areas: [id], boundary: [".foundry/api.md"], checks: [unitCheck] }))
});
/** @param {import("node:test").TestContext} t @param {Record<string,string>} [files] */
function replyFixture(t, files = {}) {
	const f = fixture(t, undefined, {
		[source]: JSON.stringify(areaPolicy()),
		[unitCheck]: `import assert from "node:assert/strict";
			const unit = (await import("../"+process.env.FOUNDRY_DIRECTORY+"/index.mjs")).default;
			assert.equal(typeof unit,"function");
			if(process.env.FOUNDRY_GRAIN==="editor") assert.equal(unit("unfinished reply"),"unfinished reply");
			if(process.env.FOUNDRY_GRAIN==="recover") assert.equal(unit(),"outcome unknown");`,
		".foundry/product.mjs": `import assert from "node:assert/strict"; import edit from "../mail/compose/editor/index.mjs";
			assert.equal(edit("typed reply"),"typed reply");`,
		[goalCheck]: `import {existsSync} from "node:fs";
			if(existsSync("mail/compose/send/index.mjs")) {
				const reply=(await import("../mail/compose/send/index.mjs")).default, calls=[];
				const state=await reply("retained text",async text=>{calls.push(text);throw Error("acknowledgment lost")});
				if(state==="outcome unknown" && calls.length===1 && calls[0]==="retained text") process.exit(0);
			}
			console.log("Reply did not send the typed draft once and preserve the unknown outcome");process.exit(1);`,
		...files
	});
	/** @param {string} worker @param {string} token @param {string} evidence @param {(string|import("./model.js").Proposal)[]} grains @param {string[]} [replace] */
	function report(worker, token, evidence, grains, replace) {
		const w = f.workers.get(worker); assert.ok(w);
		return f.runtime(w.cwd).operation("observe", { run, token, outcome: grains.length ? "regenerate" : "no-gap",
			reason: "Inspect the remaining reply behavior", evidence: [evidence], grains, ...(replace ? { replace } : {}) }, worker);
	}
	/** @param {string} id @param {string} body @param {Partial<Host>} [options] */
	async function write(id, body, options) {
		const n = (await f.status()).nodes.find(n => n.grain === id);
		assert.ok(n?.worker);
		const w = f.workers.get(n.worker); assert.ok(w);
		put(w.cwd, `${n.directory}/index.mjs`, body);
		const attempt = (await f.status(w.id)).nodes.find(n => n.grain === id);
		assert.ok(attempt?.token);
		await f.runtime(w.cwd, options).operation("submit", { run, token: attempt.token }, w.id);
	}
	return { ...f, report, write };
}
/** @param {string} id @param {string} directory @param {string[]} [needs] */
const work = (id, directory, needs = []) => ({ id, directory, task: `Implement ${id} behavior`, needs, check: unitCheck });

test("a scout splits pending work on one assessed revision; independent writers start together and a fixture-only integration cannot finish the run", async t => {
	const f = replyFixture(t);
	let confirmations = 0;
	const owner = f.runtime(f.root, { confirm: async () => { confirmations++; return true; } });
	const start = await owner.operation("start", { source }, "owner");
	assert.deepEqual(start.nodes, []);
	const [core, mail] = f.workers.values();
	const recover = work("recover", "engine/recovery"), coarse = work("compose", "mail/compose", ["recover"]);
	await f.report(core.id, core.token, ".foundry/left.md", [recover]);
	const initial = await f.report(mail.id, mail.token, ".foundry/right.md", [coarse]);
	assert.equal(initial.nodes.find(n => n.grain === "compose")?.state, "waiting");
	const next = text(initial.reviews[0].nextToken, "current scout cursor");
	const editor = work("editor", "mail/compose/editor"), send = work("send", "mail/compose/send", ["editor", "recover"]);
	const split = () => f.report(mail.id, next, ".foundry/api.md", [editor, send], ["compose"]);
	await split();
	await split(); // Lost response: no second split or creation, even though compose no longer exists.
	const parallel = await f.status(), jobs = parallel.nodes.filter(n => n.state === "writing");
	assert.deepEqual(jobs.map(n => n.grain).sort(), ["editor", "recover"]);
	assert.deepEqual(parallel.nodes.find(n => n.grain === "send")?.requires, ["editor", "recover"]);
	assert.equal(f.workers.size, 4);
	for (const n of jobs) {
		const w = f.workers.get(text(n.worker, "writer")); assert.ok(w);
		assert.ok(w.prompt.includes(`Reviewed input revision: ${f.tip}`));
		assert.match(w.prompt, /Assigned behavior: Implement/);
	}
	await f.write("editor", "export default text=>text;");
	assert.equal((await f.status()).nodes.find(n => n.grain === "send")?.state, "waiting");
	await f.write("recover", 'export default ()=>"outcome unknown";');
	const ready = await f.status(), wire = ready.nodes.find(n => n.grain === "send");
	assert.equal(wire?.state, "writing");
	assert.deepEqual(wire.inputs, Object.fromEntries(ready.nodes.filter(n => n.checked).map(n => [n.grain, n.checked])));
	await f.write("send", 'export default async ()=>"outcome unknown";'); // Fixture shortcut: never calls the transport.
	const checkpoint = await f.status();
	assert.equal(checkpoint.products?.[0].receipt?.exit, 0);
	assert.equal(checkpoint.goal?.receipt?.exit, 1);
	assert.equal(checkpoint.qualified, null);
	assert.match(String(checkpoint.goal.receipt.output), /did not send/);
	const oldMail = (await f.status(mail.id)).reviews.at(-1);
	assert.ok(oldMail);
	await assert.rejects(f.report(mail.id, oldMail.id, ".foundry/right.md", ["send"]), /no longer current/);
	const fresh = [...f.workers.values()].slice(-2);
	await f.report(fresh[0].id, fresh[0].token, ".foundry/left.md", []);
	await f.report(fresh[1].id, fresh[1].token, "mail/compose/send/index.mjs", [{ ...send, task: "Connect the actual transport" }]);
	const writer = [...f.workers.values()].at(-1); assert.ok(writer);
	assert.ok(writer.prompt.includes(`Reviewed input revision: ${checkpoint.checkpoint}`));
	assert.equal(existsSync(path.join(writer.cwd, send.directory)), false);
	await f.write("send", `import edit from "../editor/index.mjs";import recover from "../../../engine/recovery/index.mjs";
		export default async (text,send)=>{try {await send(edit(text));return "sent"}catch{return recover()}}`);
	const done = await f.status();
	assert.ok(done.qualified);
	assert.equal(done.goal?.receipt?.commit, done.qualified);
	assert.equal(done.products?.at(-1)?.receipt?.commit, done.qualified);
	assert.deepEqual(done.products?.[0], checkpoint.products?.[0]);
	assert.equal(confirmations, 1);
	assert.equal(git(f.root, "rev-parse", "main"), f.tip);
});

for (const conflict of [false, true])
	test(`a checked parent becomes the base for two child writers; a ${conflict ? "conflicting" : "disjoint"} target edit is ${conflict ? "blocked" : "preserved"}`, async t => {
		const dir = "mail/compose";
		const f = replyFixture(t, {
			".foundry/product.mjs": `import {readFileSync} from "node:fs";if(readFileSync("${dir}/keep","utf8")!=="retained")throw Error("lost checkpoint");`,
			[goalCheck]: `import {existsSync} from "node:fs";
				if(!existsSync("${dir}/editor/index.mjs")||!existsSync("${dir}/send/index.mjs"))process.exit(1);
				const edit=(await import("../${dir}/editor/index.mjs")).default, send=(await import("../${dir}/send/index.mjs")).default;
				if(send(edit("reply"))!=="sent:reply")process.exit(1);`
		});
		await f.start();
		const [core, mail] = f.workers.values();
		await f.report(mail.id, mail.token, ".foundry/right.md", [work("compose", dir)]);
		const parent = [...f.workers.values()].at(-1); assert.ok(parent);
		await f.report(core.id, core.token, ".foundry/left.md", [work("preview", "engine/preview", ["compose"])]);
		put(parent.cwd, `${dir}/keep`, "retained");
		put(parent.cwd, `${dir}/editor/obsolete`, "old editor");
		await f.write("compose", "export default ()=>false;");
		await f.write("preview", "export default ()=>true;");
		const checkpoint = (await f.status()).products?.[0]; assert.ok(checkpoint?.receipt);
		const [nextCore, nextMail] = [...f.workers.values()].slice(-2);
		await f.report(nextCore.id, nextCore.token, ".foundry/left.md", []);
		await f.report(nextMail.id, nextMail.token, `${dir}/keep`, [work("editor", `${dir}/editor`), work("send", `${dir}/send`)], conflict ? ["compose"] : []);
		const writers = (await f.status()).nodes;
		assert.deepEqual(writers.map(n => [n.grain, n.state]), [["editor", "writing"], ["send", "writing"]]);
		for (const n of writers) {
			const w = f.workers.get(text(n.worker, "writer")); assert.ok(w);
			assert.ok(w.prompt.includes(`Reviewed input revision: ${checkpoint.commit}`));
			assert.equal(existsSync(path.join(w.cwd, n.directory)), false);
			assert.equal(readFileSync(path.join(w.cwd, dir, "keep"), "utf8"), "retained");
			assert.ok(existsSync(path.join(w.cwd, "engine/preview/index.mjs")), "retiring a checked consumer's name does not delete its files");
		}
		await assert.rejects(f.runtime(parent.cwd).operation("submit", { run, token: parent.token }, parent.id), /assignment/);
		const external = `${dir}/${conflict ? "keep" : "sibling"}`;
		put(f.root, external, "target edit"); git(f.root, "add", external); git(f.root, "commit", "-qm", "move target");
		put(f.root, "only-staged", "leave in index"); git(f.root, "add", "only-staged");
		const index = git(f.root, "write-tree"), tip = git(f.root, "rev-parse", "main");
		await f.write("editor", "export default text=>text;");
		await f.write("send", 'export default text=>"sent:"+text;');
		const result = await f.status();
		assert.deepEqual(result.products?.[0], checkpoint);
		assert.equal(git(f.root, "show", `${checkpoint.commit}:${dir}/editor/obsolete`), "old editor");
		assert.equal(git(f.root, "write-tree"), index);
		assert.equal(git(f.root, "rev-parse", "main"), tip);
		if (conflict) {
			assert.equal(result.qualified, null);
			assert.equal(result.checkpoint, checkpoint.commit);
			assert.match(String(result.blocker), /Concurrent modification.*mail\/compose\/keep/);
		} else {
			assert.ok(result.qualified);
			assert.equal(result.goal?.receipt?.commit, result.qualified);
			assert.equal(result.products?.at(-1)?.receipt?.commit, result.qualified);
			assert.deepEqual(Object.keys(result.outputs ?? {}).sort(), ["editor", "send"]);
			assert.equal(git(f.root, "show", `${result.qualified}:${external}`), "target edit");
			assert.equal(git(f.root, "ls-tree", "-r", "--name-only", result.qualified, "--", `${dir}/editor`), `${dir}/editor/index.mjs`);
		}
	});

const compose = "mail/compose", composeBody = "export default ()=>true;", originalCompose = "export default ()=>false;";
const splitCompose = () => ["editor", "send"].map(id => work(id, `${compose}/${id}`));

/** @param {import("node:test").TestContext} t @param {Record<string,string>} [files] */
async function composeRound(t, files) {
	const f = replyFixture(t, { [`${compose}/index.mjs`]: originalCompose, ".foundry/product.mjs": `import "../${compose}/index.mjs";`, ...files });
	await f.start();
	const [core, mail] = f.workers.values();
	await f.report(core.id, core.token, ".foundry/left.md", []);
	await f.report(mail.id, mail.token, ".foundry/right.md", [work("compose", compose)]);
	return f;
}

/** @param {import("node:test").TestContext} t @param {Record<string,string>} [files] */
async function composeCheckpoint(t, files) {
	const f = await composeRound(t, files);
	await f.write("compose", composeBody);
	const [nextCore, nextMail] = [...f.workers.values()].slice(-2);
	return { f, nextCore, nextMail };
}

for (const repeat of [false, true])
	test(`a current consumer pins its ${repeat ? "repeated" : "checkpoint"} input against both a repartition and a target edit`, async t => {
		const { f, nextCore: core, nextMail: mail } = await composeCheckpoint(t);
		let coreToken = core.token, mailToken = mail.token;
		if (repeat) {
			const engine = await f.report(core.id, coreToken, ".foundry/left.md", []);
			const host = await f.report(mail.id, mailToken, `${compose}/index.mjs`, ["compose"]);
			await f.write("compose", originalCompose); // Reproduce the failed baseline, not the latest checkpoint.
			coreToken = text(engine.reviews[0].nextToken, "core cursor");
			mailToken = text(host.reviews[0].nextToken, "mail cursor");
		}
		await f.report(core.id, coreToken, ".foundry/left.md", [work("adapter", "engine/adapter", ["compose"])]);
		const before = await f.status(), w = [...f.workers.values()].at(-1); assert.ok(w);
		const input = before.nodes.find(n => n.grain === "compose");
		assert.ok(input?.checked);
		assert.equal(input.state, repeat ? "repeated" : "qualified");
		assert.equal(before.nodes.find(n => n.grain === "adapter")?.inputs?.compose, input.checked);
		assert.equal(readFileSync(path.join(w.cwd, compose, "index.mjs"), "utf8"), repeat ? originalCompose : composeBody);
		await assert.rejects(f.report(mail.id, mailToken, `${compose}/index.mjs`, splitCompose()), /current assignment.*adapter/);
		assert.deepEqual(await f.status(), before);
		put(f.root, `${compose}/external`, "from target"); git(f.root, "add", compose); git(f.root, "commit", "-qm", "change the checked input");
		f.owner.turn("owner"); await f.owner.flush();
		const blocked = await f.status();
		assert.match(String(blocked.blocker), /current assignment.*adapter/);
		assert.deepEqual(blocked.products, before.products);
		assert.equal(blocked.qualified, null);
		assert.equal((await f.status(w.id)).nodes[0].token, w.token);
	});

test("a target edit supersedes an unused repeated output even before the first checkpoint", async t => {
	const f = await composeRound(t);
	await f.write("compose", originalCompose);
	const stalled = await f.status();
	assert.equal(stalled.checkpoint, null);
	assert.equal(stalled.nodes[0].state, "repeated");
	put(f.root, `${compose}/index.mjs`, composeBody); git(f.root, "commit", "-qam", "edit the repeated directory");
	f.owner.turn("owner"); await f.owner.flush();
	const moved = await f.status();
	assert.ok(moved.goal?.receipt, moved.blocker ?? "target edit was not assessed");
	assert.equal(moved.goal.receipt.exit, 1);
	assert.deepEqual(moved.nodes, []);
	assert.equal(moved.qualified, null);
	assert.equal(git(f.root, "show", `${moved.goal.receipt.commit}:${compose}/index.mjs`), composeBody);
});

test("a refused consumer releases its input, but not permission to retry the refused work", async t => {
	const { f, nextCore: core, nextMail: mail } = await composeCheckpoint(t);
	const adapter = work("adapter", "engine/adapter", ["compose"]);
	let callId = "";
	const scout = f.runtime(core.cwd, { execute: async (tool, args, id) => {
		if (tool !== "create_session" || !text(record(args.kickoff).prompt, "brief").includes("complete engine/adapter/")) return f.execute(tool, args, id);
		callId = id;
		return { resultType: "unconfirmed" };
	} });
	await scout.operation("observe", { run, token: core.token, outcome: "regenerate", reason: "Use the checked compose interface",
		evidence: [".foundry/left.md"], grains: [adapter, work("parser", "engine/parser")] }, core.id);
	await assert.rejects(f.report(mail.id, mail.token, `${compose}/index.mjs`, splitCompose()), /current assignment.*adapter/);
	scout.refusal({ type: "permission.completed", data: { toolCallId: callId, result: { kind: "denied-interactively-by-user" } } }, core.id);
	await f.report(mail.id, mail.token, ".foundry/right.md", []);
	await f.write("parser", composeBody);
	const before = await f.status(), [engine, host] = [...f.workers.values()].slice(-2);
	assert.equal(before.products?.length, 2);
	const denied = before.nodes.find(n => n.grain === "adapter");
	assert.match(String(denied?.reason), /permission refused/);
	assert.equal(denied?.inputs?.compose, text(before.outputs?.compose, "checkpoint input"));
	await assert.rejects(f.report(engine.id, engine.token, ".foundry/left.md", [adapter]), /assigned grain/);
	await f.report(engine.id, engine.token, ".foundry/left.md", []);
	await f.report(host.id, host.token, `${compose}/index.mjs`, splitCompose());
	const after = await f.status();
	assert.deepEqual(after.nodes.filter(n => n.state === "writing").map(n => n.grain), ["editor", "send"]);
	assert.deepEqual(after.nodes.find(n => n.grain === "adapter"), denied);
	assert.deepEqual(after.products, before.products);
	const db = openDatabase(f.root); t.after(() => db.close());
	assert.deepEqual(db.read(run)?.effects.filter(e => e.grain === "adapter").map(e => [e.callId, e.state]), [[callId, "refused"]]);
});

test("a repeated tree stays unmet and releases the parent for a different split on the same revision", async t => {
	const { f, nextCore: core, nextMail: mail } = await composeCheckpoint(t);
	const before = await f.status();
	const engine = await f.report(core.id, core.token, ".foundry/left.md", []);
	const host = await f.report(mail.id, mail.token, `${compose}/index.mjs`, ["compose"]);
	const writer = [...f.workers.values()].at(-1); assert.ok(writer);
	await f.write("compose", composeBody);
	const stalled = await f.status();
	assert.match(String(stalled.blocker), /reproduce a tree/);
	assert.deepEqual(stalled.products, before.products);
	assert.deepEqual(stalled.goal, before.goal);
	assert.equal(stalled.qualified, null);
	await f.report(core.id, text(engine.reviews[0].nextToken, "core cursor"), ".foundry/api.md", [work("parser", "engine/parser")]);
	await f.report(mail.id, text(host.reviews[0].nextToken, "mail cursor"), `${compose}/index.mjs`, splitCompose());
	assert.deepEqual((await f.status()).nodes.filter(n => n.state === "writing").map(n => n.grain).sort(), ["editor", "parser", "send"]);
	await assert.rejects(f.runtime(writer.cwd).operation("submit", { run, token: writer.token }, writer.id), /assignment/);
	await f.write("parser", composeBody); await f.write("editor", "export default text=>text;");
	await f.write("send", `export default async(text, send)=>{try {await send(text)} catch {return "outcome unknown"}}`);
	const done = await f.status();
	assert.ok(done.qualified, done.blocker ?? done.goal?.receipt?.output ?? "no final result");
	assert.equal(done.products?.length, 2);
	assert.deepEqual(done.products[0], before.products?.[0]);
	assert.equal(done.products[1].receipt?.commit, done.qualified);
	assert.equal(done.goal?.receipt?.commit, done.qualified);
});

const matrix = process.env.FOUNDRY_FACTORY_MATRIX === "1";
/** @param {string[]} events @returns {string[][]} */
function orders(events) {
	return events.length ? events.flatMap(e => orders(events.filter(other => other !== e)).map(rest => [e, ...rest])) : [[]];
}

for (const edit of ["input", "neighbor"])
	for (const steps of orders(["edit", "reopen", "deny", "submit"])) {
		if (!matrix && (edit !== "input" || steps.join() !== "edit,reopen,deny,submit")) continue;
		test(`factory matrix: ${edit} / ${steps.join("-")}`, async t => {
			const file = edit === "input" ? `${compose}/external` : "target-note";
			const { f, nextCore: core, nextMail: mail } = await composeCheckpoint(t, {
				[goalCheck]: `import {existsSync} from "node:fs"; process.exit(existsSync("${file}") && existsSync("engine/parser/index.mjs") ? 0 : 1);`
			});
			const before = await f.status(), db = openDatabase(f.root); t.after(() => db.close());
			let call = "", denied = false, tip = f.tip, submitted = false;
			/** @type {Host["execute"]} */
			const execute = async (tool, args, id) => {
				if (tool !== "create_session" || !text(record(args.kickoff).prompt, "brief").includes("complete engine/adapter/")) return f.execute(tool, args, id);
				assert.equal(call, "", "never send a second start, even after reopening");
				call = id;
				return { resultType: "unconfirmed" };
			};
			const reopen = () => f.runtime(core.cwd, { execute, recover: async e => ({
				resultType: e.callId === call && denied ? "denied" : "unconfirmed"
			}) });
			let scout = reopen();
			await scout.operation("observe", { run, token: core.token, outcome: "regenerate", reason: "Connect compose and parse mail",
				evidence: [".foundry/left.md"], grains: [work("adapter", "engine/adapter", ["compose"]), work("parser", "engine/parser")] }, core.id);
			await f.report(mail.id, mail.token, ".foundry/right.md", []);
			put(f.root, "only-staged", "not in the product"); git(f.root, "add", "only-staged");
			for (const step of steps) {
				if (step === "edit") {
					put(f.root, file, "external"); git(f.root, "add", file); git(f.root, "commit", "-qm", "move target", "--", file);
					tip = git(f.root, "rev-parse", "main");
				} else if (step === "deny") {
					denied = true;
					scout.refusal({ type: "permission.completed", data: { toolCallId: call, result: { kind: "denied-interactively-by-user" } } }, core.id);
					scout.turn(core.id); await scout.flush();
				} else if (step === "submit") {
					submitted = true;
					await f.write("parser", composeBody);
				} else {
					const held = await f.owner.operation("pause", { run }, "owner");
					scout.close(); scout = reopen();
					scout.turn(core.id); await scout.flush();
					assert.deepEqual((await f.status()).products, held.products);
					await f.runtime(f.root).operation("start", { source }, "owner");
				}
				f.owner.turn("owner"); await f.owner.flush();
				const s = await f.status();
				assert.equal(git(f.root, "rev-parse", "main"), tip);
				assert.equal(git(f.root, "diff", "--cached", "--name-only"), "only-staged");
				assert.deepEqual(s.products?.[0], before.products?.[0]);
				const attempts = db.read(run)?.effects.filter(e => e.grain === "adapter");
				assert.deepEqual(attempts?.map(e => [e.callId, e.state]), [[call, denied ? "refused" : "uncertain"]]);
				if (!denied || !submitted || tip === f.tip) assert.equal(s.qualified, null);
				if (!denied && edit === "input" && tip !== f.tip) assert.match(String(s.blocker), /current assignment.*adapter/);
			}
			// A move after an intermediate checkpoint may leave its original scouts to report stale reads.
			for (const r of (await f.status()).reviews.filter(r => r.state === "reading")) {
				const w = f.workers.get(text(r.worker, "scout")); assert.ok(w);
				await f.report(w.id, w.token, r.squad === "engine" ? ".foundry/left.md" : ".foundry/right.md", []);
			}
			const done = await f.status();
			assert.ok(done.qualified, done.blocker ?? "all necessary evidence arrived, but the factory did not finish");
			assert.equal(done.goal?.receipt?.commit, done.qualified);
			assert.equal(done.products?.at(-1)?.receipt?.commit, done.qualified);
			assert.equal(done.target, tip);
			assert.equal(git(f.root, "show", `${done.qualified}:${file}`), "external");
			assert.equal(git(f.root, "ls-tree", "--name-only", done.qualified, "--", "only-staged"), "");
		});
	}

for (const form of ["id", "definition", "replace", "rename"])
	for (const phase of ["stalled", "peer", "backtrack"])
		for (const restart of [false, true]) {
			if (!matrix && (form !== "id" || phase !== "backtrack" || !restart)) continue;
			test(`factory matrix: duplicate ${form} / ${phase} / ${restart ? "resume" : "turn"}`, async t => {
				const { f, nextCore: core, nextMail: mail } = await composeCheckpoint(t);
				const before = await f.status(), evidence = `${compose}/index.mjs`, task = work("compose", compose);
				const peer = await f.report(core.id, core.token, ".foundry/left.md", []);
				let report = await f.report(mail.id, mail.token, evidence, ["compose"]);
				const next = () => text(report.reviews.at(-1)?.nextToken, "current cursor");
				await f.write("compose", composeBody);
				if (phase === "backtrack") {
					report = await f.report(mail.id, next(), evidence, [{ ...task, task: "Try a different implementation of compose" }]);
					await f.write("compose", composeBody);
				}
				if (phase === "peer") await f.report(core.id, text(peer.reviews[0].nextToken, "peer cursor"), ".foundry/left.md", [work("parser", "engine/parser")]);
				if (restart) {
					await f.owner.operation("pause", { run }, "owner");
					await f.runtime(f.root).operation("start", { source }, "owner");
				}
				const workers = f.workers.size, old = await f.status(), token = next();
				await assert.rejects(f.report(mail.id, token, evidence, form === "id" ? ["compose"] : [{ ...task, id: form === "rename" ? "relabeled" : task.id }], form === "replace" ? ["compose"] : []),
					{ code: "no_progress" });
				assert.deepEqual(await f.status(), old);
				assert.equal(f.workers.size, workers);
				await f.report(mail.id, token, evidence, splitCompose());
				assert.deepEqual((await f.status()).nodes.filter(n => n.state === "writing" && n.directory.startsWith(compose)).map(n => n.grain), ["editor", "send"]);
				assert.deepEqual((await f.status()).products, before.products);
			});
		}

for (const changed of [false, true])
	test(`factory matrix: delayed ${changed ? "changed" : "identical"} prerequisite on the same revision`, async t => {
		const dep = "engine/interface", parser = work("parser", dep), adapter = work("adapter", "mail/adapter", ["parser"]);
		const f = replyFixture(t, {
			[`${dep}/index.mjs`]: originalCompose, "mail/adapter/index.mjs": originalCompose,
			".foundry/product.mjs": 'import "../mail/adapter/index.mjs";',
			[goalCheck]: `import p from "../${dep}/index.mjs";import a from "../mail/adapter/index.mjs";process.exit(p() && a() ? 0 : 1);`
		});
		await f.start();
		const [core, mail] = f.workers.values();
		const engine = await f.report(core.id, core.token, ".foundry/left.md", [parser]);
		const host = await f.report(mail.id, mail.token, ".foundry/right.md", [adapter]);
		await f.write("parser", originalCompose); await f.write("adapter", originalCompose);
		assert.match(String((await f.status()).blocker), /reproduce a tree/);
		const first = [...f.workers.values()].at(-1); assert.ok(first);
		await f.report(core.id, text(engine.reviews[0].nextToken, "current cursor"), ".foundry/left.md",
			[{ ...parser, task: "Implement the revised interface" }]);
		const pending = await f.report(mail.id, text(host.reviews[0].nextToken, "current cursor"), ".foundry/right.md", [adapter]);
		const workers = f.workers.size;
		await f.write("parser", changed ? composeBody : originalCompose);
		const s = await f.status(), n = s.nodes.find(n => n.grain === "adapter"); assert.ok(n);
		assert.equal(s.qualified, null);
		await assert.rejects(f.runtime(first.cwd).operation("submit", { run, token: first.token }, first.id), /assignment/);
		if (changed) {
			assert.equal(n.state, "writing");
			assert.equal(f.workers.size, workers + 1);
			await f.write("adapter", composeBody);
		} else {
			assert.equal(f.workers.size, workers);
			assert.equal(n.generation, undefined, "do not reserve a second attempt");
			assert.match(String(n.reason), /already reproduced/);
			assert.equal(s.checkpoint, null);
			await f.report(mail.id, text(pending.reviews.at(-1)?.nextToken, "current cursor"), ".foundry/right.md",
				[{ ...adapter, task: "Use the corrected interface" }], ["adapter"]);
			assert.equal((await f.status()).nodes.find(n => n.grain === "adapter")?.state, "writing");
		}
		if (changed) assert.ok((await f.status()).qualified);
	});

for (const resolve of ["refusal", "target"])
	test(`factory matrix: a prepared call under an input conflict / ${resolve}`, async t => {
		const { f, nextCore: core, nextMail: mail } = await composeCheckpoint(t);
		const before = await f.status();
		const scout = f.runtime(core.cwd, { execute: async (...args) => args[0] === "create_session" &&
			text(record(args[1].kickoff).prompt, "brief").includes("complete engine/adapter/") ?
			{ resultType: "failure", error: "This session management tool is disabled" } : f.execute(...args) });
		const reserved = await scout.operation("observe", { run, token: core.token, outcome: "regenerate", reason: "Consume the interface",
			evidence: [".foundry/left.md"], grains: [work("adapter", "engine/adapter", ["compose"])] }, core.id);
		const [call] = reserved.prepared; assert.ok(call);
		await f.report(mail.id, mail.token, ".foundry/right.md", []);
		put(f.root, `${compose}/external`, "concurrent"); git(f.root, "add", compose); git(f.root, "commit", "-qm", "move target");
		f.owner.turn("owner"); await f.owner.flush();
		const held = await f.status();
		assert.match(String(held.blocker), /current assignment.*adapter/);
		if (resolve === "target") {
			git(f.root, "revert", "--no-edit", "HEAD"); // Only this disposable repository.
			f.owner.turn("owner"); await f.owner.flush();
			assert.equal((await f.status()).blocker, undefined);
		}
		assert.deepEqual((await f.status(core.id)).prepared, [call], "the existing exact assignment is still deliverable");
		await scout.pre(call.tool, call.arguments, core.id, "only-native-call");
		scout.post("only-native-call", { resultType: "denied" }, core.id); await scout.flush();
		const done = await f.status();
		assert.equal(done.target, git(f.root, "rev-parse", "main"));
		assert.deepEqual(done.products?.[0], before.products?.[0]);
		assert.equal(done.qualified, null);
		assert.equal(done.nodes.find(n => n.grain === "adapter")?.state, "blocked");
		assert.deepEqual((await f.status(core.id)).prepared, []);
	});

for (const cap of [undefined, 2])
	for (const firstScout of ["engine", "mail"])
		for (const firstWriter of ["editor", "recover"])
			for (const receipt of ["send", "joined product", "final goal"]) {
				if (!matrix && (cap !== 2 || firstScout !== "mail" || firstWriter !== "recover" || receipt !== "final goal")) continue;
				test(`factory matrix: fan-in ${cap ?? "uncapped"} / ${firstScout}-${firstWriter} / lost ${receipt}`, async t => {
					const f = replyFixture(t, { [source]: JSON.stringify({ ...areaPolicy(), ...(cap ? { limits: { workers: cap } } : {}) }) });
					await f.start();
					const [core, mail] = f.workers.values();
					const engine = () => f.report(core.id, core.token, ".foundry/left.md", [work("recover", "engine/recovery")]);
					const host = () => f.report(mail.id, mail.token, ".foundry/right.md", [work("editor", `${compose}/editor`)]);
					if (firstScout === "engine") await engine();
					const report = await host();
					if (firstScout === "mail") await engine();
					const wire = () => f.report(mail.id, text(report.reviews[0].nextToken, "mail cursor"), ".foundry/api.md",
						[work("send", `${compose}/send`, ["recover", "editor"])]);
					await wire(); await wire(); // The response can arrive twice.
					const initial = await f.status(), writers = initial.nodes.filter(n => n.state === "writing");
					assert.deepEqual(writers.map(n => n.grain).sort(), ["editor", "recover"]);
					const first = writers.find(n => n.grain === firstWriter), w = f.workers.get(text(first?.worker, "writer")); assert.ok(w);
					await f.write(firstWriter, 'export default ()=>null;');
					const repair = (await f.status(w.id)).nodes[0];
					assert.equal(repair.repairs, 1); assert.equal(repair.generation, first?.generation);
					await assert.rejects(f.runtime(w.cwd).operation("submit", { run, token: w.token }, w.id), /assignment/);
					for (const id of [firstWriter, firstWriter === "editor" ? "recover" : "editor"]) {
						assert.equal((await f.status()).nodes.find(n => n.grain === "send")?.state, "waiting");
						await f.write(id, id === "editor" ? "export default text=>text;" : 'export default ()=>"outcome unknown";');
					}
					const ready = await f.status(), send = ready.nodes.find(n => n.grain === "send");
					assert.deepEqual(send?.inputs, Object.fromEntries(ready.nodes.filter(n => n.checked).map(n => [n.grain, n.checked])));
					let moved = false;
					await f.write("send", `import edit from "../editor/index.mjs";import recover from "../../../engine/recovery/index.mjs";
						export default async(text,send)=>{try {await send(edit(text))}catch{return recover()}}`, { execute: async (...args) => {
						const result = await f.execute(...args);
						if (moved || !String(args[1].description).startsWith(`Check ${receipt} at `)) return result;
						moved = true;
						put(f.root, "neighbor.txt", "new target"); git(f.root, "commit", "-qam", "move before native reply");
						f.owner.turn("owner"); await f.owner.flush();
						return { resultType: "unconfirmed" }; // The independent runner already wrote its receipt.
					} });
					const done = await f.status();
					assert.ok(moved);
					assert.ok(done.qualified, done.blocker ?? "fan-in did not finish");
					assert.equal(done.target, git(f.root, "rev-parse", "main"));
					assert.equal(done.goal?.receipt?.commit, done.qualified);
					assert.equal(done.products?.at(-1)?.receipt?.commit, done.qualified);
					assert.equal(git(f.root, "show", `${done.qualified}:neighbor.txt`), "new target");
					assert.equal(f.workers.size, 5);
					assert.equal(f.checks.filter(c => c.startsWith("Check send at ")).length, 1);
				});
			}

for (const crash of ["none", "before", "after"])
	test(`factory matrix: two writer processes / exit ${crash} receipt`, async t => {
		const f = fixture(t, goal, goalFiles);
		await f.start(); await f.observe("worker-1", "left"); await f.observe("worker-2", "right");
		const gate = mkdtempSync(path.join(tmpdir(), "foundry-rendezvous-"));
		t.after(() => rmSync(gate, { recursive: true, force: true }));
		const child = `import {createRuntime} from ${JSON.stringify(new URL("./runtime.mjs", import.meta.url).href)};
			import {execFileSync} from "node:child_process";import {writeFileSync,existsSync} from "node:fs";import {setTimeout as wait} from "node:timers/promises";
			const [cwd,worker,token,side,gate,crash,run]=process.argv.slice(1);
			const runtime=createRuntime(cwd,{mode:async()=>"interactive",permissionBlocker:async()=>null,execute:async(tool,args)=>{
				if(tool!=="bash") throw Error("Unexpected native route "+tool);
				const unit=args.description.startsWith("Check "+side+" at ");
				if(unit){
					writeFileSync(gate+"/"+side,"issued",{flag:"wx"});
					const end=Date.now()+15000;
					while(!existsSync(gate+"/left")||!existsSync(gate+"/right")){
						if(Date.now()>end) throw Error("Both component checks must be issued together");await wait(10);
					}
					if(side==="left" && crash==="before") process.exit(86);
				}
				execFileSync("/bin/sh",["-c",args.command]);
				if(unit && side==="left" && crash==="after") process.exit(86);
				return {resultType:"success"};
			}});
			await runtime.operation("submit",{run,token},worker);runtime.close();`;
		await Promise.all((await f.status()).nodes.map(async n => {
			const w = f.workers.get(text(n.worker, "writer")); assert.ok(w);
			put(w.cwd, `${n.directory}/index.mjs`, `export default ${n.grain === "left" ? 1 : 2};`);
			const processResult = promisify(execFile)(process.execPath, ["--input-type=module", "-e", child,
				w.cwd, w.id, w.token, n.grain, gate, crash, run], { timeout: 30000 });
			if (n.grain === "left" && crash !== "none") await assert.rejects(processResult, { code: 86 });
			else await processResult;
		}));
		const reopened = f.runtime(f.root);
		reopened.turn("owner"); await reopened.flush();
		if (crash === "before") await reopened.operation("pause", { run }, "owner");
		const s = await reopened.operation("start", { source }, "owner"), db = openDatabase(f.root); t.after(() => db.close());
		const effects = db.read(run)?.effects; assert.ok(effects);
		assert.ok(existsSync(path.join(gate, "left")) && existsSync(path.join(gate, "right")));
		assert.deepEqual(effects.filter(e => e.kind === "component").map(e => e.grain).sort(), ["left", "right"]);
		assert.equal(effects.find(e => e.grain === "right" && e.kind === "component")?.receipt?.exit, 0);
		assert.equal(effects.filter(e => e.kind === "product").length, crash === "before" ? 0 : 1);
		if (crash === "before") {
			const lost = effects.find(e => e.grain === "left" && e.kind === "component"); assert.ok(lost);
			assert.equal(lost.state, "issued"); assert.equal(lost.receipt, undefined);
			assert.equal(s.checkpoint, null); assert.equal(s.qualified, null);
		} else {
			assert.ok(s.qualified, s.blocker ?? "lost a durable receipt");
			assert.equal(s.goal?.receipt?.commit, s.qualified);
			assert.equal(s.products?.[0].receipt?.commit, s.qualified);
		}
		assert.equal(git(f.root, "rev-parse", "main"), f.tip);
	});

test("a graph edit is atomic, charter-limited, and cannot rewrite issued work or strand a dependent", async t => {
	const f = replyFixture(t);
	await f.start();
	const [core, mail] = f.workers.values(), reading = ".foundry/left.md", host = ".foundry/right.md";
	const live = work("recover", "engine/recovery"), pending = work("abi", "engine/bindings", ["recover"]);
	const r = await f.report(core.id, core.token, reading, [live, pending]);
	const token = text(r.reviews[0].nextToken, "follow-up token");
	await f.report(mail.id, mail.token, host, [work("wire", "mail/wire", ["abi"])]);
	const before = await f.status();
	for (const [proposals, replace, reason] of /** @type {Array<[typeof live[],string[],RegExp]>} */ ([
		[[work("escape", "mail/other")], [], /outside/],
		[[{ ...work("exec", "engine/x"), check: "neighbor.txt" }], [], /component check/],
		[[work("alias", "engine/Bindings/next")], [], /disjoint/],
		[[work("cycle", "engine/c", ["abi"]), { ...pending, needs: ["cycle"] }], ["abi"], /cycle/],
		[[work("new", "engine/new")], ["abi"], /Unknown required output: abi/],
		[[work("new", "engine/new")], ["recover"], /never reserved/],
		[[work("new", "engine/new")], ["wire"], /Not your grain/],
		[[work("new", "engine/new", ["future"])], [], /Unknown required output: future/]
	])) await assert.rejects(f.report(core.id, token, reading, proposals, replace), reason);
	assert.deepEqual(await f.status(), before);
	await assert.rejects(f.report(core.id, token, "neighbor.txt", [work("new", "engine/new")]), /outside this charter/);
	await assert.rejects(f.report(mail.id, token, host, []), /bound squad/);
	await assert.rejects(f.report(core.id, core.token, reading, [pending]), /immutable/);
	assert.equal(f.workers.size, 3);
});

test("the product evaluator can attribute a bounded repair to a discovered directory after reload", async t => {
	const dir = "mail/delivery";
	const f = replyFixture(t, {
		[goalCheck]: `import {existsSync} from "node:fs";process.exit(existsSync("${dir}/index.mjs")?0:1);`,
		".foundry/product.mjs": `import deliver from "../${dir}/index.mjs";if(deliver()!=="sent"){
			const [id]=Object.entries(JSON.parse(process.env.FOUNDRY_OUTPUTS)).find(([,dir])=>dir==="${dir}");
			console.log("FOUNDRY_REPAIR="+id);process.exit(1);}`
	});
	await f.start();
	const [core, mail] = f.workers.values();
	await f.report(core.id, core.token, ".foundry/left.md", [], []);
	await f.report(mail.id, mail.token, ".foundry/right.md", [work("chosen-by-scout", dir)]);
	const before = await f.owner.operation("pause", { run }, "owner");
	const resumed = await f.runtime(f.root).operation("start", { source }, "owner");
	assert.deepEqual(resumed.nodes, before.nodes);
	await f.write("chosen-by-scout", 'export default ()=>"not sent";');
	const repair = await f.status();
	assert.equal(repair.nodes[0].state, "writing");
	assert.equal(repair.nodes[0].repairs, 1);
	assert.equal(repair.nodes[0].worker, before.nodes[0].worker);
	assert.equal(repair.qualified, null);
	await f.write("chosen-by-scout", 'export default ()=>"sent";');
	assert.ok((await f.status()).qualified);
	assert.equal(f.workers.size, 3);
});

test("area contracts conserve interfaces and check implementations, not a catalog of tasks", async t => {
	const f = replyFixture(t);
	const original = areaPolicy();
	for (const [invalid, error] of /** @type {Array<[object,RegExp]>} */ ([
		[{ ...original, seed: ["seed"] }, /Unsupported field/],
		[{ ...original, grains: [] }, /Unsupported field/],
		[{ ...original, goalCheck: undefined }, /final goal/],
		[{ ...original, squads: original.squads.map(s => ({ ...s, areas: ["mail"] })) }, /disjoint/],
		[{ ...original, squads: [{ ...original.squads[0], checks: ["engine/test.mjs"] }] }, /overlap/]
	])) {
		put(f.root, source, JSON.stringify(invalid)); git(f.root, "commit", "-qam", "invalid contract");
		assert.throws(() => readPolicy(f.root, source), error);
	}
	put(f.root, source, JSON.stringify(original)); git(f.root, "commit", "-qam", "restore contract");
	await f.start();
	const [core, mail] = f.workers.values();
	put(f.root, unitCheck, "process.exit(0)"); git(f.root, "commit", "-qam", "replace permitted check");
	await f.report(core.id, core.token, ".foundry/left.md", [work("recover", "engine/recovery")]);
	const stale = await f.report(mail.id, mail.token, ".foundry/right.md", []);
	assert.equal(stale.reviews[0].state, "blocked");
	assert.match(String((await f.status()).blocker), /conserved contract changed/);
	assert.equal(f.workers.size, 2);
});

/** @param {ReturnType<typeof fixture>} f */
async function firstGoalWriter(f) {
	await f.observe("worker-1", "left");
	await f.observe("worker-2", "right", []);
	return "worker-3";
}

test("one goal activation checks a milestone, dispatches independent work on that tree, and stops only at the final result", async t => {
	const f = fixture(t, goal, goalFiles);
	let confirmations = 0;
	const owner = f.runtime(f.root, { confirm: async () => { confirmations++; return true; } });
	const start = await owner.operation("start", { source }, "owner");
	assert.equal(start.qualified, null);
	assert.match(String(start.goal?.receipt?.output), /Left does not contribute one/);
	assert.equal(f.workers.size, 2, "both charters can inspect the initial goal gap");
	await f.submit(await firstGoalWriter(f));
	const checkpoint = await f.status();
	assert.equal(checkpoint.qualified, null, "a passing product check is not goal acceptance");
	assert.ok(checkpoint.checkpoint);
	assert.equal(checkpoint.products?.[0].receipt?.exit, 0);
	assert.equal(checkpoint.goal?.receipt?.commit, checkpoint.checkpoint);
	assert.equal(checkpoint.goal.receipt.exit, 1);
	for (const scout of [...f.workers.values()].slice(3)) {
		assert.equal(git(scout.cwd, "rev-parse", "HEAD"), checkpoint.checkpoint);
		assert.match(scout.prompt, /Left is ready; right does not contribute two/);
	}
	await f.observe("worker-4", "left", []);
	await f.observe("worker-5", "right");
	const writer = f.workers.get("worker-6");
	assert.ok(writer);
	assert.equal(readFileSync(path.join(writer.cwd, "lib/left/index.mjs"), "utf8"), "export default 1;\n");
	await f.submit(writer.id);
	const done = await f.status();
	assert.equal(done.products?.length, 2);
	assert.equal(done.products?.[0].commit, checkpoint.checkpoint);
	assert.equal(done.goal?.receipt?.commit, done.qualified);
	assert.equal(done.products?.[1].receipt?.commit, done.qualified);
	assert.match(String(done.goal?.receipt?.output), /Observed the joined result: 3/);
	assert.equal(done.active, false);
	const checks = f.checks.length;
	owner.turn("owner");
	await owner.flush();
	assert.equal((await owner.operation("start", { source }, "owner")).qualified, done.qualified);
	assert.equal(f.checks.length, checks);
	assert.equal(f.workers.size, 6);
	assert.equal(confirmations, 1);
	assert.equal(git(f.root, "rev-parse", "main"), f.tip);
});

test("an already-good goal baseline passes both exact checks without staffing anyone", async t => {
	const f = fixture(t, goal, { ...goalFiles, "lib/left/index.mjs": "export default 1;", "lib/right/index.mjs": "export default 2;" });
	const done = await f.start();
	assert.equal(done.qualified, f.tip);
	assert.equal(done.products?.[0].receipt?.commit, f.tip);
	assert.equal(done.goal?.receipt?.commit, f.tip);
	assert.equal(done.active, false);
	assert.equal(f.workers.size, 0);
	assert.equal(f.checks.length, 2);
});

test("if an already-good baseline moves during its milestone check, both gates must pass on the new tip", async t => {
	const f = fixture(t, goal, { ...goalFiles, "lib/left/index.mjs": "export default 1;", "lib/right/index.mjs": "export default 2;" });
	let moved = false;
	const owner = f.runtime(f.root, { execute: async (...args) => {
		const result = await f.execute(...args);
		if (!moved && String(args[1].description).startsWith("Check joined product")) {
			moved = true;
			put(f.root, "neighbor.txt", "a newer good tip\n");
			git(f.root, "commit", "-qam", "new baseline");
		}
		return result;
	} });
	const done = await owner.operation("start", { source }, "owner");
	assert.notEqual(done.qualified, f.tip);
	assert.equal(done.qualified, git(f.root, "rev-parse", "main"));
	assert.equal(done.products?.[0].receipt?.commit, done.qualified);
	assert.equal(done.goal?.receipt?.commit, done.qualified);
	assert.equal(done.active, false);
	assert.equal(f.workers.size, 0);
});

test("an unmet baseline admits chartered work; an inconclusive/denied call cannot staff writers or be retried on resume", async t => {
	const unseeded = fixture(t, p => { goal(p); p.limits = { workers: 1 }; }, goalFiles);
	await unseeded.start();
	assert.equal(unseeded.workers.size, 1);
	assert.match(String(unseeded.workers.get("worker-1")?.prompt), /Left does not contribute one/);
	await unseeded.observe("worker-1", "left", []);
	await unseeded.observe("worker-2", "right", []);
	assert.match(String((await unseeded.status()).blocker), /No actionable grain/);
	assert.equal(unseeded.checks.length, 1);

	for (const result of ["denied", "unconfirmed", "evaluator-error"]) {
		const f = fixture(t, goal, { ...goalFiles, [goalCheck]: 'console.error("backend error"); process.exit(3);' });
		let calls = 0;
		const owner = f.runtime(f.root, { execute: async (...args) => {
			calls++;
			return result === "evaluator-error" ? f.execute(...args) : { resultType: result };
		} });
		const s = await owner.operation("start", { source }, "owner");
		assert.equal(s.qualified, null);
		if (result === "unconfirmed") assert.equal(s.pending[0].state, "uncertain");
		else assert.match(String(s.blocker), result === "denied" ? /permission refused/ : /exit 3.*backend error/s);
		await owner.operation("pause", { run }, "owner");
		await owner.operation("start", { source }, "owner");
		assert.equal(calls, 1, "resume cannot provide a missing receipt or override a native refusal");
		assert.equal(f.workers.size, 0);
	}
});

test("a denied first goal writer releases its slot for the other charter without reissuing the refusal", async t => {
	const f = fixture(t, p => { goal(p); p.limits = { workers: 1 }; }, { ...goalFiles,
		".foundry/product.mjs": 'import n from "../lib/right/index.mjs"; if (n !== 2) throw Error("wrong contribution");' });
	await f.start();
	const left = f.workers.get("worker-1"); assert.ok(left);
	const scout = f.runtime(left.cwd, { execute: async (...args) =>
		String(record(args[1].kickoff).prompt).includes("Generate the complete lib/left/") ? { resultType: "denied" } : f.execute(...args) });
	await scout.operation("observe", { run, token: left.token, outcome: "regenerate", grains: ["left"],
		evidence: [".foundry/left.md"], reason: "Left has no export" }, left.id);
	const denied = await f.status();
	assert.equal(denied.nodes.find(n => n.grain === "left")?.state, "blocked");
	assert.equal(denied.blocker, undefined);
	assert.equal(denied.reviews.find(r => r.squad === "right")?.worker, "worker-2");
	await f.observe("worker-2", "right"); await f.submit("worker-3");
	const checked = await f.status();
	assert.ok(checked.checkpoint);
	assert.equal(checked.qualified, null);
	assert.equal(git(f.root, "show", `${checked.checkpoint}:lib/right/index.mjs`), "export default 2;");
	await f.observe("worker-4", "left"); await f.observe("worker-5", "right", []);
	assert.match(String((await f.status()).blocker), /permission refused/);
	assert.equal([...f.workers.values()].filter(w => w.prompt.includes("Generate the complete lib/")).length, 1);
});

for (const stage of ["baseline", "checkpoint", "moved target"])
test(`only a confirmed resume retries missing external evidence: ${stage}`, async t => {
	const dir = mkdtempSync(path.join(tmpdir(), "foundry-observation-")), witness = path.join(dir, "observation");
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const f = fixture(t, goal, { ...goalFiles, ...(stage === "baseline" ? { "lib/left/index.mjs": "export default 1;" } : {}),
		[goalCheck]: `import { existsSync, readFileSync } from "node:fs";
		if (!existsSync("lib/left/index.mjs")) process.exit(1);
		if (!existsSync(${JSON.stringify(witness)})) { console.log("Awaiting external observation"); process.exit(2); }
		if ((await import("../lib/left/index.mjs")).default !== Number(readFileSync(${JSON.stringify(witness)}, "utf8"))) process.exit(1);` });
	await f.start();
	if (stage !== "baseline") await f.submit(await firstGoalWriter(f));
	const held = await f.status(), checkpoint = stage === "baseline" ? f.tip : text(held.checkpoint, "checkpoint");
	assert.equal(held.qualified, null);
	assert.equal(held.goal?.receipt?.exit, 2);
	assert.equal(held.goal.receipt.commit, checkpoint);
	const db = openDatabase(f.root); t.after(() => db.close());
	const before = db.read(run);
	const original = before?.effects.find(e => e.id === before.goal?.check);
	assert.ok(original?.receipt);
	const calls = f.checks.length;
	put(dir, "observation", "1");
	if (stage === "moved target") {
		put(f.root, "neighbor.txt", "a newer target\n"); git(f.root, "commit", "-qam", "move target during hold");
	}
	const owner = f.runtime(f.root);
	owner.turn("owner"); await owner.flush();
	assert.deepEqual((await owner.operation("start", { source }, "owner")).goal, held.goal);
	await owner.operation("pause", { run }, "owner");
	await assert.rejects(f.runtime(f.root, { confirm: async () => false }).operation("start", { source }, "owner"), /not activated/);
	assert.equal(f.checks.length, calls);
	const done = await owner.operation("start", { source }, "owner");
	if (stage === "moved target") {
		assert.notEqual(done.qualified, checkpoint);
		assert.equal(git(f.root, "show", `${done.qualified}:neighbor.txt`), "a newer target");
		assert.equal(done.target, git(f.root, "rev-parse", "main"));
	} else assert.equal(done.qualified, checkpoint);
	assert.equal(done.goal?.receipt?.exit, 0);
	assert.equal(done.goal.receipt.commit, done.qualified);
	assert.deepEqual(done.products?.slice(0, held.products?.length), held.products);
	assert.deepEqual(done.nodes, held.nodes);
	assert.equal(f.workers.size, stage === "baseline" ? 0 : 3);
	assert.equal(f.checks.length, calls + (stage === "checkpoint" ? 1 : 2));
	assert.deepEqual(db.read(run)?.effects.find(e => e.id === original.id), original);
});

for (const repeat of [false, true])
	test(`an unmet goal reports ${repeat ? "a repeated tree" : "a contract decision"} and does not retry the same work`, async t => {
		const f = fixture(t, goal, goalFiles);
		await f.start(); await f.submit(await firstGoalWriter(f));
		await f.observe("worker-4", "left", repeat ? ["left"] : []);
		const right = f.workers.get("worker-5"); assert.ok(right);
		await f.runtime(right.cwd).operation("observe", { run, token: right.token, outcome: "needs-decision",
			reason: "Which right-hand value is authorized?", evidence: [goalCheck, ".foundry/right.md"], grains: [] }, right.id);
		if (repeat) {
			const writer = f.workers.get("worker-6"); assert.ok(writer);
			const revision = /^Reviewed input revision: ([a-f0-9]+)$/m.exec(writer.prompt)?.[1];
			assert.ok(revision);
			assert.equal(revision, (await f.status()).checkpoint);
			assert.notEqual(revision, f.tip);
			assert.equal(git(writer.cwd, "show", `${revision}:lib/left/index.mjs`), "export default 1;");
			assert.equal(git(writer.cwd, "rev-list", "--count", "HEAD"), "1");
			assert.equal(existsSync(path.join(writer.cwd, "lib/left")), false);
			await f.submit(writer.id);
		}
		const s = await f.status();
		assert.equal(s.qualified, null);
		assert.ok(s.checkpoint);
		assert.match(String(s.blocker), /right does not contribute two/);
		assert.match(String(s.blocker), repeat ? /reproduce a tree/ : /No actionable grain/);
		assert.match(String(s.blocker), /Which right-hand value/);
		const checks = f.checks.length, workers = f.workers.size;
		const restarted = f.runtime(f.root);
		restarted.turn("owner"); await restarted.flush();
		assert.equal((await f.status()).blocker, s.blocker);
		assert.equal(f.workers.size, workers);
		assert.equal(f.checks.length, checks);
	});

test("a target move during a passing goal check cannot qualify the obsolete commit", async t => {
	const f = fixture(t, goal, { ...goalFiles, [goalCheck]: `import {readFileSync,existsSync} from "node:fs";
		if (!existsSync("lib/left/index.mjs") || readFileSync("neighbor.txt","utf8").includes("regressed")) { console.log("goal unmet"); process.exit(1) }` });
	await f.start();
	/** @type {string|null|undefined} */ let stale;
	await f.submit(await firstGoalWriter(f), 1, { execute: async (...args) => {
		const result = await f.execute(...args);
		if (!stale && String(args[1].description).startsWith("Check final goal")) {
			stale = (await f.status()).checkpoint;
			put(f.root, "neighbor.txt", "regressed\n");
			git(f.root, "commit", "-qam", "concurrent");
		}
		return result;
	} });
	const s = await f.status();
	assert.ok(stale);
	assert.notEqual(s.checkpoint, stale);
	assert.equal(s.qualified, null);
	assert.equal(s.goal?.receipt?.exit, 1);
	assert.equal(s.goal.receipt.commit, s.checkpoint);
	assert.equal(s.target, git(f.root, "rev-parse", "main"));
});

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
		assert.doesNotMatch(first.prompt, /^Reviewed input revision:/m);
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

test("capture includes ignored files and raw executable bytes but never silently drops a name", async t => {
	const f = fixture(t, p => { p.seed = ["left"]; }, { ".gitignore": "*.payload\n", ".gitattributes": "*.payload text eol=lf\n",
		".foundry/product.mjs": 'import "../lib/left/index.mjs";' });
	await f.start();
	const [w] = f.workers.values(), dir = "lib/left";
	put(w.cwd, "only-staged", "leave in the writer's index"); git(w.cwd, "add", "only-staged");
	const staged = git(w.cwd, "write-tree");
	const filename = `${dir}/nested/raw.payload`, bytes = "first\r\nsecond\r\n";
	put(w.cwd, filename, bytes); chmodSync(path.join(w.cwd, filename), 0o755);
	git(w.cwd, "config", "core.protectNTFS", "true");
	put(w.cwd, `${dir}/git~1/file`, "Git refuses this directory in an index");
	await assert.rejects(f.submit(w.id), /Git cannot index git~1\/file/);
	assert.equal((await f.status(w.id)).nodes[0].token, w.token);
	assert.deepEqual(f.checks, []);
	rmSync(path.join(w.cwd, dir, "git~1/file")); // Empty directories are not part of a Git tree.
	const done = await f.submit(w.id);
	const commit = text((await f.status()).qualified, "qualified product");
	assert.equal(done.nodes[0].state, "qualified");
	assert.match(git(f.root, "ls-tree", commit, "--", filename), /^100755 blob /);
	assert.equal(git(f.root, "rev-parse", `${commit}:${filename}`), git(w.cwd, "hash-object", "--no-filters", filename));
	assert.equal(git(w.cwd, "write-tree"), staged);
	assert.equal(git(f.root, "ls-tree", commit, "--", "only-staged"), "");
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
	await assert.rejects(r.pre(prepared.tool, { ...prepared.arguments, base_branch: "main" }, "owner", "changed"), /prepared/i);
	await r.pre(prepared.tool, prepared.arguments, "owner", "native-1");
	await assert.rejects(r.pre(prepared.tool, prepared.arguments, "owner", "duplicate"), /prepared/i);
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
	await assert.rejects(r.pre(prepared.tool, prepared.arguments, "owner", "again"), /prepared/i);
	r.turn("owner");
	await r.flush();
	assert.deepEqual((await f.status()).reviews.map(x => [x.squad, x.state]), [["left", "blocked"], ["right", "reading"]]);
});

test("after restart only an evidenced denial of the original prepared call is final", async t => {
	const f = fixture(t, p => { p.seed = ["left"]; });
	const r = f.runtime(f.root, { execute: async () => ({ resultType: "failure", error: "This session management tool is disabled" }) });
	const [p] = (await r.operation("start", { source }, "owner")).prepared;
	await r.pre(p.tool, p.arguments, "owner", "original");
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

test("a matching failure without a runner cannot spend a writer repair", async t => {
	const f = fixture(t, p => { p.seed = ["left"]; });
	await f.start();
	await f.submit("worker-1", 1, { execute: async () => ({ resultType: "unconfirmed" }) });
	const db = openDatabase(f.root); t.after(() => db.close());
	for (const started of [false, true]) {
		const snapshot = db.read(run); assert.ok(snapshot);
		const e = snapshot.effects.find(e => e.id === snapshot.nodes.left.check); assert.ok(e?.commit && e.check);
		e.state = "done"; e.runnerStarted = started;
		e.receipt = { commit: e.commit, check: e.check, exit: 1, output: "component failed" };
		advance(f.root, snapshot, "owner", false);
		assert.equal(snapshot.nodes.left.repairs, started ? 1 : 0);
		assert.equal(snapshot.nodes.left.state, started ? "writing" : "checking");
	}
});

test("component and product checks run under Node when the extension host is not a Node executable", async t => {
	const f = fixture(t, p => { p.seed = ["left"]; }, { ".foundry/product.mjs": 'import "../lib/left/index.mjs";' });
	await f.start();
	const host = process.execPath;
	try {
		process.execPath = path.join(f.root, "not-a-node-interpreter");
		await f.submit("worker-1");
	} finally {
		process.execPath = host;
	}
	assert.ok((await f.status()).qualified);
	assert.equal(f.checks.length, 2);
});

test("a terminal launcher failure before the check starts blocks without retrying or charging a repair", async t => {
	const f = fixture(t, p => { p.seed = ["left"]; });
	await f.start();
	let calls = 0;
	await f.submit("worker-1", 1, { execute: async () => {
		calls++;
		return { resultType: "success", toolTelemetry: { properties: {
			executionMode: "sync", shell_error_category: "command_nonzero_exit"
		}, metrics: { exit_code: 1 } } };
	} });
	f.owner.turn("owner");
	await f.owner.flush();
	const s = await f.status();
	assert.equal(s.nodes[0].state, "blocked");
	assert.match(String(s.nodes[0].reason), /launcher exited 1 before the evaluator started/);
	assert.equal(s.nodes[0].receipt, undefined);
	assert.equal(s.nodes[0].repairs, 0);
	assert.equal(s.qualified, null);
	assert.equal(calls, 1);
});

test("after reload a confirmed launcher exit frees the slot for an independent writer", async t => {
	const f = fixture(t, p => { p.limits = { workers: 1 }; });
	await f.start();
	const [w] = f.workers.values();
	let launches = 0;
	await f.submit(w.id, 1, { execute: async () => { launches++; throw Error("shell reply lost"); } });
	assert.deepEqual((await f.status()).nodes.map(n => n.state), ["checking", "waiting"]);
	const resumed = f.runtime(w.cwd, { recover: e => {
		const call = { toolCallId: e.callId, turnId: "t" };
		const start = { type: "tool.execution_start", id: "s", data: { ...call, toolName: "bash", arguments: e.args } };
		const end = { type: "tool.execution_complete", id: "e", data: { ...call, success: true,
			toolTelemetry: { properties: { executionMode: "sync", shell_error_category: "command_nonzero_exit" }, metrics: { exit_code: 127 } } } };
		return recover(async () => ({ cursor: "c", cursorStatus: "ok", hasMore: false, events: [start, end] }), e);
	} });
	resumed.turn(w.id); await resumed.flush();
	const [left, right] = (await f.status()).nodes;
	assert.equal(left.state, "blocked");
	assert.match(String(left.reason), /launcher exited 127 before the evaluator started/);
	assert.equal(left.receipt, undefined);
	assert.equal(left.repairs, 0);
	assert.equal(launches, 1);
	assert.equal(f.checks.length, 0, "do not replay the lost check");
	assert.ok(right.worker);
	await f.submit(right.worker);
	const s = await f.status();
	assert.equal(s.nodes[1].state, "published");
	assert.equal(s.qualified, null);
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
				await worker.pre(tool, args, w.id, callId);
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
	const f = fixture(t, addIndependent, extraCheck);
	let active = 0, peak = 0, total = 0, offers = 0;
	const owner = f.runtime(f.root, {
		confirm: async msg => { assert.match(msg, /no worker cap/); return true; },
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
	assert.equal((await owner.operation("start", { source }, "owner")).limit, null);
	await f.owner.flush();
	assert.equal(peak, 3);
	assert.equal(total, 3);
	assert.equal(offers, 0);
	assert.equal(f.workers.size, 3);
});

/** @param {FixturePolicy} p */
function addIndependent(p) {
	p.grains.push({ ...p.grains[0], id: "extra", directory: "lib/extra", check: ".foundry/extra.mjs" });
	p.seed?.push("extra");
	p.squads[0].grains.push("extra");
}
const extraCheck = { ".foundry/extra.mjs": 'import "../lib/extra/index.mjs";' };

for (const receipt of ["live", "recovered"])
	test(`a ${receipt} refusal after switching to plan mode does not start the next writer`, async t => {
		const f = fixture(t, p => { p.limits = { workers: 1 }; });
		let mode = "autopilot";
		/** @type {string[]} */ const starts = [];
		const refuse = async () => {
			await new Promise(resolve => setImmediate(resolve));
			mode = "plan";
			return { resultType: "denied" };
		};
		/** @type {Host["execute"]} */
		const execute = async (...args) => {
			if (args[0] === "create_session") {
				const grain = text(args[1].name, "name").split(" ")[0];
				starts.push(grain);
				if (grain === "left") return receipt === "live" ? refuse() : { resultType: "unconfirmed" };
			}
			return f.execute(...args);
		};
		const host = { mode: async () => mode, execute };
		let owner = f.runtime(f.root, host);
		await owner.operation("start", { source }, "owner");
		if (receipt === "recovered") {
			assert.ok((await f.status()).pending.some(e => e.state === "uncertain"));
			owner.close();
			owner = f.runtime(f.root, { ...host, recover: refuse });
			owner.turn("owner");
			await owner.flush();
		}
		assert.deepEqual(starts, ["left"], "do not issue native work on an old mode decision");
		assert.deepEqual((await f.status()).nodes.map(n => n.state), ["blocked", "waiting"]);
		mode = "interactive";
		owner.turn("owner"); await owner.flush();
		assert.deepEqual(starts, ["left", "right"], "resume ready work without replaying the refusal");
		const right = (await f.status()).nodes.find(n => n.grain === "right");
		assert.ok(right?.worker);
		await f.submit(right.worker);
		assert.equal((await f.status()).qualified, null);
	});

for (const outcome of ["denied", "unconfirmed"])
	test(`native start ${outcome} while a sibling is held: only a refusal frees its slot`, async t => {
		const f = fixture(t, p => { addIndependent(p); p.limits = { workers: 2 }; }, extraCheck);
		let release = () => {};
		const held = new Promise(resolve => { release = () => resolve(undefined); });
		/** @type {string[]} */ const issued = [];
		const owner = f.runtime(f.root, { execute: async (...args) => {
			if (args[0] === "create_session") {
				const grain = text(args[1].name, "name").split(" ")[0];
				issued.push(grain);
				if (grain === "right") await held;
				if (grain === "left") return { resultType: outcome };
			}
			return f.execute(...args);
		} });
		const start = owner.operation("start", { source }, "owner");
		try {
			await new Promise(resolve => setImmediate(resolve)); // Drain immediate replies, not the held creation.
			const s = await f.status();
			assert.ok(s.pending.some(e => e.kind === "writer" && e.state === "issued"));
			const extra = s.nodes.find(n => n.grain === "extra");
			if (outcome === "denied") {
				assert.ok(extra?.worker, "refill the freed slot without another turn or resolving the held call");
				await f.submit(extra.worker);
				assert.equal((await f.status()).nodes.find(n => n.grain === "extra")?.state, "published");
			} else {
				assert.equal(extra?.state, "waiting");
				assert.ok(s.pending.some(e => e.kind === "writer" && e.state === "uncertain"));
			}
			assert.deepEqual(issued, outcome === "denied" ? ["left","right","extra"] : ["left","right"]);
		} finally { release(); await start; }
		assert.ok((await f.status()).nodes.find(n => n.grain === "right")?.worker);
		assert.equal(new Set(issued).size, issued.length, "do not reissue a native start");
		assert.equal((await f.status()).qualified, null);
	});

for (const sibling of ["ready", "denied", "unconfirmed"])
	test(`factory matrix: owner exits during dispatch / ${sibling} sibling while history is held`, async t => {
		const f = fixture(t, p => { addIndependent(p); p.limits = { workers: 2 }; }, extraCheck);
		// Exit after issuance is durable, either before or after the second reservation is issued.
		const child = `import {createRuntime} from ${JSON.stringify(new URL("./runtime.mjs", import.meta.url).href)};
			const [root,source,stop]=process.argv.slice(1);
			const r=createRuntime(root,{mode:async()=>"interactive",permissionBlocker:async()=>null,confirm:async()=>true,execute:(_,args)=>{
				if(args.name.startsWith(stop+" "))process.exit(86);return new Promise(()=>{});
			}});await r.operation("start",{source},"owner");`;
		await assert.rejects(promisify(execFile)(process.execPath, ["--input-type=module", "-e", child,
			f.root, source, sibling === "ready" ? "left" : "right"], { timeout: 15000 }), { code: 86 });
		assert.deepEqual((await f.status()).pending.map(e => e.state), ["issued", sibling === "ready" ? "ready" : "issued"]);
		let release = () => {};
		const held = new Promise(resolve => { release = () => resolve(undefined); });
		/** @type {string[]} */ const reads = [];
		const owner = f.runtime(f.root, { recover: async e => {
			reads.push(text(e.grain, "original writer"));
			if (e.grain === "left") { await held; return { resultType: "unconfirmed" }; }
			return { resultType: sibling };
		} });
		owner.turn("owner");
		try {
			await new Promise(resolve => setImmediate(resolve));
			const s = await f.status(), right = s.nodes.find(n => n.grain === "right"), extra = s.nodes.find(n => n.grain === "extra");
			assert.deepEqual([...reads].sort(), sibling === "ready" ? ["left"] : ["left", "right"]);
			if (sibling === "ready") {
				assert.ok(right?.worker, "send an unissued reservation without waiting for unrelated history");
				assert.equal(extra?.state, "waiting", "the held original still occupies its slot");
				await f.submit(right.worker);
			} else if (sibling === "denied") {
				assert.equal(right?.state, "blocked");
				assert.ok(extra?.worker, "use the verified refusal before the other lookup finishes");
				await f.submit(extra.worker);
			} else {
				assert.equal(f.workers.size, 0);
				assert.equal(extra?.state, "waiting");
			}
			owner.turn("owner");
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(reads.filter(g => g === "left").length, 1, "overlapping turns share the in-flight lookup");
		} finally { release(); await owner.flush(); }
		const done = await f.status();
		assert.ok(done.nodes.some(n => n.grain === "left" && n.state === "writing" && !n.worker));
		assert.equal(f.workers.size, sibling === "ready" ? 2 : sibling === "denied" ? 1 : 0);
		assert.equal(done.qualified, null);
		assert.equal(git(f.root, "rev-parse", "main"), f.tip);
	});

test("a repairs-only goal starts every scout and admits a ready writer alongside the remaining scouts", async t => {
	const f = fixture(t, p => {
		goal(p); addIndependent(p);
		p.limits = { repairs: 0 };
		p.squads[0].grains = ["left"];
		p.squads.push({ ...p.squads[0], id: "extra", grains: ["extra"] });
	}, { ...goalFiles, ...extraCheck });
	const start = await f.start();
	assert.equal(start.reviews.filter(r => r.state === "reading").length, 3);
	await f.observe("worker-1", "left");
	const active = await f.status();
	assert.equal(active.reviews.filter(r => r.state === "reading").length, 2);
	assert.equal(active.nodes.find(n => n.grain === "left")?.state, "writing");
	assert.equal(active.limit, null);
	assert.equal(active.proposedLimit, undefined);
});

test("resume cannot change the confirmed cap or fixed assignments", async t => {
	const f = fixture(t, p => { p.limits = { workers: 1 }; });
	await f.start();
	await f.owner.operation("pause", { run }, "owner");
	delete f.p.limits;
	f.p.grains[0].directory = "other";
	put(f.root, source, JSON.stringify(f.p));
	git(f.root, "commit", "-qam", "change contract");
	await assert.rejects(f.start(), /conserved contract changed/i);
	assert.equal((await f.status()).limit, 1);
	assert.equal(f.workers.size, 1);
});

for (const raise of [false, true])
	test(`saturation offers only ready work; ${raise ? "increase" : "keep"} survives resume`, async t => {
		const f = fixture(t, p => {
			addIndependent(p); p.limits = { workers: 2 };
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
	const f = fixture(t, p => { addIndependent(p); p.limits = { workers: 2 }; }, extraCheck);
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
		addIndependent(p); p.limits = { workers: 2 };
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
	const f = fixture(t, p => { delete p.seed; addIndependent(p); p.limits = { workers: 2 }; }, extraCheck);
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
		await assert.rejects(recover(async () => page([{ ...start, data: { ...start.data, ...changed } }, end]), e), /matching|not confirmed/);
	const rejected = { ...end, data: { ...end.data, success: false, error: { code: "rejected", message: "user declined" } } };
	assert.equal((await recover(async () => page([start, rejected]), e)).resultType, "denied");
	await assert.rejects(recover(async () => page([start, { ...rejected, data: { ...rejected.data, error: { message: "looks like a denial" } } }]), e), /not confirmed/);
});

test("native recovery stops at the issuing turn without losing an earlier permission decision in that turn", async () => {
	const callId = "original", turnId = "turn";
	/** @type {Effect} */
	const effect = { id: "launch", issuer: "owner", kind: "scout", tool: "create_session", args: { name: "Review" }, callId, state: "uncertain" };
	const turn = { type: "assistant.turn_start", data: { turnId } };
	const start = { type: "tool.execution_start", id: "s", data: { turnId, toolCallId: callId, toolName: effect.tool, arguments: effect.args } };
	const end = { type: "tool.execution_complete", id: "e", data: { turnId, toolCallId: callId, success: true, result: { content: "created" } } };
	const denial = { type: "permission.completed", data: { toolCallId: callId, result: { kind: "denied-interactively-by-user" } } };
	/** @param {...Record<string,unknown>[]} pages Newest page first, chronological within each page. */
	const lookup = (...pages) => recover(async ({ types = "*" }) => {
		const events = pages.shift();
		assert.ok(events, "recovery read past the issuing turn");
		return { events: events.filter(e => types === "*" || types.some(type => type === e.type)), cursor: String(pages.length), cursorStatus: "ok", hasMore: true };
	}, effect);
	await assert.rejects(lookup([denial, turn, start]), { code: "receipt_unavailable" });
	await assert.rejects(lookup([start], [turn]), { code: "receipt_unavailable" });
	await assert.rejects(lookup([turn, end, start]), { code: "ambiguous_receipt" });
	assert.equal((await lookup([{ ...turn, agentId: "nested" }, start], [turn, denial])).resultType, "denied");
	await assert.rejects(lookup([start, end], [turn, denial]), { code: "ambiguous_receipt" });
});

test("ledger readers survive concurrent SQLite journal removal but still refuse live links", async t => {
	const f = fixture(t), db = openDatabase(f.root, undefined, true);
	t.after(() => db.close());
	const writer = `import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync(process.argv[1]);
		db.exec("PRAGMA busy_timeout=5000");for(let i=0;i<2000;i++)db.exec("BEGIN IMMEDIATE;INSERT INTO runs VALUES('scratch','scratch','{}','scratch');ROLLBACK");db.close();`;
	let finished = false;
	const child = promisify(execFile)(process.execPath, ["--input-type=module", "-e", writer, db.file], { timeout: 30000 }).finally(() => { finished = true; });
	try {
		while (!finished) {
			for (let i = 0; i < 32; i++) assert.equal(db.read("scratch"), undefined);
			await new Promise(resolve => setImmediate(resolve));
		}
	} finally { await child; }
	for (const makeLink of [symlinkSync, linkSync]) {
		makeLink(path.join(f.root, "neighbor.txt"), db.file + "-journal");
		try { assert.throws(() => db.read("scratch"), { code: "unsafe_storage" }); }
		finally { rmSync(db.file + "-journal"); }
	}
	const alias = path.join(f.root, "extra-link");
	linkSync(db.file, alias);
	try { assert.throws(() => db.read("scratch"), { code: "unsafe_storage" }); }
	finally { rmSync(alias); }
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
		{ ...initial, policy: { ...initial.policy, workers: 2 }, capacity: { limit: 0, kept: false } },
		{ ...initial, policy: { ...initial.policy, workers: 2 } },
		{ ...initial, capacity: { limit: 2, kept: false } },
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
	check(p => { goal(p); p.goalCheck = "lib/left/old.mjs"; }, /overlap/);
	check(p => { p.goalCheck = p.productCheck; }, /distinct/);
	check(p => { goal(p); p.squads.pop(); }, /chartered producer/);
	check(p => { p.goalCheck = goalCheck; }, /seed selects a one-off/);
	check(p => { p.limits = { workers: 0 }; }, /worker limit/);
	check(p => { p.limits = { repairs: -1 }; }, /repair limit/);
	assert.equal(existsSync(ledgerPath(f.root)), false);
});
