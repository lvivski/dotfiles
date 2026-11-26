import assert from "node:assert/strict";
import test from "node:test";
import { accepts, journal, producersDeclared, survey } from "./dispatch.mjs";

/** @typedef {import("./model.js").Review} Review */
/** @typedef {import("./model.js").NativeCall} NativeCall */
const proof={notification:"notice",read:"history",completion:"exit"};
/** @type {NonNullable<Review["observation"]>} */
const observation={outcome:"needs-evidence",reason:"read price",evidence:["charter"],grains:[]};
const packet={review:"r",base:"base",files:{charter:"sha"},outputs:{},partial:true};
const deferred={pins:{price:"version"},consumers:["cart"]};
/** @param {Review["state"]} state @returns {Review} */
const scout=state=>({id:"r",issuer:"owner",tool:"workflow",kind:"scout",squad:"price",base:"base",version:"one",args:{},state,
	callId:"old",error:"old diagnostic",permissionHold:"old hold",workflowId:"wf",note:{receipt:"goal",question:"Price?"}});

test("native journal commands apply only their declared result fields; wrong and repeated commands are atomic",()=>{
	const common={unconfirmed:"uncertain",deny:"refused",confirm:"done",prepare:"ordinary",retire:"retired"};
	/** @type {Record<NativeCall["state"],Record<string,string>>} */
	const allowed={ready:{issue:"issued",withdraw:"withdrawn"},ordinary:{issue:"issued"},issued:common,uncertain:common,
		done:{},refused:{},retired:{},withdrawn:{}};
	const events=/** @type {const} */ ([{type:"issue",callId:"new"},{type:"withdraw"},{type:"unconfirmed",error:"unknown"},{type:"deny",error:"denied"},
		{type:"confirm",nativeId:"bound",boundAt:10},{type:"prepare",error:"ordinary tool required"},{type:"retire",retirement:proof}]);
	for (const state of /** @type {NativeCall["state"][]} */ (Object.keys(allowed))) for (const event of events) {
		/** @type {NativeCall} */ const job={id:"dispatch",issuer:"worker",tool:"create_session",kind:"writer",args:{prompt:"original"},state,callId:"old",error:"old diagnostic"};
		const before=structuredClone(job), target=allowed[state][event.type];
		assert.equal(accepts(job,"issue"),!!allowed[state].issue);assert.equal(accepts(job,"unconfirmed"),!!allowed[state].unconfirmed);
		assert.deepEqual(job,before);
		if (!target) {assert.throws(()=>journal(job,event),/Unhandled transition/);assert.deepEqual(job,before);continue;}
		const result=journal(job,event);
		before.state=/** @type {NativeCall["state"]} */ (target);
		switch (event.type) {
		case "issue": before.callId="new";delete before.error;break;
		case "retire": before.retirement=proof;delete before.error;break;
		case "confirm": before.nativeId="bound";before.boundAt=10;delete before.error;break;
		case "deny": case "unconfirmed": case "prepare": before.error=event.error;break;
		}
		const {id,issuer,tool,kind,args,state:value,...context}=before;
		assert.deepEqual(result.snapshot,{value,context});assert.deepEqual(result.effects,[]);assert.deepEqual(job,before);
	}
});

test("review commands retain the pinned evidence while recording a ticket, workflow, report or disposition",()=>{
	const reading={unconfirmed:"uncertain",block:"blocked",requeue:"ready",bind:"issued",suspend:"suspended",report:"reported"};
	const disposition={admit:"observed",defer:"deferred",block:"blocked"};
	/** @type {Record<Review["state"],Record<string,string>>} */
	const allowed={ready:{issue:"issued",block:"blocked"},issued:reading,uncertain:reading,suspended:reading,
		reported:disposition,blocked:disposition,observed:{admit:"observed",defer:"deferred"},deferred:{}};
	const events=/** @type {const} */ ([{type:"issue",callId:"ticket"},{type:"unconfirmed",error:"unknown"},{type:"block",error:"blocked"},
		{type:"requeue",error:"waiting",permissionHold:"managed"},{type:"bind",workflowId:"original workflow"},
		{type:"suspend",disconnected:true,error:"provider disconnected"},{type:"report",observation,packet},
		{type:"admit",observation},{type:"defer",observation,deferred}]);
	for (const state of /** @type {Review["state"][]} */ (Object.keys(allowed))) for (const event of events) {
		const job=scout(state), before=structuredClone(job), target=allowed[state][event.type];
		assert.equal(accepts(job,"issue"),!!allowed[state].issue);assert.equal(accepts(job,"unconfirmed"),!!allowed[state].unconfirmed);
		assert.deepEqual(job,before);
		if (!target) {assert.throws(()=>survey(job,event),/Unhandled transition/);assert.deepEqual(job,before);continue;}
		const result=survey(job,event);
		before.state=/** @type {Review["state"]} */ (target);
		switch (event.type) {
		case "issue": before.callId="ticket";delete before.error;break;
		case "unconfirmed": before.error="unknown";break;
		case "block": before.error="blocked";delete before.permissionHold;break;
		case "requeue": delete before.callId;before.error="waiting";before.permissionHold="managed";break;
		case "bind": before.workflowId="original workflow";delete before.error;break;
		case "suspend": before.providerRecovery="needed";before.error="provider disconnected";break;
		case "report": before.observation=observation;before.packet=packet;delete before.error;break;
		case "admit": before.observation=observation;break;
		case "defer": before.observation=observation;before.deferred=deferred;break;
		}
		const {id,issuer,tool,kind,squad,base,version,args,note,state:value,...context}=before;
		assert.deepEqual(result.snapshot,{value,context});assert.deepEqual(result.effects,[]);assert.deepEqual(job,before);
	}
});

test("late producers readmit only a current blocked report, once, without launching a scout",()=>{
	for (const state of /** @type {const} */ (["ready","issued","uncertain","suspended","reported","blocked","observed","deferred"])) for (const current of [false,true]) {
		const job=scout(state);job.packet=packet;job.observation=observation;
		const selected=state==="blocked" && current, before=structuredClone(job);
		if (!selected) Object.freeze(job);
		let calls=0;
		const result=producersDeclared(job,current,()=>{
			calls++;assert.equal(job.state,"reported");assert.equal(job.packet,packet);assert.equal(job.observation,observation);survey(job,"admit");
		});
		assert.equal(result.snapshot.value,selected ? "reported" : state);assert.equal(calls,Number(selected));
		assert.deepEqual(result.effects,selected ? [{type:"readmit-report"}] : []);
		if (selected) {
			before.state="observed";producersDeclared(job,true,()=>assert.fail("duplicate readmission"));
		}
		assert.deepEqual(job,before);
	}
});

test("a later halted observation cannot renew an already claimed provider continuation",()=>{
	for (const original of [undefined,/** @type {const} */ ("needed"),/** @type {const} */ ("claimed")]) for (const disconnected of [false,true]) {
		const job=scout("suspended");if (original) job.providerRecovery=original;
		survey(job,{type:"suspend",disconnected});
		assert.equal(job.providerRecovery,original==="claimed" ? "claimed" : disconnected ? "needed" : undefined);
	}
});
