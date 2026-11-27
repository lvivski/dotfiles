import { verifyFixedGrant } from "./brief.mjs";
import { verifyRepairInputs } from "./assembly.mjs";
import { working } from "./assignment.mjs";
import { productPin } from "./evidence.mjs";
import { originalScope, stalePins, validateNodes, writerInputs, writerVersion } from "./lineage.mjs";
import { changedFiles, commitAt, regularFiles } from "./product.mjs";
import { fail, roots, scopeLabel, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").CharterContinuation} Pair */

/** Common pin check, not permission to read a baseline, accept an offer or use a newer
 * charter. Return the exact exception that would need an explicit native decision.
 * @param {string} cwd @param {Run} run @param {Node} n @param {string[]} commits */
export function stoppedPins(cwd,run,n,commits){
	const {id,specification:file,boundary,check}=n.grain,base=text(n.base,"original writer base");
	if(n.stop?.input?.grant && n.stop.input.grant!==writerVersion(n))fail("stale_assignment",`${id}: the stopped grant changed`);
	verifyFixedGrant(cwd,run,n);
	if(Object.values(run.nodes).some(other=>other.grain.id!==id && other.worker===n.worker && working(other)))
		fail("dispatch_held","The original writer is bound to another active assignment");
	if(stalePins(run,n).length)fail("stale_assignment",`${id}: a pinned prerequisite changed or was removed`);
	const nodes={...run.nodes,[id]:{...n,state:/** @type {const} */("waiting")}};
	validateNodes(nodes);
	const inputs=writerInputs(nodes,nodes[id])??fail("stale_assignment",`${id}: original prerequisites unavailable`);
	if(!n.generation || changedFiles(cwd,n.generation,base,[file,...boundary,check]).length)
		fail("stale_assignment",`${id}: the original generation does not match the claimed contract`);
	const [current,...incoming]=[...new Set(commits)];
	for(const commit of [current,...incoming]){
		verifyRepairInputs(cwd,run,n,inputs,commit);
		if(changedFiles(cwd,base,commit,[...boundary,check]).length)fail("stale_assignment",`${id}: the original boundary or component check changed`);
		if(commit!==current && changedFiles(cwd,current,commit,[file]).length)
			fail("stale_assignment",`${id}: the incoming assembly has a different charter from the checked product`);
	}
	if(!changedFiles(cwd,base,current,[file]).length)return {inputs};
	const review=run.effects.find(e=>e.id===n.review),p=run.products.at(-1);
	if(!p || p.commit!==current || !run.goal || p.target!==run.goal.target || p.target!==commitAt(cwd,run.policy.target) ||
		review?.kind!=="scout" || !originalScope(run,n,review) || changedFiles(cwd,review.base,base,[file,...boundary,check]).length)
		fail("stale_assignment",`${id}: need the original reviewed task and frozen contract on a current checked product`);
	for(const [dep,pin] of Object.entries(inputs)){
		if(p.outputs[dep]!==pin || run.join && run.join.outputs[dep]!==pin ||
			[current,...incoming].some(commit=>changedFiles(cwd,pin,commit,roots(run.nodes[dep].grain.directory)).length))
			fail("stale_assignment",`${id}: the original producer ${dep}@${pin} is not included unchanged`);
	}
	const [old]=regularFiles(cwd,base,[file]),[next]=regularFiles(cwd,current,[file]);
	if(old.mode!==next.mode || old.oid===next.oid)fail("stale_assignment",`${id}: only changed charter bytes at the same regular-file mode can be reviewed`);
	return {inputs,continuation:{file,from:old.oid,to:next.oid,target:p.target,
		productEvaluator:productPin(run)??run.policy.base,goalEvaluator:run.repins?.at(-1)?.revision??run.policy.base}};
}

/** @param {Run} run @param {Node} n @param {Pair} pair */
export function continuationPrompt(run,n,pair){
	return `Review this exact charter change for ${n.grain.id} (${n.worker}) on ${pair.target}: ${JSON.stringify(pair.file)}, ${pair.from} → ${pair.to}. `+
		`Inspect the immutable change: git diff --no-ext-diff --no-textconv ${pair.from} ${pair.to}\nContinue ONLY under the original ${pair.from} charter; `+
		`no permissions or task from ${pair.to} are imported.\nOriginal task: ${n.grain.task??run.policy.direction}\n`+
		`Assigning review ${n.review}; generation ${n.generation}; scope ${scopeLabel(n.grain.directory)}; `+
		`unchanged check ${n.grain.check} and boundaries ${JSON.stringify(n.grain.boundary)} at ${n.base}; original inputs ${JSON.stringify(n.inputs)}. `+
		`Current product evaluator ${pair.productEvaluator}; goal evaluator ${pair.goalEvaluator}.`;
}

