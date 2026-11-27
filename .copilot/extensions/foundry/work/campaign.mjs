import { checkReceipt, failedComponent, productPin } from "./evidence.mjs";
import { carriedInput, publishedComponent } from "./publication.mjs";
import { batchMembers } from "./abi.mjs";
import { outside } from "./product.mjs";
import { contains, digest } from "./values.mjs";
import { correctionRefs, matchesDraft } from "./drafts.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {import("./model.js").Adoption} Offer */
/** @param {import("./model.js").Inspection["scope"]} scope @param {string} path */
export function within(scope,path){
	const match=(/** @type {{directories:string[];files:string[]}} */ s)=>s.files.includes(path)||s.directories.some(d=>contains(d,path));
	return match(scope) && !(scope.exclude && match(scope.exclude));
}
/** Each touched path has at most one included owner after exclusions. Rebind every
 * consumer of a replaced pin, including a consumer with unchanged output bytes.
 * @param {import("./model.js").HarnessRollout["included"]} included @param {import("./model.js").HarnessRollout["files"]} files @param {string[]} [previous] */
export function selection(included,files,previous=[]){
	const owners=new Set(previous),paths=new Map();
	for(const {file} of files){
		const ids=Object.keys(included).filter(id=>within(included[id].scope,file));
		if(ids.length>1)return;
		paths.set(file,ids[0]??null);
		if(ids.length)owners.add(ids[0]);
	}
	for(const owner of owners)for(const [id,n] of Object.entries(included))if(Object.hasOwn(n.inputs,owner))owners.add(id);
	return {owners,paths};
}
/** A pre-journal component is a historical reference, never a signed pass. The
 * adopted join tested this named grain on its source assembly, and the original
 * passing checkpoint included the identical output pin. The planner verifies both
 * signatures and compares the effective owned Git paths on all three commits.
 * @param {Run} run @param {import("./model.js").Product} join @param {string} checkpoint
 * @param {string} id @param {import("./model.js").Effect|undefined} old @param {import("./model.js").Inspection["scope"]} scope */
export function corroborated(run,join,checkpoint,id,old,scope){
	const product=run.products.find(p=>p.check===checkpoint),passed=run.effects.find(e=>e.id===checkpoint),failed=run.effects.find(e=>e.id===join.check);
	const entry=checkReceipt(failed)?.components?.[id],output=join.outputs[id];
	return !!output && !!product && !!old && !!passed && carriedInput(run,product,old,id,output) &&
		failed?.kind==="product" && failed.issuer===run.owner && !!failedComponent(failed) && failed.commit===join.commit &&
		failed.check===run.policy.productCheck && failed.evaluatorRevision===join.target && entry?.check===old.check && entry?.exit===0 &&
		run.effects.indexOf(passed)<run.effects.indexOf(failed) &&
		[product,join].every(p=>p.ownership ? digest(p.ownership[id]??null)===digest(scope) : !scope.exclude);
}
/** @param {Run} run @param {Check} c */
export const rolloutOffer=(run,c)=>c.rollout ? run.adoptions?.find(a=>a.id===c.rollout && a.rollout) : undefined;
/** The fresh attempt occupies the withheld grain's original place in serial order.
 * The terminal observation remains in the ledger and the proof, never in the pass set.
 * @param {Run} run @param {Offer} a */
export function rolloutChecks(run,a){
	const calls=batchMembers(run.effects.filter(/** @returns {e is Check} */ e=>e.kind==="component" && e.rollout===a.id));
	const retry=a.foreground && calls.find(c=>c.id===a.foreground?.retry);
	const patched=calls.filter(c=>c.testPin);
	const batch=calls.filter(c=>c!==retry && !c.testPin);
	return batch.map(c=>patched.find(p=>p.testPin===c.id)??(c.id===a.foreground?.check && retry || c));
}
/** @param {Run} run @param {Offer} a */
export const successor=(run,a)=>run.adoptions?.find(s=>s.rollout?.followup?.proposal===a.id && s.decision?.status==="answered");
/** @param {Run} run @param {Offer} a */
export const pendingSuccessor=(run,a)=>run.adoptions?.some(s=>s.id===run.targetProposal && s.rollout?.followup?.proposal===a.id && !s.rollout.followup.recipe &&
	(!s.decision || s.decision.status==="presenting"));

/** Only accepted proposals form the serial history; a refused form cannot become a parent.
 * @param {Run} run @param {string} joined */
export function rolloutChain(run,joined){
	const chain=run.adoptions?.filter(a=>a.failed===joined && a.rollout && a.decision?.status==="answered")??[];
	if(chain.every((a,i)=>a.rollout?.followup?.proposal===chain[i-1]?.id) && new Set(chain.map(a=>a.assembly)).size===chain.length)return chain;
}

/** Unpublished intermediate assemblies can introduce and then revert a helper. Keep its evaluator path,
 * even if every harness file has returned to the adopted target by the time output pins are published.
 * @param {Run} run @param {Pick<Offer,"rollout">} a */
export function rolloutPaths(run,a){
	const r=a.rollout;
	if(r?.followup?.observation===undefined)return r?.files.filter(f=>f.file.startsWith(".foundry/")).map(f=>f.file)??[];
	const paths=new Set();
	for(let row=/** @type {Pick<Offer,"rollout">|undefined} */(a);row?.rollout;){
		for(const f of row.rollout.files)if(f.file.startsWith(".foundry/"))paths.add(f.file);
		const parent=row.rollout.followup?.proposal;
		row=parent?run.adoptions?.find(p=>p.id===parent):undefined;
	}
	return [...paths].sort();
}

/** Verify the serial cut: only signed passes before the signed stop; no later call issued.
 * @param {Run} run @param {Offer} a @param {string} id @param {boolean} withdrawn @param {boolean} [allowPass] */
export function stoppedBatch(run,a,id,withdrawn,allowPass=false){
	const batch=rolloutChecks(run,a),pos=batch.findIndex(c=>c.id===id);
	if(pos>=0 && batch.every((c,i)=>i<=pos ? c.runnerClaim && (i<pos?checkReceipt(c)?.exit===0:[1,2,...allowPass?[0]:[]].includes(checkReceipt(c)?.exit??-1)) :
		c.state===(withdrawn?"withdrawn":"ready") && !c.callId && !c.runnerStarted && !c.receipt && !c.permissionHold))return batch;
}

/** Compose the two independently approved manifests, not just their path names.
 * @param {import("./model.js").HarnessRollout["files"]} first @param {import("./model.js").HarnessRollout["files"]} second */
function combined(first,second){
	const files=new Map(first.map(f=>[f.file,f]));
	const added=new Set();
	for(const f of second){
		const prior=files.get(f.file);
		if(added.has(f.file) || f.before===f.result || prior && (prior.result!==f.before || prior.mode!==f.mode))return;
		added.add(f.file);
		if(prior && prior.before===f.result)files.delete(f.file);
		else files.set(f.file,prior?{...f,before:prior.before}:f);
	}
	return files;
}
/** @param {Run} run @param {Check} c */
export function currentRollout(run,c){
	const a=rolloutOffer(run,c),r=a?.rollout,n=c.grain && run.nodes[c.grain],o=r && c.grain && r.owners[c.grain],j=run.join;
	return !!a && !successor(run,a) && !!r && !!n && !!o && !!j && c.issuer===run.owner && c.kind==="component" && c.commit===a.assembly && c.check===n.grain.check &&
		a.decision?.status==="answered" && a.decision.answer===r.blob && j.commit===r.from && j.check===a.failed && j.target===a.revision &&
		productPin(run)===a.revision && run.goal?.check===a.goal && run.products.at(-1)?.check===a.checkpoint &&
		n.candidate===o.output && n.check===o.component && digest(n)===o.binding && !run.independent && !run.blocker && !run.conflict;
}
/** @param {string} grain @param {import("./model.js").HarnessRollout} r */
const basis=(grain,r)=>({base:r.from,generation:r.from,scope:r.owners[grain].scope,
	task:`Review ${grain} on the exact harness rollout ${r.blob} from ${r.followup?.assembly??r.from}.`+
		(r.followup?` Review the cumulative output against ${r.from}; the earlier rollout was not published.`:"")+
		` Preserve all behavior assertions; check the new dependency pins.`});
/** @param {Run} run @param {Check} c */
export function rolloutInspection(run,c){
	const r=rolloutOffer(run,c)?.rollout;
	if(r && c.grain && currentRollout(run,c))return {node:run.nodes[c.grain],overrides:basis(c.grain,r)};
}

/** Check historical authority against the original stopped join, never an old node's current state.
 * @param {Run} run @param {Offer} a @param {import("./model.js").Product} prior @param {Map<string,import("./model.js").Effect>} effects @param {import("./model.js").ProductPin} p */
export function validRollout(run,a,prior,effects,p){
	const r=a.rollout, failed=effects.get(prior.check), step=p.amendments?.find(s=>s.proposal===a.id),chain=rolloutChain(run,prior.check);
	const f=r?.followup,parent=f && run.adoptions?.find(o=>o.id===f.proposal);
	const untouched=r?.harness===a.revision && !r.files.some(f=>f.file.startsWith(".foundry/")) &&
		(parent?parent.rollout?.harness===a.revision:!!r.draft);
	if(!r || !chain || r.from!==prior.commit || prior.check!==a.failed || prior.target!==a.revision || !a.assembly || a.assembly===r.from ||
		r.harness===a.revision && !untouched || !r.files.length || !Object.keys(r.owners).length || new Set(r.files.map(f=>f.file)).size!==r.files.length ||
		!r.files.some(f=>f.file.startsWith(".foundry/")) && r.followup?.observation===undefined && !untouched || !failed || failed.evaluatorRevision!==a.revision ||
		r.files.some(f=>f.before===f.result || !outside(f.file,[run.policy.source,...(run.policy.sharedBrief?[run.policy.sharedBrief]:[]),
			...run.policy.squads.flatMap(s=>[s.charter,...("boundary" in s?s.boundary:[])]),...(p.resolutions??[]).map(r=>r.file)])) ||
		!correctionRefs(run).some(ref=>ref.draft?.id===r.draft && ref.base===a.revision && ref.blob===r.blob &&
			matchesDraft(ref,r.followup?.check??prior.check,r.followup?.assembly??prior.commit,r.followup?.files??r.files)))return false;
	const calls=batchMembers(run.effects.filter(/** @returns {e is Check} */ e=>e.kind==="component" && e.rollout===a.id));
	const next=successor(run,a);
	if(f){
		const approved=a.decision?.status==="answered",old=parent?.rollout,stop=effects.get(f.check);
		const exit=checkReceipt(stop)?.exit;
		if(!old || parent?.decision?.status!=="answered" || parent.assembly!==f.assembly || parent.failed!==a.failed ||
			parent.revision!==a.revision || a.assembly===parent.assembly || !f.files.length || digest(old.included)!==digest(r.included) ||
			approved && (successor(run,parent)!==a || !stoppedBatch(run,parent,f.check,true,f.observation===0)) ||
			stop?.kind!=="component" || !stop.grain || stop.rollout!==parent.id || !stop.runnerClaim ||
			(f.observation===undefined?![1,2].includes(exit??-1):f.observation!==exit) ||
			f.observation===0 && !correctionRefs(run).some(ref=>ref.assembly===f.assembly && ref.blob===r.blob && ref.draft?.id===r.draft && ref.base===a.revision) ||
			calls.some(c=>run.effects.indexOf(c)<=run.effects.indexOf(stop)))return false;
		const recipe=f.recipe;
		// Historical recipe evidence is pinned data, never permission to parse or execute another recipe.
		if(recipe ? !old.followup || f.observation!==undefined || !old.files.some(p=>p.file===recipe.file && p.result===recipe.blob) || !recipe.command :
			old.followup && f.observation===undefined)return false;
		const all=combined(old.files,f.files);
		if(!all || all.size!==r.files.length || r.files.some(e=>digest(all.get(e.file)??null)!==digest(e)))return false;
	}
	const lane=a.foreground,stamp=lane && digest(lane),batch=rolloutChecks(run,a);
	if(lane){
		const old=calls.find(c=>c.id===lane.check),retry=calls.at(-1);
		if(!old || !old.grain || !retry || old===retry || retry.id!==lane.retry || retry.grain!==old.grain || retry.check!==old.check ||
			old.commit!==a.assembly || old.issuer!==run.owner || old.lane || !lane.grains[old.grain] || checkReceipt(old)?.exit!==2 ||
			calls.length!==batch.length+1 || Object.entries(lane.grains).some(([id,d])=>!r.included[id] || !within(r.included[id].scope,d.file) ||
				!d.line) || run.inspections?.some(i=>i.component===old.id))return false;
		const pos=batch.indexOf(retry);
		if(pos<0 || batch.slice(0,pos).some(c=>!c.runnerClaim || checkReceipt(c)?.exit!==0) ||
			batch.some((c,i)=>c.lane!==(i>=pos && c.grain && lane.grains[c.grain]?stamp:undefined)))return false;
	}else if(calls.some(c=>c.lane))return false;
	const joined=step && effects.get(step.recheck);
	if(step && (joined?.kind!=="product" || joined.lane!==undefined && joined.lane!==stamp))return false;
	const selected=selection(r.included,f?.files??r.files,Object.keys(parent?.rollout?.owners??{}));
	if(!selected || digest([...selected.owners].sort())!==digest(Object.keys(r.owners).sort()) ||
		digest(Object.keys(prior.outputs).sort())!==digest(Object.keys(r.included).sort()) ||
		Object.entries(r.included).some(([id,n])=>n.legacy && !corroborated(run,prior,a.checkpoint,id,effects.get(n.legacy),n.scope) ||
			prior.ownership && digest(prior.ownership[id]??null)!==digest(n.scope) ||
			Object.entries(n.inputs).some(([dep,sha])=>prior.outputs[dep]!==sha)))return false;
	const approved=a.decision?.status==="answered",at=run.effects.indexOf(failed);
	if(approved ? a.decision?.status!=="answered" || a.decision.answer!==r.blob || batch.length!==Object.keys(r.owners).length :
		calls.length || step || lane)return false;
	for(const [id,o] of Object.entries(r.owners)){
		const old=effects.get(o.component);
		const grain=run.nodes[id]?.grain,spec=grain?.task===undefined?grain?.specification:undefined;
		if(old?.kind!=="component" || old.grain!==id || old.commit!==o.output || prior.outputs[id]!==o.output ||
			o.specification!==undefined && o.specification!==spec ||
			(old.runnerClaim ? !!r.included[id].legacy : r.included[id].legacy!==old.id) ||
			(old.runnerClaim ? !publishedComponent(run,old.id,id,o.output) : !corroborated(run,prior,a.checkpoint,id,old,o.scope)) || run.effects.indexOf(old)>=at ||
			digest(r.included[id].scope)!==digest(o.scope) || digest(Object.keys(o.inputs).sort())!==digest(Object.keys(r.included[id].inputs).sort()) ||
			Object.entries(o.inputs).some(([dep,sha])=>!prior.outputs[dep] || sha!==(r.owners[dep]?a.assembly:prior.outputs[dep])))return false;
		if(!approved)continue;
		const fresh=batch.filter(c=>c.grain===id),[c]=fresh;
		if(fresh.length!==1 || c.commit!==a.assembly || c.check!==old.check || c.issuer!==run.owner || run.effects.indexOf(c)<=at)return false;
		const i=run.inspections?.find(i=>i.component===c.id);
		if(i && (i.base!==r.from || i.generation!==r.from || i.issuer!==run.owner ||
			(i.specification!==undefined || o.specification!==undefined) && i.specification!==spec ||
			i.task!==basis(id,r).task || digest(i.scope)!==digest(o.scope)))return false;
		if(step && (!publishedComponent(run,c.id,id,c.commit) ||
			run.effects.findIndex(e=>e.id===step.recheck)<=run.effects.indexOf(c)))return false;
	}
	const pin=run.repins?.find(g=>g.revision===r.harness);
	if(untouched)return !step || !next && step.harness===a.revision && !rolloutPaths(run,a).length;
	return step ? !next && step.harness===r.harness && pin?.from===a.revision &&
		digest(pin.files)===digest(rolloutPaths(run,a)) :
		!pin || !!p.amendments?.some(t=>t.harness===r.harness && t.prior.check===a.failed && (!approved || t.proposal===chain.at(-1)?.id));
}
