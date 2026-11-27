import { inspection } from "./rules/inspection.mjs";
import { randomUUID } from "node:crypto";
import { deliveryInspection } from "./batch.mjs";
import { checkReceipt } from "./evidence.mjs";
import { transition } from "./machine.mjs";
import { changedFiles } from "./product.mjs";
import { publicationVerdict } from "./publication.mjs";
import { remedyInspection } from "./remedy.mjs";
import { replacementInspection } from "./replacement.mjs";
import { rolloutInspection } from "./campaign.mjs";
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
		if(c.rollout && subject.specification && !existing.specification){
			if(existing.state!=="ready" || existing.dispatch || existing.previous?.length)
				fail("stale_inspection",`Review ${existing.id} was issued without the frozen specification. Keep its original evidence; it cannot approve this unpublished replacement.`);
			existing.specification=subject.specification;
		}
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
const specialBasis=(run,c)=>c.delivery ? deliveryInspection(run,c) : c.remedy ? remedyInspection(run,c) : c.replacement ? replacementInspection(run,c) : c.rollout ? rolloutInspection(run,c) : undefined;

/** Progress only the ordered component obligations of an already-authorized grant. A missing
 * member, a failed check, and a bound review finding have different consequences for its owner.
 * @param {Run} run @param {string} assembly @param {string[]} members @param {Check[]} checks
 * @param {(()=>void)|undefined} [validate]
 * @returns {{state:"wait"|"ready"}|{state:"next",index:number}|{state:"failed",check:Check}|{state:"changes",review:Inspection}} */
export function componentBatch(run,assembly,members,checks,validate){
	if(!members.length || checks.length>members.length || new Set(members).size!==members.length ||
		checks.some((c,i)=>c.kind!=="component" || c.grain!==members[i] || c.commit!==assembly || c.check!==run.nodes[members[i]]?.grain.check))
		fail("stale_assignment","A batch observation differs from the approved owners, order, assembly or check");
	if(checks.some(c=>c.state==="issued" || c.state==="uncertain" || c.permissionHold))return {state:"wait"};
	const failed=checks.find(c=>{const r=checkReceipt(c);return c.launcherExit!==undefined || c.state==="refused" || r && r.exit!==0;});
	if(failed)return {state:"failed",check:failed};
	if(run.effects.some(e=>e.permissionHold))return {state:"wait"};
	if(checks.some(c=>!c.callId || !c.runnerClaim || checkReceipt(c)?.exit!==0 || c.receipt?.failure))return {state:"wait"};
	if(checks.length<members.length)return {state:"next",index:checks.length};
	validate?.();
	for(const c of run.inspections===undefined?[]:checks){
		const binding=specialBasis(run,c) ?? fail("stale_assignment","The signed component no longer matches its approved publication grant");
		const i=inspectComponent(run,binding.node,c,run.owner,binding.overrides);
		if(!i || i.issuer!==run.owner)return {state:"wait"};
		const verdict=publicationVerdict(i);
		if(verdict==="changes")return {state:"changes",review:i};
		if(verdict!=="approved")return {state:"wait"};
	}
	return {state:"ready"};
}

/** @param {Run} run @param {Inspection} i */
export function currentInspection(run,i){
	const c=run.effects.find(e=>e.id===i.component), n=run.nodes[i.grain];
	if(!n || c?.kind!=="component" || c.grain!==i.grain || c.commit!==i.candidate || c.check!==n.grain.check ||
		!c.runnerClaim || checkReceipt(c)?.exit!==0)return false;
	const expected=c.delivery || c.remedy || c.replacement || c.rollout ? specialBasis(run,c) :
		n.state==="reviewing" && n.check===i.component && n.candidate===i.candidate ? {node:n,overrides:{}} : undefined;
	if(!expected)return false;
	return matchesBasis(i,basis(run,expected.node,c,expected.overrides));
}
