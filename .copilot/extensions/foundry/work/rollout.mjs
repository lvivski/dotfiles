import { awaitingReply, unissued } from "./dispatch.mjs";
import { isUtf8 } from "node:buffer";
import { working } from "./assignment.mjs";
import { corroborated, currentRollout, rolloutChain, selection, stoppedBatch, within } from "./campaign.mjs";
import { changesFixedContract } from "./contract.mjs";
import { correctionRefs, matchesDraft } from "./drafts.mjs";
import { adoptedStop, changeOffer, checkReceipt } from "./evidence.mjs";
import { admitted, current } from "./native.mjs";
import { checked, dependencies } from "./lineage.mjs";
import { publishedComponent } from "./publication.mjs";
import { changedFiles, commitAt, git, outside, rolloutFiles, stageHarness, stagePatch, treeOf, verifyContracts } from "./product.mjs";
import { grant } from "./transfer.mjs";
import { digest, fail, fields, name } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").HarnessRollout} Rollout */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {(e:Check)=>void} Verify */
/** @param {string} cwd @param {string} from @param {string} to @param {string[]} [paths] */
const diff=(cwd,from,to,paths=[])=>git(cwd,["diff","--no-ext-diff","--no-textconv","--no-renames","--full-index",from,to,"--",...paths]).toString();
/** Paths admitted by relative() contain no control bytes or backslashes. Git C-quotes
 * double quotes and, with core.quotePath enabled, non-ASCII UTF-8 bytes.
 * @param {string} path @param {boolean} ascii */
function gitPath(path,ascii){
	const escaped=path.replaceAll('"','\\"').replace(/[^\x00-\x7f]+/g,s=>ascii?[...Buffer.from(s)].map(b=>"\\"+b.toString(8)).join(""):s);
	return path===escaped?path:`"${escaped}"`;
}
/** @param {string} line @param {string} prefix @param {string} file */
const pathHeader=(line,prefix,file)=>line===prefix+file || file.includes(" ") && line===prefix+file+"\t";

/** Git can apply a hunk when the surrounding file has drifted. Require one exact
 * full-index section per effective path so the invitation cannot describe different blobs.
 * @param {string} patch @param {Rollout["files"]} files */
function exactHeaders(patch,files){
	/** @type {Map<string,{f:Rollout["files"][number],a:string,b:string}>} */ const expected=new Map();
	for(const f of files)for(const ascii of [true,false]){
		const a=gitPath("a/"+f.file,ascii),b=gitPath("b/"+f.file,ascii);
		expected.set(`${a} ${b}`,{f,a,b});
	}
	const seen=new Set();
	const [prefix,...sections]=patch.split(/^diff --git /m);
	if(prefix || sections.length!==files.length)fail("invalid_patch","Expected a full-index Git diff, one section per changed path");
	for(const section of sections){
		const [header,...lines]=section.split("\n"),paths=expected.get(header),f=paths?.f,oid=f && (f.result??f.before);
		if(!paths || !f || seen.has(f.file) || (f.before===null && lines.shift()!==`new file mode ${f.mode}`) ||
			(f.result===null && lines.shift()!==`deleted file mode ${f.mode}`) || !oid ||
			lines[0]!==`index ${f.before??"0".repeat(oid.length)}..${f.result??"0".repeat(oid.length)}${f.before && f.result?" "+f.mode:""}` ||
			!pathHeader(lines[1],"--- ",f.before===null?"/dev/null":paths.a) || !pathHeader(lines[2],"+++ ",f.result===null?"/dev/null":paths.b))
			fail("invalid_patch","Patch headers must match the exact source and result blobs, paths and modes");
		seen.add(f.file);
	}
}

/** @param {string} cwd @param {string} from @param {string} parent @param {string} blob */
export function exactPatch(cwd,from,parent,blob){
	const bytes=git(cwd,["cat-file","blob",blob]);
	if(!isUtf8(bytes) || bytes.includes(0) || !bytes.subarray(0,11).equals(Buffer.from("diff --git ")))fail("invalid_patch","Expected a UTF-8 full-index diff");
	const assembly=stagePatch(cwd,from,parent,bytes.toString()),files=rolloutFiles(cwd,from,assembly);
	exactHeaders(bytes.toString(),files);
	return {assembly,files,patch:bytes.toString()};
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} a @param {Verify} verify */
export function prepareRollout(cwd,run,actor,a,verify){
	fields(a,["run","assembly","check","blob"]);
	const plan=rolloutPlan(cwd,run,actor,name(a.assembly,"source assembly"),name(a.check,"failed check"),name(a.blob,"offered blob"),verify);
	return {target:plan.offer,prompt:plan.prompt,answer:plan.offer.rollout.blob};
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {string} from @param {string} failed @param {string} blob @param {Verify} verify */
export function rolloutPlan(cwd,run,actor,from,failed,blob,verify){
	if(actor!==run.owner)fail("foreign_run","Only the run owner can propose a harness rollout");
	admitted(run);
	const target=commitAt(cwd,run.policy.target),stop=run.effects.find(c=>c.id===failed);
	const ref=correctionRefs(run).find(ref=>ref.base===target && ref.blob===blob && !ref.evaluation && (!ref.assembly || ref.assembly===from) && matchesDraft(ref,failed,from));
	const parent=stop?.kind==="component" && stop.rollout?changeOffer(run,stop):undefined;
	const witness=stop && checkReceipt(stop)?.exit;
	const cut=parent && stoppedBatch(run,parent,failed,false,ref?.assembly===from);
	if(parent && (!cut || !run.join || !parent.rollout || parent.assembly!==from || !cut.every(c=>currentRollout(run,c)) ||
		digest(rolloutFiles(cwd,run.join.commit,from))!==digest(parent.rollout.files)))
		fail("stale_pin","Need the signed current standalone stop on the exact approved rollout; later checks must be unissued");
	const joined=parent?.failed??failed,basis=adoptedStop(run,target,joined);
	if(!basis || basis.evaluator!==target || !parent && basis.join.commit!==from ||
		basis.pin.amendments?.some(s=>s.harness && s.recheck===basis.originalCheck))
		fail("stale_pin","Need the exact current failed adopted assembly, signed component failure, and unchanged evaluator pins");
	const {pin:p,join:j,grain}=basis;
	const chain=rolloutChain(run,joined);
	if(!chain || chain.at(-1)!==parent || run.independent || run.blocker || run.conflict || run.effects.some(x=>x.permissionHold || awaitingReply(x) ||
		unissued(x) && current(run,x) && !(cut && x.kind==="component" && cut.includes(x))) ||
		run.inspections?.some(i=>i.permissionHold || ["issued","ready"].includes(i.state)) ||
		run.adoptions?.some(o=>o.failed===joined && o.decision?.status==="answered" && o.patch?.owner))
		fail("dispatch_held","An approved correction, check, review or permission hold is outstanding");
	if(!ref)
		fail("missing_artifact","Name the exact patch offered by the owner at the adopted target");
	for(const id of new Set([joined,p.checkpoint,p.goal,...(cut?.filter(c=>c.state==="done").map(c=>c.id)??[]),...(parent?.foreground?[parent.foreground.check]:[])])){
		const e=run.effects.find(c=>c.id===id);
		if(e?.tool!=="bash")fail("missing_receipt","Original signed adoption evidence is missing");
		verify(e);
	}
	verifyContracts(cwd,parent?.rollout?{...run.policy,contractTarget:parent.rollout.harness}:run.policy,from);
	const {assembly,files:delta}=exactPatch(cwd,from,target,blob);
	if(!matchesDraft(ref,failed,from,delta))fail("patch_scope","The rollout does not match all its bounded author submissions");
	if(treeOf(cwd,assembly)===treeOf(cwd,j.commit) || chain.some(o=>o.assembly===assembly))fail("unchanged_candidate","This exact assembly was already attempted on the failed join");
	/** @type {Rollout["followup"]} */ const followup=parent && {proposal:parent.id,assembly:from,check:failed,files:delta,observation:
		witness===0 || witness===1 || witness===2?witness:fail("missing_receipt","The superseded check must have a signed observation")};
	const files=followup?rolloutFiles(cwd,j.commit,assembly):delta;
	const protectedFiles=[run.policy.source,...(run.policy.sharedBrief?[run.policy.sharedBrief]:[]),...run.policy.squads.flatMap(s=>[s.charter,...("boundary" in s?s.boundary:[])]),...(p.resolutions??[]).map(r=>r.file)];
	const harnessChanged=files.some(f=>f.file.startsWith(".foundry/"));
	if(changesFixedContract(run,delta) || delta.some(f=>!outside(f.file,protectedFiles) || f.result===null && run.policy.files.includes(f.file)) || !parent && !harnessChanged &&
		!(ref.draft && (ref.draft.parts.length>1 || delta.some(f=>!f.before || !f.result) || ref.draft.parts.some(p=>p.source.grain && p.source.grain!==grain) ||
			Object.keys(j.outputs).some(id=>Object.hasOwn(run.nodes[id].inputs??{},grain)))))
		fail("patch_scope","A rollout must change the harness, not the activation plan, specification, boundary, charter, journey contract or an approved conflict resolution");
	const untouched=!harnessChanged && (parent?parent.rollout?.harness===target:!!ref.draft);
	const harness=untouched?target:stageHarness(cwd,target,diff(cwd,j.commit,assembly,[".foundry"]));
	verifyContracts(cwd,{...run.policy,contractTarget:harness},assembly);
	/** @type {Rollout["owners"]} */ const owners={};
	/** @type {Rollout["included"]} */ const included=Object.fromEntries(Object.keys(j.outputs).map(id=>[id,{scope:grant(run.nodes[id]),inputs:run.nodes[id].inputs??{}}]));
	const affected=parent?.rollout?[...parent.rollout.files,...delta]:files;
	const {owners:pending,paths}=selection(included,delta,Object.keys(parent?.rollout?.owners??{}))??fail("ownership_transition","A changed path has multiple included owners");
	if(!pending.size)fail("patch_scope","No included owner's output changes");
	for(const [id,n] of Object.entries(run.nodes)){
		const scope=grant(n);
		if(!Object.hasOwn(included,id)){
			if((working(n)||n.state==="waiting"||n.retained||n.restoration||n.state==="published") &&
				(affected.some(f=>within(scope,f.file)) || Object.keys(n.inputs??{}).some(dep=>pending.has(dep))))
				fail("patch_scope",`Cannot overwrite or invalidate the outstanding grant ${id}`);
			continue;
		}
		const c=run.effects.find(e=>e.id===n.check),output=j.outputs[id];
		if(c?.kind!=="component" || c.check!==n.grain.check || n.candidate!==output || !checked(n))
			fail("missing_receipt",`Missing exact included output evidence for ${id}`);
		const paths=[...scope.directories,...scope.files];
		const differs=(/** @type {string} */ commit)=>changedFiles(cwd,output,commit,paths).some(f=>within(scope,f));
		if(c.runnerClaim){
			if(!publishedComponent(run,c.id,id,output))fail("missing_receipt",`Missing passing, reviewed component for ${id}`);
			verify(c);
		}
		else{
			const checkpoint=run.products.at(-1);
			if(!checkpoint || !corroborated(run,j,p.checkpoint,id,c,scope) || differs(checkpoint.commit) || differs(j.commit))
				fail("missing_receipt",`No exact signed checkpoint and passing joined component for the pre-journal output ${id} (${c.id})`);
			included[id].legacy=c.id;
		}
		if(j.ownership && digest(j.ownership[id])!==digest(scope))fail("ownership_transition",`Frozen grant changed for ${id}`);
		const deps=dependencies(run.nodes,n.grain.needs);
		if(!n.inputs || deps.size!==Object.keys(n.inputs).length || [...deps].some(dep=>!j.outputs[dep] || j.outputs[dep]!==n.inputs?.[dep]))
			fail("stale_assignment",`Original dependency pins do not match the assembly for ${id}`);
		if(!pending.has(id))continue;
		const review=run.effects.find(e=>e.id===n.review);
		if(n.restoration || n.reuse || review?.kind==="scout" && review.correction ||
			c.runnerClaim && differs(j.commit))
			fail("patch_scope",`The old checked output or assignment cannot be rebound for ${id}`);
		owners[id]={output,component:c.id,binding:digest(n),scope,...(n.grain.task===undefined && {specification:n.grain.specification}),
			inputs:Object.fromEntries([...deps].map(dep=>[dep,pending.has(dep)?assembly:j.outputs[dep]]))};
	}
	if(parent?.rollout && digest(included)!==digest(parent.rollout.included))
		fail("stale_assignment","The included grants or original component inputs changed since the stopped rollout");
	const rollout={from:j.commit,blob,files,harness,included,owners,...(ref.draft && {draft:ref.draft.id}),...(followup && {followup})};
	const prompt=`Run ${run.id}: apply this exact harness rollout after signed component ${followup?`observation ${stop?.grain}, exit ${witness}`:`failure ${grain}`} (${failed})?\n`+
		(followup?`Supersede pending rollout ${followup.proposal}, based on joined failure ${joined} at ${j.commit}. Previously tested harness ${parent?.rollout?.harness}; new harness ${harness}. Preserve all observations, withdraw only unissued checks, and start a fresh component batch.\n`:"")+
		`Source assembly ${from}; result ${assembly}; ${ref.draft?`bound author sources ${JSON.stringify(ref.draft.parts.map(p=>({workflow:p.workflow,source:p.source,changes:p.changes})))}`:"owner patch"} ${blob}. Keep target and charter ${target}. Product and goal evaluator pins ${target} -> ${harness}.\n`+
		`Replacement output pins -> ${assembly} (including consumers); original components, grants and new input pins:\n${JSON.stringify(owners)}\n`+
		`Pre-journal components (historical IDs only), corroborated by signed checkpoint ${p.checkpoint} and passing grain entries on ${joined}: ${JSON.stringify(Object.entries(included).flatMap(([grain,n])=>n.legacy?[{grain,component:n.legacy,output:j.outputs[grain],scope:n.scope}]:[]))}\n`+
		`All ${delta.length} changed files (null before means create; null result means delete; null owner means outside the included grants):\n${JSON.stringify(delta.map(f=>({...f,owner:paths.get(f.file)})))}\n${diff(cwd,from,assembly)}\n`+
		`Require fresh component evidence and applicable independent review before replacing output pins. Check all ${Object.keys(included).length} included components, product and final goal afresh. No writer grant, branch change or release.`;
	return {offer:{revision:target,checkpoint:p.checkpoint,goal:p.goal,failed:joined,rollout,assembly,message:prompt},prompt};
}

