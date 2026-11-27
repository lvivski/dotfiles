import { isUtf8 } from "node:buffer";
import { evaluatorOverlay } from "./contract.mjs";
import { changedFiles, commitAt, contractConflict, contractPaths, entries, outside, regularFiles } from "./product.mjs";
import { digest, fail, relative } from "./values.mjs";
import { checkReceipt, currentEvaluation, failedComponent, mixedVerification, verificationSource } from "./evidence.mjs";
import { replacementBlob } from "./inputs.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").TestRepair} Repair */
/** @typedef {import("./model.js").TestRule} Rule */
/** @typedef {keyof Repair["controls"]} Role */
/** A project opts in for one existing evaluator by supplying its independent executable control.
 * Only that evaluator is editable. There is no manifest, path-pattern inference or general test-directory grant.
 * @param {string} cwd @param {Run} run @param {string} check */
export function controlRule(cwd,run,check){
	if(!check || !run.policy.files.includes(check))return;
	const probe=relative(check+".control"),[entry]=entries(cwd,run.policy.base,false,[probe]);
	if(!entry || entry.mode!=="100755")return;
	const required=[run.policy.source,...run.policy.squads.flatMap(s=>[s.charter,...("boundary" in s?s.boundary:[])]),
		...Object.values(run.nodes).flatMap(n=>[n.grain.specification,...n.grain.boundary])];
	if(!outside(check,required) || !outside(probe,run.policy.files))return;
	regularFiles(cwd,run.policy.base,[check]);return {driver:entry.oid,rule:{check,probe}};
}

/** The enclosing product did not run when a joined component failed. Only that named observer can be diagnosed.
 * @param {import("./model.js").NativeCall} c */
export function failedTest(c){
	if(!c.runnerClaim || c.lane || c.delivery || c.isolation || c.replacement || c.observer || c.pair || c.remedy)return;
	const grain=failedComponent(c)??failedComponent(c,2),r=checkReceipt(c);
	if(grain && r?.components)return {check:r.components[grain].check,grain,missing:r.components[grain].exit===2};
	if((r?.exit===1 || r?.exit===2) && c.check && ["goal","product","component"].includes(c.kind))return {check:c.check,missing:r.exit===2,...(c.grain && {grain:c.grain})};
}
/** @param {Run} run @param {import("./model.js").NativeCall} c */
export function stoppedTest(run,c){
	const subject=failedTest(c);
	if(!subject || replacementBlob(c.receipt) || subject.grain && replacementBlob(c.receipt?.components?.[subject.grain]))return false;
	if(c.kind==="goal")return run.goal?.check===c.id && currentEvaluation(run,c) && !run.join;
	if(c.kind==="product")return run.join?.check===c.id && !run.products.some(p=>p.withdrawnHandoff?.recheck===c.id) &&
		!run.adoptions?.some(a=>a.failed===c.id && a.assembly &&
			(a.decision?.status==="answered" || !a.rollout?.followup?.recipe && (a.id===run.targetProposal && !a.decision || a.decision?.status==="presenting")));
	if(c.kind!=="component" || !c.grain || c.observer || c.pair || c.remedy || c.delivery || c.replacement)return false;
	if(c.rollout){
		const a=run.adoptions?.findLast(a=>a.rollout && a.decision?.status==="answered");
		return a?.id===c.rollout && a.failed===run.join?.check && a.assembly===c.commit &&
			!run.adoptions?.some(b=>b.rollout?.followup?.check===c.id || b.foreground?.check===c.id) && !a.foreground;
	}
	const n=run.nodes[c.grain];
	return !!n && !n.restoration && !c.inlineRepair && n.check===c.id && n.candidate===c.commit && !n.stop &&
		(n.state==="checking" || n.state==="blocked" || subject.missing && n.state==="waiting");
}

/** @param {Run} run @param {Repair} job */
export const repairStop=(run,job)=>run.effects.find(/** @returns {c is import("./model.js").NativeCall} */ c=>c.tool==="bash" && c.id===job.stop);

/** An ordinary component observes an immutable candidate, not an unrelated commit on the target branch.
 * Joined and rollout grants still bind the exact target. Return the sampled tip for the write guard.
 * @param {string} cwd @param {Run} run @param {Repair} job */
export function repairTip(cwd,run,job){
	const tip=commitAt(cwd,run.policy.target),stop=repairStop(run,job);
	if(stop?.kind!=="component" || stop.rollout)return tip===job.target?tip:undefined;
	if(!contractConflict(cwd,run.policy,tip) && (tip===job.target ||
		!changedFiles(cwd,job.target,tip,[...contractPaths(run.policy),job.rule.probe]).length))return tip;
}
/** The observer is overlaid on a verified export of exactly this product, never on unrelated work.
 * @param {Run} run @param {import("./model.js").NativeCall} c @param {string} check @param {string} [grain] */
export function certifiedTest(run,c,check,grain=c.grain){
	const correction=priorTest(run,c,grain);
	return run.testRepairs?.findLast(j=>j.state==="applied" && j.rule.check===check && j.grain===grain &&
		(j.recheck===c.id && j.product===c.commit || correction && j.target===correction.target && j.blob===correction.blob ||
			c.kind==="product" && grain && !!j.recheck &&
			run.join?.check===c.id && run.join.target===j.target && run.nodes[grain]?.check===j.recheck && run.join.outputs[grain]===j.product));
}
/** Carry the test, never its verdict, into an explicitly approved correction to this very join.
 * @param {Run} run @param {import("./model.js").NativeCall} c @param {string|undefined} grain */
export function priorTest(run,c,grain){
	if(!grain || !run.testRepairs?.length)return;
	if(c.kind==="product" && c.testPin){
		const prior=run.effects.find(e=>e.id===c.testPin),job=run.testRepairs.find(j=>j.recheck===c.id);
		const blob=replacementBlob(checkReceipt(prior)?.components?.[grain]);
		if(job && blob)return {target:job.target,blob};
	}
	const source=c.kind==="product" && verificationSource(run,c.id);
	const proposal=c.replacement??c.rollout??(source?mixedVerification(run,source)?.amendments?.find(s=>s.recheck===source)?.proposal:undefined);
	const approval=proposal && run.adoptions?.find(a=>a.id===proposal && a.decision?.status==="answered");
	const failed=approval && run.effects.find(e=>e.id===approval.failed);
	const blob=failed && replacementBlob(checkReceipt(failed)?.components?.[grain]);
	if(approval && blob)return {target:approval.revision,blob};
}
/** @param {Run} run @param {Repair} job @param {Role} role */
export function controlOverlay(run,job,role){
	const c=repairStop(run,job);
	const prior=!job.grain && c?.evaluatorRevision && (c.kind==="goal" || c.kind==="product")?evaluatorOverlay(run,c.kind,c.evaluatorRevision):undefined;
	return {prior,test:role==="oldGood"?undefined:{file:job.rule.check,revision:job.revision??fail("unproven_repair","Missing proposed control revision"),blob:job.blob}};
}
/** @param {Repair} job @param {Role} role */
export const controlSubject=(job,role)=>digest([job.owner,job.stop,job.target,job.product,job.pin,job.before,job.driver,job.rule,job.grain??null,role,
	role==="oldGood"?null:[job.blob,job.revision,job.candidate]]);
/** @param {Run} run @param {import("./model.js").NativeCall} c */
export function currentControl(run,c){
	const k=c.calibration,j=run.testRepairs?.find(j=>j.stop===k?.stop);
	const stop=j && repairStop(run,j);
	const issued=!!c.callId && (c.state==="issued" || c.state==="uncertain");
	return !!k && !!j && (issued || run.active && !run.policyHold && !run.conflict) && j.owner===c.issuer && c.issuer===run.owner &&
		!!stop && stoppedTest(run,stop) &&
		j.controls[k.role]===c.id && c.check===j.rule.probe && k.subject===controlSubject(j,k.role) &&
		(k.role==="oldGood"?j.state==="diagnosing" && c.commit===j.product:j.state==="checking" && c.commit===j.candidate);
}

/** A process exit alone cannot identify which assertion ran. No stdout diagnostic from a product is a control.
 * @param {Buffer|null} stdout @param {number|null} exit */
export function controlObservation(stdout,exit){
	if(!stdout || !isUtf8(stdout) || !(exit===0 || exit===1))return;
	let v;try{v=JSON.parse(stdout.toString());}catch(error){if(error instanceof SyntaxError)return;throw error;}
	if(v && typeof v==="object" && Object.keys(v).length===2 && typeof v.assertion==="string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(v.assertion) && v.matched===(exit===0))
		return {assertion:v.assertion,matched:exit===0};
}
