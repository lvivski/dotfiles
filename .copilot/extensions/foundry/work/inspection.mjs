import { deliveryInspection } from "./batch.mjs";
import { rolloutInspection } from "./campaign.mjs";
import { observedComponent } from "./publication.mjs";
import { remedyInspection } from "./remedy.mjs";
import { replacementInspection } from "./replacement.mjs";
import { grant } from "./transfer.mjs";
import { digest, fail, fields, record, text } from "./values.mjs";

/** @typedef {import("./model.js").Inspection} Inspection */
/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {Pick<Inspection,"base"|"generation"|"scope"|"task"|"specification">} Basis */
/** @param {Run} run @param {import("./model.js").Node} node @param {Check} c @param {Partial<Basis>} overrides @returns {Basis} */
export function reviewBasis(run,node,c,overrides){
	const task=node.grain.task??run.policy.direction;
	return {base:text(overrides.base??(c.observer ? node.generation : node.base),"reviewed base"),
		generation:text(overrides.generation??node.generation,"reviewed generation"),scope:overrides.scope??(c.observer ? {directories:[],files:[c.observer.file]} : grant(node)),
		...(node.grain.task===undefined && !c.remedy && !c.delivery && !c.observer && {specification:node.grain.specification}),
		task:overrides.task??(c.observer ? `${task} Review only the approved observer change to ${c.observer.file}; it must preserve assertions and tolerances.` : task)};
}

/** @param {unknown} raw @returns {{outcome:"approved"|"changes"|"unavailable",summary:string}} */
export function inspectionResult(raw){
	const value=record(raw);fields(value,["outcome","summary"]);
	const {outcome}=value;
	if(outcome!=="approved" && outcome!=="changes" && outcome!=="unavailable")fail("invalid_review","Expected an independent code review verdict");
	return {outcome,summary:text(value.summary,"review finding or conclusion")};
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
export const reviewedGrant=(run,node,c,i)=>matchesBasis(i,reviewBasis(run,node,c,{}),true);

/** A stale exceptional grant must not fall through to the ordinary writer's scope.
 * @param {Run} run @param {Check} c @param {import("./model.js").Node} [ordinary] */
export function reviewBinding(run,c,ordinary){
	if(c.delivery)return deliveryInspection(run,c);
	if(c.remedy)return remedyInspection(run,c);
	if(c.replacement)return replacementInspection(run,c);
	if(c.rollout)return rolloutInspection(run,c);
	if(ordinary?.state==="reviewing" && ordinary.check===c.id && ordinary.candidate===c.commit)return {node:ordinary,overrides:{}};
}

/** @param {Run} run @param {Inspection} i */
export function currentInspection(run,i){
	const c=run.effects.find(e=>e.id===i.component), n=run.nodes[i.grain];
	if(!n || c?.kind!=="component" || c.check!==n.grain.check || !observedComponent(c,i.grain,i.candidate))return false;
	const expected=reviewBinding(run,c,n);
	if(!expected)return false;
	return matchesBasis(i,reviewBasis(run,expected.node,c,expected.overrides));
}
