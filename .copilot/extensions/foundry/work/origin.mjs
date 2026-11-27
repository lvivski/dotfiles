import { hash, oid, validName } from "../../../skills/foundry/scripts/recipe.mjs";
import { grantedComponent, publishedComponent } from "./publication.mjs";
import { checkReceipt, sameEvaluation, signedFact } from "./receipt.mjs";
import { effectAt, inspectionAt } from "./revision.mjs";
import { topology } from "./topology.mjs";
import { comparisonScope, contains, covers, digest, fail, ownership, roots, sameScope } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Call */
/** @typedef {import("./model.js").Review} Review */
/** @typedef {{squad:import("./model.js").Squad,output:string|import("./model.js").Proposal,witnesses?:import("./model.js").CurrentAttempt["facts"]}} Assignment */
/** @typedef {Omit<NonNullable<Call["writing"]>,"version">} Terms */
/** @typedef {Map<string,{review?:import("./model.js").Review;grain:import("./model.js").Grain;terms:Terms}>} PriorWriters */
/** @typedef {Map<string,NonNullable<ReturnType<typeof submittedWriter>>>} PriorPublications */
/** @param {import("./model.js").Area} squad @param {import("./model.js").Scope} scope */
export const owns=(squad,scope)=>roots(scope).every(p=>covers(squad.areas,p));
/** @param {import("./model.js").Effect|undefined} w */
export const generationOf=w=>w?.kind==="writer"?w.pooled?.generation??w.args.base_branch:undefined;

/** A retry has its own workflow and packet, but its routing evidence belongs to the original.
 * @param {Run} run @param {Review} review */
export function evidenceOrigin(run, review) {
	if (!review.retryOf) return review;
	const original = effectAt(run,review.retryOf);
	if (original?.kind !== "scout" || original.retryOf || run.effects.indexOf(original) >= run.effects.indexOf(review))
		fail("corrupt_run", "Missing original scout review");
	return original;
}

/** @param {Run} run @param {Review} r */
export const wakeSource = (run, r) => {
	const wake=r.wake,p=wake && effectAt(run,wake.review);
	return p?.kind==="scout" && p.squad===r.squad && sameEvaluation(p,r) &&
		(wake?.key==="released-inputs"?p.state==="deferred":p.base===r.base) ? p : undefined;
};

/** Evidence pages continue the same comparison, but an ordinary later review does not.
 * @param {Run} run @param {Review|undefined} review */
export function comparisonReview(run, review) {
	let r = review && evidenceOrigin(run, review);
	while (r && !r.iteration && r.wake) {
		const prev = wakeSource(run, r);
		if (!prev || prev.observation?.outcome !== "needs-evidence" || prev.base !== r.base ||
			prev.version !== r.version || !sameEvaluation(prev,r) || run.effects.indexOf(prev) >= run.effects.indexOf(r)) return;
		r = evidenceOrigin(run, prev);
	}
	return r?.iteration ? r : undefined;
}
/** @param {Run} run @param {Review|undefined} review */
export const comparison = (run, review) => comparisonReview(run, review)?.iteration;

/** @param {Run} run @param {Review} review */
export function taskBasis(run,review){
	const g=review.observation?.grains[0],i=comparison(run,review);
	if(typeof g!=="object")return;
	if(i && sameScope(comparisonScope(i),g.directory) && run.artifacts?.some(a=>a.blob===i.blob && a.to.some(d=>contains(d,i.directory))))
		return {blob:i.blob};
	if(!i && !review.predecessor && typeof g.directory==="string" && !review.observation?.replace?.length)return {ordinary:/** @type {const} */(true)};
}

/** Remove one literal clause from the original proposal, never supply replacement instructions.
 * @param {import("./model.js").Review} review @param {string} grain @param {string} clause */
export function revisedTask(review,grain,clause){
	const report=review.observation,g=report?.grains[0];
	if(!clause || review.state!=="observed" || report?.outcome!=="regenerate" || report.grains.length!==1 ||
		typeof g!=="object" || g.id!==grain)return;
	const at=g.task.indexOf(clause);
	if(at<0 || g.task.indexOf(clause,at+1)>=0)return;
	const task=g.task.slice(0,at)+g.task.slice(at+clause.length);
	if(task.trim())return task;
}

/** The launch terms never change. Only the bound worker can use an approved
 * subtraction from its original task; this conveys no new read or write scope.
 * @param {Run} run @param {import("./model.js").Grain} grain @param {Call} w @param {Review} [review] */
export function submissionTerms(run,grain,w,review){
	const c=review?.correction;
	if(!review || !c)return grain;
	const original=review.observation?.grains[0],task=revisedTask(review,grain.id,c.clause),basis=taskBasis(run,review);
	if(!task || typeof original!=="object" || original.task!==grain.task || c.worker!==w.nativeId ||
		!basis || c.predecessorCheck || c.ordinary!==basis.ordinary || c.blob!==basis.blob)return;
	return {...grain,task};
}

/** A named dynamic output is a reference to a checked definition, not permission
 * to use whichever node happens to have that name today. Every backward step
 * ends before the selecting review, even when that producer was itself restaffed.
 * @param {Run} run @param {Review} r @param {import("./model.js").Area} squad @param {string} id @returns {Assignment|undefined} */
function namedGrant(run,r,squad,id){
	const packet=r.packet,at=run.effects.indexOf(r);
	if(!packet || packet.review!==r.id || packet.base!==r.base || !Object.hasOwn(packet.outputs,id) || !oid(packet.outputs[id]))return;
	const pin=packet.outputs[id],p=run.products.findLast(p=>{
		const check=effectAt(run,p.check);return p.commit===r.base && check && run.effects.indexOf(check)<at;
	}),joined=effectAt(run,p?.check);
	if(p?.outputs[id]!==pin || joined?.kind!=="product" || joined.attempt?.version!==3 || joined.evaluatorRevision!==r.productEvaluatorRevision)return;
	const checkpoint=signedFact(run,at,joined,"product",r.base),facts=joined.attempt.facts;
	const members=facts.flatMap(f=>{
		if(f.kind!=="signed" || f.use!=="component" || f.exit!==0 || f.commit!==pin)return [];
		const c=effectAt(run,f.check);return c?.kind==="component" && c.grain===id?[c]:[];
	});
	const c=members[0];
	if(checkpoint?.exit!==0 || members.length!==1)return;
	const component=signedFact(run,run.effects.indexOf(joined),c,"component",pin),i=inspectionAt(run,c.id);
	const review=facts.find(f=>f.kind==="review" && f.component===c.id);
	if(component?.exit!==0 || !i || review?.kind!=="review" || review.inspection!==i.id || review.workflow!==i.workflow || review.dispatch!==i.dispatch ||
		!grantedComponent(run,id,{component:c.id,revision:pin,review:i.id}))return;
	const previous=recordedSubmission(run,c);
	if(!previous || previous.review?.squad!==squad.id || !reviewedWriter(run,i,previous) || !previous.grain.task ||
		!owns(squad,previous.grain.directory) || !squad.checks.includes(previous.grain.check))return;
	return {squad,output:{...previous.grain,task:previous.grain.task},witnesses:[checkpoint,component,review]};
}

/** @param {Run} run @param {import("./model.js").Effect} review @param {string} grain @returns {Assignment|undefined} */
export function assigningGrant(run,review,grain){
	if(review.kind!=="scout" || review.state!=="observed" || review.observation?.outcome!=="regenerate")return;
	const squad=run.policy.squads.find(s=>s.id===review.squad);
	const output=review.observation.grains.find(g=>(typeof g==="string"?g:g.id)===grain);
	if(squad && output && (typeof output==="string" ? "grains" in squad && squad.grains.includes(output) :
		"areas" in squad && owns(squad,output.directory) && squad.checks.includes(output.check)))return {squad,output};
	if(squad && "areas" in squad && typeof output==="string")return namedGrant(run,review,squad,output);
}

/** @param {Run} run @param {Call} e @param {(id:string)=>import("./model.js").Effect|undefined} lookup */
export function poolSource(run,e,lookup=id=>effectAt(run,id)){
	const src=e.pooled && lookup(e.pooled.from);
	if(e.kind!=="writer" || !e.token || !e.grain || e.claims || e.reuse || typeof e.args.message!=="string" ||
		src?.kind!=="writer" || !src.finished || !src.nativeId)return;
	const product=lookup(src.finished.product),recipient=e.tool==="send_session_message"?e.args.session_id:e.tool==="session.send"?e.issuer:undefined;
	if(product?.kind==="product" && run.effects.indexOf(product)<run.effects.indexOf(e) && recipient===src.nativeId &&
		(e.state==="done"?e.nativeId===src.nativeId:!e.nativeId))return src;
}

export const writerKeys=new Set(["id","kind","tool","issuer","args","grain","state","callId","permissionHold","error",
	"token","nativeId","boundAt","pooled","finished","claims","claimedRequest","readGrant"]);
/** @param {Run} r @param {Call} w */
export const writerOriginId=(r,w)=>digest(["foundry-writer-origin/v3",r.id,w.id,w.token,w.issuer,w.callId,w.nativeId,generationOf(w),w.writing]);

/** @param {Run} run @param {import("./model.js").Node} n */
export function seeded(run,n){
	return run.policy.seed && !run.policy.goalCheck && !n.review && n.grain.task===undefined &&
		topology(id=>run.nodes[id]?.grain.needs).upstream(run.policy.seed).has(n.grain.id);
}

/** A fixed-plan scout can request a declared root together with its already
 * committed dependencies. It cannot create new grains in another charter.
 * @param {Run} run @param {import("./model.js").Review|undefined} review @param {import("./model.js").Node} n */
export function fixedDependency(run,review,n){
	const squad=review && run.policy.squads.find(s=>s.id===review.squad),o=review?.observation;
	if(n.grain.task!==undefined || !squad || !("grains" in squad) || review?.state!=="observed" || o?.outcome!=="regenerate" ||
		!o.grains.every((g)=>typeof g==="string" && squad.grains.includes(g)))return false;
	const roots=o.grains.filter((g)=>typeof g==="string");
	return topology(id=>run.nodes[id]?.grain.needs).upstream(roots).has(n.grain.id);
}

/** Resolve the charter at the launch, not at the latest graph revision.
 * Each direct producer contributes its *own already-granted versions* to the
 * transitive closure. An extra checked directory is not a granted input.
 * @param {Run} run @param {Call} w @param {PriorWriters} [prior] */
export function declaredWriter(run,w,prior){
	const d=w.writing,r=d && effectAt(run,d.source?.review),at=run.effects.indexOf(w);
	if(w.kind!=="writer" || !d || d.version!==3 || Object.keys(d).length!==5 || !oid(d.base) || !hash(d.terms) ||
		!d.source || Object.keys(d.source).length!==1 || !w.grain ||
		at<(run.historicalPrefix?.length??0) || !Object.keys(w).every(k=>k==="writing" || writerKeys.has(k)) ||
		!d.inputs || typeof d.inputs!=="object" || Array.isArray(d.inputs))return;
	const n=run.nodes[w.grain],review=r?.kind==="scout" && run.effects.indexOf(r)<at && r.callId && r.workflowId?r:undefined;
	const grant=review && assigningGrant(run,review,w.grain);
	const g=grant?.output??(n && (d.source.seed===run.policy.base && seeded(run,n) || fixedDependency(run,review,n))?n.grain.id:undefined),squad=grant?.squad;
	const grain=typeof g==="string"?n?.grain:g && squad && "areas" in squad?{...g,specification:squad.charter,boundary:squad.boundary,...(squad.agent && {agent:squad.agent})}:undefined;
	if(!grain || d.terms!==digest(grain) || grain.id!==w.grain)return;
	const expected=new Set(grain.needs);
	for(const id of grain.needs){
		const p=d.inputs[id],c=p && effectAt(run,p.component);
		const a=c?.kind==="component" && c.attempt?.version===3 && c.attempt.source;
		const donor=a && a.kind==="writer" && effectAt(run,a.id);
		if(!donor || donor.kind!=="writer" || c?.issuer!==donor.nativeId || donor.grain!==id || run.effects.indexOf(donor)>=run.effects.indexOf(c))return;
		const terms=donor.writing??prior?.get(donor.id)?.terms;if(!terms)return;
		for(const [ancestor,version] of Object.entries(terms.inputs)){
			if(!d.inputs[ancestor] || digest(d.inputs[ancestor])!==digest(version))return;
			expected.add(ancestor);
		}
	}
	if(expected.size!==Object.keys(d.inputs).length)return;
	for(const [id,p] of Object.entries(d.inputs)){
		if(!expected.has(id) || !p || Object.keys(p).length!==3 || !validName(id) || !oid(p.revision) || !validName(p.component))return;
		const component=grantedComponent(run,id,p);
		if(!component || run.effects.indexOf(component)>=at)return;
	}
	if(g)return {review,output:g,grain,witnesses:grant?.witnesses};
}

/** Current access and historical producer identity are different decisions.
 * @param {NonNullable<ReturnType<typeof submittedWriter>>} w @param {import("./model.js").Node} n */
export function occupies(w,n){
	return n.worker===w.worker && n.review===w.terms.source.review && n.token===w.token && n.base===w.terms.base && n.generation===w.generation &&
		digest(n.grain)===digest(w.grain) && digest(n.inputs??{})===digest(Object.fromEntries(Object.entries(w.terms.inputs).map(([id,p])=>[id,p.revision])));
}

/** @param {Run} run @param {import("./model.js").Effect|undefined} w */
export function confirmedWriter(run,w){
	if(w?.kind!=="writer" || w.state!=="done" || !w.grain || !w.token || !w.callId || !w.nativeId || w.error || w.nativeId===run.owner ||
		(w.pooled?!poolSource(run,w):w.tool!=="create_session"))return;
	const generation=generationOf(w);
	if(typeof generation==="string")return {writer:w,worker:w.nativeId,generation,at:run.effects.indexOf(w)};
}

/** Only a confirmed delivery to this writer, or its own checked inline repair,
 * can renew a token. Resolve it at the consumer's original journal position.
 * @param {Run["effects"]} history @param {import("./model.js").Effect} w @param {(token:string)=>boolean} matches
 * @param {(c:Call)=>boolean} [component] */
export function tokenSource(history,w,matches,component=()=>true){
	const at=history.indexOf(w);
	if(at<0 || w.kind!=="writer" || w.state!=="done" || !w.callId || !w.nativeId || !w.token)return;
	if(matches(w.token))return w;
	for(let i=at+1;i<history.length;i++){
		const e=history[i];if(e.grain!==w.grain)continue;
		if(e.kind==="writer" && e.state!=="withdrawn")break;
		if(e.kind==="repair" && e.state==="done" && e.callId && !e.error && e.token && matches(e.token) &&
			(e.tool==="session.send"?e.issuer:e.tool==="send_session_message"?e.args.session_id:undefined)===w.nativeId)return e;
		if(e.kind==="component" && e.issuer===w.nativeId && e.inlineRepair && matches(e.inlineRepair) && checkReceipt(e) && component(e))return e;
	}
}

/** @param {Run} run @param {Call} e @param {string} token @param {PriorWriters} [prior] */
export function submissionGrant(run,e,token,prior){
	const history=run.effects.slice(0,run.effects.indexOf(e)),origins=[];
	for(const w of history){
		if(w.kind!=="writer" || w.grain!==e.grain || w.nativeId!==e.issuer || !confirmedWriter(run,w) ||
			!(w.writing?declaredWriter(run,w,prior):prior?.has(w.id)))continue;
		const source=tokenSource(history,w,t=>t===token);
		if(source)origins.push({kind:/** @type {const} */("writer"),id:w.id,...(source!==w && {renewed:source.id})});
	}
	if(origins.length===1)return origins[0];
}
/** A writer's confirmed submission, independent of whether its result may now
 * be published. The native session, not its reviewer, made the submission.
 * @param {Run} run @param {Call} e @param {string} id @param {string} [renewed] @param {PriorWriters} [prior] */
export function submittedWriter(run,e,id,renewed,prior){
	const w=effectAt(run,id),origin=confirmedWriter(run,w);
	if(!origin || w?.kind!=="writer" || w.grain!==e.grain || origin.worker!==e.issuer || origin.at>=run.effects.indexOf(e))return;
	const renewal=effectAt(run,renewed),token=renewal?.kind==="repair"?renewal.token:renewal?.kind==="component"?renewal.inlineRepair:w.token;
	if(!token || (renewed!==undefined && (!renewal || renewal===w || tokenSource(run.effects.slice(0,run.effects.indexOf(e)),w,t=>t===token)!==renewal)))return;
	const archived=!w.writing && prior?.get(id),assigned=archived || declaredWriter(run,w,prior),terms=archived?archived.terms:w.writing;
	const grain=assigned && submissionTerms(run,assigned.grain,w,assigned.review);
	if(terms && grain && assigned && e.check===grain.check)return {...origin,terms,grain,token,renewal,review:assigned.review,
		witnesses:"witnesses" in assigned?assigned.witnesses:undefined};
}

/** Keep the origin bytes identical at reservation and whenever that signed
 * submission is used as the source of another grant.
 * @param {Run} run @param {NonNullable<ReturnType<typeof submittedWriter>>} w @returns {import("./model.js").CurrentAttempt["facts"]} */
export function writerEvidence(run,w){
	const original=writerOriginId(run,w.writer),launch=w.writer.writing?original:digest(["original-writer",original,w.terms]);
	/** @type {import("./model.js").CurrentAttempt["facts"]} */ const facts=[{kind:"writer",assignment:w.writer.id,
		origin:w.review?.correction?digest([launch,w.review.id,w.review.correction]):launch},...w.witnesses??[]];
	const grant=w.renewal;
	if(grant)facts.push({kind:"writer",assignment:grant.id,origin:digest([w.writer.id,grant.id,grant.issuer,grant.callId,grant.args,w.token])});
	return facts;
}
/** @param {Run} run @param {Call} c @param {PriorWriters} [prior] @returns {ReturnType<typeof submittedWriter>} */
function recordedSubmission(run,c,prior){
	const a=c.attempt;
	if(a?.version!==3 || a.source.kind!=="writer")return;
	const w=submittedWriter(run,c,a.source.id,a.source.renewed,prior);
	if(!w)return;
	const expected=writerEvidence(run,w);
	if(digest(a.facts.slice(0,expected.length))===digest(expected))return w;
}

/** @param {Run} run @param {import("./model.js").Inspection} i @param {NonNullable<ReturnType<typeof submittedWriter>>} w */
function reviewedWriter(run,i,w){
	return i.workflow && i.dispatch && i.base===w.terms.base && i.generation===w.generation && digest(i.scope)===digest(ownership(w.grain.directory)) &&
		i.task===(w.grain.task??run.policy.direction) && i.specification===(w.grain.task===undefined?w.grain.specification:undefined);
}

/** One positive publication for consumers and joins. An old run's original
 * exemption is not a review; powers that require a review must name it.
 * @param {Run} run @param {string} component @param {string} grain @param {string} revision @param {PriorWriters} [prior] @param {PriorPublications} [published] */
export function writerPublication(run,component,grain,revision,prior,published){
	const p=publishedComponent(run,component,grain,revision),c=p?.component,i=p?.review;
	if(!c)return;
	const writer=c.attempt?.version===3?recordedSubmission(run,c,prior):published?.get(component);
	if(!writer)return;
	if(!i && run.inspections===undefined && run.historicalPrefix?.length)return {writer,inspection:undefined,component:c,receipt:p.receipt};
	if(i && reviewedWriter(run,i,writer))
		return {writer,inspection:i,component:c,receipt:p.receipt};
}
