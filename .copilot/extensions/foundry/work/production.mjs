import { randomUUID } from "node:crypto";
import { assign } from "./assignment.mjs";
import { availableReservations } from "./capacity.mjs";
import { admitted, current, reserveCheck, reserveWorker } from "./native.mjs";
import { verifyObserver } from "./observer.mjs";
import { changedFiles, commitAt, contractPaths, entries, outside, regularFiles } from "./product.mjs";
import { origin, passingRemedy, remedyChecks } from "./remedy.mjs";
import { awaitingReply, unissued } from "./reservation.mjs";
import { activeConsumer } from "./transfer.mjs";
import { digest, fail, fields, name, relative, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Call */

/** Validate against the original publications, excluding only the calls made by this repair.
 * The old pair attested the old bytes; it is an input, never the new verdict.
 * @param {string} cwd @param {Run} run @param {Call} job @param {string} [commit] */
export function productionBasis(cwd,run,job,commit) {
	const basis=origin(run,job), grant=job.production, producer=job.grain;
	if (!grant || !producer || !basis || run.independent) fail("invalid_production","Need the final signed diagnostic, its exact candidate, checkpoint, goal and one of the two owners");
	const {failed,primary,retainer,pair}=basis, n=run.nodes[producer];
	const installed=run.effects.some(e=>e.id===job.id);
	if (!n || installed && (n.token!==job.token || n.generation!==grant.candidate || !["writing","checking"].includes(n.state) ||
		digest(n.grain)!==digest(grant.prior.grain) || digest(n.inputs)!==digest(grant.prior.inputs)))
		fail("stale_assignment","The approved production binding changed");
	const view=installed ? {...run,nodes:{...run.nodes,[producer]:grant.prior},effects:run.effects.filter(e=>
		e.id!==job.id && !(e.kind==="component" && e.remedy?.writer===job.id))} : run;
	const receiver=view.nodes[primary], held=view.nodes[retainer];
	if (!receiver || receiver.state!=="blocked" || receiver.check!==failed.id || receiver.candidate!==grant.candidate ||
		held?.state!=="published" || held.check!==pair.component || held.candidate!==pair.candidate ||
		!receiver.restoration ||
		run.effects.some(e=>e.permissionHold))
		fail("stale_assignment","The original diagnostic, published retaining owner or permissions changed");
	if (view.effects.some(e=>(e.grain===primary || e.grain===retainer) && (awaitingReply(e) || unissued(e) && current(view,e))))
		fail("dispatch_held","Resolve the outstanding call for the affected pair before production work");
	const target=verifyObserver(cwd,view,failed,grant.candidate,true);
	const scope=grant.prior.grain.directory, files=grant.files;
	const review=view.effects.find(e=>e.id===grant.prior.review);
	if (typeof scope!=="string" || grant.prior.retained || grant.prior.successor || grant.prior.reuse || review?.kind==="scout" && review.correction ||
		!files.length || new Set(files).size!==files.length || files.some(f=>!f.startsWith(scope+"/") || f===failed.observer?.file ||
		!outside(f,contractPaths(run.policy))))
		fail("production_scope","Name exact production or regression files within the selected owner's intact directory; not the approved observer or contract");
	const originals=entries(cwd,grant.candidate,false,files);
	if (originals.some(f=>f.type!=="blob" || !["100644","100755"].includes(f.mode)))
		fail("production_scope","Only regular files or new files within the approved directory are eligible");
	const consumer=activeConsumer(view,producer,files,{except:producer});
	if (consumer || Object.values(view.nodes).some(v=>v.state==="qualified" && Object.hasOwn(v.inputs??{},producer)))
		fail("dispatch_held","Another assignment consumes this producer or its requested paths");
	if (commit) {
		const diff=changedFiles(cwd,grant.candidate,commit);
		if (!diff.length || diff.some(f=>!files.includes(f))) fail("production_scope","Submit changed bytes only in the approved production or regression files");
		for (const f of regularFiles(cwd,commit,diff)) if (f.mode!==(originals.find(x=>x.name===f.name)?.mode??"100644"))
			fail("production_scope","Do not change file modes in a production repair");
		if (view.effects.some(e=>e.kind==="component" && e.remedy && e.commit===commit))
			fail("unchanged_candidate","This production assembly was already observed; an old receipt cannot be retried");
	}
	return {target,primary,retainer,pair,failed};
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} a @param {(e:Call)=>void} verify */
export function prepareProduction(cwd,run,actor,a,verify) {
	fields(a,["run","diagnostic","candidate","checkpoint","goal","producer","files","task"]);
	const producer=name(a.producer,"production owner"), diagnostic=name(a.diagnostic,"final diagnostic"), candidate=name(a.candidate,"failed candidate"),
		checkpoint=name(a.checkpoint,"checkpoint"),goal=name(a.goal,"unmet goal"),task=text(a.task,"production regression and behavior");
	if (!Array.isArray(a.files)) fail("production_scope","Name the exact editable files, including the repository regression");
	const files=a.files.map(relative);
	/** @param {Run} r */
	function select(r) {
		if (r.owner!==actor) fail("foreign_run","Only the owner may request a production repair");
		admitted(r);
		const prior=r.nodes[producer];
		if (!prior || !["published","blocked"].includes(prior.state)) fail("invalid_production","Need the blocked primary or the published retaining owner");
		const grant={diagnostic,candidate,checkpoint,goal,files,task,prior:structuredClone(prior)};
		const basis=productionBasis(cwd,r,{id:"",kind:"writer",issuer:actor,state:"ready",tool:"create_session",args:{},grain:producer,production:grant});
		if (!availableReservations(r)) fail("limit","No assignment or worker slot remains");
		for (const id of new Set([diagnostic,basis.failed.observer?.previous?.check,basis.failed.observer?.pair,basis.pair.failed,basis.pair.component,checkpoint,goal])) {
			const e=r.effects.find(e=>e.id===id);
			if (e?.tool!=="bash" || !e.runnerClaim || !e.receipt) fail("missing_receipt","Missing signed production recovery input");
			verify(e);
		}
		return {grant,target:basis.target,retained:basis.pair.component};
	}
	const before=select(run);
	return {prompt:`Authorize a production writer for ${producer} on ${candidate} after diagnostic ${diagnostic}? Retaining check ${before.retained}, checkpoint ${checkpoint}, goal ${goal}. Exact editable files: ${JSON.stringify(files)}. Task: ${task}. Reproduce with a repository regression before changing implementation. Both owners' original evaluators must pass on the new assembly, then a joined product and goal. No observer edits or replay.`,
		/** @param {Run} r */
		apply(r) {
			const choice=select(r);
			if (digest(choice)!==digest(before)) fail("stale_assignment","Production approval inputs changed");
			const n=r.nodes[producer], token=randomUUID();
			assign(n,"staff");n.generation=candidate;n.token=token;
			delete n.worker;delete n.workspace;delete n.preview;delete n.candidate;delete n.check;delete n.reason;
			reserveWorker(r,actor,token,candidate,`Production assignment for ${producer} on failed assembly ${candidate}; read ${n.grain.specification} and ${n.grain.boundary.join(", ")}. ${task}\nOnly edit ${JSON.stringify(files)}. Start with a durable regression in the normal repository suite. Demonstrate red before a production change and green afterward. Do not infer a production cause from the diagnostic alone or weaken existing checks. If the behavior cannot be reproduced, stop with foundry_submit missingInput explaining the missing evidence; do not make a speculative fix. Join helpers and call foundry_submit({run:"${r.id}",token:"${token}"}).`,n.grain.agent,producer,undefined,undefined,choice.grant);
			return ()=>commitAt(cwd,r.policy.target)===choice.target;
		}};
}

/** @param {string} cwd @param {Run} run @param {Call} job @param {string} commit @param {string} actor */
export function submitProduction(cwd,run,job,commit,actor) {
	const {primary,retainer,target}=productionBasis(cwd,run,job,commit);
	if (!job.production || !job.grain) fail("invalid_production","Missing production grant");
	const n=run.nodes[job.grain];
	n.candidate=commit;assign(n,"submit");
	for (const id of [primary,retainer]) {
		const check=reserveCheck(run,actor,cwd,commit,run.nodes[id].grain.check,id);
		const e=run.effects.at(-1);
		if (e?.kind!=="component") fail("invalid_production","Missing component reservation");
		e.remedy={writer:job.id,basis:digest(job.production)};
		if (id===job.grain) n.check=check;
	}
	return target;
}

/** Do not withdraw the old publication or spend the other owner's binding on a negative observation.
 * @param {string} cwd @param {Run} run @param {Call} job @param {Call} check */
export function settleProduction(cwd,run,job,check) {
	const g=job.production, checks=remedyChecks(run,job);
	if (!g || !job.grain || checks.length!==2 || checks.some(awaitingReply)) return;
	if (checks.some(c=>c.state==="refused" || c.launcherExit!==undefined)) {run.nodes[job.grain]=structuredClone(g.prior);return;}
	if (checks.some(c=>!c.receipt || c.state!=="done")) return;
	if (!passingRemedy(run,check)) {run.nodes[job.grain]=structuredClone(g.prior);return;}
	productionBasis(cwd,run,job,check.commit);
	for (const c of checks) {
		const n=run.nodes[text(c.grain,"paired grain")];
		if (c.grain!==job.grain) {
			delete n.token;delete n.worker;delete n.workspace;delete n.preview;
			n.generation=g.candidate;
		}
		n.candidate=c.commit;n.check=c.id;assign(n,"paired-pass");delete n.reason;
	}
}
