import { assign } from "./assignment.mjs";
import { deliveredFile } from "./pages.mjs";
import { changedFiles, rejoin, regularFiles, retain, verifyContracts } from "./product.mjs";
import { comparison, requestedFiles, reviews } from "./reviews.mjs";
import { touchesCut } from "./transfer.mjs";
import { covers, digest, fail, FoundryError, ownership, roots as scopePaths, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */

/** @param {string} cwd @param {Run} run @param {string} target */
export function productBase(cwd, run, target) {
	verifyContracts(cwd, run.policy, target);
	const last = run.products.at(-1);
	if (target !== run.policy.base && target !== last?.target) retain(cwd, target);
	if (!last)
		return target;
	if (last.target === target)
		return last.commit;
	return rejoin(cwd, last, target);
}

/** @param {Run} run @param {Record<string,string>} outputs */
export function changes(run, outputs) {
	return Object.entries(outputs).filter(([id]) => run.nodes[id].state !== "qualified").flatMap(([id, to]) =>
		scopePaths(run.nodes[id].grain.directory).map(directory => ({ directory, exact:ownership(run.nodes[id].grain.directory).files.includes(directory), retained:run.nodes[id].retained, from: run.nodes[id].replaces ?? text(run.nodes[id].base, "producer base"), to })));
}

export class InputMismatch extends FoundryError {
	/** @param {string} message @param {NonNullable<Node["excluded"]>} input */
	constructor(message, input) {
		super("stale_assignment", `${message}: ${"path" in input ? `${input.revision}:${input.path}` : `${input.grain}@${input.revision}`}`);
		this.input = input;
	}
}

/** @param {Run} run @param {Node} n @param {import("./model.js").Review|undefined} review */
export function citedFiles(run, n, review) {
	return review && run.policy.sharedBrief ? [...requestedFiles(run, review)].filter(file =>
		!covers(n.grain.directory, file) && review.observation?.evidence.includes(file)) : [];
}

/** Older writers were explicitly given every requested, cited external path, even one
 * inside a prerequisite. Don't retroactively rewrite their kickoff after a reload.
 * @param {string} cwd @param {Run} run @param {Node} n @param {string} commit @param {string[]} [supporting] */
export function verifyEvidence(cwd, run, n, commit, supporting = n.supporting) {
	const r = reviews(run).find(r => r.id === n.review);
	if (!r || r.base === commit) return;
	const frozen = [r.correction?.file, comparison(run,r)?.source?.file].filter(
		/** @returns {file is string} */ file => !!file && !covers(n.grain.directory,file));
	const files = [...new Set([...frozen, ...(supporting ?? citedFiles(run,n,r))])];
	if (!files.length) return;
	const [file] = changedFiles(cwd, r.base, commit, files);
	if (file) throw new InputMismatch(frozen.includes(file) ? `The frozen evidence for ${n.grain.id} changed before integration` :
		"A supporting file in the writer's brief changed since this assignment", {revision:r.base,path:file});
}

/** A stopped writer may have missed a replacement prerequisite or a newer checkpoint.
 * @param {string} cwd @param {Run} run @param {Node} n @param {Record<string,string>} required @param {string} base */
export function verifyRepairInputs(cwd, run, n, required, base) {
	if (!n.inputs || digest(required) !== digest(n.inputs))
		fail("stale_assignment", "The writer's pinned prerequisites are no longer current");
	const original = text(n.base, "writer base"), directory = n.grain.directory;
	if (changedFiles(cwd, n.replaces ?? original, base, scopePaths(directory)).some(p=>!touchesCut(n.retained ?? [],p)))
		fail("stale_assignment", `The reviewed directory ${directory} changed since this assignment`);
	for (const [id, pin] of Object.entries(required)) {
		const dirs = scopePaths(run.nodes[id].grain.directory);
		if (changedFiles(cwd, original, base, dirs).length && changedFiles(cwd, pin, base, dirs).length)
			fail("stale_assignment", `The reviewed input ${dirs.join(", ")} changed since this assignment`);
	}
	verifyEvidence(cwd, run, n, base);
}

/** Check admissions on the actual assembled tree. A non-null base is the tree onto
 * which directories are being merged. An exact patch on an already approved join has
 * no directory merge; comparing it to the old checkpoint would reject newly included outputs.
 * @param {string} cwd @param {Run} run @param {Record<string,string>} outputs @param {string|null} base @param {string} commit */
function* incompatibleInputs(cwd, run, outputs, base, commit) {
	const last = run.products.at(-1);
	for (const id of Object.keys(outputs)) {
		const n = run.nodes[id];
		if (n.state === "qualified" || n.state === "repeated" && last?.outputs[id] === outputs[id]) continue;
		try {
			if (base!==null && run.goal && n.base !== base && changedFiles(cwd,n.replaces ?? text(n.base,"producer base"),base,scopePaths(n.grain.directory)).some(p=>!touchesCut(n.retained ?? [],p)))
				fail("tree_conflict", `The reviewed directory ${n.grain.directory} changed since this assignment`);
			for (const [dep,pin] of Object.entries(n.inputs ?? {})) {
				if (outputs[dep] !== pin)
					throw new InputMismatch(`A checked input of ${id} is no longer included`,{revision:pin,grain:dep});
				const dirs = scopePaths(run.nodes[dep].grain.directory);
				const [changed] = changedFiles(cwd,pin,commit,dirs);
				if (changed) throw new InputMismatch(`A checked input of ${id} changed before integration`,{revision:pin,path:changed});
			}
			verifyEvidence(cwd,run,n,commit);
		} catch (error) {
			if (!(error instanceof InputMismatch)) throw error;
			yield {n,error};
		}
	}
}

/** @param {string} cwd @param {Run} run @param {Record<string,string>} outputs @param {string|null} base @param {string} commit */
export function verifyJoinedInputs(cwd,run,outputs,base,commit) {
	for (const {error} of incompatibleInputs(cwd,run,outputs,base,commit)) throw error;
}

/** @param {string} cwd @param {Run} run @param {Record<string,string>} outputs @param {string} base @param {string} commit */
export function excludeIncompatible(cwd,run,outputs,base,commit) {
	const conflicts = [...incompatibleInputs(cwd,run,outputs,base,commit)];
	for (const {n,error} of conflicts) {
		assign(n,{type:"stop",reason:error.message});
		n.excluded = error.input;
	}
	return !!conflicts.length;
}

/** An assigning scout's citation is not necessarily a writer input. Only the
 * published retainer can use this distinction, and only for the same Git evidence.
 * @param {string} cwd @param {Run} run @param {import("./model.js").Node} owner @param {string} primary @param {string} commit */
export function verifiedCitations(cwd,run,owner,primary,commit) {
	if (owner.state!=="published") return;
	const r=run.effects.find(e=>e.id===owner.review);
	if (r?.kind!=="scout" || r.state!=="observed" || r.observation?.outcome!=="regenerate" || !r.packet) return;
	const {packet}=r, paths=r.observation.evidence.filter(p=>covers(primary,p));
	const source=comparison(run,r)?.source?.file;
	if (!paths.length || packet.review!==r.id || packet.base!==r.base || source && covers(primary,source)) return;
	const legacyInputs=run.policy.sharedBrief && !owner.supporting ? requestedFiles(run,r) : undefined;
	if (paths.some(p=>legacyInputs?.has(p)) || changedFiles(cwd,r.base,commit,paths).length) return;
	if (regularFiles(cwd,commit,paths).every(e=>deliveredFile(packet,e.name,e.oid))) return {review:r.id,paths};
}
