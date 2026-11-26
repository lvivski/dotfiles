import { assign } from "./assignment.mjs";
import { availableReservations, remainingAssignments } from "./capacity.mjs";
import { checkReceipt, currentEvaluation, launcherFailure, productPin } from "./evidence.mjs";
import { undecided } from "./facts.mjs";
import { assess, observeTarget } from "./goal.mjs";
import { changes, productBase, verifyJoinedInputs, verifyRepairInputs } from "./graph.mjs";
import { admitted, reserveCheck, reserveProduct } from "./native.mjs";
import { productOutputs, working, writerInputs } from "./plan.mjs";
import { combine, commitAt, retain } from "./product.mjs";
import { digest, fail } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Call */
/** @typedef {{kind:"component"|"product"|"goal",commit:string,target:string,pin:string,productPin:string,issuer:string,
 * basis:string,outputs?:Record<string,string>}} Selection */
/** @param {string} cwd @param {Run} r @param {string} actor @param {string} id @param {(e:Call)=>void} signed */
function selection(cwd,r,actor,id,signed) {
	if (actor !== r.owner) fail("foreign_run","Only the run owner can request a fresh observation");
	if (r.effects.some(e=>e.tool==="bash" && e.recheck?.of===id)) return;
	admitted(r);
	const e = r.effects.find(x=>x.id===id);
	if (e?.kind==="component" && (e.pair || e.observer || e.remedy)) fail("not_recoverable","A paired, production or observer observation is not repeatable");
	if (e?.tool!=="bash" || !e.callId || !e.commit || e.args.shellId!==`foundry-${id}` ||
		r.effects.some(x=>x!==e && x.issuer===e.issuer && (x.callId===e.callId || x.args.shellId===e.args.shellId)))
		fail("not_recoverable","Need the exact original check and its unique native call");
	const exit = launcherFailure(e), receipt = checkReceipt(e);
	if (exit === undefined) {
		if (e.kind!=="goal" || !e.runnerClaim || receipt?.exit!==null)
			fail("not_recoverable","Need a confirmed pre-claim launcher exit or the original signed null goal outcome; never repeat an unknown call");
		signed(e);
	}
	const { target, error } = observeTarget(()=>commitAt(cwd,r.policy.target));
	if (target===undefined) fail("target_unavailable",error);
	const at = r.goal, last = r.products.at(-1), join = r.join;
	const hold = receipt ? undecided(receipt) : e.error;
	const goalOwns = e.kind==="goal" && at?.check===id;
	const joinOwns = e.kind==="product" && join?.check===id && hold!==r.effects.find(x=>x.id===at?.check)?.error;
	if (r.blocker && (!(goalOwns || joinOwns) || r.blocker!==hold) || r.conflict ||
		r.effects.some(x=>x.permissionHold) || join && join.check!==id)
		fail("dispatch_held","Resolve the unrelated run, join or permission hold first");
	const pin = r.repins?.at(-1)?.revision ?? r.policy.base, base = productBase(cwd,r,target);
	const inputs = {target,pin,productPin:productPin(r) ?? r.policy.base,issuer:actor};
	/** @type {Selection} */
	let next;
	if (e.kind==="component") {
		const n = e.grain && r.nodes[e.grain];
		if (!n || n.check!==id || n.candidate!==e.commit || n.reason!==e.error || !n.reason || n.stop ||
			n.worker!==e.issuer || n.grain.check!==e.check || n.state!=="blocked" || !n.token || !n.generation ||
			at && (at.target!==target || !currentEvaluation(r,r.effects.find(x=>x.id===at.check))))
			fail("stale_assignment","Need the same blocked writer, candidate, contract and current assessed target");
		if (!availableReservations(r,Infinity) || Object.values(r.nodes).some(x=>x.worker===n.worker && working(x)))
			fail("limit","No worker slot is free for the frozen component observation");
		const required = writerInputs(r.nodes,{...n,state:"waiting"}) ?? fail("stale_assignment","The component prerequisites are no longer checked");
		verifyRepairInputs(cwd,r,n,required,base);
		next = {...inputs,kind:"component",issuer:n.worker,commit:e.commit,basis:digest([n,base,required])};
	} else {
		if (e.kind==="product" ? !join || join.check!==id || join.commit!==e.commit || e.check!==r.policy.productCheck :
			e.kind!=="goal" || !at || at.check!==id || at.commit!==e.commit || e.check!==r.policy.goalCheck)
			fail("stale_assignment","The check is not the current product or goal assessment");
		if (r.productRepins?.at(-1)?.recheck===id)
			fail("dispatch_held","Product pin approval requires its exact original verification; it cannot be replaced by a generic recheck");
		const outputs = productOutputs(r,target,remainingAssignments(r));
		// On a moved baseline with no outputs, assess today's target. With any earned
		// outputs, verify their actual rejoin before asking the goal about those bytes.
		if (e.kind==="goal" && (!outputs || !last && !Object.keys(outputs).length)) {
			next = {...inputs,kind:"goal",commit:base,basis:digest([at,last])};
		} else {
			if (!outputs) fail("stale_assignment","No current joinable product for this check");
			const same = join && join.target===target && digest(join.outputs)===digest(outputs);
			const commit = same ? join.commit : combine(cwd,base,changes(r,outputs),target);
			verifyJoinedInputs(cwd,r,outputs,base,commit);
			next = {...inputs,kind:"product",commit,outputs,basis:digest([at,last,join,base])};
		}
	}
	return {e,next};
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {string} id @param {(e:Call)=>void} signed */
export function prepareRecheck(cwd,run,actor,id,signed) {
	const selected = selection(cwd,run,actor,id,signed);
	if (!selected) return;
	const {next} = selected;
	return {
		/** @param {Run} r */
		apply(r) {
			const live = selection(cwd,r,actor,id,signed);
			if (!live) return;
			if (digest(live)!==digest(selected)) fail("stale_assignment","Check, candidate, target or evaluator changed before reservation");
			const {e} = live;
			if (e.kind!=="component") delete r.blocker; // selection proved ownership, including legacy product diagnostics.
			if (next.kind==="component") {
				if (!e.grain) fail("invalid_check","Missing original component");
				const n = r.nodes[e.grain];
				if (r.goal) delete r.goal.stall; // Its no-work conclusion no longer includes this eligible component.
				assign(n,"recheck");
				n.check = reserveCheck(r,next.issuer,cwd,next.commit,n.grain.check,e.grain,{
					...(e.usedArtifacts && {usedArtifacts:e.usedArtifacts}),...(e.comparedArtifacts && {comparedArtifacts:e.comparedArtifacts})});
			} else if (next.kind==="product") {
				if (!next.outputs) fail("invalid_check","Missing verified join inputs");
				reserveProduct(r,actor,cwd,next.target,next.commit,next.outputs);
			} else assess(cwd,r,actor,next.target,retain(cwd,next.commit));
			const fresh = r.effects.at(-1);
			if (fresh?.tool!=="bash") fail("invalid_check","Missing fresh observation reservation");
			fresh.recheck = {of:id,target:next.target,goalPin:next.pin,productPin:next.productPin};
			return () => { admitted(r); return observeTarget(()=>commitAt(cwd,r.policy.target)).target===next.target; };
		}
	};
}

/** Issuer permission reads and, for a component, a writer turn can intervene after
 * reservation. A reserved observation is not permission to check different inputs.
 * @param {string} cwd @param {Run} r @param {Call} e */
export function checkAuthority(cwd,r,e) {
	const a=e.recheck;
	if (!a || a.goalPin!==(r.repins?.at(-1)?.revision ?? r.policy.base) || a.productPin!==(productPin(r) ?? r.policy.base) ||
		r.blocker || r.conflict || r.effects.some(x=>x.permissionHold) ||
		observeTarget(()=>commitAt(cwd,r.policy.target)).target!==a.target) return false;
	if (e.kind==="component") {
		const n=e.grain && r.nodes[e.grain];
		if (!n || n.check!==e.id || r.join) return false;
		const required=writerInputs(r.nodes,{...n,state:"waiting"});
		if (!required || digest(required)!==digest(n.inputs)) return false;
		verifyRepairInputs(cwd,r,n,required,productBase(cwd,r,a.target));
	} else if (e.kind==="product") {
		const j=r.join, outputs=productOutputs(r,a.target,remainingAssignments(r));
		if (!j || j.check!==e.id || !outputs || digest(outputs)!==digest(j.outputs)) return false;
		verifyJoinedInputs(cwd,r,outputs,productBase(cwd,r,a.target),j.commit);
	} else if (r.join || r.goal?.target!==a.target || r.goal.check!==e.id) {
		return false;
	}
	return true;
}
