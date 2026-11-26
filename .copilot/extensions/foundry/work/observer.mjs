import { randomUUID } from "node:crypto";
import { assign } from "./assignment.mjs";
import { availableReservations } from "./capacity.mjs";
import { checkReceipt } from "./evidence.mjs";
import { admitted, reserveWorker } from "./native.mjs";
import { currentPair } from "./pairing.mjs";
import { observerInput, validRestoration } from "./partition.mjs";
import { waiting, writerInputs } from "./plan.mjs";
import { changedFiles, commitAt, contractPaths, outside, regularFiles, verifyContracts } from "./product.mjs";
import { verifiedCitations } from "./restoration.mjs";
import { digest, fail, fields, name, record, relative, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Call */
/** @typedef {import("./model.js").Observer} Observer */
/** @param {Run} run @param {string|undefined} token */
export function observerWriter(run,token) {
	const w=run.effects.find(e=>e.kind==="writer" && e.token===token && e.observer);
	return w?.kind==="writer" ? w : undefined;
}

/** @param {string} cwd @param {string} base @param {string} candidate @param {Observer} grant */
function changedObserver(cwd,base,candidate,grant) {
	const paths=changedFiles(cwd,base,candidate);
	if (paths.length!==1 || paths[0]!==grant.file) fail("observer_scope","Change exactly the authorized existing observer file");
	const [old]=regularFiles(cwd,base,paths), [next]=regularFiles(cwd,candidate,paths);
	if (old.mode!==next.mode || old.oid!==grant.before || old.oid===next.oid)
		fail("observer_scope","The observation requires changed bytes of the same regular file, not a mode or path change");
	return next.oid;
}

/** @param {string} cwd @param {Run} run @param {Call} job */
export function observerBasis(cwd,run,job) {
	const grant=job.observer, old=grant && run.effects.find(e=>e.id===grant.pair);
	if (!grant || old?.kind!=="component" || !old.pair || !old.commit || old.grain!==job.grain || !old.grain ||
		checkReceipt(old)?.exit!==1 || !currentPair(cwd,run,old,job.id) || run.blocker || run.conflict || run.join)
		fail("stale_assignment","The signed negative pair, checkpoint, goal, retaining pin and consumer state must still match");
	const source=observerInput(run.effects,grant);
	if (!source?.commit) fail("invalid_observer","Need the first observer's exact signed negative component, candidate and approved file");
	if (grant.previous && (!source.observer || changedObserver(cwd,old.commit,source.commit,source.observer)!==grant.before))
		fail("observer_scope","The previous observer changed inputs outside its approved diff");
	const n=run.nodes[old.grain], p=run.products.at(-1);
	if (!p || !validRestoration(run,n) || typeof n.grain.directory!=="string" || !grant.file.startsWith(n.grain.directory+"/") ||
		!outside(grant.file,contractPaths(run.policy)) || regularFiles(cwd,source.commit,[grant.file])[0].oid!==grant.before ||
		verifiedCitations(cwd,run,run.nodes[old.pair.retainer],n.grain.directory,p.commit)?.paths.includes(grant.file))
		fail("observer_scope","Choose one unchanged regular observer inside the primary, outside contracts and retained review evidence");
	for (const node of [n,run.nodes[old.pair.retainer]]) {
		const pins=writerInputs(run.nodes,waiting(node.grain));
		if (!pins || digest(pins)!==digest(node.inputs) || Object.entries(pins).some(([id,pin])=>p.outputs[id]!==pin || run.nodes[id].state!=="qualified"))
			fail("stale_assignment","The paired assignments' original checked prerequisites changed");
	}
	verifyContracts(cwd,run.policy,old.pair.target);
	return {old,source,base:source.commit,pair:old.pair,n};
}

/** @param {string} cwd @param {ReturnType<typeof observerBasis>} basis @param {string} candidate @param {Observer} grant */
function previewBlob(cwd,basis,candidate,grant) {
	const after=changedObserver(cwd,basis.base,candidate,grant);
	if (grant.previous && after===basis.source.observer?.before) fail("observer_scope","Do not resubmit the original failed paired input");
	return after;
}

/** @param {string} cwd @param {Run} run @param {Call} job @param {string} candidate @param {boolean} submit */
export function verifyObserver(cwd,run,job,candidate,submit) {
	const basis=observerBasis(cwd,run,job), grant=job.observer;
	if (!grant) fail("invalid_observer","Missing observer grant");
	const after=previewBlob(cwd,basis,candidate,grant);
	if (submit && !grant.after) fail("approval_required","Preview the one-file observer diff for operator approval before submitting");
	if (grant.after && grant.after!==after) fail("stale_assignment","The submitted observer differs from the approved preview");
	return basis.pair.target;
}

/** @param {unknown} value @returns {NonNullable<Observer["previous"]>} */
function predecessor(value) {
	const a=record(value);fields(a,["check","candidate","phases"]);
	if (!Array.isArray(a.phases) || a.phases.length<2 || a.phases.length>8) fail("invalid_observer","Name two to eight distinguishable observation phases");
	const phases=a.phases.map(v=>text(v,"phase").trim());
	if (phases.some(p=>p.length>120 || /[\r\n]/.test(p)) || new Set(phases).size!==phases.length) fail("invalid_observer","Use distinct, short phase labels");
	return {check:name(a.check,"failed observer check"),candidate:name(a.candidate,"failed observer candidate"),phases};
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} a @param {(e:Call)=>void} verify */
export function prepareObserver(cwd,run,actor,a,verify) {
	fields(a,["run","grain","pair","file","blob","preview","previous"]);
	const grain=name(a.grain,"picker assignment"), pair=name(a.pair,"negative paired component"),
		file=relative(a.file), before=name(a.blob,"original observer blob"), preview=a.preview===undefined?undefined:name(a.preview,"writer preview");
	const previous=a.previous===undefined?undefined:predecessor(a.previous);
	const grant={pair,file,before,...previous && {previous}};
	/** @param {Run} live */
	function select(live) {
		if (actor!==live.owner) fail("foreign_run","Only the owner can request observer recovery");
		admitted(live);
		const old=live.effects.find(e=>e.id===pair), n=live.nodes[grain];
		if (!n || old?.kind!=="component" || !old.pair || !old.commit || !old.runnerClaim || checkReceipt(old)?.exit!==1 || old.grain!==grain)
			fail("invalid_observer","Need the exact signed failed paired observation");
		const source=observerInput(live.effects,grant);
		if (!source?.commit) fail("invalid_observer","Need the original signed diagnostic failure, candidate and exact same observer file");
		const jobs=live.effects.filter(e=>e.kind==="writer" && e.observer?.pair===pair), w=observerWriter(live,n.token);
		const count=previous?1:0;
		if (preview ? jobs.length!==count+1 || w!==jobs[count] || w?.state!=="done" || !w.observer || w.observer.after ||
			w.nativeId!==n.worker || n.state!=="writing" || n.preview!==preview || digest(w.observer)!==digest(grant) :
			jobs.length!==count || n.state!=="blocked" || n.check!==source.id || n.candidate!==source.commit ||
			previous && (w!==jobs[0] || !w?.observer || w.nativeId!==source.issuer || digest(w.observer)!==digest(source.observer)))
			fail("invalid_observer","Need the named blocked check with an unused diagnostic grant, or its bound writer's current unapproved preview");
		if (!preview && !availableReservations(live)) fail("limit","No authorized assignment or writer slot remains");
		const basis=observerBasis(cwd,live,{...old,observer:grant});
		for (const id of new Set([source.id,pair,old.pair.failed,old.pair.component,old.pair.checkpoint,old.pair.goal])) {
			const e=live.effects.find(e=>e.id===id);
			if (e?.tool!=="bash" || !e.runnerClaim || !checkReceipt(e)) fail("missing_receipt","Missing signed observer recovery input");
			verify(e);
		}
		return {base:basis.base,inputs:old.pair,worker:n.worker,token:n.token,
			after:preview ? previewBlob(cwd,basis,preview,grant) : undefined};
	}
	const selected=select(run);
	return {
		prompt:`Failed pair ${pair}, original failure ${selected.inputs.failed}; retainer ${selected.inputs.retainer}@${selected.inputs.candidate} (${selected.inputs.component}), checkpoint ${selected.inputs.checkpoint}, goal ${selected.inputs.goal}. Base ${selected.base}. `+
			(previous?`One final diagnostic writer after failed observer ${previous.check} on ${previous.candidate}. Distinguish these phases: ${JSON.stringify(previous.phases)}. Preserve every earlier assertion; no production grant or further observer. `:"")+
			(preview ? `Approve this Foundry writer's exact observer diff only after reviewing it: git diff --no-ext-diff --no-textconv ${selected.base} ${preview}\n${file}: ${before} -> ${selected.after}. Approve only if every assertion and tolerance is preserved and faults are still rejected. The writer must submit these bytes for fresh checks.` :
			`Authorize one fresh Foundry writer on that assembly to improve failure attribution only in ${file} (blob ${before})? No production or contract edits, copied coordinator patch, retries, or check on an unchanged tree. The writer must preview changes for separate approval. All prior receipts stand.`),
		/** @param {Run} live */
		apply(live) {
			const now=select(live);
			if (digest(now)!==digest(selected)) fail("stale_assignment","Observer approval inputs changed");
			const n=live.nodes[grain];
			if (preview) {
				const job=observerWriter(live,n.token);
				if (!job?.observer || !now.after) fail("invalid_observer","Missing bound writer and approved blob");
				job.observer.after=now.after;
			} else {
				n.token=randomUUID();n.generation=now.base;assign(n,"staff");
				n.grain={...n.grain,task:`Improve failure attribution only in ${file}; preserve the original behavior assertions.`};
				delete n.worker;delete n.workspace;delete n.preview;delete n.candidate;delete n.check;delete n.reason;
				const brief=`Diagnose the behavior reported by signed component ${previous?.check??pair} on the checked assembly in this worktree. Read ${n.grain.specification}, ${n.grain.boundary.join(", ")} and the assigned check ${n.grain.check}. Author your own observer-only change to ${file}; no other file is writable. Separate expected and actual values at each phase including baseline. Preserve every behavior assertion and tolerance. Verify on intact and deliberately faulty controls in disposable copies. Do not import a coordinator patch or change product code. Join helpers and call foundry_preview({run:"${live.id}",token:"${n.token}"}); tell the owner the preview and control results. After the operator approves that exact diff submit the same bytes with foundry_submit. No local commits, branch changes or reruns of the failed pair.`;
				const focus=previous?` Starting from failed observer ${previous.check} at ${previous.candidate}, distinguish ${JSON.stringify(previous.phases)}. Preserve all earlier assertions including already-passing paths. Show intact and deliberately broken phase controls. On failure identify the first mismatching phase and expected/actual state or the specific missing observation for the owner. No production change or further observer assignment.`:"";
				reserveWorker(live,actor,n.token,now.base,brief+focus,n.grain.agent,grain,undefined,grant);
			}
			return ()=>commitAt(cwd,live.policy.target)===now.inputs.target;
		}
	};
}
