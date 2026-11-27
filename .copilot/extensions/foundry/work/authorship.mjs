import { awaitingReply, unissued } from "./dispatch.mjs";
import { working } from "./assignment.mjs";
import { remainingAssignments } from "./capacity.mjs";
import { corroborated, currentRollout, rolloutChain, rolloutSlots, stoppedBatch, within } from "./campaign.mjs";
import { safeEvidence } from "./critique.mjs";
import { draftChanges, draftId, movePart, partId } from "./drafts.mjs";
import { checkerPaths, originalProducer, protectedDraftPath } from "./preimages.mjs";
import { adoptedStop, changeOffer, checkReceipt, correctionEvaluator, currentEvaluation, failedComponent, productPin } from "./evidence.mjs";
import { admitted, current } from "./native.mjs";
import { offerChoices } from "./offering.mjs";
import { changedFiles, checkDirectory, commitAt, committedFile, draftDiff, entries, git, outside, retain } from "./product.mjs";
import { publishedComponent } from "./publication.mjs";
import { patchSource, replacementChecks, replacementStop } from "./replacement.mjs";
import { exactPatch } from "./rollout.mjs";
import { grant } from "./transfer.mjs";
import { contains, covers, digest, fail, fields, name, record, relative, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").CorrectionDraft} Draft */
/** @typedef {import("./model.js").DraftPart} Part */
/** @typedef {import("./model.js").DraftSource} Source */
/** @typedef {(c:import("./model.js").NativeCall)=>void} Verify */
/** @typedef {{check:string,files?:string[],evaluator?:string,automatic:boolean}} Request */
/** @param {Run} run @param {string} id @param {Verify} verify */
function signed(run,id,verify){
	const e=run.effects.find(e=>e.id===id);
	if(e?.tool!=="bash" || !e.runnerClaim || !checkReceipt(e))fail("missing_receipt",`Missing original signed check ${id}`);
	verify(e);return e;
}
/** @param {Run} run */
export function stoppedDraftCheck(run){
	const j=run.join,chain=j && rolloutChain(run,j.check),last=chain?.at(-1);
	if(last)return rolloutSlots(run,last).checks.find(c=>c.receipt?.exit===1 && stoppedBatch(run,last,c.id,false))?.id;
	return j && failedComponent(run.effects.find(e=>e.id===j.check))?j.check:undefined;
}
/** Select and re-select the *actual* bytes the writer will see at dispatch and return. No checkout, diff or diagnosis from the owner.
 * @param {string} cwd @param {Run} run @param {Request} req @param {Verify} verify @returns {Draft} */
export function draftScope(cwd,run,req,verify){
	admitted(run);
	const {check,automatic,evaluator}=req,tip=commitAt(cwd,run.policy.target),p=run.products.at(-1),g=run.goal,j=run.join;
	if(!p || !g || run.blocker || run.conflict || run.independent || run.policyHold || run.effects.some(e=>e.permissionHold) ||
		run.inspections?.some(i=>i.permissionHold))fail("dispatch_held","No settled, permitted product for a correction author");
	if(run.testRepairs?.some(j=>j.stop===check && !["product","unobserved","held"].includes(j.state)))
		fail("dispatch_held","The original observer has a calibration or certified recheck; wait for its evidence");
	const checkpoint=signed(run,p.check,verify),goal=signed(run,g.check,verify),stop=signed(run,check,verify);
	if(checkpoint.kind!=="product" || checkpoint.commit!==p.commit || checkpoint.receipt?.exit!==0 || goal.kind!=="goal" || goal.commit!==p.commit ||
		![1,2].includes(goal.receipt?.exit??-1))fail("missing_receipt","Need the exact passing checkpoint and its settled unmet or missing goal");
	const pin=run.productRepins?.at(-1),basis=j && adoptedStop(run,tip,j.check),parent=j && rolloutChain(run,j.check)?.at(-1);
	const rolled=basis && pin?.amendments?.some(s=>s.harness && s.recheck===basis.originalCheck);
	const previous=j && replacementChecks(run,j.check).at(-1);
	const grain=parent?stop.grain:basis?.grain;
	let assembly,product,paths=req.files;
	if(evaluator){
		if(automatic || check!==g.check || j || !currentEvaluation(run,goal) || p.target!==tip || g.target!==tip ||
			(evaluator!==run.policy.goalCheck && evaluator!==run.policy.productCheck))fail("stale_pin","Select the declared evaluator on its current checked product and signed goal");
		assembly=(evaluator===run.policy.goalCheck?run.repins?.at(-1)?.revision:productPin(run))??run.policy.base;product=p.commit;paths??=[evaluator];
	}else{
		if(!basis || !grain || !Object.hasOwn(basis.join.outputs,grain) || stoppedDraftCheck(run)!==check ||
			correctionEvaluator(basis.pin,basis.originalCheck)!==basis.evaluator || parent && (parent.assembly!==stop.commit || !currentRollout(run,stop)))
			fail("stale_pin","No eligible signed adopted component failure at this exact assembly and evaluator pin");
		if(previous){
			if(rolled || !replacementStop(run,previous) || ![0,1].includes(previous.receipt?.exit??-1))
				fail("dispatch_held","The previous owned correction is outstanding, unobserved, or the spent final rollout correction");
			signed(run,previous.id,verify);
		}
		const cut=parent && stoppedBatch(run,parent,check,false);
		if(run.effects.some(e=>awaitingReply(e) || unissued(e) && current(run,e) && !(cut && e.kind==="component" && cut.includes(e))) ||
			run.inspections?.some(i=>["ready","issued"].includes(i.state)))fail("dispatch_held","Wait for the already issued work on this assembly");
		assembly=product=text(stop.commit,"signed stopped assembly");
		if(!paths){
			const scope=grant(run.nodes[grain]);
			paths=entries(cwd,assembly,true,[...scope.directories,...scope.files]).filter(e=>within(scope,e.name)).map(e=>e.name);
		}
	}
	if(!paths.length || new Set(paths).size!==paths.length)fail("invalid_scope","An exact nonempty file list without duplicates is required");
	const names=paths.map(p=>relative(p).normalize("NFC").toLowerCase()+"/").sort();
	if(names.some((p,i)=>i && p.startsWith(names[i-1])))fail("invalid_scope","Case-aliased or nested files cannot form a disjoint source list");
	const all=Object.entries(run.nodes),included=j?Object.keys(j.outputs):[],effectiveChecks=checkerPaths(run);
	const rows=new Map(entries(cwd,assembly,false,paths).map(e=>[e.name,e]));
	/** @type {Map<string,Part>} */ const groups=new Map();
	/** @type {Map<string,Source>} */ const known=new Map();
	for(const file of [...paths].map(relative).sort()){
		if(protectedDraftPath(run,file,pin,evaluator))fail("protected_path",`Conserved or protected path: ${file}`);
		const row=rows.get(file);
		if(row && (row.type!=="blob" || !["100644","100755"].includes(row.mode)))fail("invalid_scope",`Not a regular file: ${file}`);
		if(!row){
			if(automatic)fail("invalid_scope",`No existing preimage for ${file}`);
			const dir=file.split("/").slice(0,-1).join("/");if(dir)checkDirectory(cwd,assembly,dir);
		}
		const owners=included.filter(id=>within(grant(run.nodes[id]),file));
		if(owners.length>1 || all.some(([id,n])=>!included.includes(id) && (working(n) || n.state==="waiting" || n.state==="published" || n.retained || n.restoration) &&
			within(grant(n),file)))fail("ownership_transition",`Overlapping or outstanding ownership for ${file}`);
		/** @type {Source} */ let source;
		if(evaluator){
			source={kind:"evaluator",grant:evaluator};
		}else if(file.startsWith(".foundry/")){
			if(automatic || rolled)fail("protected_path",`Separate exact harness authority required for ${file}`);
			source={kind:"harness",grant:effectiveChecks.find(c=>file===c || contains(c+".d",file))??file};
		}else if(owners.length && j){
			const id=owners[0],n=run.nodes[id];
			if((automatic || rolled) && grain!==id)fail("patch_scope",`The failed component does not own ${file}`);
			const c=run.effects.find(e=>e.id===n.check),output=j.outputs[id];
			if(n.candidate!==output || !["published","qualified"].includes(n.state) || c?.kind!=="component" || c.check!==n.grain.check ||
				(c.runnerClaim ? !publishedComponent(run,c.id,id,output) : !corroborated(run,j,p.check,id,c,grant(n))) ||
				j.ownership && digest(j.ownership[id])!==digest(grant(n)) || changedFiles(cwd,output,j.commit,[file]).length)
				fail("missing_grant",`The exact included output, file and component do not agree for ${id}:${file}`);
			if(!c.runnerClaim && changedFiles(cwd,output,p.commit,[file]).length)fail("missing_receipt",`Checkpoint does not corroborate ${id}:${file}`);
			let s=known.get(id);
			if(!s){
				if(c.runnerClaim)verify(c);
				const basis=patchSource(run,n,true);for(const witness of basis.witnesses)signed(run,witness,verify);
				const producer=originalProducer(run,id,c);
				s={kind:"owned",grain:id,output,component:c.id,grant:basis.source,...(producer && {producer})};known.set(id,s);
			}
			source=s;
		}else{
			if(!j || !grain || automatic || rolled || !row)fail("missing_grant",`No proven existing inherited file or included owner for ${file}`);
			const basis=patchSource(run,run.nodes[grain],true);
			if(!covers(basis.areas,file) || !outside(file,run.policy.files) || changedFiles(cwd,p.target,tip,[file]).length ||
				changedFiles(cwd,p.commit,pin?.amendments?.[0]?.prior.commit??j.commit,[file]).length)
				fail("patch_scope",`No unchanged inherited preimage within the failing charter for ${file}`);
			for(const witness of basis.witnesses)signed(run,witness,verify);
			source={kind:"inherited",grant:basis.source};
		}
		const key=digest(source);/** @type {Part} */ const part=groups.get(key)??{source,state:"ready",files:[]};
		part.files.push({file,before:row?.oid??null,mode:row?.mode??"100644"});groups.set(key,part);
	}
	const data={check,checkpoint:p.check,goal:g.check,target:tip,product,assembly,automatic,...(evaluator && {evaluator}),...(previous && {previousCheck:previous.id}),parts:[...groups.values()]};
	return {...data,id:draftId(data)};
}
/** @param {Run} run @param {Draft} draft */
export function draftBudget(run,draft){
	const left=remainingAssignments(run);
	if(left<draft.parts.length)fail("assignment_limit",`These ${draft.parts.length} disjoint proposal authors need assignments; only ${left} remain. No additional source was authorized.`);
}
/** @param {string} cwd @param {Run} run @param {Draft} d @param {Verify} verify */
export function verifyDraft(cwd,run,d,verify){
	const live=draftScope(cwd,run,{check:d.check,evaluator:d.evaluator,automatic:d.automatic,
		...(d.automatic?{}:{files:d.parts.flatMap(p=>p.files.map(f=>f.file))})},verify);
	if(live.id!==d.id)fail("stale_pin","The frozen source, ownership, or signed observation changed before draft delivery");
}
/** @param {string} cwd @param {Run} run @param {Draft} d @param {Part} p */
export function authorPacket(cwd,run,d,p){
	const read=(/** @type {string} */ pin,/** @type {string} */ f)=>{
		return safeEvidence(f,committedFile(cwd,pin,f));
	};
	const stop=run.effects.find(e=>e.id===d.check),s=p.source,
		observed=s.kind==="owned" && s.grain?run.nodes[s.grain]:undefined;
	const observation=stop?.kind==="product"?stop.receipt?.components?.[failedComponent(stop)??""]:undefined;
	const actual=observation??stop?.receipt,checker=d.evaluator??actual?.check??stop?.check,test=d.evaluator?undefined:actual?.inputs?.checker.blob??actual?.test;
	const measured=test && checker?git(cwd,["cat-file","blob",test]):undefined;
	const files=p.files.map(f=>({...f,text:f.before===null?null:read(d.assembly,f.file)}));
	const previous=d.previousCheck?run.effects.find(e=>e.id===d.previousCheck):undefined;
	const earlier=previous?.commit && previous.kind==="component"?{check:previous.id,commit:previous.commit,exit:previous.receipt?.exit,
		diagnostic:previous.receipt?.output,review:run.inspections?.find(i=>i.component===previous.id)?.summary,
		files:(changeOffer(run,previous)?.patch?.files??[]).filter(f=>files.some(x=>x.file===f.file)).map(f=>({...f,text:read(text(previous.commit,"previous candidate"),f.file)}))}:undefined;
	const packet={subject:partId(d,p),check:d.check,assembly:d.assembly,product:d.product,source:s,files,
		...(earlier && {previous:earlier}),
		direction:run.policy.direction,...(run.productRepins?.at(-1)?.acceptance && {acceptance:run.productRepins.at(-1)?.acceptance}),
		...(observed && {task:observed.grain.task??read(d.assembly,observed.grain.specification)}),
		...(run.policy.sharedBrief && {requirements:read(d.assembly,run.policy.sharedBrief)}),
		...(checker && {observer:{file:checker,text:measured?safeEvidence(checker,measured):read(d.assembly,checker)}}),diagnostic:stop?.receipt?.output};
	safeEvidence("correction-packet",JSON.stringify(packet));return packet;
}
/** @param {string} cwd @param {Draft} d @param {Part} p @param {unknown} input */
export function acceptAuthor(cwd,d,p,input){
	const answer=record(input);fields(answer,["subject","reason","edits"]);
	const reason=text(answer.reason,"author result");safeEvidence("author-result",reason);
	if(answer.subject!==partId(d,p) || !Array.isArray(answer.edits))fail("wrong_workflow","The native result is not for this frozen source");
	if(!answer.edits.length)fail("missing_evidence",reason);
	const seen=new Set();
	const changes=answer.edits.map(edit=>{
		const row=record(edit);fields(row,["file","before","text"]);const file=relative(row.file),f=p.files.find(f=>f.file===file);
		if(!f || row.before!==f.before || seen.has(file))fail("patch_scope",`Wrong source, duplicate path or mismatched preimage: ${file}`);
		seen.add(file);const body=row.text;
		if(body!==null && (typeof body!=="string" || body.includes("\0") || Buffer.from(body).toString()!==body))fail("invalid_patch",`Not exact UTF-8 text: ${file}`);
		const result=body===null?null:git(cwd,["hash-object","-w","--stdin"],safeEvidence(file,body)).toString().trim();
		if(result===f.before)fail("unchanged_candidate",`No effective change to ${file}`);return {...f,result};
	});
	const complete=d.parts.every(q=>q===p || q.state==="returned");
	let blob;
	if(complete){
		const all=[...draftChanges(d),...changes].sort((a,b)=>a.file<b.file?-1:1),bytes=draftDiff(cwd,d.assembly,all);
		blob=git(cwd,["hash-object","-w","--stdin"],bytes).toString().trim();
		const actual=exactPatch(cwd,d.assembly,d.assembly,blob).files;
		if(digest(all)!==digest(actual))fail("patch_scope","The effective diff differs from the disjoint verified author results");
		retain(cwd,blob);
	}
	for(const f of changes)if(f.result)retain(cwd,f.result);
	movePart(p,"return",{changes,reason});if(blob)d.blob=blob;
}
/** @param {Run} run */
export function authorEvidence(run){
	const check=stoppedDraftCheck(run);
	if(!check)return;
	const stop=run.effects.find(e=>e.id===check),grain=stop?.kind==="component"?stop.grain:failedComponent(stop);
	const previous=replacementChecks(run,check).at(-1),source=grain && run.nodes[grain];
	return {signal:/** @type {const} */ ("correction"),facts:{includedProducer:!!grain && !!run.join?.outputs[grain],unclaimedSource:
		!run.correctionDrafts?.some(d=>d.check===check && d.previousCheck===previous?.id) &&
		!run.adoptions?.some(a=>a.failed===check && a.assembly && !(previous && a.patch?.owner && a.decision?.status==="answered"))},attempt:previous?.id??check,args:{check},
		grant:source?digest([source.check,source.candidate,source.review??null,source.restoration??null,grant(source),source.inputs??null]):null};
}
/** @type {import("./grants.mjs").Prepare} */
export function prepareAutomaticDraft(cwd,run,actor,a,verify){
	fields(a,["run","check"]);if(actor!==run.owner)fail("foreign_run","Only the owner schedules a bounded correction author");
	const check=name(a.check,"signed stop"),req={check,automatic:true};
	/** @param {Run} live */
	const select=live=>{
		const d=draftScope(cwd,live,req,verify);
		if(live.correctionDrafts?.some(v=>v.id===d.id))return d;
		const evidence=authorEvidence(live);
		if(evidence?.args.check!==check || !evidence.facts.includedProducer || !evidence.facts.unclaimedSource)
			fail("dispatch_held","An exact correction or previous decision already exists on this stop");
		const offers=offerChoices(cwd,live,actor,verify);
		if(offers?.selected || offers?.conflict)fail("dispatch_held","Select the already offered correction; another author cannot decide between existing bytes.");
		draftBudget(live,d);return d;
	};
	const expected=select(run);
	return {consent:"satisfied",prompt:"Send the signed stop directly to its frozen included source.",apply(live){
		const d=select(live);
		if(d.id!==expected.id)fail("stale_pin","The correction-source grant changed");
		if(!live.correctionDrafts?.some(v=>v.id===d.id))(live.correctionDrafts??=[]).push(d);
		return ()=>commitAt(cwd,live.policy.target)===d.target;
	}};
}
