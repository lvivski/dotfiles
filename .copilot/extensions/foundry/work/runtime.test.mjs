import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { factory, git, put } from "../test/fixture.mjs";
import { mapSnapshot } from "../map/model.mjs";
import { checksum, openDatabase, ledgerPath, protocol } from "./database.mjs";
import { readPolicy } from "./contract.mjs";
import { feedback, goalDelta } from "./feedback.mjs";
import { advance, observe, parseObservation } from "./graph.mjs";
import { withProduct } from "./product.mjs";
import { recover } from "./recovery.mjs";
import { reviews } from "./reviews.mjs";
import { createRuntime } from "./runtime.mjs";
import { buildTools } from "./tools.mjs";
import { record, text } from "./values.mjs";

/** @typedef {Parameters<typeof createRuntime>[1]} Host */
/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {ReturnType<typeof factory>["scouts"][number]} Scout */
const grainIds = ["left", "right"];
const source = ".foundry/policy.json", run = "sum";
const policy = () => ({
	version: 1, id: run, direction: "Make the joined exports sum to three", target: "refs/heads/main", productCheck: ".foundry/product.mjs",
	goalCheck: /** @type {string|undefined} */ (undefined),
	grains: grainIds.map(id => ({ id, directory: `lib/${id}`, specification: `.foundry/${id}.md`, boundary: [".foundry/api.md"], check: `.foundry/${id}.mjs`, needs: /** @type {string[]} */ ([]) })),
	limits: /** @type {{workers?:number,assignments?:number,repairs?:number,deadline?:string}|undefined} */ (undefined), seed: /** @type {string[]|undefined} */ ([...grainIds]),
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
	/** @param {string} squad */
	async function reading(squad) {
		await f.settle();
		const review = (await f.status()).reviews.findLast(r => r.squad === squad && r.state === "reading");
		assert.ok(review, `No admitted ${squad} review`);
		const job = f.scouts.find(job => job.id === review.id);
		assert.ok(job, `No workflow job for ${squad} review ${review.id}`);
		return job;
	}
	/** @param {string} squad @param {string[]} [grains] */
	async function reportGrains(squad, grains = [squad]) {
		return (await reading(squad)).report({ outcome: grains.length ? "regenerate" : "no-gap", reason: `Review ${squad}`, evidence: [`.foundry/${squad}.md`], grains });
	}
	return { ...f, p, submit, reading, reportGrains };
}

const goalCheck = ".foundry/final.mjs";
for (const stopped of ["before repin", "after repin", "at explicit resume"]) test(`repin frees the only scout slot when a superseded attempt stops ${stopped}`, async t => {
	const f = fixture(t, p => { goal(p); p.limits = { workers: 1 }; }, { [goalCheck]: "process.exit(1);" });
	const workflow = "original-workflow";
	let ticket = "", resumes = 0, nativeStatus = "running";
	const first = f.runtime(f.root, { scout: async (id, dispatch, actor) => {
		ticket = dispatch; await f.owner.scoutBatch(id, dispatch, actor, workflow);
		if (stopped === "before repin") return { runId: workflow, status: "paused" };
		throw Error("lost the native reply after binding");
	} });
	const original = (await f.start(first)).reviews[0]; first.close();
	let stop = () => {};
	const observed = new Promise(resolve => { stop = () => resolve(undefined); });
	const owner = f.runtime(f.root, {
		confirm: async () => true,
		scoutState: async id => { await observed; return { runId: id, status: "halted" }; },
		scoutSnapshot: async id => ({ runId: id, status: nativeStatus }),
		resumeScout: async id => { resumes++; return { runId: id, status: "completed" }; },
	});
	const side = path.join(path.dirname(f.root), "repair");
	git(f.root, "worktree", "add", "-q", "--detach", side, f.tip);
	put(side, goalCheck, 'console.error("current pin diagnostic"); process.exit(1);');
	git(side, "commit", "-qam", "Correct the diagnostic"); const revision = git(side, "rev-parse", "HEAD");
	const repinned = await owner.operation("repin", { run, from: f.tip, revision, files: [goalCheck] }, "owner");
	assert.deepEqual(repinned.goalChecks?.map(e => [e.commit, e.evaluatorRevision, e.receipt?.exit]), [[f.tip, f.tip, 1], [f.tip, revision, 1]]);
	if (stopped !== "before repin") {
		await owner.operation("resume", { source }, "owner"); await f.settle();
		assert.equal(f.scouts.length, 0, "an unconfirmed or still-running workflow must keep its slot");
		if (stopped === "after repin") stop();
		else { nativeStatus = "paused"; await owner.operation("resume", { source }, "owner"); }
	}
	await f.settle(); await owner.flush();
	assert.equal(resumes, 0, "never resume a scout for a superseded evaluator");
	assert.equal(f.scouts.length, 1, "fresh discovery must get the slot");
	const [fresh] = f.scouts;
	assert.notEqual(fresh.workflowId, workflow); assert.notEqual(fresh.id, original.id);
	assert.ok(fresh.prompt.includes("current pin diagnostic"));
	assert.deepEqual(await owner.scoutBatch(run, ticket, "owner", workflow), [], "a late native continuation gets no jobs");
	await fresh.report({ outcome: "regenerate", reason: "Implement the missing output.", evidence: [`.foundry/${fresh.squad}.md`], grains: [fresh.squad] });
	const s = await f.status();
	assert.equal(s.reviews[0].state, "blocked"); assert.equal(s.reviews[1].state, "observed");
	assert.equal(s.nodes[0].state, "writing"); assert.equal(f.workers.size, 1); assert.equal(s.qualified, null);
});

test("repin identifies the obsolete running goal and rechecks once after its real interruption", async t => {
	const f = fixture(t, goal, { [goalCheck]: `import {writeFileSync} from "node:fs";
		writeFileSync(process.env.READY, String(process.pid)); setTimeout(() => process.exit(3), 30000);`,
		".foundry/product.mjs": "process.exit(0);" });
	const side = path.join(path.dirname(f.root), "amendment"), ready = path.join(path.dirname(f.root), "evaluator.pid");
	git(f.root, "worktree", "add", "-q", "--detach", side, f.tip);
	put(side, goalCheck, 'console.log("replacement observed"); process.exit(2);');
	git(side, "commit", "-qam", "Repair stalled probe");
	const revision = git(side, "rev-parse", "HEAD");
	/** @type {Promise<unknown>|undefined} */ let runner;
	const owner = f.runtime(f.root, { confirm: async () => true, execute: async (tool, a, call) => {
		if (tool !== "bash" || runner) return f.execute(tool, a, call);
		runner = promisify(execFile)("/bin/sh", ["-c", text(a.command, "runner")], { cwd: f.root, env: { ...process.env, READY: ready } });
		return { resultType: "unconfirmed" }; // Lost host reply while the actual runner is still alive.
	} });
	await owner.operation("start", { source }, "owner");
	try {
		const deadline = Date.now() + 15000;
		while (!existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
		assert.ok(existsSync(ready), "exclusive runner did not launch the fixture evaluator");
		const s = await owner.operation("repin", { run, from: f.tip, revision, files: [goalCheck] }, "owner");
		const old = s.pending.find(e => e.kind === "goal");
		assert.ok(old?.awaitingEvaluator);
		assert.equal(old.state, "uncertain");
		assert.equal(s.goalChecks?.length, 1, "no duplicate evaluation while the obsolete one is alive");
		assert.ok(s.blocker?.includes(old.id) && s.blocker.includes(revision), "owner cannot identify what is holding the approved pin");
	} finally {
		if (existsSync(ready)) {
			const pid = Number(readFileSync(ready, "utf8"));
			assert.ok(Number.isSafeInteger(pid) && pid > 1);
			process.kill(pid, "SIGTERM"); // The disposable evaluator, not its receipt-writing parent.
		}
		await runner;
	}
	owner.turn("owner"); await owner.flush();
	const done = await f.status();
	assert.deepEqual(done.goalChecks?.map(e => [e.commit, e.evaluatorRevision, e.receipt?.exit]), [[f.tip, f.tip, null], [f.tip, revision, 2]]);
	assert.match(done.goalChecks?.[0].receipt?.output ?? "", /SIGTERM/);
	assert.match(done.goalChecks?.[1].receipt?.output ?? "", /replacement observed/);
	assert.equal(done.qualified, null);
	assert.equal(f.workers.size, 0);
});

for (const [oldExit, newExit] of [[1, 0], [0, 2]]) test(`repin finishes the issued goal on its old pin, then rechecks the same product: ${oldExit} -> ${newExit}`, async t => {
	const helper = ".foundry/probe.mjs";
	const f = fixture(t, goal, { [goalCheck]: `import verdict from "./probe.mjs"; process.exit(verdict);`,
		[helper]: `export default ${oldExit};`, ".foundry/product.mjs": "process.exit(0);" });
	const side = path.join(path.dirname(f.root), "reviewed");
	git(f.root, "worktree", "add", "-q", "--detach", side, f.tip);
	put(side, helper, `export default ${newExit};`);
	git(side, "commit", "-qam", "Fix the probe");
	const revision = git(side, "rev-parse", "HEAD"), args = { run, from: f.tip, revision, files: [helper] };
	let issued = () => {}, release = () => {};
	const held = new Promise(resolve => { issued = () => resolve(undefined); });
	const until = new Promise(resolve => { release = () => resolve(undefined); });
	const owner = f.runtime(f.root, { confirm: async () => true, execute: async (tool, a, call) => {
		if (tool === "bash" && !f.checks.length) { issued(); await until; }
		return f.execute(tool, a, call);
	} });
	const starting = owner.operation("start", { source }, "owner");
	await held;
	try {
		const s = await owner.operation("repin", args, "owner");
		assert.equal(s.qualified, null);
		assert.equal(s.pending?.filter(e => e.kind === "goal").length, 1);
	} finally { release(); await starting; }
	const done = await owner.operation("status", { run, detail: "proof" }, "owner");
	assert.equal(git(f.root, "rev-parse", "HEAD"), f.tip);
	assert.equal(f.workers.size, 0);
	assert.deepEqual(done.goalChecks?.map(e => [e.commit, e.evaluatorRevision, e.receipt?.exit]), [[f.tip, f.tip, oldExit], [f.tip, revision, newExit]]);
	assert.equal(done.qualified, newExit === 0 ? f.tip : null);
	if (newExit !== 0) { assert.equal(done.qualification, null); return; }
	assert.equal(done.qualification?.format, "foundry-qualification/v2");
	assert.equal(done.qualification?.receipts.goal.evaluatorRevision, revision);
	const bundle = path.join(path.dirname(f.root), "qualification.bundle");
	execFileSync(process.execPath, [fileURLToPath(new URL("../../../skills/foundry/scripts/qualification.mjs", import.meta.url)), "pack", bundle],
		{ cwd: f.root, input: JSON.stringify(done.qualification) });
	assert.ok(git(f.root, "bundle", "list-heads", bundle).includes(`${revision} refs/foundry/objects/${revision}`));
});

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

test("repin keeps the writer and rejects changes outside the goal harness or without operator approval", async t => {
	const f = fixture(t, goal, goalFiles);
	await f.start();
	await f.reportGrains("left");
	const [w] = f.workers.values(), side = path.join(path.dirname(f.root), "probe-fix");
	git(f.root, "worktree", "add", "-q", "--detach", side, f.tip);
	let approved = false, prompts = 0;
	const owner = f.runtime(f.root, {
		ask: async () => assert.fail("Repinning must not request text input"),
		confirm: async prompt => {
			assert.ok(prompt.includes(f.tip) && prompt.includes(revision) && prompt.includes(goalCheck));
			assert.doesNotMatch(prompt, /type approve/i);
			prompts++;
			return approved;
		},
	});
	put(side, goalCheck, 'import {existsSync} from "node:fs"; process.exit(existsSync("lib/left/index.mjs") ? 0 : 1);');
	git(side, "commit", "-qam", "Repair goal probe");
	const revision = git(side, "rev-parse", "HEAD"), args = { run, from: f.tip, revision, files: [goalCheck] };
	await assert.rejects(owner.operation("repin", args, w.id), /owner/i);
	await assert.rejects(owner.operation("repin", { ...args, files: [] }, "owner"), /diff/i);
	put(side, ".foundry/api.md", "Different requirements");
	git(side, "commit", "-qam", "Change boundary");
	await assert.rejects(owner.operation("repin", { ...args, revision: git(side, "rev-parse", "HEAD"), files: [goalCheck, ".foundry/api.md"] }, "owner"), /not the brief/);
	assert.equal(prompts, 0);
	await assert.rejects(owner.operation("repin", args, "owner"), { code: "approval_declined" });
	assert.equal((await f.status()).goal?.pin, f.tip);
	approved = true;
	await owner.operation("repin", args, "owner");
	assert.equal(prompts, 2, "one button decision per valid request");
	await assert.rejects(owner.operation("repin", args, "owner"), /pin changed/);
	assert.equal((await f.runtime(w.cwd).operation("status", { run }, w.id)).nodes.find(n => n.grain === "left")?.token, w.token);
	await f.submit(w.id);
	const done = await f.status();
	assert.ok(done.qualified && done.qualified !== f.tip);
	assert.equal(done.goal?.receipt?.evaluatorRevision, revision);
	assert.equal(done.goal?.receipt?.commit, done.qualified);
	assert.equal(git(f.root, "show", `${done.qualified}:${goalCheck}`), goalFiles[goalCheck].trim());
});

for (const lateWork of [false, true])
	test(`a ready product is checked before the other scout reports / ${lateWork ? "superseded" : "accepted"}`, async t => {
		const f = fixture(t, goal, { ...goalFiles, [goalCheck]: 'import {existsSync} from "node:fs"; process.exit(existsSync("lib/left/index.mjs") ? 0 : 1)' });
		await f.start();
		const right = await f.reading("right");
		await f.reportGrains("left");
		let first;
		await f.submit("worker-1", 1, { execute: async (...args) => {
			const reply = await f.execute(...args);
			if (String(args[1].description).startsWith("Check joined product")) {
				const s = await f.status();
				assert.equal(s.reviews.find(r => r.id === right.id)?.state, "reading");
				first = s.candidate?.commit;
				if (lateWork) await f.reportGrains("right");
			}
			return reply;
		} });
		assert.ok(first, "the evaluator must not wait for an unrelated report");
		if (!lateWork) {
			const done = await f.status();
			assert.equal(done.qualified, first);
			assert.equal(done.goal?.receipt?.commit, first);
			assert.equal(done.reviews.find(r => r.id === right.id)?.state, "blocked");
			await right.report(result(".foundry/right.md", ["right"]));
			assert.deepEqual(await f.status(), { ...done, pending: [] }, "consume the late delivery without changing the accepted product");
			assert.equal(f.workers.size, 1);
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

test("rolling goal feedback binds scheduling context to the exact prior goal, not ambient env or a prior pin", async t => {
	const previous = { gaps: ["right"], title: "two words" };
	const marker = `console.log('FOUNDRY_GOAL_FEEDBACK=${JSON.stringify(previous)}');`;
	const check = `console.log("delta=" + (process.env.FOUNDRY_GOAL_DELTA ?? "unset")); ${marker} process.exit(1);`;
	const rejectAmbient = 'if ("FOUNDRY_GOAL_DELTA" in process.env) throw Error("goal hints leaked");';
	const f = fixture(t, goal, { [goalCheck]: check, ".foundry/product.mjs": rejectAmbient, ".foundry/left.mjs": rejectAmbient });
	const saved = process.env.FOUNDRY_GOAL_DELTA; process.env.FOUNDRY_GOAL_DELTA = "untrusted";
	t.after(() => { if (saved === undefined) delete process.env.FOUNDRY_GOAL_DELTA; else process.env.FOUNDRY_GOAL_DELTA = saved; });
	assert.match((await f.start()).goal?.receipt?.output ?? "", /^delta=unset$/m);
	await f.reportGrains("left"); await f.submit("worker-1");
	const joined = await f.status(), receipt = joined.goal?.receipt; assert.ok(receipt);
	assert.deepEqual(JSON.parse(/^delta=(.*)$/m.exec(receipt.output)?.[1] ?? "null"),
		{ version: 1, base: f.tip, head: receipt.commit, paths: ["lib/left/index.mjs", "lib/left/old.mjs"], previous });
	assert.equal(receipt.exit, 1); assert.equal(joined.qualified, null);
	const side = path.join(path.dirname(f.root), "new-pin"); git(f.root, "worktree", "add", "-q", "--detach", side, f.tip);
	put(side, goalCheck, `// new evaluator\n${check}`); git(side, "commit", "-qam", "New goal evaluator");
	const repinned = await f.runtime(f.root, { confirm: async () => true }).operation("repin",
		{ run, from: f.tip, revision: git(side, "rev-parse", "HEAD"), files: [goalCheck] }, "owner");
	assert.match(repinned.goal?.receipt?.output ?? "", /^delta=unset$/m);
});

test("goal scheduling omits ambiguous or oversized feedback and never truncates a tree diff", t => {
	const line = "FOUNDRY_GOAL_FEEDBACK=";
	for (const raw of [line + "{", `${line}{}\n${line}null`, `${line}"${"ä".repeat(4096)}"`, `not a record: ${line}[]`])
		assert.equal(feedback(Buffer.from(raw)), undefined);
	assert.equal(feedback(Buffer.concat([Buffer.from(line + '"'), Buffer.from([255]), Buffer.from('"')])), undefined);
	assert.equal(feedback(Buffer.from(`some output\r\n${line}null\r\n`)), "null");
	const f = fixture(t), prior = { base: f.tip, previous: "null" };
	assert.deepEqual(JSON.parse(goalDelta(f.root, f.tip, prior) ?? "null").paths, []);
	git(f.root, "mv", "neighbor.txt", "renamed file"); git(f.root, "commit", "-qm", "rename");
	assert.deepEqual(JSON.parse(goalDelta(f.root, git(f.root, "rev-parse", "HEAD"), prior) ?? "null").paths, ["neighbor.txt", "renamed file"]);
	for (let i = 0; i < 255; i++) put(f.root, `many/${i}`, "");
	git(f.root, "add", "many"); git(f.root, "commit", "-qm", "257 changed paths");
	assert.equal(goalDelta(f.root, git(f.root, "rev-parse", "HEAD"), prior), undefined);
	const base = git(f.root, "rev-parse", "HEAD");
	for (let i = 0; i < 160; i++) put(f.root, `long/${"x".repeat(210)}-${i}`, "");
	git(f.root, "add", "long"); git(f.root, "commit", "-qm", "over 32 KiB of paths");
	assert.equal(goalDelta(f.root, git(f.root, "rev-parse", "HEAD"), { ...prior, base }), undefined);
	assert.equal(goalDelta(f.root, "0".repeat(40), prior), undefined);
});

test("a newer goal without usable stdout feedback never borrows an older summary or a stderr record", async t => {
	const f = fixture(t, goal, { ...goalFiles, [goalCheck]: `import {existsSync} from "node:fs";
		console.log("delta=" + (process.env.FOUNDRY_GOAL_DELTA ?? "unset"));
		if (!existsSync("lib/left/index.mjs")) console.log('FOUNDRY_GOAL_FEEDBACK="baseline"');
		else console.error('FOUNDRY_GOAL_FEEDBACK="not stdout"'); process.exit(1);` });
	await f.start(); await f.reportGrains("left"); await f.submit("worker-1");
	assert.match((await f.status()).goal?.receipt?.output ?? "", /"previous":"baseline"/);
	await f.reportGrains("right"); await f.submit("worker-2");
	const final = await f.status(); assert.match(final.goal?.receipt?.output ?? "", /^delta=unset$/m);
	assert.equal(final.qualified, null);
});

test("an attributed goal gap staffs only its squad and widens discovery if that scout has no work", async t => {
	const f = fixture(t, goal, { ...goalFiles, [goalCheck]: `import {existsSync} from "node:fs";
		if (!existsSync("lib/left/index.mjs")) console.log("FOUNDRY_SQUAD=left\\nFOUNDRY_SQUAD=right");
		else console.log("FOUNDRY_SQUAD=right");
		process.exit(1);` });
	await f.start();
	const right = await f.reading("right");
	await f.reportGrains("left");
	await f.submit("worker-1");
	const focused = await f.status();
	assert.deepEqual(focused.reviews.filter(r => r.base === focused.checkpoint).map(r => r.squad), ["right"]);
	await right.report(result(".foundry/right.md", ["right"]));
	assert.equal((await f.status()).nodes.some(n => n.grain === "right"), false, "an older review cannot add work to the checkpoint");
	assert.equal((await f.status()).reviews.find(r => r.id === right.id)?.state, "blocked");
	await f.reportGrains("right", []);
	const full = await f.status();
	assert.deepEqual(full.reviews.filter(r => r.base === full.checkpoint).map(r => r.squad), ["right", "left"]);
	assert.equal(full.blocker, undefined);
	await f.reportGrains("left", []);
	assert.match(String((await f.status()).blocker), /no actionable grain/i);
});

test("the owner can attach a past goal receipt to the next normal scout without launching or replaying work", async t => {
	const f = fixture(t, goal, goalFiles), start = await f.start();
	const db = openDatabase(f.root); t.after(() => db.close());
	const [source] = (await f.owner.operation("status", { run, detail: "proof" }, "owner")).goalChecks ?? [];
	assert.equal(source.commit, f.tip); const receipt = source.id;
	const question = "Which boundary first loses the new value?", args = { run, squad: "right", receipt, question };
	const original = await f.reading("right"), before = db.read(run)?.effects;
	const owner = f.runtime(f.root);
	await owner.operation("review_note", args, "owner");
	await owner.operation("review_note", args, "owner");
	assert.deepEqual(db.read(run)?.effects, before);
	assert.equal(f.workers.size, 0); assert.equal(f.scouts.length, 2);
	const replay = await owner.scoutBatch(run, original.dispatch, original.issuer, original.workflowId);
	assert.ok(replay.every(job => !job.prompt.includes(question)));
	await assert.rejects(owner.operation("review_note", { ...args, question: "Different question?" }, "owner"), /pending/i);
	await assert.rejects(owner.operation("review_note", args, "foreign"), /owner/i);
	await assert.rejects(owner.operation("review_note", { ...args, receipt: f.tip }, "owner"), /receipt/i);
	await f.reportGrains("left"); await f.submit("worker-1");
	const next = await f.reading("right"), other = await f.reading("left");
	assert.notEqual(next.base, f.tip); assert.notEqual(next.id, original.id);
	assert.ok(next.prompt.includes(question)); assert.ok(!other.prompt.includes(question));
	assert.ok(start.goal?.receipt?.output);
	assert.ok(next.prompt.includes(receipt) && next.prompt.includes(f.tip) && next.prompt.includes(start.goal.receipt.output.trim()));
	assert.match(next.prompt, /historical.*not re-observed/i);
	const seen = await f.status();
	assert.equal(seen.qualified, null); assert.equal(seen.reviews.find(r => r.id === next.id)?.note?.receipt, receipt);
	assert.equal(seen.pendingReviewNotes?.length ?? 0, 0);
	await f.reportGrains("right"); await f.submit("worker-2");
	assert.equal(f.scouts.filter(s => s.prompt.includes(question)).length, 1);
});

test("review notes require a real receipt and bound the owner's question and historical excerpt", async t => {
	const f = fixture(t, goal, { ...goalFiles, [goalCheck]: 'console.log("z".repeat(9000) + "\\nlast observed: value mismatch"); process.exit(1);' });
	await f.start();
	const [check] = (await f.owner.operation("status", { run, detail: "proof" }, "owner")).goalChecks ?? [];
	const args = { run, receipt: check.id, question: "What changed?", squad: "right" }, op = "review_note";
	const tool = buildTools(f.owner, () => "owner").find(t => t.name === `foundry_${op}`); assert.ok(tool?.handler);
	const actor = { sessionId: "owner", toolName: tool.name, toolCallId: "note", arguments: args };
	assert.match(JSON.stringify(await tool.handler(args, { ...actor, agentId: "helper" })), /subagents/);
	await assert.rejects(f.owner.operation(op, args, "owner"), /verbatim excerpt/);
	await assert.rejects(f.owner.operation(op, { ...args, excerpt: "not in stdout or stderr" }, "owner"), /verbatim excerpt/);
	const excerpt = "last observed: value mismatch";
	await assert.rejects(f.owner.operation(op, { ...args, excerpt, question: "é".repeat(513) }, "owner"), /1024/);
	await assert.rejects(f.owner.operation(op, { ...args, excerpt, squad: "missing" }, "owner"), /squad/);
	assert.equal(typeof await tool.handler({ ...args, excerpt }, actor), "string");
	const reloaded = f.runtime(f.root);
	assert.deepEqual((await reloaded.operation("status", { run }, "owner")).pendingReviewNotes, [{ squad: "right", receipt: check.id, question: args.question, excerpt }]);
	const count = f.scouts.length;
	await f.reportGrains("left"); await f.submit("worker-1");
	const next = f.scouts.slice(count).find(s => s.squad === "right"); assert.ok(next);
	assert.ok(next.prompt.includes(JSON.stringify({ excerpt }).slice(1, -1)));
	assert.equal((next.prompt.match(/z{9000}/g) ?? []).length, 1, "full long output appears only in the current receipt, not in the historical note");
});

test("an early failed milestone widens a focused search and preserves its checked writer", async t => {
	const f = fixture(t, goal, { [goalCheck]: 'import {existsSync} from "node:fs"; console.log("FOUNDRY_SQUAD=left"); process.exit(existsSync("lib/right/index.mjs") ? 0 : 1)' });
	const start = await f.start();
	assert.deepEqual(start.reviews.map(r => r.squad), ["left"]);
	await f.reportGrains("left");
	await f.submit("worker-1");
	const failed = await f.status();
	assert.equal(failed.candidate?.receipt?.exit, 1);
	assert.match(String(failed.blocker), /without identifying/);
	assert.deepEqual(failed.reviews.map(r => r.squad), ["left", "right"]);
	await f.reportGrains("right");
	await f.submit("worker-2");
	const done = await f.status();
	assert.ok(done.qualified);
	assert.equal(done.goal?.receipt?.commit, done.qualified);
	assert.equal(done.products?.length, 1);
	assert.equal(f.checks.filter(c => c.startsWith("Check left ")).length, 1);
});

test("a diagnostic repin rechecks the assessed base without replaying a failed milestone", async t => {
	const f = fixture(t, goal, { [goalCheck]: goalFiles[goalCheck] });
	await f.start();
	const old = await f.reading("right");
	await f.reportGrains("left");
	await f.submit("worker-1");
	const failed = await f.status(), left = await f.status("worker-1");
	assert.equal(failed.candidate?.receipt?.exit, 1);
	assert.equal(failed.reviews.find(r => r.id === old.id)?.state, "reading");
	// Reopen the previously recorded shape: the failed check's diagnostic lived on the run.
	const db = openDatabase(f.root); t.after(() => db.close());
	db.update(run, r => {
		const effect = r.effects.find(e => e.id === failed.candidate?.check); assert.ok(effect && failed.blocker);
		delete effect.error;
		r.blocker = failed.blocker;
	});
	const side = path.join(path.dirname(f.root), "diagnostic");
	git(f.root, "worktree", "add", "-q", "--detach", side, f.tip);
	put(side, goalCheck, `console.log("amended diagnostic");\n${goalFiles[goalCheck]}`);
	git(side, "commit", "-qam", "Improve diagnostic");
	const revision = git(side, "rev-parse", "HEAD");
	const owner = f.runtime(f.root, { confirm: async () => true });
	await owner.operation("repin", { run, from: f.tip, revision, files: [goalCheck] }, "owner");
	await report(old, ".foundry/right.md", ["right"]);
	const held = await f.status();
	assert.match(String(held.reviews.find(r => r.id === old.id)?.reason), /changed during review/);
	assert.deepEqual(held.goalChecks?.map(e => [e.commit, e.evaluatorRevision, e.receipt?.exit]), [[f.tip, f.tip, 1], [f.tip, revision, 1]]);
	assert.deepEqual(held.candidate, failed.candidate);
	assert.deepEqual((await f.status("worker-1")).nodes, left.nodes);
	assert.equal(f.workers.size, 1);
	const fresh = await f.reading("right");
	assert.notEqual(fresh.id, old.id);
	assert.ok(fresh.prompt.includes("amended diagnostic"));
	await report(fresh, ".foundry/right.md", ["right"]);
	await f.submit("worker-2");
	const done = await f.status();
	assert.ok(done.qualified);
	assert.equal(done.goal?.receipt?.evaluatorRevision, revision);
	assert.equal(done.goal?.receipt?.commit, done.qualified);
	assert.equal(done.products?.at(-1)?.receipt?.commit, done.qualified);
	assert.equal(f.checks.filter(c => c.startsWith("Check joined product")).length, 2);
	assert.equal(f.checks.filter(c => c.startsWith("Check left ")).length, 1);
	assert.deepEqual(db.read(run)?.effects.find(e => e.id === failed.candidate?.check)?.receipt, failed.candidate.receipt);
});

const unitCheck = ".foundry/unit.mjs";
const areaPolicy = () => ({
	version: 2, id: run, direction: "Send a transformed record once; retain its value when the result is unknown.", target: "refs/heads/main",
	productCheck: ".foundry/product.mjs", goalCheck,
	squads: ["engine", "pipeline"].map((id, i) => ({ id, charter: `.foundry/${grainIds[i]}.md`, areas: [id], boundary: [".foundry/api.md"], checks: [unitCheck] }))
});
/** @param {string} evidence @param {(string|import("./model.js").Proposal)[]} grains @param {string[]} [replace] */
const result = (evidence, grains, replace) => ({ outcome: grains.length ? "regenerate" : "no-gap",
	reason: "Inspect the remaining behavior", evidence: [evidence], grains, ...(replace ? { replace } : {}) });
/** @param {Scout} job @param {string} evidence @param {(string|import("./model.js").Proposal)[]} grains @param {string[]} [replace] */
const report = (job, evidence, grains, replace) => job.report(result(evidence, grains, replace));

/** @param {ReturnType<typeof createRuntime>} runtime @param {Scout} job @param {unknown} raw */
const deliver = (runtime, job, raw) => runtime.scoutResult(run, job.dispatch, job.issuer, job.workflowId, job.id, raw, job.packet);
/** @param {import("node:test").TestContext} t @param {Record<string,string>} [files] */
function pipelineFixture(t, files = {}) {
	const f = fixture(t, undefined, {
		[source]: JSON.stringify(areaPolicy()),
		[unitCheck]: `import assert from "node:assert/strict";
			const unit = (await import("../"+process.env.FOUNDRY_DIRECTORY+"/index.mjs")).default;
			assert.equal(typeof unit,"function");
			if(process.env.FOUNDRY_GRAIN==="editor") assert.equal(unit("unfinished record"),"unfinished record");
			if(process.env.FOUNDRY_GRAIN==="recover") assert.equal(unit(),"outcome unknown");`,
		".foundry/product.mjs": `import assert from "node:assert/strict"; import edit from "../pipeline/assembly/editor/index.mjs";
			assert.equal(edit("typed record"),"typed record");`,
		[goalCheck]: `import {existsSync} from "node:fs";
			if(existsSync("pipeline/assembly/send/index.mjs")) {
				const transmit=(await import("../pipeline/assembly/send/index.mjs")).default, calls=[];
				const state=await transmit("retained text",async text=>{calls.push(text);throw Error("acknowledgment lost")});
				if(state==="outcome unknown" && calls.length===1 && calls[0]==="retained text") process.exit(0);
			}
			console.log("Pipeline did not send the input record once and preserve the unknown outcome");process.exit(1);`,
		...files
	});
	/** @param {string} id @param {string} body @param {Partial<Host>} [options] */
	async function write(id, body, options) {
		const n = (await f.status()).nodes.find(n => n.grain === id);
		assert.ok(n?.worker);
		const w = f.workers.get(n.worker); assert.ok(w);
		put(w.cwd, `${n.directory}/index.mjs`, body);
		const attempt = (await f.status(w.id)).nodes.find(n => n.grain === id);
		assert.ok(attempt?.token);
		const writer = f.runtime(w.cwd, options);
		await writer.operation("submit", { run, token: attempt.token }, w.id);
		return writer;
	}
	return { ...f, write };
}
/** @param {string} id @param {string} directory @param {string[]} [needs] */
const work = (id, directory, needs = []) => ({ id, directory, task: `Implement ${id} behavior`, needs, check: unitCheck });

for (const correct of [true, false]) test(`packaging cannot retire its own checked inputs; corrected plan: ${correct}`, async t => {
	const f = pipelineFixture(t), evidence = ".foundry/right.md";
	await f.start(); await f.reportGrains("engine", []);
	await report(await f.reading("pipeline"), evidence, [work("editor", "pipeline/assembly/editor"), work("storage", "pipeline/assembly/storage")]);
	await f.write("editor", "export default text=>text"); await f.write("storage", "export default ()=>true");
	const checkpoint = await f.status(); assert.ok(checkpoint.checkpoint);
	await f.reportGrains("engine", []);
	const packaging = await f.reading("pipeline"), needs = ["editor", "storage"], parent = work("send", "pipeline/assembly", needs);
	await report(packaging, evidence, [parent]);
	const rejected = await f.status(), reason = rejected.reviews.find(r => r.id === packaging.id)?.reason;
	assert.match(String(reason), /pipeline\/assembly.*editor.*pipeline\/assembly\/editor/);
	assert.deepEqual(rejected.nodes, checkpoint.nodes); assert.equal(f.workers.size, 2);
	const correction = await f.reading("pipeline");
	assert.equal(correction.base, packaging.base); assert.ok(reason && correction.prompt.includes(reason));
	await report(correction, evidence, [correct ? { ...parent, directory: "pipeline/assembly/send" } : parent]);
	if (!correct) {
		const stopped = await f.status();
		assert.deepEqual(stopped.nodes, checkpoint.nodes); assert.equal(stopped.checkpoint, checkpoint.checkpoint);
		assert.match(String(stopped.blocker), /editor/);
		assert.equal(stopped.reviews.at(-1)?.id, correction.id, "an invalid correction is not retried indefinitely");
		return;
	}
	await f.write("send", `export default async(text,send)=>{try{await send(text)}catch{return "outcome unknown"}}`);
	const done = await f.status(); assert.ok(done.qualified); assert.equal(done.goal?.receipt?.commit, done.qualified);
	assert.equal(f.workers.size, 3); assert.equal(git(f.root, "rev-parse", "main"), f.tip);
});

test("independent writers start together and a fixture-only integration cannot finish the run", async t => {
	const f = pipelineFixture(t);
	const start = await f.start();
	assert.deepEqual(start.nodes, []);
	const [core, pipeline] = f.scouts;
	await report(core, ".foundry/left.md", [work("recover", "engine/recovery")]);
	const editor = work("editor", "pipeline/assembly/editor"), send = work("send", "pipeline/assembly/send", ["editor", "recover"]);
	await report(pipeline, ".foundry/api.md", [editor, send]);
	await report(pipeline, ".foundry/api.md", [editor, send]); // A duplicated result cannot create a second job.
	const parallel = await f.status(), jobs = parallel.nodes.filter(n => n.state === "writing");
	assert.deepEqual(jobs.map(n => n.grain).sort(), ["editor", "recover"]);
	assert.deepEqual(parallel.nodes.find(n => n.grain === "send")?.requires, ["editor", "recover"]);
	assert.equal(f.workers.size, 2);
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
	const map = mapSnapshot(checkpoint);
	assert.ok(map.checkpoint && !map.qualified && map.goal?.result?.exit === 1);
	assert.match(String(checkpoint.goal.receipt.output), /did not send/);
	await report(pipeline, ".foundry/right.md", ["send"]);
	assert.deepEqual(await f.status(), checkpoint, "a completed review cannot authorize further work");
	await report(await f.reading("engine"), ".foundry/left.md", []);
	await report(await f.reading("pipeline"), "pipeline/assembly/send/index.mjs", [{ ...send, task: "Connect the actual transport" }]);
	const writer = [...f.workers.values()].at(-1); assert.ok(writer);
	assert.ok(writer.prompt.includes(`Reviewed input revision: ${checkpoint.checkpoint}`));
	assert.equal(existsSync(path.join(writer.cwd, send.directory)), false);
	await f.write("send", `import edit from "../editor/index.mjs";import recover from "../../../engine/recovery/index.mjs";
		export default async (text,send)=>{try {await send(edit(text));return "sent"}catch{return recover()}}`);
	const done = await f.status();
	assert.ok(done.qualified);
	assert.equal(done.goal?.receipt?.commit, done.qualified);
	assert.equal(done.products?.at(-1)?.receipt?.commit, done.qualified);
	assert.equal(mapSnapshot(done).phase, "Qualified");
	assert.deepEqual(done.products?.[0], checkpoint.products?.[0]);
	assert.equal(git(f.root, "rev-parse", "main"), f.tip);
});

for (const conflict of [false, true])
	test(`a checked parent becomes the base for two child writers; a ${conflict ? "conflicting" : "disjoint"} target edit is ${conflict ? "blocked" : "preserved"}`, async t => {
		const dir = "pipeline/assembly";
		const f = pipelineFixture(t, {
			".foundry/product.mjs": `import {readFileSync} from "node:fs";if(readFileSync("${dir}/keep","utf8")!=="retained")throw Error("lost checkpoint");`,
			[goalCheck]: `import {existsSync} from "node:fs";
				if(!existsSync("${dir}/editor/index.mjs")||!existsSync("${dir}/send/index.mjs"))process.exit(1);
				const edit=(await import("../${dir}/editor/index.mjs")).default, send=(await import("../${dir}/send/index.mjs")).default;
				if(send(edit("record"))!=="sent:record")process.exit(1);`
		});
		await f.start();
		const [core, pipeline] = f.scouts;
		await report(pipeline, ".foundry/right.md", [work("assembly", dir)]);
		const parent = [...f.workers.values()].at(-1); assert.ok(parent);
		await report(core, ".foundry/left.md", [work("preview", "engine/preview", ["assembly"])]);
		put(parent.cwd, `${dir}/keep`, "retained");
		put(parent.cwd, `${dir}/editor/obsolete`, "old editor");
		await f.write("assembly", "export default ()=>false;");
		await f.write("preview", "export default ()=>true;");
		const checkpoint = (await f.status()).products?.[0]; assert.ok(checkpoint?.receipt);
		await report(await f.reading("engine"), ".foundry/left.md", []);
		await report(await f.reading("pipeline"), `${dir}/keep`, [work("editor", `${dir}/editor`), work("send", `${dir}/send`)], conflict ? ["assembly"] : []);
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
			assert.match(String(result.blocker), /Concurrent modification.*pipeline\/assembly\/keep/);
		} else {
			assert.ok(result.qualified);
			assert.equal(result.goal?.receipt?.commit, result.qualified);
			assert.equal(result.products?.at(-1)?.receipt?.commit, result.qualified);
			assert.deepEqual(Object.keys(result.outputs ?? {}).sort(), ["editor", "send"]);
			assert.equal(git(f.root, "show", `${result.qualified}:${external}`), "target edit");
			assert.equal(git(f.root, "ls-tree", "-r", "--name-only", result.qualified, "--", `${dir}/editor`), `${dir}/editor/index.mjs`);
		}
	});

const assembly = "pipeline/assembly", assemblyBody = "export default ()=>true;", originalAssembly = "export default ()=>false;";
const splitAssembly = () => ["editor", "send"].map(id => work(id, `${assembly}/${id}`));

for (const pinned of [false, true]) test(`the assignment directory alone selects the writer's read source (explicit pin: ${pinned})`, async t => {
	const f = pipelineFixture(t, { [`${assembly}/index.mjs`]: originalAssembly, ".foundry/product.mjs": `import "../${assembly}/index.mjs";`,
		".foundry/right.md": "For maintenance, consult your own prior directory at the latest accepted or explicitly selected revision." });
	await f.start();
	await report(await f.reading("engine"), ".foundry/left.md", []);
	await report(await f.reading("pipeline"), ".foundry/right.md", [work("first", assembly)]);
	await f.write("first", assemblyBody);
	const checkpoint = (await f.status()).checkpoint; assert.ok(checkpoint);
	await report(await f.reading("pipeline"), ".foundry/right.md", [work("second", pinned ? `${f.tip}:${assembly}` : assembly)]);
	const n = (await f.status()).nodes.find(n => n.grain === "second"); assert.ok(n?.worker);
	const w = f.workers.get(n.worker); assert.ok(w);
	const revision = pinned ? f.tip : checkpoint;
	assert.equal(n.directory, assembly);
	assert.deepEqual(n.priorSource, { directory: assembly, revision, tree: git(f.root, "rev-parse", `${revision}:${assembly}`) });
	assert.ok(w.prompt.includes(`${revision}:${assembly}/`));
	assert.equal(git(w.cwd, "show", `${revision}:${assembly}/index.mjs`), pinned ? originalAssembly : assemblyBody);
	assert.equal(existsSync(path.join(w.cwd, assembly)), false);
	const body = git(w.cwd, "show", `${revision}:${assembly}/index.mjs`);
	await f.write("second", `${body}\n// maintained`);
	const next = (await f.status()).checkpoint; assert.ok(next && next !== checkpoint);
	assert.equal(git(f.root, "show", `${next}:${assembly}/index.mjs`), `${body}\n// maintained`);
});

test("a new directory starts empty and source metadata cannot authorize a sibling read", async t => {
	const sibling = "pipeline/other";
	const f = pipelineFixture(t, { [`${sibling}/prior`]: "not a declared input", ".foundry/right.md": "Generate from the interface only. Do not read prior implementation." });
	await f.start();
	await report(await f.reading("pipeline"), ".foundry/right.md", [work("new-unit", assembly), work("other", sibling)]);
	for (const n of (await f.status()).nodes) {
		const w = f.workers.get(text(n.worker, "writer")); assert.ok(w);
		assert.equal(n.baseline, undefined);
		if (n.directory === sibling) {
			assert.equal(n.priorSource?.directory, sibling);
			assert.match(w.prompt, /only if .*explicitly permits/i);
		} else {
			assert.equal(n.priorSource, undefined);
			assert.ok(!w.prompt.includes(`${f.tip}:${sibling}`));
		}
		assert.equal(existsSync(path.join(w.cwd, n.directory)), false);
	}
	assert.equal(f.workers.size, 2);
});

test("fixed directory pins require an exact commit and an existing directory", async t => {
	const f = fixture(t), p = policy(), g = p.grains[0];
	function save() { put(f.root, source, JSON.stringify(p)); git(f.root, "commit", "-qam", "select read source"); }
	for (const [directory, reason] of /** @type {[string,RegExp][]} */ ([
		["HEAD:lib/left", /full .*commit/], [`${f.tip}:lib/../right`, /Invalid repository path/],
		[`${"f".repeat(40)}:lib/left`, /local commit/], [`${f.tip}:lib/absent`, /No .*directory/]
	])) {
		g.directory = directory; save(); assert.throws(() => readPolicy(f.root, source), reason);
	}
	g.directory = `${f.tip}:lib/left`; save();
	const s = await f.start(), left = s.nodes.find(n => n.grain === "left");
	assert.equal(left?.directory, "lib/left"); assert.equal(left.priorSource?.revision, f.tip);
});

test("a bound writer reports missing input without replacing the checked inventory or holding eleven published outputs", async t => {
	const f = await assemblyRound(t, {
		".foundry/product.mjs": `import {readFileSync} from "node:fs"; if(readFileSync("${assembly}/accepted","utf8")!=="frozen citations") throw Error("lost inventory");`,
		[goalCheck]: `import {existsSync} from "node:fs"; process.exit(existsSync("${assembly}/new-journey") ? 0 : 1);`
	});
	const [first] = f.workers.values();
	put(first.cwd, `${assembly}/accepted`, "frozen citations"); put(first.cwd, `${assembly}/unaffected`, "preserve this row");
	await f.write("assembly", assemblyBody);
	const checkpoint = (await f.status()).products?.[0]; assert.ok(checkpoint);
	const ids = Array.from({ length: 11 }, (_, i) => `part-${i}`);
	await report(await f.reading("engine"), ".foundry/left.md", ids.map(id => work(id, `engine/${id}`)));
	await report(await f.reading("pipeline"), ".foundry/right.md", [work("inventory", assembly)]);
	for (const id of ids) await f.write(id, assemblyBody);
	const before = await f.status(), n = before.nodes.find(n => n.grain === "inventory"), w = f.workers.get(n?.worker ?? "");
	assert.ok(w); assert.deepEqual(n?.inputs, {}); assert.equal(n.state, "writing");
	assert.equal(before.nodes.filter(n => n.state === "published").length, 11);
	assert.equal(before.checkpoint, checkpoint.commit);
	assert.equal(existsSync(path.join(w.cwd, assembly)), false);
	const partial = `${assembly}/new-journey`;
	put(w.cwd, partial, "partial, not evidence");
	const writer = f.runtime(w.cwd), args = { run, token: w.token, missingInput: "No permitted source specifies the accepted journey, citations or unaffected rows." };
	await writer.operation("submit", args, w.id);
	const after = await f.status(), done = after.checkpoint, blocked = after.nodes.find(n => n.grain === "inventory");
	assert.ok(done && done !== checkpoint.commit);
	assert.deepEqual(after.products?.[0], checkpoint);
	assert.equal(git(f.root, "rev-parse", `${done}:${assembly}`), git(f.root, "rev-parse", `${checkpoint.commit}:${assembly}`));
	assert.equal(readFileSync(path.join(w.cwd, partial), "utf8"), "partial, not evidence");
	assert.deepEqual(Object.keys(after.outputs ?? {}).sort(), [...ids].sort());
	assert.equal(blocked?.state, "blocked"); assert.equal(blocked.worker, w.id); assert.ok(blocked.reason?.includes(args.missingInput));
	assert.equal(blocked.receipt, undefined); assert.equal(blocked.checked, undefined);
	const db = openDatabase(f.root); t.after(() => db.close());
	assert.ok(!db.read(run)?.effects.some(e => e.kind === "component" && e.grain === "inventory"));
	assert.equal(after.products?.at(-1)?.receipt?.exit, 0);
	assert.equal(after.goal?.receipt?.commit, done); assert.equal(after.goal.receipt.exit, 1); assert.equal(after.qualified, null);
	const checks = [...f.checks];
	await assert.rejects(f.runtime(w.cwd).operation("submit", args, w.id), /writable/);
	await assert.rejects(writer.operation("submit", { run, token: w.token }, w.id), /writable/);
	assert.deepEqual(f.checks, checks);
	assert.ok((await f.reading("pipeline")).prompt.includes(args.missingInput));

	// A later, independent checkpoint need not strand a stopped writer whose own tree is unchanged.
	const publish = { run, baselines: ["inventory"] };
	const tree = git(f.root, "rev-parse", `${checkpoint.commit}:${assembly}`);
	let consent = false, prompts = 0;
	const owner = f.runtime(f.root, { confirm: async prompt => {
		prompts++;
		for (const exact of [w.id, "inventory", checkpoint.commit, assembly, tree]) assert.ok(prompt.includes(exact));
		return consent;
	} });
	await assert.rejects(owner.operation("publish", publish, w.id), /owner/);
	await assert.rejects(owner.operation("publish", { run, baselines: ["inventory", "part-0"] }, "owner"), /missing.input/);
	await assert.rejects(owner.operation("publish", publish, "owner"), /not approved/);
	assert.equal((await f.status(w.id)).nodes[0].token, w.token);
	consent = true;
	await owner.operation("publish", publish, "owner");
	const resumed = (await f.status(w.id)).nodes[0];
	assert.equal(resumed.worker, w.id); assert.equal(resumed.state, "writing");
	assert.equal(resumed.repairs, 1); assert.notEqual(resumed.token, w.token);
	assert.deepEqual(resumed.baseline, { directory: assembly, revision: checkpoint.commit, tree });
	assert.deepEqual(f.checks, checks); assert.equal(existsSync(path.join(w.cwd, assembly, "accepted")), false);
	await assert.rejects(owner.operation("publish", publish, "owner"), /missing.input/);
	assert.equal(prompts, 2);
	await assert.rejects(writer.operation("submit", { run, token: w.token }, w.id), /assignment/);
	for (const file of ["index.mjs", "accepted", "unaffected"])
		put(w.cwd, `${assembly}/${file}`, git(f.root, "show", `${checkpoint.commit}:${assembly}/${file}`));
	assert.ok(resumed.token);
	await writer.operation("submit", { run, token: resumed.token }, w.id);
	const recovered = await f.status();
	assert.ok(recovered.qualified); assert.equal(recovered.goal?.receipt?.exit, 0);
	assert.equal(db.read(run)?.effects.filter(e => e.kind === "component" && e.grain === "inventory").length, 1);
});

for (const saved of [false, true]) test(`a stopped writer releases its exact directory to later reviewed work / ${saved ? "saved overlap" : "normal discovery"}`, async t => {
	const f = pipelineFixture(t, { ".foundry/product.mjs": "process.exit(0)" });
	await f.start();
	await report(await f.reading("engine"), ".foundry/left.md", [work("new-input", "engine/input")]);
	await report(await f.reading("pipeline"), ".foundry/right.md", [work("old-task", assembly)]);
	const old = (await f.status()).nodes.find(n => n.grain === "old-task");
	const w = f.workers.get(old?.worker ?? ""); assert.ok(w);
	if (saved) await f.write("old-task", "export default 17"); // A failed check and one inline repair before the stop.
	const token = (await f.status(w.id)).nodes[0].token; assert.ok(token);
	put(w.cwd, `${assembly}/unsubmitted`, "keep my work");
	await f.runtime(w.cwd).operation("submit", { run, token, missingInput: "No checked input for old behavior." }, w.id);
	await f.write("new-input", assemblyBody);
	const next = await f.reading("pipeline"), proposal = result(".foundry/right.md", [work("new-task", assembly, ["new-input"])]);
	await report(await f.reading("engine"), ".foundry/left.md", []);
	const scoutCount = f.scouts.length;
	const db = openDatabase(f.root); t.after(() => db.close());
	if (saved) {
		// Durable state written by reader 15 after a real workflow reported its proposal.
		db.update(run, r => {
			const e = reviews(r).find(r => r.id === next.id); assert.ok(e?.workflowId);
			e.observation = parseObservation(r.policy.squads[1], proposal); e.packet = next.packet;
			e.state = "blocked"; e.error = "Writable directories must be disjoint";
		});
		const recorded = db.read(run); assert.ok(recorded);
		for (const guard of ["uncertain launch", "live consumer", "same task", "unseen evidence", "changed checkpoint"]) {
			/** @type {import("./model.js").Run} */
			const copy = structuredClone(recorded);
			const e = reviews(copy).find(r => r.id === next.id);
			assert.ok(e?.observation && e.packet);
			const observation = e.observation, old = copy.nodes["old-task"], g = observation.grains[0]; assert.ok(typeof g !== "string");
			if (guard === "uncertain launch") {
				const launch = copy.effects.find(e => e.kind === "writer" && e.grain === "old-task"); assert.ok(launch);
				launch.state = "uncertain";
			} else if (guard === "live consumer") copy.nodes["new-input"].grain.needs.push("old-task");
			else if (guard === "same task") g.task = text(old.grain.task, "old task");
			else if (guard === "unseen evidence") delete e.packet.files[".foundry/right.md"];
			else { assert.ok(copy.goal); copy.goal.commit = f.tip; }
			assert.throws(() => observe(f.root, copy, e, observation), /disjoint|not delivered|changed during review/);
			assert.ok(!copy.nodes["new-task"] && !e.predecessor, guard);
		}
		const owner = f.runtime(f.root);
		owner.turn("owner"); await owner.flush(); await f.settle();
	} else await next.report(proposal);
	const s = await f.status(), successor = s.nodes.find(n => n.grain === "new-task");
	const decision = s.reviews.find(r => r.id === next.id);
	assert.equal(successor?.state, "writing", String(decision?.reason));
	assert.equal(decision?.predecessor?.worker, w.id);
	assert.equal(decision.predecessor.grain, "old-task");
	assert.equal(f.scouts.length, scoutCount, "the report is not replayed and the ownership transfer does not solicit another review");
	assert.equal(successor.review, next.id); assert.notEqual(successor.worker, w.id);
	assert.equal(s.nodes.some(n => n.grain === "old-task"), false);
	assert.equal(readFileSync(path.join(w.cwd, assembly, "unsubmitted"), "utf8"), "keep my work");
	await assert.rejects(f.runtime(w.cwd).operation("submit", { run, token }, w.id), /assignment/);
	assert.equal(f.workers.size, 3); assert.equal(s.qualified, null);
	assert.deepEqual(s.products?.at(-1)?.outputs, { "new-input": successor.inputs?.["new-input"] });
});

for (const issued of [false, true]) test(`a stopped writer's baseline distinguishes reserved and issued artifact notices: issued=${issued}`, async t => {
	const f = await assemblyRound(t, { [goalCheck]: `import ready from "../${assembly}/index.mjs";process.exit(ready() ? 0 : 1)` });
	const [w] = f.workers.values(), writer = f.runtime(w.cwd), db = openDatabase(f.root);
	t.after(() => db.close());
	const notice = () => db.read(run)?.effects.find(e => e.kind === "artifact");
	let entered = () => {}, release = () => {}, deliveries = 0, approvals = 0;
	const atNotice = new Promise(resolve => { entered = () => resolve(undefined); });
	const untilStop = new Promise(resolve => { release = () => resolve(undefined); });
	const publisher = f.runtime(f.root, {
		permissionBlocker: async () => {
			if (!issued && notice()?.state === "ready") { entered(); await untilStop; }
			return null;
		},
		execute: async (tool, args, id) => {
			if (tool === "send_session_message" && String(args.message).startsWith("Foundry artifact:")) {
				deliveries++; entered(); await untilStop; throw Error("Lost notice reply");
			}
			return f.execute(tool, args, id);
		},
	});
	const owner = f.runtime(f.root, { confirm: async () => { approvals++; return true; } });
	const grant = () => owner.operation("publish", { run, baselines: ["assembly"] }, "owner");
	const publish = publisher.operation("publish", { run, file: ".foundry/api.md", to: [assembly] }, "owner");
	try {
		await atNotice;
		assert.equal(notice()?.state, issued ? "issued" : "ready");
		const stopped = await writer.operation("submit", { run, token: w.token, missingInput: "Need the prior inventory." }, w.id);
		assert.equal(stopped.nodes.find(n => n.worker === w.id)?.state, "blocked");
		if (issued) await assert.rejects(grant(), { code: "stale_assignment" });
	} finally { release(); await publish; }
	assert.equal(deliveries, issued ? 1 : 0);
	if (issued) {
		const callId = notice()?.callId; assert.ok(callId);
		publisher.turn("owner"); await publisher.flush();
		assert.equal(notice()?.state, "uncertain"); assert.equal(notice()?.callId, callId);
		await assert.rejects(grant(), { code: "stale_assignment" });
		assert.equal(approvals, 0); assert.equal(deliveries, 1); return;
	}
	assert.equal(notice()?.callId, undefined);
	const recovered = await grant();
	assert.equal(approvals, 1); assert.ok(recovered.nodes.find(n => n.worker === w.id)?.baseline);
	await f.write("assembly", assemblyBody);
	assert.ok((await f.status()).qualified);
	assert.equal(notice()?.callId, undefined, "never replay the old notice under the new token");
});

test("a changed target during baseline approval leaves the missing-input writer stopped", async t => {
	const { f, nextCore, nextPipeline } = await assemblyCheckpoint(t);
	await report(nextCore, ".foundry/left.md", []);
	await report(nextPipeline, ".foundry/right.md", [work("inventory", assembly)]);
	const n = (await f.status()).nodes.find(n => n.grain === "inventory");
	const w = f.workers.get(n?.worker ?? ""); assert.ok(w);
	await f.runtime(w.cwd).operation("submit", { run, token: w.token, missingInput: "Need the accepted inventory." }, w.id);
	const before = (await f.status(w.id)).nodes[0], inbox = [...f.inbox];
	const owner = f.runtime(f.root, { confirm: async () => {
		put(f.root, `${assembly}/index.mjs`, "export default 23;");
		git(f.root, "commit", "-qam", "change inventory while approval is open");
		return true;
	} });
	await assert.rejects(owner.operation("publish", { run, baselines: ["inventory"] }, "owner"), /current unmet goal/);
	assert.deepEqual((await f.status(w.id)).nodes[0], before);
	assert.deepEqual(f.inbox, inbox);
});

test("a missing-input report needs the original writable attempt and cannot qualify a seeded run", async t => {
	const f = fixture(t, p => { p.seed = ["left"]; p.limits = { workers: 1, assignments: 1 }; });
	await f.start();
	const [w] = f.workers.values(), writer = f.runtime(w.cwd), args = { run, token: w.token, missingInput: "No permitted source." };
	await assert.rejects(writer.operation("submit", args, "owner"), /assignment/);
	await assert.rejects(writer.operation("submit", { ...args, token: "other" }, w.id), /assignment/);
	await assert.rejects(f.owner.operation("submit", args, w.id), /assigned native worktree/);
	await assert.rejects(writer.operation("submit", { ...args, usedArtifacts: [] }, w.id), /Unsupported field/);
	await assert.rejects(f.runtime(w.cwd, { runningHelpers: async () => ["active"] }).operation("submit", args, w.id), /helpers are still running/);
	await assert.rejects(f.runtime(w.cwd, { permissionBlocker: async () => ({ scope: "session", message: "Permission hold" }) }).operation("submit", args, w.id), /Permission hold/);
	await f.owner.operation("pause", { run }, "owner");
	await assert.rejects(writer.operation("submit", args, w.id), /paused/);
	await f.owner.operation("resume", { source }, "owner");
	assert.equal((await f.status()).nodes[0].state, "writing");
	await writer.operation("submit", args, w.id);
	const s = await f.status();
	assert.equal(s.nodes[0].state, "blocked");
	assert.equal(s.nodes[0].repairs, 0); assert.deepEqual(s.assignments, { limit: 1, used: 1 });
	assert.equal(s.qualified, null); assert.equal(s.products?.length, 0); assert.deepEqual(f.checks, []);
});

test("a missing-input report cannot retire an uncertain component check", async t => {
	const f = fixture(t, p => { p.seed = ["left"]; });
	await f.start();
	const [w] = f.workers.values();
	let calls = 0;
	const writer = f.runtime(w.cwd, { execute: async () => { calls++; throw Error("lost reply"); } });
	await writer.operation("submit", { run, token: w.token }, w.id);
	const before = await f.status();
	assert.equal(before.nodes[0].state, "checking"); assert.ok(before.pending.some(e => e.kind === "component" && e.state === "uncertain"));
	await assert.rejects(writer.operation("submit", { run, token: w.token, missingInput: "Cannot check it" }, w.id), /already submitted/);
	assert.equal(calls, 1); assert.deepEqual((await f.status()).nodes, before.nodes); assert.deepEqual((await f.status()).pending, before.pending);
});

/** @param {import("node:test").TestContext} t @param {Record<string,string>} [files] */
async function assemblyRound(t, files) {
	const f = pipelineFixture(t, { [`${assembly}/index.mjs`]: originalAssembly, ".foundry/product.mjs": `import "../${assembly}/index.mjs";`, ...files });
	await f.start();
	const [core, pipeline] = f.scouts;
	await report(core, ".foundry/left.md", []);
	await report(pipeline, ".foundry/right.md", [work("assembly", assembly)]);
	return f;
}

/** @param {import("node:test").TestContext} t @param {Record<string,string>} [files] */
async function assemblyCheckpoint(t, files) {
	const f = await assemblyRound(t, files);
	await f.write("assembly", assemblyBody);
	const nextCore = await f.reading("engine"), nextPipeline = await f.reading("pipeline");
	return { f, nextCore, nextPipeline };
}

for (const repeat of [false, true])
	test(`a current consumer pins its ${repeat ? "repeated" : "checkpoint"} input against both a repartition and a target edit`, async t => {
		const { f, nextCore, nextPipeline } = await assemblyCheckpoint(t);
		if (repeat) {
			await report(nextCore, ".foundry/left.md", []);
			await report(nextPipeline, `${assembly}/index.mjs`, ["assembly"]);
			await f.write("assembly", originalAssembly); // Reproduce the failed baseline, not the latest checkpoint.
		}
		const core = await f.reading("engine"), pipeline = await f.reading("pipeline");
		await report(core, ".foundry/left.md", [work("adapter", "engine/adapter", ["assembly"])]);
		const before = await f.status(), w = [...f.workers.values()].at(-1); assert.ok(w);
		const input = before.nodes.find(n => n.grain === "assembly");
		assert.ok(input?.checked);
		assert.equal(input.state, repeat ? "repeated" : "qualified");
		assert.equal(before.nodes.find(n => n.grain === "adapter")?.inputs?.assembly, input.checked);
		assert.equal(readFileSync(path.join(w.cwd, assembly, "index.mjs"), "utf8"), repeat ? originalAssembly : assemblyBody);
		await report(pipeline, `${assembly}/index.mjs`, splitAssembly());
		const denied = await f.status();
		assert.match(String(denied.reviews.find(r => r.id === pipeline.id)?.reason), /current assignment.*adapter/);
		assert.deepEqual(denied.nodes, before.nodes);
		put(f.root, `${assembly}/external`, "from target"); git(f.root, "add", assembly); git(f.root, "commit", "-qm", "change the checked input");
		f.owner.turn("owner"); await f.owner.flush();
		const blocked = await f.status();
		assert.match(String(blocked.blocker), /current assignment.*adapter/);
		assert.deepEqual(blocked.products, before.products);
		assert.equal(blocked.qualified, null);
		assert.equal((await f.status(w.id)).nodes[0].token, w.token);
	});

test("a target edit supersedes an unused repeated output even before the first checkpoint", async t => {
	const f = await assemblyRound(t);
	await f.write("assembly", originalAssembly);
	const stalled = await f.status();
	assert.equal(stalled.checkpoint, null);
	assert.equal(stalled.nodes[0].state, "repeated");
	put(f.root, `${assembly}/index.mjs`, assemblyBody); git(f.root, "commit", "-qam", "edit the repeated directory");
	f.owner.turn("owner"); await f.owner.flush();
	const moved = await f.status();
	assert.ok(moved.goal?.receipt, moved.blocker ?? "target edit was not assessed");
	assert.equal(moved.goal.receipt.exit, 1);
	assert.deepEqual(moved.nodes, []);
	assert.equal(moved.qualified, null);
	assert.equal(git(f.root, "show", `${moved.goal.receipt.commit}:${assembly}/index.mjs`), assemblyBody);
});

test("a deferred area repair waits for every pinned consumer, then asks once on the assessed checkpoint", async t => {
	const { f, nextCore, nextPipeline } = await assemblyCheckpoint(t, {
		[goalCheck]: `import assembly from "../${assembly}/index.mjs"; import {existsSync} from "node:fs";
			if (existsSync("engine/preview/index.mjs")) console.log("FOUNDRY_SQUAD=engine"); process.exit(assembly() === "fixed" ? 0 : 1);`
	});
	const evidence = `${assembly}/index.mjs`, proposal = { ...result(evidence, splitAssembly(), ["assembly"]), reason: "Repair the shared controls" };
	await report(nextCore, ".foundry/left.md", ["adapter", "preview"].map(id => work(id, `engine/${id}`, ["assembly"])));
	const before = await f.status();
	await nextPipeline.report(proposal);
	const held = await f.status(), source = held.reviews.find(r => r.id === nextPipeline.id);
	assert.equal(source?.state, "deferred");
	assert.deepEqual(source.observation, proposal);
	assert.match(String(source.reason), /adapter/); assert.match(String(source.reason), /preview/);
	assert.deepEqual(held.nodes, before.nodes);
	assert.deepEqual(held.products, before.products);
	await f.write("adapter", assemblyBody);
	await f.owner.operation("pause", { run }, "owner");
	await f.start(f.runtime(f.root));
	assert.equal(f.scouts.filter(s => s.squad === "pipeline").at(-1)?.id, nextPipeline.id);
	assert.equal((await f.status()).nodes.find(n => n.grain === "adapter")?.state, "published");
	await f.write("preview", assemblyBody);
	const released = await f.status(), fresh = await f.reading("pipeline");
	assert.notEqual(fresh.base, nextPipeline.base);
	assert.equal(fresh.base, released.goal?.receipt?.commit);
	assert.equal(released.reviews.find(r => r.id === fresh.id)?.wake?.review, nextPipeline.id);
	for (const detail of [proposal.reason, nextPipeline.base, evidence, ...splitAssembly().map(g => g.task)]) assert.ok(fresh.prompt.includes(detail), detail);
	assert.equal(f.workers.size, 3, "release reserves a scout, not the proposed writers");
	await report(fresh, evidence, [work("controls", assembly)]); // Different from the deferred split.
	const changed = await f.status();
	assert.deepEqual(changed.nodes.map(n => [n.grain, n.review]), [["controls", fresh.id]]);
	await nextPipeline.report(proposal);
	await f.write("controls", 'export default ()=>"fixed";');
	const done = await f.status();
	assert.ok(done.qualified); assert.deepEqual(Object.keys(done.outputs ?? {}), ["controls"]);
	assert.deepEqual(done.products?.slice(0, 2), released.products);
	assert.equal(done.reviews.filter(r => r.wake?.review === nextPipeline.id).length, 1);
});

test("a repair defers while an unissued dependent waits for the pinned consumer", async t => {
	const { f, nextCore, nextPipeline } = await assemblyCheckpoint(t);
	await report(nextCore, ".foundry/left.md", [work("b", "engine/b", ["assembly"]), work("c", "engine/c", ["b"])]);
	const before = await f.status(), b = before.nodes.find(n => n.grain === "b");
	assert.ok(b?.worker && b.inputs?.assembly);
	assert.equal(before.nodes.find(n => n.grain === "c")?.state, "waiting");
	const evidence = `${assembly}/index.mjs`;
	// A new proposal cannot name a retiring output as its own prerequisite.
	const db = openDatabase(f.root); t.after(() => db.close());
	const snapshot = db.read(run); assert.ok(snapshot);
	const original = structuredClone(snapshot);
	const pending = reviews(snapshot).find(r => r.id === nextPipeline.id); assert.ok(pending);
	const squad = snapshot.policy.squads.find(s => s.id === pending.squad); assert.ok(squad);
	for (const id of ["b", "c", "unknown"]) {
		const invalid = result(evidence, [work("changed", assembly, [id])], ["assembly"]);
		assert.throws(() => observe(f.root, snapshot, pending, parseObservation(squad, invalid)), new RegExp(`Unknown required output: ${id}`));
		assert.deepEqual(snapshot, original);
	}
	await report(nextPipeline, evidence, splitAssembly(), ["assembly"]);
	const held = await f.status(), review = held.reviews.find(r => r.id === nextPipeline.id);
	assert.equal(review?.state, "deferred", review?.reason ?? "repair was not deferred");
	assert.deepEqual(held.nodes, before.nodes);
	assert.deepEqual(held.products, before.products);
	await f.write("b", assemblyBody);
	const issued = await f.status();
	assert.equal(issued.nodes.find(n => n.grain === "c")?.inputs?.assembly, b.inputs.assembly);
	assert.equal(f.scouts.filter(s => s.squad === "pipeline").at(-1)?.id, nextPipeline.id);
	await f.write("c", assemblyBody);
	const fresh = await f.reading("pipeline"), released = await f.status();
	assert.equal(released.reviews.find(r => r.id === fresh.id)?.wake?.review, nextPipeline.id);
	assert.equal(fresh.base, released.checkpoint);
	assert.equal(f.workers.size, 3);
	await report(fresh, evidence, [work("revised", assembly)]);
	assert.deepEqual((await f.status()).nodes.map(n => [n.grain, n.state]), [["revised", "writing"]]);
});

for (const late of [false, true]) test(`a refused consumer releases its input, but not its refusal / ${late ? "checkpoint during review" : "same version"}`, async t => {
	const f = await assemblyRound(t);
	const adapter = work("adapter", "engine/adapter", ["assembly"]);
	let callId = "";
	const issuer = await f.write("assembly", assemblyBody, { execute: async (tool, args, id) => {
		if (tool !== "create_session" || !text(record(args.kickoff).prompt, "brief").includes("complete engine/adapter/")) return f.execute(tool, args, id);
		callId = id;
		return { resultType: "unconfirmed" };
	} });
	const core = await f.reading("engine"), pipeline = await f.reading("pipeline");
	await report(core, ".foundry/left.md", [adapter, work("parser", "engine/parser")]);
	await report(pipeline, `${assembly}/index.mjs`, splitAssembly());
	assert.match(String((await f.status()).reviews.find(r => r.id === pipeline.id)?.reason), /current assignment.*adapter/);
	issuer.refusal({ type: "permission.completed", data: { toolCallId: callId, result: { kind: "denied-interactively-by-user" } } }, core.issuer);
	await issuer.flush();
	const released = await f.reading("pipeline");
	assert.equal(released.base, pipeline.base);
	assert.equal((await f.status()).reviews.find(r => r.id === released.id)?.wake?.review, pipeline.id);
	if (!late) await report(released, `${assembly}/index.mjs`, []);
	f.owner.turn("owner"); await f.owner.flush();
	assert.equal(f.scouts.filter(s => s.squad === "pipeline").at(-1)?.id, released.id, "no second wake on the same version");
	await f.write("parser", assemblyBody);
	const before = await f.status(), engine = await f.reading("engine"), host = await f.reading("pipeline");
	if (late) {
		assert.ok(host.prompt.includes(pipeline.base) && host.prompt.includes(splitAssembly()[0].task), "the new checkpoint review retains the undecided proposal");
		await report(released, `${assembly}/index.mjs`, splitAssembly());
		assert.deepEqual((await f.status()).nodes, before.nodes, "the superseded release review cannot authorize a writer");
	}
	assert.equal(before.products?.length, 2);
	const denied = before.nodes.find(n => n.grain === "adapter");
	assert.match(String(denied?.reason), /permission refused/);
	assert.equal(denied?.inputs?.assembly, text(before.outputs?.assembly, "checkpoint input"));
	await report(engine, ".foundry/left.md", [adapter]);
	assert.match(String((await f.status()).reviews.find(r => r.id === engine.id)?.reason), /assigned grain/);
	await report(host, `${assembly}/index.mjs`, splitAssembly());
	const after = await f.status();
	assert.deepEqual(after.nodes.filter(n => n.state === "writing").map(n => n.grain), ["editor", "send"]);
	assert.deepEqual(after.nodes.find(n => n.grain === "adapter"), denied);
	assert.deepEqual(after.products, before.products);
	assert.equal(after.reviews.filter(r => r.wake?.review === pipeline.id && r.base === pipeline.base).length, 1);
	if (!late) assert.equal(host.prompt.includes(splitAssembly()[0].task), false, "a later checkpoint does not replay a consumed deferral");
	const db = openDatabase(f.root); t.after(() => db.close());
	assert.deepEqual(db.read(run)?.effects.filter(e => e.grain === "adapter").map(e => [e.callId, e.state]), [[callId, "refused"]]);
});

test("a repeated tree stays unmet and releases the parent for a different split on the same revision", async t => {
	const { f, nextCore: core, nextPipeline: pipeline } = await assemblyCheckpoint(t);
	const before = await f.status();
	await report(core, ".foundry/left.md", []);
	await report(pipeline, `${assembly}/index.mjs`, ["assembly"]);
	const writer = [...f.workers.values()].at(-1); assert.ok(writer);
	await f.write("assembly", assemblyBody);
	const stalled = await f.status();
	assert.equal(stalled.nodes.find(n => n.grain === "assembly")?.state, "repeated");
	assert.deepEqual(stalled.products, before.products);
	assert.deepEqual(stalled.goal, before.goal);
	assert.equal(stalled.qualified, null);
	const engine = await f.reading("engine"), host = await f.reading("pipeline");
	assert.notEqual(host.id, pipeline.id, "new evidence admits a new review, not a second result on the first");
	assert.equal(host.base, pipeline.base);
	assert.notEqual(stalled.reviews.find(r => r.id === pipeline.id)?.version, stalled.reviews.find(r => r.id === host.id)?.version);
	await report(engine, ".foundry/api.md", [work("parser", "engine/parser")]);
	await report(host, `${assembly}/index.mjs`, splitAssembly());
	assert.deepEqual((await f.status()).nodes.filter(n => n.state === "writing").map(n => n.grain).sort(), ["editor", "parser", "send"]);
	await assert.rejects(f.runtime(writer.cwd).operation("submit", { run, token: writer.token }, writer.id), /assignment/);
	await f.write("parser", assemblyBody); await f.write("editor", "export default text=>text;");
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
			const file = edit === "input" ? `${assembly}/external` : "target-note";
			const f = await assemblyRound(t, {
				[goalCheck]: `import {existsSync} from "node:fs"; process.exit(existsSync("${file}") && existsSync("engine/parser/index.mjs") ? 0 : 1);`
			});
			let call = "", denied = false, tip = f.tip, submitted = false;
			/** @type {Host["execute"]} */
			const execute = async (tool, args, id) => {
				if (tool !== "create_session" || !text(record(args.kickoff).prompt, "brief").includes("complete engine/adapter/")) return f.execute(tool, args, id);
				assert.equal(call, "", "never send a second start, even after reopening");
				call = id;
				return { resultType: "unconfirmed" };
			};
			/** @type {Partial<Host>} */
			const host = { execute, recover: async e => ({ resultType: e.callId === call && denied ? "denied" : "unconfirmed" }) };
			let issuer = await f.write("assembly", assemblyBody, host);
			const core = await f.reading("engine"), pipeline = await f.reading("pipeline");
			const writer = f.workers.get(core.issuer); assert.ok(writer);
			const before = await f.status(), db = openDatabase(f.root); t.after(() => db.close());
			await report(core, ".foundry/left.md", [work("adapter", "engine/adapter", ["assembly"]), work("parser", "engine/parser")]);
			await report(pipeline, ".foundry/right.md", []);
			put(f.root, "only-staged", "not in the product"); git(f.root, "add", "only-staged");
			for (const step of steps) {
				if (step === "edit") {
					put(f.root, file, "external"); git(f.root, "add", file); git(f.root, "commit", "-qm", "move target", "--", file);
					tip = git(f.root, "rev-parse", "main");
				} else if (step === "deny") {
					denied = true;
					issuer.refusal({ type: "permission.completed", data: { toolCallId: call, result: { kind: "denied-interactively-by-user" } } }, core.issuer);
					issuer.turn(core.issuer); await issuer.flush();
				} else if (step === "submit") {
					submitted = true;
					await f.write("parser", assemblyBody);
				} else {
					const held = await f.owner.operation("pause", { run }, "owner");
					issuer.close(); issuer = f.runtime(writer.cwd, host);
					issuer.turn(core.issuer); await issuer.flush();
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
			await f.settle();
			for (const r of (await f.status()).reviews.filter(r => r.state === "reading")) {
				const job = f.scouts.find(job => job.id === r.id); assert.ok(job);
				await report(job, r.squad === "engine" ? ".foundry/left.md" : ".foundry/right.md", []);
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
				const { f, nextCore: core, nextPipeline: pipeline } = await assemblyCheckpoint(t);
				const before = await f.status(), evidence = `${assembly}/index.mjs`, task = work("assembly", assembly);
				await report(core, ".foundry/left.md", []);
				await report(pipeline, evidence, ["assembly"]);
				await f.write("assembly", assemblyBody);
				if (phase === "backtrack") {
					await report(await f.reading("engine"), ".foundry/left.md", []);
					await report(await f.reading("pipeline"), evidence, [{ ...task, task: "Try a different implementation of assembly" }]);
					await f.write("assembly", assemblyBody); // The changed task also reproduces the exact failing tree.
				}
				await report(await f.reading("engine"), ".foundry/left.md", phase === "peer" ? [work("parser", "engine/parser")] : []);
				if (restart) {
					await f.owner.operation("pause", { run }, "owner");
					await f.runtime(f.root).operation("start", { source }, "owner");
				}
				const workers = f.workers.size, old = await f.status(), next = await f.reading("pipeline");
				await report(next, evidence, form === "id" ? ["assembly"] : [{ ...task, id: form === "rename" ? "relabeled" : task.id }], form === "replace" ? ["assembly"] : []);
				const rejected = await f.status(), review = rejected.reviews.find(r => r.id === next.id);
				assert.equal(review?.state, "blocked");
				assert.match(String(review.reason), /already reproduced/);
				assert.deepEqual(rejected.nodes, old.nodes);
				assert.equal(f.workers.size, workers);
				await report(next, evidence, splitAssembly());
				assert.deepEqual(await f.status(), rejected, "even a useful plan cannot replace a consumed result");
				assert.deepEqual(rejected.products, before.products);
			});
		}

for (const changed of [false, true])
	test(`factory matrix: delayed ${changed ? "changed" : "identical"} prerequisite on the same revision`, async t => {
		const dep = "engine/interface", parser = work("parser", dep), adapter = work("adapter", "pipeline/adapter", ["parser"]);
		const f = pipelineFixture(t, {
			[`${dep}/index.mjs`]: originalAssembly, "pipeline/adapter/index.mjs": originalAssembly,
			".foundry/product.mjs": 'import "../pipeline/adapter/index.mjs";',
			[goalCheck]: `import p from "../${dep}/index.mjs";import a from "../pipeline/adapter/index.mjs";process.exit(p() && a() ? 0 : 1);`
		});
		await f.start();
		const [core, pipeline] = f.scouts;
		await report(core, ".foundry/left.md", [parser]);
		await report(pipeline, ".foundry/right.md", [adapter]);
		await f.write("parser", originalAssembly); await f.write("adapter", originalAssembly);
		assert.deepEqual((await f.status()).nodes.map(n => n.state), ["repeated", "repeated"]);
		const first = [...f.workers.values()].at(-1); assert.ok(first);
		const current = await f.reading("pipeline");
		await report(await f.reading("engine"), ".foundry/left.md", [{ ...parser, task: "Implement the revised interface" }]);
		assert.ok(!(await f.status()).nodes.some(n => n.grain === "adapter"), "retire the consumer of the superseded parser");
		await report(current, ".foundry/right.md", [adapter]);
		const waiting = await f.status();
		assert.equal(waiting.reviews.find(r => r.id === current.id)?.state, "observed");
		assert.equal(waiting.nodes.find(n => n.grain === "adapter")?.state, "waiting");
		const workers = f.workers.size;
		await f.write("parser", changed ? assemblyBody : originalAssembly);
		const s = await f.status(), n = s.nodes.find(n => n.grain === "adapter"); assert.ok(n);
		assert.equal(s.qualified, null);
		await assert.rejects(f.runtime(first.cwd).operation("submit", { run, token: first.token }, first.id), /assignment/);
		if (changed) {
			assert.equal(n.state, "writing");
			assert.equal(f.workers.size, workers + 1);
			await f.write("adapter", assemblyBody);
		} else {
			assert.equal(f.workers.size, workers);
			assert.equal(n.generation, undefined, "do not reserve a second attempt");
			assert.match(String(n.reason), /already reproduced/);
			assert.equal(s.checkpoint, null);
			await report(await f.reading("pipeline"), ".foundry/right.md", [{ ...adapter, task: "Use the corrected interface" }], ["adapter"]);
			assert.equal((await f.status()).nodes.find(n => n.grain === "adapter")?.state, "writing");
		}
		if (changed) assert.ok((await f.status()).qualified);
	});

for (const resolve of ["refusal", "target"])
	test(`factory matrix: a prepared call under an input conflict / ${resolve}`, async t => {
		const f = await assemblyRound(t);
		const issuer = await f.write("assembly", assemblyBody, { execute: async (...args) => args[0] === "create_session" &&
			text(record(args[1].kickoff).prompt, "brief").includes("complete engine/adapter/") ?
			{ resultType: "failure", error: "This session management tool is disabled" } : f.execute(...args) });
		const core = await f.reading("engine"), pipeline = await f.reading("pipeline"), before = await f.status();
		await report(core, ".foundry/left.md", [work("adapter", "engine/adapter", ["assembly"])]);
		const reserved = await f.status(core.issuer);
		const [call] = reserved.prepared; assert.ok(call);
		await report(pipeline, ".foundry/right.md", []);
		put(f.root, `${assembly}/external`, "concurrent"); git(f.root, "add", assembly); git(f.root, "commit", "-qm", "move target");
		f.owner.turn("owner"); await f.owner.flush();
		const held = await f.status();
		assert.match(String(held.blocker), /current assignment.*adapter/);
		if (resolve === "target") {
			git(f.root, "revert", "--no-edit", "HEAD"); // Only this disposable repository.
			f.owner.turn("owner"); await f.owner.flush();
			assert.equal((await f.status()).blocker, undefined);
		}
		assert.deepEqual((await f.status(core.issuer)).prepared, [call], "the existing exact assignment is still deliverable");
		await issuer.pre(call.tool, call.arguments, core.issuer, "only-native-call");
		issuer.post("only-native-call", { resultType: "denied" }, core.issuer); await issuer.flush();
		const done = await f.status();
		assert.equal(done.target, git(f.root, "rev-parse", "main"));
		assert.deepEqual(done.products?.[0], before.products?.[0]);
		assert.equal(done.qualified, null);
		assert.equal(done.nodes.find(n => n.grain === "adapter")?.state, "blocked");
		assert.deepEqual((await f.status(core.issuer)).prepared, []);
	});

for (const cap of [undefined, 2])
	for (const firstScout of ["engine", "pipeline"])
		for (const firstWriter of ["editor", "recover"])
			for (const receipt of ["send", "joined product", "final goal"]) {
				if (!matrix && (cap !== 2 || firstScout !== "pipeline" || firstWriter !== "recover" || receipt !== "final goal")) continue;
				test(`factory matrix: fan-in ${cap ?? "uncapped"} / ${firstScout}-${firstWriter} / lost ${receipt}`, async t => {
					const policy = areaPolicy();
					policy.squads[1].areas = [`${assembly}/editor`];
					policy.squads.push({ ...policy.squads[1], id: "transport", areas: [`${assembly}/send`] });
					const f = pipelineFixture(t, { [source]: JSON.stringify({ ...policy, ...(cap ? { limits: { workers: cap } } : {}) }) });
					await f.start();
					const [core, pipeline] = f.scouts;
					const engine = () => report(core, ".foundry/left.md", [work("recover", "engine/recovery")]);
					const host = () => report(pipeline, ".foundry/right.md", [work("editor", `${assembly}/editor`)]);
					if (firstScout === "engine") await engine();
					await host();
					if (firstScout === "pipeline") await engine();
					const wire = async () => {
						const job = await f.reading("transport"), plans = [work("send", `${assembly}/send`, ["recover", "editor"])];
						await report(job, ".foundry/api.md", plans);
						await report(job, ".foundry/api.md", plans);
					};
					if (!cap) await wire();
					const initial = await f.status(), writers = initial.nodes.filter(n => n.state === "writing");
					assert.deepEqual(writers.map(n => n.grain).sort(), ["editor", "recover"]);
					const first = writers.find(n => n.grain === firstWriter), w = f.workers.get(text(first?.worker, "writer")); assert.ok(w);
					await f.write(firstWriter, 'export default ()=>null;');
					const repair = (await f.status(w.id)).nodes[0];
					assert.equal(repair.repairs, 1); assert.equal(repair.generation, first?.generation);
					await assert.rejects(f.runtime(w.cwd).operation("submit", { run, token: w.token }, w.id), /assignment/);
					for (const id of [firstWriter, firstWriter === "editor" ? "recover" : "editor"]) {
						if (cap && id !== firstWriter) await wire(); // Released writer slot admits the integration review.
						if (!cap || id !== firstWriter)
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
					assert.equal(f.workers.size, 3);
					assert.equal(f.checks.filter(c => c.startsWith("Check send at ")).length, 1);
				});
			}

for (const crash of ["none", "before", "after"])
	test(`factory matrix: two writer processes / exit ${crash} receipt`, async t => {
		const f = fixture(t, goal, goalFiles);
		await f.start(); await f.reportGrains("left"); await f.reportGrains("right");
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
	const f = pipelineFixture(t);
	await f.start();
	const [core, pipeline] = f.scouts, reading = ".foundry/left.md", host = ".foundry/right.md";
	const live = work("recover", "engine/recovery"), pending = work("abi", "engine/bindings", ["recover"]);
	await report(core, reading, [live, pending, work("probe", "engine/probe")]);
	await report(pipeline, host, [work("wire", "pipeline/wire", ["abi"])]);
	await f.write("probe", assemblyBody, { execute: async (...args) => String(args[1].description).startsWith("Check probe at ") ?
		{ resultType: "denied" } : f.execute(...args) });
	const next = await f.reading("engine");
	const before = await f.status();
	const db = openDatabase(f.root); t.after(() => db.close());
	// Explore alternative graph edits on the same real, unconsumed review, without issuing them.
	const graph = db.read(run); assert.ok(graph);
	const review = reviews(graph).find(r => r.id === next.id); assert.ok(review);
	const squad = graph.policy.squads.find(s => s.id === review.squad); assert.ok(squad);
	const snapshot = structuredClone(graph);
	for (const [proposals, replace, reason] of /** @type {Array<[typeof live[],string[],RegExp]>} */ ([
		[[work("escape", "pipeline/other")], [], /outside/],
		[[work("escape", `${f.tip}:pipeline/other`)], [], /outside/],
		[[work("missing", `${f.tip}:engine/absent`)], [], /No prior directory/],
		[[work("alias", `${f.tip}:engine/bindings`)], [], /disjoint/],
		[[{ ...work("exec", "engine/x"), check: "neighbor.txt" }], [], /component check/],
		[[work("alias", "engine/Bindings/next")], [], /disjoint/],
		[[work("cycle", "engine/c", ["abi"]), { ...pending, needs: ["cycle"] }], ["abi"], /cycle/],
		[[work("new", "engine/new")], ["abi"], /Unknown required output: abi/],
		[[work("new", "engine/new")], ["recover"], /never reserved/],
		[[work("new", "engine/new")], ["wire"], /Not your grain/],
		[[work("new", "engine/new", ["future"])], [], /Unknown required output: future/]
	])) {
		assert.throws(() => observe(f.root, graph, review, parseObservation(squad, result(reading, proposals, replace))), reason);
		assert.deepEqual(graph, snapshot, "reject the whole edit, including all proposed replacements");
	}
	assert.throws(() => observe(f.root, graph, review, parseObservation(squad, result("neighbor.txt", [work("new", "engine/new")]))), /outside this charter/);
	assert.deepEqual(graph, snapshot);
	assert.deepEqual(await f.status(), before);
	const helper = work("shim", "engine/bindings/shim"), narrowed = work("abi", "engine/bindings/abi", ["recover", "shim"]);
	await report(next, reading, [helper, narrowed], ["abi"]);
	const split = await f.status();
	const accepted = split.reviews.find(r => r.id === next.id);
	assert.equal(accepted?.state, "observed", accepted?.reason ?? "authorized pending split was not observed");
	assert.deepEqual(split.nodes.filter(n => n.state === "writing").map(n => n.grain), ["recover", "shim"]);
	assert.deepEqual(split.nodes.find(n => n.grain === "recover"), before.nodes.find(n => n.grain === "recover"));
	assert.deepEqual(split.nodes.find(n => n.grain === "abi")?.requires, ["recover", "shim"]);
	assert.deepEqual(split.nodes.find(n => n.grain === "wire")?.requires, ["abi"]);
	assert.equal(f.workers.size, 3);
});

test("owner resume can recover an unbound scout dispatch from a finished writer", async t => {
	const f = pipelineFixture(t);
	await f.start(); await f.reportGrains("engine", []);
	await report(await f.reading("pipeline"), ".foundry/right.md", [work("editor", "pipeline/assembly/editor")]);
	let ticket = "";
	const writer = await f.write("editor", "export default text=>text", { scout: async (_, dispatch) => {
		ticket = dispatch; throw Error("unbound scout launch");
	} });
	const failed = await f.status();
	assert.ok(ticket && failed.checkpoint);
	assert.ok(failed.pending.some(e => e.issuer === "worker-1" && e.state === "uncertain"));
	writer.close();
	await f.owner.operation("pause", { run }, "owner");
	const resumed = await f.start(), fresh = f.scouts.filter(s => s.base === failed.checkpoint);
	assert.deepEqual(fresh.map(s => s.id).sort(), failed.pending.map(e => e.id).sort());
	assert.ok(fresh.every(s => s.issuer === "owner" && s.dispatch !== ticket));
	await assert.rejects(f.owner.scoutBatch(run, ticket, "worker-1", "late-workflow"), { code: "foreign_assignment" });
	assert.deepEqual(resumed.assignments, failed.assignments); assert.equal(resumed.checkpoint, failed.checkpoint);
	assert.equal(f.workers.size, 1);
});

test("writer-owned paused discovery takes only its original session's remaining report", async t => {
	const f = pipelineFixture(t), workflow = "writer-checkpoint";
	await f.start(); await f.reportGrains("engine", []);
	await report(await f.reading("pipeline"), ".foundry/right.md", [work("editor", "pipeline/assembly/editor")]);
	let dispatch = "", issuer = "";
	const writer = await f.write("editor", "export default text=>text", { scout: async (id, ticket, actor) => {
		dispatch = ticket; issuer = actor;
		const [first, second] = await f.owner.scoutBatch(id, ticket, actor, workflow);
		assert.ok(second);
		await f.owner.scoutResult(id, ticket, actor, workflow, first.id,
			result(first.squad === "engine" ? ".foundry/left.md" : ".foundry/right.md", []), first.packet);
		return { runId: workflow, status: "paused" };
	} });
	await f.settle();
	writer.close();
	const owner = f.runtime(f.root, { scoutSnapshot: async () => assert.fail("Foreign workflow lookup"),
		resumeScout: async () => assert.fail("Foreign workflow resume") });
	const paused = await owner.operation("resume", { source }, "owner");
	const missing = paused.pending.find(e => e.issuer === issuer && e.kind === "scout");
	assert.ok(missing && missing.reason?.includes(workflow) && missing.reason.includes(issuer));
	await assert.rejects(owner.scoutBatch(run, dispatch, "owner", workflow), { code: "foreign_assignment" });
	const w = f.workers.get(issuer); assert.ok(w);
	const reopened = f.runtime(w.cwd);
	const jobs = await reopened.scoutBatch(run, dispatch, issuer, workflow);
	assert.deepEqual(jobs.map(j => j.id), [missing.id]);
	const [job] = jobs;
	await reopened.scoutResult(run, dispatch, issuer, workflow, job.id,
		result(job.squad === "engine" ? ".foundry/left.md" : ".foundry/right.md", []), job.packet);
	reopened.turn(issuer); await reopened.flush();
	assert.deepEqual((await f.status()).reviews.filter(r => r.workflowId === workflow).map(r => r.state), ["observed", "observed"]);
	assert.equal(f.workers.size, 1);
});

test("a paused workflow result survives an issuer reload and starts exactly one writer on confirmed resume", async t => {
	const f = fixture(t, goal, goalFiles), original = f.runtime(f.root);
	await f.start(original);
	const left = await f.reading("left");
	await f.reportGrains("right", []);
	await original.operation("pause", { run }, "owner");
	original.close();
	const reloaded = f.runtime(f.root);
	await deliver(reloaded, left, result(".foundry/left.md", ["left"]));
	const held = await f.status();
	assert.equal(held.active, false);
	assert.deepEqual(held.nodes, []);
	assert.equal(f.workers.size, 0);
	reloaded.turn("owner"); await reloaded.flush();
	assert.deepEqual((await f.status()).nodes, held.nodes);
	await f.start(reloaded);
	let resumed = await f.status();
	assert.equal(resumed.reviews.find(r => r.id === left.id)?.state, "observed");
	assert.equal(resumed.nodes[0].review, left.id);
	assert.equal(f.workers.size, 1);
	await deliver(reloaded, left, result(".foundry/left.md", []));
	assert.deepEqual(await f.status(), resumed);
	await f.submit("worker-1");
	resumed = await f.status();
	assert.ok(resumed.checkpoint);
	assert.equal(resumed.products?.[0].receipt?.commit, resumed.checkpoint);
	assert.equal(resumed.goal?.receipt?.commit, resumed.checkpoint);
	assert.equal(resumed.goal.receipt.exit, 1);
	assert.equal(resumed.qualified, null);
});

test("the product evaluator can attribute a bounded repair to a discovered directory after reload", async t => {
	const dir = "pipeline/delivery";
	const f = pipelineFixture(t, {
		[goalCheck]: `import {existsSync} from "node:fs";process.exit(existsSync("${dir}/index.mjs")?0:1);`,
		".foundry/product.mjs": `import deliver from "../${dir}/index.mjs";if(deliver()!=="sent"){
			const [id]=Object.entries(JSON.parse(process.env.FOUNDRY_OUTPUTS)).find(([,dir])=>dir==="${dir}");
			console.log("FOUNDRY_REPAIR="+id);process.exit(1);}`
	});
	await f.start();
	const [core, pipeline] = f.scouts;
	await report(core, ".foundry/left.md", [], []);
	await report(pipeline, ".foundry/right.md", [work("chosen-by-scout", dir)]);
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
	assert.equal(f.workers.size, 1);
});

test("area contracts conserve interfaces and check implementations, not a catalog of tasks", async t => {
	const f = pipelineFixture(t);
	const original = areaPolicy();
	for (const [invalid, error] of /** @type {Array<[object,RegExp]>} */ ([
		[{ ...original, seed: ["seed"] }, /Unsupported field/],
		[{ ...original, grains: [] }, /Unsupported field/],
		[{ ...original, goalCheck: undefined }, /final goal/],
		[{ ...original, squads: original.squads.map(s => ({ ...s, areas: ["pipeline"] })) }, /disjoint/],
		[{ ...original, squads: [{ ...original.squads[0], checks: ["engine/test.mjs"] }] }, /overlap/]
	])) {
		put(f.root, source, JSON.stringify(invalid)); git(f.root, "commit", "-qam", "invalid contract");
		assert.throws(() => readPolicy(f.root, source), error);
	}
	put(f.root, source, JSON.stringify(original)); git(f.root, "commit", "-qam", "restore contract");
	await f.start();
	const [core, pipeline] = f.scouts;
	put(f.root, unitCheck, "process.exit(0)"); git(f.root, "commit", "-qam", "replace permitted check");
	await report(core, ".foundry/left.md", [work("recover", "engine/recovery")]);
	await report(pipeline, ".foundry/right.md", []);
	const stale = await f.status();
	assert.deepEqual(stale.reviews.map(r => r.state), ["blocked", "blocked"]);
	assert.match(String(stale.blocker), /conserved contract changed/);
	assert.equal(f.workers.size, 0);
});

/** @param {ReturnType<typeof fixture>} f */
async function firstGoalWriter(f) {
	await f.reportGrains("left");
	await f.reportGrains("right", []);
	return "worker-1";
}

test("one goal activation checks a milestone, dispatches independent work on that tree, and stops only at the final result", async t => {
	const f = fixture(t, goal, goalFiles);
	const owner = f.owner;
	const start = await f.start(owner);
	assert.equal(start.qualified, null);
	assert.match(String(start.goal?.receipt?.output), /Left does not contribute one/);
	assert.equal(f.scouts.length, 2, "both charters can inspect the initial goal gap");
	assert.equal(f.workers.size, 0);
	await f.submit(await firstGoalWriter(f));
	const checkpoint = await f.status();
	assert.equal(checkpoint.qualified, null, "a passing product check is not goal acceptance");
	assert.ok(checkpoint.checkpoint);
	assert.equal(checkpoint.products?.[0].receipt?.exit, 0);
	assert.equal(checkpoint.goal?.receipt?.commit, checkpoint.checkpoint);
	assert.equal(checkpoint.goal.receipt.exit, 1);
	await f.settle();
	const fresh = f.scouts.slice(2);
	assert.equal(fresh.length, 2);
	for (const scout of fresh) {
		assert.equal(scout.base, checkpoint.checkpoint);
		assert.match(scout.prompt, /Left is ready; right does not contribute two/);
	}
	await f.reportGrains("left", []);
	await f.reportGrains("right");
	const writer = f.workers.get("worker-2");
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
	assert.equal(f.workers.size, 2);
	assert.equal(f.scouts.length, 4);
	assert.equal(git(f.root, "rev-parse", "main"), f.tip);
});

test("an already-good goal baseline passes both exact checks with a zero assignment limit", async t => {
	const f = fixture(t, p => { goal(p); p.limits = { assignments: 0 }; },
		{ ...goalFiles, "lib/left/index.mjs": "export default 1;", "lib/right/index.mjs": "export default 2;" });
	let notice;
	const done = await f.start(f.runtime(f.root, { notify: async message => { notice = message; return "delivered"; } }));
	assert.equal(done.qualified, f.tip);
	assert.equal(done.products?.[0].receipt?.commit, f.tip);
	assert.equal(done.goal?.receipt?.commit, f.tip);
	assert.equal(done.active, false);
	assert.equal(done.blocker, undefined);
	assert.deepEqual(done.assignments, { used: 0, limit: 0 });
	assert.match(String(notice), new RegExp(f.tip));
	assert.doesNotMatch(String(notice), /archive/i);
	assert.equal(f.scouts.length, 0);
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
	assert.equal(unseeded.workers.size, 0);
	assert.equal(unseeded.scouts.length, 1);
	assert.match(unseeded.scouts[0].prompt, /Left does not contribute one/);
	await unseeded.reportGrains("left", []);
	await unseeded.reportGrains("right", []);
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
	let attempts = 0;
	const owner = f.runtime(f.root, { execute: async (...args) => {
		if (args[0] === "create_session" && String(record(args[1].kickoff).prompt).includes("Generate the complete lib/left/")) {
			attempts++; return { resultType: "denied" };
		}
		return f.execute(...args);
	} });
	await f.start(owner);
	await f.reportGrains("left");
	const denied = await f.status();
	assert.equal(denied.nodes.find(n => n.grain === "left")?.state, "blocked");
	assert.equal(denied.blocker, undefined);
	assert.equal(denied.reviews.find(r => r.squad === "right")?.state, "reading");
	await f.reportGrains("right"); await f.submit("worker-1");
	const checked = await f.status();
	assert.ok(checked.checkpoint);
	assert.equal(checked.qualified, null);
	assert.equal(git(f.root, "show", `${checked.checkpoint}:lib/right/index.mjs`), "export default 2;");
	await f.reportGrains("left"); await f.reportGrains("right", []);
	assert.match(String((await f.status()).blocker), /permission refused/);
	assert.equal(attempts, 1);
	assert.equal(f.workers.size, 1);
});

for (const stage of ["baseline", "checkpoint", "moved target"])
test(`only an explicit resume retries missing external evidence: ${stage}`, async t => {
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
	await assert.rejects(owner.operation("resume", { source }, "stranger"), { code: "run_conflict" });
	assert.equal(f.checks.length, calls);
	const done = await owner.operation("resume", { source }, "owner");
	if (stage === "moved target") {
		assert.notEqual(done.qualified, checkpoint);
		assert.equal(git(f.root, "show", `${done.qualified}:neighbor.txt`), "a newer target");
		assert.equal(done.target, git(f.root, "rev-parse", "main"));
	} else assert.equal(done.qualified, checkpoint);
	assert.equal(done.goal?.receipt?.exit, 0);
	assert.equal(done.goal.receipt.commit, done.qualified);
	// Resume attaches acceptance to the same checkpoint; it does not recapture or re-evaluate it.
	const acceptedAt = done.metrics?.qualified.qualifiedAt;
	assert.ok(acceptedAt);
	assert.deepEqual(done.products?.slice(0, held.products?.length),
		held.products?.map(p => p.commit === done.qualified ? { ...p, qualifiedAt: acceptedAt } : p));
	assert.deepEqual(done.nodes, held.nodes);
	assert.equal(f.workers.size, stage === "baseline" ? 0 : 1);
	assert.equal(f.checks.length, calls + (stage === "checkpoint" ? 1 : 2));
	assert.deepEqual(db.read(run)?.effects.find(e => e.id === original.id), original);
});

for (const stopped of [false, true]) test(`managed hold during checked-product handoff: ${stopped ? "stopped goal" : "active one-off"}`, async t => {
	const f = fixture(t, stopped ? goal : p => { p.seed = ["left"]; }, { ...goalFiles,
		[goalCheck]: 'import {existsSync} from "node:fs"; process.exit(existsSync("lib/left/index.mjs") ? 0 : 1);' });
	await f.start();
	let hold = false, sent = 0;
	await f.submit(stopped ? await firstGoalWriter(f) : "worker-1", 1, {
		execute: async (tool, args, id) => {
			const result = await f.execute(tool, args, id);
			if (String(args.description).startsWith(stopped ? "Check final goal" : "Check joined product")) hold = true;
			if (tool === "send_session_message") sent++;
			return result;
		},
		permissionBlocker: async () => hold ? { scope: "run", message: "Managed permissions unavailable." } : null,
	});
	const s = await f.status();
	assert.ok(s.qualified); assert.equal(s.active, false); assert.equal(sent, 0);
	if (stopped) {
		assert.equal(s.blocker, undefined);
		assert.match(String(s.pending.find(e => e.kind === "handoff")?.reason), /next turn rechecks/);
	} else assert.match(String(s.blocker), /explicitly resume/);
});

for (const repeat of [false, true])
	test(`an unmet goal reports ${repeat ? "a repeated tree" : "a contract decision"} and does not retry the same work`, async t => {
		const f = fixture(t, goal, goalFiles);
		await f.start(); await f.submit(await firstGoalWriter(f));
		await f.reportGrains("left", repeat ? ["left"] : []);
		await (await f.reading("right")).report({ outcome: "needs-decision", ownerInput: "product-choice",
			reason: "Which right-hand value is authorized?", evidence: [goalCheck, ".foundry/right.md"], grains: [] });
		if (repeat) {
			const writer = f.workers.get("worker-2"); assert.ok(writer);
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

const immutableCheck = {
	".foundry/left.mjs": 'await import("../lib/left/index.mjs");',
	".foundry/product.mjs": 'await import("../lib/left/index.mjs");',
};
const stagesInExport = 'import {mkdirSync} from "node:fs"; mkdirSync("staging");';

// Keep the exact receipt shape written by pre-discriminator runners, before the
// scheduler sees it. The check itself still runs exclusively on the pinned export.
/** @param {ReturnType<typeof fixture>} f @param {ReturnType<typeof openDatabase>} db */
function priorRunner(f, db) {
	/** @type {Host["execute"]} */
	const execute = async (...args) => {
		const result = await f.execute(...args);
		db.update(run, r => {
			const e = r.effects.find(e => e.callId === args[2] && e.kind === "component");
			if (!e) return;
			assert.ok(e.receipt && e.state === "done");
			delete e.receipt.failure;
		});
		return result;
	};
	return execute;
}

for (const needs of [[], ["assembly"]]) test(`changed work on a later checkpoint requires the original pins: ${needs.join() || "independent"}`, async t => {
	const { f, nextCore, nextPipeline } = await assemblyCheckpoint(t, {
		[goalCheck]: 'import {existsSync} from "node:fs"; process.exit(existsSync("engine/adapter/index.mjs") ? 0 : 1);'
	});
	await report(nextCore, ".foundry/left.md", [work("adapter", "engine/adapter", needs)]);
	const db = openDatabase(f.root); t.after(() => db.close());
	const prior = await f.write("adapter", stagesInExport + assemblyBody, { execute: priorRunner(f, db) });
	prior.close();
	const adapter = (await f.status()).nodes.find(n => n.grain === "adapter"), w = f.workers.get(adapter?.worker ?? "");
	assert.ok(w);
	await report(nextPipeline, `${assembly}/index.mjs`, [work("controls", assembly)]);
	await f.write("controls", "export default ()=>42;");
	const checkpoint = await f.status();
	assert.ok(checkpoint.outputs?.controls && !checkpoint.outputs.assembly);
	assert.equal(checkpoint.goal?.receipt?.exit, 1);
	const writer = f.runtime(w.cwd);
	const node = (await writer.operation("status", { run }, w.id)).nodes[0];
	assert.equal(node.state, "blocked"); assert.ok(node.receipt);
	put(w.cwd, "engine/adapter/index.mjs", assemblyBody);
	const args = { run, token: w.token, changedFrom: node.receipt.commit };
	if (needs.length) {
		assert.equal(node.changedFrom, undefined);
		await assert.rejects(writer.operation("submit", args, w.id), /Pinned prerequisites no longer current: assembly@/);
		assert.deepEqual((await f.status()).nodes, checkpoint.nodes);
		const old = db.read(run)?.effects.filter(e => e.nativeId === w.id || e.issuer === w.id && e.kind === "component");
		const review = await f.reading("engine");
		const proposal = result(".foundry/left.md", [work("fresh-adapter", "engine/adapter", ["controls"])], ["adapter"]);
		for (const guard of ["refused", "uncertain", "older packet", "moved input", "limit"]) {
			const snapshot = db.read(run); assert.ok(snapshot);
			const r = reviews(snapshot).find(r => r.id === review.id), e = snapshot.effects.find(e => e.id === snapshot.nodes.adapter.check);
			const squad = snapshot.policy.squads.find(s => s.id === "engine"); assert.ok(r && e && squad);
			r.packet = structuredClone(review.packet);
			if (guard === "refused" || guard === "uncertain") e.state = guard;
			else if (guard === "older packet") r.version = "superseded";
			else if (guard === "moved input") delete r.packet.outputs.controls;
			else snapshot.policy.assignments = 0;
			assert.throws(() => observe(f.root, snapshot, r, parseObservation(squad, proposal)),
				/never reserved|fresh review|current pins|No assignment remains/);
			assert.equal(snapshot.nodes.adapter.worker, w.id);
		}
		await review.report(proposal);
		const planned = await f.status(), fresh = planned.nodes.find(n => n.grain === "fresh-adapter");
		assert.ok(fresh?.worker, planned.reviews.find(r => r.id === review.id)?.reason ?? "Missing fresh writer");
		assert.notEqual(fresh.worker, w.id);
		assert.deepEqual(fresh.inputs, { controls: checkpoint.outputs.controls });
		assert.ok(!planned.nodes.some(n => n.grain === "adapter"));
		assert.deepEqual(db.read(run)?.effects.filter(e => e.nativeId === w.id || e.issuer === w.id && e.kind === "component"), old);
		await assert.rejects(writer.operation("submit", args, w.id), /assignment/);
		await f.write("fresh-adapter", assemblyBody);
	} else {
		await writer.operation("submit", args, w.id);
	}
	assert.ok((await f.status()).qualified);
});

test("an exclusive post-check export violation returns one bounded repair to the same writer", async t => {
	const f = fixture(t, p => { p.seed = ["left"]; p.limits = { repairs: 1, assignments: 2 }; }, immutableCheck);
	await f.start();
	const [w] = f.workers.values(), writer = f.runtime(w.cwd);
	put(w.cwd, "lib/left/index.mjs", stagesInExport);
	const red = (await writer.operation("submit", { run, token: w.token }, w.id)).nodes[0];
	assert.equal(red.receipt && red.receipt.exit, null);
	assert.equal(red.receipt && red.receipt.output, "Unexpected path: staging");
	assert.equal(red.state, "writing");
	assert.equal(red.repairs, 1);
	assert.equal(red.worker, w.id);
	assert.notEqual(red.token, w.token);
	await assert.rejects(writer.operation("submit", { run, token: w.token }, w.id), /assignment/);
	put(w.cwd, "lib/left/index.mjs", "export default 1;");
	const green = await writer.operation("submit", { run, token: red.token }, w.id);
	assert.equal(green.nodes[0].state, "qualified");
	assert.ok((await f.status()).qualified);
	assert.equal(green.assignments?.used, 2);
	assert.equal(f.workers.size, 1);
	assert.equal(f.checks.length, 3);
});

test("a reloaded bound writer can present changed work, not replay a prior reader's blocked component check", async t => {
	const f = fixture(t, p => { p.seed = ["left"]; p.limits = { repairs: 1, assignments: 2 }; }, immutableCheck);
	await f.start();
	const [w] = f.workers.values(), db = openDatabase(f.root); t.after(() => db.close());
	const prior = f.runtime(w.cwd, { execute: priorRunner(f, db) });
	put(w.cwd, "lib/left/index.mjs", stagesInExport);
	await prior.operation("submit", { run, token: w.token }, w.id);
	prior.close();
	const writer = f.runtime(w.cwd);
	writer.turn(w.id); await writer.flush();
	const node = (await writer.operation("status", { run }, w.id)).nodes[0];
	assert.equal(node.state, "blocked");
	assert.equal(node.repairs, 0);
	assert.equal(node.receipt && node.receipt.output, "Unexpected path: staging");
	assert.ok(node.changedFrom && node.receipt && node.changedFrom === node.receipt.commit);
	const historical = db.read(run)?.effects.find(e => e.kind === "component");
	const args = { run, token: w.token, changedFrom: node.changedFrom };
	await assert.rejects(writer.operation("submit", args, "owner"), /assignment/);
	await assert.rejects(writer.operation("submit", args, w.id), /not be replayed/);
	await assert.rejects(writer.operation("submit", { ...args, changedFrom: f.tip }, w.id), /current blocked/);
	put(w.cwd, "lib/left/index.mjs", "export default 1;");
	await assert.rejects(writer.operation("submit", { run, token: w.token }, w.id), /no longer writable/);
	await assert.rejects(f.runtime(w.cwd, { permissionBlocker: async () => ({ scope: "session", message: "Permission unavailable" }) })
		.operation("submit", args, w.id), /Permission unavailable/);
	await assert.rejects(f.runtime(w.cwd, { runningHelpers: async () => ["one"] }).operation("submit", args, w.id), /helpers are still running/);
	await f.owner.operation("pause", { run }, "owner");
	await assert.rejects(writer.operation("submit", args, w.id), /paused/);
	await f.owner.operation("resume", { source }, "owner");
	assert.deepEqual(db.read(run)?.effects.find(e => e.kind === "component"), historical);
	assert.equal(f.checks.length, 1);
	const green = await writer.operation("submit", args, w.id);
	assert.equal(green.nodes[0].state, "qualified");
	assert.equal(green.nodes[0].repairs, 1);
	assert.equal(green.nodes[0].generation, node.generation);
	assert.equal(green.assignments?.used, 2);
	assert.equal(f.workers.size, 1);
	const checks = db.read(run)?.effects.filter(e => e.kind === "component");
	assert.ok(checks && historical);
	assert.equal(checks.length, 2);
	assert.deepEqual(checks[0], { ...historical, inlineRepair: green.nodes[0].token });
	assert.notEqual(checks[1].commit, checks[0].commit);
	assert.equal(checks[1].receipt?.exit, 0);
	assert.equal(f.checks.length, 3);
	await assert.rejects(writer.operation("submit", args, w.id), /assignment/);
});

for (const condition of ["repair limit", "assignment limit", "moved directory"]) test(`prior incomplete check does not bypass ${condition}`, async t => {
	const f = fixture(t, p => { p.seed = ["left"]; p.limits = { repairs: condition === "repair limit" ? 0 : 1, assignments: condition === "assignment limit" ? 1 : 2 }; }, immutableCheck);
	await f.start();
	const [w] = f.workers.values(), db = openDatabase(f.root); t.after(() => db.close());
	const prior = f.runtime(w.cwd, { execute: priorRunner(f, db) });
	put(w.cwd, "lib/left/index.mjs", stagesInExport);
	const blocked = (await prior.operation("submit", { run, token: w.token }, w.id)).nodes[0];
	prior.close();
	put(w.cwd, "lib/left/index.mjs", "export default 1;");
	if (condition === "moved directory") {
		put(f.root, "lib/left/old.mjs", "export default 27;");
		git(f.root, "commit", "-qam", "target edited the assigned directory");
	}
	await assert.rejects(f.runtime(w.cwd).operation("submit", { run, token: w.token, changedFrom: blocked.changedFrom }, w.id),
		condition === "moved directory" ? /directory .* changed/ : /No authorized repair/);
	const s = await f.status();
	assert.equal(s.nodes[0].state, "blocked");
	assert.equal(s.nodes[0].repairs, 0);
	assert.equal(s.assignments?.used, 1);
	assert.equal(f.checks.length, 1);
});

for (const mutate of [false, true]) test(`an interrupted evaluator cannot authorize export repair (mutation ${mutate})`, async t => {
	const f = fixture(t, p => { p.seed = ["left"]; }, immutableCheck);
	await f.start();
	const [w] = f.workers.values(), writer = f.runtime(w.cwd);
	put(w.cwd, "lib/left/index.mjs", `${mutate ? stagesInExport : ""}console.log("Unexpected path: staging");process.kill(process.pid, "SIGTERM");`);
	const n = (await writer.operation("submit", { run, token: w.token }, w.id)).nodes[0];
	assert.equal(n.state, "blocked");
	assert.equal(n.repairs, 0);
	assert.equal(n.changedFrom, undefined);
	assert.ok(n.receipt && n.receipt.failure === "incomplete");
	await assert.rejects(writer.operation("submit", { run, token: w.token, changedFrom: n.receipt.commit }, w.id), /current blocked/);
	assert.equal(f.checks.length, 1);
});

for (const conflict of [false, true]) test(`a frozen prior directory ${conflict ? "conflicts with an edit inside it" : "does not need reconciliation for a sibling edit"}`, async t => {
	const directory = "lib/left", f = fixture(t, undefined, { ".foundry/left.md": "Maintain the left output using its prior directory." });
	await f.start();
	const w = f.workers.get("worker-1"); assert.ok(w);
	const file = `${conflict ? directory : "lib/neighbor"}/concurrent`;
	put(f.root, file, "user work");
	git(f.root, "add", "lib");
	git(f.root, "commit", "-qm", "concurrent");
	const [n] = (await f.status(w.id)).nodes; assert.equal(n.priorSource?.revision, f.tip);
	put(w.cwd, `${directory}/old.mjs`, git(w.cwd, "show", `${n.priorSource.revision}:${directory}/old.mjs`));
	await f.submit("worker-1");
	await f.submit("worker-2");
	const s = await f.status();
	if (conflict) {
		assert.equal(s.qualified, null);
		assert.match(String(s.blocker), /Concurrent modification of lib\/left/);
		assert.equal(f.checks.length, 2);
	} else {
		assert.ok(s.qualified);
		assert.equal(git(f.root, "show", `${s.qualified}:${file}`), "user work");
		assert.equal(git(f.root, "show", `${s.qualified}:${directory}/old.mjs`), "export default 0;");
	}
	assert.equal(f.workers.size, 2);
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
	}), /Product changed: neighbor.txt/);
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

for (const other of [{ structuredContent: { project_session_id: "worker-one", session_id: "worker-two" } },
	{ structuredContent: { id: "worker-one" }, textResultForLlm: '{"id":"worker-two"}' }])
test(`conflicting native identities leave the original launch uncertain: ${Object.keys(other).join(", ")}`, async t => {
	const f = fixture(t, p => { p.seed = ["left"]; });
	let launches = 0;
	const owner = f.runtime(f.root, { execute: async () => {
		launches++; return { resultType: "success", ...other };
	} });
	await f.start(owner); owner.turn("owner"); await owner.flush();
	const s = await f.status();
	assert.equal(launches, 1); assert.equal(s.nodes[0].worker, undefined);
	assert.equal(s.pending[0].state, "uncertain"); assert.match(String(s.pending[0].reason), /Conflicting native worker identities/);
});

test("denying a prepared writer frees the only slot for another writer, without replay", async (t) => {
	const f = fixture(t, p => { p.limits = { workers: 1, assignments: 2 }; });
	const r = f.runtime(f.root, { execute: async (...args) => String(args[1].name).startsWith("left ") ?
		{ resultType: "failure", error: "This session management tool is disabled" } : f.execute(...args) });
	const s = await r.operation("start", { source }, "owner"), prepared = s.prepared[0];
	assert.ok(prepared);
	assert.deepEqual(s.assignments, { used: 1, limit: 2 });
	await assert.rejects(r.pre(prepared.tool, { ...prepared.arguments, base_branch: "main" }, "owner", "changed"), /prepared/i);
	await r.pre(prepared.tool, prepared.arguments, "owner", "native-1");
	await assert.rejects(r.pre(prepared.tool, prepared.arguments, "owner", "duplicate"), /prepared/i);
	const refusal = { type: "permission.completed", data: { toolCallId: "native-1", result: { kind: "denied-interactively-by-user" } } };
	r.refusal({ ...refusal, agentId: "nested" }, "owner");
	r.refusal(refusal, "peer");
	r.refusal({ ...refusal, data: { ...refusal.data, result: { kind: "approved" } } }, "owner");
	assert.deepEqual((await f.status()).assignments, s.assignments, "issuing the original prepared call costs no new assignment");
	assert.deepEqual((await f.status()).nodes.map(n => n.state), ["writing", "waiting"]);
	r.refusal(refusal, "owner");
	await r.flush();
	const stopped = await f.status();
	assert.deepEqual(stopped.assignments, { used: 2, limit: 2 }, "refusal frees a slot, not a reservation");
	assert.equal(stopped.nodes[0].state, "blocked");
	assert.match(String(stopped.nodes[0].reason), /permission refused/i);
	assert.equal(stopped.prepared.length, 0);
	await assert.rejects(r.pre(prepared.tool, prepared.arguments, "owner", "again"), /prepared/i);
	r.turn("owner");
	await r.flush();
	assert.deepEqual((await f.status()).nodes.map(n => [n.grain, n.state]), [["left", "blocked"], ["right", "writing"]]);
	assert.equal(f.workers.size, 1);
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
	const denied = f.runtime(f.root, { permissionBlocker: async () => ({ scope: "run", message: "Policy unavailable" }) });
	await assert.rejects(denied.operation("start", { source }, "owner"), { code: "permissions_unready" });
	assert.equal(existsSync(ledgerPath(f.root)), false);
});

test("charter scope, no-gap and cross-squad prerequisites use the same deliverable graph as a seed", async (t) => {
	const f = fixture(t, p => { delete p.seed; p.grains[1].needs = ["left"]; });
	const start = await f.start();
	assert.equal(start.nodes.length, 0);
	assert.equal(start.reviews.length, 2);
	for (const r of start.reviews) {
		assert.equal(r.state, "reading");
		assert.equal(r.base, f.tip);
		assert.ok(r.version);
		for (const key of ["worker", "token", "nextToken"]) assert.equal(Object.hasOwn(r, key), false);
	}
	const [left, right] = f.scouts;
	const claim = { outcome: "regenerate", reason: "right still exports zero", evidence: ["lib/right/old.mjs"], grains: ["right"] };
	await report(left, ".foundry/left.md", []);
	await right.report(claim);
	await right.report(claim);
	assert.equal(f.workers.size, 1);
	const producer = f.workers.get("worker-1");
	assert.ok(producer);
	assert.match(producer.prompt, /complete lib\/left/);
	await f.submit(producer.id);
	const next = await f.status();
	assert.equal(next.nodes.find(n => n.grain === "right")?.inputs?.left, next.nodes.find(n => n.grain === "left")?.checked);
	await f.submit("worker-2");
	assert.ok((await f.status()).qualified);
	await right.report({ ...claim, reason: "different decision" });
	assert.deepEqual((await f.status()).reviews.find(r => r.id === right.id)?.observation, claim);
	f.owner.turn("owner");
	await f.owner.flush();
	await f.settle();
	assert.equal(f.scouts.length, 4, "changed product inputs justify rediscovery");
	for (const job of f.scouts.slice(2)) await report(job, `.foundry/${job.squad}.md`, []);
	put(f.root, "neighbor.txt", "unrelated commit");
	git(f.root, "add", "neighbor.txt");
	git(f.root, "commit", "-qm", "neighbor only");
	f.owner.turn("owner");
	await f.owner.flush();
	await f.settle();
	assert.equal(f.scouts.length, 4, "unrelated target change is not a discovery signal");
	assert.equal(f.workers.size, 2);
});

const validClaim = { outcome: "regenerate", reason: "right has no export", evidence: [".foundry/right.md"], grains: ["right"] };
for (const [description, raw, reason] of /** @type {Array<[string,unknown,RegExp]>} */ ([
	["no result", null, /invalid|object/i],
	["missing outcome", { ...validClaim, outcome: undefined }, /outcome/],
	["unknown outcome", { ...validClaim, outcome: "unknown" }, /outcome/],
	["regenerate without grains", { ...validClaim, grains: [] }, /outcome/],
	["decision with grains", { ...validClaim, outcome: "needs-decision" }, /outcome/],
	["no-gap with grains", { ...validClaim, outcome: "no-gap" }, /outcome/],
	["missing evidence", { ...validClaim, evidence: [] }, /evidence/],
	["outside evidence", { ...validClaim, evidence: ["neighbor.txt"] }, /outside this charter/],
	["another squad's grain", { ...validClaim, grains: ["left"] }, /another squad/],
])) test(`an invalid workflow result is terminal: ${description}`, async t => {
	const f = fixture(t, p => { delete p.seed; });
	await f.start();
	const job = await f.reading("right");
	await job.report(raw);
	const before = await f.status(), r = before.reviews.find(r => r.id === job.id);
	assert.equal(r?.state, "blocked");
	assert.match(String(r.reason), reason);
	assert.deepEqual(before.nodes, []);
	assert.deepEqual(before.questions, []);
	await job.report(validClaim);
	assert.deepEqual(await f.status(), before);
	assert.equal(f.workers.size, 0);
});

test("a scout can raise a contract question without staffing work; only a fresh later report supersedes it", async t => {
	const f = fixture(t, p => { delete p.seed; p.grains[1].needs = ["left"]; }, { ".foundry/product.mjs": 'import "../lib/left/index.mjs";' });
	await f.start();
	const right = await f.reading("right");
	const question = { outcome: "needs-decision", ownerInput: "product-choice", reason: "Which behavior should right use from left?",
		evidence: [".foundry/right.md", ".foundry/left.md", "lib/left/old.mjs"], grains: [] };
	for (const [dispatch, issuer, workflowId, id] of [
		["not this dispatch", right.issuer, right.workflowId, right.id], [right.dispatch, "peer", right.workflowId, right.id],
		[right.dispatch, right.issuer, "different workflow", right.id], [right.dispatch, right.issuer, right.workflowId, "not a review"]
	]) await assert.rejects(f.owner.scoutResult(run, dispatch, issuer, workflowId, id, question), { code: "foreign_assignment" });
	await right.report(question);
	await right.report(question);
	await right.report({ ...question, outcome: "no-gap" });
	const reported = await f.status();
	assert.deepEqual(reported.questions, [{ squad: "right", base: f.tip, question: question.reason, evidence: question.evidence }]);
	assert.equal(reported.nodes.length, 0);
	assert.equal(f.workers.size, 0);
	await f.reportGrains("left");
	assert.equal((await f.status("worker-1")).questions, undefined);
	assert.deepEqual((await f.status("worker-1")).reviews, []);
	await f.submit("worker-1");
	assert.ok((await f.status()).qualified, "a question is not a veto on independently accepted work");
	f.owner.turn("owner");
	await f.owner.flush();
	assert.deepEqual((await f.status()).questions, [], "a superseded review is history, not a current operator question");
	put(f.root, "lib/right/old.mjs", "export default 3;");
	git(f.root, "commit", "-qam", "right changed while the scout was reading");
	await f.reportGrains("right", []);
	const stale = await f.status();
	assert.deepEqual(stale.questions, []);
	assert.deepEqual(stale.reviews.find(r => r.id === right.id)?.observation, question, "the original evidence is retained");
	assert.ok(stale.reviews.some(v => v.state === "blocked" && v.reason?.includes("inputs changed")));
	await f.reportGrains("right", []);
	const done = await f.status();
	assert.deepEqual(done.questions, []);
	assert.equal(done.reviews.find(v => v.id === right.id)?.observation?.outcome, "needs-decision");
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

test("independent starts overlap by default; a racing owner turn cannot issue them again", async (t) => {
	const f = fixture(t, addIndependent, extraCheck);
	let active = 0, peak = 0, total = 0;
	const owner = f.runtime(f.root, {
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
			const r=createRuntime(root,{mode:async()=>"interactive",permissionBlocker:async()=>null,execute:(_,args)=>{
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
	assert.equal(f.workers.size, 0);
	await f.reportGrains("left");
	const active = await f.status();
	assert.equal(active.reviews.filter(r => r.state === "reading").length, 2);
	assert.equal(active.nodes.find(n => n.grain === "left")?.state, "writing");
	assert.equal(active.limit, null);
});

test("resume cannot change the confirmed limits or fixed assignments", async t => {
	const f = fixture(t, p => { p.limits = { workers: 1, assignments: 2 }; });
	await f.start();
	await f.owner.operation("pause", { run }, "owner");
	delete f.p.limits;
	f.p.grains[0].directory = "other";
	put(f.root, source, JSON.stringify(f.p));
	git(f.root, "commit", "-qam", "change contract");
	await assert.rejects(f.start(), /conserved contract changed/i);
	assert.equal((await f.status()).limit, 1);
	assert.deepEqual((await f.status()).assignments, { used: 1, limit: 2 });
	assert.equal(f.workers.size, 1);
});

test("a fixed worker cap refills from a writer's check without an owner turn, including after resume", async t => {
	const f = fixture(t, p => { addIndependent(p); p.limits = { workers: 2 }; }, extraCheck);
	await f.start();
	await f.owner.operation("pause", { run }, "owner");
	const resumed = await f.start(f.runtime(f.root));
	assert.equal(resumed.limit, 2);
	assert.deepEqual(resumed.nodes.map(n => n.state), ["writing", "writing", "waiting"]);
	await f.submit("worker-2");
	assert.deepEqual((await f.status()).nodes.map(n => n.state), ["writing", "published", "writing"]);
	await f.submit("worker-3");
	await f.submit("worker-1");
	assert.ok((await f.status()).qualified);
	assert.equal((await f.status()).limit, 2);
	assert.equal(f.workers.size, 3);
});

test("a fixed cap drains an independent charter after its sibling writer frees the only slot", async t => {
	const f = fixture(t, p => { delete p.seed; p.limits = { workers: 1 }; });
	await f.start();
	assert.deepEqual(f.scouts.map(s => s.squad), ["left"]);
	await f.reportGrains("left");
	assert.equal(f.scouts.length, 1);
	await f.submit("worker-1");
	await f.settle();
	assert.deepEqual(f.scouts.map(s => s.squad), ["left", "right"]);
	await f.reportGrains("right");
	await f.submit("worker-2");
	assert.ok((await f.status()).qualified);
});

for (const seed of [true, false])
	test(`the total assignment limit bounds the first ${seed ? "writer" : "scout"} batch without a concurrency cap`, async t => {
		const f = fixture(t, p => { if (!seed) goal(p); p.limits = { assignments: 1 }; }, goalFiles);
		const start = await f.start();
		assert.equal(start.limit, null);
		assert.deepEqual(start.assignments, { used: 1, limit: 1 });
		assert.equal(f.scouts.length, seed ? 0 : 1);
		if (seed) await f.submit("worker-1");
		else await f.reportGrains("left");
		const stopped = await f.status();
		assert.equal(f.workers.size, seed ? 1 : 0);
		assert.equal(f.scouts.length, seed ? 0 : 1);
		assert.deepEqual(stopped.assignments, start.assignments);
		assert.match(String(stopped.blocker), /total assignment limit reached/i);
		assert.equal(stopped.qualified, null, "a missing seed or unmet goal cannot qualify");
	});

test("the total assignment limit admits late evidence, finishes in-flight checks and retains the unmet checkpoint", async t => {
	const f = pipelineFixture(t, { [source]: JSON.stringify({ ...areaPolicy(), limits: { assignments: 3 } }) });
	const start = await f.start();
	assert.deepEqual(start.assignments, { used: 2, limit: 3 }, "two charters in one workflow are two assignments");
	const [core, pipeline] = f.scouts;
	await report(pipeline, ".foundry/right.md", [work("editor", "pipeline/assembly/editor")]);
	await f.write("editor", "export default text=>text;", {
		execute: async (...args) => {
			if (String(args[1].description).startsWith("Check joined product")) {
				await report(core, ".foundry/left.md", [work("recover", "engine/recovery")]);
				assert.equal((await f.status()).pending.find(e => e.kind === "product")?.state, "issued");
			}
			return f.execute(...args);
		}
	});
	const stopped = await f.status();
	assert.match(String(stopped.blocker), /total assignment limit reached \(3\/3\)/i);
	assert.ok(stopped.checkpoint); assert.equal(stopped.qualified, null);
	assert.equal(stopped.products?.[0].receipt?.exit, 0);
	assert.equal(stopped.goal?.receipt?.commit, stopped.checkpoint);
	assert.equal(stopped.goal.receipt.exit, 1);
	assert.equal(stopped.nodes.find(n => n.grain === "recover")?.state, "waiting");
	await f.owner.operation("pause", { run }, "owner");
	const resumed = await f.start(f.runtime(f.root));
	assert.deepEqual(resumed.assignments, { used: 3, limit: 3 });
	assert.deepEqual(resumed.products, stopped.products);
	assert.deepEqual(resumed.reviews, stopped.reviews);
	assert.equal(f.workers.size, 1);
});

test("the total assignment limit charges a repair returned inline and preserves the next failed receipt", async t => {
	const f = fixture(t, p => { p.seed = ["left"]; p.limits = { assignments: 2, repairs: 4 }; });
	await f.start();
	const [writer] = f.workers.values();
	await assert.rejects(f.runtime(writer.cwd, { runningHelpers: async () => ["helper"] }).operation("submit", { run, token: writer.token }, writer.id),
		{ code: "helpers_running" });
	assert.deepEqual((await f.status()).assignments, { used: 1, limit: 2 }, "helpers and an unready submission are not assignments");
	const repair = await f.submit("worker-1", 0);
	assert.deepEqual(repair.assignments, { used: 2, limit: 2 });
	assert.equal(repair.nodes[0].state, "writing");
	assert.notEqual(repair.nodes[0].token, f.inbox[0].token);
	assert.equal(f.inbox.length, 1, "an inline repair is not a second message or session");
	await f.submit("worker-1", 0);
	const stopped = await f.status();
	assert.equal(stopped.nodes[0].state, "blocked");
	assert.equal(stopped.nodes[0].repairs, 1);
	const failed = stopped.nodes[0].receipt;
	assert.ok(failed); assert.equal(failed.exit, 1);
	assert.match(String(stopped.blocker), /total assignment limit reached \(2\/2\)/i);
	assert.equal(f.workers.size, 1);
});

test("a queued repair uses the last total assignment; a further attributed failure retains the checked join", async t => {
	const f = fixture(t, p => { p.limits = { assignments: 3, repairs: 4 }; },
		{ ".foundry/product.mjs": 'console.log("FOUNDRY_REPAIR=left");process.exit(1);' });
	await f.start();
	await f.submit("worker-1");
	await f.submit("worker-2");
	const repair = f.inbox.at(-1);
	assert.equal(repair?.worker, "worker-1");
	assert.notEqual(repair.token, f.inbox[0].token);
	assert.deepEqual((await f.status()).assignments, { used: 3, limit: 3 });
	await f.submit("worker-1");
	const stopped = await f.status();
	assert.equal(stopped.qualified, null);
	assert.equal(stopped.candidate?.receipt?.repair, "left");
	assert.equal(stopped.candidate?.receipt?.commit, stopped.candidate?.commit);
	assert.ok(stopped.nodes.every(n => n.receipt && n.receipt.exit === 0));
	assert.equal(stopped.nodes[0].repairs, 1);
	assert.match(String(stopped.blocker), /total assignment limit reached \(3\/3\)/i);
	assert.equal(f.inbox.length, 3);
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
	const effect = { id: "launch", issuer: "owner", kind: "writer", grain: "left", tool: "create_session", args: { name: "Write left" }, callId, state: "uncertain" };
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

test("an upgraded reader requires the original writer to reload before status or submission", async t => {
	const f = fixture(t);
	await f.start();
	const [w] = f.workers.values();
	const dir = mkdtempSync(path.join(tmpdir(), "foundry-install-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const installed = path.join(dir, "work");
	cpSync(new URL("./", import.meta.url), installed, { recursive: true });
	const version = path.join(installed, "reader.version");
	writeFileSync(version, "previous\n");
	/** Load a fresh session from the same installation, leaving the original one alive. @param {string} session */
	async function load(session) {
		/** @type {{createRuntime:typeof createRuntime}} */
		const copy = await import(`${pathToFileURL(path.join(installed, "runtime.mjs")).href}?${session}`);
		const runtime = copy.createRuntime(w.cwd, { mode: async () => "interactive", permissionBlocker: async () => null,
			execute: f.execute, notify: async () => assert.fail("unexpected notice") });
		t.after(() => runtime.close());
		return runtime;
	}
	const stale = await load("original");
	const status = await stale.operation("status", { run }, w.id);
	const node = status.nodes.find(n => n.token === w.token);
	assert.equal(node?.state, "writing");
	assert.ok(node);
	put(w.cwd, `lib/${node.grain}/index.mjs`, `export default ${grainIds.indexOf(node.grain) + 1};\n`);
	const file = ledgerPath(f.root), before = readFileSync(file);
	writeFileSync(version, "updated\n");
	const expected = { code: "stale_reader", message: /reload Foundry in this session.*status/i };
	await assert.rejects(stale.operation("status", { run }, w.id), expected);
	await assert.rejects(stale.operation("submit", { run, token: w.token }, w.id), expected);
	assert.deepEqual(readFileSync(file), before);
	const reloaded = await load("reloaded");
	assert.deepEqual(await reloaded.operation("status", { run }, w.id), status);
	const submitted = await reloaded.operation("submit", { run, token: w.token }, w.id);
	assert.equal(submitted.nodes.find(n => n.grain === node.grain)?.state, "published");
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
	await f.reportGrains("left", []);
	const db = openDatabase(f.root);
	t.after(() => db.close());
	const initial = db.read(run);
	assert.ok(initial);
	assert.throws(() => db.update(run, r => { r.active = false; throw Error("rollback"); }), /rollback/);
	assert.deepEqual(db.read(run), initial);
	const [review] = reviews(initial);
	const raw = new DatabaseSync(file);
	for (const broken of [
		{ ...initial, nodes: { left: { state: "finished-by-claim", repairs: 0 } } },
		{ ...initial, policy: { ...initial.policy, workers: 0 } },
		{ ...initial, policy: { ...initial.policy, assignments: -1 } },
		{ ...initial, policy: { ...initial.policy, assignments: 1 } }, // Fewer than the two reserved scouts.
		{ ...initial, capacity: { limit: 2, kept: false } }, // Obsolete mutable cap.
		{ ...initial, effects: initial.effects.map(e => e === review ? { ...e, observation: { ...review.observation, outcome: "needs-decision", grains: ["left"] } } : e) },
		{ ...initial, effects: initial.effects.map(e => e === review ? { ...e, observation: { reason: "missing outcome", evidence: [".foundry/left.md"], grains: [] } } : e) },
	]) {
		const doc = JSON.stringify(broken);
		raw.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(doc, checksum(doc), run);
		assert.throws(() => db.read(run), /Invalid Foundry execution snapshot/);
	}
	const mismatched = JSON.stringify({ ...initial, join: { target: f.tip, commit: f.tip, outputs: {}, check: review.id } });
	raw.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(mismatched, checksum(mismatched), run);
	assert.throws(() => db.read(run), /exact check reservation/);
	raw.close();
});

test("independent squad observations staff two writers and qualify a single combined product", async t => {
	const f = fixture(t, p => { delete p.seed; });
	await f.start();
	await f.reportGrains("left");
	await f.reportGrains("right");
	assert.equal(f.workers.size, 2, "both writers can start before either submits");
	assert.deepEqual((await f.status()).nodes.map(n => n.inputs), [{}, {}]);
	await f.submit("worker-1"); await f.submit("worker-2");
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
			await f.reportGrains("left");
			await f.reportGrains("right");
		}
		await f.submit("worker-1", 1, { execute: async () => ({ resultType: "denied" }) });
		await f.submit("worker-2");
		const s = await f.status();
		assert.equal(s.nodes.find(n => n.grain === "left")?.state, "blocked");
		assert.equal(Boolean(s.qualified), !seeded);
		assert.deepEqual(Object.keys(s.outputs ?? {}), seeded ? [] : ["right"]);
	});

test("a later observation adds to an unattributed failed product without rerunning its checked writer", async t => {
	const f = fixture(t, p => { delete p.seed; });
	await f.start();
	await f.reportGrains("left");
	await f.submit("worker-1");
	assert.match(String((await f.status()).blocker), /without identifying/);
	await f.reportGrains("right");
	await f.submit("worker-2");
	const s = await f.status();
	assert.ok(s.qualified);
	assert.equal(s.blocker, undefined);
	assert.equal(f.checks.filter(c => c.startsWith("Check left ")).length, 1);
	assert.equal(f.workers.size, 2);
});

test("a later blocked observation cannot reissue a denied check of the identical candidate", async t => {
	const f = fixture(t, p => { delete p.seed; });
	await f.start();
	await f.reportGrains("left");
	let productCalls = 0;
	/** @type {Host["execute"]} */
	const refuse = (...args) => {
		if (String(args[1].description).startsWith("Check left ")) return f.execute(...args);
		if (String(args[1].description).startsWith("Check joined product")) productCalls++;
		return Promise.resolve({ resultType: "denied" });
	};
	await f.submit("worker-1", 1, { execute: refuse });
	const held = (await f.status()).candidate;
	assert.ok(held);
	await f.reportGrains("right");
	await f.submit("worker-2", 2, { execute: refuse });
	const s = await f.status();
	assert.deepEqual(s.candidate, held);
	assert.match(String(s.blocker), /permission refused/);
	assert.equal(productCalls, 1);
});

test("a passing check on a frozen candidate cannot qualify work admitted while its reply is in flight", async t => {
	const f = fixture(t, p => { delete p.seed; }, { ".foundry/product.mjs": 'import "../lib/left/index.mjs";' });
	await f.start();
	await f.reportGrains("left");
	let oldCommit;
	await f.submit("worker-1", 1, { execute: async (...args) => {
		const result = await f.execute(...args);
		if (String(args[1].description).startsWith("Check joined product")) {
			oldCommit = (await f.status()).candidate?.commit;
			await f.reportGrains("right");
		}
		return result;
	} });
	assert.ok(oldCommit);
	assert.equal((await f.status()).qualified, null);
	await f.submit("worker-2");
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
			await f.reportGrains(id);
		assert.equal(f.workers.size, 1, "one active supplier for the shared prerequisite");
		await f.submit("worker-1");
		const before = await f.status();
		assert.ok(before.nodes.find(n => n.grain === "right")?.inputs?.left);
		await f.submit("worker-2");
		const s = await f.status();
		assert.ok(s.nodes.some(n => n.grain === "left" && n.repairs === 1 && n.state === "writing"));
		const old = f.workers.get("worker-2"), left = f.workers.get("worker-1");
		assert.ok(old && left);
		await assert.rejects(f.runtime(old.cwd).operation("submit", { run, token: old.token }, old.id), /assignment/i);
		put(left.cwd, "lib/left/ready", "fixed");
		await f.submit(left.id);
		const next = f.workers.get("worker-3");
		assert.ok(next);
		assert.equal(readFileSync(path.join(next.cwd, "lib/left/ready"), "utf8"), "fixed");
		await f.submit(next.id);
		const done = await f.status();
		assert.equal(done.products?.length, 1);
		assert.equal(git(f.root, "show", `${done.qualified}:lib/left/ready`), "fixed");
		assert.equal(f.workers.size, 3);
	});

test("a later product can repair a qualified input without changing the prior product or its receipt", async t => {
	const f = fixture(t, p => { delete p.seed; p.grains[1].needs = ["left"]; }, {
		".foundry/product.mjs": `import {existsSync} from "node:fs";
			if (existsSync("lib/right/index.mjs") && !existsSync("lib/left/ready")) { console.log("FOUNDRY_REPAIR=left");process.exit(1); }`
	});
	await f.start();
	await f.reportGrains("right", []);
	await f.reportGrains("left");
	await f.submit("worker-1");
	const qualified = (await f.status()).products?.[0];
	assert.ok(qualified?.receipt);
	f.owner.turn("owner");
	await f.owner.flush();
	await f.reportGrains("left", []);
	await f.reportGrains("right");
	await f.submit("worker-2");
	const left = f.workers.get("worker-1");
	assert.ok(left);
	put(left.cwd, "lib/left/ready", "fixed");
	await f.submit(left.id);
	await f.submit("worker-3");
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
	check(p => { p.limits = { assignments: -1 }; }, /total assignment limit/);
	check(p => { p.limits = { assignments: 1.5 }; }, /total assignment limit/);
	check(p => { p.limits = { repairs: -1 }; }, /repair limit/);
	assert.equal(existsSync(ledgerPath(f.root)), false);
});
