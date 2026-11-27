import { checkReceipt, generationOf, goalReceipt, missingInput, productPin } from "./evidence.mjs";
import { availableReservations } from "./capacity.mjs";
import { continuationPrompt, stoppedPins } from "./continuation.mjs";
import { continuationNotice } from "./reference.mjs";
import { disabledRoute, journal } from "./dispatch.mjs";
import { pendingGoal, releaseFacts } from "./facts.mjs";
import { frozenCheckpoint } from "./goal.mjs";
import { reserveWriter } from "./graph.mjs";
import { admitted } from "./native.mjs";
import { partitionConflict } from "./partition.mjs";
import { originalAttempt, validateNodes } from "./plan.mjs";
import { commitAt, describeInventory, entries, inventory, verifyContracts } from "./product.mjs";
import { awaitingReply, unissued } from "./reservation.mjs";
import { digest, fail, FoundryError, members, names, roots as scopePaths } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {(e:import("./model.js").NativeCall)=>void} Verify */

/** The outstanding call is not evidence. Use its last signed checkpoint and check the
 * pending assembly separately; never issue, retire or settle that call to grant a repair.
 * @param {Run} run @param {string} target @param {Verify} verify */
function concurrentCheckpoint(run,target,verify) {
	const p=run.products.at(-1),goal=run.goal,j=run.join;
	if(!p || !goal || p.target!==target || goal.target!==target || p.commit!==goal.commit || run.independent || run.conflict || run.blocker)return false;
	const facts=releaseFacts(run,target),check=run.effects.find(e=>e.id===p.check),g=run.effects.find(e=>e.id===goal.check);
	if(!facts.exactProduct || check?.kind!=="product" || g?.kind!=="goal" || g.commit!==p.commit ||
		(j || facts.goal!=="unmet") && partitionConflict(run,j?.outputs,target) ||
		!(facts.goal==="unmet" || facts.goal==="missing" || facts.goal==="pending" && (pendingGoal(run) || unissued(g) && !g.permissionHold && !g.error)))return false;
	if(j){
		const job=run.effects.find(e=>e.id===j.check);
		if(j.target!==target || job?.kind!=="product" || job.commit!==j.commit || job.evaluatorRevision!==productPin(run) || job.permissionHold || job.error && !awaitingReply(job) ||
			job.recheck || job.delivery || job.isolation || job.rollout || job.replacement || !(unissued(job) || awaitingReply(job) || checkReceipt(job)?.exit===0))return false;
	}
	verify(check);if(facts.goal!=="pending")verify(g);
	return true;
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {string[]} ids @param {boolean} inspect @param {Verify} verify @param {boolean} [reserved] */
function manifest(cwd, run, actor, ids, inspect,verify,reserved=false) {
	if (actor !== run.owner) fail("foreign_run", "Only the run owner may request a baseline grant");
	admitted(run);
	const goal = run.goal, target = commitAt(cwd, run.policy.target);
	const frozen=goal && goal.target!==target ? frozenCheckpoint(cwd,run,target) : undefined;
	const product=run.products.at(-1);
	const current=goal?.target===target && !run.blocker && !run.conflict && (inspect || (product ? concurrentCheckpoint(run,target,verify) :
		goal.commit===target && !run.join && goalReceipt(run)?.exit===1));
	if (!goal || !frozen && !current)
		fail("stale_assignment", inspect ? "Need the current goal target without a conflict" : "Need a current unmet goal or a compatible checked checkpoint");
	verifyContracts(cwd, run.policy, goal.target);
	if (!ids.length) fail("invalid_field", "Select at least one blocked assignment");
	if (!inspect && !reserved && ids.length > availableReservations(run))
		fail("limit", "Select assignments within the remaining worker and assignment limits");
	return ids.map(id => {
		const n = run.nodes[id], launch = n && originalAttempt(run, n);
		if (!n?.worker || n.state !== "blocked" || !n.generation || !n.token || !n.base || n.check || n.candidate ||
			missingInput(n) === undefined || !launch ||
			run.effects.some(e => (e.issuer === actor || e.issuer === n.worker) && e.permissionHold) ||
			run.inspections?.some(i=>(i.issuer===actor || i.issuer===n.worker) && i.permissionHold))
			fail("stale_assignment", `${id}: not an original bound missing-input attempt`);
		if(!inspect && (launch.error || generationOf(launch)!==n.generation || launch.production || launch.observer || launch.restoration || launch.reuse ||
			n.retained || n.restoration || n.reuse || n.successor || n.excluded || run.join && Object.hasOwn(run.join.outputs,id)))
			fail("stale_assignment",`${id}: the original writer grant is not an independent baseline repair`);
		if(!inspect && n.stop?.input?.source)fail("stale_assignment",`${id}: the writer requested a specific producer; its own baseline is not that reference`);
		if (inspect && launch.readGrant) fail("already_approved", `${id}: inspection already approved; check writer status`);
		if (!inspect && n.repairs >= run.policy.repairs) fail("limit", `${id}: repair limit exhausted`);
		if (!inspect && n.grain.revision && n.grain.revision !== n.base) fail("stale_assignment", `${id}: a grant cannot replace the assignment's explicit revision`);
		const {inputs,continuation}=inspect ? {inputs:n.inputs,continuation:undefined} :
			stoppedPins(cwd,run,n,[goal.commit,...(run.join?[run.join.commit]:[])]);
		if (!inputs) fail("stale_assignment", `${id}: a pinned prerequisite changed`);
		const directory = n.grain.directory, revision = n.grain.revision ?? n.base, baseline = inventory(cwd, revision, directory);
		const pinned = (/** @type {import("./model.js").Inventory|undefined} */ source) => members(source ?? []).map(b=>[b.directory,b.tree]);
		const unchanged = (/** @type {string} */ commit) => digest(pinned(inventory(cwd,commit,directory)))===digest(pinned(baseline));
		if (!baseline || (inspect || frozen || continuation) && (!n.priorSource || digest(n.priorSource) !== digest(baseline)) ||
			!unchanged(goal.commit) || run.join && !unchanged(run.join.commit) ||
			entries(cwd, revision, true, scopePaths(directory)).some(e => !["100644", "100755"].includes(e.mode)))
			fail("stale_assignment", `${id}: need the original unchanged regular-file inventory`);
		return {id,launch,token:n.token,worker:n.worker,generation:n.generation,inputs,specification:n.grain.specification,baseline,revision,continuation,
			target,base:n.base,assignment:digest(n),contract:run.policy.contractTarget,productPin:productPin(run),goalPin:run.repins?.at(-1)?.revision,
			...(inspect || frozen ? {checkpoint:product?.check,goal:goal.check} : {})};
	});
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {unknown} selections @param {boolean} inspect @param {Verify} verify */
export function prepareBaselines(cwd, run, actor, selections, inspect,verify) {
	const ids = names(selections, "blocked assignment"), before = manifest(cwd, run, actor, ids, inspect,verify);
	return {
		consent:inspect?/** @type {const} */("policy"):/** @type {const} */("native"),
		wake:inspect?/** @type {const} */("none"):/** @type {const} */("recover"),
		prompt: `Run ${run.id}: ` + (inspect ? "allow these writers read-only inspection of their own prior directories?"
			: "give each original writer one bounded repair using its prior directory as a read-only reference?") + "\n" +
			before.map(({ id, worker, baseline, specification, base,continuation }) => `${id} (${worker}): ${describeInventory(baseline)}; charter: ${base}:${specification}`+
				(continuation ? "\n"+continuationPrompt(run,run.nodes[id],continuation) : "")).join("\n") +
			"\nApprove only if the charter omitted this permission, not if it forbids the read." +
			(inspect ? " Inspection only: no repair, new token, edits or submission. Writers remain blocked." :
				" An unrelated product or goal may finish while this form is open. Revalidate these exact writer, inventory, contract and input pins; do not change or replay that check."),
		/** @param {Run} live */
		apply(live) {
			if (commitAt(cwd,live.policy.target)!==before[0].target) fail("stale_assignment","The current goal target moved during baseline approval");
			const fresh = manifest(cwd, live, actor, ids, inspect,verify);
			if (digest(fresh) !== digest(before)) fail("stale_assignment", "The approved assignments or baseline pins changed");
			if (inspect) {
				for (const row of fresh) row.launch.readGrant = row.baseline;
			} else {
				for (const row of fresh){
					const n=live.nodes[row.id],prior=structuredClone(n);
					reserveWriter(cwd,live,n,row.inputs,row.revision,actor,undefined,row.baseline);
					const notice=live.effects.at(-1);
					if(notice?.kind!=="repair" || notice.grain!==row.id || notice.token!==n.token || !notice.baseline)
						throw Error("Missing same-writer baseline notice");
					notice.baselineStop=prior;
					if(row.continuation){
						notice.continuation=row.continuation;
						notice.args.message+=continuationNotice(row.continuation);
					}
				}
				validateNodes(live.nodes);
				if (live.goal) delete live.goal.stall;
			}
			return () => commitAt(cwd, live.policy.target) === before[0].target;
		}
	};
}

/** A charter exception is never sticky. Recheck an unsent baseline on the live
 * assembly just as on the form, without purchasing another reservation.
 * @param {string} cwd @param {Run} run @param {import("./model.js").NativeCall} e @param {Verify} verify */
export function baselineTip(cwd,run,e,verify){
	const prior=e.baselineStop,n=e.grain && run.nodes[e.grain];
	if(!prior || !e.continuation || !n || n.token!==e.token || n.state!=="writing" || e.permissionHold ||
		!(e.state==="ready" && !e.callId || e.state==="ordinary" && e.callId && e.error===disabledRoute))return;
	try {
		if(!run.active || run.effects.some(x=>x.permissionHold && (x.issuer===run.owner || x.issuer===n.worker)) ||
			run.inspections?.some(i=>i.permissionHold && (i.issuer===run.owner || i.issuer===n.worker)))return;
		if(commitAt(cwd,run.policy.target)!==e.continuation.target)fail("stale_assignment","The target changed before delivery of the approved charter continuation");
		if(run.conflict || run.blocker || run.independent || run.join && Object.hasOwn(run.join.outputs,n.grain.id))return;
		const original={...run,nodes:{...run.nodes,[n.grain.id]:prior},effects:run.effects.filter(x=>x!==e)};
		const [row]=manifest(cwd,original,run.owner,[n.grain.id],false,verify,true);
		if(digest(row.continuation??null)!==digest(e.continuation) || digest(row.baseline)!==digest(e.baseline))
			fail("stale_assignment","The approved charter pair or baseline changed before delivery");
		return row.target;
	} catch(error){
		if(!(error instanceof FoundryError))throw error;
		if(["dispatch_held","paused","deadline","contract_hold"].includes(error.code))return;
		journal(e,e.state==="ordinary"?"withdraw-input":"withdraw");
		run.nodes[n.grain.id]=structuredClone(prior);
	}
}
