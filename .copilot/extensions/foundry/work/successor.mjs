import { checkReceipt, inconclusiveRepair, relinquishable } from "./evidence.mjs";
import { assignmentCalls, dependencies } from "./plan.mjs";
import { outside } from "./product.mjs";
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
