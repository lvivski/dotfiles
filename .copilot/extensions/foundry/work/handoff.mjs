import { acceptedChecks, checkReceipt, passingReceipt } from "./evidence.mjs";
import { dependencies, owns } from "./plan.mjs";

/** @typedef {import("./model.js").Run} Run */

/** Only deliberately selected, regenerable facts from the included versions. No writer prompt,
 * decision, raw diagnostic or authority to act travels with the product.
 * @param {Run} run */
export function qualification(run) {
	const accepted = acceptedChecks(run);
	if (!accepted?.goal) return null;
	const { last, product, goal } = accepted, { policy } = run, outputs = [];
	const effects = new Map(run.effects.map(e => [e.id, e]));
	for (const [id, commit] of Object.entries(last.outputs)) {
		const n = run.nodes[id];
		if (n?.state !== "qualified" || n.grain.id !== id || n.candidate !== commit || !n.base || !n.generation || !n.inputs || !n.check) return null;
		const { grain, base, generation, inputs } = n;
		const receipt = passingReceipt(effects.get(n.check), "component", commit, grain.check, id);
		const squad = policy.squads.find(s => "areas" in s ? owns(s, grain.directory) : s.grains.includes(id));
		const required = dependencies(run.nodes, grain.needs);
		if (!receipt || !squad || required.size !== Object.keys(inputs).length ||
			[...required].some(dep => !Object.hasOwn(inputs, dep) || inputs[dep] !== last.outputs[dep])) return null;
		outputs.push({ id, directory: grain.directory, commit, behavior: grain.task ?? null, specification: grain.specification,
			squad: squad.id, charter: squad.charter, boundary: [...grain.boundary], receipt, base, generation,
			needs: [...grain.needs], inputs: { ...inputs }, ...(n.replaces ? { replaces: n.replaces } : {}) });
	}
	return { format: "foundry-qualification/v1", direction: policy.direction,
		contract: { version: policy.squads.some(s => "areas" in s) ? 2 : 1, path: policy.source, commit: policy.base },
		target: { ref: policy.target, commit: last.target }, commit: last.commit, qualifiedAt: last.qualifiedAt,
		receipts: { product, goal }, outputs };
}

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
		const component = effects.find(e => e.id === n.check);
		if (component?.kind !== "component" || component.issuer !== id || component.grain !== grain.id ||
			component.commit !== candidate || component.check !== grain.check || checkReceipt(component)?.exit !== 0) return [];
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
