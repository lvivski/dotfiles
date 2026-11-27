import { assigningGrant, confirmedWriter, seeded, submissionTerms, writerKeys } from "./origin.mjs";
import { effectAt } from "./revision.mjs";
import { digest } from "./values.mjs";
import { publishedComponent } from "./publication.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Call */
/** @param {Run} run @param {import("./model.js").Effect|undefined} w */
export function originalGrant(run,w){
	const origin=confirmedWriter(run,w);
	if(!origin || w?.kind!=="writer" || w.writing || !w.grain || !Object.keys(w).every(k=>writerKeys.has(k)) ||
		run.historicalPrefix && origin.at>=run.historicalPrefix.length)return;
	/** @type {{review:import("./model.js").Review;output:string|import("./model.js").Proposal}|undefined} */ let source;
	for(let i=0;i<origin.at;i++){
		const r=run.effects[i];if(r.kind!=="scout")continue;
		const grant=assigningGrant(run,r,w.grain);if(!grant)continue;
		if(source)return;
		source={review:r,output:grant.output};
	}
	if(source)return {...origin,...source};
}

/** An old launch was not a typed writer declaration. Project only the positive
 * data its original charter, confirmed launch and still-bound node establish.
 * Never write those derived fields back into the old signed subject.
 * @param {Run} run @param {Iterable<string>} ids @returns {import("./origin.mjs").PriorWriters} */
export function originalWriters(run,ids){
	/** @type {import("./origin.mjs").PriorWriters} */ const sources=new Map();
	const needed=new Set(ids);
	for(const id of needed){
		const w=effectAt(run,id);
		if(w?.kind!=="writer" || !w.grain)continue;
		if(w.writing){
			for(const input of Object.values(w.writing.inputs??{})){
				const c=effectAt(run,input?.component),s=c?.kind==="component" && c.attempt?.version===3 && c.attempt.source;
				if(s && s.kind==="writer")needed.add(s.id);
			}
			continue;
		}
		if(!Object.keys(w).every(k=>writerKeys.has(k)))continue;
		const n=run.nodes[w.grain],old=originalGrant(run,w);
		if(!old){
			const launch=confirmedWriter(run,w);
			if(launch && n && seeded(run,n) && launch.at<(run.historicalPrefix?.length??0) && n.worker===launch.worker &&
				n.generation===launch.generation && n.base===run.policy.base && !n.grain.needs.length && n.inputs && !Object.keys(n.inputs).length){
				sources.set(w.id,{grain:n.grain,terms:{base:n.base,terms:digest(n.grain),source:{seed:run.policy.base},inputs:{}}});
			}
			continue;
		}
		const {review,output}=old,squad=run.policy.squads.find(s=>s.id===review.squad);
		if(!n || !squad || !review.callId || !review.workflowId || n.reuse || n.restoration || n.retained || n.successor ||
			n.worker!==old.worker || n.generation!==old.generation || n.review!==review.id || n.base!==review.base ||
			!n.inputs || n.grain.needs.length || Object.keys(n.inputs).length)continue;
		const grain=typeof output==="string"?n.grain:"areas" in squad?{...output,specification:squad.charter,boundary:squad.boundary,...(squad.agent && {agent:squad.agent})}:undefined;
		const effective=grain && submissionTerms(run,grain,w,review);
		if(!grain || !effective || digest(effective)!==digest(n.grain) || grain.needs.length)continue;
		sources.set(w.id,{review,grain,terms:{base:n.base,terms:digest(grain),source:{review:review.id},inputs:{}}});
	}
	return sources;
}

const dispatch=["kind","id","tool","issuer","state","args","attempt","verification","callId","error","permissionHold","runnerStarted","runnerClaim","receipt","launcherExit","commit","check"];
const component=new Set([...dispatch,"grain","usedArtifacts","comparedArtifacts","inlineRepair"]),product=new Set(dispatch);
/** Only this identified historical shape can supply ordinary publication evidence.
 * @param {Run} run @param {Call} c */
export function ordinary(run,c){
	if(run.effects.indexOf(c)<0 || run.effects.indexOf(c)>=(run.historicalPrefix?.length??0) || !c.runnerClaim ||
		c.attempt?.version!==1 && c.attempt?.version!==2 || c.attempt.version===2 && c.attempt.previous ||
		(c.kind!=="component" && c.kind!=="product") || !Object.keys(c).every(k=>(c.kind==="component"?component:product).has(k)))return false;
	const d=c.verification;
	return c.attempt.version===1?!d:!!d && d.use===c.kind && !d.joined && !d.resolutions && !d.privateInput && d.steps.length===1 && d.steps[0].build===null;
}
/** @param {Run} run @param {Call} c */
export function originalProduct(run,c){
	const p=run.products.find(p=>p.check===c.id);
	return c.kind==="product" && ordinary(run,c) && p?.commit===c.commit && c.check===run.policy.productCheck &&
		Object.keys(p?.outputs??{}).length>0 && Object.entries(p?.outputs??{}).every(([id,revision])=>!!publishedComponent(run,run.nodes[id]?.check,id,revision));
}
