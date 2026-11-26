import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { openDatabase } from "./database.mjs";
import { createRuntime } from "./runtime.mjs";
import { scoutDefinition } from "./scouts.mjs";
import { factory, git, loadEntry, put, withLedgerLock, recoveryClock } from "../test/fixture.mjs";
import { historicalFactory } from "../test/legacy-readers.mjs";

const run = "catalog", source = ".foundry/catalog.json";
/** @param {import("node:test").TestContext} t @param {string[]} [ids] @param {object} [policy] */
function trial(t, ids = ["price"], policy = {}) {
	const grains = ids.map(id => ({ id, directory: `src/${id}`, specification: "charter", boundary: ["interface"], check: "unit.mjs" }));
	return factory(t, run, source, {
		[source]: JSON.stringify({ version: 1, id: run, direction: "Look up the price of a product.", target: "refs/heads/main",
			grains, squads: ids.map(id => ({ id, charter: "charter", grains: [id] })), productCheck: "product.mjs", ...policy }),
		"goal.mjs": "process.exit(1)",
		charter: "Own the requested directory.", interface: "Return a decimal price.", "unit.mjs": "", "product.mjs": "",
	});
}
const noGap = { outcome: "no-gap", reason: "Nothing to change here.", evidence: ["charter"], grains: [] };

for (const phase of ["disjoint live target","overlapping writer directory","recover saved report","recover paused issuer"]) test(`operator merge during checkpoint discovery / ${phase}`, async t => {
	const mixed=phase==="recover paused issuer", saved=phase==="recover saved report";
	const make=mixed || saved ? await historicalFactory(t,64) : factory;
	const goal=`import {existsSync as has} from "node:fs";
		if (!has("loader/ready")) { console.log('FOUNDRY_BLOCKERS=[{"id":"view","directory":"panel/view","blocked":1}]');process.exit(1); }
		if (!has("panel/view/ready")) process.exit(2);`;
	const f=make(t,run,source,{[source]:JSON.stringify({version:2,id:run,direction:"Open the catalog.",target:"refs/heads/main",
		goalCheck:"goal.mjs",productCheck:"product.mjs",squads:["loader","panel"].map(id=>({id,areas:[id],charter:`${id}.md`,checks:["unit.mjs"]}))}),
		".foundry/catalog/journey.md":"Open the catalog.","loader.md":"Load it.","panel.md":"Display it.","unit.mjs":"","product.mjs":"","goal.mjs":goal});
	const propose=(/** @type {string} */ id,/** @type {string} */ directory)=>({outcome:"regenerate",evidence:[`${id}.md`],reason:`Build ${id}.`,
		grains:[{id,directory,task:`Build ${id}.`,check:"unit.mjs",needs:id==="loader"?[]:["loader"]}]});
	await f.start();
	for (const s of [...f.scouts]) await s.report(s.squad==="loader" ? propose("loader","loader") : {...noGap,evidence:["panel.md"]});
	const [loader]=f.workers.values(); let held=false;
	const policy=async()=>held ? {scope:/** @type {const} */("run"),message:"Managed settings unresolved."} : null;
	const issuer=f.runtime(loader.cwd,{permissionBlocker:policy,execute:async(tool,args,id)=>{
		const result=await f.execute(tool,args,id);
		if (mixed && String(args.description).startsWith("Check final goal")) held=true;
		return result;
	}});
	put(loader.cwd,"loader/ready","loaded");
	await issuer.operation("submit",{run,token:loader.token},loader.id); await f.settle();
	const old=await f.owner.operation("status",{run,detail:"proof"},"owner"), review=old.reviews.find(r=>r.lead);
	assert.ok(review && old.checkpoint && old.goal?.receipt?.exit===2);
	const receipts=old.goalChecks, count=f.checks.length;
	assert.equal(old.active,!mixed);
	if (mixed) {
		const job=old.pending.find(e=>e.id===review.id);
		assert.ok(job?.state==="ready" && job.issuer===loader.id && !review.workflowId && job.reason?.includes("Managed"));
	}
	put(f.root,"operator.txt","keep me");
	if (phase==="overlapping writer directory") put(f.root,"panel/view/ready","operator work");
	if (mixed) for (const file of ["panel.md","unit.mjs","goal.mjs","product.mjs"]) put(f.root,file,"throw Error('not the pinned contract')");
	git(f.root,"add","."); git(f.root,"commit","-qm","Operator change");
	const owner=f.runtime(f.root,{},createRuntime), proof=()=>owner.inspect({run,detail:"proof"},"owner");
	if (mixed) {
		await assert.rejects(f.owner.operation("resume",{source},"owner"),/conserved contract changed/);
		assert.equal(proof().active,false);
		git(f.root,"rm","-q",source); git(f.root,"commit","-qm","Remove the old plan from the new target");
		await owner.operation("resume",{source},"owner");
		assert.equal(proof().active,true);
		const fresh=f.runtime(loader.cwd,{permissionBlocker:policy},createRuntime);
		fresh.turn(loader.id); await fresh.flush();
		assert.equal(proof().active,false,"the original issuer's unresolved policy must still stop dispatch");
		assert.equal(f.scouts.filter(s=>s.id===review.id).length,0);
		held=false; await owner.operation("resume",{source},"owner");
		fresh.turn(loader.id); await fresh.flush(); await f.settle();
	}
	const moved=git(f.root,"rev-parse","HEAD");
	const scout=f.scouts.find(s=>s.id===review.id); assert.ok(scout);
	assert.equal(scout.issuer,loader.id); assert.equal(scout.base,old.checkpoint);
	let deciding=scout;
	if (mixed) {
		await scout.report({outcome:"needs-evidence",reason:"Read the failing step.",evidence:["panel.md"],receipt:review.lead?.receipt,grains:[]});
		deciding=f.scouts.at(-1) ?? assert.fail("missing follow-up");
		assert.equal(deciding.packet.read?.source,`receipt:${review.lead?.receipt}`);
	}
	await deciding.report(propose("panel","panel/view")); await owner.flush(); await f.settle();
	if (saved) {
		assert.match(proof().reviews.find(r=>r.id===review.id)?.reason ?? "",/changed during review/);
		assert.equal(f.workers.size,1);
		owner.turn("owner"); await owner.flush();
	}
	const worker=f.workers.get(proof().nodes.find(n=>n.grain==="panel")?.worker ?? "");
	assert.ok(worker,"the original checkpoint reservation must still staff its writer");
	assert.deepEqual(proof().goalChecks,receipts); assert.equal(f.checks.length,count);
	put(worker.cwd,"panel/view/ready","from original assignment");
	await f.runtime(worker.cwd,{},createRuntime).operation("submit",{run,token:worker.token},worker.id);
	if (phase==="overlapping writer directory") {
		const stop=proof();
		assert.equal(stop.qualified,null); assert.deepEqual(stop.goalChecks,receipts); assert.equal(stop.checkpoint,old.checkpoint);
		assert.match(stop.blocker ?? stop.nodes.find(n=>n.grain==="panel")?.reason ?? "",/panel\/view/);
		assert.equal(git(f.root,"show","main:panel/view/ready"),"operator work"); return;
	}
	if (mixed) {
		const blocked=proof();
		assert.equal(blocked.qualified,null); assert.equal(blocked.checkpoint,old.checkpoint);
		assert.equal(blocked.nodes.find(n=>n.grain==="panel")?.state,"published");
		assert.match(blocked.blocker ?? "",/goal\.mjs/);
		assert.deepEqual(blocked.goalChecks,receipts); assert.equal(f.checks.length,count+1);
		assert.equal(git(f.root,"rev-parse","main"),moved);
		git(f.root,"restore","--source",f.tip,"--staged","--worktree","--",source,"panel.md","unit.mjs","goal.mjs","product.mjs");
		git(f.root,"commit","-qm","Reconcile the contract without reverting the operator merge");
		owner.turn("owner"); await owner.flush();
	}
	const end=proof(); assert.ok(end.qualified && end.goal?.receipt?.commit===end.qualified);
	assert.equal(end.target,git(f.root,"rev-parse","main")); assert.equal(git(f.root,"show",`${end.qualified}:operator.txt`),"keep me");
	assert.equal(git(f.root,"show",`${end.qualified}:panel/view/ready`),"from original assignment");
	assert.deepEqual(end.goalChecks?.slice(0,receipts?.length),receipts);
	assert.equal(f.checks.length,count+3); assert.equal(f.scouts.filter(s=>s.id===review.id).length,1);
});

test("resume disambiguates existing runs by source and owner without accepting a replacement contract", async t=>{
	const f=trial(t);
	await f.start();
	const previous=JSON.parse(git(f.root,"show",`HEAD:${source}`));
	put(f.root,source,JSON.stringify({...previous,id:"later"})); git(f.root,"commit","-qam","Start a separately named run");
	await f.owner.operation("start",{source},"owner");
	await assert.rejects(f.owner.operation("resume",{source},"owner"),/Multiple owned runs/);
	await assert.rejects(f.owner.operation("resume",{source:".foundry/other.json",run:"later"},"owner"),{code:"run_conflict"});
	await assert.rejects(f.owner.operation("resume",{source,run:"later"},"stranger"),{code:"run_conflict"});
	await assert.rejects(f.owner.operation("resume",{source,run},"owner"),/conserved contract changed/);
	const count=f.scouts.length;
	assert.equal((await f.owner.operation("resume",{source,run:"later"},"owner")).run,"later");
	assert.equal(f.scouts.length,count);
});

test("a reader upgrade automatically staffs the stranded charter once, without replaying its batch", async t => {
	const f = trial(t, ["browse", "price"], { goalCheck: "goal.mjs" });
	const install = path.join(path.dirname(f.root), "install");
	cpSync(new URL("./", import.meta.url), install, { recursive: true });
	const { createRuntime } = await import(pathToFileURL(path.join(install, "runtime.mjs")).href);
	/** @type {typeof f.owner} */
	const old = createRuntime(f.root, { mode: async () => "interactive", permissionBlocker: async () => null, execute: f.execute,
		scout: (/** @type {string} */ id, /** @type {string} */ dispatch, /** @type {string} */ actor) =>
			f.owner.scoutBatch(id, dispatch, actor, "original").then(() => new Promise(() => {})) });
	t.after(() => old.close());
	const started = await f.start(old), [sibling, original] = started.reviews;
	const db = openDatabase(f.root); t.after(() => db.close());
	const dispatch = db.read(run)?.effects.find(e => e.id === original.id)?.callId; assert.ok(dispatch);
	const [done, interrupted] = await old.scoutBatch(run, dispatch, "owner", "original");
	await old.scoutResult(run, dispatch, "owner", "original", done.id, noGap, done.packet);
	await old.flush();
	put(install, "reader.version", "upgraded\n");
	let nativeError = "";
	await assert.rejects(old.scoutResult(run, dispatch, "owner", "original", interrupted.id, noGap, interrupted.packet), error => {
		assert.ok(error instanceof Error && "code" in error && error.code === "stale_reader");
		nativeError = `Request workflow.execute failed with message: ${error.message}`; return true;
	});
	old.close();
	// Reconcile the terminal envelope before the issuer can dispatch new work. The
	// resulting blocked record is also the on-disk shape left by older installations.
	let mode = "interactive";
	const reconciler = f.runtime(f.root, { mode: async () => mode, scoutState: async id => {
		assert.equal(id, "original"); mode = "plan"; return {runId:id, status:"error", error:nativeError};
	} });
	reconciler.turn("owner"); await reconciler.flush(); await f.settle();
	const before = await f.status();
	assert.deepEqual(before.reviews.map(r => [r.id, r.state]), [[sibling.id,"observed"],[original.id,"blocked"]]);
	assert.equal(before.reviews[1].reason, `Discovery error: ${nativeError}`);
	reconciler.close();
	const next = f.runtime(f.root);
	next.turn("owner"); f.owner.turn("owner"); await Promise.all([next.flush(), f.owner.flush()]); await f.settle();
	assert.deepEqual(f.scouts.map(j => j.squad), [original.squad], "one fresh scout for the unreported charter");
	const [replacement] = f.scouts;
	assert.equal(replacement.base, original.base); assert.notEqual(replacement.workflowId, "original");
	await replacement.report({...noGap, outcome:"regenerate", grains:["price"]});
	await next.scoutResult(run, dispatch, "owner", "original", interrupted.id, noGap, interrupted.packet);
	next.turn("owner"); await next.flush();
	const after = await f.status();
	assert.deepEqual(after.reviews.slice(0,2), before.reviews);
	assert.equal(after.reviews[2].retryOf, original.id);
	assert.ok(after.nodes.find(n => n.grain === "price")?.worker);
	assert.equal(f.workers.size, 1); assert.equal(f.scouts.length, 1);
	assert.deepEqual(after.goal, before.goal);
});

const readerError = "Request workflow.execute failed with message: The installed Foundry reader changed. Reload Foundry in this session, then check the original assignment's status. Do not restart the run.";
for (const scenario of ["current", "superseded", "typed failure", "budget exhausted"]) test(`terminal reader error on delivery: ${scenario}`, async t => {
	const f = trial(t, ["price"], { goalCheck:"goal.mjs", limits:{assignments:scenario === "budget exhausted" ? 1 : 4} });
	/** @type {string[]} */ const attempts = [];
	const issuer = f.runtime(f.root, { scout: async (id, ticket, actor) => {
		const workflow = `workflow-${attempts.length}`;
		const [job] = await f.owner.scoutBatch(id, ticket, actor, workflow);
		if (job.base !== f.tip) {
			await f.owner.scoutResult(id,ticket,actor,workflow,job.id,noGap,job.packet);
			return {runId:workflow, status:"completed"};
		}
		attempts.push(job.id);
		if (scenario === "superseded") {
			put(f.root,"new-product","later"); git(f.root,"add","new-product"); git(f.root,"commit","-qm","new product");
		}
		return { runId:workflow, status:"error", error:readerError, ...(scenario === "typed failure" ? {failure:{type:"workflow_limit_reached"}} : {}) };
	} });
	await f.start(issuer); await issuer.flush(); await f.settle();
	assert.equal(attempts.length, scenario === "current" ? 2 : 1, "recover on delivery, without another operator turn");
	issuer.turn("owner"); await issuer.flush(); await f.settle();
	const retries = (await f.status()).reviews.filter(r => r.retryOf);
	assert.deepEqual(retries.map(r => r.retryOf), scenario === "current" ? [attempts[0]] : []);
	assert.equal(f.workers.size, 0, "a terminal error alone cannot staff a writer");
});

test("explicit review of one proven no-report charter, including the legacy ledger reason", async t => {
	const f = trial(t, ["price", "browse"], { goalCheck: "goal.mjs", limits: { assignments: 3, workers: 2 } });
	await f.start(); const [old, sibling] = f.scouts;
	await old.report(null); await sibling.report(noGap);
	const before = (await f.status()).reviews;
	assert.equal(before[0].reason, "Invalid scout result: No structured scout report was returned");
	assert.match(String((await f.status()).blocker), /No actionable/);
	const label = `scout:${old.squad}:${old.id}@${old.base}`, call = `call-${old.id}`;
	let status = "running", error = "Permission denied", toolCalls = 0, manual = false, launches = 0, budget = 1;
	let failed = [old.id];
	const conf = await loadEntry({ sessionId: "owner", on() {}, rpc: { mode: { get: async () => "interactive" },
		metadata: { getContextAttribution: async () => ({ contextAttribution: { promptTokenLimit: 2 * budget, categories: {
			systemPrompt: 0, customInstructions: 0, systemTools: 0, mcpTools: 0 } } }) },
		managedSettings: { get: async () => ({ failClosed: false }) }, permissions: { getMode: async () => ({ mode: manual ? "manual" : "assisted" }) },
		eventLog: { read: async () => ({ cursorStatus: "ok", hasMore: false, events: [
			{ type: "subagent.failed", data: { toolCallId: call, error, totalToolCalls: toolCalls } }] }) },
	}, workflow: {
		getRun: async () => ({ runId: old.workflowId, status, result: { reported: 1, failed } }),
		getRunDetail: async () => ({ runId: old.workflowId, workflowName: "foundry-scout", status,
			agents: [{ label, runId: old.workflowId, toolCallId: call, status: "failed" }] }),
		run: async (/** @type {string} */ name, /** @type {{args:{run:string,dispatch:string}}} */ opts) => {
			launches++; assert.equal(name, "foundry-scout");
			const jobs = await f.owner.scoutBatch(run, opts.args.dispatch, "owner", "fresh-workflow");
			assert.deepEqual(jobs.map(j => j.squad), [old.squad]);
			await f.owner.scoutResult(run, opts.args.dispatch, "owner", "fresh-workflow", jobs[0].id, noGap, jobs[0].packet);
			return { runId: "fresh-workflow", status: "completed" };
		} } });
	const ctx = { sessionId: "owner" }, hook = { ...ctx, timestamp: new Date(), workingDirectory: f.root };
	await conf.hooks?.onSessionStart?.({ ...hook, source: "resume" }, ctx);
	t.after(() => conf.hooks?.onSessionEnd?.({ ...hook, reason: "complete" }, ctx));
	const tool = conf.tools?.find(t => t.name === "foundry_review"); assert.ok(tool?.handler);
	const request = (review = old.id) => tool.handler?.({ run, retry:{review} }, { ...ctx, arguments: {}, toolName: tool.name, toolCallId: "rereview" });
	assert.match(JSON.stringify(await request()), /terminal|completed/i);
	status = "completed";
	assert.match(JSON.stringify(await request()), /budget|recoverable/);
	error = "Request exceeds the model's prompt budget after reserving output (3210 tokens; limit 1234). Reduce context or compact before continuing.";
	toolCalls = 1; assert.match(JSON.stringify(await request()), /budget|recoverable/);
	toolCalls = 0; failed = [sibling.id]; assert.match(JSON.stringify(await request()), /no.report|failed/i);
	failed = [old.id]; manual = true; assert.match(JSON.stringify(await request()), /manual/i);
	manual = false;
	assert.match(JSON.stringify(await request(sibling.id)), /no.report|blocked/i);
	assert.match(JSON.stringify(await request()), /scout budget/);
	budget = 16000;
	assert.equal(launches, 0); assert.deepEqual((await f.status()).reviews, before);
	assert.equal(typeof await request(), "string");
	for (let i = 0; i < 20 && (await f.status()).reviews.at(-1)?.state !== "observed"; i++) await nextTurn();
	const after = (await f.status()).reviews;
	assert.deepEqual(after.slice(0, 2), before);
	assert.equal(after.length, 3); assert.deepEqual([after[2].squad, after[2].base, after[2].state], [old.squad, old.base, "observed"]);
	assert.match(JSON.stringify(await request()), /superseded|current/); assert.equal(launches, 1);
});

test("a proven zero-agent packet failure admits just one first scout with an exact current excerpt", async t => {
	const f = trial(t, ["price", "browse"], { goalCheck: "goal.mjs", limits: { assignments: 3 } });
	const excerpt = "price/cart: mismatch at checkout", code = `console.log("browse/row: unrelated failure\\n" + "x".repeat(150000) + "\\nprice/other: different failure\\n${excerpt}\\nprice/again: mismatch at checkout\\n" + "y".repeat(9000));process.exitCode=1`;
	put(f.root, "goal.mjs", code); git(f.root, "commit", "-qam", "verbose diagnostic");
	// This allowance cannot even fit the index, regardless of any diagnostic reduction.
	await f.start(f.runtime(f.root, { scoutBudget: async () => 1 }));
	const before = (await f.status()).reviews, [old] = before;
	assert.equal(f.scouts.length, 0); assert.match(String(old.reason), /pinned file index/);
	const db = openDatabase(f.root); t.after(() => db.close());
	const proof = db.read(run)?.goal?.check; assert.ok(proof);
	const original = db.read(run)?.effects.find(e => e.id === proof)?.receipt; assert.ok(original);
	assert.ok(original.output.includes(excerpt) && original.output.length >= 150000);
	let launched = 0, budget = 1, priorAgents = 0;
	const conf = await loadEntry({ sessionId: "owner", on() {}, rpc: { mode: { get: async () => "interactive" },
		metadata: { getContextAttribution: async () => ({ contextAttribution: { promptTokenLimit: 2 * budget, categories: {
			systemPrompt: 0, customInstructions: 0, systemTools: 0, mcpTools: 0 } } }) },
		managedSettings: { get: async () => ({ failClosed: false }) }, permissions: { getMode: async () => ({ mode: "assisted" }) }
	}, workflow: {
		getRun: async () => ({ runId: old.workflowId, status: "completed", result: { reported: 0, failed: [] } }),
		getRunDetail: async () => ({ runId: old.workflowId, workflowName: "foundry-scout", status: "completed", agents: Array(priorAgents).fill({}) }),
		run: async (/** @type {string} */ name, /** @type {{args:{dispatch:string}}} */ opts) => {
			launched++; const [job, ...others] = await f.owner.scoutBatch(run, opts.args.dispatch, "owner", "first-scout");
			assert.equal(name, "foundry-scout"); assert.deepEqual(others, []); assert.equal(job.squad, old.squad);
			assert.ok(job.prompt.includes(excerpt) && !job.prompt.includes("x".repeat(1000)) && job.packet.partial);
			await f.owner.scoutResult(run, opts.args.dispatch, "owner", "first-scout", job.id, { ...noGap, outcome: "unresolved" }, job.packet);
			return { runId: "first-scout", status: "completed" };
		} } });
	const ctx = { sessionId: "owner" }, hook = { ...ctx, timestamp: new Date(), workingDirectory: f.root };
	await conf.hooks?.onSessionStart?.({ ...hook, source: "resume" }, ctx);
	t.after(() => conf.hooks?.onSessionEnd?.({ ...hook, reason: "complete" }, ctx));
	const tool = conf.tools?.find(t => t.name === "foundry_review"); assert.ok(tool?.handler);
	const request = () => tool.handler?.({ run, retry:{review:old.id} },
		{ ...ctx, arguments: {}, toolName: tool.name, toolCallId: "request-first-scout" });
	assert.match(JSON.stringify(await request()), /scout budget/);
	budget = 16000; priorAgents = 1; assert.match(JSON.stringify(await request()), /zero.agent|no agents/);
	priorAgents = 0;
	assert.equal(launched, 0); assert.deepEqual((await f.status()).reviews, before);
	assert.equal(typeof await request(), "string");
	for (let i = 0; i < 30 && (await f.status()).reviews.at(-1)?.state !== "observed"; i++) await nextTurn();
	const after = (await f.status()).reviews;
	assert.deepEqual(after.slice(0, 2), before); assert.equal(after.length, 3); assert.equal(after[2].state, "observed");
	assert.equal(after[2].retryOf, old.id); assert.equal(after[2].squad, old.squad);
	assert.match(JSON.stringify(await request()), /superseded|current/);
	assert.equal(launched, 1); assert.equal(f.checks.length, 1); assert.deepEqual(db.read(run)?.effects.find(e => e.id === proof)?.receipt, original);
});

for (const changed of ["target", "paused", "limit"]) test(`owner rereview cannot bypass ${changed} during native verification`, async t => {
	const limit = changed === "limit" ? 1 : 2, f = trial(t, ["price"], { goalCheck: "goal.mjs", limits: { assignments: limit } });
	await f.start(); const [job] = f.scouts; await job.report(null);
	let reads = 0;
	const r = f.runtime(f.root, { confirmNoReport: async () => {
		reads++;
		if (changed === "paused") await f.owner.operation("pause", { run }, "owner");
		else { put(f.root, "changed-product", "a different product"); git(f.root, "add", "changed-product"); git(f.root, "commit", "-qm", "new product"); }
	}, scout: async () => assert.fail("no new work") });
	const args = { run, review: job.id };
	await assert.rejects(r.operation("rereview", args, "stranger"), { code: "foreign_run" });
	await assert.rejects(r.operation("rereview", args, "owner"), { code: changed === "target" ? "superseded" : changed });
	assert.equal(reads, changed === "limit" ? 0 : 1);
	assert.equal((await f.status()).reviews.length, 1);
});

const full = "This session already has 4 active workflow runs, which is the concurrent limit";

for(const paused of [false,true])test(`capacity retry survives ledger contention without replacing the review / paused=${paused}`,async t=>{
	t.mock.timers.enable({apis:["setTimeout"]});
	const f=trial(t),clock=recoveryClock();let attempts=0,occupied=true;
	const issuer=f.runtime(f.root,{watchRecovery:clock.watch,scout:async(id,key,actor)=>{
		attempts++;if(occupied)throw Error(full);
		return f.owner.scoutBatch(id,key,actor,"admitted").then(async jobs=>{
			assert.equal(jobs.length,1);await f.owner.scoutResult(id,key,actor,"admitted",jobs[0].id,{...noGap,outcome:"regenerate",grains:["price"]},jobs[0].packet);
			return {runId:"admitted",status:"completed"};
		});
	}});
	const [original]=(await f.start(issuer)).reviews;await clock.pulse(issuer,8);occupied=false;
	await withLedgerLock(f.root,async()=>{t.mock.timers.tick(15000);await nextTurn();await issuer.flush();});
	assert.equal(attempts,1);
	if(paused)await f.owner.operation("pause",{run},"owner");
	t.mock.timers.tick(60000);await nextTurn();await clock.pulse(issuer,16);
	if(paused){
		const s=await f.status();assert.equal(s.active,false);assert.equal(attempts,1);assert.equal(s.pending[0]?.id,original.id);
		assert.equal(s.pending[0]?.state,"ready");return;
	}
	assert.equal(attempts,2,"the same confirmed, unbound capacity rejection should retry without a turn");
	const s=await f.status();assert.equal(s.reviews[0].id,original.id);assert.equal(s.reviews[0].workflowId,"admitted");
	const [w]=f.workers.values();assert.ok(w);put(w.cwd,"src/price/value","original");
	await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
	const done=await f.status();assert.ok(done.qualified);assert.equal(git(f.root,"show",`${done.qualified}:src/price/value`),"original");
});

test("a full native workflow slot queues the same scout until admission, without an operator turn", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = trial(t, ["price", "browse"], { limits: { assignments: 2 } });
	/** @type {string[]} */ const tickets = [];
	let occupied = 4;
	const issuer = f.runtime(f.root, { scout: async (id, ticket, actor) => {
		tickets.push(ticket);
		if (occupied === 4) throw Error(full);
		const jobs = await f.owner.scoutBatch(id, ticket, actor, "admitted");
		for (const job of jobs) await f.owner.scoutResult(id, ticket, actor, "admitted", job.id, noGap, job.packet);
		return { runId: "admitted", status: "completed" };
	} });
	const before = await f.start(issuer);
	assert.deepEqual(before.pending.map(e => e.state), ["ready", "ready"]);
	assert.match(String(before.pending[0].reason), /capacity/i);
	issuer.turn("owner"); await issuer.flush();
	assert.equal(tickets.length, 1, "other wakes must not hammer a full session");
	t.mock.timers.tick(60_000); await nextTurn(); await issuer.flush();
	assert.equal(tickets.length, 2, "still full, only one attempt for the batch");
	occupied--;
	t.mock.timers.tick(60_000); await nextTurn(); await issuer.flush();
	assert.equal(tickets.length, 3);
	assert.deepEqual((await f.status()).reviews.map(e => [e.id, e.state]), before.reviews.map(e => [e.id, "observed"]));
	await assert.rejects(f.owner.scoutBatch(run, tickets[0], "owner", "late"), { code: "foreign_assignment" });
});

test("a capacity wake does not dispatch through a pause", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = trial(t);
	let attempts = 0;
	const issuer = f.runtime(f.root, { scout: async () => { attempts++; throw Error(full); } });
	await f.start(issuer);
	await issuer.operation("pause", { run }, "owner");
	t.mock.timers.tick(60_000); await nextTurn(); await issuer.flush();
	assert.equal(attempts, 1);
	const s = await f.status();
	assert.equal(s.pending[0].state, "ready");
});

test("reopening the issuer re-arms a proven capacity wait without an operator turn", async t => {
	t.mock.timers.enable({apis:["setTimeout"]});
	const f = trial(t);
	const old = f.runtime(f.root,{scout:async()=>{throw Error(full);}});
	const waiting = await f.start(old); old.close();
	const [original] = waiting.reviews; assert.equal(waiting.pending[0]?.state,"ready");
	const issuer = f.runtime(f.root), other = f.runtime(f.root);
	other.sessionStart("other",f.root);
	t.mock.timers.tick(20_000); await nextTurn(); await other.flush(); assert.equal(f.scouts.length,0);
	issuer.sessionStart("owner",f.root); issuer.sessionStart("owner",f.root);
	t.mock.timers.tick(20_000); await nextTurn(); await issuer.flush(); await f.settle();
	assert.deepEqual(f.scouts.map(s=>s.id),[original.id]);
	await f.scouts[0].report(noGap);
	assert.equal((await f.status()).reviews.find(r=>r.id===original.id)?.state,"observed");
});

test("reconnect recovers a persisted capacity rejection but never reissues a bound scout", async t => {
	const f = trial(t, ["price", "browse"]);
	const old = f.runtime(f.root, { scout: async () => { throw Error("lost reply"); } });
	const before = await f.start(old); old.close();
	const db = openDatabase(f.root);
	try {
		db.mutateLocked(run, r => {
			// Reproduce one reader-7 unbound rejection and a separate workflow already bound.
			for (const e of r.effects) if (e.kind === "scout") {
				if (e.squad === "price") e.error = `Discovery unconfirmed: Error: ${full}. Resume to retry unbound discovery.`;
				else { e.callId = "other-dispatch"; e.workflowId = "existing"; }
			}
		});
	} finally { db.close(); }
	f.owner.turn("owner"); await f.owner.flush(); await f.settle();
	assert.deepEqual(f.scouts.map(s => s.id), [before.reviews[0].id]);
	await f.scouts[0].report(noGap);
	assert.deepEqual((await f.status()).reviews.map(r => [r.state, r.workflowId]),
		[["observed", f.scouts[0].workflowId], ["reading", "existing"]]);
});

test("an unbound workflow launch is not retried on turns; explicit resume invalidates its old dispatch", async t => {
	const f = trial(t);
	/** @type {string[]} */ const tickets = [];
	const old = f.runtime(f.root, { scout: async (_, ticket) => { tickets.push(ticket); throw Error("dynamic_workflows_unavailable"); } });
	const s = await f.start(old);
	assert.equal(tickets.length, 1); assert.equal(s.reviews.length, 1);
	assert.match(String(s.pending[0]?.reason), /dynamic_workflows_unavailable/);
	old.turn("owner"); await old.flush();
	assert.equal(tickets.length, 1); assert.equal(f.workers.size, 0); assert.equal(f.scouts.length, 0);
	old.close();
	await f.owner.operation("resume", { source }, "owner"); await f.settle();
	const [job] = f.scouts; assert.equal(job.id, s.reviews[0].id); assert.notEqual(job.dispatch, tickets[0]);
	await assert.rejects(f.owner.scoutBatch(run, tickets[0], "owner", "late-workflow"), { code: "foreign_assignment" });
	await job.report(noGap);
	assert.equal((await f.status()).reviews[0].state, "observed");
});

test("resume cannot start a missing run or disturb a bound workflow", async t => {
	const f = trial(t);
	await assert.rejects(f.owner.operation("resume", { source }, "owner"), { code: "missing_run" });
	assert.equal(f.scouts.length, 0); assert.equal(f.workers.size, 0);
	const live = await f.start();
	assert.deepEqual(await f.owner.operation("resume", { source }, "owner"), live);
	assert.equal(f.scouts.length, 1);
});

for (const again of [false,true]) test(`a confirmed provider disconnect continues the same workflow once; disconnect again=${again}`,async t=>{
	const f=trial(t,["price","browse"]), workflow="original-workflow";
	const disconnected={runId:workflow,status:"halted",failure:{type:"workflow_provider_disconnected"}};
	let dispatch="",resumes=0;
	const first=f.runtime(f.root,{scout:async(id,ticket,actor)=>{
		dispatch=ticket; const [done]=await f.owner.scoutBatch(id,ticket,actor,workflow);
		await f.owner.scoutResult(id,ticket,actor,workflow,done.id,noGap,done.packet);
		return disconnected;
	}});
	const held=await f.start(first); first.close();
	assert.deepEqual(held.reviews.map(r=>r.state),["observed","reading"]);
	const issuer=f.runtime(f.root,{scoutSnapshot:async()=>disconnected,scoutState:async()=>disconnected,
		resumeScout:async id=>{
			assert.equal(id,workflow); resumes++;
			if (again) return disconnected;
			const jobs=await f.owner.scoutBatch(run,dispatch,"owner",workflow);
			assert.deepEqual(jobs.map(j=>j.id),[held.reviews[1].id]);
			await f.owner.scoutResult(run,dispatch,"owner",workflow,jobs[0].id,noGap,jobs[0].packet);
			return {runId:id,status:"completed"};
		}});
	issuer.turn("owner"); await issuer.flush(); await nextTurn(); await issuer.flush();
	assert.equal(resumes,1);
	issuer.turn("owner"); await issuer.flush(); assert.equal(resumes,1);
	const end=await f.status(); assert.deepEqual(end.reviews.map(r=>r.id),held.reviews.map(r=>r.id));
	assert.deepEqual(end.reviews.map(r=>r.state),["observed",again ? "reading" : "observed"]);
});

for (const outcome of ["continue","lookup","refused","pause"]) test(`a reloaded writer recovers its own disconnected scout without a turn / ${outcome}`,async t=>{
	const f=factory(t,run,source,{[source]:JSON.stringify({version:2,id:run,direction:"Open the catalog.",target:"refs/heads/main",
		goalCheck:"goal.mjs",productCheck:"product.mjs",squads:["loader","panel"].map(id=>({id,areas:[id],charter:`${id}.md`,checks:["unit.mjs"]}))}),
		".foundry/catalog/journey.md":"Open the catalog.","loader.md":"Load the catalog.","panel.md":"Show the catalog.","unit.mjs":"","product.mjs":"",
		"goal.mjs":`import {existsSync} from "node:fs"; if (!existsSync("loader/value")) {console.log('FOUNDRY_BLOCKERS=[{"id":"view","directory":"panel/view","blocked":1}]');process.exit(1)} if (!existsSync("panel/view/value")) process.exit(2);`});
	const proposal=(/** @type {string} */ id,/** @type {string} */ directory)=>({outcome:"regenerate",reason:`Implement ${id}.`,evidence:[`${id}.md`],
		grains:[{id,directory,task:`Implement ${id}.`,check:"unit.mjs",needs:id==="loader"?[]:["loader"]}]});
	await f.start();
	for (const s of [...f.scouts]) await s.report(s.squad==="loader"?proposal("loader","loader"):{...noGap,evidence:["panel.md"]});
	const [writer]=f.workers.values(),workflow="original-writer-workflow";
	let ticket="";
	const disconnected={runId:workflow,status:"halted",failure:{type:"workflow_provider_disconnected"}};
	const original=f.runtime(writer.cwd,{scout:async(id,dispatch,actor)=>{
		ticket=dispatch; await f.owner.scoutBatch(id,dispatch,actor,workflow); return disconnected;
	}});
	put(writer.cwd,"loader/value","original"); await original.operation("submit",{run,token:writer.token},writer.id);
	await nextTurn(); await original.flush(); original.close();
	const before=await f.status(), review=before.reviews.find(r=>r.workflowId===workflow); assert.ok(review && ticket && before.checkpoint);
	const prior=f.checks.slice(); let allowed=false, resumes=0, readable=outcome!=="lookup";
	/** @type {Set<()=>void>} */ const clocks=new Set();
	const issuers=[0,1].map(()=>f.runtime(writer.cwd,{
		watchRecovery:fn=>{clocks.add(fn);return ()=>{clocks.delete(fn);};},
		permissionBlocker:async()=>allowed?null:{scope:"session",message:"Manual approvals."},
		scoutSnapshot:async()=>{
			if (!readable) throw Object.assign(Error("Temporary read failure"),{code:"EAGAIN"});
			if (allowed && outcome==="pause") await f.owner.operation("pause",{run},"owner");
			return allowed && outcome==="refused"?{...disconnected,failure:{type:"workflow_resume_declined"}}:disconnected;
		},
		resumeScout:async id=>{
			assert.equal(id,workflow); resumes++;
			const jobs=await f.owner.scoutBatch(run,ticket,writer.id,workflow); assert.deepEqual(jobs.map(j=>j.id),[review.id]);
			await f.owner.scoutResult(run,ticket,writer.id,workflow,review.id,proposal("panel","panel/view"),jobs[0].packet);
			return {runId:id,status:"completed"};
		},
	}));
	for (const issuer of issuers) issuer.sessionStart(writer.id,writer.cwd);
	assert.equal(clocks.size,2,"each reloaded issuer must observe its unfinished workflow");
	async function tick() {
		for (const fn of clocks) fn();
		await Promise.all(issuers.map(i=>i.flush())); await nextTurn(); await Promise.all(issuers.map(i=>i.flush()));
	}
	for(let i=0;i<5;i++) await tick();
	assert.equal(resumes,0); readable=true; allowed=true;
	for(let i=0;i<8;i++) await tick();
	const after=await f.status(); assert.deepEqual(f.checks,prior);
	const completed=outcome==="continue" || outcome==="lookup";
	assert.equal(resumes,completed?1:0);
	assert.equal(after.active,outcome!=="pause");
	if(outcome==="refused") assert.match(after.reviews.find(r=>r.id===review.id)?.reason ?? "",/workflow_resume_declined/);
	if(!completed) {assert.equal(f.workers.size,1);return;}
	const panel=f.workers.get(after.nodes.find(n=>n.grain==="panel")?.worker ?? ""); assert.ok(panel);
	put(panel.cwd,"panel/view/value","continued"); await f.runtime(panel.cwd).operation("submit",{run,token:panel.token},panel.id);
	const qualified=(await f.status()).qualified; assert.ok(qualified);
	assert.equal(git(f.root,"show",`${qualified}:panel/view/value`),"continued");
	assert.equal(git(f.root,"show",`${qualified}:loader/value`),"original");
});

for (const status of ["paused", "halted"]) test(`explicit resume continues only the missing report of a bound ${status} batch`, async t => {
	const f = trial(t, ["price", "browse"]), workflow = "original-workflow";
	let dispatch = "", starts = 0, resumes = 0;
	const owner = f.runtime(f.root, { scout: async (id, ticket, actor) => {
		dispatch = ticket; starts++;
		const [first] = await f.owner.scoutBatch(id, ticket, actor, workflow);
		await f.owner.scoutResult(id, ticket, actor, workflow, first.id, noGap, first.packet);
		return { runId: workflow, status };
	} });
	const stopped = await f.start(owner);
	assert.deepEqual(stopped.reviews.map(r => r.state), ["observed", "reading"]);
	assert.equal(stopped.reviews[1].workflowId, workflow);
	owner.close();
	let held = true, holdDuringLookup = false;
	const issuer = f.runtime(f.root, {
		permissionBlocker: async () => held ? { scope: "session", message: "Manual approvals." } : null,
		scout: async () => assert.fail("No replacement workflow"),
		scoutState: async id => ({ runId: id, status }),
		scoutSnapshot: async id => { if (holdDuringLookup) held = true; return { runId: id, status }; },
		resumeScout: async id => {
			resumes++; assert.equal(id, workflow);
			const jobs = await f.owner.scoutBatch(run, dispatch, "owner", workflow);
			assert.deepEqual(jobs.map(j => j.id), [stopped.reviews[1].id]);
			await f.owner.scoutResult(run, dispatch, "owner", workflow, jobs[0].id, noGap, jobs[0].packet);
			return { runId: workflow, status: "completed" };
		},
	});
	issuer.turn("owner"); await issuer.flush(); await nextTurn();
	assert.equal(resumes, 0);
	await assert.rejects(issuer.operation("resume", { source }, "owner"), /Manual approvals/);
	held = false;
	await issuer.operation("start", { source }, "owner"); await nextTurn();
	assert.equal(resumes, 0);
	holdDuringLookup = true;
	await assert.rejects(issuer.operation("resume", { source }, "owner"), /Manual approvals/);
	assert.deepEqual((await f.status()).reviews, stopped.reviews);
	assert.equal(resumes, 0, "a status lookup is not permission to resume the native workflow");
	holdDuringLookup = false; held = false;
	await issuer.operation("resume", { source }, "owner"); await nextTurn(); await issuer.flush();
	assert.deepEqual((await f.status()).reviews.map(r => r.state), ["observed", "observed"]);
	await issuer.operation("resume", { source }, "owner");
	assert.deepEqual([starts, resumes, f.workers.size], [1, 1, 0]);
});

for (const envelope of [{ status: "cancelled" }, { status: "error", failure: { type: "workflow_limit_reached" } },
	{ status: "halted", failure: { type: "workflow_resume_declined" } }])
	test(`a ${envelope.failure?.type ?? envelope.status} envelope cannot authorize scout continuation`, async t => {
		const f = trial(t), workflow = "original-workflow";
		let starts = 0, resumes = 0;
		const owner = f.runtime(f.root, {
			scout: async (id, ticket, actor) => { starts++; await f.owner.scoutBatch(id, ticket, actor, workflow); return { runId: workflow, ...envelope }; },
			scoutSnapshot: async id => ({ runId: id, ...envelope }),
			resumeScout: async id => { resumes++; return { runId: id, status: "completed" }; },
		});
		assert.equal((await f.start(owner)).reviews[0].state, "blocked");
		await owner.operation("resume", { source }, "owner");
		assert.deepEqual([starts, resumes, f.workers.size], [1, 0, 0]);
	});

test("owner resume respects a newer native refusal even when Foundry last saw a paused attempt", async t => {
	const f = trial(t), workflow = "original-workflow";
	const owner = f.runtime(f.root, {
		scout: async (id, ticket, actor) => { await f.owner.scoutBatch(id, ticket, actor, workflow); return { runId: workflow, status: "paused" }; },
		scoutSnapshot: async id => ({ runId: id, status: "halted", failure: { type: "workflow_resume_declined" } }),
		resumeScout: async () => assert.fail("Stale paused envelope cannot override refusal"),
	});
	assert.equal((await f.start(owner)).reviews[0].state, "reading");
	const refused = await owner.operation("resume", { source }, "owner");
	assert.equal(refused.reviews[0].state, "blocked");
	assert.match(String(refused.reviews[0].reason), /workflow_resume_declined/);
	assert.equal(f.workers.size, 0);
});

test("a permission hold inside the resumed workflow checkpoints the original dispatch instead of completing it", async t => {
	const f = trial(t); await f.start(); const [job] = f.scouts;
	let manual = true, calls = 0;
	const issuer = f.runtime(f.root, { permissionBlocker: async () => manual ? { scope: "session", message: "Manual approvals." } : null });
	const workflow = scoutDefinition(() => issuer);
	/** @type {Parameters<typeof workflow.run>[0]} */
	const ctx = { runId: job.workflowId, args: { run, dispatch: job.dispatch }, session: /** @type {typeof ctx.session} */ ({ sessionId: job.issuer }),
		signal: new AbortController().signal, log() {}, phase() {}, step: async (_key, fn) => fn(), parallel: fs => Promise.all(fs.map(fn => fn())),
		agent: async () => { calls++; return noGap; }, pause: async key => { assert.equal(key, "dispatch-held:1"); throw new DOMException("paused", "AbortError"); },
		pipeline: () => assert.fail("unexpected pipeline"), workflow: () => assert.fail("nested workflow") };
	await assert.rejects(workflow.run(ctx), { name: "AbortError" });
	assert.equal(calls, 0);
	assert.equal((await f.status()).reviews[0].workflowId, job.workflowId);
	manual = false;
	assert.deepEqual(await workflow.run(ctx), { reported: 1, failed: [] });
	assert.equal(calls, 1); assert.equal(f.scouts.length, 1);
});

test("a reconnected issuer observes the original workflow; evidence received through a pause issues work only on resume", async t => {
	const f = trial(t), first = f.runtime(f.root);
	await f.start(first); const [job] = f.scouts; first.close();
	/** @type {string[]} */ const lookups = [];
	/** @type {() => void} */ let finish = () => {};
	const complete = new Promise(resolve => { finish = () => resolve(undefined); });
	const issuer = f.runtime(f.root, {
		scout: async () => assert.fail("A bound workflow must never be relaunched"),
		scoutState: async id => { lookups.push(id); await complete; return { runId: id, status: "completed" }; },
	});
	issuer.turn("owner"); await issuer.flush();
	issuer.turn("owner"); await issuer.flush();
	assert.deepEqual(lookups, [job.workflowId]);
	await issuer.operation("pause", { run }, "owner");
	await issuer.scoutResult(run, job.dispatch, job.issuer, job.workflowId, job.id,
		{ outcome: "regenerate", reason: "The price lookup is missing.", evidence: ["charter"], grains: ["price"] }, job.packet);
	finish(); await nextTurn();
	const paused = await f.status();
	assert.equal(paused.reviews[0].state, "reported"); assert.deepEqual(paused.nodes, []); assert.equal(f.workers.size, 0);
	const live = await issuer.operation("resume", { source }, "owner");
	assert.equal(live.reviews[0].state, "observed"); assert.equal(live.nodes[0].state, "writing"); assert.equal(f.workers.size, 1);
});

test("simultaneous reports with no new assignments require just one scheduler wake", async t => {
	const f = trial(t, ["price", "browse", "export", "index"]);
	let reads = 0;
	const issuer = f.runtime(f.root, { mode: async () => { reads++; return "interactive"; } });
	await f.start(issuer);
	assert.equal(f.scouts.length, 4);
	reads = 0;
	await Promise.all(f.scouts.map(job => job.report(noGap)));
	assert.equal(reads, 1, "a single executable-mode read served the merged wake");
	assert.ok((await f.status()).reviews.every(r => r.state === "observed"));
});

test("the issuer consumes a durable report even when a different runtime received it", async t => {
	const f = trial(t), workflow = "bound-workflow";
	const issuer = f.runtime(f.root, { scout: async (id, ticket, actor) => {
		const [job] = await f.owner.scoutBatch(id, ticket, actor, workflow);
		await f.owner.scoutResult(id, ticket, actor, workflow, job.id,
			{ ...noGap, outcome: "regenerate", grains: ["price"] }, job.packet);
		return { runId: workflow, status: "completed" };
	} });
	await f.start(issuer); await issuer.flush();
	assert.equal((await f.status()).reviews[0].state, "observed"); assert.equal(f.workers.size, 1);
});

test("a workflow cannot use another review's delivery receipt or another base", async t => {
	const f = trial(t, ["price", "browse"]); await f.start();
	const [a, b] = f.scouts;
	await f.owner.scoutResult(run, a.dispatch, a.issuer, a.workflowId, a.id, noGap, b.packet);
	await f.owner.scoutResult(run, b.dispatch, b.issuer, b.workflowId, b.id, noGap, { ...b.packet, base: "a".repeat(40) });
	await a.report(noGap); await b.report(noGap);
	for (const review of (await f.status()).reviews) {
		assert.equal(review.state, "blocked"); assert.match(String(review.reason), /mismatched journaled scout packet/);
	}
	assert.equal(f.workers.size, 0);
});
