import { missingObservation } from "./evidence.mjs";
import { activate } from "./activity.mjs";
import { survey } from "./dispatch.mjs";
import { admitted, transferableWriter } from "./native.mjs";
import { awaitingReply } from "./reservation.mjs";
import { retireSuperseded, reviews } from "./reviews.mjs";
import { fail } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {{runId:string,status:string,error?:string,reason?:string,failure?:{type:string}}} ScoutEnvelope */
/** A paused or halted envelope may also carry an explicit refusal or a limit failure.
 * @param {ScoutEnvelope} result */
export const resumable = result => (result.status === "paused" || result.status === "halted") &&
	(!result.failure || result.failure.type === "workflow_provider_disconnected");

/** @param {import("./model.js").Review} r */
const unboundTicket = r => r.state === "uncertain" && !r.workflowId ? r.callId : undefined;

/** Freeze what an owner may recover before checking host permissions. Revalidate those
 * identities on the live ledger; work that became recoverable during the wait is not selected.
 * @param {Run} prior @param {boolean} canInspectWorkflows */
export function prepareResume(prior, canInspectWorkflows) {
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
	if (prior.active && !goal && !tickets.size && !workflows.size && !writers.size) return;
	return {
		workflows, retryGoal: !!goal,
		/** @param {Run} run */
		apply(run) {
			if (run.owner !== prior.owner || run.active !== prior.active || goal && (run.goal?.check !== goal || !missingObservation(run)))
				fail("run_conflict", "Run activation changed while starting");
			activate(run,"resume");
			admitted(run,true);
			for (const e of run.effects) {
				if (e.kind === "scout") {
					const ticket = unboundTicket(e);
					if (!ticket || tickets.get(e.id) !== ticket) continue;
					e.issuer = run.owner; survey(e,"requeue"); delete e.callId; delete e.error;
					retireSuperseded(run, e);
				} else if (writers.get(e.id) === e.issuer && transferableWriter(run, e)) e.issuer = run.owner;
			}
		},
	};
}
