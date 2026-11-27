import { verifyJoinedInputs, verifyRepairInputs } from "./assembly.mjs";
import { checkReceipt } from "./evidence.mjs";
import { checks, currentDelivery, seal } from "./batch.mjs";
import { assess } from "./goal.mjs";
import { harnessFiles } from "./harness.mjs";
import { componentBatch } from "./inspection.mjs";
import { admitted, expired, reserveCheck, reserveProduct } from "./native.mjs";
import { validateNodes, writerInputs } from "./plan.mjs";
import { checkDirectory, commitAt, directoryBaseline, outside, retain, stageDelivery, verifyContracts } from "./product.mjs";
import { publishedComponent, publishedNodes } from "./publication.mjs";
import { settledCheckpoint } from "./repin.mjs";
import { grant } from "./transfer.mjs";
import { digest, fail, fields, name, names, roots } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Delivery} Delivery */
/** @typedef {import("./model.js").NativeCall} Call */

/** @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} a @param {(e:Call)=>void} signed */
export function prepareDelivery(cwd,run,actor,a,signed) {
	fields(a,["run","checkpoint","goal","reruns"]);
	if (actor!==run.owner) fail("foreign_run","Only the run owner can deliver stopped tests");
	const checkpoint=name(a.checkpoint,"current product check"), goal=name(a.goal,"current settled goal"), ids=names(a.reruns,"passed test reruns");
	if (!ids.length) fail("invalid_field","Select at least one passed test rerun");
	/** @param {Run} r */
	function select(r) {
		admitted(r);
		const target=commitAt(cwd,r.policy.target), {last,goal:at}=settledCheckpoint(r,target,"Test delivery");
		if (last.check!==checkpoint || at.check!==goal) fail("stale_assignment","Checkpoint or goal changed; inspect current owner proof");
		verifyContracts(cwd,r.policy,target);
		for (const id of [checkpoint,goal]) {
			const e=r.effects.find(c=>c.id===id);
			if (e?.tool!=="bash") fail("missing_receipt",`Missing check ${id}`);
			signed(e);
		}
		for (const [id,candidate] of Object.entries(last.outputs)) {
			const n=r.nodes[id];
			if (n?.state!=="qualified" || n.candidate!==candidate || !publishedComponent(r,n.check,id,candidate) ||
				last.ownership && digest(last.ownership[id])!==digest(grant(n)))
				fail("ownership_transition",`Cannot preserve the current checked owner of ${id}`);
		}
		const selected=ids.map(id=>{
			const e=r.effects.find(x=>x.id===id), pin=e?.kind==="rerun" ? e.rerun : undefined;
			const n=e?.grain && r.nodes[e.grain], old=pin && r.effects.find(c=>c.id===pin.of);
			if (!pin || !n || e?.kind!=="rerun" || !e.runnerClaim || checkReceipt(e)?.exit!==0 || e.commit!==last.commit ||
				r.effects.findLast(x=>x.kind==="rerun" && x.rerun?.of===pin.of && x.commit===last.commit)!==e ||
				old?.kind!=="component" || !old.runnerClaim || !checkReceipt(old)?.exit || old.issuer!==n.worker || old.commit!==pin.candidate ||
				n.state!=="blocked" || n.check!==pin.of || n.grain.check!==e.check || Object.hasOwn(last.outputs,n.grain.id))
				fail("not_recoverable",`${id}: need the latest signed passing rerun of the still-stopped original on this product`);
			signed(old); signed(e);
			const dir=n.grain.directory;
			if (typeof dir!=="string" || pin.directory!==dir || pin.harness.length!==1 || pin.harness[0]!==dir ||
				n.reuse || n.retained || n.restoration || n.successor || n.excluded ||
				r.effects.some(x=>x.kind==="scout" && x.id===n.review && (x.correction || x.iteration?.transfer || x.iteration?.successor)) ||
				Object.values(r.nodes).some(v=>v!==n && !outside(dir,roots(v.grain.directory))))
				fail("ineligible_delivery",`${id}: require one disjoint test directory, with no external historical overlay or ownership transition`);
			checkDirectory(cwd,last.commit,dir);
			const tree=directoryBaseline(cwd,pin.candidate,dir)?.tree;
			if (!tree || directoryBaseline(cwd,last.commit,dir)) fail("ineligible_delivery",`${dir} must be wholly absent from the current checked product`);
			const files=harnessFiles(cwd,last.commit,n.grain.check,pin).files;
			if (!files.length || files.some(f=>!f.name.startsWith(dir+"/"))) fail("ineligible_delivery",`Cannot isolate all test files in ${dir}`);
			const required=writerInputs(r.nodes,{...n,state:"waiting"});
			if (!required || Object.entries(required).some(([id,pin])=>last.outputs[id]!==pin))
				fail("stale_assignment",`Missing checked prerequisites for ${dir}`);
			verifyRepairInputs(cwd,r,n,required,last.commit);
			return {item:{prior:n,rerun:id,tree},update:{directory:dir,from:last.commit,to:pin.candidate},files:files.map(f=>f.name)};
		});
		const assembly=stageDelivery(cwd,last.commit,selected.map(s=>s.update),target);
		const outputs={...last.outputs}, nodes={...r.nodes};
		for (const {item:{prior:n}} of selected) {
			outputs[n.grain.id]=assembly;
			nodes[n.grain.id]={...n,state:"published",base:last.commit};
		}
		validateNodes(nodes);
		verifyJoinedInputs(cwd,{...r,nodes},outputs,last.commit,assembly);
		const basis={checkpoint,goal,assembly,selected:selected.map(s=>s.item)};
		if (r.deliveries?.some(d=>d.assembly===assembly && d.checkpoint===checkpoint && d.goal===goal &&
			d.selected.length===ids.length && d.selected.every(s=>ids.includes(s.rerun))))
			fail("duplicate_delivery","This exact batch already has a delivery record; inspect its checks");
		return {grant:{...basis,id:seal(basis)},files:selected.map(s=>({directory:s.update.directory,candidate:s.update.to,tree:s.item.tree,files:s.files})),target};
	}
	const selected=select(run);
	return {prompt:`Deliver these absent TEST-ONLY directories on checkpoint ${checkpoint} (goal ${goal}, target ${selected.target})?\n`+
		`${JSON.stringify(selected.files)}\nCombined commit: ${selected.grant.assembly}.\n`+
		"Approve only if every listed file is a test or test helper, never shipped code, and no required input is unknown. "+
		`Run every selected component on this combined commit${run.inspections ? " and independently review each contributed test directory" : ""}, then the product check and final goal. No historical candidate is promoted and the target is not changed.`,
		/** @param {Run} r */
		apply(r) {
			const again=select(r);
			if (digest(again)!==digest(selected)) fail("stale_assignment","Test delivery changed during approval");
			const d=again.grant;
			retain(cwd,d.assembly);
			(r.deliveries??=[]).push(d);
			nextComponent(cwd,r,d,0);
			return ()=>!expired(r) && commitAt(cwd,r.policy.target)===again.target;
		}};
}

/** @param {string} cwd @param {Run} r @param {Delivery} d @param {number} i */
function nextComponent(cwd,r,d,i) {
	const g=d.selected[i].prior.grain;
	reserveCheck(r,r.owner,cwd,d.assembly,g.check,g.id);
	const e=r.effects.at(-1);
	if (e?.kind!=="component") throw Error("Missing delivery component");
	e.delivery=d.id;
}

/** Run the original default suites serially: they can share a desktop. Don't publish any
 * member until the product has passed with every selected directory physically present.
 * @param {string} cwd @param {Run} run @param {Delivery} d @param {string} target */
export function deliveryResult(cwd,run,d,target) {
	if (d.assessment || d.error) return;
	const jobs=checks(run,d), e=jobs.at(-1);
	if (!e) fail("corrupt_run","Missing delivery reservation");
	if (run.effects.some(e=>e.permissionHold)) return;
	const receipt=checkReceipt(e);
	if (!currentDelivery(run,d,target) || e.state==="refused" || e.launcherExit!==undefined || receipt && receipt.exit!==0) {
		if (!receipt && (e.state==="issued" || e.state==="uncertain")) return;
		d.error=`Delivery stopped at ${e.id}: ${receipt && receipt.exit!==0 ? `exit ${receipt.exit ?? "unavailable"}: ${receipt.output}` : e.error ?? "approved checkpoint or target changed"}`;
		if (run.join?.check===e.id) delete run.join;
		return;
	}
	if (!receipt || !e.runnerClaim) return;
	const p=run.products.at(-1);
	if (!p) fail("corrupt_run","Missing delivery checkpoint");
	if (e.kind==="component") {
		const batch=componentBatch(run,d.assembly,d.selected.map(s=>s.prior.grain.id),jobs);
		if(batch.state==="next")return nextComponent(cwd,run,d,batch.index);
		if(batch.state==="changes"){
			const {review}=batch;
			d.error=`Delivery stopped at review ${review.id} of ${review.grain} (${review.component}): ${review.summary} `+
				"This delivery authorizes only unchanged historical test files. Repair needs a separate write grant; the original stopped tasks and receipts have been kept.";
		}
		if(batch.state!=="ready")return;
		const outputs={...p.outputs};
		for (const {prior} of d.selected) outputs[prior.grain.id]=d.assembly;
		reserveProduct(run,run.owner,cwd,target,d.assembly,outputs);
		const product=run.effects.at(-1);
		if (product?.kind!=="product") throw Error("Missing delivery product reservation");
		product.delivery=d.id;
		return;
	}
	const join=run.join;
	if (e.kind!=="product" || join?.check!==e.id) fail("corrupt_run","Missing exact delivery product");
	verifyContracts(cwd,run.policy,target);
	run.nodes=publishedNodes(run,jobs.slice(0,-1),({grain,review,inputs,supporting,repairs})=>
		({grain,review,inputs,supporting,repairs,base:p.commit,generation:p.commit,state:"qualified"}));
	run.products.push(join);delete run.join;
	assess(cwd,run,run.owner,target,join.commit);
	d.assessment=run.goal?.check;
}
