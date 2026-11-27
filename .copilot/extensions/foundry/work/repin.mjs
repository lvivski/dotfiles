import { journeyText } from "./brief.mjs";
import { bindOutput } from "./description.mjs";
import { offerId } from "./consent.mjs";
import { awaitingReply, unissued } from "./dispatch.mjs";
import { changes, verifyJoinedInputs } from "./assembly.mjs";
import { remainingAssignments } from "./capacity.mjs";
import { assign } from "./assignment.mjs";
import { evaluatorPaths, productOverlayPaths } from "./overlay.mjs";
import { checkpointReceipt, currentEvaluation, goalReceipt, productPin } from "./evidence.mjs";
import { admitted, current, reserveProduct } from "./native.mjs";
import { productOutputs } from "./plan.mjs";
import { changedFiles, commitAt, contractConflict, contractPaths, descendsFrom, entries, git, outside, regularFiles, retain, stageDelivery, verifyContracts } from "./product.mjs";
import { carriedInput, publishedComponent } from "./publication.mjs";
import { reconciledBase } from "./resolution.mjs";
import { checkpointBindings } from "./offers.mjs";
import { reviews } from "./charter.mjs";
import { questions, releasedReviews, retireSuperseded } from "./reviews.mjs";
import { digest, fail, fields, relative, text } from "./values.mjs";
import { ownershipMode, retainedMode } from "./transfer.mjs";
import { partitionConflict } from "./partition.mjs";
import { checkpointQueue } from "./quiescence.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {Run} run @param {string} actor @param {string} from @param {boolean} product @param {boolean} [certified] */
function allowed(run, actor, from, product,certified=false) {
	if (actor !== run.owner) fail("foreign_run", "Only the run owner can repin its evaluator");
	admitted(run);
	const evaluator = product ? run.policy.productCheck : run.policy.goalCheck;
	if (!run.goal || !evaluator || !certified && !evaluator.startsWith(".foundry/")) fail("invalid_goal", "Repinning requires a goal run and a selected evaluator under .foundry/");
	if (((product ? productPin(run) : run.repins?.at(-1)?.revision) ?? run.policy.base) !== from) fail("stale_pin", "The evaluator pin changed; review the current diff");
	return evaluator;
}

/** @param {Run} run @param {string} target */
export function settledCheckpoint(run, target, operation="Product repinning", retarget=false) {
	const conflict=partitionConflict(run);
	if (conflict) fail("ownership_transition",conflict);
	const last = run.products.at(-1), goal = run.goal, receipt = goalReceipt(run);
	const history = reviews(run).filter(r=>currentEvaluation(run,r)), funded = remainingAssignments(run) > 0;
	const {held,retained}=checkpointQueue(run,retarget);
	if (held.length) fail("unsettled_checkpoint",`${operation} must wait for current assignments: ${held.join(", ")}. Waiting is a scheduler queue, not a writable repair; only a current writer grant can submit.`);
	if (!goal || !last || last.target !== target || goal.target !== target || last.commit !== goal.commit ||
		!checkpointReceipt(run,last.check,last.commit) || !receipt || ![1,2].includes(receipt.exit ?? -1) ||
		run.join || (!retarget && run.conflict) || run.blocker || questions(run).some(r=>r.decision?.status !== "answered") || run.pendingReviewNotes?.length ||
		funded && releasedReviews(run,history).length ||
		run.effects.some(e => awaitingReply(e) || (unissued(e) || e.permissionHold) && current(run,e) ||
			e.kind === "scout" && e.state === "reported" && currentEvaluation(run,e) && e.base === goal.commit))
		fail("unsettled_checkpoint", `${operation} requires a quiescent current checked product and settled unmet or missing goal; resolve pending work and holds first`);
	return {last, goal, retained};
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} args
 * @param {(e:import("./model.js").NativeCall)=>void} signed @param {import("./model.js").TestRepair} [repair] */
export function prepareRepin(cwd, run, actor, args, signed,repair) {
	if (args.kind==="target") {
		fields(args,["run","kind","from","revision","files","checkpoint","goal","acceptance","resolutions"]);
		const acceptance=text(args.acceptance,"reviewed release rule and prospective charter change");
		const plan=targetPlan(cwd,run,actor,args.revision,signed,args);
		return {prompt:`${plan.prompt}\nReviewed change: ${acceptance}`,target:plan.offer,answer:acceptance,apply:(/** @type {Run} */ live)=>plan.apply(live,acceptance)};
	}
	fields(args, ["run", "from", "revision", "files","kind","ownership"]);
	if (args.kind !== undefined && args.kind !== "product") fail("invalid_field","Omit kind for the goal evaluator or specify product");
	const product = args.kind === "product";
	if (args.ownership !== undefined && (!product || args.ownership !== retainedMode) ||
		product && Object.values(run.nodes).some(n=>n.retained) && args.ownership !== retainedMode)
		fail("unsupported_ownership","Transfers require a product checker explicitly supporting retain-except-transferred");
	const from = text(args.from, "current evaluator pin"), revision = text(args.revision, "new evaluator pin");
	const certified=!!repair && !product && repair.state==="approved" && repair.pin===from && repair.revision===revision &&
		repair.rule.check===run.policy.goalCheck && repair.stop===run.goal?.check && run.testRepairs?.includes(repair)===true;
	const evaluator = allowed(run, actor, from, product,certified), target = commitAt(cwd,run.policy.target);
	verifyContracts(cwd, run.policy, target);
	const checkpoint = product ? settledCheckpoint(run,target) : undefined;
	const stamp=checkpoint && checkpointBindings(run,checkpoint.last.outputs);
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision) || commitAt(cwd, revision) !== revision)
		fail("invalid_pin", "Use the full object ID of the reviewed local commit");
	const files = changedFiles(cwd, from, revision).map(relative).sort();
	if (!files.length || !Array.isArray(args.files) || JSON.stringify(args.files.map(relative).sort()) !== JSON.stringify(files))
		fail("invalid_pin", "The file list must match the complete nonempty committed diff");
	if (product) {
		if (!productOverlayPaths(run,files))
			fail("contract_scope","Change only the named product evaluator or its private <evaluator>.d/ helpers");
	}

	if (!evaluatorPaths(run,product?"product":"goal",files,certified))
		fail("contract_scope", "Only the selected evaluator and its .foundry helpers may change, not the brief, other checks, or product");
	regularFiles(cwd, revision, [evaluator]);
	for (const e of entries(cwd, revision, true, files))
		if (!["100644", "100755"].includes(e.mode)) fail("invalid_pin", `Not a regular evaluator file: ${e.name}`);
	/** @type {Pick<NonNullable<Run["productRepins"]>[number],"from"|"revision"|"files"|"ownership">} */
	const pin = { from, revision, files, ...(args.ownership === retainedMode ? {ownership:retainedMode} : {}) };
	return {
		prompt: (checkpoint ? `Run ${run.id}: authorize this diff for the product evaluator only (${evaluator}) and opt this run into exact-file ownership comparisons?\n` +
			(args.ownership ? `This checker must subtract FOUNDRY_OWNERSHIP exclude.directories and exclude.files for ${retainedMode}.\n` : "") +
			`Recheck ${checkpoint.last.commit}, checkpoint ${checkpoint.last.check}, unchanged target ${target}. The original goal will be assessed afresh only after a pass. No writer access is granted by this approval.\n` :
			`Run ${run.id}: authorize the following committed diff for goal checks only?\n`) +
			`git diff --no-ext-diff --no-textconv ${from} ${revision}\nFiles: ${JSON.stringify(files)}\n` +
			"Approve to recheck the existing product only if this fixes evaluation without changing the product requirements.",
		/** @param {Run} live */
		apply(live) {
			allowed(live, actor, from, product,certified);
			const tip = commitAt(cwd, live.policy.target);
			verifyContracts(cwd, live.policy, tip);
			if (checkpoint && (tip !== target || checkpointBindings(live,checkpoint.last.outputs)!==stamp)) fail("stale_pin","Checkpoint or included output changed during product approval");
			if (revision === live.policy.base || (product ? live.productRepins : live.repins)?.some(p => p.revision === revision))
				fail("stale_pin", "Use a new reviewed commit, not a previously applied pin");
			retain(cwd, revision);
			if (checkpoint) {
				const {last,goal} = settledCheckpoint(live,tip);
				const upgrade = {...pin,checkpoint:last.check,goal:goal.check,recheck:""};
				(live.productRepins ??= []).push(upgrade);
				const {check}=reserveProduct(live,actor,cwd,tip,last.commit,{...last.outputs});
				upgrade.recheck=check.id;
				bindOutput(live,check,{kind:"assembly"},tip);
				return () => commitAt(cwd,live.policy.target) === tip;
			}
			if(!live.goal)fail("stale_pin","No original goal for this evaluator change");
			(live.repins ??= []).push({...pin,assessment:live.goal.check});
			for (const r of reviews(live)) retireSuperseded(live, r);
		},
	};
}

/** Same preflight and apply for an explicit manifest and an automatically derived proposal.
 * @param {string} cwd @param {Run} run @param {string} actor @param {unknown} requested
 * @param {(e:import("./model.js").NativeCall)=>void} signed @param {Record<string,unknown>} [args] */
export function targetPlan(cwd,run,actor,requested,signed,args) {
	if (actor!==run.owner) fail("foreign_run","Only the run owner can repin the target contract");
	admitted(run);
	const {policy}=run, from=policy.contractTarget ?? policy.base, revision=commitAt(cwd,policy.target);
	const lastTarget=run.products.at(-1)?.target;
	if (args && args.from!==from || requested!==revision || !lastTarget || lastTarget===revision || !descendsFrom(cwd,revision,lastTarget))
		fail("stale_pin","Name the current contract pin and full live descendant target commit");
	const productFrom=productPin(run) ?? policy.base, goalFrom=run.repins?.at(-1)?.revision ?? policy.base;
	const paths=contractPaths({...policy,contractTarget:revision});
	const comparisons=new Map([...new Set([from,productFrom,goalFrom])].map(pin=>[pin,changedFiles(cwd,pin,revision,paths)]));
	const files=[...new Set([...comparisons.values()].flat())].sort();
	if (!files.length || args && (!Array.isArray(args.files) || digest(args.files.map(relative).sort())!==digest(files)))
		fail("invalid_pin",`Name the complete nonempty conserved-file diff from the contract and both approved evaluator pins: ${JSON.stringify(files)}`);
	if (files.includes(policy.source) || run.independent || run.effects.some(e=>e.permissionHold) ||
		run.conflict && run.conflict!==contractConflict(cwd,policy,revision))
		fail("contract_scope","Cannot replace the activated plan or override a permission or integration hold");
	const {last,goal,retained}=settledCheckpoint(run,lastTarget,"Target repinning",true);
	if(!currentEvaluation(run,run.effects.find(e=>e.id===goal.check)))fail("unsettled_checkpoint","Wait for the goal on the currently approved evaluator pins.");
	if (args && (last.check!==args.checkpoint || goal.check!==args.goal) || run.repins?.some(p=>p.revision===revision) ||
		run.productRepins?.some(p=>p.revision===revision)) fail("stale_pin","Need the exact settled checkpoint, goal, and a new target pin");
	for (const id of [last.check,goal.check]) {
		const e=run.effects.find(e=>e.id===id);
		if (e?.tool!=="bash") fail("missing_receipt","Missing the original signed checkpoint or goal");
		signed(e);
	}
	for (const check of retained) signed(check);
	const required=regularFiles(cwd,revision,policy.files);
	if (policy.sharedBrief) journeyText(cwd,required[policy.files.indexOf(policy.sharedBrief)]);
	for (const e of entries(cwd,revision,true,files)) if (!["100644","100755"].includes(e.mode))
		fail("invalid_pin",`Not a regular contract file: ${e.name}`);
	const mode=ownershipMode(run);
	const outputs=productOutputs(run,revision,remainingAssignments(run)) ?? fail("ownership_transition","An output or ownership repair is outstanding");
	const owners=Object.keys(outputs).map(id=>({id,directory:run.nodes[id].grain.directory}));
	const {base,rows,details}=reconciledBase(cwd,last,revision,args?.resolutions,paths,args ? undefined : owners), edits=changedFiles(cwd,last.commit,base);
	for (const [id,candidate] of Object.entries(outputs)) {
		const n=run.nodes[id];
		if (!outside(n.grain.directory,edits)) fail("tree_conflict",`Target edited owned output ${id}; reconcile its files before adopting this target`);
		const c=publishedComponent(run,n.check,id,candidate)?.component;
		if(!c){
			const old=run.effects.find(e=>e.id===n.check);
			if(old?.check===n.grain.check && carriedInput(run,last,old,id,candidate))continue;
			fail("unreviewed_output",`Target adoption cannot include unreviewed output ${id}`);
		}
		if(c.check!==n.grain.check)fail("missing_receipt",`Wrong component evaluator for published output ${id}`);
		if(last.outputs[id]!==candidate)signed(c);
	}
	const conflict=partitionConflict(run,outputs,revision);
	if (conflict) fail("ownership_transition",conflict);
	const assembly=stageDelivery(cwd,base,changes(run,outputs),revision);
	verifyJoinedInputs(cwd,run,outputs,base,assembly);
	verifyContracts(cwd,{...policy,contractTarget:revision},assembly);
	const prompt=`Run ${run.id}: adopt this release change on ${revision}?\n`+
		`Current contract: ${from}. Current product evaluator: ${productFrom}. Current goal evaluator: ${goalFrom}.\n`+
		`Use the target's ${policy.productCheck} for the joined product and ${policy.goalCheck} for final acceptance. Review the conserved changes against each pin:\n`+
		[...comparisons].map(([pin,files])=>`${pin}: ${JSON.stringify(files)}\n`+
			(files.length ? git(cwd,["diff","--no-ext-diff","--no-textconv","--no-renames","--stat","--compact-summary",pin,revision,"--",...paths]).toString() : "")+
			`Full diff: git diff --no-ext-diff --no-textconv ${pin} ${revision}`).join("\n")+"\n"+
		(details.length ? `Exact file resolutions outside the included outputs (base ${last.target}, checkpoint ${last.commit}, target ${revision}):\n${details.join("\n")}\n` : "")+
		`Checkpoint ${last.check}, goal ${goal.check}. Recheck components ${JSON.stringify(outputs)}, product and goal on ${assembly}. `+
		(retained.length ? `Keep these unavailable candidates and their signed checks as history, outside this product; no repair was issued. `+
			`${JSON.stringify(retained.map(e=>({grain:e.grain,candidate:e.commit,check:e.id})))}. Their directories on the joined base are not replaced.\n` : "")+
		`The target checker must retain the ${mode} ownership interface. `+
		`The target branch, old receipts and existing writer grants do not change. New assignments use the reviewed charter.`;
	const manifest={from,productFrom,goalFrom,files,outputs,ownership:mode,retained:retained.map(c=>c.id).sort(),
		...(rows.length && {resolutions:[...rows].sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0)})};
	const offer={revision,checkpoint:last.check,goal:goal.check,assembly,manifest,message:prompt};
	return {prompt,offer,
		/** @param {Run} live @param {string} acceptance */
		apply(live,acceptance) {
			admitted(live);text(acceptance,"reviewed acceptance change");
			if (live!==run || commitAt(cwd,policy.target)!==revision) fail("stale_pin","Revalidate the exact target manifest on the committing snapshot");
			retain(cwd,revision);retain(cwd,assembly);
			const pin={from:productFrom,revision,files,checkpoint:last.check,goal:goal.check,recheck:"",targetFrom:from,acceptance,...(rows.length && {resolutions:rows}),...(mode===retainedMode && {ownership:mode})};
			(live.productRepins??=[]).push(pin);
			(live.repins??=[]).push({from:goalFrom,revision,files});
			live.policy.contractTarget=revision;
			for (const e of retained) {
				const n=live.nodes[text(e.grain,"retained grain")];
				assign(n,{type:"stop",reason:`Unavailable component ${e.id} (exit 2); target adoption superseded the unissued repair. Candidate ${e.commit} retained.`});
			}
			delete live.conflict;
			const {check}=reserveProduct(live,actor,cwd,revision,assembly,outputs);
			pin.recheck=check.id;
			bindOutput(live,check,{kind:"approval",id:offerId(offer)},revision);
			return ()=>commitAt(cwd,policy.target)===revision;
		}};
}
