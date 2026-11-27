import { checkReceipt, sameEvaluation } from "./receipt.mjs";
import { git } from "../../../skills/foundry/scripts/git-files.mjs";
import { changedFiles } from "./objects.mjs";
import { FoundryError } from "./values.mjs";
export {validFeedback,feedback,goalFiles} from "../../../skills/foundry/scripts/materialize.mjs";
/** @typedef {{base:string, previous:string} | {base:string, file:NonNullable<import("./model.js").Receipt["feedbackFile"]>}} Prior */
/** @param {import("./model.js").Run} run @param {import("./model.js").Effect} current @returns {Prior|undefined} */
export function priorGoal(run, current) {
	const e=feedbackSource(run,current),r=checkReceipt(e);
	if(r?.feedbackFile)return { base:r.commit, file:r.feedbackFile };
	if(r?.feedback!==undefined)return { base:r.commit, previous:r.feedback };
}
/** @param {import("./model.js").Run} run @param {import("./model.js").Effect} current */
export function feedbackSource(run,current){
	for (let i = run.effects.indexOf(current) - 1; i >= 0; i--) {
		const e = run.effects[i];
		if (e.kind !== "goal") continue;
		if (e.check !== current.check || !sameEvaluation(e,current)) return;
		const r = checkReceipt(e);
		if (!r || r.exit !== 0 && r.exit !== 1) continue;
		return r.feedbackFile || r.feedback!==undefined ? e : undefined;
	}
}

/** @param {string} cwd @param {string} head @param {Prior} prior */
export function goalDelta(cwd, head, prior) {
	const { base } = prior;
	let paths, previous;
	try {
		previous = "file" in prior ? git(cwd, ["cat-file", "blob", prior.file.blob]).toString() : prior.previous;
		paths = changedFiles(cwd, base, head, [], Infinity);
	}
	catch (error) {
		// Unavailable objects or paths are not an empty diff.
		if (error instanceof FoundryError || error instanceof Error && "status" in error) return;
		throw error;
	}
	return `{"version":1,"base":${JSON.stringify(base)},"head":${JSON.stringify(head)},"paths":${JSON.stringify(paths)},"previous":${previous}}`;
}

/** @param {string} cwd @param {string} head @param {Prior|undefined} prior */
export function schedulingInput(cwd,head,prior){
	const bytes=prior && goalDelta(cwd,head,prior);
	return prior && bytes!==undefined ? {bytes,inline:("previous" in prior || !!prior.file.legacy) && Buffer.byteLength(bytes)<=32768}:undefined;
}

export {retainFeedback} from "./objects.mjs";
