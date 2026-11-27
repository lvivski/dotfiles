import { randomUUID } from "node:crypto";
import { draftBudget, draftWorkPending, repairSubject, verifyDraft } from "./authorship.mjs";
import { decide, observeReply, presentDialog, redisplay } from "./dialog.mjs";
import { draftAllowed } from "./drafts.mjs";
import { remainingAssignments } from "./capacity.mjs";
import { validDraftScope } from "./preimages.mjs";
import { issuerGone, presenter, whilePresenting } from "./forms.mjs";
import { expired } from "./native.mjs";
import { commitAt } from "./product.mjs";
import { offerChoices } from "./offering.mjs";
import { digest, fail, FoundryError } from "./values.mjs";

/** Only an unpresented, still-current scope may request an owner form. Historical validity alone is not consent.
 * @param {import("./model.js").Run} run @param {()=>string|undefined} [tip] */
export function pendingScope(run,tip){
	if(!run.correctionDrafts?.length || !run.join || !run.active || run.policyHold || run.conflict || run.blocker || run.independent ||
		run.effects.some(e=>e.permissionHold) || run.inspections?.some(i=>i.permissionHold))return;
	const join=run.join,waiting=run.correctionDrafts.filter(d=>d.finding && !d.decision && d.goal===run.goal?.check &&
		d.checkpoint===run.products.at(-1)?.check && d.target===join.target && d.parts.length<=remainingAssignments(run));
	if(!waiting.length || tip && tip()!==join.target)return;
	const subject=repairSubject(run);
	if(subject?.review && !draftWorkPending(run,subject.frontier))return waiting.find(d=>d.check===subject.check && validDraftScope(run,d));
}

/** @param {{cwd:string,store:Pick<ReturnType<typeof import("./database.mjs").openDatabase>,"read"|"planAndSwap"|"verifySigned">,closed:()=>boolean,
 * permitted:()=>Promise<boolean>,vacant?:(()=>Promise<boolean>),confirm?:((message:string)=>Promise<boolean>),
 * persist:<T>(write:()=>T|Promise<T>)=>Promise<T|undefined>}} io @param {string} id @param {string} actor @param {import("./model.js").CorrectionDraft} expected @param {boolean} [automatic] */
export async function selectDraft(io,id,actor,expected,automatic=false){
	const live=io.store.read(id);if(live?.owner!==actor || !live)fail("foreign_run","Only the owner can select another correction-author scope");
	const verify=(/** @type {import("./model.js").NativeCall} */ c)=>io.store.verifySigned(id,c);
	const prior=live.correctionDrafts?.find(v=>v.id===expected.id),previous=prior?.decision;
	if(prior && draftAllowed(prior) || automatic && (!prior || previous))return;
	/** @param {import("./model.js").Run} r */
	function scopeAt(r){
		if(automatic){
			const offers=offerChoices(io.cwd,r,actor,verify);
			if(offers?.selected || offers?.conflict)fail("dispatch_held","An offered correction already needs its own decision");
		}
		return verifyDraft(io.cwd,r,expected,verify);
	}
	const lost=previous?.status==="presenting" && previous.presentation && issuerGone(previous) && await io.vacant?.()===true;
	if(previous?.status==="presenting" && !lost)fail("approval_pending","The original native scope presentation is unconfirmed; no second request was issued");
	if(!io.confirm || !await io.permitted())fail("approval_required","The native scope approval is unavailable");
	const confirm=io.confirm,presentation=randomUUID();
	const finding=expected.finding && live.inspections?.find(i=>i.id===expected.finding?.inspection);
	const message=`Authorize bounded correction authors for signed check ${expected.check} on ${expected.assembly}? `+
		(finding?`Independent review ${finding.id} (${finding.workflow}) requested changes: ${JSON.stringify(finding.summary)}. This finding is not edit authority. `:"")+
		`Only these exact source files and preimages, preserving modes (null before permits proposing creation): ${JSON.stringify(expected.parts.map(({source,files})=>({source,files})))}. `+
		"No checkout access, ownership transfer, evaluator change or applied edits. Review actual bytes separately.";
	await whilePresenting(presentation,io.closed,async()=>{
		/** @type {ReturnType<typeof decide>|undefined} */ let claim;
		io.store.planAndSwap(id,r=>{
			claim=undefined;const scope=scopeAt(r);
			const d=r.correctionDrafts?.find(v=>v.id===scope.id)??scope;
			if(draftAllowed(d))return;
			draftBudget(r,d);
			if(digest(d.decision??null)!==digest(previous??null) || r.adoptions?.some(v=>v.decision?.status==="presenting") ||
				r.correctionDrafts?.some(v=>v!==d && v.check===d.check && (v.decision?.status==="presenting" ||
					draftAllowed(v) && !v.blob && !v.parts.some(p=>p.state==="held"))))
				fail("dispatch_held","An original author or decision is outstanding; do not replay it");
			const next=/** @type {const} */({status:"presenting",presentation,presenter});
			if(d.decision?.status==="presenting" && previous?.status==="presenting" && previous.presentation && lost){
				claim=redisplay(d,next,previous.presentation,{issuerGone:issuerGone(d.decision),nativeVacant:true});
				if(!claim.edge)fail("approval_pending","The original presenter is still live");
				(d.previous??=[]).push({status:"unavailable",presentation:previous.presentation,reason:"The previous scope presenter is gone and the native queues are clear."});
			}else{
				if(d.decision){(d.previous??=[]).push(d.decision);delete d.decision;}
				claim=decide(d,next);
			}
			if(d===scope)(r.correctionDrafts??=[]).push(d);
			return ()=>!io.closed() && !expired(r) && commitAt(io.cwd,r.policy.target)===d.target;
		});
		if(!claim)return;
		let answer;
		try{answer=await presentDialog(claim,async()=>{const yes=await confirm(message);
			return yes===true?expected.id:yes===false?null:fail("approval_required","No confirmed button answer");});}
		catch{answer=undefined;}
		const updated=await io.persist(async()=>{
			const allowed=answer===expected.id && await io.permitted();
			return io.store.planAndSwap(id,r=>{
				const d=r.correctionDrafts?.find(v=>v.id===expected.id);
				if(!d || d.decision?.status!=="presenting" || d.decision.presentation!==presentation)return;
				if(answer===null){observeReply(d,presentation,{status:"dismissed"});return;}
				if(allowed && r.active && !expired(r)){
					try{draftBudget(r,d);scopeAt(r);observeReply(d,presentation,{status:"answered",answer:d.id});return ()=>!io.closed() && commitAt(io.cwd,r.policy.target)===d.target;}
					catch(e){if(!(e instanceof FoundryError))throw e;}
				}
				observeReply(d,presentation,{status:"unavailable",presentation,reason:"No current affirmative scope decision. No proposal author was issued."});
			});
		});
		if(!updated?.correctionDrafts?.some(d=>d.id===expected.id && draftAllowed(d)))fail(answer===null?"approval_declined":"approval_required","Correction-author scope not approved");
	});
}
