import { offered } from "./artifacts.mjs";
import { materialize } from "./reference.mjs";
import { sharedBlockers } from "./routing.mjs";
import { remainingAssignments } from "./capacity.mjs";
import { changedFrom, inconclusiveRepair, launcherFailure, missingInput, productPin, relinquishable } from "./evidence.mjs";
import { handoff, portableProof } from "./handoff.mjs";
import { metricsFacts, timingFacts } from "./metrics.mjs";
import { scheduling, workerLimit } from "./policy.mjs";
import { ownershipMode } from "./transfer.mjs";
import { workspaceName } from "./workspace.mjs";
import { canDispatch } from "./native.mjs";
import { stalePins } from "./lineage.mjs";
import { presentation } from "./charter.mjs";
import { replacementChecks, replacementStop } from "./replacement.mjs";
import { fail } from "./values.mjs";
import { adoptionQuestions, nodeFact, pendingFact, visible } from "./visibility.mjs";
import { guidance } from "./guidance.mjs";
import { instructionPermitted } from "./instructions.mjs";
import { effectAt,inspectionAt,revisionLookup } from "./revision.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {Run} run @param {string} actor @param {import("./instructions.mjs").Tip} [tip] */
export function recoveryStatus(run,actor,tip){
	const view=visible(run,actor,false),{summary}=view;
	return {run:run.id,active:summary.active,expired:summary.expired,qualified:summary.qualified,checkpoint:summary.checkpoint,
		blocker:summary.blocker,prepared:prepared(run,actor,view.pending,tip),
		...(summary.integrityHolds && {integrityHolds:summary.integrityHolds}),...(summary.historicalChecks && {historicalChecks:summary.historicalChecks}),
		...(view.owner && {scheduling:scheduling(run),goal:run.goal && {check:run.goal.check,commit:run.goal.commit,exit:summary.goal?.receipt?.exit}}),
		...(view.owner && {questions:view.questions.map(q=>({review:q.review.id,question:q.fact.question})),
			...(summary.targetAdoption && {targetAdoption:{id:summary.targetAdoption.id,state:summary.targetAdoption.state,assembly:summary.targetAdoption.assembly}})}),
		recovery:guidance(run,actor,view,tip)};
}
/** @param {Run} run @param {string} actor @param {Run["effects"]} pending @param {import("./instructions.mjs").Tip} [tip] */
const prepared=(run,actor,pending,tip)=>[...pending,...run.instructions??[]].filter(e=>e.issuer===actor && e.state==="ordinary" && !e.permissionHold &&
	canDispatch(run,e) && (!tip || instructionPermitted(run,e.instruction,tip))).map(e=>({tool:e.tool,arguments:e.args}));
/** @param {Run} run @param {ReturnType<typeof visible>} view @param {unknown} detail @param {import("./portable.mjs").Evidence} [evidence] @param {string} [cwd] */
function ownerStatus(run, { receipts, questions, summary }, detail,evidence,cwd) {
	const last = run.products.at(-1);
	const correction=run.join && replacementChecks(run,run.join.check).at(-1);
	const inspection=correction && inspectionAt(run,correction.id);
	const rollout=run.adoptions?.findLast(a=>a.rollout && a.decision?.status==="answered");
	return {
		handoff: handoff(run, detail === "cleanup"),
		...(run.correctionDrafts?.length && {correctionDrafts:run.correctionDrafts.map(d=>({id:d.id,check:d.check,assembly:d.assembly,scopeApproval:d.decision?.status,
			...(d.finding && {inspection:d.finding.inspection,frontier:d.finding.frontier}),
			automatic:d.automatic,blob:d.blob,parts:d.parts.map(p=>({source:p.source,state:p.state,files:p.files,workflow:p.workflow,
				reason:p.reason??(p.state==="issued"?"Waiting for the original native author; no replacement launch.":undefined),
				...(detail==="proof" && {dispatch:p.dispatch,changes:p.changes})}))}))}),
		...(run.testRepairs?.length && {testRepairs:run.testRepairs.map(j=>({stop:j.stop,state:j.state,assertion:j.assertion,
			file:j.rule.check,grain:j.grain,wait:j.wait,reason:j.reason??((j.state==="authoring" || j.state==="reviewing")?
				(j.continuation?`Continuation for ${j.continuation} already issued; awaiting its original host outcome.`:j.workflow?`Waiting for original workflow ${j.workflow}.`:"Waiting for the original workflow binding. If the issuer was interrupted, this unconfirmed call cannot be replayed."):undefined),
			...(detail==="proof" && {controls:j.controls,recheck:j.recheck,author:j.author,reviewer:j.reviewer,subject:j.subject,
				product:j.product,revision:j.revision,driver:j.driver})}))}),
		scheduling: scheduling(run),
		sharedBlockers: sharedBlockers(run, remainingAssignments(run),cwd),
		...(rollout && {harnessRollout:{check:rollout.failed,from:rollout.rollout?.from,assembly:rollout.assembly,blob:rollout.rollout?.blob,
			harness:rollout.rollout?.harness,...(rollout.rollout?.followup && {followup:rollout.rollout.followup}),...(rollout.foreground && {foreground:rollout.foreground}),checks:run.effects.flatMap(e=>e.kind==="component" && e.rollout===rollout.id ?
				[{grain:e.grain,id:e.id,state:e.state,exit:receipts.get(e.id)?.exit,reason:replacementStop(run,e)??e.permissionHold??e.error}]:[])}}),
		...(correction && {outputCorrection:{proposal:correction.replacement,grain:correction.grain,candidate:correction.commit,
			component:correction.id,state:correction.state,exit:correction.receipt?.exit,review:inspection?.id,reviewState:inspection?.state,
			reason:replacementStop(run,correction)??inspection?.permissionHold??inspection?.summary??correction.permissionHold??correction.error}}),
		...(run.inspections && {codeReviews:run.inspections.map(({id,grain,component,candidate,state,summary,issuer,workflow,previous,permissionHold,base,generation,scope,task,specification})=>({
			id,grain,component,candidate,state,summary,permissionHold,...(detail==="proof" && {issuer,workflow,previous,base,generation,scope,task,specification}),
		}))}),
		...(run.deliveries?.length && {deliveries:run.deliveries.map(d=>({id:d.id,checkpoint:d.checkpoint,goal:d.goal,assembly:d.assembly,
			selected:d.selected.map(s=>({grain:s.prior.grain.id,original:s.prior.check,stop:s.prior.stop,reason:s.prior.reason,rerun:s.rerun,tree:s.tree})),
			checks:run.effects.flatMap(e=>e.tool==="bash" && e.delivery===d.id ? [{id:e.id,kind:e.kind,grain:e.grain,state:e.state,exit:receipts.get(e.id)?.exit}] : []),
			assessment:d.assessment,error:d.error}))}),
		...(detail === "proof" ? portableProof(run,evidence) : {}),
		...(detail==="proof" && run.effects.some(e=>e.kind==="repair" && e.baselineStop) && {baselineGrants:run.effects.flatMap(e=>e.kind==="repair" && e.baselineStop ?
			[{notice:e.id,state:e.state,worker:e.baselineStop.worker,grain:e.grain,review:e.baselineStop.review,reason:e.baselineStop.reason,
				stop:e.baselineStop.stop,baseline:e.baseline,...(e.continuation && {frozenCharter:e.continuation})}] : [])}),
		...(detail==="proof" && run.effects.some(e=>e.kind==="repair" && e.input) && {inputGrants:run.effects.flatMap(e=>e.kind==="repair" && e.input ?
			[{notice:e.id,state:e.state,worker:e.input.prior.worker,grain:e.grain,review:e.input.review,assignment:e.input.assignment,
				stop:e.input.prior.reason,blob:e.input.blob,goal:e.input.goal,checkpoint:e.input.checkpoint,requested:e.input.requested,withdrawn:e.input.withdrawn,
				...(e.continuation && {frozenCharter:e.continuation}),...(e.input.dependency ? {dependency:e.input.dependency} :
					run.artifacts?.[e.input.offer].source && {source:run.artifacts[e.input.offer].source})}] : [])}),
		...(detail === "proof" ? { checkRecovery: run.effects.flatMap(e => {
			if (e.tool!=="bash") return [];
			const exit = launcherFailure(e);
			if (exit===undefined && !e.replacement && !e.recheck && !e.rerun && !e.pair && !e.observer && !e.remedy && !(e.kind==="goal" && e.runnerClaim && e.receipt?.exit===null)) return [];
			return [{check:e.id,kind:e.kind,commit:e.commit,issuer:e.issuer,...(exit!==undefined && {launcherExit:exit}),
				...(e.pair && {pair:e.pair,originalReceipt:receipts.get(e.pair.failed),receipt:receipts.get(e.id)}),
				...(e.rerun && {rerun:e.rerun,...(!e.rerun.after && {originalReceipt:receipts.get(e.rerun.of)}),receipt:receipts.get(e.id)}),
				...(e.observer && {observer:e.observer,pairedReceipt:receipts.get(e.observer.pair),receipt:receipts.get(e.id)}),
				...(e.remedy && {repairWriter:e.remedy.writer,receipt:receipts.get(e.id)}),
				...(e.replacement && {proposal:e.replacement,receipt:receipts.get(e.id)}),
				...(e.kind==="goal" && e.runnerClaim && e.receipt?.exit===null && {interruptedGoal:true}),...(e.recheck && {approval:e.recheck})}];
		}) } : {}),
		...(detail==="proof" && run.effects.some(w=>w.kind==="writer" && w.production) && {productionRepairs:run.effects.flatMap(w=>
				w.kind==="writer" && w.production ? [{writer:w.id,grain:w.grain,diagnostic:w.production.diagnostic,files:w.production.files,
					task:w.production.task,session:w.nativeId,reason:w.error}] : [])}),
		metrics: detail === "usage" ? metricsFacts(run) : timingFacts(run),
		...(run.pendingReviewNotes?.length ? { pendingReviewNotes: run.pendingReviewNotes.map(({ squad, receipt, question, excerpt }) => ({ squad, receipt, question, excerpt })) } : {}),
		target: last?.target, outputs: last?.outputs ?? {},
		...(run.independent && {independentCheckpoint:detail==="proof" ? run.independent :
			{checkpoint:run.independent.checkpoint,observer:run.independent.observer,product:run.independent.product,assessment:run.independent.assessment}}),
		...(run.repins ? { evaluatorChanges: run.repins } : {}),
		contractPin:run.policy.contractTarget ?? run.policy.base,
		productPin:productPin(run) ?? run.policy.base,
		productOwnership:ownershipMode(run),
		...(run.productRepins ? {productEvaluatorChanges:run.productRepins.map(p=>detail==="proof" && p.amendments ?
			{...p,amendments:p.amendments.map(a=>({...a,prior:{...a.prior,receipt:receipts.get(a.prior.check)}}))} : p)} : {}),
		...(run.repins || run.productRepins || run.goal && detail === "proof" ? { goalChecks: run.effects.filter(e => e.kind === "goal").map(e => ({
			id: e.id, commit: e.commit, evaluatorRevision: e.evaluatorRevision ?? run.policy.base, state: e.state,
			...(e.productEvaluatorRevision ? {productEvaluatorRevision:e.productEvaluatorRevision} : {}),
			...(e.state === "retired" ? { infrastructureFailure: { reason: "Runner failed before recording a verdict", ...e.retirement } } : {}), receipt: receipts.get(e.id) })) } : {}),
		questions: [...questions.map(({ review: r, observation, fact }) => {
			const claim = presentation(r);
			return { ...fact, squad: r.squad, base: r.base, evidence: observation.evidence,
				...(observation.ownerInput && claim ? { recovery: { run: run.id, review: r.id, presentation: claim } } : {}) };
		}),...adoptionQuestions(summary)],
		...(detail==="proof" && run.adoptions && {targetProposals:run.adoptions.map(({basis,...a})=>a)}),
		products: run.products.map(p => ({ ...p, receipt: receipts.get(p.check) })),
		candidate: run.join && { ...run.join, receipt: receipts.get(run.join.check) },
	};
}

const statusRows=revisionLookup(run=>{
	const baselines = new Map(run.effects.flatMap(e => e.kind === "repair" && e.state === "done" && e.baseline ? [[e.token, e.baseline]] : []));
	const supplied=new Map(run.effects.flatMap(e=>e.kind==="repair" && e.input && e.state==="done" ? [[e.token,e.input.blob]] : []));
	const charters=new Map(run.effects.flatMap(e=>e.kind==="repair" && e.continuation && e.state==="done" ? [[e.token,e.continuation]] : []));
	const inspections = new Map(run.effects.flatMap(e => e.kind === "writer" && e.readGrant ? [[e.token, e.readGrant]] : []));
	const observers = new Map(run.effects.flatMap(e => e.kind==="writer" && e.observer ? [[e.token,e.observer]] : []));
	const producers = new Map(run.effects.flatMap(w=>w.kind==="writer" && w.production ? [[w.token,Object.freeze({diagnostic:w.production.diagnostic,task:w.production.task,files:w.production.files})]] : []));
	const reuse = new Map(run.effects.flatMap(e => e.kind === "writer" && e.reuse ? [[e.id,Object.freeze({
		assignment:e.id, candidate:e.reuse.predecessor.candidate, check:e.reuse.predecessor.check, worker:e.reuse.predecessor.worker,
		blob:e.reuse.blob, checkpoint:e.reuse.checkpoint, goal:e.reuse.goal
	})]] : []));
	return {baselines,supplied,charters,inspections,observers,producers,reuse};
});
/** @param {Run} run @param {string} actor @param {unknown} [detail] @param {import("./instructions.mjs").Tip} [tip] @param {import("./portable.mjs").Evidence} [evidence] @param {string} [cwd] */
export function status(run, actor, detail, tip,evidence,cwd) {
	if (detail !== undefined) {
		if (run.owner !== actor) fail("foreign_run", "Only the owner can request handoff details");
		if (detail !== "proof" && detail !== "cleanup" && detail !== "usage") fail("invalid_field", "Unknown status detail");
	}
	const view = visible(run, actor,true,cwd), { owner, nodes, pending, assignments } = view;
	const {baselines,supplied,charters,inspections,observers,producers,reuse}=statusRows(run);
	const correction=(/** @type {string|undefined} */ id)=>{const e=effectAt(run,id);return e?.kind==="scout" && e.correction && (owner || !e.correction.ordinary)?{correction:e.correction}:{};};
	return {
		...view.summary, contract: { commit: run.policy.base, path: run.policy.source, ...(run.policy.contractTarget && {targetPin:run.policy.contractTarget}) },
		recovery:guidance(run,actor,view,tip),
		limit: workerLimit(run) ?? null, ...(assignments ? { assignments } : {}), deadline: run.policy.deadline,
		...(owner ? ownerStatus(run, view, detail,evidence,cwd) : {}),
		artifacts: (run.artifacts ?? []).filter(a => owner || a.publisher === actor || nodes.some(n => offered(a, n))).map(a => ({ ...a, extract: materialize(a) })),
		artifactReports: run.effects.flatMap(e => e.kind === "component" && (owner || e.issuer === actor) && (e.usedArtifacts || e.comparedArtifacts)
			? [{ grain: e.grain, worker: e.issuer, candidate: e.commit, usedArtifacts: e.usedArtifacts, comparedArtifacts: e.comparedArtifacts }] : []),
		nodes: nodes.map(n => ({
			...nodeFact(n,view), ...(n.preview ? {preview: n.preview} : {}),
			...(observers.has(n.token) && {observer:observers.get(n.token)}),
			...(producers.has(n.token) && {production:producers.get(n.token)}),
			priorSource: n.priorSource, baseline: n.state === "writing" ? baselines.get(n.token) : undefined,
			...(n.stop?.input && {requestedInput:n.stop.input}),
			...(n.state==="writing" && supplied.has(n.token) && {suppliedInput:supplied.get(n.token)}),
			...(n.state==="writing" && charters.has(n.token) && {frozenCharter:charters.get(n.token)}),
			...(n.state === "writing" && n.check && inconclusiveRepair(n, effectAt(run,n.check))
				? { cannotRepair: { check:n.check, action:"If the assignment permits no further repair, submit cannotRepair:{check,reason} with your current token instead of repeating the check." } } : {}),
			...(actor === n.worker && n.state === "writing" && relinquishable(run,n) ? {relinquish:{check:n.check}} : {}),
			readGrant: missingInput(n) !== undefined ? inspections.get(n.token) : undefined,
			...(actor === n.worker ? { token: n.token, changedFrom: n.state === "blocked" && !stalePins(run, n).length
				? changedFrom(n,effectAt(run,n.check)) : undefined } : {}),
			review:n.review,...correction(n.review),
			...(n.reuse ? {reuse:reuse.get(n.reuse)} : {}),
			...(owner && n.check ? {check:n.check} : {}),
			repairs: n.repairs, inputs: n.inputs, generation: n.generation,
			...(n.workspace ? {workspace:workspaceName(n.workspace)} : {}),
		})),
		pending: pending.map(pendingFact),
		prepared: prepared(run,actor,pending,tip),
	};
}
