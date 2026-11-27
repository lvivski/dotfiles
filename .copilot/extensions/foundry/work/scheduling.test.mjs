import { readPolicy } from "./brief.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {git,put} from "../test/fixture.mjs";
import {api,fixture,noGap,propose,readFile,run,source,worker} from "../test/release.mjs";
import {activate} from "./activity.mjs";
import {transition} from "./machine.mjs";
import {ledgerPath,openDatabase} from "./database.mjs";
import {advance,newRun} from "./graph.mjs";
import {reportReceiver} from "./reports.mjs";
import {scheduling} from "./scheduling.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {string} keys @param {(facts:Record<string,boolean>)=>string} outcome */
const cases=(keys,outcome)=>({keys:keys.split(" ").filter(Boolean),outcome});
/** @param {string} outcome */
const always=outcome=>cases("",()=>outcome);

test("every planning question selects the independently expected destination and effects for every finite input",()=>{
	const questions={
		ready:cases("active elapsed timely participant",f=>f.active && f.participant && (!f.elapsed || f.timely) ? "route/observe-target" : "done"),
		route:cases("targetKnown delivery independent owner elapsed hasJoin",f=>!f.targetKnown ? "done" : f.delivery ? "delivery" :
			f.independent ? f.owner && !f.elapsed && f.hasJoin ? "isolated/read-isolation" : "done" : f.elapsed ? "expired" : "reports/reconcile-writers"),
		delivery:cases("owner elapsed",f=>f.owner && !f.elapsed ? "done/advance-delivery" : "done"),
		isolated:cases("isolatedReceipt isolatedPass",f=>!f.isolatedReceipt ? "done" : f.isolatedPass ? "done/accept-isolation" : "done/reject-isolation"),
		expired:cases("sameGoalTarget liveWriter",f=>f.sameGoalTarget && !f.liveWriter ? "done/settle-timely" : "done"),
		reports:always("inputs/settle-reports"),
		inputs:cases("currentInputs",f=>f.currentInputs ? "renewal/admit-arrivals" : "renewal"),
		renewal:cases("owner",f=>f.owner ? "checks/renew-reports" : "checks"),
		checks:always("retries/settle-checks"),retries:always("release/retry-readers"),release:always("admission/assess-release"),
		admission:cases("admitted",f=>f.admitted ? "allocation/prepare-admission" : "done"),
		allocation:cases("writerSlot",f=>f.writerSlot ? "outputs/allocate-writers" : "outputs"),
		outputs:always("join/collect-outputs"),
		join:cases("outputs sameJoin outstandingProduct",f=>f.outputs && !f.sameJoin && !f.outstandingProduct ? "assembly/assemble-outputs" : "after-join"),
		assembly:cases("excluded",f=>f.excluded ? "survivors/settle-survivors" : "novelty/compare-assembly"),
		survivors:cases("hasGoal",f=>f.hasGoal ? "readmission/reassess-survivors" : "join/refresh-outputs"),
		readmission:cases("admitted",f=>f.admitted ? "join/refresh-outputs" : "done"),
		novelty:cases("noNewProduct",f=>f.noNewProduct ? "after-join" : "after-join/reserve-product"),
		"after-join":cases("recheckStopped",f=>f.recheckStopped ? "discovery/reassess-stopped" : "discovery"),
		discovery:cases("active mayDiscover budget surveyDue",f=>f.active && f.mayDiscover && f.budget && f.surveyDue ? "progress/reserve-surveys" : "done"),
		progress:cases("unmet pendingWork surveysFinished",f=>f.unmet && !f.pendingWork && f.surveysFinished ? "done/record-stall" : "done"),
	};
	const conflicts=new Set(["retries","release","admission","allocation","join","assembly","survivors","readmission","novelty","after-join"]);
	assert.deepEqual(new Set(Object.keys(scheduling.states)),new Set([...Object.keys(questions),"done"]));
	for (const [value,{keys,outcome}] of Object.entries(questions)) {
		const before=Object.freeze({value,context:null});
		for (let mask=0;mask<2**keys.length;mask++) {
			const facts=Object.fromEntries(keys.map((k,i)=>[k,!!(mask & (1<<i))]));
			const result=transition(scheduling,before,{type:"plan"},facts,true);
			assert.equal([result.snapshot.value,...result.effects.map(e=>e.type)].join("/"),outcome(facts),`${value} ${JSON.stringify(facts)}`);
		}
		const rejected=transition(scheduling,before,{type:"conflict"});
		assert.equal(rejected.snapshot.value,conflicts.has(value) ? "done" : value);
		assert.deepEqual(rejected.effects,conflicts.has(value) ? [{type:"record-conflict"}] : []);
		assert.equal(transition(scheduling,before,{type:"native-success"}).snapshot,before,"a native success is not a planning signal");
	}
	const done={value:"done",context:null};
	assert.equal(transition(scheduling,done,{type:"plan"}).snapshot,done);
});

/** Trace only the accepted transition, never replace a handler. @param {string} root @param {Run} draft @param {string} [actor] */
function trace(root,draft,actor="owner") {
	/** @type {import("./graph.mjs").PlanningStep[]} */ const steps=[];
	advance(root,draft,actor,false,{trace:steps});
	return {states:steps.map(s=>s.from),actions:steps.flatMap(s=>s.edge.action ? [s.edge.action] : [])};
}

test("a stopped pass does not even sample Git; an unavailable target or pending goal remains a clean wait",t=>{
	const f=fixture(t,["producer"],"false"), {policy,grains}=readPolicy(f.root,source), initial=newRun(f.root,policy,"owner",grains);
	for (const kind of ["pause","foreign issuer","late","missing target","pending goal"]) {
		const draft=structuredClone(initial);
		if (kind==="pause") activate(draft,"pause");
		if (kind==="late") draft.policy.deadline="2000-01-01T00:00:00Z";
		if (kind==="missing target") draft.policy.target="refs/heads/absent";
		const original=structuredClone(draft), {states,actions}=trace(f.root,draft,kind==="foreign issuer" ? "stranger" : "owner");
		if (kind==="missing target") assert.deepEqual(actions,["observe-target"]);
		else if (kind==="pending goal") assert.equal(states.at(-1),"admission");
		else assert.deepEqual({states,actions},{states:["ready"],actions:[]});
		assert.deepEqual(draft,original,kind);
	}
});

/** @param {ReturnType<typeof fixture>} f @param {Run[]} samples @param {(file:string)=>void} [capture] @returns {ReturnType<typeof fixture>["execute"]} */
const sampling=(f,samples,capture)=>async(tool,args,id)=>{
	const result=await f.execute(tool,args,id);
	if (tool==="bash") {
		const db=openDatabase(f.root);
		try {
			const draft=db.read(run), e=draft?.effects.find(e=>e.args.shellId===args.shellId);
			assert.ok(draft && e?.tool==="bash" && e.receipt);
			db.verifySigned(run,e);if(!samples.length)capture?.(db.file);samples.push(draft);
		} finally {db.close();}
	}
	return result;
};

/** Replay planning from the interval after the real reviewer returned but before its output was published.
 * @param {string} root @param {Run} sample @param {string} grain @param {string} actor */
function reviewed(root,sample,grain,actor){
	const draft=structuredClone(sample), db=openDatabase(root);
	try {
		trace(root,draft,actor);
		assert.equal(draft.nodes[grain].state,"reviewing");assert.ok(!draft.join);
		const check=draft.nodes[grain].check, i=db.read(run)?.inspections?.find(i=>i.component===check);
		assert.ok(i?.state==="approved" && i.candidate===draft.nodes[grain].candidate && draft.inspections);
		draft.inspections=draft.inspections.map(reservation=>reservation.component===check ? i : reservation);
		return draft;
	}finally{db.close();}
}

/** Deliver the same verified packet on a detached fixture snapshot, without issuing a new scout.
 * @param {Run} draft @param {import("../test/fixture.mjs").Scout} job @param {unknown} report */
async function reported(draft,job,report) {
	const receive=reportReceiver({read:()=>draft,record:(_,record)=>record(draft),signal:()=>undefined});
	await receive(run,job.dispatch,job.issuer,job.workflowId,job.id,report,job.packet);
	return draft;
}

test("a real pass reserves writers before surveys, records a demonstrated stall, and checks a Git assembly without qualifying it",async t=>{
	const f=fixture(t,["producer"],'has("producer/ready")',6);
	/** @type {Run[]} */ const samples=[];
	const forkFile=path.join(path.dirname(ledgerPath(f.root)),"planning.sqlite");
	const execute=sampling(f,samples,file=>{
		// Copy the actual ledger and spool before the first runner returns to its issuer.
		for(const suffix of ["",".outcomes"]){
			const src=new DatabaseSync(file+suffix,{readOnly:true});
			try{src.prepare("VACUUM INTO ?").run(forkFile+suffix);}finally{src.close();}
		}
	});
	await f.start(f.runtime(f.root,{execute}));
	const [gap]=samples,[job]=f.scouts,db=openDatabase(f.root);t.after(()=>db.close());
	assert.ok(gap && job);
	const reading=db.read(run);assert.ok(reading);

	const waiting=await reported(structuredClone(reading),job,propose("producer"));
	const plan=trace(f.root,waiting);
	assert.deepEqual(plan.actions.filter(a=>["settle-reports","admit-arrivals","assess-release","allocate-writers","reserve-surveys"].includes(a)),
		["settle-reports","admit-arrivals","assess-release","allocate-writers","reserve-surveys"]);
	assert.equal(waiting.nodes.producer.state,"writing");assert.equal(waiting.nodes.producer.review,job.id);
	assert.deepEqual(waiting.effects.map(e=>e.kind),["goal","scout","writer"]);
	const noWork=await reported(structuredClone(reading),job,noGap("producer"));
	assert.equal(trace(f.root,noWork).actions.at(-1),"record-stall");
	assert.match(noWork.goal?.stall ?? "",/No actionable grain/);
	assert.deepEqual(db.read(run),reading,"tracing a private plan does not commit it");

	// Force one real stale CAS. Its speculative reservation must disappear on the paused reread.
	const fork=openDatabase(f.root,forkFile);t.after(()=>fork.close());
	assert.deepEqual(fork.read(run),gap);
	/** @type {string[][]} */ const attempts=[];
	fork.planAndSwap(run,r=>{
		attempts.push(trace(f.root,r).actions);
		if (attempts.length===1) fork.mutateLocked(run,live=>activate(live,"pause"));
	});
	assert.equal(attempts.length,2);assert.ok(attempts[0].includes("reserve-surveys"));assert.deepEqual(attempts[1],[]);
	assert.deepEqual(fork.read(run),{...gap,active:false},"only the competing pause survives");

	await job.report(propose("producer"));
	const w=worker(f,"producer");put(w.cwd,"producer/ready","checked");
	await f.runtime(w.cwd,{execute}).operation("submit",{run,token:w.token},w.id);
	const component=samples.find(r=>r.nodes.producer?.state==="checking");assert.ok(component);
	const approved=reviewed(f.root,component,"producer",w.id),joined=structuredClone(approved), basis=Object.keys(joined).sort(), checks=[...f.checks];
	// The explorer can inspect the real next action without building anything or touching the ledger.
	const before=structuredClone(joined), state={value:"join",context:joined};
	assert.deepEqual(transition(scheduling,state,{type:"plan"},{outputs:true,sameJoin:false,outstandingProduct:false},true).effects,[{type:"assemble-outputs"}]);
	assert.deepEqual(joined,before);
	const {actions}=trace(f.root,joined);
	assert.deepEqual(actions.slice(-3),["assemble-outputs","compare-assembly","reserve-product"]);
	assert.ok(joined.join);assert.equal(git(f.root,"show",`${joined.join.commit}:producer/ready`),"checked");
	assert.deepEqual(joined.effects.slice(component.effects.length).map(e=>[e.kind,e.state,e.receipt]),[["product","ready",undefined]]);
	assert.deepEqual(joined.products,component.products);assert.equal(joined.goal?.check,component.goal?.check);
	assert.deepEqual(Object.keys(joined).sort(),[...basis,"join"].sort(),"no planning phase is durable");
	const unchanged=structuredClone(joined);
	assert.ok(!trace(f.root,joined).actions.includes("reserve-product"));assert.deepEqual(joined,unchanged);
	assert.deepEqual(f.checks,checks,"planning and inspection did not execute an evaluator");
	assert.ok(f.owner.inspect({run},"owner").qualified,"the real issuer handed off only after product and goal checks");

	// Settlement preceded this conflicting target edit in the pass; it is not rolled back with the failed assembly.
	put(f.root,"producer/ready","concurrent target edit");git(f.root,"add","producer/ready");git(f.root,"commit","-qm","Move an owned input");
	const dirty=structuredClone(approved);
	assert.deepEqual(trace(f.root,dirty).actions.slice(-2),["assemble-outputs","record-conflict"]);
	assert.equal(dirty.nodes.producer.state,"published");assert.match(dirty.conflict ?? "",/Concurrent modification of producer/);
	assert.deepEqual(dirty.effects,component.effects);assert.deepEqual(dirty.products,component.products);assert.equal(dirty.join,undefined);
});

test("after a cited input changes, the same pass excludes the checked consumer and reconsiders only surviving outputs",async t=>{
	const f=fixture(t,["producer","consumer"],'has("consumer/ready")',10);
	/** @type {Run[]} */ const samples=[];
	const execute=sampling(f,samples);
	await f.start(f.runtime(f.root,{execute}));
	const [producer,consumer]=f.scouts;
	await producer.report(propose("producer"));
	await consumer.report(readFile(api));
	const follow=f.scouts.at(-1);assert.ok(follow?.squad==="consumer" && follow.id!==consumer.id);
	await follow.report(propose("consumer",["consumer.md",api]));
	const p=worker(f,"producer"),c=worker(f,"consumer");
	put(p.cwd,api,"v2");await f.runtime(p.cwd,{execute}).operation("submit",{run,token:p.token},p.id);
	put(c.cwd,"consumer/ready","uses v1");await f.runtime(c.cwd,{execute}).operation("submit",{run,token:c.token},c.id);
	const before=samples.find(r=>r.nodes.consumer?.state==="checking");assert.ok(before);
	const planned=reviewed(f.root,before,"consumer",c.id), {states,actions}=trace(f.root,planned,c.id);
	assert.deepEqual(states.slice(states.indexOf("join"),states.lastIndexOf("join")+1),["join","assembly","survivors","readmission","join"]);
	assert.ok(!actions.includes("reserve-product"));assert.equal(planned.nodes.consumer.state,"blocked");
	assert.deepEqual(planned.nodes.consumer.excluded,{revision:f.tip,path:api});
	assert.deepEqual(planned.products,before.products);assert.deepEqual(planned.nodes.producer,before.nodes.producer);
	assert.deepEqual(planned.goal,before.goal);assert.equal(planned.join,undefined);
	const db=openDatabase(f.root);t.after(()=>db.close());
	const live=db.read(run);assert.deepEqual(live?.nodes.consumer,planned.nodes.consumer);
	assert.equal(f.owner.inspect({run},"owner").qualified,null);
});
