import { randomUUID } from "node:crypto";
import { decide, invalidatePresentation, observeReply, presentDialog, redisplay } from "./dialog.mjs";
import { issuerGone, presenter, restorableForm, whilePresenting } from "./forms.mjs";
import { checkpointReceipt, goalReceipt } from "./evidence.mjs";
import { expired } from "./native.mjs";
import { currentOffer, matchesPresentation, offerId, pendingAdoption, presentationBasis, rememberOffer } from "./offers.mjs";
import { observeTarget } from "./goal.mjs";
import { frozenCheckpoint } from "./frozen.mjs";
import { changedFiles, commitAt, contractConflict } from "./product.mjs";
import { targetPlan } from "./repin.mjs";
import { patchPlan } from "./patch.mjs";
import { rolloutPlan } from "./rollout.mjs";
import { evaluatorPlan, offerChoices } from "./offering.mjs";
import { correctionRefs } from "./drafts.mjs";
import { reserveChange } from "./obligations.mjs";
import { digest, fail, FoundryError, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Adoption} Adoption */
/** @typedef {import("./offers.mjs").Subject} Subject */
/** @typedef {(e:import("./model.js").NativeCall)=>void} Verify */
/** Never call the mode-dependent auto-confirm helper for a change to the authorized bytes.
 * @param {((message:string)=>Promise<boolean>)|undefined} confirm @param {string} accepted */
export function exactForm(confirm,accepted){
	return confirm && (async(/** @type {string} */ message)=>{
		const answer=await confirm(message);
		if(answer===false)return null;
		if(answer!==true)fail("approval_required","The exact proposal was not explicitly approved");
		return accepted;
	});
}
/** @param {Pick<Parameters<typeof import("./runtime.mjs").createRuntime>[1],"confirm"|"confirmProposal"|"adopt">} host @param {Adoption|undefined} a */
export const proposalForm=(host,a)=>a && (a.evaluator || a.rollout ? exactForm(host.confirmProposal,(a.evaluator??a.rollout)?.blob??fail("missing_artifact","Missing proposed patch")) : a.patch ? exactForm(host.confirmProposal??host.confirm,a.patch.blob) : host.adopt);
/** @param {string} cwd @param {Run} run @param {string} actor @param {string} revision @param {Verify} verify @param {string} [failed] @param {string} [blob] */
const proposal=(cwd,run,actor,revision,verify,failed,blob)=>failed ?
	patchPlan(cwd,run,actor,revision,verify,failed,blob) : targetPlan(cwd,run,actor,revision,verify);
/** @param {Run} run @param {Subject} subject @returns {Adoption} */
export function requestedAdoption(run,subject) {
	const id=offerId(subject), prior=run.adoptions?.find(a=>a.id===id);
	return {id,basis:presentationBasis(run,subject),...subject,...(prior?.decision && {decision:prior.decision})};
}

/** Resume under the old contract only. A changed activation brief is not eligible for adoption.
 * @param {string} cwd @param {Run} run @param {string} target */
export function adoptionBase(cwd,run,target){
	const p=run.products.at(-1);
	if(p && p.target!==target && contractConflict(cwd,run.policy,target) &&
		!changedFiles(cwd,run.policy.contractTarget??run.policy.base,target,[run.policy.source]).length)
		return frozenCheckpoint(cwd,run,target)?.target;
}

/** The release machine selects a changed contract or a failed component on the already adopted contract.
 * Both use the same claimed presentation. No dialog or evaluator runs on the planning snapshot.
 * @param {string} cwd @param {Run} run @param {string} actor @param {string|undefined} revision @param {Verify} verify */
export function planAdoption(cwd,run,actor,revision,verify) {
	if(actor!==run.owner || !run.active || expired(run))return;
	const last=run.products.at(-1), goal=run.goal, prior=run.adoptions?.at(-1);
	const failed=revision===run.policy.contractTarget ? run.join?.check : undefined;
	if(!revision || !last || revision===last.target || last.qualifiedAt || !goal || goal.commit!==last.commit || goal.target!==last.target ||
		!failed && (!checkpointReceipt(run,last.check,last.commit) || ![1,2].includes(goalReceipt(run)?.exit??-1))){
		invalidatePresentation(prior,"This target adoption is no longer current.");
		delete run.targetProposal;
		return;
	}
	/** @type {Subject} */ let subject;
	try {subject=proposal(cwd,run,actor,revision,verify,failed).offer;}
	catch(error){
		if(!(error instanceof FoundryError))throw error;
		// In-flight work gets to finish. Its receipt will wake the same owner.
		if(error.code==="unsettled_checkpoint" || error.code==="dispatch_held"){
			invalidatePresentation(prior,"The original verified change has outstanding work. No approval was applied.");
			delete run.targetProposal;
			return;
		}
		subject={revision,checkpoint:last.check,goal:goal.check,...(failed && {failed}),message:failed ? error.message : `Cannot propose target adoption: ${error.message}`};
	}
	const id=offerId(subject);
	if(prior?.decision?.status==="presenting"){
		if(id===prior.id && matchesPresentation(cwd,run,prior))return;
		invalidatePresentation(prior,"The target or verified change no longer matches the presented scope.");
	}
	rememberOffer(run,{id,basis:presentationBasis(run,subject),...subject});
	return pendingAdoption(run);
}

/** @typedef {{cwd:string,store:()=>Pick<ReturnType<typeof import("./database.mjs").openDatabase>,"planAndSwap"|"verifySigned">,
 * closed:()=>boolean,executable:()=>Promise<boolean>,permissionBlocker:()=>Promise<import("./permissions.mjs").PermissionBlock|null>,
 * persist:<T>(write:()=>T|Promise<T>)=>Promise<T|undefined>,idle:()=>boolean|Promise<boolean>,adopt:(message:string)=>Promise<string|null>,wake:()=>Promise<void>}} ApprovalHost */
/** @typedef {{showing:boolean,prompt:string,vacant?:()=>Promise<boolean>}|{lost:string,vacant:()=>Promise<boolean>}} Presentation */
/** Present exactly once after a committed claim. A new display does not adopt, approve, or recheck.
 * @param {ApprovalHost} io @param {string} runId @param {string} actor @param {Adoption} expected @param {Presentation} [request] */
export function presentAdoption(io,runId,actor,expected,request){
	const presentation=randomUUID();
	return whilePresenting(presentation,io.closed,()=>present(io,runId,actor,expected,presentation,request));
}
/** @param {ApprovalHost} io @param {string} runId @param {string} actor @param {Adoption} expected @param {string} presentation @param {Presentation} [request] */
async function present(io,runId,actor,expected,presentation,request){
	const explicit=request && "prompt" in request ? request : undefined,restore=request && "lost" in request ? request : undefined;
	const permitted=async()=>!await io.permissionBlocker() && await io.executable();
	/** @type {ReturnType<typeof decide>|undefined} */ let claim;
	const target=(/** @type {Run} */ r)=>observeTarget(()=>commitAt(io.cwd,r.policy.target)).target;
	const stored=await io.persist(async()=>{
		if(!await permitted()){
			if(explicit)fail("permissions_unready","The owner cannot currently approve target adoption.");
			return "held";
		}
		if(!explicit && !await io.idle())return "approval-delivery";
		const checked=explicit?.vacant && expected.decision?.status==="presenting" && issuerGone(expected.decision) ? await explicit.vacant() : undefined;
		if(restore && !await restore.vacant())return;
		if((restore || checked!==undefined) && !await permitted())return;
		return io.store().planAndSwap(runId,r=>{
			claim=undefined;
			if(io.closed() || r.owner!==actor || !r.active || expired(r) || target(r)!==expected.revision || !matchesPresentation(io.cwd,r,expected))return;
			if(explicit){
				const prior=r.adoptions?.at(-1), same=r.adoptions?.find(a=>a.id===expected.id);
				if(digest(same?.decision??null)!==digest(expected.decision??null) || prior?.decision?.status==="presenting" &&
					(explicit.showing || !issuerGone(prior.decision) || explicit.vacant && (prior.id!==expected.id || checked!==true)))
					fail("approval_pending","Foundry is awaiting the original native approval reply; its visibility is not confirmed. No additional form or check was issued.");
				invalidatePresentation(prior,"Superseded by an explicitly requested target approval.");
				const a=rememberOffer(r,{...expected});
				if(a.decision){
					(a.previous??=[]).push(a.decision);delete a.decision; // A new operator request, never an automatic retry.
				}
			}
			const a=restore?currentOffer(r):pendingAdoption(r);
			if(!a || a.id!==expected.id || a.basis!==expected.basis)return;
			const next=/** @type {const} */ ({status:"presenting",presentation,presenter,...(explicit && (a.failed || a.evaluator) && {selected:a.id})});
			if(restore){
				const result=redisplay(a,next,restore.lost,{issuerGone:restorableForm(a)===restore.lost,nativeVacant:true});
				if(!result.edge)return;
				(a.previous??=[]).push({status:"unavailable",presentation:restore.lost,reason:"The previous presenter is gone and no native form remains. No answer was recorded."});
				claim=result;
			}else claim=decide(a,next);
			return ()=>!io.closed() && !expired(r) && target(r)===a.revision;
		});
	});
	if(stored==="held")return "issuer-permission";
	if(stored==="approval-delivery")return stored;
	const a=stored?.adoptions?.at(-1);
	if(io.closed() || !claim || !a || a.decision?.status!=="presenting" || a.decision.presentation!==presentation){
		if(explicit)fail("stale_pin","Target or checkpoint changed during approval");
		return;
	}
	/** @type {import("./dialog.mjs").Reply} */ let reply;
	const asking=presentDialog(claim,async()=>io.adopt(explicit?.prompt??a.message));
	try{
		const answer=await asking;
		reply=answer===null ? {status:"dismissed"} : {status:"answered",answer:text(answer,"operator's reviewed acceptance change")};
	}catch{
		reply={status:"unavailable",presentation,reason:a.failed ? "No confirmed correction approval. The original failed assembly is unchanged; the operator can reopen this exact patch." :
			"The native target form did not return a confirmed acceptance statement. No target was adopted; the owner can explicitly request a fresh review."};
	}
	let applied=false;
	await io.persist(async()=>{
		const allowed=reply.status==="answered" && !io.closed() && await permitted();
		if(io.closed())return;
		const store=io.store();
		store.planAndSwap(runId,r=>{
			applied=false;
			const live=r.adoptions?.at(-1);
			if(r.owner!==actor || r.targetProposal!==a.id || live?.id!==a.id || live.decision?.status!=="presenting" || live.decision.presentation!==presentation)return;
			if(reply.status!=="answered"){observeReply(live,presentation,reply);return;}
			if(!allowed || !r.active || expired(r) || target(r)!==live.revision || !matchesPresentation(io.cwd,r,live)){
				invalidatePresentation(live,"Approval is stale or no longer permitted. No new assembly was approved.");return;
			}
			const selected=live.decision.selected===live.id;
			let plan;
			const verify=(/** @type {import("./model.js").NativeCall} */ c)=>store.verifySigned(runId,c);
			try{
				if(!selected && (live.failed || live.evaluator)){
					const choices=offerChoices(io.cwd,r,actor,verify);
					if(choices?.conflict || choices?.selected && offerId(choices.selected)!==live.id)fail("stale_pin","The correction no longer has a unique current selection");
				}
				plan=live.evaluator ? evaluatorPlan(io.cwd,r,actor,correctionRefs(r).find(ref=>ref.blob===live.evaluator?.blob && ref.evaluation?.from===live.evaluator?.from &&
				ref.evaluation?.goal===live.goal && ref.evaluation.checkpoint===live.checkpoint && ref.draft?.id===live.evaluator?.draft && ref.to.length===1 &&
				ref.to[0]===(live.evaluator?.kind==="goal"?r.policy.goalCheck:r.policy.productCheck))??fail("missing_artifact","Evaluator offer disappeared"),verify) :
				live.rollout ? rolloutPlan(io.cwd,r,actor,live.rollout.followup?.assembly??live.rollout.from,live.rollout.followup?.check??text(live.failed,"failed check"),live.rollout.blob,verify) :
				live.manifest ? targetPlan(io.cwd,r,actor,live.revision,verify,{...live.manifest,checkpoint:live.checkpoint,goal:live.goal}) :
				proposal(io.cwd,r,actor,live.revision,verify,live.failed,selected?live.patch?.blob:undefined);}
			catch(error){
				if(!(error instanceof FoundryError))throw error;
				invalidatePresentation(live,`Approval no longer applies: ${error.message}`);return;
			}
			if(offerId(plan.offer)!==live.id || !explicit && !live.failed && plan.prompt!==a.message){
				invalidatePresentation(live,"The prepared target no longer matches the original proposal.");return;
			}
			const guard=live.failed ? reserveChange(io.cwd,r,live,reply.answer) :
				"apply" in plan ? plan.apply(r,reply.answer) : fail("invalid_patch","No verification operation for the approved change");
			if(live.rollout)live.offeredThrough=r.artifacts?.length??0;
			observeReply(live,presentation,reply);delete r.targetProposal;applied=true;
			return ()=>!io.closed() && !expired(r) && guard();
		});
	});
	if(explicit && !applied){
		if(reply.status==="dismissed")fail("approval_declined","Target change not approved. No change or recheck was made.");
		if(reply.status==="unavailable")fail("approval_required",reply.reason);
		fail("stale_pin","Target or checkpoint changed during approval, or permission is no longer available.");
	}
	if(!explicit && applied && !io.closed())await io.wake();
}
