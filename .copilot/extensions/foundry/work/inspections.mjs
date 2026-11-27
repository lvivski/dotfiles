import { randomUUID } from "node:crypto";
import { currentInspection, reviewBasis, reviewBinding } from "./inspection.mjs";
import { checkReceipt } from "./receipt.mjs";
import { componentDecision, observedComponent } from "./publication.mjs";
import { inspectionAt } from "./revision.mjs";
import { inspection } from "./rules/inspection.mjs";
import { transition } from "./machine.mjs";
import { changedFiles } from "./product.mjs";
import { grant } from "./transfer.mjs";
import { expired } from "./native.mjs";
import { contains, digest, fail } from "./values.mjs";

/** @typedef {import("./model.js").Inspection} Inspection */
/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {import("./inspection.mjs").Basis} Basis */
/** @typedef {Pick<Inspection,"issuer"|"dispatch"|"workflow"|"summary"|"previous">} Context */
/** @typedef {Omit<Context,"issuer">} Data */

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

/** Reserve from a private planner snapshot, never by starting a workflow in the transaction.
 * The absence of the list denotes a run activated under its original pre-review contract.
 * @param {Run} run @param {import("./model.js").Node} node @param {Check} c @param {string} issuer @param {Partial<Basis>} [overrides] */
export function inspectComponent(run,node,c,issuer,overrides={}){
	if(!run.inspections)return;
	if(!c.commit || !observedComponent(c,node.grain.id,c.commit) || c.check!==node.grain.check || issuer!==run.owner && issuer!==c.issuer)
		fail("invalid_review","Review requires this component's passing runner receipt");
	const subject={component:c.id,grain:node.grain.id,candidate:c.commit,...reviewBasis(run,node,c,overrides)};
	const existing=inspectionAt(run,c.id);
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

/** Progress only the ordered component obligations of an already-authorized grant. A missing
 * member, a failed check, and a bound review finding have different consequences for its owner.
 * @param {Run} run @param {string} assembly @param {string[]} members @param {Check[]} checks
 * @param {((observed:Check[])=>void)|undefined} [validate]
 * @returns {{state:"wait"|"ready"}|{state:"next",index:number}|{state:"failed",check:Check}|{state:"changes",review:Inspection}} */
export function componentBatch(run,assembly,members,checks,validate){
	if(!members.length || checks.length>members.length || new Set(members).size!==members.length ||
		checks.some((c,i)=>c.kind!=="component" || c.grain!==members[i] || c.commit!==assembly || c.check!==run.nodes[members[i]]?.grain.check))
		fail("stale_assignment","A batch observation differs from the approved owners, order, assembly or check");
	if(checks.some(c=>c.state==="issued" || c.state==="uncertain" || c.permissionHold))return {state:"wait"};
	const failed=checks.find(c=>{const r=checkReceipt(c);return c.launcherExit!==undefined || c.state==="refused" || r && r.exit!==0;});
	if(failed)return {state:"failed",check:failed};
	if(run.effects.some(e=>e.permissionHold))return {state:"wait"};
	const observed=checks.filter((c,i)=>observedComponent(c,members[i],assembly));
	if(observed.length===checks.length && checks.length<members.length)return {state:"next",index:checks.length};
	const complete=observed.length===members.length;
	const required=new Set(checks.flatMap(c=>c.attempt?.version===3?c.attempt.facts.flatMap(f=>f.kind==="publication"?[f.component]:[]):[]));
	const due=complete?checks:observed.filter(c=>required.has(c.id));
	if(!due.length)return {state:"wait"};
	validate?.(due);
	for(const c of run.inspections===undefined?[]:due){
		const binding=reviewBinding(run,c) ?? fail("stale_assignment","The signed component no longer matches its approved publication grant");
		const i=inspectComponent(run,binding.node,c,run.owner,binding.overrides);
		if(!i || i.issuer!==run.owner)return {state:"wait"};
		const verdict=componentDecision(run,c.id,binding.node.grain.id,assembly)?.verdict;
		if(verdict==="changes")return {state:"changes",review:i};
		if(verdict!=="approved")return {state:"wait"};
	}
	return {state:complete?"ready":"wait"};
}

/** @param {Inspection} i */
const decided=i=>i.state==="approved" || i.state==="changes";
/** @param {Run} run */
const current=run=>(run.inspections??[]).filter(i=>currentInspection(run,i));
/** @param {Inspection} i @returns {i is Inspection & {workflow:string}} */
const bound=i=>i.state==="issued" && !!i.dispatch && !!i.workflow;
/** @param {Run} run @param {string} actor */
export const boundInspections=(run,actor)=>(run.inspections??[]).filter(bound).filter(i=>i.issuer===actor);
/** @param {Run} run @param {string} actor @param {Inspection[]} [expected] */
export function readyInspections(run,actor,expected){
	if(!run.active || expired(run))return [];
	const selected=expected && stamps(expected);
	return (run.inspections??[]).filter(i=>i.issuer===actor && i.state==="ready" && !i.dispatch && !i.workflow &&
		(!selected || matches(selected,i)) && currentInspection(run,i));
}

/** Which wake sources matter for this issuer? Observation of an original call is independent of permission to dispatch.
 * @param {Run} run @param {string} actor @param {boolean} waitingForPermission */
export function inspectionWakes(run,actor,waitingForPermission){
	const live=current(run);
	return {local:run.active && live.some(i=>(i.state==="ready" && i.issuer===actor || decided(i)) &&
		(i.issuer===actor && !!i.permissionHold || waitingForPermission)),
		participant:live.some(i=>i.issuer===actor) || boundInspections(run,actor).length>0,
		pending:live.some(i=>i.issuer===actor && bound(i))};
}

/** @param {Inspection[]} items */
const stamps=items=>new Map(items.map(i=>[i.id,digest(i)]));
/** @param {Map<string,string>} selected @param {Inspection} i */
const matches=(selected,i)=>selected.has(i.id) && selected.get(i.id)===digest(i);
/** Revalidate the exact record after any asynchronous policy read. A new review at the same SHA is not the selected one.
 * @param {Run} run @param {Map<string,string>} selected */
function unchanged(run,selected){
	if(!selected.size)return [];
	return run.inspections?.filter(i=>matches(selected,i) && currentInspection(run,i))??[];
}
/** @param {Run} run @param {Inspection[]} expected */
export const matchingInspections=(run,expected)=>unchanged(run,stamps(expected));

/** One planning pass may retry its ledger swap. Its permission sample covers only the decisions actually presented.
 * @param {string} actor */
export function publicationSample(actor){
	/** @type {Inspection[]} */ let selected=[];
	/** @type {Map<string,string>} */ let presented=new Map();
	let permitted=presented;
	return {
		get selected(){return selected;},
		permit(){permitted=presented;},
		/** @param {Run|undefined} run */
		check(run){
			selected=run ? current(run).filter(i=>decided(i) && (!i.permissionHold || i.issuer===actor)) : [];
			presented=stamps(selected);
			for(const [id,pin] of presented)if(permitted.get(id)!==pin)return false;
			for(const i of selected)if(i.issuer===actor)delete i.permissionHold;
			return true;
		},
	};
}

/** Freeze the owner's resume request at its original pins. Observation alone must never reissue a workflow.
 * @param {Run} prior @param {boolean} canReceive */
export function prepareInspectionResume(prior,canReceive){
	const live=current(prior), selected=stamps(live.filter(i=>inspectionResume(prior,i,canReceive)));
	const observe=live.some(i=>i.issuer===prior.owner && (i.state==="ready" || bound(i)) ||
		decided(i) && (!i.permissionHold || i.issuer===prior.owner));
	if(!selected.size && !observe)return;
	return (/** @type {Run} */ run)=>{
		for(const i of unchanged(run,selected))inspectionResume(run,i,canReceive)?.();
	};
}
