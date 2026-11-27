import { admissionPolicy } from "./admission.mjs";
import { assign, working } from "./assignment.mjs";
import { activate } from "./activity.mjs";
import { checkpointReceipt, checkReceipt, currentEvaluation, goalReceipt, leadGoal, milestoneBlocker, passingCheck, productPin } from "./evidence.mjs";
import { remainingAssignments } from "./capacity.mjs";
import { decisionOf, release, releasePreflight, releaseResolution, releaseState, transition } from "./engine.mjs";
import { transition as next } from "./machine.mjs";
import { executor } from "./adapter.mjs";
import { pendingGoal, releaseFacts, undecided } from "./facts.mjs";
import { expired, reserveCheck, reserveNotice, reserveProduct } from "./native.mjs";
import { workKey } from "./plan.mjs";
import { partitionConflict } from "./partition.mjs";
import { heldRepair } from "./successor.mjs";
import { contractConflict, descendsFrom, retain, treeOf, verifyContracts } from "./product.mjs";
export { frozenCheckpoint } from "./frozen.mjs";
import { blockReview, checkpointWake, comparison, obstructed, reading, reviews } from "./reviews.mjs";
import { deadlineAt, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {string} cwd @param {Run} run @param {string} actor @param {string} target @param {string} commit */
export function assess(cwd, run, actor, target, commit) {
	verifyContracts(cwd, run.policy, target);
	run.goal = { target, commit, check: reserveCheck(run, actor, cwd, commit, text(run.policy.goalCheck, "goal evaluator")) };
	for (const r of reviews(run)) if (r.state === "ready" && r.base !== commit)
		blockReview(r, "Reviewed revision was superseded before dispatch");
}

/** Publish the timestamp and owner notification in the same transition as the exact receipt.
 * @param {Run} run @param {string} actor @param {import("./model.js").Product} product */
function handoff(run, actor, product) {
	product.qualifiedAt = Date.now();
	const exclusions = [];
	if (run.goal) {
		const budget = remainingAssignments(run);
		for (const n of Object.values(run.nodes)) if (n.state === "blocked" || n.state === "waiting") {
			if (n.candidate && product.outputs[n.grain.id] === n.candidate) continue;
			exclusions.push(`${n.grain.id}: ${n.reason ?? (budget ? "No reachable prerequisite" : "No assignment remains")}`);
		}
		if (!budget) for (const r of new Map(reviews(run).filter(r => currentEvaluation(run,r)).map(r => [r.squad,r])).values()) {
			if (r.base === product.commit && r.state === "observed" && r.observation?.outcome === "needs-evidence")
				exclusions.push(`Review ${r.id}: no assignment remains for the requested evidence follow-up`);
		}
	}
	reserveNotice(run, actor, product.check, "handoff",
		`Foundry ${run.id} qualified ${product.commit}. The target was not changed. Read foundry_status({run:"${run.id}"}) for the checked product and its receipts.` +
		(exclusions.length ? `\nNot included in this release:\n${exclusions.join("\n")}` : ""));
}

/** Shared, read-only preflight. Re-evaluate the current tip, not yesterday's persisted conflict.
 * @param {()=>string} tip */
export function observeTarget(tip) {
	try { return { target:tip() }; }
	catch (error) {
		if (!(error instanceof Error && "status" in error)) throw error;
		return { error:`Target unavailable: ${error.message}` };
	}
}

/** Never infer when an older receipt finished. Only completed observations, not a
 * reservation or a native success, can be settled after the clock expires.
 * @param {Run} run */
export function timelyChecks(run) {
	const until=run.policy.deadline && deadlineAt(run.policy.deadline), product=run.join ?? run.products.at(-1);
	if (typeof until!=="number" || !product || product.commit!==run.goal?.commit || product.target!==run.goal.target || run.blocker || run.conflict ||
		run.effects.some(e=>e.permissionHold)) return false;
	const effect=run.effects.find(e=>e.id===product.check), goal=goalReceipt(run);
	if (effect?.kind!=="product" || effect.commit!==product.commit || effect.check!==run.policy.productCheck ||
		effect.evaluatorRevision!==productPin(run)) return false;
	const milestone=checkReceipt(effect);
	return [goal,milestone].every(r=>r?.exit===0 && r.completedAt!==undefined && r.completedAt<until);
}

/** An automatic survey belongs to the signed checkpoint and goal, not to the tip of the delivery branch.
 * Explicit comparisons, retries and grants keep their own live-target checks.
 * @param {Run} run @param {import("./model.js").Review|undefined} r */
export const checkpointSurvey = (run,r) => !!r?.lead && !r.retryOf && !r.correction && !comparison(run,r) &&
	r.base===run.goal?.commit && leadGoal(r.lead)===run.goal?.check && r.lead.checkpoint===run.products.at(-1)?.check && currentEvaluation(run,r);

/** @param {string} cwd @param {Run} run @param {string} target */
export function movingSurvey(cwd,run,target) {
	const p=run.products.at(-1), at=run.goal;
	if (!p || !at || p.target===target || p.qualifiedAt || p.target!==at.target || p.commit!==at.commit ||
		run.join || run.independent || run.blocker || !checkpointReceipt(run,p.check,p.commit) ||
		!(pendingGoal(run) || goalReceipt(run)?.exit===2) || partitionConflict(run,undefined,p.target)) return;
	const history=reviews(run).filter(r=>currentEvaluation(run,r));
	const unfinished=new Set(Object.values(run.nodes).filter(n=>working(n) || n.state==="waiting" || n.state==="published").map(n=>n.review));
	const latest=new Map(history.map(r=>[r.squad,r]));
	const pending=history.some(r=>{
		if (!checkpointSurvey(run,r)) return false;
		if (unfinished.has(r.id)) return true;
		if (latest.get(r.squad)!==r) return false;
		if (reading(r) || r.state==="reported" || r.state==="blocked" && obstructed(r,"stale-review")) return true;
		return r.state==="observed" && (r.observation?.ownerInput && !r.decision ||
			checkpointWake(run,history.filter(h=>h.squad===r.squad),p.commit,r.version));
	});
	if (pending && descendsFrom(cwd,target,p.target)) return p;
}

/** @typedef {import("./model.js").Product} Product */
/** @typedef {import("./engine.mjs").Decision} Decision */
/** @typedef {{run:Run,actor:string,cwd?:string,target?:string,error?:string,product?:Product}} Bindings */
/** @typedef {{cwd:string,run:Run,actor:string,target:string,at:NonNullable<Run["goal"]>,last?:Product}} ReleaseContext */

/** @param {string} cwd @param {Run} run @param {()=>string} tip @param {boolean} retry */
function releasePlan(cwd,run,tip,retry) {
	const elapsed=expired(run);
	/** @type {string|undefined} */ let target;
	/** @type {string|undefined} */ let ownership;
	/** @type {Product|undefined} */ let survey;
	/** @type {ReturnType<typeof releaseResolution>|undefined} */ let ordinary;
	let scoped=false;
	const live=()=>text(target,"observed release target");
	const contracts=()=>{
		const error=contractConflict(cwd,run.policy,live());
		return {target,contractChanged:!!error,...(error && {error})};
	};
	// Each read supplies evidence only for the phase the machine actually reached.
	/** @satisfies {Record<Exclude<keyof typeof releasePreflight.states,"decided"|"cleared">,()=>import("./machine.mjs").Facts>} */
	const read={
		clock:()=>({expired:elapsed,timely:elapsed && timelyChecks(run)}),
		target(){
			const seen=observeTarget(tip), s=run.independent;
			target=seen.target;
			const isolation=s && target!==undefined && `Non-release checkpoint ${s.product}; ownership remains held at ${s.checkpoint} by failed observer ${s.observer}.`+
				(target===s.target?"":` Approved target ${s.target} is not current (${target}); no check can advance on this target.`);
			return {...seen,...(target===undefined && {error:seen.error}),...(isolation && {error:isolation}),available:target!==undefined,independent:!!s,active:run.active};
		},
		partition(){
			ownership=partitionConflict(run,undefined,live());
			return {expired:elapsed,ownershipConflict:!!ownership};
		},
		survey(){
			survey=movingSurvey(cwd,run,live());
			return {movingSurvey:!!survey};
		},
		contracts:()=>({...contracts(),ownershipConflict:!!ownership}),
		frozen(){
			const workTarget=text(survey?.target,"signed survey target");
			const mode=admissionPolicy(transition(releaseFacts(run,workTarget)).admission);
			return {...contracts(),workTarget,checkpointWriters:mode.scoped && mode.writers==="eligible",changedJoin:mode.join==="changed",
				published:Object.values(run.nodes).some(n=>n.state==="published")};
		},
		"repair-admission"(){
			const mode=admissionPolicy(transition(releaseFacts(run,live())).admission);
			scoped=mode.scoped;
			return {target,error:ownership,sameTarget:run.goal?.target===target,joining:!!run.join,blocked:!!run.blocker,
				recordedConflict:!!run.conflict,permissionHold:run.effects.some(e=>e.permissionHold),eligibleWriters:mode.writers==="eligible"};
		},
		repairs:()=>({target,error:ownership,scoped,designatedRepair:Object.values(run.nodes).some(n=>heldRepair(run,n))}),
		goal(){
			ordinary=releaseResolution(releaseFacts(run,live()),retry,target);
			const edge=ordinary.edge;
			return {target,expired:elapsed,settlesAfterExpiry:!!edge && "settlesAfterExpiry" in edge && edge.settlesAfterExpiry===true};
		},
	};
	/** @param {{value:string,context:Decision|null}} snapshot */
	function inspect(snapshot) {
		if (!Object.hasOwn(read,snapshot.value)) throw Error(`Missing release observation: ${snapshot.value}`);
		const observation={type:"inspect",...read[/** @type {keyof typeof read} */ (snapshot.value)]()};
		return next(releasePreflight,snapshot,observation,observation,true);
	}
	let selected=inspect({value:releasePreflight.initial,context:null});
	while (selected.snapshot.value!=="decided" && selected.snapshot.value!=="cleared") selected=inspect(selected.snapshot);
	if (selected.snapshot.value==="decided") return {selected,perform:applyPreflight};
	if (!ordinary) throw Error("Cleared preflight without an inspected release decision");
	return {selected:ordinary,perform:applyRelease};
}

/** @param {string} cwd @param {Run} run @param {()=>string} tip @param {boolean} [retry] */
export function releaseAssessment(cwd,run,tip,retry=false) {
	return decisionOf(releasePlan(cwd,run,tip,retry).selected);
}

/** @type {Record<Exclude<import("./engine.mjs").Action,"wait"|"none">,(c:ReleaseContext)=>void>} */
const goalActions={
	assess({cwd,run,actor,at,last}) {
		delete run.blocker;
		assess(cwd, run, actor, last?.target ?? at.target, last?.commit ?? at.commit);
	},
	retry({cwd,run,actor,target,at}) {
		if (!milestoneBlocker(run)) delete run.join;
		assess(cwd, run, actor, target, at.commit);
	},
	undecided({run}) {
		const receipt = goalReceipt(run);
		if (receipt) run.blocker = undecided(receipt);
	},
	"assess-target"({cwd,run,actor,target}) {
		delete run.join;
		assess(cwd, run, actor, target, retain(cwd, target));
	},
	rejoin({at}) {delete at.stall;},
	qualify({run,actor,last}) {
		if (!last) throw Error("Missing checked product for qualification");
		handoff(run, actor, last);
		activate(run,"goal-met");
		for (const r of reviews(run).filter(reading)) blockReview(r, "Goal met; no further review is needed");
	},
	baseline({cwd,run,actor,target,at}) {reserveProduct(run,actor,cwd,target,at.commit,{});},
};

/** @param {(c:ReleaseContext)=>void} effect */
const forGoal=effect=>(/** @type {Bindings} */ {run,actor,cwd,target,product})=>{
	if (cwd===undefined || target===undefined || !run.goal) throw Error("Missing goal inputs for release effect");
	effect({run,actor,cwd,target,at:run.goal,last:product});
};
const applyRelease=executor(release,{
	...Object.fromEntries(Object.entries(goalActions).map(([name,effect])=>[name,forGoal(effect)])),
	"handoff-product"(/** @type {Bindings} */ {run,actor,product}) {
		if (!product) throw Error("Missing settled product for handoff");
		handoff(run,actor,product);
	},
});
const applyPreflight=executor(releasePreflight,{
	rejoin:forGoal(goalActions.rejoin),
	"record-contract-conflict"(/** @type {Bindings} */ {run,error}) {run.conflict=text(error,"conserved contract conflict");},
});

/** Called while settling a checked join without a goal. Handoff does not deactivate these runs.
 * @param {Run} run @param {string} actor @param {Product} product @param {string} target */
export function qualify(run,actor,product,target) {
	const check=run.effects.find(e=>e.id===product.check);
	const selected=next(release,{value:releaseState(releaseFacts(run,target)),context:null},{type:"product-settled"},{
		oneOff:!run.policy.goalCheck,currentJoin:run.join===product && product.target===target,signedProduct:check?.evaluatorRevision===productPin(run) &&
			!!passingCheck(check,"product",product.commit,run.policy.productCheck),
		alreadyHandedOff:!!product.qualifiedAt,held:!!(run.blocker || run.conflict || run.independent || check?.error || check?.permissionHold),
	},true);
	applyRelease(selected,{run,actor,product});
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {()=>string} tip @param {boolean} retry */
export function applyGoal(cwd, run, actor, tip, retry) {
	const {selected,perform}=releasePlan(cwd,run,tip,retry), decision=decisionOf(selected);
	perform(selected,{cwd,run,actor,target:decision.target,error:decision.error,product:run.products.at(-1)});
	return decision;
}

/** A new assignment or report is not progress if it reproduces an already assessed tree.
 * @param {string} cwd @param {Run} run @param {string} target @param {string} commit @param {Record<string,string>} outputs */
export function rejectRepeat(cwd, run, target, commit, outputs) {
	if (run.goal?.target !== target) return;
	const receipt = run.effects.find(e => e.kind === "goal" && currentEvaluation(run,e) && e.check === run.policy.goalCheck && checkReceipt(e)?.exit === 1 &&
		(e.commit === commit || e.commit === target && treeOf(cwd, commit) === treeOf(cwd, target)))?.receipt;
	if (!receipt) return;
	const tried = new Set(run.goal.tried);
	for (const id of Object.keys(outputs)) {
		const n = run.nodes[id];
		if (n.state !== "published") continue;
		if (n.grain.task) tried.add(workKey(n.grain, text(n.base, "producer base"), n.inputs));
		assign(n,"repeat");
	}
	if (tried.size) run.goal.tried = [...tried];
	return receipt;
}

/** @param {Run} run @param {string} why @param {import("./model.js").Receipt} receipt */
export function stall(run, why, receipt) {
	if (!run.goal) return;
	const decisions = reviews(run).filter(r => r.base === run.goal?.commit).map(r =>
		`${r.squad}: ${r.error ?? r.observation?.reason}`);
	const blocked = Object.entries(run.nodes).filter(([, n]) => n.state === "blocked").map(([id, n]) => `${id}: ${n.reason}`);
	run.goal.stall = [`Goal unmet at ${receipt.commit}: ${receipt.output.trim() || `${receipt.check} exited 1`}.`, why, ...decisions, ...blocked].join("\n");
}
