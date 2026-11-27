import { regularFiles } from "../../../skills/foundry/scripts/git-files.mjs";
import { validName } from "../../../skills/foundry/scripts/recipe.mjs";
import { preparationHook, resolveInputs } from "../../../skills/foundry/scripts/materialize.mjs";
import { changedFiles, contractPaths, verifyContracts } from "./objects.mjs";
import { evaluatorFacts, selectedGoal } from "./overlay.mjs";
import { signedFact } from "./receipt.mjs";
import { assemblyAt, effectAt, productAt } from "./revision.mjs";
import { digest, fail } from "./values.mjs";

/** @typedef {import("./model.js").Adoption} Offer */
/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {import("./model.js").CurrentAttempt} Attempt */
/** @typedef {import("./model.js").CorrectionDraft} Draft */
/** @param {unknown} v */
export function approvedInput(v){
	if(!v || typeof v!=="object" || Array.isArray(v) || Object.keys(v).length!==2)return false;
	return "member" in v?"afterReviewOf" in v && validName(v.member) && validName(v.afterReviewOf):
		"component" in v && "inspection" in v && validName(v.component) && validName(v.inspection);
}
/** @param {Omit<Draft,"id">} d */
export const draftId=d=>digest([d.check,d.checkpoint,d.goal,d.target,d.product,d.assembly,d.evaluator??null,d.previousCheck??null,d.automatic,d.parts.map(p=>[p.source,p.files])]);
/** @param {Draft} d */
export const draftAllowed=d=>d.automatic ? !d.decision : d.decision?.status==="answered" && d.decision.answer===d.id;
/** @param {Draft} d */
export const draftChanges=d=>d.parts.flatMap(p=>p.changes??[]).sort((a,b)=>a.file<b.file?-1:1);
/** Compare preimages as well as new bytes and file modes.
 * @param {Draft|undefined} d @param {string} check @param {string} assembly @param {import("./model.js").HarnessRollout["files"]} [delta] */
export const sameDraft=(d,check,assembly,delta)=>!!d && d.check===check && d.assembly===assembly &&
	(!delta || digest(draftChanges(d))===digest([...delta].sort((a,b)=>a.file<b.file?-1:1)));
/** @typedef {import("./model.js").Artifact & {draft?:Draft,index?:number}} Ref */
/** Original **owner offers** and bound author answers are distinct evidence.
 * @param {Run} run @returns {Ref[]} */
export function correctionRefs(run){
	return [...(run.artifacts??[]).flatMap((a,index)=>a.publisher===run.owner?[{...a,index,draft:undefined}]:[]),
		...(run.correctionDrafts??[]).flatMap(d=>d.blob && draftAllowed(d) && d.parts.every(p=>p.state==="returned" && !!p.workflow)?
			[{draft:d,base:d.target,file:"writer-correction.diff",blob:d.blob,publisher:d.parts.map(p=>p.workflow).join(", "),
				to:d.evaluator?[d.evaluator]:draftChanges(d).map(f=>f.file),...(d.evaluator?
					{evaluation:{from:d.assembly,checkpoint:d.checkpoint,goal:d.goal}}:{assembly:d.assembly})}]:[])];
}
/** @param {Omit<Offer,"id"|"basis"|"decision"|"previous">} s */
export const offerId=s=>digest([s.revision,s.checkpoint,s.goal,s.assembly??null,...(s.failed?[s.failed,s.rollout??s.patch??s.message]:[s.evaluator??s.manifest??s.message])]);

/** @param {Run} run @param {Check} e @param {Attempt["source"]} source @param {Attempt["use"]} use @param {Attempt["facts"]} facts @returns {Attempt} */
export function declaration(run,e,source,use,facts){
	return {version:3,source,use,grant:digest(["foundry-power/v3",run.id,run.owner,run.policy.source,e.check,source,use,facts]),facts};
}

/** Compare physical observations only. The historical grant cannot become a
 * current grant; its original recipe and use must nevertheless match exactly.
 * @param {import("./model.js").CheckDescription|undefined} before @param {import("./model.js").CheckDescription} next */
export function sameRecipe(before,next){
	if(!before)return false;
	const {grant:old,...prior}=before,{grant:fresh,...current}=next;
	return digest(prior)===digest(current);
}

/** @param {string} cwd @param {string} commit */
export function buildAt(cwd,commit){
	const hook=preparationHook(cwd,commit);
	return {commit,hook:hook?{path:hook.name,mode:/** @type {const} */("100755"),blob:hook.oid}:null};
}
/** @param {string} cwd @param {string} commit @param {string} check @param {string} grain
 * @param {import("./model.js").Inspection["scope"]} scope @param {ReturnType<typeof buildAt>} build @param {string|null} member */
export const preparedMember=(cwd,commit,check,grain,scope,build,member)=>({member,build,inputs:resolveInputs(cwd,{commit,check,scope:{kind:"component",grain,...scope}})});

/** Project an answered target manifest and its original checkpoints. No request for
 * changed rights, rollback, dispatch, signing, or mutable grant enters this reader.
 * @param {Run} run @param {Check} e @param {string} id @param {string} [cwd] */
export function adopted(run,e,id,cwd){
	const a=run.adoptions?.find(a=>a.id===id),m=a?.manifest;
	if(!m || !a || !a.assembly || a.assembly!==e.commit || a.id!==offerId(a) || a.decision?.status!=="answered" || !a.decision.answer ||
		e.issuer!==run.owner || (e.kind==="goal"?e.productEvaluatorRevision!==a.revision || !e.evaluatorRevision:
			e.kind!=="product" || e.evaluatorRevision!==a.revision || !!e.productEvaluatorRevision))return;
	const answer=a.decision.answer;
	const p=run.productRepins?.find(p=>p.targetFrom===m.from && p.from===m.productFrom && p.revision===a.revision && p.checkpoint===a.checkpoint &&
		p.goal===a.goal && p.acceptance===answer && digest(p.files)===digest(m.files) && digest(p.resolutions??[])===digest(m.resolutions??[]));
	const goalPin=run.repins?.find(g=>g.from===m.goalFrom && g.revision===a.revision && digest(g.files)===digest(m.files));
	const original=productAt(run,a.checkpoint),at=run.effects.indexOf(e);
	if(!p || !goalPin || !original || p.recheck!==(e.kind==="product"?e.id:productAt(run,p.recheck)?.check))return;
	const checkpoint=signedFact(run,at,effectAt(run,a.checkpoint),"product",original.commit),goal=signedFact(run,at,effectAt(run,a.goal),"goal",original.commit);
	if(checkpoint?.exit!==0 || goal?.exit!==1 && goal?.exit!==2)return;
	const joined=assemblyAt(run,p,p.recheck);
	if(!joined || joined.commit!==a.assembly || joined.target!==a.revision || digest(joined.outputs)!==digest(m.outputs))return;
	if(cwd){
		const conserved=contractPaths({...run.policy,contractTarget:a.revision}),pins=new Set([m.from,m.productFrom,m.goalFrom]);
		const changed=[...new Set([...pins].flatMap(pin=>changedFiles(cwd,pin,a.revision,conserved)))].sort();
		if(!changed.length || digest(changed)!==digest(m.files) || changed.includes(run.policy.source))fail("invalid_inputs","The adopted contract differs from the reviewed manifest");
		verifyContracts(cwd,{...run.policy,contractTarget:a.revision},a.assembly);
		for(const r of m.resolutions??[]){
			const [f]=regularFiles(cwd,a.assembly,[r.file]);if(f.mode!==r.mode || f.oid!==r.result)fail("invalid_inputs","The adopted assembly has a different resolution");
		}
	}
	/** @type {Attempt["facts"]} */ const facts=[{kind:"consent",offer:id,terms:digest(m),answer:digest(a.decision.answer)},checkpoint,goal,{kind:"clear",issuer:e.issuer}];
	if(e.kind==="goal" && e.evaluatorRevision!==a.revision){
		const pin=run.repins?.find(g=>g.revision===e.evaluatorRevision),old=effectAt(run,pin?.assessment);
		const prior=signedFact(run,at,old,"goal",joined.commit);
		if(!pin || old?.kind!=="goal" || old.check!==e.check || old.productEvaluatorRevision!==a.revision || old.attempt?.version!==3 ||
			old.attempt.source.kind!=="approval" || old.attempt.source.id!==id || !prior || run.policy.contractTarget!==a.revision)return;
		facts.push(prior,...evaluatorFacts(run,e,"goal",pin.revision,cwd));
	}
	return {a,p,joined,facts,current:run.policy.contractTarget===a.revision && run.productRepins?.at(-1)===p && (e.kind==="product" || selectedGoal(run,e))};
}
