import { digest } from "./values.mjs";
import { assign } from "./assignment.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {Run} run */
export const productPin = run => run.productRepins?.at(-1)?.revision;
/** An amendment has its own check; the original target approval never changes.
 * @param {import("./model.js").ProductPin|undefined} pin */
export const verification=pin=>pin?.amendments?.at(-1)?.recheck??pin?.recheck;
/** @param {Run} run @param {string} check */
export const mixedVerification=(run,check)=>run.productRepins?.find(p=>p.targetFrom && (p.recheck===check || p.amendments?.some(a=>a.recheck===check)));
/** Only an intact export and a completed component exit 1 can identify the failing observation.
 * The outer null is not a product failure, and the component's grant does not identify a faulty path.
 * @param {import("./model.js").Effect|undefined} e */
export function failedComponent(e){
	if(e?.kind!=="product" || !e.runnerClaim)return;
	const receipt=checkReceipt(e);
	if(receipt?.exit!==null || !receipt.components)return;
	const observed=Object.entries(receipt.components),last=observed.pop();
	if(last?.[1].exit===1 && observed.every(([,c])=>c.exit===0))return last[0];
}
/** @typedef {Pick<import("./model.js").Effect,"evaluatorRevision"|"productEvaluatorRevision">} Evaluation */
/** @param {Evaluation} a @param {Evaluation} b */
export const sameEvaluation = (a,b) => a.evaluatorRevision === b.evaluatorRevision && a.productEvaluatorRevision === b.productEvaluatorRevision;
/** Current goal/scout generation. Product checks have their own executable pin.
 * @param {Run} run @param {Evaluation|undefined} e */
export const currentEvaluation = (run,e) => !!e && e.evaluatorRevision === run.repins?.at(-1)?.revision && e.productEvaluatorRevision === productPin(run);

const missingPrefix = "Writer reports missing input: ";
/** @param {import("./model.js").Node} n @param {string} detail */
export function stopForInput(n, detail) {
	assign(n,{type:"stop",reason:missingPrefix+detail});
	n.stop = { kind: "writer-missing-input", detail };
}

/** Return the unmodified original detail; older snapshots recorded only the display reason.
 * @param {import("./model.js").Node} n */
export function missingInput(n) {
	if (n.state !== "blocked") return;
	if (n.stop) return n.stop.kind === "writer-missing-input" ? n.stop.detail : undefined;
	if (n.reason?.startsWith(missingPrefix)) return n.reason.slice(missingPrefix.length);
}

/** Native shell completion is not evidence. Only the runner can attest to its pinned input.
 * @param {import("./model.js").Effect|undefined} e */
export function checkReceipt(e) {
	if (e?.tool === "bash" && e.runnerStarted && e.state === "done" && e.receipt &&
		e.receipt.commit === e.commit && e.receipt.check === e.check && sameEvaluation(e.receipt,e)) return e.receipt;
}

/** Older readers recorded this exact terminal transition as a ledger diagnostic rather
 * than a numeric field. It was never produced by an uncertain call or by the evaluator.
 * @param {import("./model.js").Effect|undefined} e */
export function launcherFailure(e) {
	if (e?.tool !== "bash" || !e.callId || e.state !== "done" || e.runnerStarted || e.runnerClaim || e.receipt ||
		e.args.shellId !== `foundry-${e.id}` || e.permissionHold) return;
	const legacy = /^Check launcher exited ([1-9]\d*) before the evaluator started; no check result\. Verify Node\.js with node:sqlite is on the shell PATH\.$/.exec(e.error ?? "");
	const exit = e.launcherExit ?? (legacy && Number(legacy[1]));
	if (typeof exit === "number" && Number.isSafeInteger(exit) && exit > 0) return exit;
}

/** The issued inline token binds this repair to one completed, inconclusive component attempt.
 * @param {import("./model.js").Node} n @param {import("./model.js").Effect|undefined} e */
export function inconclusiveRepair(n, e) {
	if (!n.token || !n.worker || !n.generation || !n.repairs || e?.kind !== "component" || e.id !== n.check ||
		e.inlineRepair !== n.token || e.issuer !== n.worker || e.grain !== n.grain.id || e.check !== n.grain.check ||
		!e.callId || e.error || e.permissionHold) return;
	const r = checkReceipt(e);
	if (r?.exit === 2 && !r.failure) return r;
}

/** The binding authorizes giving up this repair, never reinterpreting its check.
 * @param {Run} run @param {import("./model.js").Node} n */
export function relinquishable(run, n) {
	if (!n.worker || !n.token || !n.generation || !n.repairs || !n.check || n.reuse) return;
	const calls = run.effects.filter(e => e.grain === n.grain.id);
	const check = calls.findLast(e => e.kind === "component" && !e.delivery);
	if (check?.kind !== "component" || check.id !== n.check || check.issuer !== n.worker || check.check !== n.grain.check ||
		!check.callId || !check.runnerClaim || check.error || check.permissionHold || inconclusiveRepair(n,check)) return;
	const receipt = checkReceipt(check);
	if (!receipt || receipt.exit === null || receipt.exit <= 0 || receipt.failure) return;
	const writers = calls.filter(e => e.kind === "writer" && e.state !== "withdrawn");
	const [writer] = writers;
	if (writers.length !== 1 || writer?.kind !== "writer" || !writer.callId || writer.state !== "done" || writer.error ||
		writer.nativeId !== n.worker || generationOf(writer) !== n.generation || writer.token === n.token) return;
	const notices = calls.filter(e => e.kind === "repair" && e.token === n.token);
	if (check.inlineRepair) {
		if (check.inlineRepair !== n.token || notices.length) return;
	} else {
		const [delivery] = notices;
		if (notices.length !== 1 || !delivery.callId || delivery.state !== "done" || delivery.error || delivery.permissionHold ||
			(delivery.tool === "session.send" ? delivery.issuer : delivery.args.session_id) !== n.worker ||
			calls.indexOf(delivery) < calls.indexOf(check)) return;
	}
	return check;
}

/** A private detail in the owning charter's packet, never a checked dependency.
 * @param {import("./model.js").Node} n */
export function repairDetail(n) {
	if (n.state === "blocked" && n.stop?.kind === "writer-cannot-repair" && n.check && n.candidate)
		return digest(["stopped-repair", n.grain.id, n.check, n.candidate, n.stop.detail]);
}

/** A prior reader's *terminal* component attempt, not a verdict about what caused it.
 * @param {import("./model.js").Node} n @param {import("./model.js").Effect|undefined} e */
export function blockedComponent(n, e) {
	if (e?.kind==="component" && e.observer) return;
	const receipt = checkReceipt(e);
	if (n.state === "blocked" && e?.kind === "component" && e.id === n.check && e.grain === n.grain.id &&
		e.check === n.grain.check && e.issuer === n.worker && e.callId && !e.error && !e.inlineRepair &&
		receipt?.exit === null && receipt.commit === n.candidate &&
		(receipt.failure === "changed-export" || !receipt.failure && n.reason === `Evaluation did not complete: ${receipt.output}`)) return receipt;
}

/** @param {import("./model.js").Node} n @param {import("./model.js").Effect|undefined} e */
export function changedFrom(n, e) {
	const receipt = blockedComponent(n, e);
	if (receipt && !receipt.failure) return receipt.commit;
}

/** @param {import("./model.js").Effect|undefined} w */
export const generationOf = w => w?.kind === "writer" ? w.pooled?.generation ?? w.args.base_branch : undefined;

/** @param {Run} run @param {import("./model.js").Node} n */
export function failedCandidate(run, n) {
	const e = run.effects.find(e => e.id === n.check), r = checkReceipt(e);
	return !!n.worker && !!n.generation && !!n.token && !!n.base && !!n.candidate &&
		e?.kind === "component" && !e.observer && e.grain === n.grain.id && e.issuer === n.worker && e.check === n.grain.check &&
		!!e.callId && !e.error && !e.inlineRepair && !e.permissionHold && r?.exit === 1 && r.commit === n.candidate &&
		run.effects.some(w => w.kind === "writer" && w.grain === n.grain.id && w.state === "done" && !!w.callId &&
			w.nativeId === n.worker && generationOf(w) === n.generation);
}

/** @param {Run} run @param {import("./model.js").Node} n */
export function exhaustedCandidate(run, n) {
	return n.state === "blocked" && !n.reuse && !n.stop && n.repairs === run.policy.repairs && failedCandidate(run, n);
}

/** @param {Run} run @param {import("./model.js").Node} n */
export function baselineNotice(run, n) {
	const e = run.effects.findLast(e => e.kind === "repair" && e.token === n.token && e.grain === n.grain.id);
	return e?.kind === "repair" && e.baseline ? e : undefined;
}

/** @param {Run} run */
export function goalReceipt(run) {
	const at = run.goal;
	const e = at && run.effects.find(e => e.id === at.check);
	if (e?.kind === "goal" && e.commit === at?.commit && e.check === run.policy.goalCheck &&
		currentEvaluation(run,e)) return checkReceipt(e);
}

/** @param {import("./model.js").DiscoveryLead|undefined} lead */
export const leadGoal = lead => lead?.pending ?? lead?.missing;

/** @param {import("./model.js").Review["iteration"]} comparison */
export const comparisonGoal = comparison => comparison?.source?.goal ?? comparison?.historical?.missing;

/** @param {number|null|undefined} exit @param {import("./model.js").Successor|undefined} successor */
export const comparisonVerdict = (exit,successor) => exit===2 || !!successor && exit===1;

/** Only consecutive goal observations on identical bytes. A missing step identifier is
 * reason to compare both receipts, never proof the old failure still exists.
 * @param {Run} run @param {import("./model.js").HistoricalStep & {missing:string}} h
 * @param {string} base @param {string|undefined} pin @param {string|undefined} productRevision */
export function omittedStep(run, h, base, pin, productRevision) {
	const at = run.effects.findIndex(e => e.id === h.missing);
	const missing = run.effects[at], prior = run.effects.slice(0, at).findLast(e => e.kind === "goal");
	if (!/^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u.test(h.step) ||
		missing?.kind !== "goal" || missing.check !== run.policy.goalCheck || missing.commit !== base || missing.evaluatorRevision !== pin || missing.productEvaluatorRevision !== productRevision ||
		prior?.id !== h.receipt || prior.check !== missing.check || prior.commit !== base || prior.productEvaluatorRevision !== missing.productEvaluatorRevision) return false;
	const before = checkReceipt(prior), now = checkReceipt(missing);
	return before?.exit === 1 && now?.exit === 2 && before.output.includes(h.step) && !now.output.includes(h.step);
}

/** A terminal product check holds only its own candidate, not the goal on the assessed base.
 * @param {Run} run */
export function milestoneBlocker(run) {
	const e = run.join && run.effects.find(e => e.id === run.join?.check);
	if (e?.kind === "product" && (e.state === "done" || e.state === "refused")) return e.error;
}

/** @param {Run} run */
export function missingObservation(run) {
	const receipt = goalReceipt(run);
	if (!run.blocker && receipt?.exit === 2 && (!run.join || milestoneBlocker(run))) return receipt;
}

/** A goal milestone doesn't qualify until both exact receipts are applied to this product.
 * @param {Run} run */
export function qualifiedProduct(run) {
	if (run.independent) return;
	const last = run.products.at(-1);
	return last?.qualifiedAt ? last : undefined;
}

/** Project the runner verdict, not native IDs, command arguments or evaluator output.
 * @param {import("./model.js").Effect|undefined} e @param {"product"|"goal"|"component"} kind
 * @param {string} commit @param {string} check @param {string} [grain] */
export function passingReceipt(e, kind, commit, check, grain) {
	if (e?.kind === kind && e.grain === grain && e.commit === commit && e.check === check && checkReceipt(e)?.exit === 0)
		return { commit, check, exit: 0, ...(e.evaluatorRevision ? { evaluatorRevision: e.evaluatorRevision } : {}),
			...(kind==="product" && e.receipt?.components && {components:e.receipt.components}),
			...(e.productEvaluatorRevision ? { productEvaluatorRevision:e.productEvaluatorRevision } : {}) };
}

/** A milestone is authority for the reviewed inputs, never a goal verdict.
 * @param {Run} run @param {string} id @param {string} base */
export function checkpointReceipt(run, id, base) {
	return productReceiptAt(run,id,base,productPin(run));
}

/** Validate historical references against the generation of their consumer, not today's pin.
 * @param {Run} run @param {string} id @param {string} base @param {string|undefined} pin */
export function productReceiptAt(run,id,base,pin) {
	const e = run.effects.find(e => e.id === id);
	return run.products.some(p => p.check === id && p.commit === base) &&
		e?.evaluatorRevision === pin && passingReceipt(e, "product", base, run.policy.productCheck);
}

/** The last *applied* product. A native success, a pending join, or two green checks
 * from different assessments do not make a goal handoff.
 * @param {Run} run */
export function acceptedChecks(run) {
	const last = qualifiedProduct(run);
	if (!last) return;
	const { productCheck, goalCheck } = run.policy;
	const product = checkpointReceipt(run,last.check,last.commit);
	if (!product) return;
	if (!goalCheck && !run.goal) return { last, product };
	if (!goalCheck || goalCheck === productCheck || run.active || run.join || run.blocker || run.conflict ||
		run.goal?.commit !== last.commit || run.goal.target !== last.target || run.goal.stall) return;
	const goal = passingReceipt(run.effects.find(e => e.id === run.goal?.check), "goal", last.commit, goalCheck);
	if (goal && goalReceipt(run)?.exit === 0) return { last, product, goal };
}
