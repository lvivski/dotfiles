import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as wait } from "node:timers/promises";
import { openDatabase } from "./database.mjs";
import { factory, git, nativeHost, put, scriptedInspections, settleSubmitted, workflowHost } from "../test/fixture.mjs";
import { driveProjections, reportProjections } from "../test/participant.mjs";
import { createRuntime } from "./runtime.mjs";

const source = ".foundry/contract.json", unit = ".foundry/unit.mjs", product = ".foundry/product.mjs", goal = ".foundry/goal.mjs";
const participant = fileURLToPath(new URL("../test/participant.mjs", import.meta.url)), exec = promisify(execFile);
/** @param {number} n */
const range = n => Array.from({ length: n }, (_, i) => i);
/** @typedef {{id:string,directory:string,squad:string,needs:string[],body:string}} Part */

// Each line's transfer board consumes its own and the next line's departure projection (a ring).
const transit = {
	id: "transit", width: 12, group: 2, direction: "Show connecting departure times between adjacent lines. The latest revision of a trip wins, including cancellations.",
	/** @param {number} i @param {number[]} lanes */
	sources: (i, lanes) => [i, (i + 1) % lanes.length],
	/** @param {number} i */
	reader: i => `rows=>rows.filter(r=>r.line===${i})`,
	reducer: `rows=>{const trips=new Map();for(const r of d0(rows))if(!trips.has(r.trip)||trips.get(r.trip).rev<r.rev)trips.set(r.trip,r);
		return [...new Set([...trips.values()].filter(r=>!r.cancel).map(r=>r.time))].sort((a,b)=>a-b)}`,
	/** @param {number} _i @param {string[]} _deps */
	view: (_i, _deps) => "rows=>{const next=new Set(d1(rows));return d0(rows).filter(t=>next.has(t))}",
	probe: `const old={line:i,trip:'a',rev:1,time:9},latest={...old,rev:2,time:5},other={...latest,line:(i+1)%lanes.length};
		assert.deepEqual(fn([latest,old,other]),stage==='read'?[latest,old]:[5]);`,
	empty: [], invariant: "",
	oracle: `function verify(board){for(const offset of [0,17]){
		const rows=lanes.flatMap(i=>[{line:i,trip:'late',rev:2,time:90+offset,cancel:true},{line:i,trip:'late',rev:1,time:90+offset},
			{line:i,trip:'shared',rev:1,time:5+offset},{line:i,trip:'pair',rev:1,time:20+(i>>1)+offset}]).reverse();
		assert.deepEqual(board(rows),Object.fromEntries(lanes.map(i=>[i,i%2?[5+offset]:[5+offset,20+(i>>1)+offset]])))}}`
};
// Any office can pay any other office. Every net position consumes every journal, not just its own.
const clearing = {
	id: "clearing", width: 16, group: 4, direction: "Report each office's net transfers after duplicate deliveries and reversals. Reference numbers are local to the sending office.",
	/** @param {number} _i @param {number[]} lanes */
	sources: (_i, lanes) => lanes,
	/** @param {number} i */
	reader: i => `rows=>rows.filter(r=>r.from===${i})`,
	reducer: `rows=>{const byRef=new Map();for(const r of d0(rows))if(!byRef.has(r.ref)||r.rev>byRef.get(r.ref).rev)byRef.set(r.ref,r);
		return [...byRef.values()].filter(r=>!r.reversed)}`,
	/** @param {number} i @param {string[]} deps */
	view: (i, deps) => `rows=>[${deps}].flatMap(f=>f(rows)).reduce((n,r)=>n+(r.to===${i}?r.amount:0)-(r.from===${i}?r.amount:0),0)`,
	probe: `const a={from:i,to:(i+1)%lanes.length,ref:'a',rev:1,amount:i+7},b={...a,from:(i+lanes.length-1)%lanes.length,to:i,amount:2};
		assert.deepEqual(fn([a,b,a]),stage==='read'?[a,a]:stage==='reduce'?[a]:2-a.amount);`,
	empty: 0,
	invariant: `for(const i of lanes){const payment={from:i,to:(i+1)%lanes.length,ref:'void',amount:3,rev:1};
		const reversed=[payment,{...payment,rev:2,reversed:true}],positions=board(reversed);
		if(Object.values(positions).some(n=>n!==0)){
			const journal=(await import('../'+outputs['reduce-'+i]+'/index.mjs')).default;
			if(journal(reversed).length)console.log('FOUNDRY_REPAIR=reduce-'+i);
			assert.fail('A reversed transfer changed office positions')
		}}`,
	oracle: `function verify(board){for(const step of [1,5]){
		const expected=Object.fromEntries(lanes.map(i=>[i,0])),rows=[];
		for(const i of lanes){const to=(i+step)%lanes.length,a={from:i,to,ref:'invoice',amount:3+i,rev:1},
			b={from:i,to,ref:'void',amount:51+i,rev:1};rows.push(a,b,{...b,reversed:true,rev:2},{...a});expected[i]-=a.amount;expected[to]+=a.amount}
		assert.deepEqual(board(rows.reverse()),expected)}}`
};

/** @param {typeof transit | typeof clearing} app */
function layout(app) {
	const lanes = range(app.width), groups = range(app.width / app.group), squads = groups.map(i => `district-${i}`);
	/** @type {Map<string,Part>} */ const nodes = new Map();
	/** @param {string} id @param {number} group @param {string[]} needs @param {string} fn */
	function add(id, group, needs, fn) {
		const squad = squads[group], directory = `${squad}/${id}`;
		const imports = needs.map((key, j) => {
			const dep = nodes.get(key); assert.ok(dep);
			return `import d${j} from './${path.relative(directory, dep.directory)}/index.mjs';`;
		});
		nodes.set(id, { id, squad, directory, needs, body: [...imports, `export default ${fn};`].join("\n") });
	}
	for (const i of lanes) add(`read-${i}`, Math.floor(i / app.group), [], app.reader(i));
	for (const i of lanes) add(`reduce-${i}`, Math.floor(i / app.group), [`read-${i}`], app.reducer);
	for (const i of lanes) {
		const needs = app.sources(i, lanes).map(j => `reduce-${j}`);
		add(`view-${i}`, Math.floor(i / app.group), needs, app.view(i, needs.map((_, j) => `d${j}`)));
	}
	for (const g of groups) {
		const members = lanes.slice(g * app.group, (g + 1) * app.group);
		add(`section-${g}`, g, members.map(i => `view-${i}`), `rows=>({${members.map((i, j) => `${i}:d${j}(rows)`)}})`);
	}
	add("board", 0, groups.map(g => `section-${g}`), `rows=>Object.assign({},${groups.map((_, j) => `d${j}(rows)`)})`);
	const setup = `import assert from 'node:assert/strict';import {existsSync} from 'node:fs';
		const lanes=${JSON.stringify(lanes)},file='district-0/board/index.mjs';`;
	const files = {
		[source]: JSON.stringify({ version: 2, id: app.id, direction: app.direction, target: "refs/heads/main", productCheck: product, goalCheck: goal,
			squads: squads.map(id => ({ id, charter: `.foundry/${id}.md`, areas: [id], boundary: [".foundry/api.md"], checks: [unit] })) }),
		".foundry/api.md": "All stages export a pure function from input records to a projection. Do not mutate the input.",
		...Object.fromEntries(squads.map(s => [`.foundry/${s}.md`, `Own ${s}'s contribution to: ${app.direction}`])),
		[goal]: `${setup}${app.oracle};if(!existsSync(file)){console.log('District boards are not yet integrated');process.exit(1)}
			verify((await import('../'+file)).default);`,
		[product]: `${setup}const outputs=JSON.parse(process.env.FOUNDRY_OUTPUTS);for(const dir of Object.values(outputs))
			assert.equal(typeof (await import('../'+dir+'/index.mjs')).default,'function');
			if(existsSync(file)){const board=(await import('../'+file)).default;
				assert.deepEqual(board([]),Object.fromEntries(lanes.map(i=>[i,${JSON.stringify(app.empty)}])));${app.invariant}}`,
		[unit]: `import assert from 'node:assert/strict';import {existsSync,writeFileSync} from 'node:fs';import {setTimeout as wait} from 'node:timers/promises';
			const dir=process.env.FOUNDRY_TEST_RENDEZVOUS,id=process.env.FOUNDRY_GRAIN,[stage,key]=id.split('-'),i=Number(key),lanes=${JSON.stringify(lanes)};
			const fn=(await import('../'+process.env.FOUNDRY_DIRECTORY+'/index.mjs')).default;assert.equal(typeof fn,'function');
			if(['read','reduce','view'].includes(stage)){
				${app.probe}
				if(!dir||(!dir.endsWith('/0')&&stage!=='view'))process.exit(0);
				const name=dir+'/'+id,start=process.hrtime.bigint();writeFileSync(name+'.entered','',{flag:'wx'});
				const until=Date.now()+90000;async function untilPresent(files){while(!files.every(f=>existsSync(dir+'/'+f))){
					assert.ok(Date.now()<until&&!existsSync(dir+'/../abort'),'waiting for '+files.filter(f=>!existsSync(dir+'/'+f)));await wait(15)}}
				await untilPresent(lanes.map(i=>stage+'-'+i+'.entered'));
				if(id==='view-'+lanes.at(-1))await untilPresent(['release']);
				writeFileSync(name+'.span',JSON.stringify([process.env.FOUNDRY_TEST_WRITER,process.pid,String(start),String(process.hrtime.bigint())]),{flag:'wx'})
			}`
	};
	return { files, nodes, lanes, squads };
}

/** @param {string} gate @param {string} stage @param {number[]} lanes */
function assertOverlap(gate, stage, lanes) {
	const spans = lanes.map(i => JSON.parse(readFileSync(path.join(gate, `${stage}-${i}.span`), "utf8")));
	assert.equal(new Set(spans.map(s => s[0])).size, lanes.length, `${stage}: distinct writer processes`);
	assert.equal(new Set(spans.map(s => s[1])).size, lanes.length, `${stage}: distinct evaluator processes`);
	const latestStart = spans.reduce((at,s) => BigInt(s[2]) > at ? BigInt(s[2]) : at, 0n);
	assert.ok(spans.every(s => latestStart < BigInt(s[3])), `${stage}: all evaluator intervals must overlap`);
}

for (const app of [transit, clearing]) for (const missing of app === clearing ? [false, true] : [false]) test(`wide factory: ${app.id} / ${app.width} simultaneous writers${missing ? " / missing repair receipt" : ""}`, {
	skip: process.env.FOUNDRY_FACTORY_MATRIX !== "1" && "set FOUNDRY_FACTORY_MATRIX=1 for the multiprocess stress run"
}, async t => {
	const { files, nodes, lanes, squads } = layout(app), f = factory(t, app.id, source, files);
	const plan = { direction: app.direction, check: unit, parts: [...nodes.values()].map(({ body, ...part }) => part) };
	const script = JSON.stringify(plan);
	const gate = path.join(path.dirname(f.root), "gates");
	for (const pass of ["0","1"]) mkdirSync(path.join(gate, pass), { recursive: true });
	const seen = new Set(), held = `view-${lanes.at(-1)}`, consumer = `section-${squads.length - 1}`;
	/** @typedef {Awaited<ReturnType<typeof f.status>>} State */
	/** @type {Map<string,NonNullable<State["products"]>[number]>} */ const history = new Map();
	/** @type {Map<string,number>} */ const attempts = new Map();
	/** @typedef {typeof f.inbox[number]} Delivery */
	/** @typedef {{workers:Array<NonNullable<ReturnType<typeof f.workers.get>>>,inbox:Delivery[],reviews:Awaited<ReturnType<typeof reportProjections>>}} Reply */
	/** Capture the checked milestone before admitting any writer produced by these reports.
	 * @param {Reply["reviews"]} reviews */
	async function recordReviews(reviews) {
		if (!reviews.length) return;
		const { products } = await f.status();
		for (const { id, base } of reviews) {
			assert.ok(!seen.has(id), `duplicate review ${id}`); seen.add(id);
			if (base === f.tip || history.has(base)) continue;
			const checkpoint = products?.find(p => p.commit === base); assert.ok(checkpoint);
			history.set(base, checkpoint);
		}
	}
	/** Descendants are driven only by actual deliveries, never by polling the owner's actionable nodes.
	 * @param {Delivery[]} events @returns {Promise<void>} */
	async function drain(events) {
		const results = await Promise.allSettled(events.map(async ({ worker, token }) => {
			try {
				assert.ok(!seen.has(token), `duplicate delivery ${token}`); seen.add(token);
				const w = f.workers.get(worker); assert.ok(w);
				const state = await f.status(worker);
				const n = state.nodes.find(n => n.token === token && n.state === "writing"); assert.ok(n, "delivery without a writable assignment");
				const p = nodes.get(n.grain); assert.ok(p);
				const grain = p.id, pass = attempts.get(grain) ?? 0;
				assert.ok(pass < 2, `unbounded regeneration of ${grain}`); attempts.set(grain, pass + 1);
				const payload = app === clearing && grain === "reduce-0" && !pass ? p.body.replace("!r.reversed", "true") : p.body;
				const wave = path.join(gate, String(pass)), withhold = missing && pass && grain === "reduce-0" ? grain : "";
				const { stdout } = await exec(process.execPath, [participant, f.root, app.id, worker, token, payload, wave, withhold, script,
					...(grain==="section-0"?[JSON.stringify({held,consumer})]:[])],
					{ cwd: w.cwd, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
				const reply = /** @type {Reply} */ (JSON.parse(stdout));
				await recordReviews(reply.reviews);
				for (const child of reply.workers) { assert.ok(!f.workers.has(child.id)); f.workers.set(child.id, child); }
				await drain(reply.inbox);
			} catch (error) {
				writeFileSync(path.join(gate, "abort"), "stop waiting"); throw error;
			}
		}));
		const failure = results.find(r => r.status === "rejected"); if (failure) throw failure.reason;
	}
	assert.equal((await f.start()).limit, null);
	assert.equal(f.workers.size, 0);
	assert.deepEqual(f.scouts.map(s => s.squad), squads);
	await driveProjections(f,plan,recordReviews,drain);
	const s = await f.status(), db = openDatabase(f.root); t.after(() => db.close());
	const run = db.read(app.id); assert.ok(run);
	assert.ok(s.products && s.products.length >= (missing ? 3 : 4), s.blocker ?? "delivery queue drained before the expected checkpoint");
	assert.ok(history.size >= 3, "reviews must observe the checked stages, not just the final product");
	for (const checkpoint of history.values())
		assert.deepEqual(s.products.find(p => p.check === checkpoint.check), checkpoint, "a previously observed checkpoint must not change");
	assert.ok(s.products.every(p => p.receipt?.commit === p.commit && p.receipt.check === product && p.receipt.exit === 0));
	assert.equal(git(f.root, "rev-parse", "main"), f.tip);
	const repair = app === clearing, failedJoins = run.effects.filter(e => e.kind === "product" && e.receipt?.exit !== 0);
	assert.deepEqual(failedJoins.map(e => e.receipt?.repair), repair ? ["reduce-0"] : []);
	assert.equal(s.goal?.receipt?.commit, s.checkpoint); assert.equal(s.goal?.receipt?.check, goal);
	if (missing) {
		assert.equal(s.qualified, null); assert.equal(s.goal?.receipt?.exit, 1);
		assert.deepEqual(s.pending.map(e => [e.id, e.state]), [[run.nodes["reduce-0"].check, "uncertain"]]);
	} else {
		assert.ok(s.qualified, s.blocker ?? "delivery queue drained before qualification");
		assert.equal(s.checkpoint, s.qualified); assert.equal(s.goal?.receipt?.exit, 0);
		assert.deepEqual(s.pending, []);
	}
	const invalidated = new Set(repair ? ["reduce-0"] : []);
	assert.equal(attempts.size, nodes.size);
	for (const p of nodes.values()) {
		if (p.needs.some(id => invalidated.has(id))) invalidated.add(p.id);
		const count = invalidated.has(p.id) && (!missing || p.id === "reduce-0") ? 2 : 1;
		assert.equal(attempts.get(p.id), count, `unexpected attempts for ${p.id}`);
		/** @type {import("./model.js").Effect[]} */ const effects = run.effects.filter(e => e.kind === "component" && e.grain === p.id);
		assert.equal(effects.length, count);
		/** @type {import("./model.js").Node} */ const n = run.nodes[p.id];
		if (missing && p.id === "reduce-0") {
			assert.deepEqual(effects.map(e => e.receipt?.exit), [0, undefined]); assert.equal(n.state, "checking");
		} else {
			assert.ok(effects.every(e => e.receipt?.exit === 0));
			if (missing && invalidated.has(p.id)) {
				assert.equal(n.state, "waiting"); assert.equal(n.generation, undefined); // Cannot consume the old journal.
			} else {
				assert.equal(n.state, "qualified"); assert.equal(n.candidate, s.outputs?.[p.id]);
				for (const id of p.needs) assert.equal(n.inputs?.[id], s.outputs?.[id], `${p.id} consumed stale ${id}`);
			}
		}
	}
	for (const stage of ["read","reduce","view"]) assertOverlap(path.join(gate, "0"), stage, lanes);
	if (repair && !missing) assertOverlap(path.join(gate, "1"), "view", lanes);
	t.diagnostic(`${squads.length} squads, ${nodes.size} directories; ${app.width} overlapping writers in ${repair && !missing ? 4 : 3} waves; ${s.products.length} checked milestones`);
});

test("a checkpoint survey delivered to the original owner while a writer is in flight drives its original dependent once",async t=>{
	const id="late",file=".foundry/late.json",squad="team",direction="Deliver both outputs.";
	const parts=[{id:"first",directory:"unit/first",squad,needs:[]},{id:"second",directory:"unit/second",squad,needs:["first"]}];
	const f=factory(t,id,file,{[file]:JSON.stringify({version:2,id,target:"refs/heads/main",direction,productCheck:"product.mjs",goalCheck:"goal.mjs",
		squads:[{id:squad,areas:["unit"],charter:".foundry/team.md",boundary:["api"],checks:["unit.mjs"]}]}),".foundry/team.md":"Provide both.",
		api:"Stable.","unit.mjs":"","product.mjs":"","goal.mjs":'import {existsSync} from "node:fs";if(!existsSync("unit/second/index.mjs"))process.exit(1);'});
	await f.start();let woke=false;const plan={direction,check:"unit.mjs",parts};
	const delivered=new Set(),jobs=new Set();
	/** @param {Awaited<ReturnType<typeof reportProjections>>} rows */
	async function received(rows){for(const r of rows){assert.ok(!jobs.has(r.id));jobs.add(r.id);}}
	/** @param {typeof f.inbox} entries */
	async function deliver(entries){
		await Promise.all(entries.map(async ({worker,token})=>{
			assert.ok(!delivered.has(token));delivered.add(token);
			const w=f.workers.get(worker);assert.ok(w);
			const state=await f.status(w.id),node=state.nodes.find(n=>n.token===token);assert.ok(node && typeof node.directory==="string");
			const host=nativeHost(f.root,token),scouts=workflowHost();
			/** @type {ReturnType<typeof createRuntime>} */
			const writer=settleSubmitted(createRuntime(w.cwd,{mode:async()=>"interactive",permissionBlocker:async()=>null,...scriptedInspections(f.root),
				notify:async()=>"notice",scout:(run,dispatch,actor)=>scouts.launch(writer,run,dispatch,actor),
				execute:async(tool,args,key)=>{
					const result=await host.execute(tool,args,key);
					if(!woke && tool==="bash" && String(args.description).startsWith("Check joined product")){
						woke=true;f.owner.turn("owner");await f.owner.flush();await f.settle();
					}return result;
				}}));
			try{
				put(w.cwd,node.directory+"/index.mjs","export default 1;");
				await writer.operation("submit",{run:id,token},w.id);
				await received(await reportProjections(f.root,scouts,plan));await writer.flush();
				for(const [id,w] of host.workers)f.workers.set(id,w);
				await deliver(host.inbox);
			}finally{writer.close();}
		}));
	}
	await driveProjections(f,plan,received,deliver);
	const s=await f.status();assert.ok(woke);assert.ok(s.qualified,"the checkpoint's already-delivered owner survey must reach the original dependent");
	assert.equal(delivered.size,2);assert.deepEqual(Object.keys(s.outputs??{}).sort(),["first","second"]);
	assert.ok(f.scouts.length>1 && f.scouts.every(x=>jobs.has(x.id)),"all actually emitted owner reports were serviced once");
});

for(const pass of [true,false])test(`the original signed district submission, not its later stdout delivery, releases its peer / ${pass?"pass":"failure"}`,async t=>{
	const run="barrier",brief=".foundry/barrier.json",ids=["independent","held","dependent"];
	const f=factory(t,run,brief,{[brief]:JSON.stringify({version:1,id:run,target:"refs/heads/main",direction:"Check independent outputs.",
		seed:ids,limits:{repairs:0},productCheck:"product.mjs",grains:ids.map(id=>({id,directory:id,check:"unit.mjs",specification:"spec",boundary:["api"],
			needs:id==="dependent"?["held"]:[]}))}),spec:"Check the output.",api:"Stable.","product.mjs":"",
		"unit.mjs":`import {writeFileSync,existsSync} from "node:fs";import {setTimeout as wait} from "node:timers/promises";
			const dir=process.env.FOUNDRY_TEST_RENDEZVOUS;if(process.env.FOUNDRY_GRAIN==="held"){
				writeFileSync(dir+"/entered","");while(!existsSync(dir+"/release")){if(existsSync(dir+"/abort"))process.exit(2);await wait(10);}
			}else if(!${pass})process.exit(1);`});
	const gate=path.join(path.dirname(f.root),"proof");mkdirSync(gate);
	const s=await f.start(),worker=(/** @type {string} */ id)=>f.workers.get(s.nodes.find(n=>n.grain===id)?.worker??"")??assert.fail();
	const held=worker("held"),section=worker("independent"),plan=JSON.stringify({direction:"Check.",check:"unit.mjs",parts:[]});
	const start=(/** @type {typeof held} */ w,probe="")=>exec(process.execPath,[participant,f.root,run,w.id,w.token,"export default 1;",gate,"",plan,probe],
		{cwd:w.cwd,timeout:180000,maxBuffer:8*1024*1024});
	const first=start(held);
	try{
		const end=Date.now()+30_000;
		while(!existsSync(path.join(gate,"entered"))){assert.ok(Date.now()<end,"original peer never claimed");await wait(10);}
		const probe=start(section,JSON.stringify({held:"held",consumer:"dependent"}));
		if(pass){
			await probe;assert.ok(existsSync(path.join(gate,"release")),"the completed original submission must release its peer without the owner processing stdout");
			await first;const receipt=(await f.status()).nodes.find(n=>n.grain==="held")?.receipt;assert.ok(receipt && receipt.exit===0);
		}else{
			await assert.rejects(probe,/passing independent submission/);assert.equal(existsSync(path.join(gate,"release")),false);
			assert.equal((await f.status()).nodes.find(n=>n.grain==="held")?.receipt,undefined);
		}
	}finally{writeFileSync(path.join(gate,"abort"),"");await first;}
});
