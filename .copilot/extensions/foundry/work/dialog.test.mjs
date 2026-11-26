import assert from "node:assert/strict";
import test from "node:test";
import { transition } from "./machine.mjs";
import { decide, dialog, observeReply, presentDialog } from "./dialog.mjs";

/** @typedef {import("./model.js").Review} Review */
/** @typedef {NonNullable<Review["decision"]>} Decision */
/** @param {Decision|undefined} decision @returns {Review} */
const question=decision=>({id:"q",issuer:"owner",tool:"workflow",kind:"scout",squad:"price",base:"base",version:"one",args:{},state:"observed",
	...(decision && {decision}),note:{receipt:"goal",question:"Price?"}});
/** @type {(Decision|undefined)[]} */
const initial=[undefined,{status:"presenting"},{status:"presenting",presentation:"second"},
	{status:"unavailable",reason:"offline"},{status:"unavailable",reason:"offline",presentation:"second"},
	{status:"answered",answer:"old answer"},{status:"dismissed"}];
/** @param {Decision|undefined} prior */
const presentation=prior=>prior?.status==="presenting" ? prior.presentation ?? "q" : prior?.status==="unavailable" ? prior.presentation : undefined;

test("required dialog commands apply complete decision payloads and cannot reopen implicitly",()=>{
	/** @type {Decision[]} */ const decisions=[{status:"presenting",presentation:"new"},{status:"answered",answer:"answer"},
		{status:"dismissed"},{status:"unavailable",reason:"offline"}];
	for (const prior of initial) for (const decision of decisions) for (const recover of [false,true]) {
		const job=question(prior), before=structuredClone(job), from=prior?.status ?? "pending";
		const allowed=recover ? decision.status==="presenting" && (from==="presenting" || from==="unavailable") :
			from==="pending" ? decision.status==="presenting" || decision.status==="unavailable" :
			from==="presenting" && decision.status!=="presenting";
		if (!allowed) {
			assert.throws(()=>decide(job,decision,recover),/Unhandled transition|does not match/);assert.deepEqual(job,before);continue;
		}
		const result=decide(job,decision,recover);
		const saved=decision.status==="unavailable" && from==="presenting" ? {...decision,presentation:presentation(prior)} : decision;
		const {status:value,...data}=saved;
		assert.deepEqual(result.snapshot,{value,context:{question:"q",...data}});
		assert.deepEqual(result.effects,value==="presenting" ? [{type:"present-question"}] : []);assert.deepEqual(job,{...before,decision:saved});
	}
});

test("only the exact presentation can consume an observed answer, dismissal or delivery failure",()=>{
	const replies=/** @type {const} */ ([{status:"answered",answer:"answer"},{status:"dismissed"},
		{status:"unavailable",reason:"offline"},{status:"unavailable",reason:"offline",presentation:"second"}]);
	for (const prior of initial) for (const expected of ["q","second","stale"]) for (const reply of replies) {
		const job=question(prior), before=structuredClone(job);
		const accepted=prior?.status==="presenting" && presentation(prior)===expected &&
			(!("presentation" in reply) || reply.presentation===expected);
		if (!accepted) Object.freeze(job);
		const result=observeReply(job,expected,reply);
		assert.equal(!!result.edge,accepted);assert.deepEqual(result.effects,[]);
		if (accepted) {
			before.decision=reply.status==="unavailable" ? {...reply,presentation:expected} : reply;
			assert.equal(observeReply(job,expected,reply).edge,undefined,"a duplicate reply must not apply twice");
		}
		assert.deepEqual(job,before);
	}
});

test("reopening a lost presentation discards the old presentation's late reply, even with a forged guard",()=>{
	const job=question({status:"unavailable",reason:"unconfirmed",presentation:"first"});
	const before=structuredClone(job);
	assert.throws(()=>decide(job,{status:"presenting",presentation:"next"},true,"wrong"),/Unhandled transition/);assert.deepEqual(job,before);
	const claim=decide(job,{status:"presenting",presentation:"next"},true,"first");
	const stale=transition(dialog,claim.snapshot,{type:"answered",expected:"first",answer:"wrong"},{samePresentation:true});
	assert.equal(stale.snapshot,claim.snapshot);assert.equal(stale.edge,undefined);assert.deepEqual(stale.effects,[]);
	const late={status:/** @type {const} */ ("answered"),answer:"wrong",expected:"next"};
	assert.equal(observeReply(job,"first",late).edge,undefined,"reply data cannot replace its verified presentation identity");
	observeReply(job,"first",{status:"dismissed"});assert.deepEqual(job.decision,{status:"presenting",presentation:"next"});
	observeReply(job,"next",{status:"answered",answer:"current"});assert.deepEqual(job.decision,{status:"answered",answer:"current"});
});

test("the claim queues the one native presentation; restoring a pending reply never opens it",async()=>{
	const job=question(undefined);
	let asks=0;
	const ask=async()=>{asks++;return "yes";};
	const claim=decide(job,{status:"presenting"});
	assert.equal(asks,0);assert.deepEqual(job.decision,{status:"presenting"});
	assert.equal(await presentDialog(claim,ask),"yes");assert.throws(()=>presentDialog(claim,ask),/consumed/);
	const answered=observeReply(structuredClone(job),"q",{status:"answered",answer:"yes"});
	assert.throws(()=>presentDialog(answered,ask),/No dialog presentation/);assert.equal(asks,1);
});
