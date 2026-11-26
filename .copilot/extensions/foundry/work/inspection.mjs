import { randomUUID } from "node:crypto";
import { deliveryInspection } from "./batch.mjs";
import { checkReceipt } from "./evidence.mjs";
import { guard, machine, to, transition, update } from "./machine.mjs";
import { changedFiles } from "./product.mjs";
import { publicationVerdict } from "./publication.mjs";
import { remedyInspection } from "./remedy.mjs";
import { grant } from "./transfer.mjs";
import { contains, digest, fail, fields, record, text } from "./values.mjs";

/** @typedef {import("./model.js").Inspection} Inspection */
/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {Pick<Inspection,"issuer"|"dispatch"|"workflow"|"summary"|"previous">} Context */
/** @typedef {Omit<Context,"issuer">} Data */
/** @typedef {Pick<Inspection,"base"|"generation"|"scope"|"task"|"specification">} Basis */
/** @param {Run} run @param {import("./model.js").Node} node @param {Check} c @param {Partial<Basis>} overrides @returns {Basis} */
function basis(run,node,c,overrides){
	const task=node.grain.task??run.policy.direction;
	return {base:text(overrides.base??(c.observer ? node.generation : node.base),"reviewed base"),
		generation:text(overrides.generation??node.generation,"reviewed generation"),scope:overrides.scope??(c.observer ? {directories:[],files:[c.observer.file]} : grant(node)),
		...(node.grain.task===undefined && !c.remedy && !c.delivery && !c.observer && {specification:node.grain.specification}),
		task:overrides.task??(c.observer ? `${task} Review only the approved observer change to ${c.observer.file}; it must preserve assertions and tolerances.` : task)};
}
const issue=update("claim-review",(/** @type {Context} */ c,/** @type {Data} */ e)=>({
	issuer:c.issuer,...(c.previous && {previous:c.previous}),dispatch:text(e.dispatch,"review dispatch"),
}));
const bind=update("bind-workflow",(/** @type {Context} */ {summary,...c},/** @type {Data} */ e)=>({
	...c,workflow:text(e.workflow,"bound review workflow"),
}));
const verdict=update("record-review",(/** @type {Context} */ c,/** @type {Data} */ e)=>({...c,summary:text(e.summary,"review finding or conclusion")}));
const ready=update("release-unstarted-review",(/** @type {Context} */ c)=>({issuer:c.issuer,...(c.previous && {previous:c.previous})}));
const retry=update("retain-unavailable-review",(/** @type {Context} */ c,/** @type {{issuer:string}} */ e)=>({
	issuer:text(e.issuer,"next issuer"),previous:[...c.previous??[],{issuer:c.issuer,dispatch:text(c.dispatch,"original dispatch"),
		workflow:text(c.workflow,"terminal review workflow"),summary:text(c.summary,"original diagnostic")}],
}));
const bound=guard("bound",(/** @type {Context} */ c)=>!!c.dispatch && !!c.workflow);
export const inspection=machine("inspection","ready",{
	ready:[{...to("issue","issued","Claim this exact candidate before starting its independent review."),...issue},
		{...to("resume","ready","The owner may take an unissued review after checking permission, never another issuer's hold or ticket."),
			...guard("unticketed",(/** @type {Context} */ c)=>!c.dispatch && !c.workflow),when:["transferable","unticketed"],
			...update("transfer-unissued-review",(/** @type {Context} */ c,/** @type {{issuer:string}} */ e)=>({...c,issuer:text(e.issuer,"resuming owner")}))}],
	issued:[
		{...to("bind","issued","Bind the original native workflow; a second identity cannot replace it."),
			...guard("sameWorkflow",(/** @type {Context} */ c,/** @type {Context} */ e)=>!!c.dispatch && (!c.workflow || c.workflow===e.workflow)),...bind},
		{...to("capacity","ready","The host confirmed no workflow was admitted; retain the review for an available slot."),
			...guard("unbound",(/** @type {Context} */ c)=>!!c.dispatch && !c.workflow),...ready},
		{...to("approved","approved","Record the bound reviewer's approval for these bytes."),...bound,...verdict},
		{...to("changes","changes","Return the bound reviewer's blocking findings to this assignment."),...bound,...verdict},
		{...to("unavailable","unavailable","Record why the bound workflow could not return a usable review; keep the candidate unpublished."),...bound,...verdict},
	],
	unavailable:[{...to("resume","ready","On explicit resume, retain the bound unavailable attempt before reviewing the same pins again."),...bound,...retry}],
	approved:[],changes:[],
},{description:"Records one independent Rubber Duck code review of an immutable component candidate.",states:{
	ready:"A component passed; no review has been issued for this candidate.",
	issued:"Only the original dispatch may bind or return a review; missing history is not a verdict.",
	approved:"This review found no blocking issue. Other component, product and goal checks still apply.",
	changes:"This exact candidate has blocking findings and cannot be consumed.",
	unavailable:"No usable review was obtained. This is not a code defect or permission to publish.",
}});

/** @param {Inspection} i */
const snapshot=({state:value,issuer,dispatch,workflow,summary,previous})=>({value,context:{issuer,dispatch,workflow,summary,previous}});
/** @param {Inspection} i @param {{value:Inspection["state"],context:Context}} next */
function apply(i,{value,context:next}){
	i.state=value;i.issuer=next.issuer;
	for(const k of /** @type {const} */(["dispatch","workflow","summary","previous"])){
		if(next[k]===undefined)delete i[k];else Object.assign(i,{[k]:next[k]});
	}
}
/** @param {Inspection} i @param {"issue"|"bind"|"approved"|"changes"|"unavailable"|"capacity"} signal @param {Data} [data] */
export function markInspection(i,signal,data={}){
	apply(i,transition(inspection,snapshot(i),{type:signal,...data},{},true).snapshot);
}

/** Project the same resume rule before and after the permission read. Uncertain starts have no such edge.
 * @param {Run} run @param {Inspection} i @param {boolean} canReceive */
export function inspectionResume(run,i,canReceive){
	const transferable=canReceive && i.issuer!==run.owner && !i.permissionHold && run.policyHold?.issuer!==i.issuer &&
		!run.effects.some(e=>e.issuer===i.issuer && e.permissionHold);
	const result=transition(inspection,snapshot(i),{type:"resume",issuer:transferable ? run.owner : i.issuer},
		{transferable});
	if(result.edge)return ()=>apply(i,result.snapshot);
}

/** A new commit ID or changed excluded bytes cannot clear a finding on the same inputs.
 * @param {string} cwd @param {Run} run @param {import("./model.js").Node} node @param {string} candidate */
export function requireChangedReview(cwd,run,node,candidate){
	/** @type {Inspection["scope"]} */ const scope=grant(node);
	for(const i of run.inspections??[]){
		if(i.state!=="changes" || i.grain!==node.grain.id || i.base!==node.base || i.generation!==node.generation || digest(scope)!==digest(i.scope))continue;
		const changed=i.candidate!==candidate && changedFiles(cwd,i.candidate,candidate,[...scope.directories,...scope.files])
			.some(f=>!scope.exclude?.files.includes(f) && !scope.exclude?.directories.some(d=>contains(d,f)));
		if(!changed)fail("unchanged_candidate",`Rubber Duck requested changes on ${i.candidate}; change the assigned output before submitting: ${i.summary}`);
	}
}

/** @param {unknown} raw @returns {{outcome:"approved"|"changes"|"unavailable",summary:string}} */
export function inspectionResult(raw){
	const value=record(raw);fields(value,["outcome","summary"]);
	const {outcome}=value;
	if(outcome!=="approved" && outcome!=="changes" && outcome!=="unavailable")fail("invalid_review","Expected an independent code review verdict");
	return {outcome,summary:text(value.summary,"review finding or conclusion")};
}

/** Reserve from a private planner snapshot, never by starting a workflow in the transaction.
 * The absence of the list denotes a run activated under its original pre-review contract.
 * @param {Run} run @param {import("./model.js").Node} node @param {Check} c @param {string} issuer @param {Partial<Basis>} [overrides] */
export function inspectComponent(run,node,c,issuer,overrides={}){
	if(!run.inspections)return;
	if(c.kind!=="component" || !c.commit || c.grain!==node.grain.id || c.check!==node.grain.check ||
		issuer!==run.owner && issuer!==c.issuer || !c.runnerClaim || checkReceipt(c)?.exit!==0)
		fail("invalid_review","Review requires this component's passing runner receipt");
	const subject={component:c.id,grain:c.grain,candidate:c.commit,...basis(run,node,c,overrides)};
	const existing=run.inspections.find(i=>i.component===c.id);
	if(existing){
		if(Object.entries(subject).some(([k,v])=>digest(Reflect.get(existing,k))!==digest(v)))fail("stale_inspection","The checked candidate's review inputs changed");
		return existing;
	}
	/** @type {Inspection} */ const i={id:randomUUID(),issuer,...structuredClone(subject),state:"ready"};
	run.inspections.push(i);
	return i;
}

/** Ownership transfers may narrow an already published output, never lend a narrower review to a larger grant.
 * @param {Inspection} i @param {Basis} b @param {boolean} [published] */
function matchesBasis(i,b,published=false){
	if(b.base!==i.base || b.generation!==i.generation || b.task!==i.task || b.specification!==i.specification)return false;
	if(!published || !b.scope.exclude)return digest(b.scope)===digest(i.scope);
	return digest(b.scope.directories)===digest(i.scope.directories) && digest(b.scope.files)===digest(i.scope.files) &&
		(i.scope.exclude?.directories??[]).every(d=>b.scope.exclude?.directories.includes(d)) &&
		(i.scope.exclude?.files??[]).every(f=>b.scope.exclude?.files.includes(f));
}

/** @param {Run} run @param {import("./model.js").Node} node @param {Check} c @param {Inspection} i */
export const reviewedGrant=(run,node,c,i)=>matchesBasis(i,basis(run,node,c,{}),true);

/** @param {Run} run @param {Check} c */
const specialBasis=(run,c)=>c.delivery ? deliveryInspection(run,c) : c.remedy ? remedyInspection(run,c) : undefined;

/** One-shot delivery and paired production share the same gate; only the grant owner decides how to handle a finding.
 * @param {Run} run @param {Check[]} checks @param {(i:Inspection)=>void} onChanges */
export function inspectedBatch(run,checks,onChanges){
	if(!run.inspections)return true;
	for(const c of checks){
		const binding=specialBasis(run,c) ?? fail("stale_assignment","The signed component no longer matches its approved publication grant");
		const i=inspectComponent(run,binding.node,c,run.owner,binding.overrides);
		if(!i || i.issuer!==run.owner)return false;
		const verdict=publicationVerdict(i);
		if(verdict==="changes")onChanges(i);
		if(verdict!=="approved")return false;
	}
	return true;
}

/** @param {Run} run @param {Inspection} i */
export function currentInspection(run,i){
	const c=run.effects.find(e=>e.id===i.component), n=run.nodes[i.grain];
	if(!n || c?.kind!=="component" || c.grain!==i.grain || c.commit!==i.candidate || c.check!==n.grain.check ||
		!c.runnerClaim || checkReceipt(c)?.exit!==0)return false;
	const expected=c.delivery || c.remedy ? specialBasis(run,c) :
		n.state==="reviewing" && n.check===i.component && n.candidate===i.candidate ? {node:n,overrides:{}} : undefined;
	if(!expected)return false;
	return matchesBasis(i,basis(run,expected.node,c,expected.overrides));
}
