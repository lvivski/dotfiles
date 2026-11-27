import { projectBoard } from "./projection.mjs";
import { assignmentCount } from "./capacity.mjs";
import { checkReceipt, goalReceipt, milestoneBlocker, missingObservation, originalVerification, qualifiedProduct, verification } from "./evidence.mjs";
import { timingFacts } from "./metrics.mjs";
import { current, expired } from "./native.mjs";
import { awaitingReply, unissued } from "./reservation.mjs";
import { checked, liveNeeds } from "./plan.mjs";
import { questions, reviews, reviewStatus } from "./reviews.mjs";
import { fail } from "./values.mjs";
import { grant } from "./transfer.mjs";
import { currentOffer } from "./offers.mjs";
import { contractHold } from "./contract.mjs";
import { unprovenExports } from "./attestation.mjs";
import { effectAt, heldOutcome, integrityHolds } from "./revision.mjs";
import { legacyWait } from "./abi.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {import("./model.js").NativeCall} e */
function attempt(e) {
	const receipt=e.kind!=="rerun" || e.runnerClaim ? checkReceipt(e) : undefined;
	return {check:e.id,commit:e.commit,kind:e.delivery ? /** @type {const} */ ("delivery") : e.kind, ...(e.rerun && {original:e.rerun.of,after:e.rerun.after ?? e.rerun.of}),
		status:receipt ? receipt.exit===0 ? "passed" : receipt.exit===2 || receipt.exit===null ? "unavailable" : "failed" :
			e.state==="refused" ? "refused" : e.launcherExit || e.state==="done" ? "unavailable" :
			e.state==="uncertain" ? "unconfirmed" : e.runnerStarted ? "running" : "pending",
		...(receipt && {exit:receipt.exit})};
}
/** Ledger-only facts shared by the board and chat. Nodes and effects stay inside the
 * query; each surface projects only the fields it exposes.
 * @param {Run} run @param {string} actor @param {boolean} [history] */
export function visible(run, actor, history=true) {
	const owner = run.owner === actor;
	let nodes = Object.values(run.nodes).filter(n => n.state !== "idle" && (owner || n.worker === actor));
	if (!owner && nodes.length>1 && nodes.some(n=>n.state!=="qualified"))
		nodes = nodes.filter(n=>n.state!=="qualified");
	if (!owner && !nodes.length && !run.effects.some(e => e.nativeId === actor))
		fail("foreign_run", "No bound assignment in this run. If you are the original writer of an uncertain launch, run get_session on yourself, then foundry_claim with the run and token from your kickoff. Do not relaunch or submit until bound.");

	const pending = run.effects.filter(e => (owner || e.issuer === actor) && e.state !== "done" && (awaitingReply(e) || current(run, e)));
	const unconfirmed = new Set(pending.flatMap(e => e.kind === "writer" && e.state === "uncertain" && e.token ? [e.token] : []));
	const writerAssignments = { bound: 0, pending: 0, unconfirmed: 0, sessionActivity: "not-observed" };
	for (const n of nodes) {
		const binding = writerBinding(n, unconfirmed);
		if (binding) writerAssignments[binding]++;
	}
	const receipts = {get:(/** @type {string} */ id)=>{const e=history && effectAt(run,id);return e && !heldOutcome(e)?e.receipt:undefined;}};
	const inspections = new Map((history?run.inspections??[]:[]).map(i=>[i.component,i]));
	/** @type {Map<string,ReturnType<typeof attempt>[]>} */ const attempts=new Map();
	if(history)for (const e of run.effects) if ((e.kind==="component" || e.kind==="rerun") && e.grain && (owner || e.issuer===actor)) {
		const history=attempts.get(e.grain) ?? [];
		history.push(attempt(e)); attempts.set(e.grain,history);
	}
	const missing = missingObservation(run);
	const assignments = run.policy.assignments === undefined ? undefined : { limit: run.policy.assignments, used: assignmentCount(run) };
	const qualified = qualifiedProduct(run), finished = (run.goal || run.policy.seed) && qualified;
	const quarantine=contractHold(run),unproven=unprovenExports(run);
	const stop = !finished && assignments && assignments.used === assignments.limit
		? `Total assignment limit reached (${assignments.used}/${assignments.limit}); no new scouts, writers or repairs. Reserved work and checks can finish.` : undefined;
	const pin = run.repins?.at(-1)?.revision;
	const previous = pin && owner ? pending.find(e => e.id === run.goal?.check && e.evaluatorRevision !== pin &&
		e.runnerStarted && awaitingReply(e) && !e.receipt && !e.permissionHold) : undefined;
	const upgrading = run.join?.check && verification(run.productRepins?.at(-1)) === originalVerification(run,run.join.check);
	const retired=run.effects.find(e=>e.tool==="bash" && e.lane && !e.receipt && (unissued(e) || awaitingReply(e)));
	const linked=new Set(run.effects.flatMap(e=>e.tool==="bash" && e.attempt?.version===2 && e.attempt.previous?[e.attempt.previous]:[]));
	const historical=run.effects.flatMap(e=>{
		const reason=e.tool==="bash" && !linked.has(e.id) && (owner || e.issuer===actor) && legacyWait(e);
		return reason?[{check:e.id,reason}]:[];
	});
	const integrity=integrityHolds(run).filter(h=>owner || effectAt(run,h.effect)?.issuer===actor);
	const repair=run.testRepairs?.find(j=>j.state==="held" && (run.goal?.check===j.stop || run.join?.check===j.stop || run.nodes[j.grain??""]?.check===j.stop ||
		run.effects.some(e=>e.kind==="component" && e.id===j.stop && e.rollout && run.adoptions?.some(a=>a.id===e.rollout && a.failed===run.join?.check))));
	const blocker = quarantine ?? (unproven.length ? `Handoff withheld: historical check ${unproven.join(", ")} does not establish the approved evaluator inputs. Resume this same run on its original target for fresh product and goal evidence.` : undefined) ??
		run.pauseReason ?? run.blocker ?? run.conflict ?? (retired && `Historical desktop reservation ${retired.id} cannot start under this reader. No permission or verdict was carried forward.`) ??
		run.testRepairs?.find(j=>j.wait)?.wait ?? (repair && `Test repair held (${repair.rule.check}): ${repair.reason}`) ?? (upgrading ? milestoneBlocker(run) : run.goal?.stall) ?? (previous
		? `Approved evaluator ${pin} is waiting for the receipt of superseded goal ${previous.id} in session ${previous.issuer}. Verify the original runner before intervening; do not replay it.`
		: missing ? `Goal check at ${missing.commit} awaits external evidence (exit 2): ${missing.output.trim() || "no diagnostic"}. After supplying it, use /foundry resume ${run.policy.source}.` : milestoneBlocker(run));
	const openQuestions = owner && !quarantine ? questions(run).flatMap(r => r.observation ? [{ review: r, observation: r.observation,
		fact: { question: r.observation.reason, ...(r.decision ? { delivery: r.decision } : {}) } }] : []) : [];
	const a=owner && !quarantine && currentOffer(run);
	const targetAdoption=a ? {id:a.id,revision:a.revision,checkpoint:a.checkpoint,goal:a.goal,assembly:a.assembly,manifest:a.manifest,message:a.message,
			...(a.evaluator && {evaluator:a.evaluator}),
			...(a.failed && {failed:a.failed,patch:a.patch,...(a.rollout && {rollout:a.rollout})}),
			state:!a.assembly ? "blocked" : a.decision?.status??"ready",delivery:a.decision} : undefined;
	return { owner, nodes, pending, receipts, inspections, attempts, unconfirmed, assignments, questions: openQuestions, summary: {
		run: run.id, active: run.active && !quarantine, direction: run.policy.direction, expired: expired(run),
		...(integrity.length && {integrityHolds:integrity}),
		...(historical.length && {historicalChecks:historical}),
		blocker:[blocker,stop,owner && run.offerHold,targetAdoption?.state==="blocked" ? targetAdoption.message :
			targetAdoption?.delivery?.status==="unavailable" ? targetAdoption.delivery.reason : undefined].filter(Boolean).join("\n")||undefined,
		...(targetAdoption && {targetAdoption}),
		reviews: owner && history ? reviews(run).map(r => reviewStatus(run, r)) : [],
		...(owner ? { writerAssignments, discoveryError: run.discoveryError, qualified: qualified?.commit ?? null,
			...(run.goal ? { checkpoint: run.products.at(-1)?.commit ?? null, goal: { commit: run.goal.commit,
				evaluator: run.policy.goalCheck, pin: pin ?? run.policy.base, receipt: goalReceipt(run) } } : {}) } : {}),
	} };
}

/** Assignment ownership, not an observation of native session activity.
 * @param {import("./model.js").Node} n @param {Set<string>} unconfirmed */
function writerBinding(n, unconfirmed) {
	if (n.state === "writing") return n.worker ? "bound" : n.token && unconfirmed.has(n.token) ? "unconfirmed" : "pending";
}

/** @param {import("./model.js").Node} n @param {Pick<ReturnType<typeof visible>,"receipts"|"inspections"|"unconfirmed"|"attempts"|"summary">} view */
export function nodeFact(n, {receipts,inspections,unconfirmed,attempts,summary}) {
	const binding = writerBinding(n, unconfirmed);
	const i=n.check && inspections.get(n.check);
	const latest=n.state==="blocked" && n.check && summary.checkpoint
		? attempts.get(n.grain.id)?.findLast(a=>a.original===n.check && a.commit===summary.checkpoint) : undefined;
	return { grain: n.grain.id, directory: n.grain.directory, task: n.grain.task, requires: liveNeeds(n), evaluator: n.grain.check,
		...(!n.grain.task && {specification:n.grain.specification}),
		...(n.retained ? {ownership:grant(n)} : {}),
		...(n.successor ? {successor:n.successor} : {}),
		...(n.restoration ? {restoration:n.restoration} : {}),
		...(latest?.status==="passed" && {passedOnBuild:latest.check}),
		...(i && {codeReview:{id:i.id,component:i.component,candidate:i.candidate,state:i.state,summary:i.summary,permissionHold:i.permissionHold}}),
		state: n.state, ...(binding ? { writerBinding: binding } : {}), checked: checked(n) ? n.candidate : undefined, worker: n.worker, receipt: n.check && receipts.get(n.check), reason: n.reason,
		...(attempts.has(n.grain.id) && {attempts:attempts.get(n.grain.id)}) };
}

/** @param {import("./model.js").Effect} e */
export function pendingFact(e) {
	return { id: e.id, issuer: e.issuer, kind: e.kind, state: e.state, ...(e.grain ? { grain: e.grain } : {}),
		...(e.kind === "writer" && e.state === "uncertain" && e.claims?.length ? { claim: e.claims.length === 1 ? "awaiting_issuer" : "conflicting_claims" } : {}),
		...(e.tool === "bash" && awaitingReply(e) && !e.receipt ? {runner:e.runnerStarted ? "claimed-no-outcome" : "claim-not-recorded"} : {}),
		...(e.tool === "bash" && e.runnerStarted && !e.receipt && awaitingReply(e) && !e.permissionHold ? { awaitingEvaluator: true } : {}),
		reason: e.permissionHold ?? e.error };
}

/** @typedef {ReturnType<typeof visible>["summary"] & {
 * metrics?: ReturnType<typeof timingFacts>, questions?: ReturnType<typeof visible>["questions"][number]["fact"][],
 * nodes: ReturnType<typeof nodeFact>[], pending: ReturnType<typeof pendingFact>[]
 * }} BoardSource */

/** @param {Run} run @param {string} actor */
export function boardFacts(run, actor) {
	const view=visible(run,actor), { owner, summary, questions, nodes, pending } = view;
	return projectBoard({ ...summary, ...(owner ? { metrics: timingFacts(run), questions:[...questions.map(q => q.fact),...adoptionQuestions(summary)] } : {}),
		nodes: nodes.map(n => nodeFact(n,view)), pending: pending.map(pendingFact) }, owner);
}

/** @param {ReturnType<typeof visible>["summary"]} summary */
export function adoptionQuestions(summary){
	const a=summary.targetAdoption;
	return summary.active && !summary.expired && a?.assembly && (a.state==="ready" || a.state==="presenting") ? [{
		kind:a.rollout?"harness-rollout":a.patch?.owner?"owned-correction":a.failed?"inherited-correction":"target-adoption",question:a.rollout ?
			`Apply exact harness rollout ${a.rollout.blob} after ${a.rollout.followup?.check??a.failed} and verify ${a.assembly} with fresh checks?` : a.failed ? `Apply the exact ${a.patch?.owner?"owned-output":"inherited-file"} correction ${a.patch?.blob} after ${a.failed} and verify ${a.assembly}?` :
			`Adopt the changed contract on ${a.revision} and recheck ${a.assembly}?`,
		delivery:a.delivery,squad:undefined,base:a.revision,evidence:[],recovery:undefined,
	}] : [];
}
