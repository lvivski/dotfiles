import { checkedOverlay, pinnedChecker, preparationHook, resolveInputs } from "../../../skills/foundry/scripts/materialize.mjs";
import { inputCommits } from "../../../skills/foundry/scripts/recipe.mjs";
import { certifiedTest, controlOverlay, repairStop } from "./calibration.mjs";
import { evaluatorOverlay } from "./contract.mjs";
import { mixedVerification, verificationSource } from "./evidence.mjs";
import { priorGoal, schedulingInput } from "./feedback.mjs";
import { harnessFiles } from "./harness.mjs";
import { checkUse, componentScope, described, productScope } from "./inputs.mjs";
import { isolationSeal } from "./isolation.mjs";
import { changedBlobs, git, regularFiles, retain, rolloutFiles, verifyContracts } from "./product.mjs";
import { replacementOffer } from "./replacement.mjs";
import { rolloutOffer } from "./campaign.mjs";
import { grant as ownership } from "./transfer.mjs";
import { digest, fail, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {import("./model.js").CheckDescription} Description */
/** @typedef {Description["steps"][number]} Step */

/** The host calls this on the finalized private reservation, not a claim or an earlier graph draft.
 * Only the immutable Git inputs go into the recipe. No private delta text or host environment is journaled.
 * @param {string} cwd @param {Run} run @param {Check} e @returns {Description} */
export function describeCheck(cwd,run,e){
	const check=text(e.check,"reserved evaluator"),commit=text(e.commit,"reserved commit"),k=e.calibration;
	const repair=k && run.testRepairs?.find(j=>j.stop===k.stop),original=repair && repairStop(run,repair);
	if(k && (!repair || !original))fail("missing_receipt","Missing original calibration obligation");
	const product=run.join,grain=repair?.grain??e.grain,kind=(original??e).kind;
	const scope=(kind==="component" || kind==="rerun" || repair?.grain) && grain ? componentScope(grain,e.rerun?.directory??run.nodes[grain].grain.directory) :
		kind==="product"?productScope(run,product):kind==="goal"?/** @type {const} */({kind:"goal"}):fail("invalid_inputs","Missing evaluator role");
	const evaluation=repair || scope.kind==="component"?/** @type {const} */({kind:"component"}):
		scope.kind==="product"?/** @type {const} */({kind:"product",outputs:scope.outputs.map(o=>o.id)}):
			/** @type {const} */({kind:"goal",squads:run.policy.squads.map(s=>s.id)});
	const migration=e.kind==="product" && mixedVerification(run,verificationSource(run,e.id)),control=k&&repair&&controlOverlay(run,repair,k.role);
	const amended=migration && migration.amendments?.find(s=>s.recheck===verificationSource(run,e.id));
	const replacementOwner=replacementOffer(run,e),offer=rolloutOffer(run,e)??(amended && run.adoptions?.find(a=>a.id===amended.proposal));
	const patch=replacementOwner?.patch??(offer && offer.patch),rollout=offer && offer.rollout,from=amended && amended.prior.commit || replacementOwner && run.join?.commit;
	if(rollout && digest(rolloutFiles(cwd,rollout.from,commit))!==digest(rollout.files))
		fail("invalid_patch","The assembly differs from the complete approved harness rollout");
	if(!rollout && from && (!patch || digest(changedBlobs(cwd,from,commit))!==digest(patch.files)))
		fail("invalid_patch","The assembly does not match the complete approved file changes");
	if(migration){
		verifyContracts(cwd,{...run.policy,contractTarget:e.evaluatorRevision},commit);
		for(const r of migration.resolutions??[]){
			const [file]=regularFiles(cwd,commit,[r.file]);
			if(file.mode!==r.mode || file.oid!==r.result)fail("invalid_resolution",`Joined product does not contain the approved resolution: ${r.file}`);
		}
	}
	const prepared=!!(e.replacement || e.rollout || repair && (original?.rollout || original?.kind==="product" && repair.grain));
	const subject=prepared && repair?repair.product:commit,source=e.rerun?{revision:e.rerun.candidate,
		paths:harnessFiles(cwd,subject,check,e.rerun).files.map(x=>x.name)}:checkedOverlay(control?.prior??(
		e.evaluatorRevision && (e.kind==="goal" || e.kind==="product")?evaluatorOverlay(run,e.kind,e.evaluatorRevision):undefined));
	const delta=scope.kind==="goal"?schedulingInput(cwd,repair?.product??commit,priorGoal(run,original??e)):undefined;
	// A cache hit can replace a build, never an evaluator. Bind the pristine build source and hook, including its absence.
	/** @param {string} revision @returns {Step["build"]} */
	function build(revision){
		const hook=preparationHook(cwd,revision);
		return {commit:revision,hook:hook?{path:hook.name,mode:"100755",blob:hook.oid}:null};
	}
	/** @param {string} path @param {string|undefined} member */
	function replacement(path,member){
		const test=certifiedTest(run,e,path,member);
		return test?.revision && (e.testPin && member===e.grain || regularFiles(cwd,commit,[path])[0].oid===test.before)?
			{file:path,revision:test.revision,blob:test.blob,before:test.before}:undefined;
	}
	/** @type {Step[]} */ const steps=[];
	if(migration){
		const prep=build(commit);
		for(const id of Object.keys(product?.outputs??{})){
			const n=run.nodes[id];
			steps.push({member:id,build:prep,inputs:resolveInputs(cwd,{commit,check:n.grain.check,
				scope:componentScope(id,n.grain.directory),test:replacement(n.grain.check,id)})});
		}
	}
	const driver=repair && pinnedChecker(cwd,run.policy.base,repair.rule.probe);
	if(repair && (driver?.mode!=="100755" || driver.blob!==repair.driver))fail("stale_assignment","Calibration driver differs from its activation pin");
	steps.push({member:null,build:prepared?build(subject):null,inputs:resolveInputs(cwd,{commit:subject,check:repair?.rule.check??check,scope,
		overlay:source,test:control?.test??replacement(check,e.grain),delta,
		control:k&&driver?{commit:run.policy.base,checker:driver,example:k.role==="newBad"?"bad":"good"}:undefined})});
	const use=checkUse(e)??fail("invalid_inputs","Unknown verification obligation");
	const target=(migration?migration.revision:e.rollout || e.replacement?run.policy.contractTarget:undefined) ??
		(e.kind==="product"?product?.target:run.goal?.target)??run.policy.contractTarget??run.policy.base;
	const subset=run.independent;
	if(e.isolation && (!subset || e.isolation!==isolationSeal(subset) || ![subset.product,subset.assessment].includes(e.id)))
		fail("invalid_inputs","The non-release check lost its original frozen ownership and footprint proof");
	const sources=e.isolation ? e.isolation : Object.fromEntries((scope.kind==="product"?scope.outputs.map(o=>o.id):grain?[grain]:[]).map(id=>{
		const n=run.nodes[id]??fail("incomplete_evidence",`No checked grant for ${id}`);return [id,[n.grain.check,n.review??null,n.generation??null,ownership(n),n.inputs??null]];
	}));
	const grant=digest(["foundry-verification-use/v1",run.id,use,run.owner,e.issuer,target,run.policy.contractTarget??run.policy.base,sources,product?.check===e.id?product.outputs:null,
		e.pair??null,e.observer??null,e.rerun??null,e.calibration??null,e.remedy??null,e.replacement??null,e.rollout??null,
		e.delivery??null,e.isolation??null,e.recheck??null,e.testPin??null]);
	const pins=new Set(steps.flatMap(s=>inputCommits(s.inputs)));
	for(const pin of pins)retain(cwd,pin);
	const privateInput=delta && retain(cwd,git(cwd,["hash-object","-w","--stdin"],delta.bytes).toString().trim());
	return {version:1,use,grant,target,contract:run.policy.contractTarget??run.policy.base,evaluation,steps,
		...(privateInput && {privateInput}),...(migration && {joined:true}),...(migration && migration.resolutions && {resolutions:digest(migration.resolutions)})};
}

/** @param {string} cwd @param {Run} run @param {number} first */
export function describeNewChecks(cwd,run,first){
	for(const e of run.effects.slice(first))if(e.tool==="bash"){
		if(e.attempt?.version!==2)
			fail("unsupported_store","A new verification contract requires the fenced second-generation reservation");
		if(e.verification)fail("invalid_inputs","A newly reserved check cannot supply its own input description");
		e.verification=describeCheck(cwd,run,e);
		if(!described(e))fail("invalid_inputs","The proposed input description does not match its obligation");
	}
}
