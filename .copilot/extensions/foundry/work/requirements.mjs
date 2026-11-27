import { hash, oid, validInputs, validName } from "../../../skills/foundry/scripts/recipe.mjs";
import { checkReceipt, signedFact } from "./receipt.mjs";
import { hasPublication } from "./publication.mjs";
import { effectAt } from "./revision.mjs";
import { deadlineAt, digest, fail } from "./values.mjs";
import { commitAt } from "./objects.mjs";
import { declaredOrigin } from "./declarations.mjs";
export { declareAssessment } from "./declarations.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {import("./model.js").CurrentAttempt} Attempt */
/** @typedef {import("./declarations.mjs").Origin} Origin */
const dispatch=new Set(["id","kind","issuer","tool","state","args","attempt","verification","commit","check","callId","error",
	"permissionHold","launcherExit","runnerStarted","runnerClaim","receipt","retirement"]);
/** @param {object} v @param {string[]} keys */
const only=(v,keys)=>Object.keys(v).every(k=>keys.includes(k));

/** Each recorded fact is closed. Its *meaning and necessity* come from the
 * original granting operation; an author cannot drop or add prerequisites.
 * @param {Attempt["facts"][number]} f */
function knownFact(f){
	if(!f || typeof f!=="object")return false;
	switch(f.kind){
	case "activation":return only(f,["kind","policy"]) && oid(f.policy);
	case "assessment":return only(f,["kind","use","target","commit","check"]) && ["goal","product"].includes(f.use) && oid(f.target) && oid(f.commit) && !!f.check;
	case "writer":return only(f,["kind","assignment","origin"]) && validName(f.assignment) && hash(f.origin);
	case "approved":return only(f,["kind","id","bytes","manifest"]) && hash(f.id) && oid(f.bytes) && hash(f.manifest);
	case "consent":return only(f,["kind","offer","answer","terms"]) && [f.offer,f.answer,f.terms].every(hash);
	case "target":return only(f,["kind","ref","commit"]) && typeof f.ref==="string" && f.ref.startsWith("refs/heads/") && oid(f.commit);
	case "clear":return only(f,["kind","issuer"]) && typeof f.issuer==="string" && !!f.issuer;
	case "evaluator":return only(f,["kind","assessment","terms","from","revision","files"]) && validName(f.assessment) && hash(f.terms) && oid(f.from) && oid(f.revision) && Array.isArray(f.files) &&
		f.files.length>0 && f.files.every(p=>typeof p==="string" && !!p) && new Set(f.files).size===f.files.length;
	case "signed":return only(f,["kind","use","check","commit","exit"]) && ["component","product","goal"].includes(f.use) &&
		validName(f.check) && oid(f.commit) && (f.exit===null || Number.isSafeInteger(f.exit) && f.exit>=0);
	case "review":return only(f,["kind","component","inspection","workflow","dispatch"]) && validName(f.component) && validName(f.inspection) && !!f.workflow && !!f.dispatch;
	case "publication":return only(f,["kind","component","subject"]) && validName(f.component) && hash(f.subject);
	case "closed-slot":return only(f,["kind","original","request","position"]) && validName(f.original) && hash(f.request) && Number.isSafeInteger(f.position) && f.position>=0;
	case "build-group":return only(f,["kind","group","prior"]) && hash(f.group) && Array.isArray(f.prior) && f.prior.every(validName) && new Set(f.prior).size===f.prior.length;
	default:return false;
	}
}
const sourceKeys=["kind","policy","commit","target"];
/** @param {Attempt} a */
function knownSource(a){
	const s=a.source;
	if(!s || !oid(s.policy) || !oid(s.commit) || !oid(s.target))return false;
	switch(s.kind){
	case "activation":return a.use==="goal" && s.target===s.commit && only(s,sourceKeys);
	case "receipt":return !a.previous && (s.use==="goal" && ["goal","product"].includes(a.use) || s.use==="product" && a.use==="goal") && validName(s.check) && only(s,[...sourceKeys,"check","use"]);
	case "writer":return a.use==="component" && validName(s.id) && (s.renewed===undefined || !a.previous && validName(s.renewed)) && only(s,[...sourceKeys,"id","renewed"]);
	case "assembly":return !a.previous && a.use==="product" && only(s,sourceKeys);
	case "approval":return hash(s.id) && (!a.previous || a.use==="component") && only(s,[...sourceKeys,"id"]);
	default:return false;
	}
}

/** @param {NonNullable<Check["verification"]>["steps"][number]} step @param {string} commit */
function stepShape(step,commit){
	if(!step || !only(step,["member","inputs","build"]) || !validInputs(step.inputs))return false;
	const {inputs:v,member,build}=step;
	if(v.commit!==commit || v.prepared || v.control || v.checker.replacement ||
		member!==null && (!validName(member) || v.scope.kind!=="component" || v.scope.grain!==member || !build))return false;
	if(!build)return build===null;
	return v.scope.kind==="component" && !v.overlay && only(build,["commit","hook"]) && build.commit===commit &&
		(build.hook===null || !!build.hook && only(build.hook,["path","blob","mode"]) && build.hook.path===".foundry/prepare-components" && oid(build.hook.blob) && build.hook.mode==="100755");
}

/** Shape has one owner independent of how this assessment was selected. Actual
 * entitlement to these steps is independently derived at reservation and claim.
 * @param {Check} e */
export function closedAttempt(e){
	const a=e.attempt,d=e.verification;
	if(e.tool!=="bash" || !e.check || a?.version!==3 || !["component","product","goal"].includes(a.use) || a.use!==e.kind ||
		!only(a,["version","use","grant","facts","source","previous"]) || "previous" in a && !validName(a.previous) ||
		!knownSource(a) || !hash(a.grant) || !Array.isArray(a.facts) || !a.facts.length || !a.facts.every(knownFact) ||
		d?.version!==1 || !only(d,["version","use","grant","target","contract","evaluation","steps","joined","privateInput","resolutions"]) ||
		"resolutions" in d && (!d.joined || !hash(d.resolutions)) ||
		d.use!==a.use || d.grant!==a.grant || d.target!==a.source.target || d.contract!==(a.source.kind==="approval"?d.target:a.source.policy) || e.commit!==a.source.commit ||
		d.evaluation?.kind!==a.use || !Array.isArray(d.steps) || !d.steps.length || !d.steps.every(step=>stepShape(step,a.source.commit)))return false;
	const {inputs:v,member}=d.steps[d.steps.length-1],use=a.use;
	if(member!==null || v.checker.path!==e.check || v.scope.kind!==use || v.overlay?.revision!==e.evaluatorRevision ||
		(v.delta?use!=="goal" || !oid(d.privateInput):"privateInput" in d))return false;
	const fields=use==="component"?["grain","inlineRepair","usedArtifacts","comparedArtifacts"]:use==="goal"?["evaluatorRevision","productEvaluatorRevision"]:["evaluatorRevision"];
	if(!Object.keys(e).every(k=>dispatch.has(k) || fields.includes(k)) || e.productEvaluatorRevision!==undefined && !oid(e.productEvaluatorRevision))return false;
	if(d.evaluation.kind==="goal" && (!only(d.evaluation,["kind","squads"]) || !Array.isArray(d.evaluation.squads) || !d.evaluation.squads.every(validName)))return false;
	if(d.evaluation.kind==="component" && (!only(d.evaluation,["kind"]) || !validName(e.grain) || v.scope.kind!=="component" || v.scope.grain!==e.grain))return false;
	if(d.evaluation.kind==="product" && (!only(d.evaluation,["kind","outputs"]) || v.scope.kind!=="product" ||
		digest(d.evaluation.outputs)!==digest(v.scope.outputs.map(o=>o.id))))return false;
	if(d.joined===undefined)return d.steps.length===1;
	return d.joined===true && d.evaluation.kind==="product" && d.steps.length>1 &&
		digest(d.steps.slice(0,-1).map(s=>s.member))===digest(d.evaluation.outputs) && d.steps.slice(0,-1).every(s=>digest(s.build)===digest(d.steps[0].build));
}

/** An inactive reservation can remain true history after refusal, publication or
 * reassignment. Reading history may not claim it.
 * @param {Run} run @param {Check} e @param {Origin} [origin] */
export function recordedAttempt(run,e,origin){
	const bound=origin??declaredOrigin(run,e);
	return !!bound && closedAttempt(e) && digest(bound.expected)===digest(e.attempt);
}
/** @param {Run} run @param {Check} e @param {Origin} [origin] */
export function authorizedAttempt(run,e,origin){
	const bound=origin??declaredOrigin(run,e);
	return !!bound && bound.slot===e.id && recordedAttempt(run,e,bound);
}

/** The source owns the admissible slot; these fact kinds own their sampling
 * boundaries. Neither the evaluator nor a caller-supplied label chooses a guard.
 * @param {Run} run @param {Check} e @param {Origin} [origin] */
export function currentDeclaration(run,e,origin){
	const bound=origin??declaredOrigin(run,e);
	if(!bound || !authorizedAttempt(run,e,bound) || e.attempt?.version!==3)return false;
	const at=run.effects.indexOf(e);
	return e.attempt.facts.every(f=>f.kind==="publication"?hasPublication(run,f):
		f.kind!=="signed" || signedFact(run,at,effectAt(run,f.check),f.use,f.commit)?.exit===f.exit);
}
/** @param {string} cwd @param {Run} run @param {Check} e @param {Origin} [origin] */
export function sampleLive(cwd,run,e,origin){
	if(!currentDeclaration(run,e,origin) || e.attempt?.version!==3)fail("stale_assignment","The original declaration no longer has its approved slot");
	for(const f of e.attempt.facts){
		if(f.kind==="target" && commitAt(cwd,f.ref)!==f.commit)fail("stale_pin","The approved target moved before verification");
		if(f.kind==="clear" && (!run.active || f.issuer!==e.issuer || run.policyHold || run.conflict || run.blocker || run.policy.deadline && Date.now()>=(deadlineAt(run.policy.deadline)??-Infinity) ||
			run.effects.some(c=>c.permissionHold) || run.inspections?.some(i=>i.permissionHold)))fail("stale_assignment","The original issuer, permission or run is held");
	}
}
/** Re-sample the exact declared pins at native issue, including inside its final
 * compare-and-swap. A lost race must not hand the native host a command.
 * @param {string} cwd @param {Run} run @param {Check} e @param {()=>boolean} closed @param {Origin} [origin] */
export function declarationIssue(cwd,run,e,closed,origin){
	const current=()=>{
		if(closed())return false;
		try{sampleLive(cwd,run,e,origin);return true;}
		catch(error){if(error instanceof Error && ("code" in error && ["stale_pin","stale_assignment"].includes(String(error.code)) || "status" in error))return false;throw error;}
	};
	return current() && current;
}
/** @param {Run} run @param {Attempt} a */
export function preparationGroup(run,a){
	const group=a.facts.find(f=>f.kind==="build-group");
	return group?{group:group.group,prior:group.prior.map(id=>{
		const c=effectAt(run,id);
		if(!c?.runnerClaim || checkReceipt(c)?.exit!==0)fail("missing_receipt","Missing original predecessor for prepared inputs");
		return {id,claim:c.runnerClaim};
	}).reverse()}:undefined;
}

/** A complete, well-shaped recipe still cannot replace the executable at the
 * originally granted commit. @param {string} cwd @param {Run} run @param {Check} e @param {Origin} [origin] */
export function verifyClaim(cwd,run,e,origin){
	if(!e.callId || e.runnerClaim || e.runnerStarted || e.receipt || !["issued","uncertain"].includes(e.state))
		fail("unissued_check","Expected the original, issued and unclaimed assessment");
	const bound=origin??declaredOrigin(run,e,undefined,cwd);
	sampleLive(cwd,run,e,bound);
	if(!bound?.recipe || digest(bound.recipe)!==digest(e.verification))fail("invalid_inputs","Current grant and exact physical inputs are required at claim");
}
