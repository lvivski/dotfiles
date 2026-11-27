import { machine, to } from "../machine.mjs";

/** @param {string} on @param {string} target @param {string} why @param {...string} when */
const go=(on,target,why,...when)=>({...to(on,target,why),when});
/** @param {string} on @param {string} target @param {string} action @param {string} why @param {...string} when */
const act=(on,target,action,why,...when)=>({...go(on,target,why,...when),action});
const closedPlan=go("planned","done","The issuer closed during planning; do not install observers or dispatch.","closed");
const fencedPlan=act("planned","done","refill","Read the committed historical closures before deciding whether the original issuer can reserve fresh work.","fenced");
const reviewPlan=act("planned","publication","sample-policy","Recheck permission before applying independent review evidence to the graph.","inspectionDue");
const watchPlan=act("planned","offering","watch-plan","Observe the committed plan and choose this issuer's outstanding work.");
const wakeLanes=Object.freeze(["history","dispatch"]);

export const reconciliation=machine("reconciliation","idle",{
	idle:[
		act("wake","done","retain-wake","Keep the observation dirty until this session can execute again.","!executable"),
		act("wake","inspecting","inspect-issuer","Read the ledger and arm observation before considering any work."),
		act("verify-batch","permission","sample-batch","Check an existing prepared call or explicit check without entering ordinary reconciliation."),
	],
	inspecting:[
		act("inspected","held","sample-policy","Recheck only this issuer's unexpired managed hold.","ownHold","!expired"),
		act("inspected","recovering","continue-workflows","Verify the original bound continuations, without replacing their workflows.","active","!expired","continuations"),
		{...go("inspected","lanes","Observe originals independently of planning; no continuation is due."),fork:wakeLanes},
	],
	held:[
		act("policy","recovering","clear-hold","Revalidate the exact token and deadline under lock; an operator pause wins.","permitted"),
		{...go("policy","lanes","Keep the protected hold; observation does not authorize dispatch."),fork:wakeLanes},
	],
	recovering:[{...go("recovered","lanes","Continue from the ledger after checking the original hold or workflows."),fork:wakeLanes}],
	lanes:[
		act("history","history","read-originals","Attach to original calls from this issuer without waiting for or replaying a dispatch.","!closed","recoverCalls"),
		go("history","done","No history lookup is requested on this wake."),
		act("dispatch","planning","plan","Plan against the current ledger without waiting for unrelated native history.","!closed"),
		go("dispatch","done","Do not plan after this runtime closes."),
	],
	history:[
		act("completion","history","refill","A terminal original reply may have freed a slot; wake planning without another lookup.","terminal"),
		go("completion","history","An unconfirmed original keeps its reservation and cannot free a slot."),
		go("drained","done","All requested original-call reads for this pass have returned."),
	],
	planning:[closedPlan,fencedPlan,reviewPlan,
		act("planned","renewal","sample-policy","Sample fresh permission before renewing a report or reissuing a writer whose requested input arrived.","!missingTarget","owner","active","!expired","renewalDue"),
		watchPlan],
	publication:[
		go("policy","done","The issuer closed; preserve the review without publishing it.","closed"),
		act("policy","done","retain-wake","Do not publish or record a policy hold from an ineligible execution mode.","!executable"),
		act("policy","planning","apply-verdicts","Revalidate the sampled candidate reviews before publishing or requesting repair.","permitted"),
		act("policy","done","watch-held-inspections","Retain the original evidence and watch for permission to apply it."),
	],
	renewal:[
		go("policy","done","Do not renew a report or install observers after close.","closed"),
		act("policy","renewing","renew","Replan the same run and revalidate its original report or exact input request.","permitted"),
		act("policy","offering","watch-held-renewal","Observe the issuer's permission and retain the original renewal."),
	],
	renewing:[closedPlan,fencedPlan,reviewPlan,watchPlan],
	offering:[
		go("work","done","Wait for the target to be readable; do not dispatch against a missing ref.","missingTarget"),
		go("work","done","Keep an inactive run stopped; only its already-qualified handoff can be delivered.","!active","!handoff"),
		go("work","done","A later eligible turn can deliver a timely final handoff, not start new work.","expired","!handoff"),
		act("work","reservations","mend-test","Dispatch only the current test-repair phase; a calibration is not a product check.","owner","active","!expired","testRepair"),
		act("work","reservations","draft-correction","Send the signed stop directly to its bounded proposal writer. A draft never changes a release.","owner","active","!expired","draftDue"),
		act("work","reservations","offer-question","Present the active owner's outstanding question independently of eligible reservations.","owner","active","!expired","question"),
		act("work","reservations","offer-adoption","Ask the owner about the exact adoption or correction to the failed assembly. Presenting the proposal grants nothing.","owner","active","!expired","adoption"),
		act("work","reservations","offer-batch","Consider only reservations belonging to this issuer."),
	],
	reservations:[
		act("batch","permission","sample-batch","Sample current policy for the selected reservations, outside the write lock.","hasBatch"),
		go("batch","done","There is no eligible unissued batch. An outstanding call is not a new job."),
	],
	permission:[
		act("sampled","done","decline-mode","A changed execution mode cannot enable calls or place a run on hold.","!executable"),
		act("sampled","recording","hold-run","Protect the active run on its issuer's still-current reservation.","managed"),
		act("sampled","recording","hold-issuer","Record the local block only on this issuer's eligible reservations.","blocked"),
		act("sampled","recording","release-batch","Clear old local holds only if the sampled batch is still current.","hadHolds"),
		act("sampled","enabling","enable","The sampled batch has permission and no earlier hold to update."),
	],
	recording:[
		go("recorded","done","A live hold or changed reservation prevents this batch from issuing.","!permitted"),
		act("recorded","enabling","enable","The same eligible reservations have been released."),
	],
	enabling:[
		go("authorized","done","Return the permission decision to the explicit caller; it owns the claim.","checkOnly"),
		act("authorized","native","send-matched","Revalidate the pool match and claim only the same still-ready reservations.","pooled"),
		act("authorized","done","refill","Exposing a held prepared call enables planning, not automatic replay.","!ready"),
		{...act("authorized","dispatching","group-batch","Dispatch the permitted discovery, candidate review, writer and native calls independently."),fork:["scouts","inspections","writers","calls"]},
	],
	dispatching:[
		act("scouts","done","launch-scouts","Claim each native workflow batch before launching it; isolate frozen-reference readers.","jobs","!capacityWait"),
		go("scouts","done","Absent or capacity-queued scouts need no launch on this pass."),
		act("inspections","done","launch-inspections","Claim each exact candidate before starting its independent Rubber Duck workflow.","jobs","!capacityWait"),
		go("inspections","done","Do not issue missing, already-claimed or capacity-queued candidate reviews."),
		act("writers","matching","match-writers","Find eligible idle writers across the ready create reservations.","jobs","pool"),
		act("writers","native","send-writers","Use fresh creates when native writer matching is unavailable.","jobs"),
		go("writers","done","There is no ready writer to match or launch."),
		act("calls","native","send-calls","Claim and send independent native reservations without waiting for writer matching.","jobs"),
		go("calls","done","There are no direct native calls in this batch."),
	],
	matching:[
		act("matched","permission","sample-writer-batch","Sample the original writer reservations' permissions again after the host lookup.","!closed"),
		go("matched","done","The issuer closed while matching writers; keep their reservations."),
	],
	native:[
		act("issued","native","wake-checkpoint","The journaled goal opens eligible checkpoint discovery before its native reply.","checkpointGoal","checkpointReviews"),
		go("issued","native","Wait for the original call without opening checkpoint discovery."),
		go("attempt","done","A stale protected check or writer handoff waits for a verified change instead of retrying the call.","!claimed","pinnedCheck"),
		act("attempt","done","refill","Reconcile from the ledger after the attempted call, never by repeating its request."),
	],
	done:[],
},{description:"Coordinates one transient wake of an issuing session. The ledger, not this pass, owns reservations and evidence.",states:{
	idle:"A turn, receipt or observer has requested reconciliation.",inspecting:"The issuing session is executable; inspect its actual obligations.",
	held:"Only the original managed permission hold is being sampled.",recovering:"A guarded hold or original workflow continuation is being reconciled.",
	lanes:"Native history and dispatch start from this same point without waiting for one another.",history:"Read only eligible original requests and their matching completions.",
	planning:"Plan eligible work and look for evidence that needs fresh permission.",publication:"The issuer needs permission to apply a candidate's independent review.",
	renewal:"The owner needs fresh permission to renew an original report.",
	renewing:"Revalidate the renewal and commit the resulting plan.",offering:"Select allowed work from the observed plan, including a final handoff if due.",
	reservations:"Check whether this issuer has a batch to authorize.",permission:"Only a fresh policy and execution mode can enable this batch.",
	recording:"Revalidate the original batch against the live ledger before setting or releasing a hold.",enabling:"Choose which work the sampled permission enables.",
	dispatching:"Discovery, candidate review, writer creation and direct calls have independent native routes.",matching:"Match ready writers without holding the ledger lock.",
	native:"Individual ledger claims and matching replies determine what the issuer can do next.",done:"This branch of the wake owes no more work.",
}});
