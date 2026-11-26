import { isUtf8 } from "node:buffer";
import { working } from "./assignment.mjs";
import { failedComponent, verification } from "./evidence.mjs";
import { verifyJoinedInputs } from "./graph.mjs";
import { admitted, current, reserveProduct } from "./native.mjs";
import { offerId, targetBasis } from "./offers.mjs";
import { owns } from "./plan.mjs";
import { changedBlobs, changedFiles, commitAt, contractPaths, git, outside, retain, stagePatch } from "./product.mjs";
import { awaitingReply, unissued } from "./reservation.mjs";
import { covers, digest, fail, fields, FoundryError, name } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {NonNullable<import("./model.js").Adoption["patch"]>} Patch */
/** @typedef {(e:import("./model.js").NativeCall)=>void} Verify */
/** Reopen a named patch after a dismissal or choose between competing proposals.
 * Identical preflight and native confirmation as the automatic presentation.
 * @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} a @param {Verify} verify */
export function prepareInherited(cwd,run,actor,a,verify){
	fields(a,["run","check","blob"]);
	const answer=name(a.blob,"offered patch"), plan=inheritedPlan(cwd,run,actor,commitAt(cwd,run.policy.target),verify,name(a.check,"failed verification"),answer);
	return {prompt:plan.prompt,target:plan.offer,answer,apply:(/** @type {Run} */ r)=>plan.apply(r,answer)};
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {string} target @param {Verify} verify
 * @param {string} failed @param {string} [selected] */
export function inheritedPlan(cwd,run,actor,target,verify,failed,selected){
	if(actor!==run.owner)fail("foreign_run","Only the owner can approve a correction to inherited files");
	admitted(run);
	const pin=run.productRepins?.at(-1),join=run.join,last=run.products.at(-1),e=run.effects.find(e=>e.id===failed);
	const grain=failedComponent(e);
	if(!pin?.targetFrom || !join || join.check!==failed || verification(pin)!==failed || !last || last.check!==pin.checkpoint ||
		run.goal?.check!==pin.goal || run.repins?.at(-1)?.revision!==target || run.policy.contractTarget!==target || pin.revision!==target ||
		join.target!==target || commitAt(cwd,run.policy.target)!==target || e?.kind!=="product" || e.commit!==join.commit || !grain || !Object.hasOwn(join.outputs,grain))
		fail("stale_pin","Need the current adopted target and its exact signed exit-1 component on the failed assembly");
	if(run.independent || run.blocker || run.conflict || run.effects.some(x=>x.permissionHold || awaitingReply(x) || unissued(x) && current(run,x)))
		fail("dispatch_held","Resolve the outstanding work or permission hold before correcting the adopted assembly");
	for(const id of [failed,last.check,pin.goal]){
		const c=run.effects.find(x=>x.id===id);
		if(c?.tool!=="bash")fail("missing_receipt","Missing original signed adoption evidence");
		verify(c);
	}
	const n=run.nodes[grain],review=run.effects.find(r=>r.id===n.review);
	const squad=review?.kind==="scout" && run.policy.squads.find(s=>s.id===review.squad);
	if(!squad || !("areas" in squad) || !owns(squad,n.grain.directory))fail("missing_grant",`No assigning charter area for the failed component ${grain}`);
	const protectedFiles=[...contractPaths(run.policy),...(pin.resolutions??[]).map(r=>r.file)];
	const held=Object.values(run.nodes).filter(n=>Object.hasOwn(join.outputs,n.grain.id) || working(n) || n.state==="waiting" || n.retained || n.restoration);
	const original=pin.amendments?.[0]?.prior.commit??join.commit;
	const refs=(run.artifacts??[]).filter(a=>a.publisher===actor && a.base===target && (!selected || a.blob===selected) &&
		a.to.some(dir=>owns(squad,dir)));
	/** @type {Map<string,{assembly:string,patch:Patch}>} */ const available=new Map();
	/** @type {string[]} */ const rejected=[];
	for(const a of refs){
		try{
			const bytes=git(cwd,["cat-file","blob",a.blob]);
			if(!selected && !/^(?:diff --git |--- )/.test(bytes.subarray(0,11).toString()) && !/\.(?:diff|patch)$/i.test(a.file))continue;
			if(!isUtf8(bytes) || bytes.includes(0))fail("invalid_patch","Expected a UTF-8 unified diff");
			const assembly=stagePatch(cwd,join.commit,target,bytes.toString()), files=changedBlobs(cwd,join.commit,assembly);
			const paths=files.map(r=>r.file);
			for(const file of paths){
				if(!covers(a.to,file) || !owns(squad,file) || !outside(file,protectedFiles) || held.some(n=>!outside(n.grain.directory,[file])))
					fail("patch_scope",`Not an offered, unowned file in the failed component's charter: ${file}`);
			}
			if(changedFiles(cwd,last.commit,original,paths).length || changedFiles(cwd,last.target,target,paths).length)
				fail("patch_scope","Cannot overwrite an adopted target change; name only files inherited from the prior checkpoint");
			if(pin.amendments?.some(s=>s.prior.commit===assembly))fail("unchanged_candidate","The correction reproduces an already failed assembly");
			verifyJoinedInputs(cwd,run,join.outputs,last.commit,assembly);
			for(const oid of new Set(files.flatMap(r=>[r.before,r.result]))){
				const b=git(cwd,["cat-file","blob",oid]);
				if(!isUtf8(b) || b.includes(0))fail("invalid_patch","Only reviewable UTF-8 file changes are eligible");
			}
			available.set(a.blob,{assembly,patch:{blob:a.blob,grain,files}});
		}catch(error){
			if(!(error instanceof FoundryError))throw error;
			rejected.push(`${a.blob}: ${error.message}`);
		}
	}
	if(available.size!==1)fail("patch_selection",available.size ?
		`Multiple owner patches apply at ${failed}. Select the intended blob with foundry_grant inherited: ${[...available.keys()].join(", ")}` :
		`Component ${grain} exited 1 at ${failed}; that does not identify a faulty path or grant a writer access. If the correction is in inherited files, offer a unified .patch or .diff to their directories on ${target}.`+
		(rejected.length?`\n${rejected.join("\n")}`:""));
	const [{assembly,patch}]=available.values();
	const prompt=`Run ${run.id}: apply this exact inherited-file correction on the already approved target ${target}?\n`+
		`Component ${grain} exited 1 on ${join.commit} (check ${failed}); the product evaluator did not run. No other failure is inferred.\n`+
		`Owner reference ${patch.blob}; checkpoint ${last.check}, prior goal ${pin.goal}. Review every changed file, including callers not yet exercised:\n`+
		`${JSON.stringify(patch.files)}\n${git(cwd,["diff","--no-ext-diff","--no-textconv","--no-renames","--text",join.commit,assembly]).toString()}\n`+
		`Accept only these bytes on ${assembly}. Keep the branch, included outputs, charter, resolutions and evaluator pins. Check every included component, the product and the goal afresh. No writer grant or passing result is implied.`;
	const offer={revision:target,checkpoint:last.check,goal:pin.goal,failed,patch,assembly,message:prompt};
	const stamp=targetBasis(cwd,run,target);
	return {offer,prompt,
		/** @param {Run} live @param {string} answer */
		apply(live,answer){
			admitted(live);
			const p=live.productRepins?.at(-1),prior=live.join;
			if(!p || !prior || prior.check!==failed || answer!==patch.blob || targetBasis(cwd,live,target)!==stamp || commitAt(cwd,live.policy.target)!==target)
				fail("stale_pin","The failed assembly, offer or target changed during correction approval");
			retain(cwd,assembly);
			reserveProduct(live,actor,cwd,target,assembly,{...prior.outputs});
			const fresh=live.join;
			if(!fresh || fresh.check===failed || digest(fresh.ownership??null)!==digest(prior.ownership??null))fail("ownership_transition","The included grants changed");
			(p.amendments??=[]).push({prior,proposal:offerId(offer),recheck:fresh.check});
			return ()=>commitAt(cwd,live.policy.target)===target;
		}};
}
