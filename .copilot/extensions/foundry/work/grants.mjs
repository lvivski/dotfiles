import { executor } from "./adapter.mjs";
import { authorEvidence, prepareAutomaticDraft } from "./authorship.mjs";
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
/** @typedef {{prompt:string,apply:(r:Run)=>()=>boolean,consent?:"native"|"satisfied"|"policy",hold?:string,wake?:"none"|"recover"|"ready"}} Grant */
/** @typedef {(cwd:string,run:Run,actor:string,args:Record<string,unknown>,verify:Verify)=>Grant} Prepare */
/** @typedef {{operation:"input",attempt:string,args:{grain:string;blob:string}} | {operation:"draft",attempt:string,args:{check:string}}} Proposal */
/** @typedef {ReturnType<typeof inputEvidence> extends Generator<infer V> ? V : never} Reference */
/** @typedef {Reference|NonNullable<ReturnType<typeof authorEvidence>>} Evidence */
/** @typedef {{prepare:Prepare,on?:"reference"|"correction",propose?:(e:Evidence)=>Proposal}} Power */
/** @param {boolean} inspect @returns {Prepare} */
const baseline=inspect=>(cwd,run,actor,args,verify)=>{
	fields(args,["run","grains"]);
	return prepareBaselines(cwd,run,actor,args.grains,inspect,verify);
};
/** @type {ReadonlyMap<string,Power>} */
const operations=new Map(Object.entries(/** @satisfies {Record<string,Power>} */ ({
	input:{prepare:prepareInput,on:"reference",propose:e=>e.signal==="reference"?{operation:"input",attempt:e.attempt,args:e.args}:fail("invalid_rule","Missing writer reference")},
	draft:{prepare:prepareAutomaticDraft,on:"correction",propose:e=>e.signal==="correction"?{operation:"draft",attempt:e.attempt,args:e.args}:fail("invalid_rule","Missing correction subject")},
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
	const propose=executor(rules,Object.fromEntries([...operations].flatMap(([op,p])=>p.propose?[[op,p.propose]]:[])));
	/** @param {Run} run */
	function select(run) {
		/** @type {Map<string,Proposal>} */ const found=new Map();
		const author=authors && authorEvidence(run);
		for(const subject of [...inputEvidence(run),...(author?[author]:[])]){
			const choice=transition(rules,{value:rules.initial,context:null},{type:subject.signal},subject.facts,false);
			const [proposal]=propose(choice,subject);
			if(proposal)found.set(digest(proposal),proposal);
		}
		return found;
	}
	return {select,
		/** @param {string} cwd @param {Run} run @param {string} actor @param {Map<string,Proposal>} sampled @param {Verify} verify */
		apply(cwd,run,actor,sampled,verify){
			/** @type {(()=>boolean)[]} */ const guards=[];
			for(const [key,p] of select(run)){
				if(!sampled.has(key) || p.operation==="input" && run.nodes[p.args.grain]?.token!==p.attempt)continue;
				let grant;
				try{
					const prepare=grantFor(p.operation)??fail("invalid_rule","Unregistered recovery power");
					grant=prepare(cwd,run,actor,{run:run.id,...p.args},verify);
				}catch(error){
					if(!(error instanceof FoundryError))throw error;
					if(p.operation==="input"){const need=run.nodes[p.args.grain]?.stop?.input;if(need){need.hold=error.message;delete need.decision;}}
					else run.offerHold??=`Cannot assign a correction author for ${p.attempt}: ${error.message}`;
					continue;
				}
				if(grant.consent==="satisfied")guards.push(grant.apply(run));
				else if(grant.hold && p.operation==="input"){
					const need=run.nodes[p.args.grain]?.stop?.input;
					if(need){need.hold=grant.hold;need.decision="input";}
				}
			}
			return guards.length?()=>guards.every(guard=>guard()):undefined;
		}};
}
