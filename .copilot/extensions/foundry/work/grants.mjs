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
import { memberAction, memberInputs, strategy } from "./strategy.mjs";
import { writerPublication } from "./origin.mjs";
import { digest, fail, fields, FoundryError } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {(e:import("./model.js").NativeCall)=>void} Verify */
/** @typedef {{prompt:string,apply:(r:Run)=>()=>boolean,consent?:"native"|"satisfied"|"policy",hold?:string,wake?:"none"|"recover"|"ready"}} Grant */
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
	input:{prepare:prepareInput,on:"reference"},draft:{prepare:prepareAutomaticDraft,on:"correction"},
	inspectBaseline:{prepare:baseline(true)},repairBaseline:{prepare:baseline(false)},correct:{prepare:prepareCorrection},reuse:{prepare:prepareReuse},
	restore:{prepare:prepareRestoration},diagnose:{prepare:prepareObserver},checkpoint:{prepare:prepareCheckpoint},remediate:{prepare:prepareProduction},deliver:{prepare:prepareDelivery},
})));
/** @param {string} op */
export const grantFor=op=>operations.get(op)?.prepare;

/** Bind trusted edition rules once. The result of a match contains only a subject and operation name.
 * @param {import("./machine.mjs").Machine} [rules] @param {boolean} [authors] */
export function recoveryRules(rules=strategy,authors=false) {
	for(const edges of Object.values(rules.states))for(const e of edges)
		if(e.on==="approved-members"?!memberInputs(e):e.action && operations.get(e.action)?.on!==e.on)fail("invalid_rule",`Operation ${e.action} has no verified subject for ${e.on}`);
	/** @typedef {{op:string,prepare:Prepare}|{inputs:NonNullable<NonNullable<Run["adoptions"]>[number]["accepted"]>["inputs"]}} Selection */
	/** @type {Record<string,(c:{run:Run,offer?:import("./model.js").Adoption,edge?:import("./machine.mjs").Edge})=>Selection>} */
	const bindings=Object.fromEntries([...operations].filter(([,p])=>p.on).map(([op,p])=>[op,()=>({op,prepare:p.prepare})]));
	bindings[memberAction]=({run,offer,edge})=>{
		const r=offer?.rollout;if(!r || !run.join || !offer?.accepted)fail("invalid_rule","An original answered byte proposal is required");
		const members=Object.keys(r.owners),ids=new Set(),edges=[];
		for(const use of memberInputs(edge)??fail("invalid_rule","No declared prerequisites for the selected member rule")){
			if(use==="dependency-reviews"){
				for(const member of members)for(const dep of Object.keys(r.included[member].inputs)){
					if(!Object.hasOwn(r.owners,dep))continue;
					edges.push({member,afterReviewOf:dep});
				}
			}else if(use==="included-publications" || use==="declared-dependencies"){
				const versions=use==="included-publications"?Object.keys(r.included):Object.values(r.included).flatMap(o=>Object.keys(o.inputs));
				for(const id of versions)ids.add(id);
			}else fail("invalid_rule","Unknown approval input declaration");
		}
		const inputs=[...ids].map(id=>{
			const n=run.nodes[id],o=r.included[id],p=n?.check && writerPublication(run,n.check,id,run.join?.outputs[id]??"");
			if(!o || !p || !p.inspection || digest(o.scope)!==digest(p.inspection.scope))fail("missing_receipt",`Missing the original reviewed input for ${id}`);
			return {component:p.component.id,inspection:p.inspection.id};
		});
		return {inputs:[...inputs,...edges]};
	};
	const propose=executor(rules,bindings);
	/** @param {Run} run */
	function select(run) {
		/** @type {Map<string,Proposal>} */ const found=new Map();
		const author=authors && authorEvidence(run);
		for(const subject of [...inputEvidence(run),...(author?[author]:[])]){
			const choice=transition(rules,{value:rules.initial,context:null},{type:subject.signal},subject.facts,false);
			const [power]=propose(choice,{run});
			if(power && "prepare" in power)found.set(digest([power.op,subject.attempt,subject.args,subject.grant]),{prepare:power.prepare,subject});
		}
		return found;
	}
	return {select,
		/** Freeze the actual checked input versions when the original answer is consumed.
		 * Neither the runner nor the state document can choose a policy by name.
		 * @param {Run} run @param {import("./model.js").Adoption} offer */
		admittedInputs(run,offer){
			const r=offer.rollout;if(!r || !offer.accepted || offer.decision?.status!=="answered" || offer.decision.answer!==r.blob)
				fail("approval_required","Only the original answered proposal can bind component inputs");
			const facts={multipleOwners:Object.keys(r.owners).length>1,includedInputs:Object.values(r.included).some(p=>Object.keys(p.inputs).length>0)};
			const choice=transition(rules,{value:rules.initial,context:null},{type:"approved-members"},facts,true);
			const [selected]=propose(choice,{run,offer,edge:choice.edge});
			if(!selected || !("inputs" in selected) || !selected.inputs)fail("invalid_rule","No bound input declaration for the answered proposal");
			return selected.inputs;
		},
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
				if(grant.consent==="satisfied")guards.push(grant.apply(run));
				else if(grant.hold && stop?.stop?.input){stop.stop.input.hold=grant.hold;stop.stop.input.decision="input";}
			}
			return guards.length?()=>guards.every(guard=>guard()):undefined;
		}};
}
