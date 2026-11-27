import { assign, working } from "./assignment.mjs";
import { blockedComponent, checkReceipt, exhaustedCandidate, generationOf, missingInput, repairDetail } from "./evidence.mjs";
import { assignmentCalls, candidateHandoff, checked, dependencies, liveNeeds, owns, settledOutput, stalePins, tokenSource, validateNodes, writerInputs } from "./lineage.mjs";
import { changedFiles, outside } from "./product.mjs";
import { protectsGrant, transferredTo } from "./transfer.mjs";
import { assignmentDirectory, digest, fail, fields, mixed, name, names, record, relative, roots, sameScope, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").Proposal} Proposal */
/** @typedef {import("./model.js").Area} Area */

/** @param {import("./model.js").Grain} grain @param {string} [review] @param {number} [repairs] @returns {Node} */
export function waiting(grain,review,repairs=0){
	/** @type {Node} */ const n={grain,state:"idle",repairs,...(review && {review})};
	assign(n,"request");
	return n;
}

/** A current terminal check is history, not authority to replay it. A changed
 * prerequisite can instead justify a newly reviewed assignment.
 * @param {Run} run @param {Node} n */
export function supersededAttempt(run, n) {
	if (n.state !== "blocked" || !n.worker || !n.generation || !n.check || n.repairs >= run.policy.repairs) return;
	const stale = stalePins(run, n);
	if (stale.length && !assignmentCalls(run,n).some(e => ["component", "writer", "repair"].includes(e.kind) &&
		e.state !== "done" && e.state !== "refused") && blockedComponent(n, run.effects.find(e => e.id === n.check)))
		return { check: n.check, staleInputs: Object.fromEntries(stale) };
}

/** @param {Run} run @param {Node} n @param {string} commit @param {string} [cwd] */
export function changedExclusion(run,n,commit,cwd){
	const input=n.excluded;
	if(!input)return false;
	if("path" in input)return cwd===undefined?undefined:changedFiles(cwd,input.revision,commit,[input.path]).length>0;
	const checkpoint=run.products.at(-1);
	return checkpoint?.commit===commit && checkpoint.outputs[input.grain]!==input.revision && (!!checkpoint.outputs[input.grain] || commit!==n.base);
}

/** The scheduler and read-only ownership projection use the same input version.
 * Without a checkout a path-dependent version is unknown, not the last review's version.
 * @param {Run} run @param {import("./model.js").Squad} squad @param {string} commit @param {string} [cwd] */
export function goalVersion(run,squad,commit,cwd){
	if(!("areas" in squad))return commit;
	const stopped=[];
	for(const n of Object.values(run.nodes)){
		if(n.state!=="blocked" && n.state!=="repeated" || !owns(squad,n.grain.directory))continue;
		if(n.excluded){
			const changed=changedExclusion(run,n,commit,cwd);if(changed===undefined)return;
			if(!changed)continue;
		}
		const retired=supersededAttempt(run,n);
		stopped.push([n.grain.id,n.state,n.reason??n.candidate,...(retired?[retired]:[])]);
	}
	return digest([commit,run.goal?.tried??[],stopped]);
}

/** A ready reservation may already have a generated checkout or pooled recipient. Only the
 * original, never-issued start is withdrawable, not a repair, approved successor or native hold.
 * @param {Run} run @param {Node} n */
export function unstartedWriter(run,n) {
	if (n.state!=="writing" || n.worker || n.repairs || n.check || n.preview || n.reuse || !n.token) return;
	const w=run.effects.find(e=>e.kind==="writer" && e.grain===n.grain.id && e.token===n.token);
	if (w?.kind==="writer" && w.state==="ready" && !w.callId && !w.nativeId && !w.permissionHold && !w.error &&
		!w.reuse && !w.observer && !w.production && !w.claims && generationOf(w)===n.generation) return w;
}

/** A terminal stop releases no files. On the same base the new task needs
 * review evidence scoped to this exact directory, not just an ordinary area review.
 * @param {Run} run @param {import("./model.js").Review} review @param {import("./model.js").Observation} report
 * @param {import("./model.js").Scope|undefined} scopedDirectory */
export function stoppedHandoff(run, review, report, scopedDirectory) {
	const [g] = report.grains;
	if (report.outcome !== "regenerate" || report.grains.length !== 1 || typeof g !== "object" || run.nodes[g.id] ||
		run.effects.some(e => e.grain === g.id) || !review.packet || review.retryOf && !sameScope(scopedDirectory,g.directory)) return;
	const n = Object.values(run.nodes).find(n => sameScope(n.grain.directory,g.directory));
	if (!n) return;
	const exhausted = exhaustedCandidate(run,n);
	if (!exhausted && missingInput(n) === undefined && !repairDetail(n)) return;
	if (n.candidate && !(sameScope(scopedDirectory,g.directory) && candidateHandoff(run, n, g, review)))
		return { hold: repairDetail(n) ? `Review the stopped component ${n.check} on the current product and explicitly replace ${n.grain.id} with a distinct task for ${g.directory}` :
			`${n.grain.id} still has candidate ${n.candidate}; a distinct scoped task needs a newly qualified prerequisite` };
	if (!n.worker || !n.base || !n.token || !n.generation) return { hold: `${n.grain.id} lacks its original writer binding` };
	if (n.base === review.base && !sameScope(scopedDirectory,g.directory) || n.grain.check !== g.check ||
		g.task === n.grain.task || report.replace?.some(id => id !== n.grain.id)) return { hold: `Not a distinct task with the same directory and check as ${n.grain.id}` };
	const consumer = Object.values(run.nodes).find(other => liveNeeds(other).includes(n.grain.id) || other.state !== "blocked" && Object.hasOwn(other.inputs ?? {}, n.grain.id));
	if (consumer) return { hold: `${consumer.grain.id} consumes ${n.grain.id}` };
	const calls = assignmentCalls(run, n), launches = calls.filter(e => e.kind === "writer");
	const held = calls.find(e => e.state !== "done" || e.permissionHold || e.error);
	if (held) return { hold: `${n.grain.id}: ${held.kind} ${held.id} is ${held.state}${held.permissionHold || held.error ? `: ${held.permissionHold || held.error}` : ""}` };
	if (launches.length !== 1 || !launches[0].callId || launches[0].nativeId !== n.worker || generationOf(launches[0]) !== n.generation)
		return { hold: `No unique confirmed launch matches ${n.grain.id}'s writer and generation` };
	if(!tokenSource(calls,launches[0],t=>t===n.token,e=>!!exhausted || e.id===n.check))return {hold:`Unconfirmed repair for ${n.grain.id}`};
	const missing = g.needs.find(id => !run.nodes[id]);
	if (missing) return { hold: `Missing prerequisite ${missing}` };
	const deps = writerInputs(run.nodes, waiting({ ...n.grain, needs: g.needs }));
	if (!deps) return { hold: `Unchecked prerequisites for ${g.id}` };
	const stale = Object.entries(deps).find(([id,pin]) => run.nodes[id].state !== "qualified" || review.packet?.outputs[id] !== pin);
	return stale ? { hold: `Prerequisite ${stale[0]} is not qualified at its reviewed revision` } : { predecessor: n };
}

/** @param {Run} run @param {Node} n */
const blockedInput = (run, n) => [...dependencies(run.nodes, [n.grain.id])].some(id => run.nodes[id].state === "blocked");
/** @param {Run} run @param {Node} n */
export const actionable = (run, n) => working(n) || n.state === "waiting" && !blockedInput(run, n);

/** Lifetime assignments still needed by the admitted DAG, not occupied worker slots.
 * Propagate unknown/unavailable inputs downstream once, including through diamonds.
 * @param {Run["nodes"]} nodes */
export function queuedWriters(nodes) {
	const all=Object.values(nodes), held=new Set(all.filter(n=>n.state==="idle" || n.state==="blocked").map(n=>n.grain.id));
	if (held.size) {
		/** @type {Map<string,string[]>} */ const consumers=new Map();
		for (const n of all) for (const id of liveNeeds(n)) {
			const list=consumers.get(id);
			if (list) list.push(n.grain.id);else consumers.set(id,[n.grain.id]);
		}
		for (const id of held) for (const consumer of consumers.get(id)??[]) held.add(consumer);
	}
	return all.filter(n=>n.state==="waiting" && !held.has(n.grain.id)).length;
}

/** @param {Run["nodes"]} nodes @param {number} remaining */
export const discoveryBudget=(nodes,remaining)=>Number.isFinite(remaining)?Math.max(0,remaining-queuedWriters(nodes)):remaining;

/** In a goal run the product check verifies a checkpoint, not a final delivery.
 * One-off runs still wait for all actionable outputs (every output for a seed).
 * @param {Run} run @param {string|undefined} target @param {number} remaining */
export function productOutputs(run, target, remaining) {
	// Do not resubmit the failed assembly without its blamed owner while that repair is outstanding.
	if (Object.values(run.nodes).some(n=>n.retained && n.replaces && !checked(n) &&
		n.retained.some(c=>run.nodes[c.to]?.state==="published"))) return;
	/** @type {Record<string,string>} */ const outputs = {};
	let changed = false;
	for (const n of Object.values(run.nodes)) {
		if (checked(n)) {
			outputs[n.grain.id] = text(n.candidate, "checked output");
			if (n.state === "published") changed = true;
		} else if (!run.goal && n.state !== "idle" && (run.policy.seed ||
			actionable(run, n) && !(remaining === 0 && n.state === "waiting"))) return;
	}
	if (changed || run.goal && (run.goal.target !== target || !run.products.length && run.join?.commit === target)) return outputs;
}

/** The effective inputs are the entire versioned upstream closure. Older keys used the direct edge list.
 * @param {Node["grain"]} g @param {string} base @param {Node["inputs"]} inputs @param {string[]} [edges] */
export const workKey = (g, base, inputs, edges=Object.keys(inputs??{})) => digest([base, g.directory, g.task, g.check, [...edges].sort(), inputs, ...(g.revision && g.revision !== base ? [g.revision] : [])]);

/** @param {Run} run @param {Node["grain"]} g @param {string} base @param {Node["inputs"]} inputs */
export function requireNewWork(run, g, base, inputs) {
	if (!inputs || !run.goal?.tried?.length) return;
	const tried=new Set(run.goal.tried);
	// Older keys include the direct edges. Try the journaled spellings for this task too:
	// adding a shortcut to an already pinned ancestor doesn't change the writer's inputs.
	const duplicate=tried.has(workKey(g,base,inputs)) || Object.keys(inputs).length>1 && (tried.has(workKey(g,base,inputs,g.needs)) ||
		run.effects.some(e=>e.kind==="scout" && e.observation?.grains.some(old=>typeof old!=="string" && old.task===g.task &&
			old.check===g.check && sameScope(old.directory,g.directory) && tried.has(workKey(g,base,inputs,old.needs)))));
	if (duplicate)
		fail("no_progress", `${g.directory}: this assignment with these inputs already reproduced a failing tree. Reuse its checked output or propose different work.`);
}

/** Inputs include transitive versions. Blocked assignments keep their pins only as history.
 * @param {Run["nodes"]} current @param {Record<string,string>} pins */
export function consumersOf(current, pins) {
	const versions = Object.entries(pins);
	return Object.values(current).filter(n => n.state !== "blocked" && versions.some(([id, version]) => n.inputs?.[id] === version));
}

/** Project retirement for validation only; a live consumer vetoes applying the entire change.
 * @param {Run["nodes"]} current @param {Iterable<string>} ids */
function retirement(current, ids) {
	const remove = new Set(ids), pins = Object.fromEntries([...remove].filter(id => settledOutput(current[id]))
		.map(id => [id, text(current[id].candidate, "checked output")]));
	const consumers = [];
	for (const n of consumersOf(current, pins)) {
		if (!settledOutput(n)) consumers.push(n.grain.id);
		remove.add(n.grain.id);
	}
	return { remove, deferred: consumers.length ? { pins, consumers } : undefined };
}

/** @param {Run["nodes"]} current @param {Iterable<string>} ids */
export function superseded(current, ids) {
	const { remove, deferred } = retirement(current, ids);
	if (deferred) fail("frozen_assignment", `A current assignment still consumes a superseded output: ${deferred.consumers.join(", ")}`);
	return remove;
}

/** @param {unknown} value @returns {Proposal} */
export function proposal(value) {
	const g = record(value);
	fields(g, ["id", "task", "directory", "check", "needs", "prior"]);
	/** @type {Proposal["prior"]} */ let prior;
	if (g.prior==="independent" || g.prior==="unavailable") prior=g.prior;
	else if (g.prior!==undefined) {
		const p=record(g.prior);fields(p,["clause"]);
		prior={clause:text(p.clause,"verbatim prior-read clause in the charter")};
	}
	return { id: name(g.id, "grain"), task: text(g.task, "missing behavior"), ...assignmentDirectory(g.directory),
		check: relative(g.check), needs: names(g.needs === undefined ? [] : g.needs, "required output"), ...(prior && {prior}) };
}

/** @param {Run["nodes"]} current @param {(string|import("./model.js").Output)[]} grains */
export function displacedInputs(current, grains) {
	const added = new Set(grains.map(g => typeof g === "string" ? g : g.id));
	for (const g of grains) if (typeof g !== "string") {
		const lost = g.needs.filter(id => !added.has(id) && current[id] && settledOutput(current[id]) && !outside(g.directory, roots(current[id].grain.directory)));
		if (lost.length) return { lost, reason: `${g.id} would own ${g.directory} and retire its required checked output(s): ${lost.map(id => `${id} (${current[id].grain.directory})`).join(", ")}. Use a disjoint directory to consume these outputs, or propose a complete replacement that does not require them.` };
	}
}

/** Check the entire replacement before changing any node, including consumers in other charters.
 * @param {Run["nodes"]} current @param {Area} squad @param {import("./model.js").Observation} report @param {string} review @param {Set<string>} [replaceable] */
export function revise(current, squad, report, review, replaceable = new Set()) {
	const remove = new Set(report.replace);
	for (const id of remove) {
		const n = current[id] ?? fail("unknown_grain", `No such assignment: ${id}`);
		if (!owns(squad, n.grain.directory)) fail("charter_scope", `Not your grain: ${id}`);
		if (!replaceable.has(id) && !settledOutput(n) && (n.generation || n.state !== "waiting" && n.state !== "blocked"))
			fail("frozen_assignment", `Only settled outputs or never reserved work can be split: ${id}`);
	}
	const added = report.grains.map(g => {
		const id = typeof g === "string" ? g : g.id;
		const old = current[id];
		if (old && !owns(squad, old.grain.directory)) fail("charter_scope", `Not your grain: ${id}`);
		if (old && !settledOutput(old) && !remove.has(id)) fail("frozen_assignment", `Cannot redefine an assigned grain: ${id}`);
		if (typeof g === "string") return old?.grain ?? fail("unknown_grain", `No checkpoint output named ${id}`);
		if (!owns(squad, g.directory) || !squad.checks.includes(g.check))
			fail("charter_scope", `Directory or component check is outside ${squad.id}'s charter: ${g.directory}, ${g.check}`);
		return { ...g, specification: squad.charter, boundary: squad.boundary, ...(squad.agent ? { agent: squad.agent } : {}) };
	});
	for (const n of Object.values(current))
		if (settledOutput(n) && added.some(g=>g.id===n.grain.id ||
			!outside(n.grain.directory,roots(g.directory)) && !transferredTo(n,g.id,g.directory))) remove.add(n.grain.id);
	const nodes = { ...current };
	const retired = retirement(current, remove);
	for (const id of retired.remove) {
		const n=current[id];
		if (settledOutput(n) && mixed(n.grain.directory) && !added.some(g=>sameScope(g.directory,n.grain.directory)))
			fail("ownership_transition",`Ordinary repartition cannot retire the primary directory or exact files of checked mixed grant ${id}`);
	}
	for (const n of Object.values(current)) if (protectsGrant(n,retired.remove))
		fail("ownership_transition","Ordinary repartition cannot revoke a retained parent or its transferred grants");
	// If issued, downstream waiters will inherit the vetoing consumer's pins too.
	// Project their retirement for validation only; the live graph stays intact.
	if (retired.deferred) {
		const consumers = new Set(retired.deferred.consumers);
		for (const n of Object.values(current))
			if (n.state === "waiting" && !n.generation && [...dependencies(current, n.grain.needs)].some(id => consumers.has(id)))
				retired.remove.add(n.grain.id);
	}
	for (const id of retired.remove) delete nodes[id];
	for (const g of added) nodes[g.id] = waiting(g, review);
	const conflict = displacedInputs(current, added);
	if (conflict) fail("displaced_input", conflict.reason,{kind:"displaced-input"});
	validateNodes(nodes,{changed:added.map(g=>g.id),removed:retired.remove});
	return { nodes, direct: remove, deferred: retired.deferred };
}
