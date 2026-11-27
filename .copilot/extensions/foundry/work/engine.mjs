import { machine, to, transition as next, update } from "./machine.mjs";

/** @typedef {Exclude<keyof typeof release.states,"paused"|"qualified"|"blocked">} GoalState */
/** @typedef {{active:boolean, qualified:boolean, goal:GoalState, blocked:boolean, scoped:boolean, stalled:boolean,
 * moved:boolean, failedComponent:boolean, idle:boolean, product:boolean, exactProduct:boolean, join:boolean, held:boolean, review:boolean, work:boolean,supersededWork?:boolean}} Facts */
/** @typedef {"wait"|"assess"|"retry"|"assess-target"|"undecided"|"rejoin"|"qualify"|"baseline"|"none"} Action */
/** @typedef {import("./admission.mjs").Admission} Admission */
/** @typedef {{target?:string,workTarget?:string,error?:string}} Pins */
/** @typedef {Pins & {action:Action,admission:Admission,reason:string}} Decision */
/** @typedef {Exclude<keyof Facts,"goal">|"retryEvidence"} Flag */

/** A public decision (including "wait" or "none") is data, not an instruction to dispatch.
 * Only an edge with a separate action can change the ledger.
 * @param {Action} outcome @param {Admission} admission @param {string} reason @param {string} description @param {boolean} [frozen] */
const report=(outcome,admission,reason,description,frozen=false)=>({outcome,admission,reason,description,
	...update(`${frozen?"checkpoint":"release"}-${outcome}`,
		(/** @type {Decision|null} */ _,/** @type {Pins} */ e)=>({action:outcome,admission,reason,
			...(e.target!==undefined && {target:e.target}),...("error" in e && {error:e.error}),...(frozen && {workTarget:e.workTarget})}))});

/** @param {Action} action @param {Admission} admission @param {string} reason @param {string} description @param {...(Flag|`!${Flag}`)} when */
const edge=(action,admission,reason,description,...when)=>({on:"assess",...report(action,admission,reason,description),when,
	...(action!=="none" && action!=="wait" && {action})});
const pending=/** @param {string} reason */ reason=>[
	edge("wait","checkpoint",reason,"Let independent work use the checked checkpoint while the original goal call settles.","scoped"),
	edge("wait","closed",reason,"Wait for the outstanding goal call without issuing another one.")];
const moving=[
	edge("none","open","milestone-held","Leave the milestone unresolved while eligible work continues.","held"),
	edge("assess-target","closed","new-target","Assess the moved target directly when no product or assignments need carrying forward.","moved","!product","idle"),
	edge("rejoin","open","target-changed","Bring retained work onto the changed target before judging it.","moved"),
];
const settled=[...moving,edge("wait","closed","no-new-information","Wait for different evidence instead of assessing the same gap again.","stalled")];

export const release=machine("release","absent",{
	paused:[edge("wait","closed","paused","Keep release and new work on hold.")],
	qualified:[{...edge("wait","closed","qualified","Keep the qualified commit available for handoff; no more work is needed."),settlesAfterExpiry:true}],
	blocked:[edge("wait","closed","blocked","Keep the recorded run blocker visible rather than working around it.")],
	absent:[edge("none","open","component-work","Allow ordinary component work without making a goal decision."),
		{on:"product-settled",action:"handoff-product",when:["oneOff","currentJoin","signedProduct","!alreadyHandedOff","!held"],
			description:"Hand off the exact settled product without stopping a run that has no goal evaluator."}],
	"product-repin":[edge("wait","closed","product-repin-target-changed","Do not apply a product-checker upgrade to a different target.","moved"),
		edge("wait","closed","adopted-component-failed","Keep the failed assembly. Propose an exact inherited-file or single-owner correction, not another target adoption.","failedComponent"),
		edge("wait","closed","product-repin-held","Preserve the milestone hold while the upgraded check is outstanding.","held"),
		edge("wait","closed","awaiting-product-repin","Wait for the newly pinned product checker to verify the existing checkpoint.")],
	"withheld-handoff":[edge("wait","closed","handoff-target-changed","Only the original target can receive the fresh assessment.","moved"),
		edge("wait","closed","handoff-recheck-held","Keep the fresh nonpassing observation; the historical pass cannot take its place.","held"),
		edge("wait","closed","awaiting-handoff-recheck","Wait for the fresh product verification on the unchanged checkpoint.","join"),
		edge("wait","closed","unproven-handoff","Wait for an owner resume; the old receipts do not prove the selected evaluator inputs.")],
	superseded:[edge("none","changed-join","integrate-under-approved-pin","Verify genuinely changed, already-published work. The obsolete claimed goal keeps its original call and any late result.","supersededWork","!held"),...pending("superseded-goal")],
	pending:pending("awaiting-goal-receipt"),
	retired:[edge("none","open","integrate-retained-work","Allow retained work to integrate without attributing a verdict to the retired runner.")],
	rejoining:[edge("none","join-only","verify-current-product","Verify the assembled product without staffing new work.")],
	repin:[edge("assess","closed","evaluator-changed","Assess the existing product with the newly approved goal evaluator.")],
	"new-product":[edge("assess","closed","new-checkpoint","Assess the goal on the new checkpoint, not the previous commit.")],
	incomplete:[edge("undecided","closed","incomplete-goal","Report an undecided check rather than treating an interruption as a pass or gap.")],
	missing:[
		edge("wait","repaired-checkpoint","missing-evidence","Let scoped work produce a changed join; do not repeat the unavailable observation on unchanged bytes.","!retryEvidence","scoped","work"),
		edge("wait","checkpoint","missing-evidence","Allow independent checkpoint work but do not join or retry the goal.","!retryEvidence","scoped"),
		edge("wait","closed","missing-evidence","Keep the same target on hold until the missing observation is supplied.","!retryEvidence","!moved"),
		edge("wait","closed","missing-evidence","A target move alone does not justify another observation; no join is pending.","!retryEvidence","!join"),
		edge("wait","closed","missing-evidence","A milestone hold prevents integration while goal evidence is missing.","!retryEvidence","held"),
		edge("retry","closed","retry-evidence","Request a fresh observation on the unchanged target after the retry is authorized.","!moved"),
		...moving.slice(0,2),edge("rejoin","open","target-changed","Assemble retained work on the moved target instead of retrying the old goal."),
	],
	unmet:[...moving,edge("wait","discovery","reconsider-discovery","Let discovery reconsider undelivered evidence without staffing or rechecking the stalled product.","stalled"),
		edge("none","open","goal-unmet","Discover and admit work that addresses the observed gap.")],
	met:[...settled,edge("wait","checkpoint","comparison-in-progress","Let a scoped comparison finish on the checkpoint before release.","review","scoped"),
		edge("wait","closed","comparison-in-progress","Wait for the outstanding comparison without admitting new work.","review"),
		edge("none","open","include-admitted-work","Finish already admitted work before handing off a product.","work"),
		edge("wait","closed","awaiting-baseline-product","Wait for the already reserved baseline product check.","!product","join"),
		edge("baseline","closed","verify-baseline-product","Obtain the independent product pass even when the baseline goal already passes.","!product"),
		{...edge("qualify","closed","exact-checks-passed","Hand off the exact commit supported by both current checks.","exactProduct","!join"),settlesAfterExpiry:true},
		edge("wait","closed","awaiting-exact-product","A goal pass alone does not prove this exact product can be released.")],
},{description:"Decides what work may proceed and whether the exact assembled commit is ready for handoff.",states:{
	paused:"The run is inactive without a qualified product.",qualified:"The accepted product has already qualified.",blocked:"A recorded run-level obstacle prevents a release decision.",
	absent:"No goal observation has been requested.","product-repin":"An approved product-checker change still needs its own passing observation.",
	"withheld-handoff":"The historical handoff lacks verified evaluator inputs. Only fresh evidence on the same product can replace it.",
	superseded:"An earlier goal call is still outstanding or held, but its evaluator is no longer current.",
	pending:"The current goal has no settled receipt.",retired:"The original goal reservation ended without a verdict; its retained work still matters.",
	rejoining:"A fresh product check is verifying the assembly before the goal can be assessed again.",repin:"The goal evidence belongs to an evaluator that has been replaced.",
	"new-product":"There is a checked product that needs a current goal assessment.",incomplete:"The goal check ended without a recognized verdict.",
	missing:"The evaluator could not observe something the goal requires. This is neither a pass nor a demonstrated gap.",
	unmet:"The evaluator demonstrated a gap on the assessed commit.",met:"The goal passed on the assessed commit. Qualification still depends on the product check, target and outstanding work.",
}});

/** @param {Readonly<Facts>} f */
export const releaseState=f=>f.goal==="withheld-handoff" ? f.goal : !f.active ? f.qualified ? "qualified" : "paused" : f.goal!=="absent" && f.blocked ? "blocked" : f.goal;

/** @param {Readonly<Facts>} f @param {boolean} [retryEvidence] @param {string} [target] */
export function releaseResolution(f,retryEvidence=false,target) {
	return next(release,{value:releaseState(f),context:/** @type {Decision|null} */ (null)},{type:"assess",target},{...f,supersededWork:f.supersededWork===true,retryEvidence},true);
}

/** @param {{snapshot:{context:Decision|null}}} selected */
export function decisionOf(selected) {
	if (!selected.snapshot.context) throw Error("Release assessment finished without a decision");
	return selected.snapshot.context;
}

/** @param {Readonly<Facts>} f @param {boolean} [retryEvidence] */
export function transition(f,retryEvidence=false) {
	return decisionOf(releaseResolution(f,retryEvidence));
}

/** @param {Admission} admission @param {string} reason @param {string} description @param {...string} when */
const hold=(admission,reason,description,...when)=>({on:"inspect",target:"decided",...report("wait",admission,reason,description),when});
/** @param {Admission} admission @param {string} reason @param {string} description @param {...string} when */
const frozen=(admission,reason,description,...when)=>({on:"inspect",target:"decided",...report("wait",admission,reason,description,true),when});
/** @param {string} target @param {string} description @param {...string} when */
const inspect=(target,description,...when)=>({...to("inspect",target,description),when});

/** One read of the release evidence. No phase is persisted. A cleared preflight uses the exact
 * release resolution it inspected; a hold or frozen rejoin replaces it, never dispatches both. */
export const releasePreflight=machine("release-preflight","clock",{
	clock:[hold("closed","deadline","Stop before reading the target unless both signed passes finished before expiry.","expired","!timely"),
		inspect("target","Read the current target; the clock alone is not a verdict.")],
	target:[hold("closed","target-unavailable","Do not inspect a checkpoint or issue work for an unavailable target.","!available"),
		hold("closed","ownership-conflict","The independent checkpoint preserves an ownership hold; it cannot qualify.","independent"),
		inspect("partition","Inspect current ownership before surveying an active run.","active"),
		inspect("goal","Read the inactive run's ordinary decision without checking active contracts.")],
	partition:[inspect("contracts","Check the contract before considering repairs to a held ownership partition.","ownershipConflict"),
		inspect("contracts","Do not start a checkpoint survey after the deadline.","expired"),
		inspect("survey","Look for a signed checkpoint whose automatic survey belongs to the previous target.")],
	survey:[inspect("frozen","Validate the live contract without moving the survey's signed work target.","movingSurvey"),
		inspect("contracts","Evaluate the ordinary target when no checkpoint survey is pending.")],
	contracts:[{...hold("closed","contract-changed","Record the changed conserved contract and do not proceed.","contractChanged"),action:"record-contract-conflict"},
		inspect("repair-admission","Consider only designated repairs while ownership is unresolved.","ownershipConflict"),
		inspect("goal","Evaluate the assessed goal against the checked product and the observed target.")],
	frozen:[frozen("checkpoint","contract-changed","Keep permitted checkpoint work on its old target; do not record a run-wide conflict.","contractChanged","checkpointWriters"),
		frozen("closed","contract-changed","Preserve the frozen survey's pins but admit no work on the changed contract.","contractChanged"),
		{on:"inspect",target:"decided",...report("rejoin","join-only","target-changed","Rejoin published repairs on the live target instead of staffing the old survey."),
			action:"rejoin",when:["changedJoin","published"]},
		frozen("checkpoint","checkpoint-work","Staff eligible checkpoint work only on its signed target.","checkpointWriters"),
		frozen("closed","checkpoint-work","Leave the survey on its signed checkpoint without admitting work.")],
	"repair-admission":[inspect("repairs","Check for a designated repair only if the ordinary decision permits a writer on unobstructed, current pins.",
		"sameTarget","!joining","!blocked","!recordedConflict","!permissionHold","eligibleWriters"),
		hold("closed","ownership-conflict","Do not widen the ordinary admission or bypass a target, join or permission hold.")],
	repairs:[hold("ownership-checkpoint-repairs","ownership-conflict","Admit only the designated repair on checkpoint inputs.","designatedRepair","scoped"),
		hold("ownership-repairs","ownership-conflict","Admit only the designated repair; do not discover or integrate other work.","designatedRepair"),
		hold("closed","ownership-conflict","Keep ownership held when no eligible bound repair or disjoint successor exists.")],
	goal:[hold("closed","deadline","After expiry, do not staff, assess, join or retry; only exact handoff may settle.","expired","!settlesAfterExpiry"),
		inspect("cleared","Use the selected ordinary release decision and only its effects.")],
	decided:[],cleared:[],
},{description:"Checks the clock, live target, contract and ownership before an ordinary release decision may take effect.",states:{
	clock:"An assessment starts here, before any Git read.",target:"Observe the current delivery target, not a saved conflict.",
	partition:"Check whether the live target holds any unresolved ownership.",survey:"Check whether an automatic survey must stay on its original signed checkpoint.",
	contracts:"Validate the conserved contract on the live target.",frozen:"A survey still belongs to the signed checkpoint on the old target.",
	"repair-admission":"Ownership is held: the ordinary decision bounds any possible repair.",repairs:"Check for a bound repair or disjoint successor within that admission.",
	goal:"Inspect the projected release decision; expiry can withhold it but cannot manufacture a pass.",
	decided:"Preflight supplied the decision; do not dispatch an ordinary release action.",cleared:"Only the inspected ordinary release decision may proceed.",
}});
