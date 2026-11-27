import { renewal } from "./rules/renewal.mjs";
import { transition } from "./machine.mjs";
import { executor } from "./adapter.mjs";
import { currentEvaluation, goalReceipt } from "./evidence.mjs";
import { checkpointCurrent } from "./facts.mjs";
import { availableReservations } from "./capacity.mjs";
import { expired } from "./native.mjs";
import { partitionConflict } from "./partition.mjs";
import { consumersOf, liveNeeds } from "./plan.mjs";
import { changedFiles, contractPaths, outside } from "./product.mjs";
import { comparison, obstructed, reviews } from "./reviews.mjs";
import { FoundryError, comparisonScope, covers, roots, sameScope } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Review} Review */
/** @typedef {NonNullable<Review["renewal"]>} Renewal */
/** @typedef {Omit<Renewal,"state">} Pins */

/** @typedef {NonNullable<Review["observation"]>} Report */
const applyRenewal=executor(renewal,{
	"admit-report"(/** @type {{report:Report,admit:(report:Report)=>void}} */ {admit,report}) {admit(report);},
});

/** @param {{value:keyof typeof renewal.states,context:Pins|undefined}} snapshot @returns {Renewal} */
function renewed({value,context}) {
	if (!context || value==="initial") throw Error("Renewal did not enter a state with reviewed pins");
	return {...context,state:value};
}

/** @param {string} cwd @param {Run} run @param {Review} r @param {string} target @param {boolean} permitted
 * @param {(report:NonNullable<Review["observation"]>)=>void} admit */
export function renew(cwd,run,r,target,permitted,admit) {
	const state=r.renewal?.state ?? "initial";
	if (!r.observation || !renewal.states[state].length) return;
	const basis=renewalBasis(cwd,run,r,target);
	if (!basis) return;
	const selected=transition(renewal,{value:state,context:/** @type {Pins|undefined} */ (r.renewal)},
		{type:"evidence",...basis},{conflict:!!basis.reason,permitted},true);
	r.renewal=renewed(selected.snapshot);
	try {applyRenewal(selected,{admit,report:r.observation});}
	catch (error) {
		if (!(error instanceof FoundryError)) throw error;
		r.renewal=renewed(transition(renewal,selected.snapshot,{type:"invalid",...basis,reason:error.message},{},true).snapshot);
	}
}

/** A checkpoint can move without invalidating the report. Never infer that a
 * whole-directory repair may replace an owner (or transfer only some files).
 * @param {string} cwd @param {Run} run @param {Review} r @param {string} target */
export function renewalBasis(cwd, run, r, target) {
	if (!run.active || expired(run) || r.state!=="blocked" || !obstructed(r,"stale-review") || !r.packet || !r.workflowId || !r.callId ||
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
