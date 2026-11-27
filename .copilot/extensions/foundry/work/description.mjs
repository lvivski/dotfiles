import { git } from "../../../skills/foundry/scripts/git-files.mjs";
import { inputCommits } from "../../../skills/foundry/scripts/recipe.mjs";
import { declaredOrigin, declareOutput } from "./declarations.mjs";
import { approvalEvidence, priorPublications, priorWriters } from "./historical.mjs";
import { retain } from "./objects.mjs";
import { authorizedAttempt } from "./requirements.mjs";
import { fail } from "./values.mjs";

/** @param {import("./model.js").Run} run @param {import("./model.js").NativeCall} e @param {string} [cwd] */
export const sourceAt=(run,e,cwd)=>declaredOrigin(run,e,approvalEvidence(run,e,cwd),cwd,priorWriters(run,e),priorPublications(run,e));
/** @param {import("./model.js").Run} run @param {import("./model.js").NativeCall} e @param {Parameters<typeof declareOutput>[2]} source @param {string} [target] */
export const bindOutput=(run,e,source,target=run.policy.base)=>declareOutput(run,e,source,target,priorWriters(run,e),priorPublications(run,e));

/** Materialize the granting operation's declaration on the private reservation,
 * before the journal transaction. Historical descriptions are never recomputed.
 * @param {string} cwd @param {import("./model.js").Run} run @param {number} first */
export function describeNewChecks(cwd,run,first){
	for(const e of run.effects.slice(first))if(e.tool==="bash"){
		if(e.attempt?.version!==3)fail("current_authority_required","The granting operation has not declared this check's current requirements");
		if(e.verification)fail("invalid_inputs","A newly reserved check cannot supply its own input description");
		const origin=sourceAt(run,e,cwd);
		e.verification=origin?.recipe??fail("current_authority_required","Missing original grant or required predecessor");
		if(!authorizedAttempt(run,e,origin))fail("current_authority_required","The declaration differs from the authorized inputs");
		for(const pin of new Set(e.verification.steps.flatMap(s=>inputCommits(s.inputs))))retain(cwd,pin);
		if(origin?.delta!==undefined && retain(cwd,git(cwd,["hash-object","-w","--stdin"],origin.delta).toString().trim())!==e.verification.privateInput)
			fail("invalid_inputs","Cannot retain the declared private feedback");
	}
}
