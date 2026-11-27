import { currentCheck } from "./eligibility.mjs";
import { journal } from "./dispatch.mjs";
import { productPin } from "./evidence.mjs";
import { expired, reserveCheck } from "./native.mjs";
import { exactRunner } from "./abi.mjs";
import { commitAt, verifyContracts } from "./product.mjs";
import { heldOutcome } from "./revision.mjs";
import { stalePins } from "./lineage.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** Only plain checks and the two supported scoped correction batches can be
 * rebound. Unknown inputs remain attached to the closed original obligation. */
const understood=new Set(["id","issuer","tool","kind","state","args","attempt","commit","check","grain","evaluatorRevision","productEvaluatorRevision",
	"error","callId","usedArtifacts","comparedArtifacts","rollout","replacement"]);
/** @param {Check} e */
const neverIssued=e=>e.state==="ready" && ["callId","error","permissionHold","runnerStarted","runnerClaim","receipt","launcherExit","nativeId"].every(k=>!Object.hasOwn(e,k));
/** Unknown incoming links can bind a historical use (e.g. a particular mixed
 * target's joined verification). Never move such a pointer by guessing.
 * @param {unknown} value @param {Check} e @param {object|undefined} anchor @returns {boolean} */
function referenced(value,e,anchor){
	if(value===e || !value || typeof value!=="object")return false;
	return Object.entries(value).some(([k,v])=>value===anchor && k==="check"?false:v===e.id || referenced(v,e,anchor));
}
/** @param {Run} run @param {string} cwd @param {string} actor @param {string} target */
export function continueChecks(run,cwd,actor,target){
	if(!run.active || expired(run) || run.conflict || run.blocker || run.policyHold || run.effects.some(e=>e.permissionHold) ||
		run.inspections?.some(i=>i.permissionHold))return false;
	let linked=false;
	for(const e of run.effects){
		if(e.tool!=="bash" || e.attempt?.version!==1 || e.issuer!==actor || heldOutcome(e) || !e.commit || !e.check ||
			!exactRunner(run,e,cwd,false) ||
			!(neverIssued(e) || e.state==="done" && e.attempt.closure==="closed-before-runner-claim") ||
			run.effects.some(x=>x.tool==="bash" && x.attempt?.version===2 && x.attempt.previous===e.id))continue;
		if(neverIssued(e) && !e.attempt.closure){e.attempt.closure="never-issued";linked=true;}
		if(!Object.keys(e).every(k=>understood.has(k)))continue;
		const n=e.grain && run.nodes[e.grain];
		const at=e.kind==="goal"?run.goal:e.kind==="product"?run.join:undefined;
		const batch=e.rollout??e.replacement,a=batch && run.adoptions?.find(a=>a.id===batch);
		if(referenced(run,e,at??(!batch && n || undefined)))continue;
		if(batch ? !a || a.revision!==target || a.foreground || e.kind!=="component" || !n :
			at ? at.check!==e.id || at.commit!==e.commit || at.target!==target :
			!n || e.kind!=="component" || n.state!=="checking" || n.check!==e.id || n.worker!==actor || n.candidate!==e.commit ||
			n.grain.check!==e.check || stalePins(run,n).length)continue;
		if(!currentCheck(run,e) || e.evaluatorRevision!==(e.kind==="goal"?run.repins?.at(-1)?.revision:e.kind==="product"?productPin(run):undefined) ||
			e.productEvaluatorRevision!==(e.kind==="goal"?productPin(run):undefined) ||
			e.check!==(e.kind==="goal"?run.policy.goalCheck:e.kind==="product"?run.policy.productCheck:n && n.grain.check))continue;
		const role=e.kind==="component" && e.grain?/** @type {const} */({kind:"component",grain:e.grain}):
			e.kind==="goal" || e.kind==="product"?{kind:e.kind}:undefined;
		if(!role)continue;
		verifyContracts(cwd,run.policy,target);commitAt(cwd,e.commit);
		if(neverIssued(e))journal(e,"withdraw");
		const fresh=reserveCheck(run,actor,cwd,e.commit,e.check,role,{
			...(e.usedArtifacts && {usedArtifacts:e.usedArtifacts}),...(e.comparedArtifacts && {comparedArtifacts:e.comparedArtifacts})});
		if(e.rollout)fresh.rollout=e.rollout;
		if(e.replacement)fresh.replacement=e.replacement;
		fresh.attempt.previous=e.id;
		if(at)at.check=fresh.id;else if(!batch && n)n.check=fresh.id;
		linked=true;
	}
	return linked;
}
