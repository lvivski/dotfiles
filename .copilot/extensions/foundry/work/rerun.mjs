import { checkReceipt, checkpointReceipt } from "./evidence.mjs";
import { frozenCheckpoint } from "./goal.mjs";
import { harnessFiles } from "./harness.mjs";
import { admitted, reserveCheck } from "./native.mjs";
import { commitAt } from "./product.mjs";
import { digest, fail, fields, name, relative } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Call */
/** @param {unknown} raw */
function paths(raw) {
	if (!Array.isArray(raw)) fail("invalid_field","Expected a list of repository-relative inputs");
	return raw.map(relative).sort();
}

/** A new, non-qualifying observation. Never set node.check to this reservation.
 * @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} a @param {(e:Call)=>void} signed */
export function prepareRerun(cwd,run,actor,a,signed) {
	fields(a,["run","check","product","harness","current","after"]);
	const of=name(a.check,"original stopped component check"), product=name(a.product,"checked product commit"),
		after=a.after===undefined ? undefined : name(a.after,"previous observation");
	/** @param {Run} r */
	function select(r) {
		if (r.owner!==actor) fail("foreign_run","Only the run owner can request a component recheck on a checked product");
		const previous=r.effects.filter(e=>e.kind==="rerun" && e.rerun?.of===of && e.commit===product);
		const parent=after && previous.find(e=>e.id===after);
		if (after && (!parent || parent.kind!=="rerun" || !parent.rerun || !checkReceipt(parent)))
			fail("stale_assignment","The previous recheck must have a signed outcome for this original and product");
		const inherited=parent && parent.kind==="rerun" ? parent.rerun : undefined;
		const harness=paths(a.harness ?? inherited?.harness), current=paths(a.current ?? inherited?.current ?? []);
		if (inherited && digest([inherited.harness,inherited.current])!==digest([harness,current]))
			fail("stale_assignment","A repeat must run the identical approved check and product inputs");
		const same=previous.find(e=>e.kind==="rerun" && e.rerun?.after===after);
		if (same?.kind==="rerun" && same.rerun) {
			if (digest([same.rerun.harness,same.rerun.current])!==digest([harness,current]))
				fail("stale_assignment",`Observation ${same.id} already reserved with different inputs`);
			return;
		}
		admitted(r);
		const target=commitAt(cwd,r.policy.target), moved=r.products.at(-1)?.target!==target;
		if (r.independent || r.blocker || r.effects.some(e=>e.permissionHold) || r.conflict && !moved)
			fail("dispatch_held","Resolve the outstanding run or permission hold first");
		const old=r.effects.find(e=>e.id===of), n=old?.grain && r.nodes[old.grain], p=r.products.at(-1);
		const receipt=checkReceipt(old);
		if (old?.kind!=="component" || !n || n.state!=="blocked" || n.check!==of || n.worker!==old.issuer ||
			old.check!==n.grain.check || !old.commit || !receipt?.exit || old.pair || old.observer || old.remedy || n.restoration)
			fail("not_recoverable",`Need the stopped assignment's original signed numeric component failure: ${of}`);
		if (!old.runnerClaim) fail("missing_receipt",`Component ${of} recorded exit ${receipt.exit} at ${old.commit}, but has no runner signing key. The original result cannot be verified for a linked recheck. Do not resubmit the writer.`);
		signed(old);
		if (p?.commit!==product || !checkpointReceipt(r,p.check,product) || moved && !frozenCheckpoint(cwd,r,target))
			fail("stale_assignment","Need the full current checked product on its target or a held checkpoint on a descendant target");
		const checkpoint=r.effects.find(e=>e.id===p.check);
		if (checkpoint?.kind!=="product") fail("missing_receipt","No passing product check");
		signed(checkpoint);
		const last=previous.at(-1);
		if (last?.id!==after || last && (last.kind!=="rerun" || !checkReceipt(last)))
			fail("stale_assignment","Name the latest signed recheck to authorize another observation on these same product bytes");
		if (last?.kind==="rerun") signed(last);
		const pin={of,checkpoint:p.check,candidate:old.commit,directory:n.grain.directory,harness,current,...(moved && {observedTarget:target}),...(after && {after})};
		const inputs=harnessFiles(cwd,product,n.grain.check,pin);
		return {pin,inputs,grain:n.grain.id,check:n.grain.check,target};
	}
	const selected=select(run);
	if (!selected) return;
	const {pin,inputs,grain,check,target}=selected;
	return {prompt:after ? undefined : `Rerun the full unchanged ${check} for ${grain} (original ${of} at ${pin.candidate}) against checked product ${product} (${pin.checkpoint})?`+
		(pin.observedTarget ? `\nTarget ${target} moved. Only the frozen checkpoint is under observation.` : "")+
		`\nHistorical harness: ${JSON.stringify(pin.harness)}. Restore only these changed test files in the disposable export: ${JSON.stringify(inputs.files.map(e=>e.name))}.`+
		`\nKeep current product bytes for these differences: ${JSON.stringify(inputs.current)}.`+
		"\nApprove only if the complete original default suite, including external helpers and discovery, is accounted for and no production input is restored. If any input is unknown, decline. Append a signed observation; no writer, repair, integration or release.",
		/** @param {Run} r */
		apply(r) {
			const again=select(r);
			if (!again) return;
			if (digest(again)!==digest(selected)) fail("stale_assignment","Recheck inputs changed before reservation");
			reserveCheck(r,actor,cwd,product,check,{kind:"rerun",grain,rerun:pin});
			return ()=>{admitted(r);return commitAt(cwd,r.policy.target)===target;};
		}};
}
