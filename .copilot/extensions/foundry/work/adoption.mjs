import { randomUUID } from "node:crypto";
import { decide, invalidatePresentation, observeReply, presentDialog } from "./dialog.mjs";
import { checkpointReceipt, goalReceipt } from "./evidence.mjs";
import { expired } from "./native.mjs";
import { offerId, pendingAdoption, rememberOffer, targetBasis } from "./offers.mjs";
import { observeTarget } from "./goal.mjs";
import { frozenCheckpoint } from "./frozen.mjs";
import { changedFiles, commitAt, contractConflict } from "./product.mjs";
import { targetPlan } from "./repin.mjs";
import { inheritedPlan } from "./inherited.mjs";
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
/** @param {Pick<Parameters<typeof import("./runtime.mjs").createRuntime>[1],"confirm"|"adopt">} host @param {Adoption|undefined} a */
export const proposalForm=(host,a)=>a && (a.patch ? exactForm(host.confirm,a.patch.blob) : host.adopt);
/** @param {string} cwd @param {Run} run @param {string} actor @param {string} revision @param {Verify} verify @param {string} [failed] @param {string} [blob] */
const proposal=(cwd,run,actor,revision,verify,failed,blob)=>failed ?
	inheritedPlan(cwd,run,actor,revision,verify,failed,blob) : targetPlan(cwd,run,actor,revision,verify);
/** @param {string} cwd @param {Run} run @param {Subject} subject @returns {Adoption} */
export function requestedAdoption(cwd,run,subject) {
	const id=offerId(subject), prior=run.adoptions?.find(a=>a.id===id);
	return {id,basis:targetBasis(cwd,run,subject.revision),...subject,...(prior?.decision && {decision:prior.decision})};
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
	const basis=targetBasis(cwd,run,revision);
	if(prior?.id===run.targetProposal && prior?.revision===revision && prior.basis===basis)return pendingAdoption(run);
	invalidatePresentation(prior,"The target or run changed during approval. Review the current inputs instead.");
	/** @type {Subject} */ let subject;
	try {subject=proposal(cwd,run,actor,revision,verify,failed).offer;}
	catch(error){
		if(!(error instanceof FoundryError))throw error;
		// In-flight work gets to finish. Its receipt will wake the same owner.
		if(error.code==="unsettled_checkpoint" || error.code==="dispatch_held"){
			delete run.targetProposal;
			return;
		}
		subject={revision,checkpoint:last.check,goal:goal.check,...(failed && {failed}),message:failed ? error.message : `Cannot propose target adoption: ${error.message}`};
	}
	rememberOffer(run,{id:offerId(subject),basis,...subject});
	return pendingAdoption(run);
}

/** Present exactly once after a committed claim. Only a fresh human answer to that presentation
 * can enter the normal mixed-target preflight; a persisted proposal is never authority.
 * @param {{cwd:string,store:()=>Pick<ReturnType<typeof import("./database.mjs").openDatabase>,"planAndSwap"|"verifySigned">,
 * closed:()=>boolean,executable:()=>Promise<boolean>,permissionBlocker:()=>Promise<import("./permissions.mjs").PermissionBlock|null>,
 * persist:<T>(write:()=>T|Promise<T>)=>Promise<T|undefined>,adopt:(message:string)=>Promise<string|null>,wake:()=>Promise<void>}} io
 * @param {string} runId @param {string} actor @param {Adoption} expected
 * @param {{apply:(live:Run)=>()=>boolean,showing:boolean,prompt:string}} [explicit] */
export async function presentAdoption(io,runId,actor,expected,explicit){
	const permitted=async()=>!await io.permissionBlocker() && await io.executable();
	const presentation=randomUUID();
	/** @type {ReturnType<typeof decide>|undefined} */ let claim;
	const target=(/** @type {Run} */ r)=>observeTarget(()=>commitAt(io.cwd,r.policy.target)).target;
	const stored=await io.persist(async()=>{
		if(!await permitted()){
			if(explicit)fail("permissions_unready","The owner cannot currently approve target adoption.");
			return "held";
		}
		return io.store().planAndSwap(runId,r=>{
			claim=undefined;
			if(io.closed() || r.owner!==actor || !r.active || expired(r) || target(r)!==expected.revision || expected.basis!==targetBasis(io.cwd,r,expected.revision))return;
			if(explicit){
				const prior=r.adoptions?.at(-1), same=r.adoptions?.find(a=>a.id===expected.id);
				if(digest(same?.decision??null)!==digest(expected.decision??null) || explicit.showing && prior?.decision?.status==="presenting")
					fail("approval_pending","An owner approval is already open for this target. Answer that presentation.");
				invalidatePresentation(prior,"Superseded by an explicitly requested target approval.");
				const a=rememberOffer(r,{...expected});
				if(a.decision){
					(a.previous??=[]).push(a.decision);delete a.decision; // A new operator request, never an automatic retry.
				}
			}
			const a=pendingAdoption(r);
			if(!a || a.id!==expected.id || a.basis!==expected.basis)return;
			claim=decide(a,{status:"presenting",presentation});
			return ()=>!io.closed() && !expired(r) && target(r)===a.revision;
		});
	});
	if(stored==="held")return "issuer-permission";
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
			if(!allowed || !r.active || expired(r) || target(r)!==live.revision || live.basis!==targetBasis(io.cwd,r,live.revision)){
				invalidatePresentation(live,"Approval is stale or no longer permitted. No new assembly was approved.");return;
			}
			let plan;
			try{plan=proposal(io.cwd,r,actor,live.revision,e=>store.verifySigned(runId,e),live.failed,explicit && live.patch?.blob);}
			catch(error){
				if(!(error instanceof FoundryError))throw error;
				invalidatePresentation(live,`Approval no longer applies: ${error.message}`);return;
			}
			if(offerId(plan.offer)!==live.id || !explicit && plan.prompt!==a.message){
				invalidatePresentation(live,"The prepared target no longer matches the original proposal.");return;
			}
			const guard=explicit ? explicit.apply(r) : plan.apply(r,reply.answer);
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
