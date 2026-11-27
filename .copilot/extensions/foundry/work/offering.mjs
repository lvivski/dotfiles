import { rolloutChecks } from "./campaign.mjs";
import { correctionRefs, matchesDraft } from "./drafts.mjs";
import { invalidatePresentation } from "./dialog.mjs";
import { checkReceipt, currentEvaluation, failedComponent, productPin } from "./evidence.mjs";
import { currentOffer, matchesPresentation, offerId, presentationBasis, rememberOffer } from "./offers.mjs";
import { patchPlan } from "./patch.mjs";
import { commitAt, git } from "./product.mjs";
import { prepareRepin } from "./repin.mjs";
import { exactPatch, rolloutPlan } from "./rollout.mjs";
import { covers, fail, fields, FoundryError, name } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./drafts.mjs").Ref} Ref */
/** @typedef {(c:import("./model.js").NativeCall)=>void} Verify */
/** @param {string} cwd @param {Run} run @param {string} actor @param {Ref} ref @param {Verify} verify */
export function evaluatorPlan(cwd,run,actor,ref,verify){
	const basis=ref.evaluation,p=run.products.at(-1),g=run.effects.find(c=>c.id===run.goal?.check),target=commitAt(cwd,run.policy.target);
	const kind=ref.to[0]===run.policy.goalCheck?"goal":"product",from=(kind==="goal"?run.repins?.at(-1)?.revision:productPin(run))??run.policy.base;
	if(actor!==run.owner || (!ref.draft && ref.publisher!==actor) || !basis || basis.from!==from || !p || p.check!==basis.checkpoint || p.target!==target ||
		ref.to.length!==1 || ref.to[0]!==(kind==="goal"?run.policy.goalCheck:run.policy.productCheck) || run.join || run.blocker || run.conflict ||
		g?.kind!=="goal" || g.id!==basis.goal || g.commit!==p.commit || !currentEvaluation(run,g) || ![1,2].includes(checkReceipt(g)?.exit??-1) ||
		run.effects.some(e=>e.permissionHold) || run.inspections?.some(i=>i.permissionHold))fail("stale_pin","The evaluator offer no longer matches its checked product and goal");
	const c=run.effects.find(e=>e.id===p.check);
	if(c?.kind!=="product" || checkReceipt(c)?.exit!==0)fail("missing_receipt","Missing exact product evidence for evaluator correction");
	verify(g);verify(c);
	const {assembly,files:delta,patch}=exactPatch(cwd,from,from,ref.blob),files=delta.map(f=>f.file).sort();
	if(!matchesDraft(ref,g.id,from,delta))fail("patch_scope","The evaluator diff does not match its bound author");
	const requested=prepareRepin(cwd,run,actor,{from,revision:assembly,files,...(kind==="product" && {kind,
		...(run.policy.ownership==="retain-except-transferred" || run.productRepins?.at(-1)?.ownership==="retain-except-transferred"?{ownership:"retain-except-transferred"}:{})})},verify);
	/** @type {NonNullable<import("./model.js").Adoption["evaluator"]>} */ const evaluator={kind,from,blob:ref.blob,files,...(ref.draft && {draft:ref.draft.id})};
	const prompt=`Review ${kind} evaluator correction ${ref.blob} on run ${run.id}. Current signed goal ${g.id}, checkpoint ${p.check}, product ${p.commit}.\n${requested.prompt}\n${patch}`;
	return {offer:{revision:target,checkpoint:p.check,goal:g.id,assembly,evaluator,message:prompt},prompt,
		/** @param {Run} live @param {string} answer */
		apply(live,answer){
			if(answer!==ref.blob)fail("approval_required","The response does not approve this exact evaluator diff");
			requested.apply(live);
			return ()=>commitAt(cwd,live.policy.target)===target;
		}};
}

/** @param {Run} run @param {Ref} ref */
const currentEvaluator=(run,ref)=>ref.evaluation && (ref.draft || ref.publisher===run.owner) && !run.join && ref.evaluation.goal===run.goal?.check &&
	ref.evaluation.checkpoint===run.products.at(-1)?.check && ref.evaluation.from===((ref.to[0]===run.policy.goalCheck?run.repins?.at(-1)?.revision:productPin(run))??run.policy.base);
/** Select or reopen already published bytes without manufacturing another commit or reviving a stale offer.
 * @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} args @param {Verify} verify */
export function selectedEvaluator(cwd,run,actor,args,verify){
	if(actor!==run.owner)fail("foreign_run","Only the run owner can select an evaluator correction");
	fields(args,["run","blob","check"]);const blob=name(args.blob,"evaluator patch blob"),check=nameOfEvaluator(run,args.check);
	const refs=correctionRefs(run).filter(o=>o.blob===blob && o.to.length===1 && o.to[0]===check && currentEvaluator(run,o));
	if(!refs.length)fail("stale_pin","No such owner offer for this evaluator, checkpoint and goal");
	const plan=evaluatorPlan(cwd,run,actor,refs[0],verify);
	return {target:plan.offer,prompt:plan.prompt,answer:blob,apply:(/** @type {Run} */ r)=>plan.apply(r,blob)};
}
/** @param {Run} run @param {unknown} value */
function nameOfEvaluator(run,value){
	if(typeof value==="string" && (value===run.policy.goalCheck || value===run.policy.productCheck))return value;
	return fail("invalid_recipient","Select the declared goal or product evaluator");
}

/** Examine frozen offers, without recording a decision or changing a prior presentation.
 * Scheduling and manual author requests use this same result; diagnostic text never selects a path.
 * @param {string} cwd @param {Run} run @param {string} actor @param {Verify} verify
 * @returns {{selected?:import("./offers.mjs").Subject,conflict?:string,diagnostic?:string}|undefined} */
export function offerChoices(cwd,run,actor,verify){
	if(actor!==run.owner || !run.active || run.independent || run.conflict || run.policyHold || run.blocker)return;
	const candidates=correctionRefs(run);if(!candidates.length)return;
	const j=run.join,parent=j && run.adoptions?.findLast(a=>a.rollout && a.failed===j.check && a.decision?.status==="answered");
	const batch=parent && rolloutChecks(run,parent),last=batch?.findLast(c=>!!checkReceipt(c));
	const check=parent?last?.id:j && failedComponent(run.effects.find(c=>c.id===j.check))?j.check:undefined;
	const from=parent?.assembly??j?.commit,used=new Set(run.adoptions?.flatMap(a=>a.rollout && a.decision?.status==="answered"?[a.rollout.blob]:[]));
	const goal=checkReceipt(run.effects.find(e=>e.id===run.goal?.check));
	const refs=candidates.filter(ref=>(ref.evaluation ? currentEvaluator(run,ref) && [1,2].includes(goal?.exit??-1) &&
		!run.adoptions?.some(a=>a.evaluator?.blob===ref.blob && a.goal===ref.evaluation?.goal && a.checkpoint===ref.evaluation?.checkpoint &&
			a.evaluator?.kind===(ref.to[0]===run.policy.goalCheck?"goal":"product") && a.decision && a.decision.status!=="presenting") :
		check && from && matchesDraft(ref,check,from) && !used.has(ref.blob) && (!ref.assembly || ref.assembly===from) && (ref.assembly===from || !parent || last?.receipt?.exit!==0) &&
		(ref.assembly || (ref.index??-1)>=(parent?.offeredThrough??0)) &&
		!run.adoptions?.some(a=>a.rollout?.blob===ref.blob && (!ref.assembly || (a.rollout.followup?.assembly??a.rollout.from)===from) &&
			(a.decision?.status==="dismissed" || a.decision?.status==="unavailable"))));
	if(!refs.length)return;
	const tip=commitAt(cwd,run.policy.target);
	const errors=[];
	/** @type {Map<string,import("./offers.mjs").Subject>} */ const choices=new Map();
	let narrow,conflict;
	for(const ref of refs){
		try{
			if(ref.evaluation){
				const plan=evaluatorPlan(cwd,run,actor,ref,verify);choices.set(`${ref.to[0]}:${ref.blob}`,plan.offer);
			}else if(check && from && ref.base===tip && !choices.has(ref.blob)){
				const bytes=git(cwd,["cat-file","blob",ref.blob]);
				if(!bytes.subarray(0,11).equals(Buffer.from("diff --git ")))continue;
				if(ref.draft && !parent){
					try{const narrow=patchPlan(cwd,run,actor,tip,verify,check,ref.blob);choices.set(ref.blob,narrow.offer);continue;}
					catch(e){if(!(e instanceof FoundryError))throw e;errors.push(`Draft ${ref.blob}: ${e.message}`);}
				}
				const plan=rolloutPlan(cwd,run,actor,from,check,ref.blob,verify);
				if((plan.offer.rollout.followup?.files??plan.offer.rollout.files).every(f=>f.file.startsWith(".foundry/") || covers(ref.to,f.file)))
					choices.set(ref.blob,plan.offer);
			}
		}catch(e){
			if(!(e instanceof FoundryError))throw e;
			// A domain preflight refusal belongs to this blob, not to the owner scheduler.
			errors.push(`Offer ${ref.blob}: ${e.message}`);
		}
	}
	if(!parent && j && check){
		try{narrow=patchPlan(cwd,run,actor,tip,verify,check).offer;}
		catch(e){if(!(e instanceof FoundryError))throw e;if(e.code==="ambiguous_patches")conflict=e.message;}
	}
	if(narrow)choices.set(narrow.patch.blob,narrow);
	if(choices.size>1 || conflict)return {conflict:`Competing exact corrections; choose the intended bytes rather than applying a patch automatically. ${[...choices.keys()].join(", ")}${conflict?" "+conflict:""}`};
	const [selected]=choices.values();
	return selected?{selected}:errors.length?{diagnostic:[...new Set(errors)].join("\n")}:undefined;
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {Verify} verify
 * @returns {{offer?:import("./model.js").Adoption,ambiguous?:true}|undefined} */
export function planOffers(cwd,run,actor,verify,discover=true){
	const existing=currentOffer(run);
	if(actor===run.owner && run.active && (existing?.failed || existing?.evaluator) && existing.decision?.status==="presenting" &&
		commitAt(cwd,run.policy.target)===existing.revision){
		if(matchesPresentation(cwd,run,existing))return {offer:existing};
		invalidatePresentation(existing,"The original approval inputs changed. No new change was approved.");
		delete run.targetProposal;
	}
	if(!discover)return;
	const result=offerChoices(cwd,run,actor,verify);
	if(!result)return;
	if(result.conflict){
		run.offerHold=result.conflict;
		if(existing)invalidatePresentation(existing,"The current evidence no longer selects one correction.");
		delete run.targetProposal;return {ambiguous:true};
	}
	const s=result.selected;
	if(!s){if(result.diagnostic)run.offerHold=result.diagnostic;return;}
	const id=offerId(s),prior=run.adoptions?.find(a=>a.id===id);
	if(prior?.decision && prior.decision.status!=="presenting")return;
	const basis=presentationBasis(run,s);
	if(existing?.decision?.status==="presenting"){
		if(existing.id===id && (s.failed || existing.basis===basis)){existing.basis=basis;return {offer:existing};}
		invalidatePresentation(existing,"The proposal changed before approval; no new bytes were authorized.");
		if(existing.id===id)return;
	}
	return {offer:rememberOffer(run,{...s,id,basis})};
}
