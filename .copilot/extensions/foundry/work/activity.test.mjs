import assert from "node:assert/strict";
import test from "node:test";
import { run as savedRun } from "../test/timing.mjs";
import { activate, activity, hold, permitted, sendActivity } from "./activity.mjs";
import { transition } from "./machine.mjs";

const ticket={issuer:"owner",effect:"dispatch-1",token:"original"};
const replacement={issuer:"writer",effect:"dispatch-2",token:"replacement"};
const events=/** @type {const} */ ([
	{type:"pause"},{type:"resume"},{type:"goal-met"},{type:"policy-hold",hold:replacement,reason:"permissions unavailable"},
	{type:"policy-ready",issuer:"owner",token:"original"},{type:"policy-ready",issuer:"writer",token:"original"},
	{type:"policy-ready",issuer:"owner",token:"stale"},
]);
/** @type {Record<string,Record<string,string>>} */
const destinations={
	active:{pause:"paused",resume:"active","policy-hold":"held","goal-met":"qualified"},
	held:{pause:"paused",resume:"active","policy-ready":"active"},paused:{pause:"paused",resume:"active"},qualified:{pause:"qualified"},
};

test("activity projects every ledger discriminator, event and hold identity without touching other records",()=>{
	for (const active of [false,true]) for (const goal of [false,true]) for (const stamp of [undefined,0,42]) {
		for (const held of [false,true]) for (const reason of [undefined,"legacy diagnostic"]) for (const event of events) {
			const run=savedRun(), product={target:"target",commit:"product",check:"check",outputs:{}};
			run.active=active;
			run.products.push({...product,qualifiedAt:1},{...product,...(stamp!==undefined && {qualifiedAt:stamp})});
			if (goal) run.goal={target:"target",commit:"product",check:"goal"};
			if (held) run.policyHold={...ticket};
			if (reason!==undefined) run.pauseReason=reason;
			const from=active ? "active" : goal && stamp===42 ? "qualified" : held ? "held" : "paused";
			const target=event.type==="policy-ready" && (event.issuer!=="owner" || event.token!=="original") ? undefined : destinations[from][event.type];
			const before=structuredClone(run), products=run.products, effects=run.effects, nodes=run.nodes;
			let writes=0;
			const ledger=new Proxy(run,{set(...args){writes++;return Reflect.set(...args);},deleteProperty(...args){writes++;return Reflect.deleteProperty(...args);}});
			if (!target && event.type!=="policy-ready") {
				assert.throws(()=>sendActivity(ledger,event),/Unhandled transition/);assert.equal(writes,0);assert.deepEqual(run,before);
				continue;
			}
			const result=sendActivity(ledger,event);
			const context=target ? event.type==="policy-hold" ? {policyHold:replacement,pauseReason:event.reason} : {} :
				{...(held && {policyHold:ticket}),...(reason!==undefined && {pauseReason:reason})};
			assert.deepEqual(result.snapshot,{value:target ?? from,context});assert.deepEqual(result.effects,[]);
			assert.equal(result.edge?.on,target ? event.type : undefined);
			if (target) {
				delete before.policyHold;delete before.pauseReason;Object.assign(before,{active:target==="active"},context);
			} else assert.equal(writes,0);
			assert.deepEqual(run,before);assert.equal(run.products,products);assert.equal(run.effects,effects);assert.equal(run.nodes,nodes);
		}
	}
});

test("the authored guard checks the current issuer and token, even with forged simulator inputs",()=>{
	const before=Object.freeze({value:"held",context:Object.freeze({policyHold:Object.freeze({...ticket}),pauseReason:"policy"})});
	for (const [issuer,token] of [["owner","stale"],["other","original"]]) {
		const result=transition(activity,before,{type:"policy-ready",issuer,token},{sameHold:true});
		assert.equal(result.edge,undefined);assert.equal(result.snapshot,before);assert.deepEqual(result.effects,[]);
	}
	const good=transition(activity,before,{type:"policy-ready",issuer:"owner",token:"original"},{sameHold:false});
	assert.deepEqual(good.snapshot,{value:"active",context:{}});assert.deepEqual(good.effects,[]);
	assert.deepEqual(before.context,{policyHold:ticket,pauseReason:"policy"});
});

test("an invalid hold cannot turn an executable run into an unidentifiable wait",()=>{
	const run=savedRun(), before=structuredClone(run);
	for (const missing of ["issuer","effect","token"]) {
		assert.throws(()=>sendActivity(run,{type:"policy-hold",hold:{...ticket,[missing]:""},reason:"policy"}),/needs its issuer/);
		assert.deepEqual(run,before);
	}
});

test("a delayed or duplicate permission observation cannot undo an operator pause or release a new hold",()=>{
	const run=savedRun();hold(run,ticket,"unresolved");
	activate(run,"pause");permitted(run,"owner","original");assert.equal(run.active,false);assert.equal(run.policyHold,undefined);
	assert.throws(()=>hold(run,replacement,"new"),/Unhandled transition/);
	activate(run,"resume");hold(run,replacement,"second hold");const paused=structuredClone(run);
	permitted(run,"owner","original");assert.deepEqual(run,paused);
	permitted(run,"writer","replacement");assert.equal(run.active,true);assert.ok(!("pauseReason" in run));
	const resumed=structuredClone(run);permitted(run,"writer","replacement");assert.deepEqual(run,resumed);
});
