import { materialize, offered } from "./artifacts.mjs";
import { sharedBlockers } from "./blockers.mjs";
import { remainingAssignments } from "./capacity.mjs";
import { changedFrom, inconclusiveRepair, launcherFailure, missingInput, relinquishable } from "./evidence.mjs";
import { handoff, qualification } from "./handoff.mjs";
import { metricsFacts, timingFacts } from "./metrics.mjs";
import { scheduling, workerLimit } from "./policy.mjs";
import { ownershipMode } from "./transfer.mjs";
import { workspaceName } from "./workspace.mjs";
import { canDispatch } from "./native.mjs";
import { stalePins } from "./plan.mjs";
import { presentation } from "./reviews.mjs";
import { fail } from "./values.mjs";
import { nodeFact, pendingFact, visible } from "./visibility.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {Run} run @param {ReturnType<typeof visible>} view @param {unknown} detail */
function ownerStatus(run, { receipts, questions }, detail) {
	const last = run.products.at(-1);
	return {
		handoff: handoff(run, detail === "cleanup"),
		scheduling: scheduling(run),
		sharedBlockers: sharedBlockers(run, remainingAssignments(run)),
		...(run.deliveries?.length && {deliveries:run.deliveries.map(d=>({id:d.id,checkpoint:d.checkpoint,goal:d.goal,assembly:d.assembly,
			selected:d.selected.map(s=>({grain:s.prior.grain.id,original:s.prior.check,stop:s.prior.stop,reason:s.prior.reason,rerun:s.rerun,tree:s.tree})),
			checks:run.effects.flatMap(e=>e.tool==="bash" && e.delivery===d.id ? [{id:e.id,kind:e.kind,grain:e.grain,state:e.state,exit:receipts.get(e.id)?.exit}] : []),
			assessment:d.assessment,error:d.error}))}),
		...(detail === "proof" ? { qualification: qualification(run) } : {}),
		...(detail === "proof" ? { checkRecovery: run.effects.flatMap(e => {
			if (e.tool!=="bash") return [];
			const exit = launcherFailure(e);
			if (exit===undefined && !e.recheck && !e.rerun && !e.pair && !e.observer && !e.remedy && !(e.kind==="goal" && e.runnerClaim && e.receipt?.exit===null)) return [];
			return [{check:e.id,kind:e.kind,commit:e.commit,issuer:e.issuer,...(exit!==undefined && {launcherExit:exit}),
				...(e.pair && {pair:e.pair,originalReceipt:receipts.get(e.pair.failed),receipt:receipts.get(e.id)}),
				...(e.rerun && {rerun:e.rerun,...(!e.rerun.after && {originalReceipt:receipts.get(e.rerun.of)}),receipt:receipts.get(e.id)}),
				...(e.observer && {observer:e.observer,pairedReceipt:receipts.get(e.observer.pair),receipt:receipts.get(e.id)}),
				...(e.remedy && {repairWriter:e.remedy.writer,receipt:receipts.get(e.id)}),
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
		productPin:run.productRepins?.at(-1)?.revision ?? run.policy.base,
		productOwnership:ownershipMode(run),
		...(run.productRepins ? {productEvaluatorChanges:run.productRepins} : {}),
		...(run.repins || run.productRepins || run.goal && detail === "proof" ? { goalChecks: run.effects.filter(e => e.kind === "goal").map(e => ({
			id: e.id, commit: e.commit, evaluatorRevision: e.evaluatorRevision ?? run.policy.base, state: e.state,
			...(e.productEvaluatorRevision ? {productEvaluatorRevision:e.productEvaluatorRevision} : {}),
			...(e.state === "retired" ? { infrastructureFailure: { reason: "Runner failed before recording a verdict", ...e.retirement } } : {}), receipt: receipts.get(e.id) })) } : {}),
		questions: questions.map(({ review: r, observation, fact }) => {
			const claim = presentation(r);
			return { ...fact, squad: r.squad, base: r.base, evidence: observation.evidence,
				...(observation.ownerInput && claim ? { recovery: { run: run.id, review: r.id, presentation: claim } } : {}) };
		}),
		products: run.products.map(p => ({ ...p, receipt: receipts.get(p.check) })),
		candidate: run.join && { ...run.join, receipt: receipts.get(run.join.check) },
	};
}

/** @param {Run} run @param {string} actor @param {unknown} [detail] */
export function status(run, actor, detail) {
	if (detail !== undefined) {
		if (run.owner !== actor) fail("foreign_run", "Only the owner can request handoff details");
		if (detail !== "proof" && detail !== "cleanup" && detail !== "usage") fail("invalid_field", "Unknown status detail");
	}
	const view = visible(run, actor), { owner, nodes, pending, receipts, assignments } = view;
	const baselines = new Map(run.effects.flatMap(e => e.kind === "repair" && e.state === "done" && e.baseline ? [[e.token, e.baseline]] : []));
	const inspections = new Map(run.effects.flatMap(e => e.kind === "writer" && e.readGrant ? [[e.token, e.readGrant]] : []));
	const observers = new Map(run.effects.flatMap(e => e.kind==="writer" && e.observer ? [[e.token,e.observer]] : []));
	const producers = new Map(run.effects.flatMap(w=>w.kind==="writer" && w.production ? [[w.token,{diagnostic:w.production.diagnostic,task:w.production.task,files:w.production.files}]] : []));
	const corrections = new Map(run.effects.flatMap(e => e.kind === "scout" && e.correction && (owner || !e.correction.ordinary) ? [[e.id, e.correction]] : []));
	const reuse = new Map(run.effects.flatMap(e => e.kind === "writer" && e.reuse ? [[e.id, {
		assignment:e.id, candidate:e.reuse.predecessor.candidate, check:e.reuse.predecessor.check, worker:e.reuse.predecessor.worker,
		blob:e.reuse.blob, checkpoint:e.reuse.checkpoint, goal:e.reuse.goal
	}]] : []));
	return {
		...view.summary, contract: { commit: run.policy.base, path: run.policy.source, ...(run.policy.contractTarget && {targetPin:run.policy.contractTarget}) },
		limit: workerLimit(run) ?? null, ...(assignments ? { assignments } : {}), deadline: run.policy.deadline,
		...(owner ? ownerStatus(run, view, detail) : {}),
		artifacts: (run.artifacts ?? []).filter(a => owner || a.publisher === actor || nodes.some(n => offered(a, n))).map(a => ({ ...a, extract: materialize(a) })),
		artifactReports: run.effects.flatMap(e => e.kind === "component" && (owner || e.issuer === actor) && (e.usedArtifacts || e.comparedArtifacts)
			? [{ grain: e.grain, worker: e.issuer, candidate: e.commit, usedArtifacts: e.usedArtifacts, comparedArtifacts: e.comparedArtifacts }] : []),
		nodes: nodes.map(n => ({
			...nodeFact(n,view), ...(n.preview ? {preview: n.preview} : {}),
			...(observers.has(n.token) && {observer:observers.get(n.token)}),
			...(producers.has(n.token) && {production:producers.get(n.token)}),
			priorSource: n.priorSource, baseline: n.state === "writing" ? baselines.get(n.token) : undefined,
			...(n.state === "writing" && n.check && inconclusiveRepair(n, run.effects.find(e => e.id === n.check))
				? { cannotRepair: { check:n.check, action:"If the assignment permits no further repair, submit cannotRepair:{check,reason} with your current token instead of repeating the check." } } : {}),
			...(actor === n.worker && n.state === "writing" && relinquishable(run,n) ? {relinquish:{check:n.check}} : {}),
			readGrant: missingInput(n) !== undefined ? inspections.get(n.token) : undefined,
			...(actor === n.worker ? { token: n.token, changedFrom: n.state === "blocked" && !stalePins(run, n).length
				? changedFrom(n, run.effects.find(e => e.id === n.check)) : undefined } : {}),
			review: n.review, ...(n.review && corrections.has(n.review) ? { correction:corrections.get(n.review) } : {}),
			...(n.reuse ? {reuse:reuse.get(n.reuse)} : {}),
			...(owner && n.check ? {check:n.check} : {}),
			repairs: n.repairs, inputs: n.inputs, generation: n.generation,
			...(n.workspace ? {workspace:workspaceName(n.workspace)} : {}),
		})),
		pending: pending.map(pendingFact),
		prepared: pending.filter(e => e.issuer === actor && e.state === "ordinary" && !e.permissionHold && canDispatch(run, e)).map(e => ({ tool: e.tool, arguments: e.args })),
	};
}
