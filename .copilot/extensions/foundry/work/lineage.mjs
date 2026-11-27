import { exhaustedCandidate, generationOf, inconclusiveRepair, missingInput, repairDetail } from "./evidence.mjs";
import { checkReceipt } from "./receipt.mjs";
import { publishedComponent } from "./publication.mjs";
import { assigningGrant, confirmedWriter, declaredWriter, fixedDependency, seeded } from "./origin.mjs";
import { originalGrant, originalWriters } from "./ancestry.mjs";
export { assigningGrant, owns, poolSource, tokenSource, writerOriginId } from "./origin.mjs";
import { editionBoundary,effectAt } from "./revision.mjs";
import { topology } from "./topology.mjs";
import { transferredTo } from "./transfer.mjs";
import { covers, digest, disjoint, fail, names, roots, sameScope } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */

/** A published output still owns its directory until the combined tree is assessed.
 * @param {Node} n */
export const settledOutput = n => n.state === "qualified" || n.state === "repeated";

/** @param {Node} n */
export const checked = n => settledOutput(n) || n.state === "published";

/** @param {Run} run @param {Node} n */
export const stalePins = (run, n) => Object.entries(n.inputs ?? {}).filter(([id, pin]) =>
	run.nodes[id]?.candidate !== pin || !checked(run.nodes[id]));

/** A terminal assignment keeps its original brief and pins as history, not prerequisites.
 * @param {Node} n */
export const liveNeeds = n => n.state === "blocked" ? [] : n.grain.needs;

/** @param {Run["nodes"]} nodes */
const workGraph=nodes=>topology(id=>Object.hasOwn(nodes,id) ? liveNeeds(nodes[id]) : undefined);

/** @param {Node|undefined} n @param {import("./model.js").Effect} e */
export function targetsWriter(n, e) {
	return n?.state === "writing" && n.token === e.token && (e.tool !== "session.send" || e.issuer === n.worker || e.kind === "writer" && n.workspace === e.id);
}

/** A reference offer that never reached a native call cannot keep its former writer's directory.
 * Keep the reservation in the journal; a held, prepared, issued or uncertain call is not obsolete.
 * @param {Node} n @param {import("./model.js").Effect} e */
function obsoleteOffer(n, e) {
	if (e.kind !== "artifact" || e.state !== "ready" || targetsWriter(n, e)) return false;
	return e.callId === undefined && e.permissionHold === undefined && e.error === undefined;
}

/** @param {Run} run @param {Node} n */
export const assignmentCalls = (run, n) => run.effects.filter(e => e.grain === n.grain.id && e.state !== "withdrawn" && !obsoleteOffer(n, e));

/** @param {Run} run @param {Node} n */
export function originalAttempt(run, n) {
	const calls = assignmentCalls(run, n), launch = calls.find(e => e.kind === "writer" && e.token === n.token);
	if (launch?.kind === "writer" && launch.callId && launch.state === "done" && launch.nativeId === n.worker &&
		calls.every(e => e === launch || e.kind === "artifact" && e.state === "done")) return launch;
}

/** @param {Run} run @param {Node} n @param {import("./model.js").Effect|undefined} review */
function assignedScope(run,n,review) {
	if (review?.kind!=="scout" || review.id!==n.review || review.state!=="observed" || review.observation?.outcome!=="regenerate" ||
		review.correction || n.reuse || n.retained || n.successor || n.excluded || n.restoration) return;
	const assigned=assigningGrant(run,review,n.grain.id);
	if(!assigned)return;
	const {output:g,squad:s}=assigned;
	if(typeof g==="string" || "areas" in s && s.charter===n.grain.specification && digest(s.boundary)===digest(n.grain.boundary) && s.agent===n.grain.agent &&
		sameScope(g.directory,n.grain.directory) && g.check===n.grain.check && g.task===n.grain.task &&
		g.revision===n.grain.revision && digest(g.needs)===digest(n.grain.needs) && digest(g.prior??null)===digest(n.grain.prior??null))return assigned;
}
/** @param {Run} run @param {Node} n @param {import("./model.js").Effect|undefined} review */
export const originalScope=(run,n,review)=>!!assignedScope(run,n,review);

const missingAssignment="No original assigning review or fixed requirement for this dispatch";
/** A previously unrecognized source may now be provable. Match the untouched
 * request and its actual checked product, never a diagnostic alone.
 * @param {Run} run @param {Node} n */
export function unstaffedGrant(run,n){
	if(n.state!=="blocked" || n.reason!==missingAssignment || !n.review || n.repairs!==0 ||
		Object.keys(n).some(k=>!["grain","review","state","reason","repairs"].includes(k)))return;
	const review=effectAt(run,n.review);
	if(review?.kind!=="scout" || !review.workflowId || !review.callId || review.base!==run.goal?.commit ||
		run.effects.slice(run.effects.indexOf(review)+1).some(e=>e.grain===n.grain.id))return;
	const witnesses=assignedScope(run,n,review)?.witnesses;
	if(witnesses?.some(f=>f.kind==="signed" && f.use==="product" && f.check===run.products.at(-1)?.check))return {review,witnesses};
}

const dispatchKeys=["id","kind","tool","issuer","args","grain","state","callId","permissionHold","error"];
const componentKeys=new Set([...dispatchKeys,"commit","check","attempt","verification","runnerStarted","runnerClaim","receipt","launcherExit",
	"inlineRepair","usedArtifacts","comparedArtifacts"]);
/** @param {Run} run @param {Node} n @param {import("./model.js").Review|undefined} review @returns {NonNullable<import("./model.js").NativeCall["writing"]>} */
export function declareWriter(run,n,review){
	if(!n.base || !n.generation || !n.inputs || !(review?originalScope(run,n,review) || fixedDependency(run,review,n):seeded(run,n)))
		fail("current_authority_required",missingAssignment);
	const inputs=Object.fromEntries(Object.entries(n.inputs).map(([id,revision])=>{
		const donor=run.nodes[id],published=publishedComponent(run,donor?.check,id,revision);
		if(!published || !donor || donor.candidate!==revision)fail("missing_receipt","The source version is not a reviewed component");
		return [id,{revision,component:published.component.id,review:published.review?.id??null}];
	}));
	return {version:3,source:review?{review:review.id}:{seed:run.policy.base},base:n.base,terms:digest(n.grain),inputs};
}

/** The format fence names the last original journal position, not a new authority table.
 * @param {Run} r */
export function writerFormat(r){
	if(!editionBoundary(r))return false;
	const prior=r.historicalPrefix?.length?originalWriters(r,r.effects.flatMap(e=>e.kind==="writer" && e.writing?[e.id]:[])):undefined;
	return r.effects.every(e=>e.kind!=="writer" || !e.writing || !!declaredWriter(r,e,prior));
}

/** Historical launches had no explicit grant pointer. Resolve a confirmed ordinary
 * assignment only when exactly one charter in its original prefix could have issued it.
 * @param {Run} run @param {import("./model.js").Effect|undefined} w */
export function producingGrant(run,w){
	if(w?.kind!=="writer" || !w.writing)return originalGrant(run,w);
	const origin=confirmedWriter(run,w);
	const declared=origin && declaredWriter(run,w,run.historicalPrefix?.length?originalWriters(run,[w.id]):undefined);
	if(origin && declared?.review)return {...declared,review:declared.review,...origin};
}

/** Only a writer's own submission can identify it as the producer. Passing an
 * observation, including with the same checker and bytes, is a separate fact.
 * @param {import("./model.js").Effect|undefined} c @param {NonNullable<ReturnType<typeof producingGrant>>} origin */
export const submittedBy=(c,origin)=>c?.kind==="component" && c.grain===origin.writer.grain && c.issuer===origin.worker &&
	(c.attempt?.version===3?c.attempt.source.kind==="writer" && c.attempt.source.id===origin.writer.id:!origin.writer.writing) &&
	Object.keys(c).every(k=>componentKeys.has(k)) && (!c.verification || c.verification.use==="component") &&
	(typeof origin.output==="string" || origin.output.check===c.check);

/** Follow only delivered reference grants to the same original launch; no check or unrelated repair can enter the chain.
 * @param {Run} run @param {Node} n */
export function inputAttempt(run,n) {
	const calls=assignmentCalls(run,n), writers=calls.filter(e=>e.kind==="writer"), w=writers[0];
	if (writers.length!==1 || w?.kind!=="writer" || w.state!=="done" || !w.callId || w.nativeId!==n.worker || generationOf(w)!==n.generation ||
		calls.some(e=>e.error || e.permissionHold || e.state!=="done" || e!==w && e.kind!=="artifact" && !(e.kind==="repair" && e.input))) return;
	const last=calls.findLast(e=>e.kind==="repair");
	if (!last) return w.token===n.token ? w : undefined;
	const old=last.kind==="repair" && last.input?.prior;
	if (old && last.token===n.token && old.worker===n.worker && old.generation===n.generation && old.base===n.base &&
		old.review===n.review && n.repairs===old.repairs+1 && digest(old.inputs)===digest(n.inputs) && digest(old.grain)===digest(n.grain)) return w;
}

/** A producer request and a reference grant must agree on who can resume the work.
 * @param {Run} run @param {Node} n */
export function referenceAttempt(run,n){
	if(!n.base || !n.token || !n.worker || !n.generation || !n.review || missingInput(n)===undefined || n.candidate || n.check)return;
	if(n.stop?.input?.grant && n.stop.input.grant!==writerVersion(n))return;
	const w=inputAttempt(run,n);
	if(w && !w.finished && !w.reuse && !w.observer && !w.production && !w.restoration && !w.readGrant &&
		originalScope(run,n,run.effects.find(e=>e.id===n.review)))return w;
}

/** Identify a particular grant without sharing its token. A preview, reference cursor
 * or delivery diagnostic changes no authority and must not invalidate the request.
 * @param {Node} n */
export const writerVersion=n=>digest([n.grain,n.worker,n.token,n.repairs,n.base,n.generation,n.review,n.inputs,
	n.supporting??null,n.priorSource??null,n.replaces??null,n.workspace??null,n.retained??null,n.successor??null,n.restoration??null,n.reuse??null]);

/** A stopped exit-2 sample can inform a different assignment but cannot seed it. An
 * exhausted exit-1 candidate instead needs a newly reviewed prerequisite.
 * @param {Run} run @param {Node} n @param {import("./model.js").Output} g @param {import("./model.js").Review} review */
export function candidateHandoff(run, n, g, review) {
	if (g.revision && g.revision !== review.base) return false;
	const detail = repairDetail(n);
	if (detail) return review.packet?.sources?.includes(`detail:${detail}`) &&
		inconclusiveRepair(n, run.effects.find(e => e.id === n.check))?.commit === n.candidate;
	return exhaustedCandidate(run,n) && g.needs.some(id => review.packet?.outputs[id] && review.packet.outputs[id] !== n.inputs?.[id]);
}

/** @param {Run["nodes"]} nodes @param {Iterable<string>} roots */
export function dependencies(nodes, roots) {
	return workGraph(nodes).upstream(roots);
}

/** Undefined means not ready; an empty map is a ready writer with no prerequisites.
 * @param {Run["nodes"]} nodes @param {Node} n */
export function writerInputs(nodes, n) {
	if (n.state !== "waiting") return;
	/** @type {Record<string,string>} */ const pins = {};
	for (const id of dependencies(nodes, n.grain.needs)) {
		const input = nodes[id];
		if (!input.candidate || !checked(input)) return;
		pins[id] = input.candidate;
	}
	return pins;
}

/** @param {Run["nodes"]} nodes @param {{changed:string[],removed:Iterable<string>}} [edit] */
export function validateNodes(nodes,edit) {
	const all=Object.values(nodes), cut=all.some(n=>n.retained || n.successor);
	if (cut) for (const [index,n] of all.entries()) {
		disjoint(roots(n.grain.directory));
		for (const other of all.slice(index+1)) {
			if (transferredTo(n,other.grain.id,other.grain.directory) || transferredTo(other,n.grain.id,n.grain.directory)) continue;
			disjoint([...roots(n.grain.directory),...roots(other.grain.directory)]);
		}
	}
	else disjoint(all.flatMap(n=>roots(n.grain.directory)));
	const graph=workGraph(nodes);
	if (edit) graph.validateEdit(edit.changed,edit.removed,()=>Object.keys(nodes));
	else {
		names(all.map(n=>n.grain.id),"grain");
		graph.validate(Object.keys(nodes));
	}
}
