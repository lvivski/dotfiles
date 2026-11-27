import { awaitingReply, unissued } from "./dispatch.mjs";
import { verifyJoinedInputs } from "./assembly.mjs";
import { isUtf8 } from "node:buffer";
import { correctionRefs, matchesDraft } from "./drafts.mjs";
import { working } from "./assignment.mjs";
import { adoptedStop, correctionEvaluator } from "./evidence.mjs";
import { admitted, current } from "./native.mjs";
import { changedBlobs, changedFiles, commitAt, contractPaths, git, outside, stagePatch, verifyContracts } from "./product.mjs";
import { patchSource, replaceable, replacementChecks, replacementStop } from "./replacement.mjs";
import { covers, digest, fail, fields, FoundryError, name } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {NonNullable<import("./model.js").Adoption["patch"]>} Patch */
/** @typedef {(e:import("./model.js").NativeCall)=>void} Verify */
/** Reopen a named patch after a dismissal or choose between competing proposals.
 * Identical preflight and native confirmation as the automatic presentation.
 * @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} a @param {Verify} verify @param {boolean} owned */
export function preparePatch(cwd,run,actor,a,verify,owned){
	fields(a,["run","check","blob"]);
	const answer=name(a.blob,"offered patch"), plan=patchPlan(cwd,run,actor,commitAt(cwd,run.policy.target),verify,name(a.check,"failed verification"),answer);
	if(!!plan.offer.patch.owner!==owned)fail("patch_scope",`Select the ${owned?"inherited":"owned"} correction for these exact paths`);
	return {prompt:plan.prompt,target:plan.offer,answer};
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {string} target @param {Verify} verify
 * @param {string} failed @param {string} [selected] */
export function patchPlan(cwd,run,actor,target,verify,failed,selected){
	if(actor!==run.owner)fail("foreign_run","Only the owner can approve a correction on the adopted assembly");
	admitted(run);
	const stopped=adoptedStop(run,target,failed);
	if(!stopped || commitAt(cwd,run.policy.target)!==target)
		fail("stale_pin","Need the current adopted target and its exact signed exit-1 component on the failed assembly");
	const {pin,join,last,grain,evaluator,originalCheck}=stopped;
	if(correctionEvaluator(pin,originalCheck)!==evaluator)
		fail("not_recoverable","The owned correction after the rollout join has already been checked. Preserve this signed failure; another correction is not authorized.");
	if(run.independent || run.blocker || run.conflict || run.effects.some(x=>x.permissionHold || awaitingReply(x) || unissued(x) && current(run,x)))
		fail("dispatch_held","Resolve the outstanding work or permission hold before correcting the adopted assembly");
	const attempts=replacementChecks(run,failed),active=attempts.at(-1);
	const rolled=pin.amendments?.some(s=>s.harness && s.recheck===originalCheck)===true;
	if(rolled && active)fail("dispatch_held",`This rollout join already has its exact output correction: ${active.id}`);
	if(run.adoptions?.some(a=>a.failed===failed && a.rollout && a.decision?.status==="answered"))
		fail("dispatch_held","This failure already has an approved harness rollout; inspect its fresh component evidence");
	if(active && !replacementStop(run,active))fail("dispatch_held",`The approved output correction is waiting for its own component or review: ${active.id}`);
	const refs=correctionRefs(run).filter(a=>a.base===target && (!selected || a.blob===selected) && !a.evaluation &&
		(!a.draft || a.draft.previousCheck===active?.id) && matchesDraft(a,failed,join.commit));
	const n=run.nodes[grain],fixedAuthor=n.grain.task===undefined && !rolled,{source,squad,areas,witnesses}=patchSource(run,n,rolled || fixedAuthor && refs.some(a=>a.draft));
	for(const id of new Set([failed,last.check,pin.goal,...witnesses])){
		const c=run.effects.find(x=>x.id===id);
		if(c?.tool!=="bash")fail("missing_receipt","Missing original signed adoption evidence");
		verify(c);
	}
	if(rolled)verifyContracts(cwd,{...run.policy,contractTarget:evaluator},join.commit);
	const protectedFiles=[...contractPaths(run.policy),...(pin.resolutions??[]).map(r=>r.file)];
	const held=Object.values(run.nodes).filter(n=>Object.hasOwn(join.outputs,n.grain.id) || working(n) || n.state==="waiting" || n.retained || n.restoration);
	const original=pin.amendments?.[0]?.prior.commit??join.commit;
	/** @type {Map<string,{assembly:string,patch:Patch}>} */ const available=new Map();
	/** @type {string[]} */ const rejected=[];
	for(const a of refs){
		if(!a.to.some(dir=>covers(areas,dir)) || fixedAuthor && !a.draft)continue;
		try{
			const bytes=git(cwd,["cat-file","blob",a.blob]);
			if(!selected && !/^(?:diff --git |--- )/.test(bytes.subarray(0,11).toString()) && !/\.(?:diff|patch)$/i.test(a.file))continue;
			if(!isUtf8(bytes) || bytes.includes(0))fail("invalid_patch","Expected a UTF-8 unified diff");
			const assembly=stagePatch(cwd,join.commit,target,bytes.toString()), files=changedBlobs(cwd,join.commit,assembly);
			if(!matchesDraft(a,failed,join.commit,files))fail("patch_scope","Changed bytes do not match the bound authors' submissions");
			const paths=files.map(r=>r.file);
			const owned=paths.every(file=>covers(n.grain.directory,file));
			if(rolled && !owned)fail("patch_scope","Only the failed output's exact owned correction is eligible after a rollout join");
			for(const file of paths){
				if(!covers(a.to,file) || !covers(areas,file) || !outside(file,protectedFiles) || held.some(other=>(!owned || other!==n) && !outside(other.grain.directory,[file])))
					fail("patch_scope",`Not an offered, unowned file or part of one exclusive failed-output grant: ${file}. Do not mix owners, inherited files or protected paths.`);
			}
			if(!owned && changedFiles(cwd,last.commit,original,paths).length || changedFiles(cwd,last.target,target,paths).length)
				fail("patch_scope","Cannot overwrite an adopted target change or claim inherited files that changed since the checkpoint");
			if(pin.amendments?.some(s=>s.prior.commit===assembly))fail("unchanged_candidate","The correction reproduces an already failed assembly");
			const seen=attempts.find(c=>c.commit===assembly);
			if(seen)fail("unchanged_candidate",`Already observed this correction. ${replacementStop(run,seen)??seen.id}`);
			/** @type {Patch["owner"]} */ let owner;
			if(owned){
				const c=replaceable(cwd,run,join,n,paths);verify(c);
				if(run.effects.findIndex(e=>e.id===source)>=run.effects.indexOf(c))fail("missing_grant","The source grant does not precede the checked owner");
				owner={source,squad:squad.id,directory:n.grain.directory,component:c.id,output:join.outputs[grain],binding:digest(n)};
			}
			verifyJoinedInputs(cwd,run,join.outputs,null,assembly);
			for(const oid of new Set(files.flatMap(r=>[r.before,r.result]))){
				const b=git(cwd,["cat-file","blob",oid]);
				if(!isUtf8(b) || b.includes(0))fail("invalid_patch","Only reviewable UTF-8 file changes are eligible");
			}
			available.set(a.blob,{assembly,patch:{blob:a.blob,grain,files,...(a.draft && {draft:a.draft.id}),...(owner && {owner})}});
		}catch(error){
			if(!(error instanceof FoundryError))throw error;
			rejected.push(`${a.blob}: ${error.message}`);
		}
	}
	if(available.size!==1)fail(available.size?"ambiguous_patches":"patch_selection",available.size ?
		`Multiple owner patches apply at ${failed}. Select the intended foundry_grant correction: ${[...available].map(([blob,v])=>`${v.patch.owner?"owned":"inherited"} ${blob}`).join(", ")}` :
		`Component ${grain} exited 1 at ${failed}; that does not identify a faulty path or grant a writer access. A bounded author can draft on this assembly; select other exact files with foundry_grant draft, or import an external diff on ${target}.`+
		(rejected.length?`\n${rejected.join("\n")}`:""));
	const [{assembly,patch}]=available.values();
	const owner=patch.owner;
	const prompt=`Run ${run.id}: apply this exact ${owner?"owned-output":"inherited-file"} correction on the already approved target ${target}?\n`+
		`Component ${grain} exited 1 on ${join.commit} (check ${failed}); the product evaluator did not run. No other failure is inferred.\n`+
		(rolled?`Keep the approved rollout harness ${evaluator}.\n`:"")+
		`${patch.draft?`Bound author proposal ${patch.draft}`:"Owner reference"} ${patch.blob}; checkpoint ${last.check}, prior goal ${pin.goal}. `+
		(owner?`Replace only ${grain}@${owner.output}, checked by ${owner.component}, in ${JSON.stringify(owner.directory)}. `+
			`Recorded ${owner.squad} grant source: ${owner.source}. This is fresh authority for this exact diff, not permission for the old writer. `+
			`The changed output must first pass its own component${run.inspections?" and a new independent review of these files":""}.\n`:"")+
		`Review every changed file, including callers not yet exercised:\n`+
		`${JSON.stringify(patch.files)}\n${git(cwd,["diff","--no-ext-diff","--no-textconv","--no-renames","--text",join.commit,assembly]).toString()}\n`+
		`Accept only these bytes on ${assembly}. Keep the branch, ${owner?"all other output pins":"included outputs"}, charter, resolutions and evaluator pins. Check every included component, the product and the goal afresh. No writer grant or passing result is implied.`;
	return {offer:{revision:target,checkpoint:last.check,goal:pin.goal,failed,patch,assembly,message:prompt},prompt};
}
