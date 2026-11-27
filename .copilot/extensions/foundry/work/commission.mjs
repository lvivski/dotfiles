import { randomUUID } from "node:crypto";
import { draftBudget, draftScope } from "./authorship.mjs";
import { decide, observeReply, presentDialog, redisplay } from "./dialog.mjs";
import { draftAllowed } from "./drafts.mjs";
import { issuerGone, presenter, whilePresenting } from "./forms.mjs";
import { expired } from "./native.mjs";
import { commitAt } from "./product.mjs";
import { digest, fail, fields, FoundryError, name, relative } from "./values.mjs";

/** @param {{cwd:string,store:Pick<ReturnType<typeof import("./database.mjs").openDatabase>,"read"|"planAndSwap"|"verifySigned">,closed:()=>boolean,
 * permitted:()=>Promise<boolean>,vacant?:(()=>Promise<boolean>),confirm?:((message:string)=>Promise<boolean>),
 * persist:<T>(write:()=>T|Promise<T>)=>Promise<T|undefined>}} io @param {string} id @param {string} actor @param {Record<string,unknown>} a */
export async function selectDraft(io,id,actor,a){
	fields(a,["run","check","files","evaluator"]);
	const live=io.store.read(id);if(live?.owner!==actor || !live)fail("foreign_run","Only the owner can select another correction-author scope");
	if(a.files!==undefined && !Array.isArray(a.files))fail("invalid_scope","Select exact file paths");
	const req={check:name(a.check,"signed observation"),automatic:false,
		...(a.evaluator!==undefined && {evaluator:relative(a.evaluator)}),...(Array.isArray(a.files) && {files:a.files.map(relative)})};
	const verify=(/** @type {import("./model.js").NativeCall} */ c)=>io.store.verifySigned(id,c);
	const expected=draftScope(io.cwd,live,req,verify),prior=live.correctionDrafts?.find(v=>v.id===expected.id),previous=prior?.decision;
	if(prior && draftAllowed(prior))return;
	const lost=previous?.status==="presenting" && previous.presentation && issuerGone(previous) && await io.vacant?.()===true;
	if(previous?.status==="presenting" && !lost)fail("approval_pending","The original native scope presentation is unconfirmed; no second request was issued");
	if(!io.confirm || !await io.permitted())fail("approval_required","The native scope approval is unavailable");
	const confirm=io.confirm,presentation=randomUUID();
	const message=`Authorize bounded correction authors for signed check ${expected.check} on ${expected.assembly}? `+
		`Only these exact source files and preimages, preserving modes (null before permits proposing creation): ${JSON.stringify(expected.parts.map(({source,files})=>({source,files})))}. `+
		"No checkout access, ownership transfer, evaluator change or applied edits. Review actual bytes separately.";
	await whilePresenting(presentation,io.closed,async()=>{
		/** @type {ReturnType<typeof decide>|undefined} */ let claim;
		io.store.planAndSwap(id,r=>{
			claim=undefined;const scope=draftScope(io.cwd,r,req,verify);
			if(scope.id!==expected.id)fail("stale_pin","Correction scope changed before selection");
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
					try{draftBudget(r,d);if(draftScope(io.cwd,r,req,verify).id===d.id){observeReply(d,presentation,{status:"answered",answer:d.id});return ()=>!io.closed() && commitAt(io.cwd,r.policy.target)===d.target;}}
					catch(e){if(!(e instanceof FoundryError))throw e;}
				}
				observeReply(d,presentation,{status:"unavailable",presentation,reason:"No current affirmative scope decision. No proposal author was issued."});
			});
		});
		if(!updated?.correctionDrafts?.some(d=>d.id===expected.id && draftAllowed(d)))fail(answer===null?"approval_declined":"approval_required","Correction-author scope not approved");
	});
}
