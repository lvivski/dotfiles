import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { factory, git, put } from "../test/fixture.mjs";
import { openDatabase } from "./database.mjs";
import { observe, parseObservation } from "./graph.mjs";
import { issue } from "./native.mjs";
import { combine } from "./product.mjs";
import { decode } from "./snapshot.mjs";

for (const legacy of [false,true]) test(`an approved integration file and primary directory are checked, attributed and repaired as one grain / ${legacy?"legacy checkpoint upgrade":"new brief"}`, async t => {
	const run="labels", source=".foundry/labels.json", directory="render/labels", file="render/views/index", sibling="render/views/menu";
	const product=".foundry/labels/milestone.mjs";
	const checker=`import assert from "node:assert/strict";import {readFileSync as read} from "node:fs";
			const ids=JSON.parse(process.env.FOUNDRY_OUTPUTS);if(ids.labels){const owners=JSON.parse(process.env.FOUNDRY_OWNERSHIP);
			assert.equal(ids.labels,"render/labels");assert.deepEqual(owners.labels,{directories:["render/labels"],files:["render/views/index"]});
			const owner=p=>Object.keys(owners).find(id=>owners[id].files.includes(p)||owners[id].directories.some(d=>p===d||p.startsWith(d+"/")));
			assert.equal(owner("render/views/menu"),undefined);assert.equal(owner("render/views/index/nested"),undefined);
			if(read("render/views/index","utf8")!=="formatted"){console.log("FOUNDRY_REPAIR="+owner("render/views/index"));process.exit(1);}}`;
	const f=factory(t,run,source,{
		[source]:JSON.stringify({version:2,id:run,direction:"Show formatted labels.",...(legacy?{}:{ownership:"exact-files"}),target:"refs/heads/main",
			productCheck:product,goalCheck:"goal.mjs",squads:[{id:"renderer",areas:["render"],charter:"render.md",checks:["unit.mjs"]}]}),
		".foundry/labels/journey.md":"Render a formatted label.", "render.md":"Maintain the rendering package.",[file]:"plain",[sibling]:"keep",
		"unit.mjs":`import assert from "node:assert/strict";if(process.env.FOUNDRY_GRAIN==="labels"){
			assert.equal(process.env.FOUNDRY_DIRECTORY,${JSON.stringify(directory)});assert.deepEqual(JSON.parse(process.env.FOUNDRY_FILES),[${JSON.stringify(file)}]);}`,
		[product]:legacy ? `for(const d of Object.values(JSON.parse(process.env.FOUNDRY_OUTPUTS))) if(typeof d!=="string")process.exit(1);` : checker,
		"goal.mjs":`import {existsSync as has,readFileSync as read} from "node:fs";process.exit(!has("render/data/value")?1:
			has("render/labels/value")&&read("render/views/index","utf8")==="formatted"&&read("render/views/menu","utf8")==="keep"?0:2);`,
	});
	const report=(/** @type {string} */ id,/** @type {unknown} */ dir,/** @type {string} */ evidence)=>({outcome:"regenerate",reason:"Render labels.",
		evidence:[evidence],grains:[{id,directory:dir,check:"unit.mjs",needs:[],task:"Render "+id}]});
	const prior=legacy && process.env.FOUNDRY_PREVIOUS_WORK ? (await import(pathToFileURL(path.join(process.env.FOUNDRY_PREVIOUS_WORK,"runtime.mjs")).href)).createRuntime : undefined;
	const original=f.runtime(f.root,undefined,prior);
	await f.start(original); await f.scouts[0].report(report("data","render/data","render.md"));
	const [data]=f.workers.values(); put(data.cwd,"render/data/value","ready");
	const producer=f.runtime(data.cwd,undefined,prior);
	await producer.operation("submit",{run,token:data.token},data.id); await f.settle();
	original.close(); producer.close();
	const at=f.owner.inspect({run,detail:"proof"},"owner").goalChecks?.at(-1); assert.ok(at?.commit && at.receipt?.exit===2);
	put(f.root,"sample","Use formatted labels.");
	const [offer]=(await f.owner.operation("publish",{run,file:"sample",to:[directory]},"owner")).artifacts;
	const args={run,directory,files:[file],receipt:at.id,blob:offer.blob,question:"Use the formatted renderer.",source:{commit:at.commit,file,excerpt:"plain"}};
	const owner=f.runtime(f.root,{confirm:async prompt=>{assert.ok(prompt.includes(file) && prompt.includes(directory));return true;}});
	if (legacy) {
		await assert.rejects(owner.operation("iterate",args,"owner"),{code:"unsupported_ownership"});
		const side=path.join(path.dirname(f.root),"checker");
		git(f.root,"worktree","add","-q","--detach",side,f.tip);put(side,product,checker);
		git(side,"commit","-qam","Attribute files to their actual owner");
		const pin={run,kind:"product",from:f.tip,revision:git(side,"rev-parse","HEAD"),files:[product]};
		await f.runtime(f.root,{confirm:async p=>p.includes("product evaluator only")}).operation("repin",pin,"owner");
		const current=owner.inspect({run,detail:"proof"},"owner").goalChecks?.at(-1);
		assert.ok(current?.commit===at.commit && current.receipt?.exit===2 && current.id!==at.id);
		await assert.rejects(owner.operation("iterate",args,"owner"),{code:"invalid_receipt"});
		args.receipt=current.id;
	}
	await assert.rejects(owner.operation("iterate",{...args,files:[directory+"/nested"]},"owner"));
	await assert.rejects(owner.operation("iterate",{...args,files:["outside/item"]},"owner"));
	await assert.rejects(owner.operation("iterate",{...args,files:[file,file.toUpperCase()]},"owner"),{code:"overlapping_ownership"});
	await assert.rejects(owner.operation("iterate",{...args,files:["render/data/value"]},"owner"),{code:"ownership_transition"});
	const count=f.scouts.length;
	await assert.rejects(f.runtime(f.root,{confirm:async()=>false}).operation("iterate",args,"owner"),{code:"approval_declined"});
	assert.equal(f.scouts.length,count);
	await owner.operation("iterate",args,"owner"); await f.settle();
	const scout=f.scouts.at(-1); assert.ok(scout);
	if (!legacy) {
		const db=openDatabase(f.root), seed=db.read(run); db.close(); assert.ok(seed);
		for (const wider of [{primary:directory,files:[file,sibling]},"render/views","render"]) {
			/** @type {import("./model.js").Run} */ const copy=structuredClone(seed);
			/** @type {import("./model.js").Effect|undefined} */ const review=copy.effects.find(e=>e.id===scout.id);
			assert.ok(review?.kind==="scout");
			assert.throws(()=>observe(f.root,copy,review,parseObservation(copy.policy.squads[0],report("labels",wider,file))),{code:"charter_scope"});
		}
	}
	await scout.report(report("labels",{primary:directory,files:[file]},file));
	const row=(await f.status()).nodes.find(n=>n.grain==="labels");
	const w=f.workers.get(row?.worker ?? ""); assert.ok(w,JSON.stringify((await f.status()).reviews));
	const writer=f.runtime(w.cwd); assert.equal(git(w.cwd,"show",`HEAD:${file}`),"plain");
	put(w.cwd,`${directory}/value`,"present");
	if (!legacy) {
		const integration=path.join(w.cwd,file);
		unlinkSync(integration); mkdirSync(integration);
		await assert.rejects(writer.operation("submit",{run,token:w.token},w.id),{code:"unsupported_tree"});
		rmdirSync(integration); symlinkSync("menu",integration);
		await assert.rejects(writer.operation("submit",{run,token:w.token},w.id),{code:"unsupported_tree"});
		unlinkSync(integration);
	}
	put(w.cwd,file,"wrong"); put(w.cwd,sibling,"not owned");
	await assert.rejects(writer.operation("publish",{run,token:w.token,file:sibling,to:[directory]},w.id),/outside/);
	await writer.operation("submit",{run,token:w.token},w.id); await f.settle();
	const repair=writer.inspect({run},w.id).nodes.find(n=>n.grain==="labels"); assert.ok(repair?.token && repair.token!==w.token);
	put(w.cwd,file,"formatted"); await writer.operation("submit",{run,token:repair.token},w.id); await f.settle();
	const end=await f.status(); assert.ok(end.qualified,JSON.stringify(end));
	assert.equal(git(f.root,"show",`${end.qualified}:${file}`),"formatted");assert.equal(git(f.root,"show",`${end.qualified}:${sibling}`),"keep");
	assert.equal(git(f.root,"show",`${end.qualified}:${directory}/value`),"present");
	if (!legacy) {
		const side=path.join(path.dirname(f.root),"other-target");
		git(f.root,"worktree","add","-q","--detach",side,at.commit); put(side,sibling,"concurrent sibling"); git(side,"commit","-qam","Edit sibling");
		const update={directory:file,from:at.commit,to:end.qualified,exact:true};
		const joined=combine(f.root,git(side,"rev-parse","HEAD"),[update]);
		assert.equal(git(f.root,"show",`${joined}:${sibling}`),"concurrent sibling"); assert.equal(git(f.root,"show",`${joined}:${file}`),"formatted");
		put(side,file,"concurrent integration"); git(side,"commit","-qam","Edit integration file");
		assert.throws(()=>combine(f.root,git(side,"rev-parse","HEAD"),[update]),{code:"tree_conflict"});
	}
});

/** @param {import("node:test").TestContext} t @param {Record<string,string>} [files] */
function codec(t, files) {
	const run = "codec", source = ".foundry/codec.json", roots = ["codec/decode","codec/encode"];
	const f = factory(t,run,source,{
		[source]:JSON.stringify({id:run,version:2,target:"refs/heads/main",direction:"Deliver the codec.",goalCheck:"goal.mjs",productCheck:"product.mjs",
			squads:[{id:"format",areas:["codec"],charter:"format.md",checks:["unit.mjs"]}]}),
		".foundry/codec/journey.md":"Round-trip a value.", "format.md":"Own the codec.",
		"unit.mjs":`import assert from 'node:assert/strict'; import {readFileSync as read} from 'node:fs';
			if(process.env.FOUNDRY_GRAIN==='pair'){
				assert.equal(process.env.FOUNDRY_DIRECTORY,undefined);
				assert.deepEqual(JSON.parse(process.env.FOUNDRY_DIRECTORIES),${JSON.stringify(roots)});
				for(const p of ${JSON.stringify(roots)}) assert.equal(read(p+'/value','utf8'),'paired');
			}`,
		"product.mjs":`import assert from 'node:assert/strict'; const p=JSON.parse(process.env.FOUNDRY_OUTPUTS);
			if(p.pair)assert.deepEqual(p.pair,${JSON.stringify(roots)});`,
		"goal.mjs":`import {readFileSync as read,existsSync} from 'node:fs';
			for(const [p,v] of [['decode','paired'],['encode','paired'],['checksum','peer'],['keep','original']])
				if(!existsSync('codec/'+p+'/value')||read('codec/'+p+'/value','utf8')!==v)process.exit(1);`,
		...files,
	});

	return {run,roots,f};
}

test("a fresh review can withdraw only an untouched broad reservation, not an issued or held start", async t => {
	const {run,f}=codec(t);
	await f.start();
	const [s]=f.scouts;
	const db=openDatabase(f.root); t.after(()=>db.close());
	const proposed=(/** @type {string} */ id,/** @type {string|string[]} */ directory)=>({id,directory,task:id,check:"unit.mjs",needs:[]});
	await s.report({outcome:"regenerate",reason:"Missing codec.",evidence:["format.md"],grains:[proposed("broad","codec")]});
	const seed=db.read(run); assert.ok(seed);
	for(const kind of ["issued","uncertain","held","prepared","outside charter","overlap","ready"]){
		/** @type {import("./model.js").Run} */ const r=structuredClone(seed);
		const n=r.nodes.broad, w=r.effects.find(e=>e.kind==="writer");
		const review=r.effects.find(e=>e.kind==="scout"); assert.ok(w?.kind==="writer" && review?.kind==="scout");
		const fresh={...review,id:"new-review",observation:undefined};
		assert.ok(fresh.packet); fresh.packet={...fresh.packet,review:fresh.id}; r.effects.push(fresh);
		delete n.worker; delete w.nativeId; delete w.boundAt;
		w.state=kind==="issued"||kind==="uncertain"?kind:kind==="prepared"?"ordinary":"ready";
		if(w.state==="ready") delete w.callId;
		if(kind==="held") w.permissionHold="permission pending";
		const scope=kind==="outside charter"?["codec/decode","other/encode"]:kind==="overlap"?["codec/decode","codec/Decode/item"]:["codec/decode","codec/encode"];
		const apply=()=>observe(f.root,r,fresh,parseObservation(r.policy.squads[0],{outcome:"regenerate",reason:"Separate checksum.",evidence:["format.md"],replace:["broad"],
			grains:[proposed("pair",scope),proposed("checksum","codec/checksum")]}));
		if(kind!=="ready"){
			assert.throws(apply,kind==="outside charter"?/charter/:kind==="overlap"?/disjoint/:/split|reserved|frozen/);
			assert.equal(r.nodes.broad,n); assert.equal(r.nodes.pair,undefined); continue;
		}
		const old=structuredClone(w); apply();
		assert.deepEqual(Object.keys(r.nodes).sort(),["checksum","pair"]);
		assert.equal(w.state,"withdrawn"); assert.equal(issue(r,old,"late-call"),false);
		decode(JSON.parse(JSON.stringify(r)));
	}
});

test("a repeated broad output cannot be split on an unchecked baseline", async t=>{
	const {f,run,roots}=codec(t);
	await f.start();
	const proposal=(/** @type {string} */ id,/** @type {string|string[]} */ directory)=>({
		outcome:"regenerate",reason:"Complete the codec.",evidence:["format.md"],grains:[{id,directory,task:id,check:"unit.mjs",needs:[]}]});
	await f.scouts[0].report(proposal("broad","codec"));
	const [w]=f.workers.values();
	await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
	await f.settle();
	const before=await f.status(); assert.equal(before.nodes[0].state,"repeated"); assert.equal(before.checkpoint,null);
	const next=f.scouts.at(-1); assert.ok(next && next.id!==f.scouts[0].id);
	await next.report(proposal("pair",roots));
	const after=await f.status(); assert.deepEqual(after.nodes,before.nodes);
	assert.match(after.reviews.find(r=>r.id===next.id)?.reason ?? "",/has not passed a product checkpoint/);
});

test("a stopped pair's inspection grant lists only the prior roots that exist",async t=>{
	const {f,run,roots}=codec(t,{"codec/encode/original":"preserve","codec/other/original":"not granted"});
	await f.start();
	await f.scouts[0].report({outcome:"regenerate",reason:"Maintain both.",evidence:["format.md"],
		grains:[{id:"pair",directory:roots,task:"Preserve inventory.",check:"unit.mjs",needs:[]}]});
	const [w]=f.workers.values(), writer=f.runtime(w.cwd);
	await writer.operation("submit",{run,token:w.token,missingInput:"Need the prior inventory."},w.id);
	await f.runtime(f.root,{confirm:async prompt=>{
		assert.ok(prompt.includes(`${f.tip}:codec/encode/`) && !prompt.includes("codec/other")); return true;
	}}).operation("publish",{run,readBaselines:["pair"]},"owner");
	const row=f.runtime(w.cwd).inspect({run},w.id).nodes[0];
	assert.deepEqual(row.readGrant,[{directory:"codec/encode",revision:f.tip,tree:git(f.root,"rev-parse",`${f.tip}:codec/encode`)}]);
	assert.equal(row.state,"blocked"); assert.equal(row.baseline,undefined);
});

for (const conflict of [false,true]) test(`a finished broad writer and a peer deliver an atomic pair and its independent sibling / ${conflict?"second root conflict":"repair then qualify"}`, async t => {
	const {run,roots,f}=codec(t), opts = {idleWriter:async (/** @type {string} */ id)=>f.workers.get(id)?.cwd};
	await f.start(f.runtime(f.root,opts));
	const propose = async (/** @type {{id:string,directory:string|string[]}[]} */ jobs) => {
		const scout=f.scouts.at(-1); assert.ok(scout);
		await scout.report({outcome:"regenerate",reason:"Complete the codec.",evidence:["format.md"],
			grains:jobs.map(g=>({...g,task:`Deliver ${g.id}`,check:"unit.mjs",needs:[]}))});
	};
	await propose([{id:"broad",directory:"codec"}]);
	const [broad]=f.workers.values(); assert.ok(broad);
	for(const dir of ["decode","encode","checksum","keep"]) put(broad.cwd,`codec/${dir}/value`,"original");
	await f.runtime(broad.cwd,opts).operation("submit",{run,token:broad.token},broad.id);
	await f.settle();
	await propose([{id:"pair",directory:roots.toReversed()},{id:"checksum",directory:"codec/checksum"}]);
	const owner=f.runtime(f.root,opts), status=owner.inspect({run},"owner");
	assert.ok(status.checkpoint);
	const pair=status.nodes.find(n=>n.grain==="pair"), peer=status.nodes.find(n=>n.grain==="checksum");
	assert.ok(pair?.worker && peer?.worker,JSON.stringify(status.reviews));
	assert.notEqual(pair.worker,peer.worker);
	assert.ok([pair.worker,peer.worker].includes(broad.id));
	for(const n of [pair,peer]){
		const w=f.workers.get(n.worker ?? ""); assert.ok(w);
		const runtime=f.runtime(w.cwd,opts), row=runtime.inspect({run},w.id).nodes.find(v=>v.grain===n.grain);
		assert.ok(row?.token);
		if(row.workspace) {
			await assert.rejects(runtime.operation("submit",{run,token:broad.token},w.id),/assignment|token/);
			await runtime.operation("workspace",{run,token:row.token},w.id);
		}
		const cwd=path.join(w.cwd,row.workspace ?? "");
		for(const dir of n===pair?roots:["codec/checksum"]) {
			assert.equal(existsSync(path.join(cwd,dir)),false);
			put(cwd,`${dir}/value`,n===pair?"paired":"peer");
		}
		if(n===pair){
			put(cwd,"codec/checksum/value","unowned");
			await assert.rejects(runtime.operation("publish",{run,token:row.token,file:"codec/checksum/value",to:["codec/checksum"]},w.id),/outside/);
			await runtime.operation("publish",{run,token:row.token,file:"codec/encode/value",to:["codec/checksum"]},w.id);
			const draft=await runtime.operation("preview",{run,token:row.token},w.id);
			const pin=draft.nodes.find(v=>v.grain==="pair")?.preview; assert.ok(pin);
			assert.equal(git(cwd,"show",`${pin}:codec/checksum/value`),"original");
			for(const dir of roots) assert.equal(git(cwd,"show",`${pin}:${dir}/value`),"paired");
			if(conflict){
				put(f.root,"codec/encode/value","external"); git(f.root,"add","codec/encode"); git(f.root,"commit","-qm","independent target edit");
				await runtime.operation("submit",{run,token:row.token},w.id);
				const held=owner.inspect({run},"owner");
				assert.equal(held.qualified,null); assert.equal(held.checkpoint,status.checkpoint); assert.match(held.blocker ?? "",/conflict|concurrent|changed/i);
				assert.equal(git(f.root,"show",`${held.checkpoint}:codec/decode/value`),"original");
				assert.equal(git(f.root,"show","HEAD:codec/encode/value"),"external");
				return;
			}
			put(cwd,"codec/encode/value","incomplete");
			const failed=await runtime.operation("submit",{run,token:row.token},w.id);
			const repair=failed.nodes.find(v=>v.grain==="pair");
			assert.ok(repair?.token && repair.token!==row.token && repair.repairs===1);
			assert.equal(owner.inspect({run},"owner").checkpoint,status.checkpoint);
			put(cwd,"codec/encode/value","paired");
			await runtime.operation("submit",{run,token:repair.token},w.id);
			continue;
		}
		await runtime.operation("submit",{run,token:row.token},w.id);
	}
	const end=owner.inspect({run},"owner"); assert.ok(end.qualified);
	for(const [dir,v] of [["decode","paired"],["encode","paired"],["checksum","peer"],["keep","original"]])
		assert.equal(git(f.root,"show",`${end.qualified}:codec/${dir}/value`),v);
});
