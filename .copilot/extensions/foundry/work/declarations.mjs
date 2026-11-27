import { git } from "../../../skills/foundry/scripts/git-files.mjs";
import { checkedOverlay, resolveInputs } from "../../../skills/foundry/scripts/materialize.mjs";
import { feedbackSource, priorGoal, schedulingInput } from "./feedback.mjs";
import { verifyFixedGrant } from "./fixed.mjs";
import { citedText, isRejoined, verifyContracts } from "./objects.mjs";
import { evaluatorOverlay, evaluatorFacts, selectedGoal } from "./overlay.mjs";
import { adopted, buildAt, declaration, preparedMember } from "./consent.mjs";
import { currentOrder, seriesEvidence } from "./series.mjs";
import { confirmedWriter, occupies, submittedWriter, writerEvidence, writerPublication } from "./origin.mjs";
import { signedFact } from "./receipt.mjs";
import { effectAt, productAt } from "./revision.mjs";
import { digest, fail, ownership } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {import("./model.js").CurrentAttempt} Attempt */
/** @typedef {import("./model.js").VerificationScope} Scope */
/** @typedef {import("./model.js").CheckDescription} Recipe */
/** @typedef {import("./origin.mjs").PriorWriters} PriorWriters */
/** @typedef {import("./origin.mjs").PriorPublications} PriorPublications */
/** @typedef {{expected:Attempt,slot?:string,recipe?:Recipe,delta?:string}} Origin */

/** A target is not the revision containing the activation brief. Both are pinned.
 * @param {Run} run @param {Check} e @param {string} target @param {string} [passed] */
export function declareAssessment(run,e,target,passed){
	const policy=run.policy.base,commit=e.commit,use=passed?"product":"goal";
	if(e.kind!==use || !commit || commit!==target || !e.check || e.check!==(passed?run.policy.productCheck:run.policy.goalCheck) ||
		e.evaluatorRevision || e.productEvaluatorRevision || e.issuer!==run.owner)
		fail("current_authority_required","The frozen activation does not grant this assessment");
	/** @type {Attempt["source"]} */ const source=passed?{kind:"receipt",use:"goal",check:passed,policy,commit,target}:{kind:"activation",policy,commit,target};
	/** @type {Attempt["facts"]} */ const facts=[{kind:"activation",policy}];
	if(passed)facts.push({kind:"signed",use:"goal",check:passed,commit,exit:0});
	if(target!==policy)facts.push({kind:"target",ref:run.policy.target,commit:target});
	facts.push({kind:"assessment",use,target,commit,check:e.check});
	return declaration(run,e,source,use,facts);
}

/** Generate physical inputs outside the claim transaction. Verification computes
 * the private blob's identity without writing anything to the source repository.
 * @param {string} cwd @param {Run} run @param {Check} e @param {Attempt} a @param {Scope} scope @param {boolean} previous */
function physical(cwd,run,e,a,scope,previous){
	const {source:s,use}=a,commit=s.commit,check=e.check??fail("invalid_inputs","Missing reserved checker");
	const before=previous?priorGoal(run,e):undefined,delta=before?schedulingInput(cwd,commit,before):undefined;
	if(before && !delta)fail("unavailable_inputs","The original scheduling feedback is unavailable");
	const overlay=e.evaluatorRevision && (use==="goal" || use==="product")?checkedOverlay(evaluatorOverlay(run,use,e.evaluatorRevision)):undefined;
	const inputs=resolveInputs(cwd,{commit,check,scope,delta,overlay});
	const privateInput=delta && git(cwd,["hash-object","--stdin"],delta.bytes).toString().trim();
	const evaluation=scope.kind==="goal"?{kind:scope.kind,squads:run.policy.squads.map(s=>s.id)}:
		scope.kind==="product"?{kind:scope.kind,outputs:scope.outputs.map(o=>o.id)}:{kind:scope.kind};
	/** @type {Recipe} */ const recipe={version:1,use,grant:a.grant,target:s.target,contract:s.kind==="approval"?s.target:s.policy,evaluation,
		steps:[{member:null,inputs,build:null}],...(privateInput && {privateInput})};
	return {recipe,...(delta && {delta:delta.bytes})};
}

/** @param {Run} run @param {Check} e @param {Attempt} a @param {string} [cwd] @returns {Origin|undefined} */
function assessmentEvidence(run,e,a,cwd){
	const s=a.source,at=run.effects.indexOf(e),use=a.use;
	if(!(s.kind==="activation" && use==="goal" || s.kind==="receipt" && s.use==="goal" && use==="product") ||
		s.policy!==run.policy.base || s.commit!==s.target || s.commit!==e.commit || e.kind!==use || e.issuer!==run.owner ||
		e.check!==(use==="goal"?run.policy.goalCheck:run.policy.productCheck) || e.evaluatorRevision || e.productEvaluatorRevision)return;
	const original=a.previous?effectAt(run,a.previous):e;
	if(a.previous){
		const slot=run.history?.[a.previous];
		if(use!=="goal" || !slot || !(slot.closure==="never-issued" || slot.settlement?.kind==="terminal") ||
			original?.kind!=="goal" || original!==run.effects[0] || original.issuer!==e.issuer || original.commit!==e.commit ||
			original.check!==e.check || original.runnerStarted || original.runnerClaim || original.receipt ||
			(original.attempt?.version!==1 && original.attempt?.version!==2) || run.effects.indexOf(original)>=at ||
			run.effects.some(x=>x!==e && x.tool==="bash" && x.attempt?.version===3 && x.attempt.previous===a.previous))return;
	}else if(use==="goal" && run.effects[0]!==e)return;
	const passed=s.kind==="receipt"?s.check:undefined,g=effectAt(run,passed);
	if(passed && (g?.kind!=="goal" || g.check!==run.policy.goalCheck || signedFact(run,at,g,"goal",s.commit)?.exit!==0))return;
	const expected=declareAssessment(run,e,s.target,passed);
	if(a.previous)expected.previous=a.previous;
	const active=use==="goal"?run.goal:run.join;
	const current=active?.check===e.id && active.commit===s.commit && active.target===s.target && !run.independent &&
		!run.deliveries?.some(d=>!d.assessment && !d.error) && !run.policy.contractTarget && (passed?g?.evaluatorRevision===run.repins?.at(-1)?.revision:selectedGoal(run,e)) && !run.productRepins?.length && !run.testRepairs?.length &&
		(!passed || run.goal?.check===passed && run.join && !Object.keys(run.join.outputs).length);
	if(e.verification?.evaluation.kind==="goal" && digest(e.verification.evaluation.squads)!==digest(run.policy.squads.map(s=>s.id)))return;
	return {expected,slot:current?e.id:undefined,...(cwd && physical(cwd,run,e,expected,use==="goal"?{kind:"goal"}:{kind:"product",outputs:[]},false))};
}

/** Historical translation is an optional *data* input. Pure current operations
 * never import the historical grant owner, scheduler or candidate checker.
 * @param {Run} run @param {Check} e @param {Origin} [translated] @param {string} [cwd] @param {PriorWriters} [prior] @param {PriorPublications} [published] @returns {Origin|undefined} */
export function declaredOrigin(run,e,translated,cwd,prior,published){
	const a=e.attempt;if(a?.version!==3 || !a.source)return;
	if(translated)return translated;
	const s=a.source;
	if(s.kind==="approval"){
		const a=run.adoptions?.find(a=>a.id===s.id);
		if(a?.accepted && a.rollout)return seriesEvidence(run,e,a,currentOrder(run,a),cwd);
	}
	if(a.previous && s.kind==="writer")return;
	if(s.kind==="activation" || s.kind==="receipt" && s.use==="goal" && a.use==="product")return assessmentEvidence(run,e,a,cwd);
	return outputEvidence(run,e,s,cwd,prior,published);
}

/** @param {Run} run @param {Check} e @param {string} component @param {string} id @param {string} revision @param {Attempt["facts"]} facts @param {PriorWriters} [prior] @param {PriorPublications} [published] */
function member(run,e,component,id,revision,facts,prior,published){
	const p=writerPublication(run,component,id,revision,prior,published),i=p?.inspection;
	const signed=signedFact(run,run.effects.indexOf(e),p?.component,"component",revision);
	if(!p || !signed || signed.exit!==0)return;
	facts.push(signed);
	if(i?.workflow && i.dispatch)facts.push({kind:"review",component,inspection:i.id,workflow:i.workflow,dispatch:i.dispatch});
	return p.writer;
}

/** @param {string} cwd @param {Run} run @param {NonNullable<ReturnType<typeof submittedWriter>>} w */
function verifyTerms(cwd,run,w){
	verifyFixedGrant(cwd,run,w,w.review);
	const c=w.review?.correction;
	if(c && !citedText(cwd,w.terms.base,c.file,c.excerpt))fail("invalid_inputs","Missing the original frozen citation for the task correction");
}

/** The same source supplies the reservation and the proof verified at claim.
 * Do not use today's slot to decide whether a historical grant existed.
 * @param {Run} run @param {Check} e @param {Attempt["source"]} s @param {string} [cwd] @param {PriorWriters} [prior] @param {PriorPublications} [published] @returns {Origin|undefined} */
export function outputEvidence(run,e,s,cwd,prior,published){
	const commit=e.commit,policy=run.policy.base,use=e.kind;
	if(!commit || commit!==s.commit || !e.check || s.policy!==policy ||
		!run.inspections && !(run.inspections===undefined && run.historicalPrefix?.length))return;
	const consent=s.kind==="approval"?adopted(run,e,s.id,cwd):undefined;
	const checker=run.productRepins?.at(-1);
	/** @type {Attempt["facts"]} */ const facts=[];
	/** @type {Scope} */ let scope;
	let current=false;
	if(s.kind==="receipt" && s.use==="goal" && use==="goal"){
		const old=effectAt(run,s.check),pin=run.repins?.find(p=>p.revision===e.evaluatorRevision && p.assessment===s.check);
		const signed=signedFact(run,run.effects.indexOf(e),old,"goal",commit);
		if(!pin || old?.kind!=="goal" || !signed || e.check!==run.policy.goalCheck || old.check!==e.check || e.issuer!==run.owner && e.issuer!==old.issuer ||
			run.policy.contractTarget || old.productEvaluatorRevision!==e.productEvaluatorRevision || run.testRepairs?.length ||
			run.effects.some(c=>c!==e && c.kind==="goal" && c.evaluatorRevision===pin.revision && c.commit===commit && c.attempt?.version===3 &&
				c.attempt.source.kind==="receipt" && c.attempt.source.check===old.id))return;
		facts.push(signed,{kind:"target",ref:run.policy.target,commit:s.target});
		current=selectedGoal(run,e) && e.productEvaluatorRevision===checker?.revision && run.goal?.check===e.id && run.goal.commit===commit && run.goal.target===s.target;
		scope={kind:"goal"};
	}else if(s.kind==="writer" && use==="component"){
		const w=submittedWriter(run,e,s.id,s.renewed,prior),n=e.grain && run.nodes[e.grain];
		if(!w || !n || s.target!==policy || e.evaluatorRevision)return;
		if(cwd)verifyTerms(cwd,run,w);
		facts.push(...writerEvidence(run,w));
		const grant=w.renewal;
		if(grant?.kind==="component"){
			const signed=grant.commit && signedFact(run,run.effects.indexOf(e),grant,"component",grant.commit);
			if(!signed)return;
			facts.push(signed);
		}
		for(const [id,p] of Object.entries(w.terms.inputs)){
			if(!member(run,e,p.component,id,p.revision,facts,prior,published))return;
		}
		scope={kind:"component",grain:w.grain.id,...ownership(w.grain.directory)};
		current=n.check===e.id && n.candidate===commit && n.state==="checking" && occupies(w,n) &&
			Object.entries(w.terms.inputs).every(([id,p])=>run.nodes[id]?.candidate===p.revision && run.nodes[id]?.check===p.component);
	}else if((use==="goal" || use==="product") && (consent || s.kind==="assembly" && use==="product" || s.kind==="receipt" && s.use==="product" && use==="goal")){
		const id=consent?.p.recheck??(s.kind==="receipt"?s.check:e.id);
		const p=consent?.joined??(run.join?.check===id?run.join:productAt(run,id)),product=effectAt(run,id);
		if(!p || p.commit!==commit || p.target!==s.target || e.check!==(use==="goal"?run.policy.goalCheck:run.policy.productCheck) ||
			e.issuer!==run.owner && !run.effects.slice(0,run.effects.indexOf(e)).some(w=>w.kind==="writer" && w.nativeId===e.issuer && confirmedWriter(run,w)))return;
		if(use==="goal" && (product?.kind!=="product" || e.productEvaluatorRevision!==product.evaluatorRevision || (product.attempt?.version===3?(consent?
			product.attempt.source.kind!=="approval" || product.attempt.source.id!==consent.a.id:product.attempt.source.kind!=="assembly"):
			!published?.size || consent || !run.products.includes(p) || product.evaluatorRevision || product.productEvaluatorRevision)))return;
		if(product?.kind!=="product")return;
		const outputs=Object.entries(p.outputs),end=run.effects.indexOf(product);
		if(!outputs.length){
			const last=run.products.findLast(p=>{const c=effectAt(run,p.check);return c && run.effects.indexOf(c)<end;});
			const previous=last && effectAt(run,last.check),old=run.effects.slice(0,end).findLast(c=>c.kind==="goal");
			if(consent || !last || last.target===s.target || previous?.kind!=="product" || previous.attempt?.version!==3 ||
				previous.attempt.source.kind!=="assembly" || old?.kind!=="goal" || old.attempt?.version!==3 ||
				old.attempt.source.kind!=="receipt" || old.attempt.source.check!==last.check || old.attempt.source.use!=="product")return;
			const carried=signedFact(run,end,previous,"product",last.commit),unmet=signedFact(run,end,old,"goal",last.commit);
			if(carried?.exit!==0 || unmet?.exit!==1 && unmet?.exit!==2)return;
			if(cwd){
				verifyContracts(cwd,run.policy,s.target);
				if(!isRejoined(cwd,last,s.target,commit))fail("invalid_inputs","The reserved tree is not the unchanged checkpoint delta on the live target");
			}
			facts.push(carried,unmet);
		}
		if(consent)facts.push(...consent.facts);
		current=!run.blocker && !run.conflict && (use==="product"?run.join?.check===e.id:run.goal?.check===e.id && run.products.at(-1)?.check===id) &&
			!run.independent && (consent?consent.current:!run.policy.contractTarget && product?.evaluatorRevision===checker?.revision && (use!=="goal" || selectedGoal(run,e))) && !run.testRepairs?.length &&
			!run.deliveries?.some(d=>!d.assessment && !d.error);
		/** @type {Extract<Scope,{kind:"product"}>["outputs"]} */ const scopes=[];
		for(const [grain,revision] of outputs){
			// Equal output bytes need not be the same submission. Once claimed,
			// follow the product's signed input references, not a current owner.
			const refs=product.runnerStarted && product.attempt?.version===3 ? product.attempt.facts.flatMap(f=>{
				if(f.kind!=="signed" || f.use!=="component")return [];
				const c=effectAt(run,f.check);return c?.kind==="component" && c.grain===grain && c.commit===revision?[c.id]:[];
			}):[run.nodes[grain]?.check];
			const check=refs[0],c=effectAt(run,check);
			if(refs.length!==1 || !check || !c || run.effects.indexOf(c)>=end)return;
			const w=member(run,e,check,grain,revision,facts,prior,published);
			if(!w)return;
			if(cwd)verifyTerms(cwd,run,w);
			const area=ownership(w.grain.directory);
			if(p.ownership && digest(p.ownership[grain])!==digest(area))return;
			scopes.push({id:grain,...area});
			const n=run.nodes[grain];current&&=n?.check===check && n.candidate===revision;
		}
		facts.push({kind:"target",ref:run.policy.target,commit:s.target});
		if(use==="goal"){
			const signed=signedFact(run,run.effects.indexOf(e),product,"product",commit);
			if(!signed || signed.exit!==0)return;
			facts.push(signed);
			const prior=feedbackSource(run,e);
			if(prior){
				const previous=prior.commit && signedFact(run,run.effects.indexOf(e),prior,"goal",prior.commit);
				if(!previous)return;
				facts.push(previous);
			}
		}
		scope=use==="goal"?{kind:"goal"}:{kind:"product",outputs:scopes};
	}else return;
	if(!consent && e.evaluatorRevision && (use==="goal" || use==="product"))facts.push(...evaluatorFacts(run,e,use,e.evaluatorRevision,cwd));
	const expected=declaration(run,e,s,use,facts),slot=current?e.id:undefined;
	if(!cwd)return {expected,slot};
	const result=physical(cwd,run,e,expected,scope,use==="goal");
	if(consent && scope.kind==="product"){
		const build=buildAt(cwd,commit);
		result.recipe.steps.unshift(...scope.outputs.map(({id,...area})=>preparedMember(cwd,commit,run.nodes[id].grain.check,id,area,build,id)));
		result.recipe.joined=true;
		if(consent.p.resolutions)result.recipe.resolutions=digest(consent.p.resolutions);
	}
	return {expected,slot,...result};
}

/** @param {Run} run @param {Check} e @param {{kind:"writer";id:string;renewed?:string}|{kind:"approval";id:string}|{kind:"assembly"}|{kind:"receipt";use:"product"|"goal";check:string}} source @param {string} target @param {PriorWriters} [prior] @param {PriorPublications} [published] */
export function declareOutput(run,e,source,target,prior,published){
	const commit=e.commit??fail("current_authority_required","Missing candidate for the authorized output");
	const origin=outputEvidence(run,e,{...source,commit,policy:run.policy.base,target},undefined,prior,published);
	if(!origin || origin.slot!==e.id)fail("current_authority_required","No current, reviewed grant for this output");
	e.attempt=origin.expected;
}
