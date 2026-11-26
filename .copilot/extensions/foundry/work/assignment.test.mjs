import assert from "node:assert/strict";
import test from "node:test";
import { run as savedRun } from "../test/timing.mjs";
import { assign, componentOutcome } from "./assignment.mjs";

/** @typedef {import("./model.js").Node} Node */
const grain={id:"price",directory:"price",specification:"price.md",check:"unit",needs:[],boundary:[]};
const restoration={from:"old",historical:"receipt",checkpoint:"checkpoint",goal:"goal",retainer:"keeper",tree:"tree"};
const states=/** @type {const} */ (["idle","waiting","writing","checking","reviewing","published","qualified","repeated","blocked"]);
/** @param {Node["state"]} state @returns {Node} */
const node=state=>({state,grain,repairs:0,candidate:"candidate",check:"check",reason:"original reason",replaces:"previous",worker:"same writer"});

test("the complete command matrix preserves pins and rejects unsupported assignment transitions atomically",()=>{
	const commands=/** @type {const} */ (["request","staff","submit","stop","integrate","paired-pass","repeat","recheck","deliver"]);
	/** @type {Record<Node["state"],Record<string,Node["state"]>>} */
	const allowed={
		idle:{request:"waiting"},waiting:{staff:"writing",stop:"blocked"},writing:{submit:"checking",stop:"blocked"},
		checking:{stop:"blocked","paired-pass":"published"},reviewing:{},published:{integrate:"qualified",stop:"blocked",staff:"writing",repeat:"repeated","paired-pass":"published"},
		qualified:{integrate:"qualified",request:"waiting"},repeated:{integrate:"qualified",request:"waiting"},
		blocked:{staff:"writing",recheck:"checking","paired-pass":"published",deliver:"qualified",stop:"blocked"},
	};
	for (const state of states) for (const command of commands) {
		const n=node(state), expected=structuredClone(n), to=allowed[state][command];
		if (!to) {
			assert.throws(()=>assign(n,command),/Unhandled transition/);assert.deepEqual(n,expected);
			continue;
		}
		const result=assign(n,command);
		expected.state=to;
		if (command==="recheck" || command==="paired-pass") delete expected.reason;
		assert.deepEqual(result.snapshot,{value:to,context:{replaces:"previous",...(expected.reason && {reason:expected.reason})}});
		assert.deepEqual(result.effects,[]);assert.deepEqual(n,expected);
	}
	const n=node("writing");assign(n,{type:"stop",reason:"missing input"});assert.equal(n.reason,"missing input");
});

test("component and repair truth tables resolve context and invalidate only the old pinned consumers",()=>{
	for (const state of states) for (const component of [false,true]) for (let mask=0;mask<(component ? 32 : 4);mask++) {
		const attested=!!(mask&1), exhausted=!!(mask&2), passed=!!(mask&4), incomplete=!!(mask&8), unfunded=!!(mask&16);
		const run=savedRun(), n=run.nodes.price=node(state);
		run.policy.repairs=exhausted ? 0 : 1;if (attested) n.restoration=restoration;
		const before=structuredClone(run), initial=structuredClone(n);
		const facts=component ? {passed,incomplete,unfunded} : undefined;
		let calls=0;
		/** @type {Parameters<typeof componentOutcome>[4]} */
		const invalidate=(live,id,version)=>{
			calls++;assert.equal(live,run);assert.equal(id,"price");assert.equal(version,"candidate");assert.deepEqual(n,initial);
		};
		if (component ? state!=="checking" : !["published","qualified","repeated","blocked"].includes(state)) {
			assert.throws(()=>componentOutcome(run,"price","bad",facts,invalidate),/Unhandled transition/);
			assert.deepEqual(run,before);assert.equal(calls,0);continue;
		}
		const invalidateExpected=!(passed || incomplete || unfunded);
		const value=passed ? "published" : incomplete || unfunded || attested || exhausted ? "blocked" : "waiting";
		const reason=passed ? undefined : incomplete ? "Evaluation did not complete: bad" : unfunded ? "No assignment remains to repair price: bad" :
			attested ? "The approved unchanged directory did not pass; this ownership attestation cannot change the bytes or replay the check: bad" :
			exhausted ? "price: repair limit exhausted: bad" : "bad";
		const replaces=value==="waiting" && state==="qualified" ? "candidate" : "previous";
		const result=componentOutcome(run,"price","bad",facts,invalidate);
		assert.equal(calls,Number(invalidateExpected));assert.deepEqual(result.effects,invalidateExpected ? [{type:"invalidate-consumers"}] : []);
		assert.deepEqual(result.snapshot,{value,context:{replaces,...(reason!==undefined && {reason})}});
		before.nodes.price.state=value;before.nodes.price.replaces=replaces;
		if (reason===undefined) delete before.nodes.price.reason; else before.nodes.price.reason=reason;
		assert.deepEqual(run,before);
	}
});

test("attestations read the original check, and rejecting a protected consumer leaves the producer untouched",()=>{
	for (const final of [false,true]) {
		const run=savedRun(), n=run.nodes.price=node("blocked");n.restoration=restoration;
		run.effects.push({id:"check",issuer:"writer",kind:"component",tool:"bash",args:{},state:"done",
			observer:{pair:"pair",file:"unit",before:"before",...(final && {previous:{check:"prior",candidate:"candidate",phases:[]}})}},
			{id:"unrelated",issuer:"writer",kind:"component",tool:"bash",args:{},state:"done"});
		const before=structuredClone(run);
		assert.throws(()=>componentOutcome(run,"price","failure",undefined,()=>{throw Error("protected consumer");}),/protected consumer/);
		assert.deepEqual(run,before);
		componentOutcome(run,"price","failure",undefined,()=>{});
		assert.match(n.reason ?? "",final ? /^Final diagnostic check stopped on price\..*No observer replay: failure$/ : /^The approved observer change failed\..*do not replay it: failure$/);
		assert.deepEqual(run.effects,before.effects);
	}
});
