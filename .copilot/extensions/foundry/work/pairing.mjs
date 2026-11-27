import { changes, verifiedCitations, verifyJoinedInputs } from "./assembly.mjs";
import { assign } from "./assignment.mjs";
import { availableReservations } from "./capacity.mjs";
import { checkReceipt, goalReceipt } from "./evidence.mjs";
import { checkpointCurrent } from "./facts.mjs";
import { admitted, reserveCheck } from "./native.mjs";
import { historicalGrant, matchesPair, validRestoration } from "./partition.mjs";
import { waiting, writerInputs } from "./plan.mjs";
import { changedFiles, combinedTree, commitAt, contractPaths, directoryBaseline, pairedCommit, regularFiles, treeOf, verifyContracts } from "./product.mjs";
import { publishedComponent } from "./publication.mjs";
import { awaitingReply } from "./reservation.mjs";
import { activeConsumer } from "./transfer.mjs";
import { digest, fail, fields, name } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Call */

/** @param {string} cwd @param {Run} run @param {string} grain @param {string} retainer @param {string} checkpoint @param {string} [self] */
function pairHold(cwd,run,grain,retainer,checkpoint,self) {
	const n=run.nodes[grain], owner=run.nodes[retainer], r=n?.restoration;
	if (!r || typeof n.grain.directory!=="string") return "Missing unchanged restoration grant";
	const pending=run.effects.find(e=>e.id!==self && (e.permissionHold || [grain,retainer,r.from].includes(e.grain ?? "") && awaitingReply(e)));
	if (pending) return `Resolve outstanding ${pending.kind} ${pending.id} first`;
	const scope=n.grain.directory, citations=verifiedCitations(cwd,run,owner,scope,checkpoint);
	for (const id of [r.from,grain]) {
		const consumer=activeConsumer(run,id,scope,{except:grain,verifiedCitationsOf:citations ? owner : undefined});
		if (consumer) return `${consumer.grain.id} still consumes ${id} or frozen evidence in ${scope}`;
	}
}

/** @param {string} cwd @param {Run} run @param {Call} e @param {string} [self] */
export function currentPair(cwd,run,e,self=e.id) {
	const pair=e.pair;
	if (!pair || !e.grain || !e.commit) return false;
	const target=commitAt(cwd,run.policy.target), p=run.products.at(-1);
	return !!p && matchesPair(run,pair,target) && checkpointCurrent(run,pair.checkpoint,target) &&
		treeOf(cwd,e.commit)===pair.tree && !pairHold(cwd,run,e.grain,pair.retainer,p.commit,self);
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} a @param {(e:Call)=>void} verify */
export function preparePair(cwd,run,actor,a,verify) {
	fields(a,["run","grain","failed","checkpoint","goal","retainer","component","candidate"]);
	const grain=name(a.grain,"restoration assignment"), failed=name(a.failed,"failed original attestation"),
		checkpoint=name(a.checkpoint,"current product check"), goal=name(a.goal,"current goal"), retainer=name(a.retainer,"retaining owner"),
		component=name(a.component,"passing retaining component"), candidate=name(a.candidate,"retaining candidate");
	/** @param {Run} live */
	function select(live) {
		if (actor!==live.owner) fail("foreign_run","Only the owner can request a paired observation");
		admitted(live);
		const n=live.nodes[grain], r=n?.restoration, owner=live.nodes[retainer], p=live.products.at(-1), target=commitAt(cwd,live.policy.target);
		const old=live.effects.find(e=>e.id===failed), held=live.effects.find(e=>e.id===component);
		const receipt=checkReceipt(old);
		if (!r || !p || !validRestoration(live,n) || n.state!=="blocked" || n.check!==failed || r.retainer!==retainer || r.checkpoint!==checkpoint || r.goal!==goal ||
			typeof n.grain.directory!=="string" || old?.kind!=="component" || old.pair || old.issuer!==n.worker || old.grain!==grain ||
			!old.commit || old.commit!==n.candidate || !old.runnerClaim || receipt?.exit!==1 || receipt.failure || old.check!==n.grain.check ||
			live.effects.some(e=>e.kind==="component" && e.pair?.failed===failed))
			fail("invalid_pair","Need the original blocked restoration and its signed exit-1 component; a paired observation is not repeatable");
		if (p.check!==checkpoint || !checkpointCurrent(live,checkpoint,target) || live.goal?.check!==goal || ![1,2].includes(goalReceipt(live)?.exit ?? -1) ||
			owner?.state!=="published" || owner.check!==component || owner.candidate!==candidate || held?.kind!=="component" ||
			held.grain!==retainer || held.commit!==candidate || held.issuer!==owner.worker || checkReceipt(held)?.exit!==0)
			fail("stale_assignment","Need the exact current checkpoint, goal and published retaining candidate with its own passing component");
		if (!publishedComponent(live,held.id,retainer,candidate))
			fail("unreviewed_output","An unchanged attestation cannot stand in for review of the retaining owner's changed output");
		const hold=pairHold(cwd,live,grain,retainer,p.commit);
		if (hold) fail("dispatch_held",hold);
		if (!availableReservations(live,Infinity)) fail("limit","No worker slot is free for the frozen component observation");
		const h=historicalGrant(live,r.from,r.historical), scope=n.grain.directory;
		if (!h || treeOf(cwd,old.commit)!==treeOf(cwd,p.commit) || directoryBaseline(cwd,old.commit,scope)?.tree!==r.tree)
			fail("stale_assignment","The original check must have observed the unchanged primary in the named checkpoint tree");
		verifyContracts(cwd,live.policy,target);
		for (const id of new Set([failed,component,checkpoint,goal,h.component.id,r.historical])) {
			const e=live.effects.find(e=>e.id===id);
			if (e?.tool!=="bash" || !checkReceipt(e)) fail("missing_receipt","Missing signed paired-check evidence");
			verify(e);
		}
		for (const node of [n,owner]) {
			const pins=writerInputs(live.nodes,waiting(node.grain));
			if (!pins || digest(pins)!==digest(node.inputs) || Object.entries(pins).some(([id,pin])=>p.outputs[id]!==pin || live.nodes[id].state!=="qualified"))
				fail("stale_assignment","The original prerequisites must remain checked on this product");
		}
		const assembly=combinedTree(cwd,p.commit,changes(live,{[retainer]:candidate}));
		verifyJoinedInputs(cwd,live,{...n.inputs,...owner.inputs,[grain]:old.commit,[retainer]:candidate},p.commit,assembly);
		const oldFiles=new Map(regularFiles(cwd,old.commit,h.scope.files).map(e=>[e.name,e.oid]));
		if (!regularFiles(cwd,assembly,h.scope.files).some(e=>oldFiles.get(e.name)!==e.oid) || directoryBaseline(cwd,assembly,scope)?.tree!==r.tree ||
			changedFiles(cwd,old.commit,assembly,contractPaths(live.policy)).length)
			fail("unchanged_pair","Need different retaining integration bytes, the identical primary tree, and the original evaluator");
		const pair={failed,component,candidate,retainer,checkpoint,goal,target,tree:assembly};
		return {pair,scope,grant:owner.grain.directory,check:n.grain.check,primary:r.tree};
	}
	const before=select(run);
	return {
		/** @param {Run} live */
		apply(live) {
			const next=select(live);
			if (digest(next)!==digest(before)) fail("stale_assignment","Paired inputs changed before reservation");
			const n=live.nodes[grain];
			n.candidate=pairedCommit(cwd,before.pair.tree);
			n.check=reserveCheck(live,actor,cwd,n.candidate,n.grain.check,grain);
			const effect=live.effects.at(-1);
			if (effect?.kind!=="component") fail("invalid_pair","Missing paired component reservation");
			effect.pair=before.pair;
			assign(n,"recheck");
			if (live.goal) delete live.goal.stall;
			return ()=>commitAt(cwd,live.policy.target)===before.pair.target;
		}
	};
}
