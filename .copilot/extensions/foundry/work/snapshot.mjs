import { planDirectory, productOverlayPaths, validOutcome } from "./contract.mjs";
import { correctionBasis, revisedTask } from "./amendment.mjs";
import { validSignals } from "./signals.mjs";
import { checkpointReceipt, checkReceipt, comparisonVerdict, exhaustedCandidate, generationOf, goalReceipt, inconclusiveRepair, launcherFailure, missingInput, omittedStep, productReceiptAt, relinquishable, sameEvaluation } from "./evidence.mjs";
import { validFeedback } from "./feedback.mjs";
import { validLead } from "./leads.mjs";
import { attachedNotes, noteId, noteText, sourceReceipt } from "./notes.mjs";
import { deliveredFile, indexBudgetError, rejectedSource, validMatch } from "./pages.mjs";
import { assignmentCount } from "./capacity.mjs";
import { unissued } from "./reservation.mjs";
import { candidateHandoff, checked, owns, validateNodes } from "./plan.mjs";
import { outside } from "./product.mjs";
import { comparison, investigation, readerInterrupted, successorDirectory } from "./reviews.mjs";
import { assignmentDirectory, comparisonScope, contains, covers, digest, fail, members, mixed, ownership, relative, sameScope, roots as scopePaths } from "./values.mjs";
import { productOwnership, retainedMode, understandsTransfers } from "./transfer.mjs";
import { narrower, stoppedCheck } from "./successor.mjs";
import { historicalGrant, observerInput, restoredProduct, validRestoration } from "./partition.mjs";
import { validIsolation } from "./isolation.mjs";
import { validRemedy } from "./remedy.mjs";
import { validDeliveries } from "./batch.mjs";
import { resolutions } from "./resolution.mjs";
import { assignment } from "./assignment.mjs";
import { call, review as discovery } from "./dispatch.mjs";

/** @typedef {(value:unknown)=>boolean} Guard */
/** @type {Guard} */
const string = value => typeof value === "string";
/** @type {Guard} */
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !Object.hasOwn(Object.prototype, value);
/** @type {Guard} */
const commit = value => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
/** @type {Guard} */
const path = value => typeof value === "string" && relative(value) === value;
/** @type {Guard} */
const count = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** @type {Guard} */
const positive = v => count(v) && v !== 0;
/** @type {Guard} */
const bool = value => typeof value === "boolean";
/** @param {unknown} v @returns {v is Record<string,unknown>} */
const object = v => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {...string} states @returns {Guard} */
const one = (...states) => v => typeof v === "string" && states.includes(v);
/** @param {Guard} guard @returns {Guard} */
const optional = guard => v => v === undefined || guard(v);
/** @param {Guard} guard @returns {Guard} */
const list = guard => v => Array.isArray(v) && v.every(guard);
/** @param {Guard} guard @returns {Guard} */
const named = guard => v => object(v) && Object.entries(v).every(([k, item]) => id(k) && guard(item));
/** @param {Record<string,Guard>} fields @returns {Guard} */
const shape = fields => v => object(v) && Object.entries(fields).every(([key, guard]) => guard(v[key]));
/** @type {Guard} */
const scope = v => path(v) || Array.isArray(v) && v.length > 1 && v.every((dir,i)=>path(dir) && (!i || v[i-1] < dir)) ||
	object(v) && path(v.primary) && Array.isArray(v.files) && v.files.length > 0 && digest(v) === digest(assignmentDirectory(v).directory);
const baseline = shape({directory:path,revision:commit,tree:commit});
/** @type {Guard} */
const inventory = v => baseline(v) || Array.isArray(v) && v.length>0 && v.every(baseline);
const output = { id, directory: scope, revision: optional(commit), check: path, needs: list(id),
	prior:optional(v=>one("independent","unavailable")(v) || shape({clause:noteText})(v)) };
const grain = shape({ ...output, specification: path, boundary: list(path), task: optional(string), agent: optional(string) });
const proposal = shape({ ...output, task: string });
const charter = { id, charter: path, agent: optional(string) };
const fixed = shape({ ...charter, grains: list(id) });
const area = shape({ ...charter, areas: list(path), boundary: list(path), checks: list(path), researchAgent: optional(id) });
const policy = shape({
	id, direction: string, target: string, source: path, sharedBrief: optional(path), base: commit, contractTarget:optional(commit), productCheck: path, ownership:optional(one("exact-files",retainedMode)), goalCheck: optional(path), files: list(path),
	squads: list(s => object(s) && ("areas" in s ? !("grains" in s) && area(s) : fixed(s))),
	workers: optional(positive), assignments: optional(count), repairs: count, deadline: optional(string), seed: optional(list(id))
});
/** @type {Guard} */
const observation = v => object(v) && string(v.reason) && Array.isArray(v.evidence) && v.evidence.length > 0 && v.evidence.every(path) &&
	Array.isArray(v.grains) && v.grains.every(g => id(g) || proposal(g)) && validOutcome(v.outcome, v.grains.length) &&
	(v.ownerInput === undefined || v.outcome === "needs-decision" && one("product-choice", "external-action")(v.ownerInput)) &&
	(v.references === undefined || Array.isArray(v.findings) && list(shape({ repo: id, revision: commit }))(v.references)) &&
	(v.findings === undefined ? v.outcome !== "researched" : (v.outcome === "researched" || v.outcome === "needs-decision" || v.outcome === "unresolved" || v.outcome === "waiting") &&
		list(shape({ kind: string, source: string, finding: string }))(v.findings) && (v.outcome !== "researched" || Array.isArray(v.findings) && v.findings.length > 0)) &&
	(v.outcome === "waiting" ? id(v.waitFor) || typeof v.waitFor === "string" && v.waitFor.startsWith("reference:") && id(v.waitFor.slice(10)) : v.waitFor === undefined) &&
	[v.file, v.receipt, v.detail].filter(k => k !== undefined).length === Number(v.outcome === "needs-evidence") &&
	optional(path)(v.file) && optional(id)(v.receipt) && optional(id)(v.detail) &&
	(v.offset === undefined || v.outcome === "needs-evidence" && count(v.offset)) &&
	(v.match === undefined || v.outcome === "needs-evidence" && validMatch(v.match)) &&
	(v.addresses === undefined || Array.isArray(v.addresses) && v.addresses.length > 0 &&
		v.addresses.every(shape({ id, grain: id, worker: optional(noteText) })) &&
		new Set(v.addresses.map(a => a.id)).size === v.addresses.length) &&
	(v.replace === undefined || v.outcome === "regenerate" && list(id)(v.replace));
/** @param {unknown} v @returns {v is import("./model.js").Packet} */
export const isPacket = v => object(v) && id(v.review) && commit(v.base) && bool(v.partial) && object(v.files) &&
	(v.sources === undefined || Array.isArray(v.sources) && v.sources.every(s => typeof s === "string" &&
		(s.startsWith("receipt:") && id(s.slice(8)) || s.startsWith("detail:") && commit(s.slice(7))))) &&
	(v.read === undefined || v.partial === true && object(v.read) && typeof v.read.source === "string" &&
		[v.read.start, v.read.end, v.read.length].every(count) && Number(v.read.end) <= Number(v.read.length) &&
		(v.read.hit === undefined || count(v.read.hit) && Number(v.read.start) <= Number(v.read.hit) && Number(v.read.hit) < Number(v.read.end)) &&
		(v.read.miss === true ? v.read.start === v.read.end && v.read.hit === undefined : v.read.miss === undefined && Number(v.read.start) < Number(v.read.end)) &&
		(v.read.source.startsWith("file:") ? path(v.read.source.slice(5)) && (v.read.miss === true || object(v.excerpt) &&
			v.read.source.slice(5) === v.excerpt.path && v.excerpt.start === v.read.start && v.excerpt.end === v.read.end && v.excerpt.length === v.read.length) :
			Array.isArray(v.sources) && v.sources.includes(v.read.source))) &&
	(v.excerpt === undefined || v.partial === true && object(v.excerpt) && path(v.excerpt.path) && commit(v.excerpt.oid) &&
		[v.excerpt.start, v.excerpt.end, v.excerpt.length].every(count) && Number(v.excerpt.start) < Number(v.excerpt.end) &&
		Number(v.excerpt.end) <= Number(v.excerpt.length) && !Object.hasOwn(v.files, String(v.excerpt.path))) &&
	Object.entries(v.files).every(([p, oid]) => path(p) && commit(oid)) && named(commit)(v.outputs);
/** @type {Guard} */
const decision = v => object(v) && (v.status === "presenting" && optional(id)(v.presentation) || v.status === "dismissed" ||
	v.status === "answered" && string(v.answer) ||
	v.status === "unavailable" && string(v.reason) && optional(id)(v.presentation));
const restoration=shape({from:id,historical:id,checkpoint:id,goal:id,retainer:id,tree:commit});
const nodeShape = shape({
	retained: optional(list(shape({review:id,to:id,primary:path,files:list(path)}))),
	successor: optional(shape({review:id,to:id,directory:scope})),
	restoration: optional(restoration),
	grain, review: optional(id), state: one(...Object.keys(assignment.states)), token: optional(id), worker: optional(string),
	generation: optional(commit), inputs: optional(named(commit)), base: optional(commit), replaces: optional(commit), candidate: optional(commit), check: optional(id),
	supporting: optional(list(path)), excluded: optional(v => shape({path,revision:commit})(v) || shape({grain:id,revision:commit})(v)),
	priorSource: optional(inventory), reuse: optional(id), workspace: optional(id),
	repairs: count, reason: optional(string), artifactCursor: optional(count), preview: optional(commit),
	stop: optional(shape({kind: one("writer-missing-input","writer-cannot-repair","writer-relinquished"), detail: noteText}))
});
/** @type {Guard} */
const node = n => nodeShape(n) && object(n) && (n.excluded === undefined || n.state === "blocked") && (n.stop === undefined ||
	n.state === "blocked" && !!n.worker && !!n.token && !!n.generation);
const assessment = { target: commit, commit, check: id };
const paths=shape({directories:list(path),files:list(path)});
const scopes=named(v=>object(v) && paths(v) && optional(paths)(v.exclude));
const product = shape({ ...assessment, outputs: named(commit), ownership:optional(scopes), qualifiedAt: optional(positive) });
const proofNotes=list(shape({file:path,blob:commit,excerpt:string,inventory:shape({file:path,keys:list(string),blob:commit}),inputs:list(path),reason:string}));
/** @type {Guard} */
const sha256=v=>typeof v==="string" && /^[0-9a-f]{64}$/.test(v);
const subset=shape({observer:id,checkpoint:id,goal:id,target:commit,assembly:commit,basis:sha256,ownership:scopes,
	hold:shape({historical:id,grain:id,original:id,pair:id,retainer:id,candidate:commit,component:id}),
	selected:list(shape({grain:id,candidate:commit,component:id})),
	evidence:list(shape({component:id,commit,stages:shape({component:proofNotes,generated:proofNotes,package:proofNotes,runtime:proofNotes})})),
	product:id,assessment:optional(id)});
const receipt = shape({ commit, check: path, completedAt:optional(positive), evaluatorRevision: optional(commit), productEvaluatorRevision:optional(commit), exit: v => v === null || count(v), output: string,
	components:optional(named(shape({check:path,exit:v=>v===null || count(v)}))), resolutionDigest:optional(sha256),
	failure: optional(one("changed-export", "incomplete")), repair: optional(id), squad: optional(id), blockers: optional(validSignals), feedback: optional(validFeedback),
	feedbackFile: optional(shape({ blob: commit, legacy: optional(bool) })) });
const dispatch = { id, issuer: string, args: object, evaluatorRevision: optional(commit), productEvaluatorRevision:optional(commit), callId: optional(string), error: optional(string), permissionHold: optional(string) };
const noteFields = { receipt: id, question: noteText, excerpt: optional(noteText) };
const scout = shape({ ...dispatch, kind: one("scout"), tool: one("workflow"), squad: id, base: commit, version: string,
	state: one(...Object.keys(discovery.states)), observation: optional(observation),
	deferred: optional(shape({ pins: v => named(commit)(v) && object(v) && Object.keys(v).length > 0,
		consumers: v => Array.isArray(v) && v.length > 0 && v.every(id) && new Set(v).size === v.length })),
	workflowId: optional(string), providerRecovery:optional(one("needed","claimed")), decision: optional(decision), packet: optional(isPacket), retryOf: optional(id), retrySource: optional(commit), note: optional(shape(noteFields)),
	lead: optional(v => object(v) && id(v.receipt) && id(v.checkpoint) && optional(id)(v.priorReview) &&
		(v.pending === undefined ? id(v.missing) : v.missing === undefined && id(v.pending))),
	iteration: optional(shape({receipt: id, directory: path, files:optional(list(path)), blob: commit, question: noteText, basis: optional(one("checkpoint")),
		transfer:optional(shape({from:id,candidate:commit,to:id})),successor:optional(shape({from:id,check:id,to:id})),historical: optional(shape({receipt:id, missing:id, step:noteText})), source: optional(shape({goal:id,commit,file:path,excerpt:noteText})),follow:optional(v=>v===true)})), predecessor: optional(node),
	renewal:optional(shape({checkpoint:id,goal:id,state:one("needed","presenting","approved","held","closed"),reason:optional(noteText)})),
	correction: optional(shape({ worker: noteText, clause: noteText, file: path, excerpt: noteText, blob: optional(commit), predecessorCheck: optional(id),
		ordinary:optional(v=>v===true),resumed:optional(shape({prior:node,token:id})) })),
	otherNotes: optional(list(shape(noteFields))), diagnostic: optional(shape({ receipt: id, excerpt: noteText })), wake: optional(shape({ review: id, key: string })) });
const native = shape({
	delivery:optional(sha256),
	rerun:optional(shape({of:id,checkpoint:id,candidate:commit,directory:scope,harness:list(path),current:list(path),after:optional(id),observedTarget:optional(commit)})),
	production:optional(shape({diagnostic:id,candidate:commit,checkpoint:id,goal:id,files:list(path),task:noteText,prior:node})),
	remedy:optional(shape({writer:id,basis:sha256})),
	isolation:optional(sha256),
	observer:optional(shape({pair:id,file:path,before:commit,after:optional(commit),previous:optional(shape({check:id,candidate:commit,
		phases:v=>Array.isArray(v) && v.length>=2 && v.length<=8 && new Set(v).size===v.length && v.every(p=>typeof p==="string" && p.trim()===p && p.length>0 && p.length<=120 && !/[\0\r\n]/.test(p))}))})),
	restoration:optional(restoration),
	pair:optional(shape({failed:id,component:id,candidate:commit,retainer:id,checkpoint:id,goal:id,target:commit,tree:commit})),
	...dispatch, kind: one("writer", "component", "rerun", "product", "goal", "repair", "decision", "handoff", "artifact", "escalation"), grain: optional(id), inlineRepair: optional(id),
	usedArtifacts: optional(list(commit)), comparedArtifacts: optional(list(commit)),
	reuse: optional(shape({predecessor:node, blob:commit, checkpoint:id, goal:id})),
	finished: optional(shape({squad:id,directory:scope,component:id,product:id})),
	pooled: optional(shape({from:id,home:v=>typeof v==="string" && v.startsWith("/") && !v.includes("\0"),generation:commit})),
	baseline: optional(inventory),
	readGrant: optional(inventory),
	claims: optional(list(shape({ actor: string, path: string, start: string, kickoff: string, identity: string }))), claimedRequest: optional(string),
	retirement: optional(shape({ notification: id, read: id, completion: id })),
	token: optional(id), tool: one("create_session", "bash", "send_session_message", "session.send"), state: one(...Object.keys(call.states)),
	nativeId: optional(string), boundAt: optional(positive), commit: optional(commit), check: optional(path),
	launcherExit: optional(positive), recheck: optional(shape({ of:id, target:commit, goalPin:commit, productPin:commit })),
	runnerStarted: optional(bool), runnerClaim: optional(v => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v)), receipt: optional(receipt)
});
const snapshot = shape({
	deliveries:optional(list(shape({id:sha256,checkpoint:id,goal:id,assembly:commit,selected:list(shape({rerun:id,tree:commit,prior:node})),assessment:optional(id),error:optional(string)}))),
	independent:optional(subset),
	id, owner: string, policy, references: optional(named(commit)),
	scheduling: optional(shape({ revision: positive, workers: optional(positive), checkpointReviews: bool })),
	repins: optional(list(shape({ from: commit, revision: commit, files: list(path) }))),
	productRepins: optional(list(shape({ from:commit, revision:commit, files:list(path), checkpoint:id, goal:id, recheck:id, ownership:optional(one(retainedMode)), targetFrom:optional(commit),acceptance:optional(noteText),resolutions:optional(v=>resolutions(v).length>0) }))),
	artifacts: optional(list(shape({ file: path, blob: commit, base: commit, publisher: string, to: list(path) }))),
	pendingReviewNotes: optional(list(shape({ ...noteFields, squad: id, after: count }))),
	attributions: optional(list(shape({ receipt: id, id, directory: path, blocked: positive, excerpt: noteText }))),
	active: bool, activatedAt: positive, pauseReason: optional(string), policyHold:optional(shape({issuer:string,effect:id,token:id})), nodes: named(node), effects: list(v => scout(v) || native(v)),
	products: list(product), join: optional(product), goal: optional(shape({ ...assessment, stall: optional(string),
		tried: optional(list(v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v))) })),
	blocker: optional(string), conflict: optional(string), discoveryError: optional(string)
});

/** @param {unknown} value @returns {value is import("./model.js").Run} */
function isRun(value) { return snapshot(value); }

/** Each approval starts at its own recheck reservation, never at the beginning of history.
 * @param {import("./model.js").Run} run @param {Map<string,import("./model.js").Product>} products */
function productLineage(run,products) {
	const pins = run.productRepins ?? [];
	if (run.policy.contractTarget!==pins.findLast(p=>p.targetFrom)?.revision) return false;
	if (!pins.length) return !run.effects.some(e=>e.productEvaluatorRevision || e.kind === "product" && e.evaluatorRevision);
	if (!run.goal || products.size !== run.products.length || new Set([run.policy.base,...pins.map(p=>p.revision)]).size !== pins.length+1) return false;
	let next = 0, applied = 0;
	let retained=run.policy.ownership===retainedMode;
	/** @type {string|undefined} */ let pin;
	/** @type {import("./model.js").Effect|undefined} */ let lastGoal;
	/** @type {import("./model.js").Product|undefined} */ let needsGoal;
	const captures=pins.some(p=>p.targetFrom) ? new Map() : undefined;
	for (const e of run.effects) {
		if (captures && e.kind==="component" && checkReceipt(e)?.exit===0) captures.set(`${e.grain}@${e.commit}`,e.check);
		const p = pins[next];
		if (e.id === p?.recheck) {
			const prior = run.products[applied-1], after = products.get(e.id) ?? (run.join?.check === e.id ? run.join : undefined);
			if (needsGoal || !prior || prior.check !== p.checkpoint || lastGoal?.id !== p.goal || lastGoal.commit !== prior.commit ||
				lastGoal.check !== run.policy.goalCheck || ![1,2].includes(checkReceipt(lastGoal)?.exit ?? -1) ||
				e.kind !== "product" || e.issuer !== run.owner || !after || after.commit!==e.commit || p.from !== (pin ?? run.policy.base) ||
				!p.files.length || new Set(p.files).size !== p.files.length) return false;
			if (!!p.targetFrom!==!!p.acceptance || p.resolutions && (!p.targetFrom || p.resolutions.some(r=>!outside(r.file,[".foundry",...run.policy.files])))) return false;
			if (p.targetFrom) {
				const g=run.repins?.find(g=>g.revision===p.revision);
				if (retained!==(p.ownership===retainedMode) || !g || digest(g.files)!==digest(p.files) || g.from!==(lastGoal.evaluatorRevision ?? run.policy.base) ||
					p.files.includes(run.policy.source) || !p.files.every(f=>f.startsWith(".foundry/") || run.policy.files.includes(f)) ||
					p.targetFrom!==(pins.slice(0,next).findLast(q=>q.targetFrom)?.revision ?? run.policy.base) ||
					after.target!==p.revision || after.target===prior.target || after.commit===prior.commit) return false;
				if (e.receipt) {
					const map=e.receipt.components;
					if (e.receipt.resolutionDigest!==(p.resolutions && digest(p.resolutions)) ||
						!map || Object.entries(map).some(([id,c])=>!Object.hasOwn(after.outputs,id) || captures?.get(`${id}@${after.outputs[id]}`)!==c.check) ||
						e.receipt.exit===0 && (Object.keys(map).length!==Object.keys(after.outputs).length || Object.values(map).some(c=>c.exit!==0))) return false;
				}
			} else if (e.commit!==prior.commit || after.target!==prior.target || digest(after.outputs)!==digest(prior.outputs) || !productOverlayPaths(run,p.files)) return false;
			retained=p.ownership===retainedMode;
			pin = p.revision;
			next++;
			needsGoal = after;
		} else if (needsGoal) {
			if (e.kind === "goal") {
				if (!products.has(needsGoal.check) || e.commit !== needsGoal.commit || e.check !== run.policy.goalCheck) return false;
				needsGoal = undefined;
			} else if (["product","component","writer","repair","scout"].includes(e.kind)) return false;
		}
		if (e.kind === "product" && e.evaluatorRevision !== pin ||
			e.productEvaluatorRevision !== (e.kind === "goal" || e.kind === "scout" ? pin : undefined)) return false;
		if (e.kind === "goal") lastGoal = e;
		if (products.has(e.id) && run.products[applied++]?.check !== e.id) return false;
	}
	return next === pins.length && applied === products.size && lastGoal?.id === run.goal.check &&
		(!run.join || !products.has(run.join.check));
}

/** @param {import("./model.js").Run} run @param {import("./model.js").Effect} e
 * @param {Map<string,import("./model.js").Effect>} effects @param {Map<string,import("./model.js").Product>} products */
function validDispatch(run, e, effects, products) {
	if ((e.receipt?.components || e.receipt?.resolutionDigest) && !(e.kind==="product" && run.productRepins?.some(p=>p.targetFrom && p.recheck===e.id))) return false;
	if (e.tool!=="workflow") {
		if (e.kind==="rerun" || e.rerun) {
			const pin=e.rerun;
			if (e.kind!=="rerun" || !pin || e.issuer!==run.owner || e.tool!=="bash" || e.recheck || e.pair || e.observer || e.remedy || e.isolation ||
				e.evaluatorRevision || e.productEvaluatorRevision || e.token || e.inlineRepair || e.receipt?.repair) return false;
			const prior=run.effects.slice(0,run.effects.indexOf(e)), old=effects.get(pin.of), p=products.get(pin.checkpoint);
			const last=prior.findLast(x=>x.kind==="rerun" && x.rerun?.of===pin.of && x.commit===e.commit);
			if (old?.kind!=="component" || old.pair || old.observer || old.remedy || !old.runnerClaim || !checkReceipt(old)?.exit ||
				!prior.includes(old) || old.grain!==e.grain || old.check!==e.check || old.commit!==pin.candidate ||
				!p || p.commit!==e.commit || !prior.some(x=>x.id===p.check && x.kind==="product") ||
				last?.id!==pin.after || last && (last.kind!=="rerun" || !checkReceipt(last) ||
					digest([last.rerun?.harness,last.rerun?.current])!==digest([pin.harness,pin.current]))) return false;
		}
		if ((e.remedy || e.production) && !validRemedy(run,e)) return false;
		if (e.observer) {
			const o=e.observer, old=effects.get(o.pair), prior=run.effects.slice(0,run.effects.indexOf(e));
			const original=prior.find(w=>old?.kind==="component" && w.kind==="writer" && w.restoration?.goal===old.pair?.goal &&
				w.grain===old.grain && !!w.restoration);
			const h=original?.kind==="writer" && original.restoration && historicalGrant(run,original.restoration.from,original.restoration.historical);
			if (!h || !o.file.startsWith(h.scope.primary+"/") || old?.kind!=="component" || !old.pair || old.grain!==e.grain ||
				!prior.includes(old) || !old.runnerClaim || checkReceipt(old)?.exit!==1 || e.pair || e.recheck || e.reuse || e.restoration ||
				o.before===o.after || !(e.kind==="writer" || e.kind==="component")) return false;
			const source=observerInput(prior,o), count=o.previous?1:0;
			const jobs=prior.filter(w=>w.kind==="writer" && w.observer?.pair===o.pair), w=jobs[count];
			if (!source?.commit || (o.previous && source.observer?.before===o.after) ||
				(e.kind==="writer" ? jobs.length!==count || e.tool!=="create_session" || e.issuer!==run.owner || e.args.base_branch!==source.commit :
				jobs.length!==count+1 || w?.kind!=="writer" || w.nativeId!==e.issuer || old.check!==e.check || !o.after ||
				digest(o)!==digest(w.observer) || e.commit===source.commit || prior.some(c=>c.kind==="component" && c.observer?.pair===o.pair &&
					c.observer.previous?.check===o.previous?.check))) return false;
		}
		if (e.launcherExit!==undefined && launcherFailure(e)!==e.launcherExit) return false;
		if (e.pair) {
			const a=e.pair, prior=run.effects.slice(0,run.effects.indexOf(e)), old=effects.get(a.failed), held=effects.get(a.component);
			const w=prior.findLast(x=>x.kind==="writer" && x.grain===e.grain), r=w?.kind==="writer" && w.restoration;
			const p=products.get(a.checkpoint), goal=prior.findLast(x=>x.kind==="goal");
			if (!r || e.kind!=="component" || e.issuer!==run.owner || e.recheck || !p || p.target!==a.target ||
				r.checkpoint!==a.checkpoint || r.goal!==a.goal || r.retainer!==a.retainer ||
				goal?.id!==a.goal || goal.commit!==p.commit || ![1,2].includes(checkReceipt(goal)?.exit ?? -1) ||
				old?.kind!=="component" || old.pair || old.grain!==e.grain || old.check!==e.check || old.commit===e.commit ||
				old.issuer!==w.nativeId || !old.runnerClaim || checkReceipt(old)?.exit!==1 || prior.indexOf(old)<=prior.indexOf(w) ||
				held?.kind!=="component" || held.grain!==a.retainer || !prior.includes(held) || held.commit!==a.candidate ||
				!held.runnerClaim || checkReceipt(held)?.exit!==0 || prior.some(x=>x.kind==="component" && x.pair?.failed===a.failed)) return false;
		}
		if (e.recheck) {
			const old = effects.get(e.recheck.of);
			if (e.tool!=="bash" || old?.tool!=="bash" || old===e || run.effects.indexOf(old)>=run.effects.indexOf(e) ||
				!launcherFailure(old) && !(old.kind==="goal" && old.runnerClaim && checkReceipt(old)?.exit===null) ||
				!(old.kind===e.kind && e.check===old.check && e.grain===old.grain || old.kind==="goal" && e.kind==="product") ||
				(e.kind==="component" ? e.issuer!==old.issuer || e.commit!==old.commit : e.issuer!==run.owner) ||
				(e.kind==="goal" && e.recheck.goalPin!==(e.evaluatorRevision ?? run.policy.base) ||
				e.kind==="product" && e.recheck.productPin!==(e.evaluatorRevision ?? run.policy.base)) ||
				run.effects.some(x=>x!==e && x.tool==="bash" && x.recheck?.of===old.id)) return false;
		}
	}
	if (e.state==="withdrawn" && (e.kind!=="writer" || e.callId || e.permissionHold || e.error || e.claims || e.reuse || e.observer || e.receipt ||
		!e.token || !e.grain || run.nodes[e.grain]?.token===e.token)) return false;
	if (e.state === "retired" || "retirement" in e) {
		if (e.kind !== "goal" || e.state !== "retired" || !e.retirement || e.issuer !== run.owner || !e.runnerStarted ||
			!e.callId || e.receipt || e.runnerClaim || e.permissionHold || e.args.shellId !== `foundry-${e.id}` ||
			new Set(Object.values(e.retirement)).size !== 3) return false;
	}
	if (e.runnerClaim !== undefined && (e.tool !== "bash" || !e.runnerStarted || !e.callId ||
		!(e.kind === "component" || e.kind === "rerun" || e.kind === "product" || e.kind === "goal"))) return false;
	if (e.permissionHold !== undefined && !unissued(e)) return false;
	if (e.receipt?.feedback !== undefined && e.receipt.feedbackFile) return false;
	if (e.receipt?.blockers && (e.kind !== "goal" || !e.runnerStarted || !e.callId ||
		e.receipt.exit !== 1 && !((e.receipt.exit === 0 || e.receipt.exit === 2) && e.receipt.blockers.every(s => "passed" in s)))) return false;
	if ((e.receipt?.feedback !== undefined || e.receipt?.feedbackFile) && (e.kind !== "goal" || !e.runnerStarted || !e.callId ||
		e.receipt.exit !== 0 && e.receipt.exit !== 1)) return false;
	if (e.evaluatorRevision && e.kind !== "product" && (!(e.kind === "goal" || e.kind === "scout") || !run.repins?.some(p => p.revision === e.evaluatorRevision))) return false;
	if (e.receipt?.failure && (e.kind !== "component" && e.kind!=="rerun" || !e.runnerStarted || !e.callId || e.receipt.exit !== null ||
		e.receipt.repair || e.receipt.squad || e.state !== "done" && e.state !== "refused")) return false;
	if (e.tool === "workflow") {
		const squad = run.policy.squads.find(s => s.id === e.squad), report = e.observation;
		if (e.lead && (!squad || !("areas" in squad) || e.iteration || !validLead(run, e.lead, e, squad))) return false;
		if (e.iteration) {
			const i = e.iteration, r = sourceReceipt(run.effects.find(g => g.id === i.receipt), i);
			if (i.follow && (!i.source || i.transfer || i.successor)) return false;
			if (i.transfer && (!i.files || !i.source || !understandsTransfers(run,e.productEvaluatorRevision) ||
				run.products.find(p=>p.check===i.receipt)?.outputs[i.transfer.from]!==i.transfer.candidate)) return false;
			if (i.successor) {
				const s=i.successor, old=effects.get(s.check), receipt=checkReceipt(old);
				if (i.transfer || !i.source || !covers(comparisonScope(i),i.source.file) || s.from===s.to ||
					old?.kind!=="component" || old.grain!==s.from || !old.runnerClaim || !receipt?.exit ||
					run.effects.indexOf(old)>=run.effects.indexOf(e) || products.get(i.receipt)?.outputs[s.from]) return false;
			}
			if (i.files && (!i.source || !(run.policy.ownership || e.productEvaluatorRevision) || !scope(comparisonScope(i)) ||
				!squad || !("areas" in squad) || !owns(squad,comparisonScope(i)) || !outside(comparisonScope(i),run.policy.files))) return false;
			if (!squad || !("areas" in squad) || !owns(squad, i.directory) || e.issuer !== run.owner || e.retryOf || e.wake ||
				!(i.basis ? productReceiptAt(run, i.receipt, e.base,e.productEvaluatorRevision) : r?.exit === 1 && r.commit === e.base && sameEvaluation(r,e)) ||
				i.historical && (!i.basis || run.effects.findIndex(g => g.id === i.historical?.missing) >= run.effects.indexOf(e) ||
					!omittedStep(run, i.historical, e.base, e.evaluatorRevision,e.productEvaluatorRevision)) ||
				!run.artifacts?.some(a => a.blob === i.blob && a.to.some(dir => contains(dir, i.directory)))) return false;
			if (i.source) {
				const goal = run.effects.slice(0,run.effects.indexOf(e)).findLast(g=>g.kind==="goal");
				if (!i.basis || i.historical || i.source.commit !== e.base || !owns(squad,i.source.file) ||
					goal?.id !== i.source.goal || goal.commit !== e.base || goal.check !== run.policy.goalCheck ||
					!sameEvaluation(goal,e) || !comparisonVerdict(checkReceipt(goal)?.exit,i.successor)) return false;
			}
		}
		if (e.renewal) {
			const n=e.renewal, i=comparison(run,e), p=products.get(n.checkpoint), g=effects.get(n.goal);
			if (!i?.source || i.transfer || i.successor || !p || p.commit===e.base || p.target!==products.get(i.receipt)?.target ||
				!productReceiptAt(run,n.checkpoint,p.commit,e.productEvaluatorRevision) || g?.kind!=="goal" || g.commit!==p.commit ||
				checkReceipt(g)?.exit!==2 || !sameEvaluation(g,e) || !e.packet || !e.workflowId || !e.callId ||
				report?.outcome!=="regenerate" || report.grains.length!==1 || report.replace?.length ||
				typeof report.grains[0]!=="object" || !sameScope(report.grains[0].directory,comparisonScope(i)) ||
				(n.state==="held" || n.state==="closed")!==!!n.reason || (e.state!=="blocked" && !(n.state==="approved" && e.state==="observed"))) return false;
		}
		if (e.correction) {
			const c = e.correction, basis=correctionBasis(run,e,c.file), g = report?.grains[0];
			if (typeof g !== "object" || !basis || basis.blob!==c.blob || basis.predecessorCheck!==c.predecessorCheck || basis.ordinary!==c.ordinary ||
				!revisedTask(e,g.id,c.clause) || !run.effects.some(w => w.kind === "writer" && w.state === "done" && w.grain === g.id && w.nativeId === c.worker)) return false;
			if ("resumed" in c && c.resumed) {
				const {prior,token}=c.resumed, notice=run.effects.find(w=>w.kind==="repair" && w.token===token);
				if (!c.ordinary || prior.review!==e.id || prior.worker!==c.worker || prior.base!==e.base || !prior.preview ||
					prior.check || prior.candidate || missingInput(prior)===undefined || prior.grain.task!==g.task || prior.grain.id!==g.id ||
					!sameScope(prior.grain.directory,g.directory) || prior.grain.check!==g.check || prior.token===token ||
					!notice || notice.issuer!==run.owner || notice.grain!==g.id || notice.args.session_id!==c.worker ||
					!run.effects.slice(run.effects.indexOf(e)+1,run.effects.indexOf(notice)).some(w=>w.kind==="writer" && w.token===prior.token &&
						w.grain===g.id && w.nativeId===c.worker && w.state==="done" && generationOf(w)===prior.generation)) return false;
			}
		}
		if (e.diagnostic) {
			const d = e.diagnostic, src = run.effects.find(r => r.id === e.retryOf), receipt = sourceReceipt(run.effects.find(r => r.id === d.receipt), d);
			if (src?.kind !== "scout" || src.error !== indexBudgetError || src.packet || src.note ||
				receipt?.exit !== 1 || receipt.commit !== e.base || !sameEvaluation(receipt,e) || e.packet && !e.packet.partial) return false;
		}
		if (e.predecessor) {
			const n = e.predecessor, g = report?.grains[0];
			if (e.state !== "observed" || report?.outcome !== "regenerate" || report.grains.length !== 1 || typeof g !== "object" ||
				(n.candidate ? !candidateHandoff(run, n, g, e) : missingInput(n) === undefined) ||
				!n.worker || !n.base || (n.candidate || e.retryOf || n.base === e.base) && !sameScope(successorDirectory(run, e, report),g.directory) ||
				g.task === n.grain.task ||
				g.id === n.grain.id || !sameScope(g.directory,n.grain.directory) || g.check !== n.grain.check ||
				!run.effects.some(w => w.kind === "writer" && w.grain === n.grain.id && w.nativeId === n.worker && w.state === "done")) return false;
		}
		if (e.retrySource && (!e.retryOf || e.wake || e.lead || e.diagnostic)) return false;
		if (e.retryOf) {
			const src = effects.get(e.retryOf);
			if (src?.kind !== "scout" || src.retryOf || src.state !== "blocked" || !src.workflowId ||
				e.issuer !== run.owner && (e.issuer !== src.issuer || !readerInterrupted(src)) ||
				src.squad !== e.squad || src.base !== e.base || src.version !== e.version || !sameEvaluation(src,e) ||
				run.effects.indexOf(src) >= run.effects.indexOf(e) ||
				run.effects.some(other => other !== e && other.kind === "scout" && other.retryOf === e.retryOf)) return false;
			if (e.retrySource ? src.issuer !== e.issuer || !src.iteration?.source || !rejectedSource(src, e.retrySource) ||
				e.packet && !deliveredFile(e.packet, src.iteration.source.file, e.retrySource) : !!src.observation) return false;
		}
		return !!squad && !e.nativeId && !e.token && !e.receipt && !e.boundAt && (!e.workflowId || !!e.callId) &&
			(e.state !== "suspended" && !e.providerRecovery || !!e.workflowId) &&
			(e.wake?.key !== "research" && report?.outcome !== "needs-research" || "areas" in squad && !!squad.researchAgent) &&
			(!report || investigation(e, squad) === (report.findings !== undefined)) &&
			(!e.packet || e.packet.review === e.id && e.packet.base === e.base) &&
			(e.state !== "reported" && e.state !== "observed" && e.state !== "deferred" || !!report && !!e.workflowId && !!e.packet) &&
			(e.state === "deferred" ? !!e.deferred && "areas" in squad && report?.outcome === "regenerate" : !e.deferred) &&
			(e.wake?.key !== "released-inputs" || run.effects.some(src => src.kind === "scout" && src.state === "deferred" &&
				src.squad === e.squad && src.id === e.wake?.review)) &&
			(!e.decision || e.state === "observed" && report?.outcome === "needs-decision") &&
			("areas" in squad || !report || !report.replace && report.grains.every(g => typeof g === "string"));
	}
	if (e.workflowId || Boolean(e.nativeId) !== Boolean(e.boundAt)) return false;
	if (e.restoration && (e.kind!=="writer" || e.issuer!==run.owner || !e.grain || e.reuse ||
		!historicalGrant(run,e.restoration.from,e.restoration.historical) || !products.has(e.restoration.checkpoint) ||
		effects.get(e.restoration.goal)?.kind!=="goal" || run.effects.findIndex(x=>x.id===e.restoration?.goal)>=run.effects.indexOf(e) ||
		!restoredProduct(run,e) && digest(run.nodes[e.grain]?.restoration ?? null)!==digest(e.restoration))) return false;
	if (e.finished) {
		const f=e.finished,c=effects.get(f.component),p=products.get(f.product);
		if (e.kind!=="writer" || e.state!=="done" || !e.nativeId || c?.kind!=="component" || c.grain!==e.grain || c.issuer!==e.nativeId ||
			!c.commit || checkReceipt(c)?.exit!==0 || !e.grain || p?.outputs[e.grain]!==c.commit ||
			!run.policy.squads.some(s=>s.id===f.squad && ("areas" in s ? owns(s,f.directory) : s.grains.includes(e.grain ?? "")))) return false;
	}
	if (e.pooled) {
		const src = effects.get(e.pooled.from);
		if (e.kind!=="writer" || !e.token || !e.grain || e.claims || e.reuse || typeof e.args.message!=="string" ||
			src?.kind!=="writer" || !src.finished || !src.nativeId || run.effects.indexOf(effects.get(src.finished.product) ?? e)>=run.effects.indexOf(e) ||
			(e.tool==="send_session_message" ? e.args.session_id!==src.nativeId : e.tool!=="session.send" || e.issuer!==src.nativeId) ||
			(e.state==="done" ? e.nativeId!==src.nativeId : !!e.nativeId)) return false;
	}
	if (e.reuse) {
		const {predecessor:n,blob,checkpoint,goal} = e.reuse, p = run.products.find(p => p.check === checkpoint);
		const at = run.effects.find(h => h.id === goal);
		if (e.kind !== "writer" || e.issuer !== run.owner || e.grain !== n.grain.id || !exhaustedCandidate(run,n) ||
			!p || at?.kind !== "goal" || at.commit !== p.commit || !run.artifacts?.some(a => a.blob === blob && scopePaths(n.grain.directory).some(dir => covers(a.to,dir))) ||
			run.effects.some(other => other !== e && other.kind === "writer" && other.reuse?.predecessor.check === n.check)) return false;
	}
	if (e.readGrant && (e.kind !== "writer" || e.state !== "done" || !e.callId)) return false;
	if (e.baseline && (e.kind !== "repair" || e.issuer !== run.owner || e.tool !== "send_session_message" ||
		!run.effects.some(w => w.kind === "writer" && w.state === "done" && w.grain === e.grain && w.nativeId === e.args.session_id))) return false;
	if (e.claims && (e.kind !== "writer" || !e.callId || !e.claims.length ||
		new Set(e.claims.map(c => c.actor)).size !== e.claims.length)) return false;
	if (e.claimedRequest && (e.state !== "done" || e.claims?.length !== 1 || e.claims[0].actor !== e.nativeId)) return false;
	if (e.inlineRepair && (e.kind !== "component" || !checkReceipt(e))) return false;
	if ((e.usedArtifacts || e.comparedArtifacts) && e.kind !== "component") return false;
	if (e.kind === "writer") return (e.tool === "create_session" || !!e.pooled) && !!e.grain && !!e.token && (e.state === "done") === !!e.nativeId;
	if (e.nativeId) return false;
	if (e.kind === "goal" || e.kind === "product" || e.kind === "component" || e.kind==="rerun")
		return e.tool === "bash" && !!e.commit && !!e.check && (e.kind === "component" || e.kind==="rerun") === !!e.grain &&
			(!e.receipt || e.receipt.commit === e.commit && e.receipt.check === e.check && sameEvaluation(e.receipt,e)) &&
			(!e.receipt?.squad || e.kind === "goal" && e.receipt.exit === 1 && run.policy.squads.some(s => s.id === e.receipt?.squad));
	if (!e.token || e.receipt || !string(e.args.message)) return false;
	if (e.kind === "escalation") return !e.grain && /^[a-f0-9]{64}$/.test(e.token) && (e.issuer === run.owner ?
		e.tool === "session.send" && e.state !== "ordinary" : e.tool === "send_session_message" && e.args.session_id === run.owner);
	if (e.kind === "repair" || e.kind === "artifact") return !!e.grain && (e.tool === "send_session_message" || e.tool === "session.send" && e.state !== "ordinary");
	return e.issuer === run.owner ? e.kind === "handoff" && e.tool === "session.send" && e.state !== "ordinary"
		: e.tool === "send_session_message" && e.args.session_id === run.owner;
}

/** @param {unknown} value @returns {import("./model.js").Run} */
export function decode(value) {
	if (!isRun(value) || value.policy.id !== value.id || value.active && value.pauseReason !== undefined ||
		value.scheduling?.workers !== undefined && value.policy.workers !== undefined && value.scheduling.workers > value.policy.workers ||
		"capacity" in value || value.policy.assignments !== undefined && assignmentCount(value) > value.policy.assignments ||
		Boolean(value.policy.goalCheck) !== Boolean(value.goal) || value.goal && value.policy.seed)
		fail("corrupt_run", "Invalid Foundry execution snapshot");
	const { policy: p, nodes, products } = value, areas = p.squads.filter(s => "areas" in s), files = new Set(p.files);
	const effects = new Map(value.effects.map(e => [e.id, e]));
	if (value.policyHold && (value.active || !value.pauseReason || effects.get(value.policyHold.effect)?.issuer!==value.policyHold.issuer))
		fail("corrupt_run","Invalid managed permission hold");
	const attributions = value.attributions ?? [];
	if (new Set(attributions.map(a => `${a.receipt}:${a.id}`)).size !== attributions.length || attributions.some(a => {
		const r = sourceReceipt(effects.get(a.receipt), a);
		return r?.exit !== 1 || r.blockers?.some(s => s.id === a.id) || !Number.isSafeInteger(a.blocked + 1);
	})) fail("corrupt_run", "Invalid shared blocker attribution");
	const grants = new Map(value.effects.flatMap(e => e.kind === "writer" && e.readGrant ? [[e.token, e]] : []));
	const observers = new Map(value.effects.flatMap(e => e.kind==="writer" && e.observer ? [[e.token,e]] : []));
	const queued = value.pendingReviewNotes ?? [];
	if (new Set(queued.map(n => `${n.squad}:${noteId(n)}`)).size !== queued.length || queued.some(n => n.after > value.effects.length ||
		!p.squads.some(s => s.id === n.squad) || !sourceReceipt(effects.get(n.receipt), n)) ||
		value.effects.some(e => e.kind === "scout" && (e.otherNotes && !e.note || e.note && (!e.workflowId || e.retryOf ||
			p.squads.some(s => s.id === e.squad && investigation(e, s)) || attachedNotes(e).some(n => !sourceReceipt(effects.get(n.receipt), n))))))
		fail("corrupt_run", "Invalid historical receipt for scout review");
	const pins = value.repins ?? [];
	if (pins.length && (!value.goal || new Set([p.base, ...pins.map(pin => pin.revision)]).size !== pins.length + 1 ||
		pins.some((pin, i) => pin.from !== (i ? pins[i-1].revision : p.base) || !pin.files.length ||
			new Set(pin.files).size !== pin.files.length || !pin.files.every(f => f.startsWith(".foundry/") ||
				p.files.includes(f) && value.productRepins?.some(q=>q.targetFrom && q.revision===pin.revision)))))
		fail("corrupt_run", "Invalid goal evaluator pin history");
	const last = products.at(-1);
	const checkpoints = new Map(products.map(p=>[p.check,p]));
	if (!validDeliveries(value)) fail("corrupt_run","Invalid test delivery or component lineage");
	if (!validIsolation(value)) fail("corrupt_run","Invalid independent checkpoint or original ownership hold");
	if (!productLineage(value,checkpoints)) fail("corrupt_run","Invalid product evaluator lineage");
	if (effects.size !== value.effects.length || value.effects.some(e => !validDispatch(value, e, effects, checkpoints)))
		fail("corrupt_run", "Invalid Foundry dispatch");
	if (areas.length && (!value.goal || areas.length !== value.policy.squads.length) ||
		p.sharedBrief !== undefined && (!areas.length || p.sharedBrief !== `${planDirectory(p.source)}/journey.md` ||
			areas.some(s => s.boundary.length !== 1 || s.boundary[0] !== p.sharedBrief)) ||
		![p.source, p.productCheck, ...(p.goalCheck ? [p.goalCheck] : []), ...p.squads.flatMap(s => "areas" in s ? [s.charter, ...s.boundary, ...s.checks] : [s.charter])].every(f => files.has(f)) ||
		[p.seed ?? [], ...p.squads.flatMap(s => "grains" in s ? [s.grains] : [])].some(ids => ids.some(id => !Object.hasOwn(nodes, id))) ||
		Object.entries(nodes).some(([id, n]) => {
			const g = n.grain, e = n.check ? effects.get(n.check) : undefined;
			if (e?.kind==="rerun") return true;
			if (n.restoration && (!validRestoration(value,n) || !value.effects.some(w=>w.kind==="writer" && w.grain===id &&
				digest(w.restoration ?? null)===digest(n.restoration)))) return true;
			if (n.retained && (!n.retained.length || new Set(n.retained.map(c=>c.to)).size!==n.retained.length ||
				!understandsTransfers(value,value.productRepins?.at(-1)?.revision) || n.retained.some(c=>{
					const r=effects.get(c.review), i=r?.kind==="scout" && comparison(value,r), scope={primary:c.primary,files:c.files};
					return !i || !i.transfer || r?.state!=="observed" || i.transfer.from!==id || i.transfer.to!==c.to ||
						!sameScope(comparisonScope(i),scope) || !sameScope(nodes[c.to]?.grain.directory,scope) || nodes[c.to].review!==c.review ||
						!scopePaths(scope).every(p=>ownership(g.directory).directories.some(d=>p.startsWith(d+"/")));
				}))) return true;
			const review = n.review && effects.get(n.review);
			if (n.successor) {
				const c=n.successor,r=effects.get(c.review),i=r?.kind==="scout" && comparison(value,r),s=i && i.successor;
				const child=nodes[c.to], origin=review && review.kind==="scout" && review.squad;
				if (!s || !stoppedCheck(value,s) || n.retained || r?.state!=="observed" || r.kind!=="scout" || r.squad!==origin ||
					s.from!==id || s.to!==c.to || !narrower(g.directory,c.directory) || !sameScope(comparisonScope(i),c.directory) ||
					!child || child.review!==c.review || !sameScope(child.grain.directory,c.directory) || child.grain.check!==g.check ||
					child.grain.revision || child.grain.needs.includes(id) || child.successor || child.reuse) return true;
			}
			if (review && review.kind==="scout") {
				const s=comparison(value,review)?.successor;
				if (s && (s.to!==id || nodes[s.from]?.successor?.review!==review.id)) return true;
			}
			if (mixed(g.directory)) {
				const i=review && review.kind==="scout" ? comparison(value,review) : undefined;
				if (!i?.source || !sameScope(g.directory,comparisonScope(i))) return true;
				if (i.transfer && (i.transfer.to!==id || !nodes[i.transfer.from]?.retained?.some(c=>c.review===n.review && c.to===id))) return true;
			}
			const launch = n.reuse ? effects.get(n.reuse) : undefined;
			if (n.workspace) {
				const w = effects.get(n.workspace);
				if (w?.kind!=="writer" || !w.pooled || w.grain!==id || w.nativeId!==n.worker || w.pooled.generation!==n.generation ||
					w.state!=="done" && w.token!==n.token) return true;
				const src = effects.get(w.pooled.from);
				if (src?.kind!=="writer" || !src.finished || !p.squads.some(s=>s.id===src.finished?.squad &&
					("areas" in s ? owns(s,g.directory) : s.grains.includes(id)))) return true;
			}
			const reuse = launch?.kind === "writer" ? launch.reuse : undefined;
			if (n.reuse && (!reuse || launch?.grain !== id || launch.token !== n.token || launch.nativeId !== n.worker ||
				launch.args.base_branch !== n.generation || reuse.predecessor.review !== n.review || n.repairs !== reuse.predecessor.repairs ||
				digest(g) !== digest(reuse.predecessor.grain))) return true;
			if (review && review.kind === "scout" && review.correction && ((reuse?.predecessor.worker ?? n.worker) !== review.correction.worker ||
				g.task !== revisedTask(review,g.id,review.correction.clause))) return true;
			if (n.priorSource && (!n.base || Array.isArray(n.priorSource)!==Array.isArray(g.directory) ||
				members(n.priorSource).some(b=>!ownership(g.directory).directories.includes(b.directory) || b.revision !== (g.revision ?? n.base)))) return true;
			const w = grants.get(n.token);
			const observer=observers.get(n.token);
			if (observer && (observer.grain!==id || observer.nativeId!==n.worker || observer.args.base_branch!==n.generation ||
				(e && (e.kind!=="component" || !e.observer || e.issuer!==n.worker || digest(e.observer)!==digest(observer.observer))))) return true;
			if (w?.readGrant && (w.grain !== id || w.nativeId !== n.worker || !n.priorSource || digest(w.readGrant)!==digest(n.priorSource))) return true;
			if (id !== g.id || ![g.specification, g.check, ...g.boundary].every(f => files.has(f)) || !outside(g.directory, p.files)) return true;
			if (n.stop?.kind === "writer-cannot-repair" && (!n.candidate || inconclusiveRepair(n,e)?.commit !== n.candidate)) return true;
			if (n.stop?.kind === "writer-relinquished" && (n.candidate || !relinquishable(value,n))) return true;
			if ((n.state === "checking" || checked(n)) && (e?.kind !== "component" || e.grain !== id || e.commit !== n.candidate || e.check !== g.check)) return true;
			if (checked(n) && checkReceipt(e)?.exit !== 0) return true;
			if (n.state === "qualified" && last?.outputs[id] !== n.candidate) return true;
			return areas.length ? n.state === "idle" || !g.task || !areas.some(s => owns(s, g.directory) && s.checks.includes(g.check) &&
				g.specification === s.charter && g.agent === s.agent && g.boundary.length === s.boundary.length && g.boundary.every((b, i) => b === s.boundary[i])) : g.task !== undefined || Array.isArray(g.directory);
		}))
		fail("corrupt_run", "Invalid Foundry task graph");
	validateNodes(nodes);
	for (const product of value.join ? [...products, value.join] : products) {
		const e = effects.get(product.check);
		if (e?.kind !== "product" || e.commit !== product.commit || e.check !== p.productCheck)
			fail("corrupt_run", "Product does not match its exact check reservation");
		if (product.ownership) {
			const transfer=understandsTransfers(value,e.evaluatorRevision);
			const restore=!transfer && !Object.values(product.ownership).some(s=>s.exclude) && value.effects.some(w=>w.kind==="writer" &&
				w.restoration && (product===value.join ? w.grain && nodes[w.grain]?.restoration && product.outputs[w.grain] : restoredProduct(value,w)===product));
			if (!transfer && !restore && value.independent?.product!==product.check || digest(Object.keys(product.ownership).sort())!==digest(Object.keys(product.outputs).sort()))
				fail("corrupt_run","Invalid product ownership snapshot");
		}
		if (product===value.join && value.independent?.product!==product.check && product.ownership && Object.keys(product.outputs).every(id=>nodes[id]) &&
			digest(product.ownership)!==digest(productOwnership(nodes,product.outputs) ?? null))
			fail("corrupt_run","Product reservation does not match its partition of the current outputs");
		if (product === value.join ? product.qualifiedAt !== undefined :
			checkReceipt(e)?.exit !== 0 || (!value.goal && !product.qualifiedAt || value.goal && product.qualifiedAt && last !== product))
			fail("corrupt_run", "Checkpoint requires an exact passing product receipt");
	}
	if (last?.qualifiedAt && value.goal && (value.active || last.commit !== value.goal.commit ||
		last.target !== value.goal.target || !checkpointReceipt(value,last.check,last.commit) || goalReceipt(value)?.exit !== 0))
		fail("corrupt_run", "Goal acceptance requires both exact runner receipts");
	return value;
}
