import { materialize, offered } from "./artifacts.mjs";
import { sharedBlockers } from "./blockers.mjs";
import { remainingAssignments } from "./capacity.mjs";
import { changedFrom, missingInput } from "./evidence.mjs";
import { handoff, qualification } from "./handoff.mjs";
import { metricsFacts, timingFacts } from "./metrics.mjs";
import { scheduling, workerLimit } from "./policy.mjs";
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
		...(detail === "proof" ? { qualification: qualification(run) } : {}),
		metrics: detail === "usage" ? metricsFacts(run) : timingFacts(run),
		...(run.pendingReviewNotes?.length ? { pendingReviewNotes: run.pendingReviewNotes.map(({ squad, receipt, question, excerpt }) => ({ squad, receipt, question, excerpt })) } : {}),
		target: last?.target, outputs: last?.outputs ?? {},
		...(run.repins ? { evaluatorChanges: run.repins } : {}),
		...(run.repins || run.goal && detail === "proof" ? { goalChecks: run.effects.filter(e => e.kind === "goal").map(e => ({
			id: e.id, commit: e.commit, evaluatorRevision: e.evaluatorRevision ?? run.policy.base, state: e.state,
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
	return {
		...view.summary, contract: { commit: run.policy.base, path: run.policy.source },
		limit: workerLimit(run) ?? null, ...(assignments ? { assignments } : {}), deadline: run.policy.deadline,
		...(owner ? ownerStatus(run, view, detail) : {}),
		artifacts: (run.artifacts ?? []).filter(a => owner || a.publisher === actor || nodes.some(n => offered(a, n))).map(a => ({ ...a, extract: materialize(a) })),
		artifactReports: run.effects.flatMap(e => e.kind === "component" && (owner || e.issuer === actor) && (e.usedArtifacts || e.comparedArtifacts)
			? [{ grain: e.grain, worker: e.issuer, candidate: e.commit, usedArtifacts: e.usedArtifacts, comparedArtifacts: e.comparedArtifacts }] : []),
		nodes: nodes.map(n => ({
			...nodeFact(n, receipts), ...(n.preview ? {preview: n.preview} : {}),
			priorSource: n.priorSource, baseline: n.state === "writing" ? baselines.get(n.token) : undefined,
			readGrant: missingInput(n) !== undefined ? inspections.get(n.token) : undefined,
			...(actor === n.worker ? { token: n.token, changedFrom: n.state === "blocked" && !stalePins(run, n).length
				? changedFrom(n, run.effects.find(e => e.id === n.check)) : undefined } : {}),
			review: n.review, repairs: n.repairs, inputs: n.inputs, generation: n.generation,
		})),
		pending: pending.map(pendingFact),
		prepared: pending.filter(e => e.issuer === actor && e.state === "ordinary" && !e.permissionHold && canDispatch(run, e)).map(e => ({ tool: e.tool, arguments: e.args })),
	};
}
