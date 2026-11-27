import { awaitingReply, unissued } from "./dispatch.mjs";
import { changes, verifyJoinedInputs } from "./assembly.mjs";
import { working } from "./assignment.mjs";
import { proposedFootprint } from "./diagnostics.mjs";
import { checkReceipt, goalReceipt } from "./evidence.mjs";
import { checkpointCurrent } from "./facts.mjs";
import { footprints, nonempty } from "./footprint.mjs";
import { isolationBasis, isolationSeal } from "./isolation.mjs";
import { admitted, current, reserveCheck } from "./native.mjs";
import { currentPair } from "./pairing.mjs";
import { displacements, historicalGrant, validRestoration } from "./partition.mjs";
import { writerInputs } from "./lineage.mjs";
import { waiting } from "./plan.mjs";
import { changedFiles, commitAt, outside, retain, stageCheckpoint, verifyContracts } from "./product.mjs";
import { publishedComponent } from "./publication.mjs";
import { comparison } from "./charter.mjs";
import { questions } from "./reviews.mjs";
import { grant } from "./transfer.mjs";
import { digest, fail, fields, name, ownership, pinnedSelection, record, roots } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Call */
/** @param {Run} run @param {import("./model.js").Product} prior @param {string} id */
function inheritedGrant(run,prior,id) {
	if (prior.ownership?.[id]) return prior.ownership[id];
	const history=run.effects.slice(0,run.effects.findIndex(e=>e.id===prior.check));
	const component=history.findLast(e=>e.kind==="component" && e.grain===id && e.commit===prior.outputs[id] && checkReceipt(e)?.exit===0);
	const w=component && history.slice(0,history.indexOf(component)).findLast(e=>e.kind==="writer" && e.grain===id && e.nativeId===component.issuer);
	if (w?.kind==="writer" && w.finished?.component===component?.id && w.finished) return ownership(w.finished.directory);
	const n=run.nodes[id];
	if (component && n?.check===component.id && n.candidate===component.commit && n.state==="qualified" && !n.retained) return grant(n);
	fail("incomplete_evidence",`Cannot recover the exact checked ownership of ${id}`);
}

/** @param {Run} r @param {import("./model.js").Node} n */
function frozenReads(r,n) {
	const review=r.effects.find(e=>e.id===n.review), scout=review?.kind==="scout"?review:undefined;
	const artifacts=(r.artifacts??[]).slice(0,n.artifactCursor??0).filter(a=>roots(n.grain.directory).some(d=>!outside(d,a.to)));
	return [...n.supporting??[],...scout?.observation?.evidence??[],scout?.correction?.file,scout && comparison(r,scout)?.source?.file,
		...artifacts.map(a=>a.file),n.grain.check,n.grain.specification,...n.grain.boundary].filter(/** @returns {p is string} */ p=>!!p);
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} a @param {(e:Call)=>void} verify */
export function prepareCheckpoint(cwd,run,actor,a,verify) {
	fields(a,["run","observer","checkpoint","goal","target","selected","evidence","requestEvidence"]);
	const request=a.requestEvidence===true;
	if(a.requestEvidence!==undefined && (!request || a.evidence!==undefined))fail("invalid_selector","Request writer evidence or present a complete proof, not both");
	const observer=name(a.observer,"failed observer check"), checkpoint=name(a.checkpoint,"current checkpoint"), goal=name(a.goal,"current goal"), target=name(a.target,"target commit");
	const selected=nonempty(a.selected,"independent output triples").map(raw=>{
		const n=record(raw);fields(n,["grain","candidate","component"]);
		return {grain:name(n.grain,"output"),candidate:name(n.candidate,"candidate commit"),component:name(n.component,"component check")};
	});
	/** @param {Run} r */
	function select(r) {
		if (actor!==r.owner) fail("foreign_run","Only the owner can request an independent checkpoint");
		admitted(r);
		const p=r.products.at(-1), obs=r.effects.find(e=>e.id===observer);
		const pair=obs?.kind==="component" && obs.observer ? r.effects.find(e=>e.id===obs.observer?.pair) : undefined;
		const n=obs?.grain && r.nodes[obs.grain];
		if (r.independent || !p || !n || !obs?.commit || obs.kind!=="component" || obs.observer?.previous || !pair?.grain || pair.kind!=="component" || !pair.pair || !n.restoration ||
			pair.grain!==obs.grain || n.check!==observer || n.candidate!==obs.commit || checkReceipt(obs)?.exit!==1 ||
			n.state!=="blocked" || !validRestoration(r,n) || !currentPair(cwd,r,pair) || !checkpointCurrent(r,checkpoint,target) ||
			r.goal?.check!==goal || ![1,2].includes(goalReceipt(r)?.exit??-1) || commitAt(cwd,r.policy.target)!==target)
			fail("stale_assignment","Need the unchanged target, checked checkpoint, unmet goal and original blocked negative observer");
		const held=[...displacements(r)], retainer=r.nodes[pair.pair.retainer];
		if (held.length!==1 || held[0].id!==n.restoration.from || held[0].replacements.length!==1 || held[0].replacements[0]!==retainer ||
			Object.values(r.nodes).some(n=>n.state==="waiting" || working(n)) || r.pendingReviewNotes?.length ||
			questions(r).some(q=>q.decision?.status!=="answered") || r.effects.some(e=>e.permissionHold || awaitingReply(e) ||
				unissued(e) && current(r,e) || e.state==="reported" || e.state==="deferred"))
			fail("dispatch_held","Independent integration requires one exact unresolved hold and no outstanding checks, reviews, writers or permissions");
		const historic=historicalGrant(r,n.restoration.from,n.restoration.historical);
		if (!historic) fail("incomplete_evidence","Missing original checked mixed grant");
		const heldRoots=[...roots(held[0].scope),...roots(retainer.grain.directory)], heldIds=[held[0].id,pair.grain,pair.pair.retainer];
		const outputs={...p.outputs}, ownership=Object.fromEntries(Object.keys(p.outputs).map(id=>[id,inheritedGrant(r,p,id)]));
		/** @type {Map<string,{commit:string,check:string,selected:boolean,scope:import("./model.js").Scope}>} */
		const roles=new Map();
		/** @param {string} id @param {boolean} pick @param {number} exit */
		function component(id,pick,exit) {
			const e=r.effects.find(e=>e.id===id);
			if (e?.kind!=="component" || !e.commit || !e.check || !e.grain || !r.nodes[e.grain] || !e.runnerClaim || checkReceipt(e)?.exit!==exit)
				fail("missing_receipt",`Missing exact signed component ${id}`);
			verify(e);roles.set(id,{commit:e.commit,check:e.check,selected:pick,scope:r.nodes[e.grain].grain.directory});
		}
		for (const id of new Set([checkpoint,goal,historic.product.check,historic.component.id])) {
			const e=r.effects.find(e=>e.id===id);
			if (e?.tool!=="bash" || !e.runnerClaim) fail("missing_receipt",`Missing original signed ${id}`);
			verify(e);
		}
		component(pair.pair.failed,false,1);component(pair.id,false,1);component(observer,false,1);component(pair.pair.component,false,0);
		const wrote=new Set();
		for (const {grain,candidate,component:id} of selected) {
			const v=r.nodes[grain];
			if (!v || wrote.has(grain) || heldIds.includes(grain) || !outside(v.grain.directory,heldRoots) || v.state!=="published" ||
				v.candidate!==candidate || v.check!==id || !publishedComponent(r,id,grain,candidate) || !v.generation || v.restoration || v.retained || v.successor ||
				r.effects.some(e=>e.id===id && e.kind==="component" && (e.usedArtifacts?.length || e.comparedArtifacts?.length)))
				fail("dependent_output",`Need an exact independently published component and disjoint grant for ${grain}`);
			if (Object.hasOwn(outputs,grain) && digest(ownership[grain])!==digest(grant(v))) fail("dependent_output","Cannot change an inherited grant");
			if (Object.entries(ownership).some(([id,s])=>id!==grain && !outside(v.grain.directory,[...s.directories,...s.files])))
				fail("dependent_output","A different checkpoint output already owns part of this grant");
			component(id,true,0);wrote.add(grain);outputs[grain]=candidate;ownership[grain]=grant(v);
			if (changedFiles(cwd,v.generation,candidate).some(f=>outside(v.grain.directory,[f])))
				fail("dependent_output",`Out-of-grant candidate delta for ${grain}`);
		}
		const commit=stageCheckpoint(cwd,p.commit,changes(r,Object.fromEntries(selected.map(s=>[s.grain,s.candidate]))));
		verifyContracts(cwd,r.policy,commit);
		const delta=changedFiles(cwd,p.commit,commit);
		for (const {grain,candidate} of selected) {
			const v=r.nodes[grain], dirs=roots(v.grain.directory);
			const pins=writerInputs(r.nodes,waiting(v.grain));
			if (!pins || digest(pins)!==digest(v.inputs) || Object.entries(pins).some(([id,pin])=>heldIds.includes(id) || outputs[id]!==pin) ||
				!outside(heldRoots,frozenReads(r,v)) || !delta.some(f=>!outside(dirs,[f])) || changedFiles(cwd,candidate,commit,dirs).length)
				fail("dependent_output",`Changed or dependent inputs for ${grain}`);
		}
		for (const v of [n,retainer]) {
			const pins=writerInputs(r.nodes,waiting(v.grain));
			if (!pins || digest(pins)!==digest(v.inputs) || Object.entries(pins).some(([id,pin])=>wrote.has(id) || p.outputs[id]!==pin) ||
				!outside(delta,frozenReads(r,v))) fail("dependent_output","A held observation consumes a selected change");
		}
		const launchReads=historic.review.observation?.evidence??[], source=comparison(r,historic.review)?.source?.file;
		if (!outside(delta,[...launchReads,...source?[source]:[],...historic.review.correction?[historic.review.correction.file]:[]]))
			fail("dependent_output","The historical grant cites a changed input");
		if (!outside(heldRoots,delta) || delta.some(f=>selected.filter(({grain})=>!outside(r.nodes[grain].grain.directory,[f])).length!==1))
			fail("dependent_output","The assembly changes files outside the selected grants");
		verifyJoinedInputs(cwd,r,Object.fromEntries(Object.entries(outputs).filter(([id])=>r.nodes[id] && (wrote.has(id) || r.nodes[id].state==="qualified"))),p.commit,commit);
		const checks=[...roles.keys()];
		const evidence=request?[]:footprints(cwd,a.evidence??checks.map(id=>proposedFootprint(r,id)),roles,p.commit,commit,heldRoots,delta);
		const hold={historical:historic.product.check,grain:pair.grain,original:pair.pair.failed,pair:pair.id,
			retainer:pair.pair.retainer,candidate:pair.pair.candidate,component:pair.pair.component};
		return {observer,checkpoint,goal,target,hold,selected,evidence,checks,assembly:commit,basis:isolationBasis(r,"",selected),ownership,outputs,delta};
	}
	const {subject:choice,revalidate}=pinnedSelection(run,select,request?"The selected subset or its original inputs changed":"Independent checkpoint approval changed");
	if(request){
		const body={observer,checkpoint,goal,target,selected,checks:choice.checks},id=digest(body);
		return {consent:/** @type {const} */("satisfied"),prompt:"Request scoped read-only evidence from the original component writers. No checkpoint is authorized.",
			/** @param {Run} r */
			apply(r){
				for(const check of revalidate(r).checks){
					const c=r.effects.find(e=>e.id===check),n=c?.grain && r.nodes[c.grain];
					if(!n || !n.worker || !n.token)fail("missing_writer",`No bound writer can supply footprint ${check}. Do not invent its inputs.`);
				}
				if(!r.footprintRequests?.some(q=>q.id===id))(r.footprintRequests??=[]).push({id,...body});
				return ()=>commitAt(cwd,r.policy.target)===target;
			}};
	}
	return {prompt:`Independent NON-RELEASE checkpoint from ${checkpoint} on target ${target}, goal ${goal}; failed observer ${observer} and its entire ownership hold remain. `+
		`Approve only if these exact sources cover every build, generated, packaged and runtime input in both directions, including optional reads and all glob matches. Decline any gap. `+
		`Check exactly ${choice.assembly} with this delta and these component pins; a fresh passing goal cannot qualify it:\n${JSON.stringify({hold:choice.hold,delta:choice.delta,selected,evidence:choice.evidence})}`,
		/** @param {Run} r */
		apply(r) {
			const {ownership,outputs,delta,checks,...approval}=revalidate(r);
			retain(cwd,choice.assembly);
			const product=reserveCheck(r,actor,cwd,choice.assembly,r.policy.productCheck,{kind:"product"});
			const s=r.independent={...approval,ownership,product:product.id};
			product.isolation=isolationSeal(s);
			r.join={check:product.id,commit:choice.assembly,target,ownership,outputs};
			return ()=>commitAt(cwd,r.policy.target)===target;
		}};
}
