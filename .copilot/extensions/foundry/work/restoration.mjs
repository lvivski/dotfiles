import { availableReservations } from "./capacity.mjs";
import { checkReceipt, goalReceipt } from "./evidence.mjs";
import { checkpointCurrent } from "./facts.mjs";
import { reserveWriter } from "./graph.mjs";
import { admitted } from "./native.mjs";
import { deliveredFile } from "./pages.mjs";
import { displacement, historicalGrant } from "./partition.mjs";
import { owns, validateNodes, waiting, writerInputs } from "./plan.mjs";
import { changedFiles, commitAt, directoryBaseline, outside, regularFiles, verifyContracts } from "./product.mjs";
import { awaitingReply } from "./reservation.mjs";
import { comparison, requestedFiles } from "./reviews.mjs";
import { activeConsumer, touchesCut } from "./transfer.mjs";
import { covers, digest, fail, fields, name, sameScope } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** An assigning scout's citation is not necessarily a writer input. Only the
 * published retainer can use this distinction, and only for the same Git evidence.
 * @param {string} cwd @param {Run} run @param {import("./model.js").Node} owner @param {string} primary @param {string} commit */
export function verifiedCitations(cwd,run,owner,primary,commit) {
	if (owner.state!=="published") return;
	const r=run.effects.find(e=>e.id===owner.review);
	if (r?.kind!=="scout" || r.state!=="observed" || r.observation?.outcome!=="regenerate" || !r.packet) return;
	const {packet}=r, paths=r.observation.evidence.filter(p=>covers(primary,p));
	const source=comparison(run,r)?.source?.file;
	if (!paths.length || packet.review!==r.id || packet.base!==r.base || source && covers(primary,source)) return;
	const legacyInputs=run.policy.sharedBrief && !owner.supporting ? requestedFiles(run,r) : undefined;
	if (paths.some(p=>legacyInputs?.has(p)) || changedFiles(cwd,r.base,commit,paths).length) return;
	if (regularFiles(cwd,commit,paths).every(e=>deliveredFile(packet,e.name,e.oid))) return {review:r.id,paths};
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} a
 * @param {(e:import("./model.js").NativeCall)=>void} verify */
export function prepareRestoration(cwd,run,actor,a,verify) {
	fields(a,["run","from","historical","retainer","to","checkpoint","goal"]);
	const from=name(a.from,"lost output"), historical=name(a.historical,"historical product check"), retainer=name(a.retainer,"retaining owner"),
		to=name(a.to,"fresh output"), checkpoint=name(a.checkpoint,"current product check"), goal=name(a.goal,"current goal check");
	/** @param {Run} live */
	function select(live) {
		if (actor!==live.owner) fail("foreign_run","Only the owner can request a forward ownership restoration");
		admitted(live);
		const h=historicalGrant(live,from,historical), displaced=displacement(live,from);
		const target=commitAt(cwd,live.policy.target), p=live.products.at(-1), owner=live.nodes[retainer];
		if (!h || !p || !displaced || !sameScope(h.scope,displaced.scope) || live.nodes[from] || live.nodes[to] || live.effects.some(e=>e.grain===to) ||
			displaced.replacements.length!==1 || !owner || displaced.replacements[0]!==owner ||
			!["writing","checking","waiting","published","qualified"].includes(owner.state) ||
			!h.scope.files.every(f=>covers(owner.grain.directory,f) && !touchesCut(owner.retained ?? [],f)) ||
			Object.values(live.nodes).some(n=>n.restoration?.from===from || !outside(n.grain.directory,[h.scope.primary])))
			fail("invalid_restoration","Need a displaced checked mixed grant, one current owner covering every exact file, an unowned primary and a fresh ID");
		if (p.check!==checkpoint || !checkpointCurrent(live,checkpoint,target) || live.goal?.check!==goal ||
			![1,2].includes(goalReceipt(live)?.exit ?? -1))
			fail("stale_assignment","Need the exact current checked product and settled exit-1 or exit-2 goal on the unchanged target");
		const pending=live.effects.find(e=>e.permissionHold || (e.grain===from || e.grain===retainer || e.issuer===actor && e.kind==="scout") && awaitingReply(e));
		if (pending) fail("dispatch_held",`Resolve the ${pending.kind} ${pending.id} (${pending.state}${pending.permissionHold ? ", permission hold" : ""}) in its issuing session ${pending.issuer} before restoration`);
		const citations=verifiedCitations(cwd,live,owner,h.scope.primary,p.commit);
		const consumer=activeConsumer(live,from,h.scope.primary,{verifiedCitationsOf:citations ? owner : undefined});
		if (consumer) fail("dispatch_held",`${consumer.grain.id} (${consumer.state}) still consumes ${from} or frozen evidence in ${h.scope.primary}`);
		const squad=live.policy.squads.find(s=>s.id===h.squad);
		if (!squad || !("areas" in squad) || !owns(squad,h.scope) || !squad.checks.includes(h.grain.check) || !outside(h.scope.primary,live.policy.files))
			fail("invalid_restoration","The original charter and evaluator must still cover the unchanged primary");
		if (!availableReservations(live)) fail("limit","No authorized writer slot or assignment budget remains");
		verifyContracts(cwd,live.policy,target);
		const baseline=directoryBaseline(cwd,p.commit,h.scope.primary);
		if (!baseline || changedFiles(cwd,h.candidate,p.commit,[h.scope.primary]).length ||
			changedFiles(cwd,h.product.commit,p.commit,[h.scope.primary]).length)
			fail("stale_assignment","The orphaned primary must still match both its checked candidate and historical product");
		regularFiles(cwd,p.commit,h.scope.files);
		const checked=["published","qualified"].includes(owner.state);
		if (checked && !owner.check) fail("missing_receipt","Missing retaining owner's component");
		for (const id of new Set([h.component.id,historical,checkpoint,goal,...(checked && owner.check ? [owner.check] : [])])) {
			const e=live.effects.find(e=>e.id===id);
			if (!e || e.kind==="scout" || !e.runnerClaim || !checkReceipt(e) || id!==goal && checkReceipt(e)?.exit!==0) fail("missing_receipt","Missing signed ownership evidence");
			verify(e);
		}
		const node=waiting({id:to,task:`Verify the unchanged checked directory ${h.scope.primary} under its own assignment.`,
			directory:h.scope.primary,needs:h.grain.needs,check:h.grain.check,specification:squad.charter,boundary:squad.boundary,...(squad.agent && {agent:squad.agent})});
		const pins=writerInputs(live.nodes,node);
		if (!pins || Object.entries(pins).some(([id,pin])=>p.outputs[id]!==pin || live.nodes[id].state!=="qualified"))
			fail("stale_assignment","All original prerequisites must be present and checked on the current product");
		node.restoration={from,historical,retainer,checkpoint,goal,tree:baseline.tree};
		return {node,pins,target,commit:p.commit,files:h.scope.files,owner:owner.grain.directory,tree:baseline.tree,citations,
			binding:{state:owner.state,worker:owner.worker,generation:owner.generation,check:owner.check,candidate:owner.candidate}};
	}
	const before=select(run);
	return {
		prompt:`Restore only ${before.node.grain.directory} as ${to} from current checked product ${before.commit} (${checkpoint}), goal ${goal}?\n`+
			`Historical mixed output ${from} at ${historical}. ${retainer} (${before.binding.state}) retains ${JSON.stringify(before.owner)}, including ${JSON.stringify(before.files)}. `+
			(before.binding.candidate ? `Retain candidate ${before.binding.candidate}, component ${before.binding.check}. ` : "Its existing writer and any pending evidence stay intact. ")+
			(before.citations ? `Retaining scout ${before.citations.review} cited ${JSON.stringify(before.citations.paths)}; the cited files are unchanged and are not writer inputs. ` : "")+
			`The new writer submits only unchanged tree ${before.tree} to ${before.node.grain.check}. Authorize fresh component, product and goal checks for the new ownership map; do not replay or amend any previous verdict.`,
		/** @param {Run} live */
		apply(live) {
			const fresh=select(live);
			if (digest(fresh)!==digest(before)) fail("stale_assignment","Approved ownership, source, or inputs changed");
			live.nodes[to]=fresh.node;validateNodes(live.nodes);
			reserveWriter(cwd,live,fresh.node,fresh.pins,fresh.commit,actor);
			if (live.goal) delete live.goal.stall;
			return ()=>commitAt(cwd,live.policy.target)===fresh.target;
		}
	};
}
