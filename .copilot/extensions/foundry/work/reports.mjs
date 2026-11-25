import { parseObservation } from "./graph.mjs";
import { awaitingReply } from "./reservation.mjs";
import { researchResult } from "./research.mjs";
import { blockReview, investigation, reviews } from "./reviews.mjs";
import { isPacket } from "./snapshot.mjs";
import { FoundryError, fail } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** A workflow body may journal a report and signal its original issuer, never launch follow-up work.
 * @param {{read:(id:string)=>Run, record:(id:string, fn:(run:Run)=>boolean)=>boolean,
 * diagnostic?:(workflow:string,label:string)=>Promise<string|undefined>, signal:(ticket:string,review:string)=>Promise<void>|undefined}} io */
export function reportReceiver(io) {
	/** @param {string} id @param {string} ticket @param {string} actor @param {string} workflowId @param {string} reviewId
	 * @param {unknown} raw @param {unknown} [packet] */
	return async function receive(id, ticket, actor, workflowId, reviewId, raw, packet) {
		/** @param {Run} run */
		const bound = run => reviews(run).find(r => r.id === reviewId && r.issuer === actor && r.callId === ticket && r.workflowId === workflowId);
		/** @type {string|undefined} */ let diagnostic;
		if (raw === null && io.diagnostic) {
			const job = bound(io.read(id));
			if (job && awaitingReply(job)) {
				try { diagnostic = await io.diagnostic(workflowId, `scout:${job.squad}:${job.id}@${job.base}`); }
				catch (error) { diagnostic = `No report; native diagnostic lookup failed: ${String(error)}`; }
			}
		}
		const changed = io.record(id, run => {
			const job = bound(run) ?? fail("foreign_assignment", "Only the bound workflow may return this report");
			if (!awaitingReply(job)) return false;
			delete job.error;
			const squad = run.policy.squads.find(s => s.id === job.squad) ?? fail("invalid_charter", "No matching charter");
			try {
				const research = investigation(job, squad);
				if (raw === null && diagnostic) fail("missing_report", diagnostic);
				if (raw === null && !research) fail("missing_report", "No structured scout report was returned");
				if (!isPacket(packet) || packet.review !== job.id || packet.base !== job.base || job.diagnostic && !packet.partial)
					fail("missing_packet", "Missing or mismatched journaled scout packet");
				job.observation = research ? researchResult(raw, squad.charter) : parseObservation(squad, raw);
				job.packet = packet; job.state = "reported";
			} catch (error) {
				if (!(error instanceof FoundryError)) throw error;
				blockReview(job, `Invalid scout result: ${error.message}`);
			}
			return true;
		});
		if (changed) await io.signal(ticket, reviewId);
	};
}
