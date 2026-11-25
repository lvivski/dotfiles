import { checkReceipt, inconclusiveRepair, relinquishable } from "./evidence.mjs";
import { assignmentCalls, dependencies } from "./plan.mjs";
import { displacements } from "./partition.mjs";
import { outside } from "./product.mjs";
import { comparison } from "./reviews.mjs";
import { activeConsumer } from "./transfer.mjs";
import { contains, covers, fail, fields, name, ownership, record, roots, sameScope } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Scope} Scope */
/** @typedef {import("./model.js").Successor} Successor */
/** @param {unknown} input @returns {Successor} */
export function successorRequest(input) {
	const a=record(input); fields(a,["from","check","to"]);
	return {from:name(a.from,"stopped assignment"),check:name(a.check,"original component check"),to:name(a.to,"new assignment")};
}

/** Only descendants of directory grants can become directories. An inherited exact file is never recursive.
 * @param {Scope} parent @param {Scope} scope */
export function narrower(parent,scope) {
	/** @param {Scope} outer @param {Scope} inner */
	const encloses=(outer,inner)=>ownership(inner).directories.every(dir=>ownership(outer).directories.some(root=>contains(root,dir))) &&
		ownership(inner).files.every(file=>covers(outer,file));
	return encloses(parent,scope) && !encloses(scope,parent);
}

/** @param {Run} run @param {Successor} s */
export function stoppedCheck(run,s) {
	const n=run.nodes[s.from], e=run.effects.find(e=>e.id===s.check);
	if (!n || n.state!=="blocked" || n.check!==s.check || e?.kind!=="component" || !e.callId || !e.runnerClaim ||
		e.grain!==s.from || e.check!==n.grain.check || e.issuer!==n.worker || e.error || e.permissionHold) return;
	if (n.stop?.kind==="writer-relinquished" && !n.candidate && relinquishable(run,n)?.id===s.check ||
		n.stop?.kind==="writer-cannot-repair" && n.candidate && inconclusiveRepair(n,e)?.commit===n.candidate && checkReceipt(e)) return e;
}

/** A successor changes its stopped parent's ownership record as well as adding its own
 * scope. Neither may intersect a held grant; its evidence and inputs can't come from one.
 * @param {Run} run @param {Successor|undefined} successor @param {Scope} scope @param {string[]} [reads] */
export function disjointSuccessor(run,successor,scope,reads=[]) {
	const parent=successor && run.nodes[successor.from];
	if (!parent) return false;
	const writes=[...roots(scope),...roots(parent.grain.directory)];
	for (const d of displacements(run)) {
		const owners=[...d.replacements,...Object.values(run.nodes).filter(n=>n.restoration?.from===d.id)];
		const held=[...roots(d.scope),...owners.flatMap(n=>roots(n.grain.directory))];
		if (!outside([...writes,...reads],held)) return false;
		for (const n of owners) {
			const r=run.effects.find(e=>e.id===n.review);
			const cited=r?.kind==="scout" ? r.observation?.evidence??[] : [];
			const inputs=Object.keys(n.inputs??{}).flatMap(id=>run.nodes[id]?roots(run.nodes[id].grain.directory):[]);
			if (!outside(scope,[...n.supporting??[],...cited,...inputs])) return false;
		}
	}
	return true;
}

/** @param {Run} run @param {import("./model.js").Observation} report */
export function successorReads(run,report) {
	return [...report.evidence,...report.grains.flatMap(g=>typeof g==="string"?[]:
		[...dependencies(run.nodes,g.needs)].flatMap(id=>roots(run.nodes[id].grain.directory)))];
}

/** @param {Run} run @param {import("./model.js").Node} n */
export function heldRepair(run,n) {
	if (n.state!=="waiting" || n.restoration) return;
	const review=run.effects.find(e=>e.id===n.review);
	if (review?.kind==="scout") {
		const i=comparison(run,review);
		if (i?.successor) {
			if (review.observation && i.source && i.successor.to===n.grain.id && disjointSuccessor(run,i.successor,
				n.grain.directory,successorReads(run,review.observation))) return "successor";
			return;
		}
	}
	if (n.worker && n.check) return "bound";
}

/** A blocked node has no included output to repartition. Keep that node intact and
 * pair it with exactly one narrower assignment, never another successor of that assignment.
 * @param {Run} run @param {Successor} s @param {Scope} scope @param {string} squad @param {string} [staffing] */
export function preflightSuccessor(run,s,scope,squad,staffing) {
	const n=run.nodes[s.from], prior=run.effects.find(e=>e.id===n?.review), all=Object.values(run.nodes);
	if (!stoppedCheck(run,s) || prior?.kind!=="scout" || prior.squad!==squad || !narrower(n.grain.directory,scope) ||
		n.retained || all.some(v=>v.successor?.to===s.from || v.retained?.some(c=>c.to===s.from)) ||
		(staffing ? n.successor?.review!==staffing || n.successor.to!==s.to : !!n.successor || !!run.nodes[s.to]) ||
		run.effects.some(e=>e.grain===s.to) || run.products.at(-1)?.outputs[s.from] || run.join)
		fail("invalid_successor","Need a fresh ID and a strict subset of one stopped, non-included original assignment, bound to its exact failed component");
	if (assignmentCalls(run,n).some(e=>e.state!=="done" || e.error || e.permissionHold))
		fail("dispatch_held","Resolve outstanding calls and holds on the stopped assignment");
	const overlap=all.find(v=>v!==n && !(staffing && v.grain.id===s.to) && !outside(v.grain.directory,roots(scope)));
	if (overlap) fail("ownership_transition",`The narrow successor also overlaps ${overlap.grain.id}`);
	const live=activeConsumer(run,s.from,scope,{except:staffing ? s.to : undefined});
	if (live) fail("frozen_assignment",`${live.grain.id} still consumes the stopped assignment or the named paths`);
}

/** @param {Run} run @param {Successor} s @param {import("./model.js").Observation} observation @param {Scope} scope */
export function matchesSuccessor(run,s,observation,scope) {
	const [g]=observation.grains;
	return observation.grains.length===1 && !observation.replace?.length && typeof g==="object" && g.id===s.to && !g.revision &&
		sameScope(g.directory,scope) && g.check===run.nodes[s.from].grain.check && !dependencies(run.nodes,g.needs).has(s.from);
}
