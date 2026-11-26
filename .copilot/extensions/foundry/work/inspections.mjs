import { currentInspection, inspectionResume } from "./inspection.mjs";
import { expired } from "./native.mjs";
import { digest } from "./values.mjs";

/** @typedef {import("./model.js").Inspection} Inspection */
/** @typedef {import("./model.js").Run} Run */
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
