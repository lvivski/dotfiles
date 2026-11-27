import { callBinding, exactRunner, runnerBinding, runnerIndex } from "./abi.mjs";
import { heldOutcome, sameDocument } from "./revision.mjs";
import { digest, fail } from "./values.mjs";
import { ordinary, originalGrant, originalWriters } from "./ancestry.mjs";
import { approvalEvidence as approvedHistory } from "./approved.mjs";
import { declaration, sameRecipe } from "./consent.mjs";
import { effectAt } from "./revision.mjs";
import { outputEvidence } from "./declarations.mjs";
import { submittedWriter } from "./origin.mjs";
export {readHistorical} from "./archive.mjs";

/** The old submission is evidence for exactly its own stopped slot, never
 * permission for a peer or for an attempt with matching bytes elsewhere.
 * @param {Run} run @param {Check} e @param {string} previous @param {Extract<import("./model.js").AssessmentSource,{kind:"writer"}>} source @param {string} [cwd] */
export function submissionEvidence(run,e,previous,source,cwd){
	const old=effectAt(run,previous),slot=run.history?.[previous],w=effectAt(run,source.id),origin=originalGrant(run,w);
	if(!slot || !(slot.closure==="never-issued" || slot.settlement?.kind==="terminal") || old?.kind!=="component" ||
		old.attempt?.version!==2 || old.attempt.previous || !old.verification || old.verification.use!=="component" || old.runnerStarted || old.runnerClaim || old.receipt ||
		!origin || source.renewed || old.grain!==w?.grain || old.issuer!==origin.worker || origin.at>=run.effects.indexOf(old) ||
		old.issuer!==e.issuer || old.grain!==e.grain || old.commit!==e.commit || old.check!==e.check || old.evaluatorRevision || old.productEvaluatorRevision ||
		digest(old.usedArtifacts??[])!==digest(e.usedArtifacts??[]) || digest(old.comparedArtifacts??[])!==digest(e.comparedArtifacts??[]) ||
		e.callId!==undefined && e.callId===old.callId || run.effects.indexOf(old)>=(run.historicalPrefix?.length??0) ||
		run.effects.some(c=>c!==e && c.tool==="bash" && c.attempt?.version===3 && c.attempt.previous===previous))return;
	const bound=outputEvidence(run,e,source,cwd,priorWriters(run,e));
	if(!bound || bound.recipe && !sameRecipe(old.verification,bound.recipe))return;
	const a=bound.expected,facts=[...a.facts,{kind:/** @type {const} */("closed-slot"),original:old.id,request:slot.request,position:0}];
	const expected={...declaration(run,e,a.source,a.use,facts),previous};
	return {...bound,expected,...(bound.recipe && {recipe:{...bound.recipe,grant:expected.grant}})};
}
/** @param {Run} run @param {Check} e @param {string} [cwd] */
export function approvalEvidence(run,e,cwd){
	const a=e.attempt;
	return a?.version===3 && a.previous && a.source.kind==="writer"?submissionEvidence(run,e,a.previous,a.source,cwd):approvedHistory(run,e,cwd);
}

/** Read just the possible historical launches for this original submit or its
 * versioned consumers. A fresh edition never loads this boundary in the runner.
 * @param {import("./model.js").Run} run @param {import("./model.js").NativeCall} e */
export function priorWriters(run,e){
	if(run.historicalPrefix?.length===0)return;
	const ids=new Set();
	/** @param {import("./model.js").Effect|undefined} c */
	const add=c=>{
		const s=c?.kind==="component" && c.attempt?.version===3 && c.attempt.source;
		if(s && s.kind==="writer")ids.add(s.id);
	};
	if(e.kind==="component"){
		add(e);
		for(const w of run.effects)if(w.kind==="writer" && w.grain===e.grain && w.nativeId===e.issuer)ids.add(w.id);
	}

	const at=e.kind==="product"?run.join:e.kind==="goal"?run.products.at(-1):undefined;
	for(const id of Object.keys(at?.outputs??{}))add(run.effects.find(c=>c.id===run.nodes[id]?.check));
	if(e.attempt?.version===3)for(const f of e.attempt.facts)if(f.kind==="signed" && f.use==="component")add(effectAt(run,f.check));
	if(ids.size)return originalWriters(run,ids);
}

/** A current product may include an old ordinary candidate, but cannot
 * promote a prior attestation to a publication merely because its bytes match.
 * @param {Run} run @param {Check} e */
export function priorPublications(run,e){
	const cut=run.historicalPrefix?.length??0;if(!cut || e.kind!=="product" && e.kind!=="goal")return;
	const ids=new Set(),at=e.kind==="product"?run.join:run.products.at(-1);
	for(const id of Object.keys(at?.outputs??{}))ids.add(run.nodes[id]?.check);
	if(e.attempt?.version===3)for(const f of e.attempt.facts)if(f.kind==="signed" && f.use==="component")ids.add(f.check);
	/** @type {import("./origin.mjs").PriorPublications} */ const known=new Map();
	for(const id of ids){
		const c=effectAt(run,id);
		if(c?.kind!=="component" || !c.grain || !c.commit || !ordinary(run,c))continue;
		const matches=run.effects.slice(0,run.effects.indexOf(c)).filter(w=>w.kind==="writer" && w.grain===c.grain && w.nativeId===c.issuer);
		if(matches.length!==1)continue;
		const [w]=matches,source=submittedWriter(run,c,w.id,undefined,originalWriters(run,[w.id]));
		if(source)known.set(c.id,source);
	}
	return known;
}

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {import("./model.js").HistoricalSlot} Slot */
/** @type {WeakMap<Run,string>} */ const entryRequest=new WeakMap();
/** @param {import("./model.js").Effect} e */
export const historical=e=>e.tool==="bash" && (e.attempt?.version===1 || e.attempt?.version===2);
/** @param {Check} e */
export const attached=e=>historical(e) && !!e.callId?.trim() && !e.runnerStarted && !e.runnerClaim && !e.receipt && e.launcherExit===undefined && e.nativeId===undefined &&
	(e.state==="issued" || e.state==="uncertain");
/** @param {Check} e */
const neverIssued=e=>e.state==="ready" && ["callId","error","runnerStarted","runnerClaim","receipt","launcherExit","nativeId"].every(k=>!Object.hasOwn(e,k));
/** @param {Check} e @returns {Slot["closure"]|undefined} */
function proof(e){
	if(!historical(e) || !e.issuer.trim() || !e.commit || !e.check || !["component","goal","product","control","rerun"].includes(e.kind))return;
	if(attached(e))return "closed-before-runner-claim";
	if(neverIssued(e))return "never-issued";
	// A 98 document can already contain a genuine 95 closure/withdrawal. Do not mint
	// terminal native evidence from the older ledger's state or erase its original flag.
	if(e.attempt?.version===1)return e.attempt.closure;
}
/** A runner can request the fence only for its own exact, already issued command.
 * The store completes the census under its writer lock before the caller can return.
 * @param {Run} run @param {Check} e @param {string} cwd */
export function closeAtEntry(run,e,cwd){
	if(!exactRunner(run,e,cwd) || heldOutcome(e) || proof(e)!=="closed-before-runner-claim" || run.history && run.history[e.id]?.closure!=="closed-before-runner-claim")
		fail("unissued_check","Historical check has no proven unclaimed slot for this exact command");
	if(!run.history){entryRequest.set(run,e.id);run.history={};}
}
/** A real issuer wake may close provably never-issued work, not merely observe it.
 * @param {Run} run @param {string} issuer */
export function requestUnissuedFence(run,issuer){
	if(!run.history && run.effects.some(e=>e.tool==="bash" && e.state==="ready" && !heldOutcome(e) && e.issuer===issuer && proof(e)==="never-issued" && runnerBinding(run,e)))run.history={};
}
/** Only called inside BEGIN IMMEDIATE with the re-read source revision. No publisher,
 * native result, key or replacement reservation is created here.
 * @param {Run} original @param {Run} draft @param {(cwd:string)=>boolean} sameLedger */
export function fenceHistory(original,draft,sameLedger){
	/** @type {NonNullable<Run["history"]>} */ const slots={};
	const unique=runnerIndex(original);
	for(const e of original.effects)if(e.tool==="bash" && !heldOutcome(e)){
		const closure=proof(e),bound=closure && runnerBinding(original,e,unique);
		if(bound && sameLedger(bound.cwd))slots[e.id]={closure,request:callBinding(e)};
	}
	const entry=entryRequest.get(draft);
	if(entry && slots[entry]?.closure!=="closed-before-runner-claim")
		fail("unissued_check","Could not prove absence of the original claim and outcome; no fence committed");
	draft.history=slots;
	draft.historicalPrefix={length:original.effects.length,last:original.effects.at(-1)?.id??null};
}
/** @param {unknown} object @param {string[]} keys */
const only=(object,keys)=>!!object && typeof object==="object" && !Array.isArray(object) && Object.keys(object).every(k=>keys.includes(k));
/** @param {Run} run */
export function validHistory(run){
	const slots=run.history;
	if(!slots || typeof slots!=="object" || Array.isArray(slots))return false;
	const entries=Object.entries(slots);
	if(!entries.length)return true;
	const unique=runnerIndex(run),effects=new Map(run.effects.slice(0,run.historicalPrefix?.length??0).map(e=>[e.id,e]));
	return entries.every(([id,s])=>{
		const e=effects.get(id);
		if(!e || e.tool!=="bash" || !only(s,["closure","request","settlement"]) || !s.closure || s.closure!==proof(e) ||
			s.request!==callBinding(e) || !runnerBinding(run,e,unique))return false;
		const p=s.settlement;
		return p===undefined || s.closure==="closed-before-runner-claim" && (p?.kind==="declined" && only(p,["kind"]) ||
			p?.kind==="terminal" && only(p,["kind","request","turn","start","end","exit"]) && p.request===s.request && [p.turn,p.start,p.end].every(v=>typeof v==="string" && v.length>0) &&
			p.start!==p.end && Number.isSafeInteger(p.exit) && p.exit>=0 && p.exit<=255);
	});
}
/** Only an original authenticated observation may add a settlement. A stale plan
 * cannot write a different observation or silently drop an already established closure.
 * @type {WeakSet<object>} */
const witnessed=new WeakSet();
/** @param {Run} run @param {Check} e @param {Slot["settlement"]} observation */
export function settleClosed(run,e,observation){
	const slot=run.history?.[e.id];
	if(!slot || slot.closure!=="closed-before-runner-claim" || heldOutcome(e))return false;
	if(slot.settlement)return true;
	if(!observation)return false;
	witnessed.add(observation);slot.settlement=observation;return true;
}
/** @param {Run} prior @param {Run} draft */
export function preserveHistory(prior,draft){
	const before=prior.history,after=draft.history;
	if(!before){
		if(after && Object.keys(after).length || draft.historicalPrefix)fail("corrupt_run","Only the original locked fence can identify historical slots");
		return;
	}
	if(!sameDocument(prior.historicalPrefix,draft.historicalPrefix) ||
		prior.effects.slice(0,prior.historicalPrefix?.length).some((e,i)=>e.id!==draft.effects[i]?.id))fail("corrupt_run","The original historical prefix changed");
	if(!after || Object.keys(before).length!==Object.keys(after).length || Object.entries(before).some(([id,slot])=>{
		const next=after[id];
		return !next || slot.request!==next.request || slot.closure!==next.closure || (slot.settlement? !sameDocument(slot.settlement,next.settlement):
			next.settlement && !witnessed.has(next.settlement));
	}))fail("corrupt_run","Cannot replace historical closure or native settlement evidence");
}
