import { randomUUID } from "node:crypto";
import { offered, verifyDependency, verifySource } from "./artifacts.mjs";
import { baselineTip } from "./baseline.mjs";
import { continuationNotice, inputMessage, inputReference } from "./reference.mjs";
import { continuationPrompt, stoppedPins } from "./continuation.mjs";
import { journal, unsentRepair } from "./dispatch.mjs";
import { assign } from "./assignment.mjs";
import { availableReservations } from "./capacity.mjs";
import { milestoneBlocker, missingInput } from "./evidence.mjs";
import { pendingGoal, releaseFacts } from "./facts.mjs";
import { observeTarget } from "./goal.mjs";
import { admitted, reserveNotice } from "./native.mjs";
import { partitionConflict } from "./partition.mjs";
import { referenceAttempt, writerVersion } from "./lineage.mjs";
import { commitAt, git, verifyContracts } from "./product.mjs";
import { currentSupply, pooledDependency, sourceLocator } from "./supplier.mjs";
import { digest, fail, fields, FoundryError, name, pinnedSelection, roots, scopeLabel, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {NonNullable<import("./model.js").NativeCall["input"]>} Input */
/** @typedef {(e:import("./model.js").NativeCall)=>void} Verify */
/** @typedef {import("./model.js").DependencyReference} Dependency */

/** @param {unknown} value */
export function inputBlob(value) {
	const blob=text(value,"full Git blob ID of the missing reference");
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blob)) fail("invalid_pin","Supply the exact full Git blob ID, not a path, branch or abbreviated hash");
	return blob;
}

/** @param {Run} run @param {Node} n @param {import("./model.js").Artifact} a @param {number} i @param {boolean} requested */
const matches=(run,n,a,i,requested)=>!a.evaluation && !a.assembly && offered(a,n) &&
		(a.source ? currentSupply(run,n,a,i) : !n.stop?.input?.source && a.publisher===run.owner) &&
		(!requested || i>=(n.stop?.input?.after??Infinity) && roots(n.grain.directory).some(dir=>a.to.includes(dir)));
/** @param {Run} run @param {Node} n @param {string} blob @param {boolean} requested */
const offerIndex=(run,n,blob,requested)=>run.artifacts?.findIndex((a,i)=>a.blob===blob && matches(run,n,a,i,requested))??-1;

/** Read-only options. Publication is not evidence that a reference matches a prose-only need.
 * @param {Run} run @param {Node} n */
export function inputChoices(run,n){
	const need=n.stop?.input;
	if(need && !need.decision || !referenceAttempt(run,n))return [];
	const dependency=pooledDependency(run,n);
	if(need && dependency)return [{file:dependency.source.file,blob:need.blob}];
	const seen=new Set();
	return (run.artifacts??[]).filter((a,i)=>{
		if(seen.has(a.blob) || need && a.blob!==need.blob || !matches(run,n,a,i,!!need))return false;
		seen.add(a.blob);return true;
	});
}

/** The grant stays on its original checkout; a later, unrelated checkpoint need not strand an undelivered notice.
 * @param {string} cwd @param {Run} run @param {Node} n @param {string} [tip] */
function inputContext(cwd,run,n,tip) {
	admitted(run);
	const target=tip??observeTarget(()=>commitAt(cwd,run.policy.target)).target, goal=run.goal, p=run.products.at(-1);
	if (target && goal && goal.target!==target) fail("stale_assignment","The assessed target changed before writer delivery");
	const failed=milestoneBlocker(run);
	if(failed)fail("stale_assignment",`The joined check stopped before writer delivery: ${failed}`);
	if (!target || !goal || goal.commit!==(p?.commit??target) || p && p.target!==target || run.join || run.independent || run.conflict || run.blocker ||
		partitionConflict(run,undefined,target) || run.effects.some(e=>e.permissionHold) || run.inspections?.some(i=>i.permissionHold))
		fail("dispatch_held","Wait for the assessed target, join, ownership and permissions before delivering the writer notice");
	verifyContracts(cwd,run.policy,target);
	const {continuation}=stoppedPins(cwd,run,n,[goal.commit],target);
	return {target,p,goal,continuation};
}

/** @param {string} cwd @param {Run} run @param {Node} n @param {string} blob @param {boolean} requested @param {Verify} verify @param {Dependency|undefined} dependency */
function select(cwd,run,n,blob,requested,verify,dependency) {
	const w=referenceAttempt(run,n);
	if (!w || !n.review)
		fail("stale_assignment","Need the original bound writer's ordinary missing-input stop, unchanged assigning review and no component verdict");
	const offer=offerIndex(run,n,blob,requested);
	if (run.effects.some(e=>e.kind==="repair" && e.state!=="withdrawn" && e.input?.assignment===w.id && e.input.blob===blob))
		fail("no_progress","This original writer already received or refused a grant for those bytes");
	if (!dependency && offer<0 || n.stop?.input && n.stop.input.blob!==blob || !dependency && git(cwd,["cat-file","--batch-check=%(objecttype)"],blob+"\n").toString().trim()!=="blob")
		fail("missing_artifact","Need the exact immutable owner reference or a fresh, authorized producer response to this assignment");
	const artifact=run.artifacts?.[offer], source=dependency?.source??artifact?.source;
	if(!dependency && source)verifySource(cwd,run,source,blob,verify);
	if (n.repairs>=run.policy.repairs || !availableReservations(run)) fail("limit","No authorized repair, assignment or worker slot remains");
	const {target,p,goal,continuation}=inputContext(cwd,run,n);
	if(dependency)verifyDependency(cwd,run,n,dependency,blob,verify);
	const facts=releaseFacts(run,target), assessment=run.effects.find(e=>e.id===goal.check), check=p && run.effects.find(e=>e.id===p.check);
	if (assessment?.kind!=="goal" || p && (!facts.exactProduct || check?.kind!=="product") ||
		!(facts.goal==="unmet" || facts.exactProduct && (facts.goal==="missing" || facts.goal==="pending" && pendingGoal(run))))
		fail("stale_assignment","Need a current unmet goal or a checked checkpoint whose goal is pending or missing evidence");
	if (check?.kind==="product") verify(check);
	if (facts.goal!=="pending") verify(assessment);
	/** @type {Input} */ const input={prior:structuredClone(n),assignment:w.id,review:n.review,blob,
		...(dependency ? {dependency} : {offer,...((source || continuation) && {offerDigest:digest(artifact)})}),
		target,goal:goal.check,...(p && {checkpoint:p.check}),requested};
	return {input,continuation};
}

/** @param {Run} run @param {Node} n @param {Input} input @param {import("./model.js").CharterContinuation|undefined} continuation */
function reopen(run,n,input,continuation) {
	const artifact=inputReference(run,input) ?? fail("missing_artifact","The selected reference is unavailable");
	assign(n,"staff");n.token=randomUUID();n.repairs++;
	delete n.stop;delete n.reason;
	const notice=reserveNotice(run,run.owner,n.token,"repair",inputMessage(artifact,n)+continuationNotice(continuation),n);
	notice.input=input;
	if(continuation)notice.continuation=continuation;
	if (run.goal) delete run.goal.stall;
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} args @param {Verify} verify */
export function prepareInput(cwd,run,actor,args,verify) {
	if (actor!==run.owner) fail("foreign_run","Only the run owner can reissue the stopped writer");
	fields(args,["run","grain","blob","inputSource"]);
	const id=name(args.grain,"assignment"), blob=inputBlob(args.blob), locator=args.inputSource===undefined?undefined:sourceLocator(args.inputSource);
	/** @param {Run} r */
	const selected=r=>{
		const n=r.nodes[id]??fail("stale_assignment","Unknown stopped assignment"), match=matchInput(r,n,blob);
		const dependency=locator?pooledDependency(r,n,locator):match.dependency;
		if(locator && !dependency)fail("stale_assignment","Name the file in the original checked input whose producer was pooled");
		const requested=dependency ? !!n.stop?.input?.source && n.stop.input.blob===blob : match.targeted;
		const grant=select(cwd,r,n,blob,requested,verify,dependency);
		return {...grant,satisfied:!grant.continuation && (requested || !locator && match.approved)};
	};
	const {subject:before,revalidate}=pinnedSelection(run,selected,"The stopped writer, original pins or selected input changed during approval");
	const n=before.input.prior,artifact=inputReference(run,before.input);
	return {consent:before.satisfied ? /** @type {const} */("satisfied") : /** @type {const} */("native"),
		prompt:`Does ${JSON.stringify(artifact?.file)} (${blob}) resolve this stop for ${id}, writer ${n.worker}?\n`+
		(artifact && "dependency" in artifact ? `Already granted dependency ${artifact.dependency.source.grain}@${artifact.dependency.source.revision}, signed component ${artifact.dependency.source.component}. Read its checked file; no new publication or writer authority.\n` :
		artifact?.source ? `Producer: ${JSON.stringify(artifact.publisher)}, ${artifact.source.grain} (${artifact.source.assignment}); `+
			`${artifact.source.component ? `checked revision ${artifact.source.revision}, component ${artifact.source.component}` : `read-only draft on generation ${artifact.source.generation}`}. No prerequisite is added or replaced.\n` : "")+
		`Reported need: ${missingInput(n)}\nTask: ${n.grain.task??run.policy.direction}\nScope: ${scopeLabel(n.grain.directory)}; check: ${n.grain.check}; review: ${before.input.review}.\n`+
		"Reissue only this original assignment with one fresh token. The reference is read-only; no check has run."+
		(before.continuation ? "\n"+continuationPrompt(run,n,before.continuation) : ""),
		...(before.continuation && {hold:`A reference cannot authorize a charter change. Request the native input grant to review ${before.continuation.from} → ${before.continuation.to} for ${id}.`}),
		/** @param {Run} current */
		apply(current) {
			const fresh=revalidate(current);
			reopen(current,current.nodes[id],fresh.input,fresh.continuation);
			return ()=>commitAt(cwd,current.policy.target)===before.input.target;
		}};
}

/** @param {Run} run @param {Node} n @param {string} [selected] */
function matchInput(run,n,selected) {
	const last=run.effects.findLast(e=>e.kind==="repair" && e.input?.prior.token===n.token);
	const prior=last?.kind==="repair" && last.state==="withdrawn" ? last.input : undefined;
	const blob=selected??n.stop?.input?.blob??prior?.blob;
	const dependency=pooledDependency(run,n,n.stop?.input?.source??prior?.dependency?.source);
	const targeted=!!blob && n.stop?.input?.blob===blob && (n.stop.input.source && !!dependency || offerIndex(run,n,blob,true)>=0);
	const approved=!!prior && !prior.requested && prior.blob===blob && (prior.dependency ? !!dependency && digest(dependency)===digest(prior.dependency) :
		!prior.offerDigest || prior.offer===offerIndex(run,n,blob,false) &&
		prior.offerDigest===digest(run.artifacts?.[prior.offer])) && run.goal?.target===prior.target &&
		run.goal.check===prior.goal && run.products.at(-1)?.check===prior.checkpoint;
	return {blob,targeted,approved,dependency,pending:!!last && last.state!=="withdrawn"};
}

/** Project facts and a proposal subject, never write authority. @param {Run} run */
export function* inputEvidence(run) {
	if (!run.active) return;
	for (const n of Object.values(run.nodes)) {
		if (!n.token || missingInput(n)===undefined) continue;
		const {blob,targeted,approved,pending}=matchInput(run,n);
		if (blob && !pending) yield {signal:/** @type {const} */ ("reference"),facts:{targeted,approved},attempt:n.token,args:{grain:n.grain.id,blob},
			grant:digest([writerVersion(n),n.stop?.input?.source??null])};
	}
}

/** An unusable, demonstrably unsent notice must not hold a writer slot or prevent target reconciliation.
 * Never withdraw a claimed, uncertain or explicitly denied delivery.
 * @param {string} cwd @param {Run} run @param {import("./model.js").NativeCall} e @param {Verify} verify @param {string} [tip] */
export function deliveryTip(cwd,run,e,verify,tip) {
	const n=e.grain && run.nodes[e.grain],prior=e.input?.prior??e.baselineStop;
	if(!prior || !n || n.state!=="writing" || n.token!==e.token || !unsentRepair(e))return;
	try {
		if(!e.input)return baselineTip(cwd,run,e,verify,tip);
		const {target,continuation}=inputContext(cwd,run,e.input.prior,tip);
		if(digest(continuation??null)!==digest(e.continuation??null))fail("stale_assignment","The approved charter pair changed before delivery");
		const a=inputReference(run,e.input);
		if(e.input.dependency){
			const d=pooledDependency(run,e.input.prior,e.input.dependency.source);
			if(!d || digest(d)!==digest(e.input.dependency))fail("stale_assignment","The original checked dependency is no longer available");
			verifyDependency(cwd,run,e.input.prior,d,e.input.blob,verify);
		}else if(a && !("dependency" in a) && a.source){
			if(e.input.offer===undefined || !currentSupply(run,e.input.prior,a,e.input.offer))fail("stale_assignment","The producer's original source or grant changed before delivery");
			verifySource(cwd,run,a.source,a.blob,verify);
		}
		return target;
	}
	catch (error) {
		if (!(error instanceof FoundryError)) throw error;
		if (["dispatch_held","paused","deadline","contract_hold"].includes(error.code)) return;
		journal(e,e.state==="ordinary"?"withdraw-input":"withdraw");
		if(e.input)e.input.withdrawn=error.message;
		run.nodes[n.grain.id]=structuredClone(prior);
	}
}
