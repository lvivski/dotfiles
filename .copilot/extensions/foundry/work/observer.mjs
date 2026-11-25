import { randomUUID } from "node:crypto";
import { availableReservations } from "./capacity.mjs";
import { checkReceipt } from "./evidence.mjs";
import { admitted, reserveWorker } from "./native.mjs";
import { currentPair } from "./pairing.mjs";
import { validRestoration } from "./partition.mjs";
import { waiting, writerInputs } from "./plan.mjs";
import { changedFiles, commitAt, contractPaths, outside, regularFiles, verifyContracts } from "./product.mjs";
import { verifiedCitations } from "./restoration.mjs";
import { digest, fail, fields, name, relative } from "./values.mjs";

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
	const n=run.nodes[old.grain], p=run.products.at(-1);
	if (!p || !validRestoration(run,n) || typeof n.grain.directory!=="string" || !grant.file.startsWith(n.grain.directory+"/") ||
		!outside(grant.file,contractPaths(run.policy)) || regularFiles(cwd,old.commit,[grant.file])[0].oid!==grant.before ||
		verifiedCitations(cwd,run,run.nodes[old.pair.retainer],n.grain.directory,p.commit)?.paths.includes(grant.file))
		fail("observer_scope","Choose one unchanged regular observer inside the primary, outside contracts and retained review evidence");
	for (const node of [n,run.nodes[old.pair.retainer]]) {
		const pins=writerInputs(run.nodes,waiting(node.grain));
		if (!pins || digest(pins)!==digest(node.inputs) || Object.entries(pins).some(([id,pin])=>p.outputs[id]!==pin || run.nodes[id].state!=="qualified"))
			fail("stale_assignment","The paired assignments' original checked prerequisites changed");
	}
	verifyContracts(cwd,run.policy,old.pair.target);
	return {old,base:old.commit,pair:old.pair,n};
}

/** @param {string} cwd @param {Run} run @param {Call} job @param {string} candidate @param {boolean} submit */
export function verifyObserver(cwd,run,job,candidate,submit) {
	const {base,pair}=observerBasis(cwd,run,job), grant=job.observer;
	if (!grant) fail("invalid_observer","Missing observer grant");
	const after=changedObserver(cwd,base,candidate,grant);
	if (submit && !grant.after) fail("approval_required","Preview the one-file observer diff for operator approval before submitting");
	if (grant.after && grant.after!==after) fail("stale_assignment","The submitted observer differs from the approved preview");
	return pair.target;
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} a @param {(e:Call)=>void} verify */
export function prepareObserver(cwd,run,actor,a,verify) {
	fields(a,["run","grain","pair","file","blob","preview"]);
	const grain=name(a.grain,"picker assignment"), pair=name(a.pair,"negative paired component"),
		file=relative(a.file), before=name(a.blob,"original observer blob"), preview=a.preview===undefined?undefined:name(a.preview,"writer preview");
	const grant={pair,file,before};
	/** @param {Run} live */
	function select(live) {
		if (actor!==live.owner) fail("foreign_run","Only the owner can request observer recovery");
		admitted(live);
		const old=live.effects.find(e=>e.id===pair), n=live.nodes[grain];
		if (!n || old?.kind!=="component" || !old.pair || !old.commit || !old.runnerClaim || checkReceipt(old)?.exit!==1 || old.grain!==grain)
			fail("invalid_observer","Need the exact signed failed paired observation");
		const jobs=live.effects.filter(e=>e.kind==="writer" && e.observer?.pair===pair), w=observerWriter(live,n.token);
		if (preview ? jobs.length!==1 || w!==jobs[0] || w?.state!=="done" || !w.observer || w.observer.after ||
			w.nativeId!==n.worker || n.state!=="writing" || n.preview!==preview || digest(w.observer)!==digest(grant) :
			jobs.length || n.state!=="blocked" || n.check!==pair || n.candidate!==old.commit)
			fail("invalid_observer","Need the original blocked pair or its one bound writer's current unapproved preview");
		if (!preview && !availableReservations(live)) fail("limit","No authorized assignment or writer slot remains");
		const basis=observerBasis(cwd,live,{...old,observer:grant});
		for (const id of new Set([pair,old.pair.failed,old.pair.component,old.pair.checkpoint,old.pair.goal])) {
			const e=live.effects.find(e=>e.id===id);
			if (e?.tool!=="bash" || !e.runnerClaim || !checkReceipt(e)) fail("missing_receipt","Missing signed observer recovery input");
			verify(e);
		}
		return {base:basis.base,inputs:old.pair,worker:n.worker,token:n.token,
			after:preview ? changedObserver(cwd,basis.base,preview,grant) : undefined};
	}
	const selected=select(run);
	return {
		prompt:`Failed pair ${pair} at ${selected.base}, original failure ${selected.inputs.failed}; retainer ${selected.inputs.retainer}@${selected.inputs.candidate} (${selected.inputs.component}), checkpoint ${selected.inputs.checkpoint}, goal ${selected.inputs.goal}. `+
			(preview ? `Approve this Foundry writer's exact observer diff only after reviewing it: git diff --no-ext-diff --no-textconv ${selected.base} ${preview}\n${file}: ${before} -> ${selected.after}. Approve only if every assertion and tolerance is preserved and faults are still rejected. The writer must submit these bytes for fresh checks.` :
			`Authorize one fresh Foundry writer on that assembly to improve failure attribution only in ${file} (blob ${before})? No production or contract edits, copied coordinator patch, retries, or check on an unchanged tree. The writer must preview changes for separate approval. Both signed failures stand.`),
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
				n.token=randomUUID();n.generation=now.base;n.state="writing";
				n.grain={...n.grain,task:`Improve failure attribution only in ${file}; preserve the original behavior assertions.`};
				delete n.worker;delete n.workspace;delete n.preview;delete n.candidate;delete n.check;delete n.reason;
				const brief=`Diagnose the behavior reported by signed component ${pair} on the checked assembly in this worktree. Read ${n.grain.specification}, ${n.grain.boundary.join(", ")} and the assigned check ${n.grain.check}. Author your own observer-only change to ${file}; no other file is writable. Separate expected and actual values at each phase including baseline. Preserve every behavior assertion and tolerance. Verify on intact and deliberately faulty controls in disposable copies. Do not import a coordinator patch or change product code. Join helpers and call foundry_preview({run:"${live.id}",token:"${n.token}"}); tell the owner the preview and control results. After the operator approves that exact diff submit the same bytes with foundry_submit. No local commits, branch changes or reruns of the failed pair.`;
				reserveWorker(live,actor,n.token,now.base,brief,n.grain.agent,grain,undefined,grant);
			}
			return ()=>commitAt(cwd,live.policy.target)===now.inputs.target;
		}
	};
}
