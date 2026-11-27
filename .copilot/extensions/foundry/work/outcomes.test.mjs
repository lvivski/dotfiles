import assert from "node:assert/strict";
import { pairedWork } from "../test/install.mjs";
import { execFile } from "node:child_process";
import { cpSync, existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { openDatabase } from "./database.mjs";
import { acceptOutcome, claimOutcome } from "./outcomes.mjs";
import { factory, put } from "../test/fixture.mjs";
import { resolveInputs } from "../../../skills/foundry/scripts/materialize.mjs";

test("a runner started before a ledger rollout preserves its exact outcome without reissuing the goal", async t => {
	const run = "rollout", source = ".foundry/rollout.json";
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 1, id: run, target: "refs/heads/main", direction: "Verify the whole product.",
			productCheck: "product.mjs", goalCheck: "goal.mjs",
			grains: [{ id: "item", directory: "item", specification: "spec", boundary: ["api"], check: "product.mjs" }],
			squads: [{ id: "builders", charter: "spec", grains: ["item"] }] }),
		spec: "Build it.", api: "Contract.", "product.mjs": "",
		"goal.mjs": `import { appendFileSync, existsSync } from "node:fs";
			import { setTimeout as wait } from "node:timers/promises";
			const gate = process.env.FOUNDRY_TEST_GATE;
			appendFileSync(gate + "/invocations", "goal\\n");
			while (!existsSync(gate + "/finish")) await wait(10);
			console.log("fixture: exact runner outcome");`
	});
	const gate = path.dirname(f.root), old = pairedWork(path.join(gate,"older-reader"));
	cpSync(new URL("./", import.meta.url), old, { recursive: true });
	// Model an older reader which accepts the launch snapshot but not a later valid record.
	renameSync(path.join(old, "snapshot.mjs"), path.join(old, "original.mjs"));
	put(old, "snapshot.mjs", `export * from "./original.mjs"; import {decode as current} from "./original.mjs";
		export function decode(value) { if (value.scheduling?.revision) throw Error("Invalid Foundry dispatch"); return current(value); }`);
	/** @type {Promise<{code:number,detail:string}>|undefined} */ let shell;
	let goals = 0;
	const owner = f.runtime(f.root, { execute: async (tool, args, actor) => {
		if (tool !== "bash" || !String(args.description).includes("final goal")) return f.execute(tool, args, actor);
		assert.equal(++goals, 1, "an issued check is never replayed");
		const effect = String(args.shellId).replace(/^foundry-/, "");
		shell = promisify(execFile)(process.execPath, [path.join(old, "runner.mjs"), f.root, run, effect],
			{ env: { ...process.env, FOUNDRY_TEST_GATE: gate }, timeout: 30_000 })
			.then(r => ({ code: 0, detail: r.stdout }), error => ({ code: Number(error.code), detail: String(error.stderr) }));
		return { resultType: "unconfirmed" };
	} });
	await f.start(owner);
	assert.ok(shell);
	let result;
	try {
		const end = Date.now() + 15_000;
		while (!existsSync(path.join(gate, "invocations"))) { assert.ok(Date.now() < end, "exclusive evaluator never started"); await wait(10); }
		await owner.operation("configure", { run, revision: 0, checkpointReviews: false }, "owner");
	} finally {
		put(gate, "finish", "");
		result = await shell;
	}
	const latest = f.runtime(f.root);
	latest.turn("owner"); await latest.flush();
	const s = await f.status();
	assert.equal(s.goal?.receipt?.exit, 0, result.detail);
	assert.equal(result.code, 0, result.detail);
	assert.match(s.goal.receipt.output, /fixture: exact runner outcome/);
	assert.equal(s.goal.receipt.commit, f.tip);
	assert.equal(s.goal.receipt.check, "goal.mjs");
	assert.equal(s.qualified, f.tip);
	assert.equal(f.checks.filter(check => check.includes("final goal")).length, 0, "the replacement reader never launches another goal");
	assert.equal(readFileSync(path.join(gate, "invocations"), "utf8"), "goal\n");
});

test("missing outcome stays unknown despite shell success; only the first exact runner receipt settles it", async t => {
	const run = "missing", source = ".foundry/missing.json";
	const f = factory(t, run, source, { [source]: JSON.stringify({version:2, id:run, target:"refs/heads/main",
		direction:"Verify delivery.", goalCheck:"goal.mjs", productCheck:"product.mjs",
		squads:[{id:"catalog",areas:["items"],charter:"spec",boundary:["api"],checks:["product.mjs"]}]}),
		api:"Keep stable.", spec:"Deliver the catalog.", "goal.mjs":"", "product.mjs":"" });
	let issues = 0;
	const shell = {resultType:"success", textResultForLlm:'FOUNDRY_GOAL_FEEDBACK="passed"', toolTelemetry:{metrics:{exit_code:0}}};
	const owner = f.runtime(f.root, { execute: async () => { issues++; return shell; }, recover: async () => shell });
	await f.start(owner);
	const db = openDatabase(f.root); t.after(() => db.close());
	const publish = db.mutateLocked(run, r => {
		const e = r.effects.find(e => e.kind === "goal"); assert.ok(e);
		return db.outcomeWriter(run, e);
	});
	const reloaded = f.runtime(f.root, { execute: async () => assert.fail("replayed check"), recover: async () => shell });
	reloaded.turn("owner"); await reloaded.flush();
	assert.equal((await f.status()).goal?.receipt, undefined);
	assert.equal((await f.status()).qualified, null);
	const inputs=resolveInputs(f.root,{commit:f.tip,check:"goal.mjs",scope:{kind:"goal"}});
	const receipt = {commit:f.tip, check:"goal.mjs", inputs,exit:2, output:"Exact original: evidence unavailable."};
	for (const mismatch of [{commit:"0".repeat(40)}, {check:"product.mjs"}, {evaluatorRevision:f.tip}])
		assert.throws(() => publish({...receipt, ...mismatch}), {code:"wrong_outcome"});
	assert.equal((await f.status()).goal?.receipt, undefined);
	publish(receipt); publish({...receipt});
	assert.throws(() => publish({...receipt, exit:0}), {code:"conflicting_outcome"});
	for (let n = 0; n < 2; n++) {
		reloaded.turn("owner"); await reloaded.flush();
		const s = await f.status();
		assert.deepEqual(s.goal?.receipt, receipt);
		assert.equal(s.qualified, null); assert.equal(issues, 1);
	}
});

test("the original claim cannot settle another run, call, reservation, or evaluator pin", () => {
	/** @type {import("./model.js").NativeCall} */
	const e = {id:"goal", callId:"call", issuer:"owner", kind:"goal", tool:"bash", attempt:{version:2}, args:{}, state:"issued",
		commit:"a".repeat(40), check:"goal.mjs", evaluatorRevision:"b".repeat(40)};
	const commit=e.commit??"",checker=/** @type {const} */ ({path:"goal.mjs",blob:"d".repeat(40),mode:"100644"});
	const bare={commit,check:"goal.mjs",evaluatorRevision:e.evaluatorRevision,exit:0,output:"ok"};
	const inputs=/** @type {import("./model.js").VerificationInputs} */ ({version:1,commit,checker,scope:{kind:"goal"},overlay:{revision:"b".repeat(40),paths:[]}});
	e.verification={version:1,use:"goal",grant:"1".repeat(64),contract:commit,target:commit,evaluation:{kind:"goal",squads:[]},steps:[{member:null,build:null,inputs}]};
	const claim=claimOutcome("run",e);
	assert.throws(()=>claim(bare),{code:"unproven_inputs"},"A new runner cannot sign a numeric verdict without observed inputs");
	const receipt={...bare,inputs};
	const {signature, document}=claim(receipt);
	assert.throws(() => claimOutcome("run", e), {code:"unissued_check"});
	assert.throws(() => acceptOutcome("other", e, signature, document), {code:"wrong_outcome"});
	assert.throws(() => acceptOutcome("run", e, signature, JSON.stringify({...receipt,output:"substituted"})), {code:"wrong_outcome"});
	assert.throws(() => acceptOutcome("run",e,signature,JSON.stringify({...receipt,inputs:{...inputs,checker:{...checker,mode:"100755"}}})),{code:"wrong_outcome"});
	for (const mismatch of [{id:"sibling"}, {callId:"peer"}, {issuer:"peer"}, {evaluatorRevision:"c".repeat(40)}])
		assert.throws(() => acceptOutcome("run", {...e, ...mismatch}, signature, document), {code:"wrong_outcome"});
	const reserved=e.verification;
	assert.throws(()=>acceptOutcome("run",{...e,verification:{...reserved,use:"subset"}},signature,document),{code:"wrong_outcome"});
	acceptOutcome("run", e, signature, document); assert.equal(e.state, "done"); assert.deepEqual(e.receipt, receipt);
});

test("a goal verdict cannot be signed for another checker or scope on the same named reservation",async t=>{
	const run="original-input",source=".foundry/input.json",evaluator="goal.mjs";
	const f=factory(t,run,source,{
		[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Publish one item.",goalCheck:evaluator,
			productCheck:"product.mjs",squads:[{id:"catalog",areas:["items"],charter:"spec",checks:["unit.mjs"]}]}),
		".foundry/input/journey.md":"Observe the published item.",spec:"One item.","product.mjs":"","unit.mjs":"", [evaluator]:"process.exit(0)\n",other:"process.exit(1)\n",
	});
	const issuer=f.runtime(f.root,{execute:async()=>({resultType:"unconfirmed"})});await f.start(issuer);
	const db=openDatabase(f.root);t.after(()=>db.close());
	const seal=db.mutateLocked(run,r=>{
		const e=r.effects.find(e=>e.id===r.goal?.check);assert.ok(e?.kind==="goal" && e.callId && !e.runnerClaim);
		return db.outcomeWriter(run,e);
	});
	const correct=resolveInputs(f.root,{commit:f.tip,check:evaluator,scope:{kind:"goal"}});
	const another=resolveInputs(f.root,{commit:f.tip,check:"other",scope:{kind:"goal"}});
	const original={commit:f.tip,check:evaluator,inputs:correct,exit:0,output:"original observation"};
	assert.throws(()=>seal({...original,inputs:{...correct,checker:{...correct.checker,blob:another.checker.blob}}}),
		{code:"wrong_outcome"},"the permission and the path alone cannot bind different evaluator bytes");
	assert.equal(db.read(run)?.effects.find(e=>e.kind==="goal")?.receipt,undefined);
	seal(original);
	const e=db.read(run)?.effects.find(e=>e.kind==="goal");assert.ok(e?.kind==="goal" && e.runnerClaim);db.verifySigned(run,e);
	assert.deepEqual(e.receipt,original);
});

test("a paired observation cannot be detached from the failed or retaining component, even on identical assembly bytes", () => {
	const pair={failed:"original",component:"passing",candidate:"a".repeat(40),retainer:"adjacent",
		checkpoint:"checkpoint",goal:"goal",target:"b".repeat(40),tree:"c".repeat(40)};
	/** @type {import("./model.js").NativeCall} */
	const e={id:"paired",callId:"native",issuer:"owner",kind:"component",grain:"leaf",tool:"bash",attempt:{version:2},args:{},state:"issued",
		commit:"d".repeat(40),check:"unit.mjs",pair};
	const commit="d".repeat(40);
	/** @type {import("./model.js").VerificationInputs} */
	const inputs={version:1,commit,checker:{path:"unit.mjs",mode:"100644",blob:"c".repeat(40)},scope:{kind:"component",grain:"leaf",directories:["leaf"],files:[]}};
	e.verification={version:1,use:"attestation",grant:"2".repeat(64),contract:commit,target:commit,evaluation:{kind:"component"},steps:[{member:null,build:null,inputs}]};
	const {signature,document}=claimOutcome("run",e)({commit,check:"unit.mjs",exit:1,output:"neighbor changed",inputs});
	for (const changed of [undefined,{...pair,failed:"other"},{...pair,component:"other"}])
		assert.throws(()=>acceptOutcome("run",{...e,pair:changed},signature,document),{code:"wrong_outcome"});
	acceptOutcome("run",e,signature,document);
	acceptOutcome("run",e,signature,document);
	assert.equal(e.receipt?.exit,1);
});
