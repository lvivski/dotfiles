import { acceptedChecks } from "./evidence.mjs";
import { dependencies, owns } from "./plan.mjs";
import { portableReceipt } from "./portable.mjs";
import { publishedComponent } from "./publication.mjs";
import { FoundryError } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */

/** Only deliberately selected, regenerable facts from the included versions. No writer prompt,
 * decision, raw diagnostic or authority to act travels with the product.
 * @param {Run} run @param {import("./portable.mjs").Evidence} [evidence] */
function record(run,evidence) {
	const accepted = acceptedChecks(run);
	if (!accepted?.goal) return null;
	if(!evidence)throw new FoundryError("unproven_inputs","Read the original signed outcomes and Git objects in the owning repository");
	const { last } = accepted, { policy } = run, outputs = [];
	for (const [id, commit] of Object.entries(last.outputs)) {
		const n = run.nodes[id];
		if (n?.state !== "qualified" || n.grain.id !== id || n.candidate !== commit || !n.base || !n.generation || !n.inputs || !n.check) return null;
		const { grain, base, generation, inputs } = n;
		const component=publishedComponent(run,n.check,id,commit)?.component;
		const squad = policy.squads.find(s => "areas" in s ? owns(s, grain.directory) : s.grains.includes(id));
		const required = dependencies(run.nodes, grain.needs);
		if(!component || component.check!==grain.check)throw new FoundryError("unproven_inputs",`Missing original passing, reviewed component ${n.check} for ${id}`);
		if (!squad || required.size !== Object.keys(inputs).length ||
			[...required].some(dep => !Object.hasOwn(inputs, dep) || inputs[dep] !== last.outputs[dep])) return null;
		const receipt=portableReceipt(evidence,run,component,last);
		outputs.push({ id, directory: grain.directory, commit, behavior: grain.task ?? null, specification: grain.specification,
			squad: squad.id, charter: squad.charter, boundary: [...grain.boundary], receipt, base, generation,
			needs: [...grain.needs], inputs: { ...inputs }, ...(component.pair && {pair:component.pair}),
			...(component.observer && {observer:component.observer}), ...(component.remedy && {repairWriter:component.remedy.writer}),
			...(component.replacement && {replacement:component.replacement}), ...(component.rollout && {rollout:component.rollout}),
			...(n.replaces ? { replaces: n.replaces } : {}) });
	}
	const product=portableReceipt(evidence,run,accepted.product,last),goal=portableReceipt(evidence,run,accepted.goal,last);
	return { format:"foundry-qualification/v5", direction: policy.direction,
		...(last.ownership && {ownership:last.ownership}),
		contract: { version: policy.squads.some(s => "areas" in s) ? 2 : 1, path: policy.source, commit: policy.contractTarget ?? policy.base,
			...(policy.contractTarget && {activation:policy.base}) },
		target: { ref: policy.target, commit: last.target }, commit: last.commit, qualifiedAt: last.qualifiedAt,
		receipts: { product, goal }, outputs };
}

/** Historical qualification is not retroactively withdrawn when a portable observation cannot be proven.
 * @param {Run} run @param {import("./portable.mjs").Evidence} [evidence]
 * @returns {{qualification:ReturnType<typeof record>,qualificationUnavailable?:string}} */
export function portableProof(run,evidence){
	try{return {qualification:record(run,evidence)};}
	catch(error){
		if(error instanceof FoundryError || error instanceof Error && "status" in error)
			return {qualification:null,qualificationUnavailable:`Cannot establish the original verification inputs: ${error.message}`};
		throw error;
	}
}
/** @param {Run} run @param {import("./portable.mjs").Evidence} [evidence] */
export const qualification=(run,evidence)=>portableProof(run,evidence).qualification;

/** Owner status only. Compute private cleanup prospects only when explicitly requested.
 * @param {Run} run @param {boolean} [cleanup] */
export function handoff(run, cleanup = false) {
	const product = acceptedChecks(run)?.last;
	if (!product) return null;
	const { policy } = run;
	return { mode: policy.goalCheck ? "goal" : policy.seed ? "one-off" : "ongoing", commit: product.commit, targetRef: policy.target, target: product.target,
		...(cleanup ? { run: run.id, owner: run.owner, writers: cleanupProspects(run, product) } : {}) };
}

/** @param {Run} run @param {import("./model.js").Product} product */
function cleanupProspects(run, product) {
	const { policy, effects } = run;
	const nodes = Object.values(run.nodes);
	const finished = policy.goalCheck || policy.seed?.every(id => run.nodes[id]?.state === "qualified");
	return !finished || run.join || run.blocker || run.conflict ? [] : nodes.flatMap(n => {
		const { worker: id, generation, candidate, grain } = n;
		if (!id || id === run.owner || !generation || !candidate || n.state !== "qualified" || product.outputs[grain.id] !== candidate ||
			nodes.some(other => other !== n && other.worker === id)) return [];
		const component=publishedComponent(run,n.check,grain.id,candidate)?.component;
		if(!component || component.issuer!==id || component.check!==grain.check)return [];
		const bindings = effects.filter(e => e.nativeId === id), [creation] = bindings;
		if (bindings.length !== 1 || creation.kind !== "writer" || creation.tool !== "create_session" || creation.state !== "done" ||
			!creation.callId || creation.issuer !== run.owner || creation.grain !== grain.id || creation.args.base_branch !== generation ||
			creation.args.workspace_type !== "worktree" || creation.args.coordinate_with_creator !== true || typeof creation.args.name !== "string") return [];
		// A participant can create another writer. Neither infer grandchild authority nor offer a cascade.
		if (effects.some(e => (e.issuer === id && e.kind === "writer") || (e.state !== "done" && e.state !== "observed" &&
			(e.issuer === id || e.grain === grain.id || e.args.session_id === id)))) return [];
		return [{ id, name: creation.args.name, grain: grain.id, directory: grain.directory, generation, candidate }];
	});
}
