import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openDatabase } from "../work/database.mjs";
import { factory, git } from "./fixture.mjs";

const source = ".foundry/contract.json", unit = ".foundry/unit.mjs", product = ".foundry/product.mjs", goal = ".foundry/goal.mjs";
const participant = fileURLToPath(new URL("./participant.mjs", import.meta.url)), exec = promisify(execFile);
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
	const gate = path.join(path.dirname(f.root), "gates");
	for (const pass of ["0","1"]) mkdirSync(path.join(gate, pass), { recursive: true });
	const seen = new Set(), held = `view-${lanes.at(-1)}`, consumer = `section-${squads.length - 1}`;
	/** @typedef {Awaited<ReturnType<typeof f.status>>} State */
	/** @type {Map<string,NonNullable<State["products"]>[number]>} */ const history = new Map();
	/** @type {Map<string,number>} */ const attempts = new Map();
	/** @typedef {typeof f.inbox[number]} Delivery */
	/** @typedef {{workers:Array<NonNullable<ReturnType<typeof f.workers.get>>>,inbox:Delivery[]}} Reply */
	/** Descendants are driven only by actual deliveries, never by polling the owner's actionable nodes.
	 * @param {Delivery[]} events @returns {Promise<void>} */
	async function drain(events) {
		const results = await Promise.allSettled(events.map(async ({ worker, token }) => {
			try {
				assert.ok(!seen.has(token), `duplicate delivery ${token}`); seen.add(token);
				const w = f.workers.get(worker); assert.ok(w);
				const state = await f.status(worker), review = state.reviews.find(r => r.token === token && r.state === "reading");
				let op, payload, grain = "", pass = 0;
				if (review) {
					if (review.base !== f.tip && !history.has(review.base)) {
						const checkpoint = (await f.status()).products?.at(-1); assert.equal(checkpoint?.commit, review.base);
						assert.ok(checkpoint); history.set(review.base, checkpoint);
					}
					/** @param {string} id */
					const present = id => existsSync(path.join(w.cwd, nodes.get(id)?.directory ?? assert.fail(id), "index.mjs"));
					const batch = [...nodes.values()].filter(p => p.squad === review.squad && !present(p.id) && p.needs.every(present));
					// A district can propose its section together with its own views in the same report.
					const section = [...nodes.values()].find(p => p.squad === review.squad && p.id.startsWith("section-"));
					if (section && !present(section.id) && !batch.includes(section) && section.needs.every(id => present(id) || batch.some(p => p.id === id))) batch.push(section);
					const grains = batch.map(p => ({ id: p.id, directory: p.directory, needs: p.needs, task: `Implement ${p.id}: ${app.direction}`, check: unit }));
					op = "observe"; payload = JSON.stringify({ grains, outcome: grains.length ? "regenerate" : "no-gap", reason: "Implement the next incomplete projection on this checked tree", evidence: [`.foundry/${review.squad}.md`] });
				} else {
					const n = state.nodes.find(n => n.token === token && n.state === "writing"); assert.ok(n, "delivery without a writable assignment");
					const p = nodes.get(n.grain); assert.ok(p);
					pass = attempts.get(p.id) ?? 0; assert.ok(pass < 2, `unbounded regeneration of ${p.id}`); attempts.set(p.id, pass + 1);
					op = "submit"; grain = p.id; payload = p.body;
					if (app === clearing && p.id === "reduce-0" && !pass) payload = payload.replace("!r.reversed", "true");
				}
				const wave = path.join(gate, String(pass)), withhold = missing && pass && grain === "reduce-0" ? grain : "";
				const { stdout } = await exec(process.execPath, [participant, f.root, app.id, worker, token, op, payload, wave, withhold],
					{ cwd: w.cwd, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
				if (grain === "section-0") {
					const s = await f.status(), independent = s.nodes.find(n => n.grain === grain);
					assert.ok(independent?.receipt && independent.receipt.exit === 0);
					assert.equal(s.nodes.find(n => n.grain === held)?.state, "checking");
					const waiting = s.nodes.find(n => n.grain === consumer);
					assert.equal(waiting?.state, "waiting"); assert.equal(waiting?.generation, undefined);
					assert.equal(s.qualified, null);
					writeFileSync(path.join(wave, "release"), "", { flag: "wx" }); // Release only the test evaluator, not the scheduler.
				}
				const reply = /** @type {Reply} */ (JSON.parse(stdout));
				for (const child of reply.workers) { assert.ok(!f.workers.has(child.id)); f.workers.set(child.id, child); }
				await drain(reply.inbox);
			} catch (error) {
				writeFileSync(path.join(gate, "abort"), "stop waiting"); throw error;
			}
		}));
		const failure = results.find(r => r.status === "rejected"); if (failure) throw failure.reason;
	}
	assert.equal((await f.start()).limit, null);
	await drain(f.inbox);
	const s = await f.status(), db = openDatabase(f.root); t.after(() => db.close());
	const run = db.read(app.id); assert.ok(run);
	assert.equal(s.products?.length, missing ? 3 : 4, s.blocker ?? "delivery queue drained before the expected checkpoint");
	assert.deepEqual(s.products.slice(0, 3), [...history.values()], "prior checkpoint commits, outputs and receipts must not change");
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
		/** @type {import("../work/model.js").Effect[]} */ const effects = run.effects.filter(e => e.kind === "component" && e.grain === p.id);
		assert.equal(effects.length, count);
		/** @type {import("../work/model.js").Node} */ const n = run.nodes[p.id];
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
