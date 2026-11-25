import assert from "node:assert/strict";
import test from "node:test";
import { pairInputs, checkedPair } from "../test/ownership.mjs";
import { git } from "../test/fixture.mjs";
import { currentPair, preparePair } from "./pairing.mjs";
import { createRuntime } from "./runtime.mjs";
import { decode } from "./snapshot.mjs";
import { partitionConflict } from "./partition.mjs";

for (const mode of ["failed attestation","negative pair","unchanged pair"]) test(`partial repartition of a checked mixed grant / ${mode}`,async t=>{
	const c=await pairInputs(t,mode);
	const {f,run,primary,parent,db,file,number,negative,state,node,original,args,commit,beforeObserver,citation,next,pins,attester,b,current,priorChecks,a}=c;
	if (mode==="unchanged pair") {
		await assert.rejects(next.operation("pair",args,"owner"),{code:"unchanged_pair"});
		assert.deepEqual(db.read(run),state);assert.equal(f.workers.size,number);return;
	}
	await assert.rejects(next.operation("pair",{...args,candidate:commit},"owner"),{code:"stale_assignment"});
	await assert.rejects(next.operation("pair",{...args,retainer:"rail",candidate:b.checked,component:b.check},"owner"),{code:"invalid_pair"});
	await assert.rejects(f.runtime(f.root,{confirm:async()=>false},createRuntime).operation("pair",args,"owner"),{code:"approval_declined"});
	const inspect=(/** @type {typeof state} */ s)=>preparePair(f.root,s,"owner",args,e=>db.verifySigned(run,e));
	const consumer=structuredClone(state);consumer.nodes.rail.supporting=[citation];
	assert.throws(()=>inspect(consumer),{code:"dispatch_held",message:/rail/});
	const changed=structuredClone(state);assert.ok(changed.nodes.selector.restoration);
	changed.nodes.selector.restoration.tree=f.tip;
	assert.throws(()=>inspect(changed),{code:"invalid_pair"});
	const evaluator=structuredClone(state);evaluator.nodes.selector.grain.check="product.mjs";
	assert.throws(()=>inspect(evaluator),{code:"invalid_pair"});
	const preview=inspect(state), stale=structuredClone(state);stale.nodes.buttons.check=b.check;
	assert.throws(()=>preview.apply(stale),{code:"stale_assignment"});
	const reserved=structuredClone(state);preview.apply(reserved);
	const e=reserved.effects.at(-1);assert.ok(e?.kind==="component" && e.pair && currentPair(f.root,reserved,e));
	reserved.nodes.rail.supporting=[citation];assert.equal(currentPair(f.root,reserved,e),false);
	const racing=f.runtime(f.root,{confirm:async()=>{await next.operation("pair",args,"owner");return true;}},beforeObserver);
	await assert.rejects(racing.operation("pair",args,"owner"),{code:negative?"invalid_pair":"goal_met"});
	const {end,checked,receipt,saved,paired}=await checkedPair(c);
	assert.ok(checked.receipt && receipt?.pair && paired.pair);
	assert.equal(f.workers.size,number);assert.deepEqual(db.read(run)?.effects.find(e=>e.id===node.check),original);
	assert.match(checked.receipt.output,/Checked control: current button/);
	assert.equal(git(f.root,"rev-parse",`${checked.receipt.commit}:${primary}`),git(f.root,"rev-parse",`${commit}:${primary}`));
	assert.equal(git(f.root,"rev-parse",`${checked.receipt.commit}:${parent}`),git(f.root,"rev-parse",`${a.checked}:${parent}`));
	assert.equal(git(f.root,"diff-tree","-r","--name-only",commit,checked.receipt.commit,"--","unit/rail"),"");
	assert.deepEqual(receipt?.originalReceipt,node.receipt);assert.deepEqual(receipt?.receipt,checked.receipt);
	const forged={...paired,pair:{...paired.pair,tree:f.tip}};
	assert.throws(()=>db.verifySigned(run,forged),{code:"wrong_outcome"});
	assert.equal(git(f.root,"rev-parse","refs/heads/main"),f.tip);
	assert.ok(Object.entries(pins).every(([id,pin])=>saved.nodes[id].candidate===pin && saved.nodes[id].check===state.nodes[id].check));
	if (negative) {
		assert.ok(checked.state==="blocked" && checked.receipt.exit===1 && !end.qualified);
		assert.deepEqual(end.products,current.products);assert.deepEqual(end.goalChecks,current.goalChecks);
		await assert.rejects(next.operation("pair",{...args,failed:checked.check},"owner"),{code:"invalid_pair"});
		await assert.rejects(next.operation("pair",args,"owner"),{code:"invalid_pair"});
		assert.deepEqual(f.checks.slice(priorChecks.length).map(s=>s.split(" at ")[0]),["Check selector","Check selector"]);
		return;
	}
	assert.ok(end.qualified && end.qualification && end.outputs?.selector===checked.receipt.commit);
	const restored=end.qualification.outputs.find(o=>o.id==="selector");
	assert.deepEqual(restored?.pair,receipt.pair);
	assert.deepEqual(end.qualification.ownership?.selector,{directories:[primary],files:[]});
	assert.deepEqual(end.qualification.ownership?.buttons,{directories:[parent],files:[]});
	assert.ok(Object.entries(pins).every(([id,pin])=>end.outputs?.[id]===pin));
	assert.ok(!next.inspect({run,detail:"cleanup"},"owner").handoff?.writers?.some(w=>w.id===attester.id));
	const broken=structuredClone(saved), altered=broken.effects.find(e=>e.id===checked.check);assert.ok(altered?.kind==="component" && altered.pair);
	altered.pair.component=b.check??"";assert.throws(()=>decode(broken),{code:"corrupt_run"});
	reserved.nodes.selector.state="published";delete reserved.nodes.rail.supporting;
	assert.equal(partitionConflict(reserved),undefined);reserved.nodes.buttons.check=b.check;
	assert.match(partitionConflict(reserved)??"",/no longer matches/);
	assert.deepEqual(end.products?.slice(0,-1),current.products);assert.deepEqual(end.goalChecks?.slice(0,-1),current.goalChecks);
	assert.deepEqual(f.checks.slice(priorChecks.length).map(s=>s.split(" at ")[0]),["Check selector","Check selector","Check joined product","Check final goal"]);
});
