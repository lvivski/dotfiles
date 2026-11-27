import { working } from "./assignment.mjs";
import { answeredRoutes, currentFailures, delivered, failures, inPacketScope } from "./blockers.mjs";
import { comparison, reviews } from "./charter.mjs";
import { checkReceipt, currentEvaluation } from "./evidence.mjs";
import { discoveryBudget, goalVersion } from "./plan.mjs";
import { availableHistory, nextReview } from "./reviews.mjs";
import { roots } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {ReturnType<typeof failures>[number]} Gap */
/** @param {Run} run @param {number} remaining @param {Gap[]} gaps @param {string} [cwd] */
function routing(run,remaining,gaps,cwd){
	const history=reviews(run).filter(r=>currentEvaluation(run,r)),budget=discoveryBudget(run.nodes,remaining);
	const base=run.goal?.commit;
	/** @param {string} squadId */
	function offer(squadId){
		const squad=run.policy.squads.find(s=>s.id===squadId),past=availableHistory(run,history,squadId);
		if(!run.active || !budget || !squad || !base || !past || run.conflict || run.policyHold)return;
		const version=goalVersion(run,squad,base,cwd);
		if(version===undefined)return {unknown:true};
		const choice=nextReview(run,past,base,version,gaps);if(!choice)return;
		const prev=choice.wake && past.find(r=>r.id===choice.wake?.review);
		return {scope:prev?.observation?.outcome==="needs-evidence" && prev.base===base && prev.version===version?comparison(run,prev):undefined};
	}
	/** @type {Map<string,ReturnType<typeof offer>>} */ const promised=new Map();
	/** @param {Gap} g */
	return g=>{
		const seen=history.filter(r=>delivered(g,r));
		for(const r of seen.toReversed()){
			const link=r.state==="observed" && r.observation?.addresses?.find(a=>a.id===g.id),n=link && run.nodes[link.grain];
			if(link && n && roots(n.grain.directory).includes(g.directory) && (link.worker?n.worker===link.worker:n.review===r.id) &&
				!["blocked","idle","repeated"].includes(n.state))return {state:n.state==="waiting" || n.state==="writing" && !n.worker?"reserved":
					working(n)?"assigned":"awaiting-verification",grain:link.grain,worker:n.worker,review:r.id};
		}
		const last=history.findLast(r=>r.squad===g.squad && r.base===g.commit);
		const open=last && ["ready","issued","uncertain","reported","suspended","deferred"].includes(last.state) && inPacketScope(g,last,comparison(run,last));
		if(g.squad && !open && g.commit===base && !promised.has(g.squad))promised.set(g.squad,offer(g.squad));
		const next=g.squad?promised.get(g.squad):undefined;
		return {state:open?"in-review":next?.unknown?"review-unknown":next && g.commit===base && (!next.scope || next.scope.directory===g.directory)?"awaiting-review":"unowned",
			review:open?last.id:seen.at(-1)?.id,grain:undefined,worker:undefined};
	};
}

/** @param {Run} run @param {number} remaining @param {string} [cwd] */
export function routedBlockers(run,remaining,cwd){
	const gaps=currentFailures(run);if(!gaps.length)return [];
	const claim=routing(run,remaining,gaps,cwd);return gaps.map(g=>({...g,...claim(g)}));
}
/** @param {Run} run @param {number} remaining @param {string} [cwd] */
export const unownedBlockers=(run,remaining,cwd)=>routedBlockers(run,remaining,cwd).filter(g=>g.state==="unowned");

/** A verified result belongs to a goal; a routing state belongs to a failure and
 * its present owner. Neither a writer nor a scheduling pass verifies the step.
 * @param {Run} run @param {number} remaining @param {string} [cwd] */
export function sharedBlockers(run,remaining,cwd){
	/** @type {Map<string,Gap & {verifiedAt?:string,verifiedReceipt?:string}>} */ const latest=new Map();
	for(const e of run.effects){
		if(e.kind!=="goal" || e.check!==run.policy.goalCheck || !currentEvaluation(run,e))continue;
		const r=checkReceipt(e);if(!r || ![0,1,2].includes(r.exit??-1))continue;
		if(r.blockers?.some(s=>"blocked" in s) || run.attributions?.some(s=>s.receipt===e.id))
			for(const g of failures(run,e.id))latest.set(JSON.stringify([g.id,g.directory]),g);
		for(const s of r.blockers??[]){
			const g=latest.get(JSON.stringify([s.id,s.directory]));
			if(g && "passed" in s){g.verifiedAt=r.commit;g.verifiedReceipt=e.id;}
		}
	}
	if(!latest.size)return [];
	const claimFor=routing(run,remaining,currentFailures(run),cwd),routes=new Map();
	return [...latest.values()].map(g=>{
		const claim=claimFor(g);
		if(!routes.has(g.receipt))routes.set(g.receipt,answeredRoutes(run,g.receipt).passes);
		/** @type {string|undefined} */ const schedulingPass=routes.get(g.receipt)?.get(g.id);
		return {...g,...claim,...(schedulingPass?{schedulingPass}:{}),
			state:g.verifiedAt?"verified":run.goal?.check!==g.receipt?"awaiting-verification":claim.state};
	}).sort((a,b)=>b.blocked-a.blocked);
}
