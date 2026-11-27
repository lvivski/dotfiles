import { checkpointReceipt, goalReceipt, missingObservation } from "./evidence.mjs";
import { unprovenExports } from "./attestation.mjs";
import { activate } from "./activity.mjs";
import { prepareInspectionResume } from "./inspections.mjs";
import { survey } from "./dispatch.mjs";
import { admitted, current, reserveProduct, transferableWriter } from "./native.mjs";
import { commitAt, verifyContracts } from "./product.mjs";
import { awaitingReply, unissued } from "./reservation.mjs";
import { checkpointQueue } from "./quiescence.mjs";
import { retireSuperseded, reviews } from "./reviews.mjs";
import { digest, fail } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {{runId:string,status:string,error?:string,reason?:string,failure?:{type:string}}} ScoutEnvelope */
/** A paused or halted envelope may also carry an explicit refusal or a limit failure.
 * @param {ScoutEnvelope} result */
export const resumable = result => (result.status === "paused" || result.status === "halted") &&
	(!result.failure || result.failure.type === "workflow_provider_disconnected");

/** @param {import("./model.js").Review} r */
const unboundTicket = r => r.state === "uncertain" && !r.workflowId ? r.callId : undefined;

/** Withdraw only the handoff, not a receipt or output. A new product and then goal
 * must earn release on the unchanged pins; the old notification cannot become current.
 * @param {string} cwd @param {Run} run @param {string} actor @param {string} checkpoint @param {string} goal
 * @param {(e:import("./model.js").NativeCall)=>void} signed */
export function reassessHandoff(cwd,run,actor,checkpoint,goal,signed){
	const p=run.products.at(-1),at=run.goal;
	if(actor!==run.owner || !p || p.withdrawnHandoff || p.check!==checkpoint || at?.check!==goal ||
		p.commit!==at.commit || p.target!==at.target || commitAt(cwd,run.policy.target)!==p.target || !unprovenExports(run).length ||
		!checkpointReceipt(run,p.check,p.commit) || goalReceipt(run)?.exit!==0 || at.stall || run.policyHold || run.targetProposal ||
		run.join || run.blocker || run.conflict || run.independent || checkpointQueue(run,false).held.length ||
		run.inspections?.some(i=>i.permissionHold || i.state==="ready" || i.state==="issued") ||
		run.effects.some(e=>e.permissionHold || e.kind!=="handoff" && (awaitingReply(e) || unissued(e) && current(run,e))))
		fail("stale_pin","Only the original, settled handoff on its unchanged target and evaluator pins can be reassessed");
	for(const id of [p.check,at.check]){
		const e=run.effects.find(c=>c.id===id);
		if(e?.tool!=="bash" || !e.runnerClaim || e.receipt?.exit!==0)fail("missing_receipt","Both historical signed observations are required for reassessment");
		if(e.evaluatorRevision)commitAt(cwd,e.evaluatorRevision);
		signed(e);
	}
	commitAt(cwd,p.commit);
	verifyContracts(cwd,run.policy,p.target);
	const qualifiedAt=p.qualifiedAt;
	delete p.qualifiedAt;
	activate(run,"resume");admitted(run,true);
	const join=reserveProduct(run,actor,cwd,p.target,p.commit,{...p.outputs});
	if(digest(join.ownership??null)!==digest(p.ownership??null))fail("stale_assignment","The historical ownership no longer matches");
	p.withdrawnHandoff={...(qualifiedAt && {qualifiedAt}),goal,recheck:join.check};
	return ()=>commitAt(cwd,run.policy.target)===p.target;
}

/** Freeze what an owner may recover before checking host permissions. Revalidate those
 * identities on the live ledger; work that became recoverable during the wait is not selected.
 * @param {Run} prior @param {boolean} canInspectWorkflows @param {boolean} [canReceiveInspection] */
export function prepareResume(prior, canInspectWorkflows, canReceiveInspection=false) {
	const inspections=prepareInspectionResume(prior,canReceiveInspection);
	const goal = missingObservation(prior) ? prior.goal?.check : undefined;
	/** @type {Map<string,string>} */ const tickets = new Map();
	/** @type {Map<string,string>} */ const workflows = new Map();
	for (const r of reviews(prior)) {
		const ticket = unboundTicket(r);
		if (ticket) tickets.set(r.id, ticket);
		else if (canInspectWorkflows && r.issuer === prior.owner && r.callId && r.workflowId && awaitingReply(r))
			workflows.set(r.callId, r.workflowId);
	}
	const writers = new Map(prior.effects.filter(e => transferableWriter(prior, e)).map(e => [e.id, e.issuer]));
	if (prior.active && !goal && !tickets.size && !workflows.size && !writers.size && !inspections) return;
	return {
		workflows, retryGoal: !!goal,
		/** @param {Run} run */
		apply(run) {
			if (run.owner !== prior.owner || run.active !== prior.active || goal && (run.goal?.check !== goal || !missingObservation(run)))
				fail("run_conflict", "Run activation changed while starting");
			inspections?.(run); // Observe the issuer's original hold before clearing an operator pause.
			activate(run,"resume");
			admitted(run,true);
			for (const e of run.effects) {
				if (e.kind === "scout") {
					const ticket = unboundTicket(e);
					if (!ticket || tickets.get(e.id) !== ticket) continue;
					e.issuer = run.owner; survey(e,"requeue");
					retireSuperseded(run, e);
				} else if (writers.get(e.id) === e.issuer && transferableWriter(run, e)) e.issuer = run.owner;
			}
		},
	};
}
