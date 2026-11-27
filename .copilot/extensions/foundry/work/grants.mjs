import { executor } from "./adapter.mjs";
import { authorEvidence, prepareDraft } from "./authorship.mjs";
import { prepareBaselines } from "./baseline.mjs";
import { prepareCheckpoint } from "./checkpoint.mjs";
import { prepareCorrection } from "./correction.mjs";
import { prepareDelivery } from "./delivery.mjs";
import { transition } from "./machine.mjs";
import { prepareObserver } from "./observer.mjs";
import { prepareProduction } from "./production.mjs";
import { inputEvidence, prepareInput } from "./resupply.mjs";
import { prepareRestoration } from "./restoration.mjs";
import { prepareReuse } from "./reuse.mjs";
import { strategy } from "./strategy.mjs";
import { digest, fail, fields, FoundryError } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {(e:import("./model.js").NativeCall)=>void} Verify */
/** @typedef {{prompt:string,apply:(r:Run)=>()=>boolean,consent?:"native"|"satisfied"|"policy",scope?:import("./model.js").CorrectionDraft,hold?:string,wake?:"none"|"recover"|"ready"}} Grant */
/** @typedef {(cwd:string,run:Run,actor:string,args:Record<string,unknown>,verify:Verify)=>Grant} Prepare */
/** @typedef {ReturnType<typeof inputEvidence> extends Generator<infer V> ? V : never} Reference */
/** @typedef {Reference|NonNullable<ReturnType<typeof authorEvidence>>} Evidence */
/** @typedef {{prepare:Prepare,on?:Evidence["signal"]}} Power */
/** @typedef {{prepare:Prepare,subject:Evidence}} Proposal */
/** @param {boolean} inspect @returns {Prepare} */
const baseline=inspect=>(cwd,run,actor,args,verify)=>{
	fields(args,["run","grains"]);
	return prepareBaselines(cwd,run,actor,args.grains,inspect,verify);
};
/** @type {ReadonlyMap<string,Power>} */
const operations=new Map(Object.entries(/** @satisfies {Record<string,Power>} */ ({
	input:{prepare:prepareInput,on:"reference"},draft:{prepare:prepareDraft,on:"correction"},
	inspectBaseline:{prepare:baseline(true)},repairBaseline:{prepare:baseline(false)},correct:{prepare:prepareCorrection},reuse:{prepare:prepareReuse},
	restore:{prepare:prepareRestoration},diagnose:{prepare:prepareObserver},checkpoint:{prepare:prepareCheckpoint},remediate:{prepare:prepareProduction},deliver:{prepare:prepareDelivery},
})));
/** @param {string} op */
export const grantFor=op=>operations.get(op)?.prepare;

/** Bind trusted edition rules once. The result of a match contains only a subject and operation name.
 * @param {import("./machine.mjs").Machine} [rules] @param {boolean} [authors] */
export function recoveryRules(rules=strategy,authors=false) {
	for(const edges of Object.values(rules.states))for(const {on,action} of edges)
		if(action && operations.get(action)?.on!==on)fail("invalid_rule",`Operation ${action} has no verified subject for ${on}`);
	const propose=executor(rules,Object.fromEntries([...operations].filter(([,p])=>p.on).map(([op,p])=>[op,()=>({op,prepare:p.prepare})])));
	/** @param {Run} run */
	function select(run) {
		/** @type {Map<string,Proposal>} */ const found=new Map();
		const author=authors && authorEvidence(run);
		for(const subject of [...inputEvidence(run),...(author?[author]:[])]){
			const choice=transition(rules,{value:rules.initial,context:null},{type:subject.signal},subject.facts,false);
			const [power]=propose(choice,undefined);
			if(power)found.set(digest([power.op,subject.attempt,subject.args,subject.grant]),{prepare:power.prepare,subject});
		}
		return found;
	}
	return {select,
		/** @param {string} cwd @param {Run} run @param {string} actor @param {Map<string,Proposal>} sampled @param {Verify} verify */
		apply(cwd,run,actor,sampled,verify){
			/** @type {(()=>boolean)[]} */ const guards=[];
			for(const [key,{prepare,subject}] of select(run)){
				if(!sampled.has(key))continue;
				const stop=subject.signal==="reference"?run.nodes[subject.args.grain]:undefined;
				if(stop && stop.token!==subject.attempt)continue;
				let grant;
				try{
					grant=prepare(cwd,run,actor,{run:run.id,...subject.args},verify);
				}catch(error){
					if(!(error instanceof FoundryError))throw error;
					const need=stop?.stop?.input;
					if(need){need.hold=error.message;delete need.decision;}
					else if(subject.signal==="correction")run.offerHold??=`Cannot assign a correction author for ${subject.attempt}: ${error.message}`;
					continue;
				}
				if(grant.consent==="satisfied" || grant.scope)guards.push(grant.apply(run)); // An unanswered scope queues a question, not an author.
				else if(grant.hold && stop?.stop?.input){stop.stop.input.hold=grant.hold;stop.stop.input.decision="input";}
			}
			return guards.length?()=>guards.every(guard=>guard()):undefined;
		}};
}
