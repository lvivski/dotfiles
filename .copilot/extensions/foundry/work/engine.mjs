import { chart, select } from "./chart.mjs";

/** @typedef {Exclude<keyof typeof release.states,"paused"|"qualified"|"blocked">} GoalState */
/** @typedef {{active:boolean, qualified:boolean, goal:GoalState, blocked:boolean, scoped:boolean, stalled:boolean,
 * moved:boolean, idle:boolean, product:boolean, exactProduct:boolean, join:boolean, held:boolean, review:boolean, work:boolean}} Facts */
/** @typedef {"wait"|"assess"|"retry"|"assess-target"|"undecided"|"rejoin"|"qualify"|"baseline"|"none"} Action */
/** @typedef {"scoped"|"stalled"|"moved"|"idle"|"product"|"exactProduct"|"join"|"held"|"review"|"work"|"retryEvidence"} Flag */
/** @param {Action} action @param {import("./admission.mjs").Admission} admission @param {string} reason @param {string} description @param {...(Flag|`!${Flag}`)} when */
const edge=(action,admission,reason,description,...when)=>({on:"assess",action,admission,reason,description,when});
const pending=/** @param {string} reason */ reason=>[
	edge("wait","checkpoint",reason,"Let independent work use the checked checkpoint while the original goal call settles.","scoped"),
	edge("wait","closed",reason,"Wait for the outstanding goal call without issuing another one.")];
const moving=[
	edge("none","open","milestone-held","Leave the milestone unresolved while eligible work continues.","held"),
	edge("assess-target","closed","new-target","Assess the moved target directly when no product or assignments need carrying forward.","moved","!product","idle"),
	edge("rejoin","open","target-changed","Bring retained work onto the changed target before judging it.","moved"),
];
const settled=[...moving,edge("wait","closed","no-new-information","Wait for different evidence instead of assessing the same gap again.","stalled")];

export const release=chart("release","absent",{
	paused:[edge("wait","closed","paused","Keep release and new work on hold.")],
	qualified:[edge("wait","closed","qualified","Keep the qualified commit available for handoff; no more work is needed.")],
	blocked:[edge("wait","closed","blocked","Keep the recorded run blocker visible rather than working around it.")],
	absent:[edge("none","open","component-work","Allow ordinary component work without making a goal decision.")],
	"product-repin":[edge("wait","closed","product-repin-target-changed","Do not apply a product-checker upgrade to a different target.","moved"),
		edge("wait","closed","product-repin-held","Preserve the milestone hold while the upgraded check is outstanding.","held"),
		edge("wait","closed","awaiting-product-repin","Wait for the newly pinned product checker to verify the existing checkpoint.")],
	superseded:pending("superseded-goal"),
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
	unmet:[...settled,edge("none","open","goal-unmet","Discover and admit work that addresses the observed gap.")],
	met:[...settled,edge("wait","checkpoint","comparison-in-progress","Let a scoped comparison finish on the checkpoint before release.","review","scoped"),
		edge("wait","closed","comparison-in-progress","Wait for the outstanding comparison without admitting new work.","review"),
		edge("none","open","include-admitted-work","Finish already admitted work before handing off a product.","work"),
		edge("wait","closed","awaiting-baseline-product","Wait for the already reserved baseline product check.","!product","join"),
		edge("baseline","closed","verify-baseline-product","Obtain the independent product pass even when the baseline goal already passes.","!product"),
		edge("qualify","closed","exact-checks-passed","Hand off the exact commit supported by both current checks.","exactProduct","!join"),
		edge("wait","closed","awaiting-exact-product","A goal pass alone does not prove this exact product can be released.")],
},{description:"Decides what work may proceed and whether the exact assembled commit is ready for handoff.",states:{
	paused:"The run is inactive without a qualified product.",qualified:"The accepted product has already qualified.",blocked:"A recorded run-level obstacle prevents a release decision.",
	absent:"No goal observation has been requested.","product-repin":"An approved product-checker change still needs its own passing observation.",
	superseded:"An earlier goal call is still outstanding or held, but its evaluator is no longer current.",
	pending:"The current goal has no settled receipt.",retired:"The original goal reservation ended without a verdict; its retained work still matters.",
	rejoining:"A fresh product check is verifying the assembly before the goal can be assessed again.",repin:"The goal evidence belongs to an evaluator that has been replaced.",
	"new-product":"There is a checked product that needs a current goal assessment.",incomplete:"The goal check ended without a recognized verdict.",
	missing:"The evaluator could not observe something the goal requires. This is neither a pass nor a demonstrated gap.",
	unmet:"The evaluator demonstrated a gap on the assessed commit.",met:"The goal passed on the assessed commit. Qualification still depends on the product check, target and outstanding work.",
}});

/** @param {Readonly<Facts>} f */
export const releaseState=f=>!f.active ? f.qualified ? "qualified" : "paused" : f.goal!=="absent" && f.blocked ? "blocked" : f.goal;

/** @param {Readonly<Facts>} f @param {boolean} [retryEvidence] */
export function transition(f,retryEvidence=false) {
	const {action,admission,reason}=select(release,releaseState(f),"assess",{...f,retryEvidence});
	return {action,admission,reason};
}
