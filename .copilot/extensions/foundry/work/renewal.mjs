import { chart, select, to } from "./chart.mjs";
import { currentEvaluation, goalReceipt } from "./evidence.mjs";
import { checkpointCurrent } from "./facts.mjs";
import { availableReservations } from "./capacity.mjs";
import { expired } from "./native.mjs";
import { partitionConflict } from "./partition.mjs";
import { consumersOf, liveNeeds } from "./plan.mjs";
import { changedFiles, contractPaths, outside } from "./product.mjs";
import { comparison, reviews, staleReviewReason } from "./reviews.mjs";
import { FoundryError, comparisonScope, covers, roots, sameScope } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Review} Review */

const consider=[{...to("evidence","held","Keep the saved report on hold because its inputs or ownership conflict."),when:["conflict"]},
	{...to("evidence","approved","Use the original report after its inputs and current permissions have been revalidated."),when:["permitted"]},
	to("evidence","needed","Keep the eligible report until the issuing session has permission to admit it.")];
export const renewal=chart("renewal","initial",{
	initial:consider,held:consider,needed:consider,approved:[...consider,to("invalid","closed","Retain the admission error rather than rerunning or silently changing the report.")],
	// Older readers may already have presented an approval. Silence is not permission to replace it.
	presenting:[],closed:[],
},{description:"Determines whether an existing scout report can be admitted after a checkpoint changes.",states:{
	initial:"The saved report has not been assessed for renewal.",held:"An input or ownership conflict prevents reuse of the report.",
	needed:"The evidence supports renewal, but current permission is missing.",approved:"The report may be admitted on the reviewed checkpoint and goal.",
	presenting:"A previous reader already presented a decision; it must not be silently replaced.",
	closed:"The renewed proposal failed admission. Preserve its diagnostic.",
}});

/** @param {string} cwd @param {Run} run @param {Review} r @param {string} target @param {boolean} permitted
 * @param {(report:NonNullable<Review["observation"]>)=>void} admit */
export function renew(cwd,run,r,target,permitted,admit) {
	const state=r.renewal?.state ?? "initial";
	if (!r.observation || !renewal.states[state].length) return;
	const basis=renewalBasis(cwd,run,r,target);
	if (!basis) return;
	const {checkpoint,goal,reason}=basis;
	const next=select(renewal,state,"evidence",{conflict:!!reason,permitted}).target;
	r.renewal={checkpoint,goal,state:next,...(reason && {reason})};
	if (next!=="approved") return;
	try {admit(r.observation);}
	catch (error) {
		if (!(error instanceof FoundryError)) throw error;
		r.renewal={checkpoint,goal,state:select(renewal,next,"invalid").target,reason:error.message};
	}
}

/** A checkpoint can move without invalidating the report. Never infer that a
 * whole-directory repair may replace an owner (or transfer only some files).
 * @param {string} cwd @param {Run} run @param {Review} r @param {string} target */
export function renewalBasis(cwd, run, r, target) {
	if (!run.active || expired(run) || r.state!=="blocked" || r.error!==staleReviewReason || !r.packet || !r.workflowId || !r.callId ||
		r.observation?.outcome!=="regenerate" || r.observation.grains.length!==1 || r.observation.replace?.length) return;
	const i=comparison(run,r), g=r.observation.grains[0], last=run.products.at(-1), goal=run.goal;
	if (!i?.source || i.transfer || i.successor || typeof g!=="object" || g.revision || !sameScope(comparisonScope(i),g.directory) ||
		!r.observation.evidence.includes(i.source.file) || !last || !goal || last.commit===r.base || r.base!==i.source.commit ||
		!currentEvaluation(run,r) || !checkpointCurrent(run,last.check,target) || goalReceipt(run)?.exit!==2 ||
		!run.products.some(p=>p.check===i.receipt && p.commit===r.base && p.target===target) ||
		run.independent || run.effects.some(e=>e.permissionHold)) return;
	const pins={checkpoint:last.check,goal:goal.check};
	const scope=roots(g.directory), nodes=Object.values(run.nodes);
	const owner=nodes.find(n=>n.grain.id===g.id || !outside(n.grain.directory,scope));
	if (owner) {
		const users=owner.candidate ? consumersOf(run.nodes,{[owner.grain.id]:owner.candidate}).map(n=>n.grain.id) : [];
		return {...pins,reason:`${owner.grain.id} owns or reserves the proposed work${users.length?`; dependent assignments: ${users.join(", ")}`:""}. Continuing this report cannot change ownership.`};
	}
	if (reviews(run).findLast(s=>s.squad===r.squad)!==r)
		return {...pins,reason:"A newer review exists for this charter; the older proposal cannot supersede it."};
	const conflict=partitionConflict(run);
	if (conflict) return {...pins,reason:conflict};
	const squad=run.policy.squads.find(s=>s.id===r.squad);
	if (!squad || !("areas" in squad)) return;
	const paths=new Set([...scope,...squad.areas,...squad.boundary,squad.charter,g.check,...contractPaths(run.policy),
		...r.observation.evidence,...Object.keys(r.packet.files)]);
	if (r.packet.excerpt) paths.add(r.packet.excerpt.path);
	const needs=new Set(g.needs);
	for (const id of needs) {
		const n=run.nodes[id], pin=r.packet.outputs[id];
		if (!pin || n?.state!=="qualified" || n.candidate!==pin || last.outputs[id]!==pin ||
			!run.products.some(p=>p.check===i.receipt && p.outputs[id]===pin))
			return {...pins,reason:`Required input ${id} is not qualified at its reviewed version.`};
		for (const dep of liveNeeds(n)) needs.add(dep);
		for (const path of roots(n.grain.directory)) paths.add(path);
	}
	const changes=changedFiles(cwd,r.base,last.commit);
	const frozen=[...paths];
	const changed=changes.find(file=>!outside(file,frozen));
	if (changed) return {...pins,reason:`Reviewed input changed: ${changed}.`};
	const unknown=changes.find(file=>!nodes.some(n=>n.state==="qualified" && n.candidate && n.candidate===last.outputs[n.grain.id] && covers(n.grain.directory,file)));
	if (unknown) return {...pins,reason:`Cannot attribute changed input ${unknown} to an independent checked output.`};
	if (!availableReservations(run)) return;
	return {...pins,reason:undefined};
}
