import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { accepted, requireSquad } from "./backlog.mjs";
import { outstanding } from "./effects.mjs";
import { templateChecks } from "./factory.mjs";
import { applyExpectedTip, branchRef, candidateCommit, joinTree, observedLanding, targetTip } from "./promotion.mjs";
import { productionClosure } from "./jobs.mjs";
import { goalMember, requireAdmission } from "./policy.mjs";
import { admittedEvidence, finishClosure } from "./results.mjs";
import { inputOutput, resolvedInputs, revise } from "./tasks.mjs";
import { array, choice, closedFields, containsPath, digest, FoundryError, json, latestEvidence, record, text } from "./values.mjs";
import { enqueueLandedRetirements } from "./retirement.mjs";

/** @typedef {import("./database.mjs").Transaction} Tx */
/** @typedef {import("./model.d.ts").PinnedInput} PinnedInput */
/** @typedef {{ level:"qualified"|"landed"|"released", acceptance:"artifact-command"|"interactive", targetRef:string }} DeliveryPolicy */
/** @typedef {{goalId:string,revision:number,factoryId:string,generation:number,policyHash:string,taskId:string,taskVersion:number,
 * policy:DeliveryPolicy,checks:import("./model.d.ts").Check[],inputs:PinnedInput[],
 * sources:{input:PinnedInput,output:import("./model.d.ts").Output,base:string,resultId:string,attemptId:string}[]}} Basis */
/** @param {string} code @param {string} reason @returns {never} */
function fail(code, reason) { throw new FoundryError(code, reason); }
/** @param {unknown} a @param {unknown} b */
const equal = (a,b) => digest(json(a)) === digest(json(b));

/** @param {unknown} value @returns {DeliveryPolicy} */
export function deliveryPolicy(value) {
	const policy = record(value);
	closedFields(policy, ["level","acceptance","targetRef"], "delivery policy");
	return { level: choice(policy.level, ["qualified", "landed", "released"], "required delivery level"),
		acceptance: choice(policy.acceptance, ["artifact-command", "interactive"], "required product environment"),
		targetRef: branchRef(text(policy.targetRef, "local delivery ref")) };
}
/** @param {Tx} tx @param {string} goalId */
function context(tx, goalId) {
	const completion = tx.get("goal_completions", goalId), task = tx.get("tasks", completion.taskId);
	const factory = tx.get("factory_controls", completion.factoryId), definition = record(factory.definition);
	if (definition.delivery === undefined) fail("delivery_unauthorized", "Activation did not authorize a delivery ref or product acceptance");
	return { completion, task, factory, definition, policy: deliveryPolicy(definition.delivery), goal: tx.get("goals", goalId) };
}
/** @param {Tx} tx @param {string} goalId @param {string} actor */
function owner(tx, goalId, actor) {
	const ctx = context(tx, goalId);
	if (ctx.goal.owner !== actor || ctx.completion.owner !== actor) fail("forbidden", "Only this admitted bounded job's accountable owner can integrate or land it");
	if (ctx.factory.owner !== actor) {
		const item = tx.list("backlog_items","WHERE goal_id=?",[goalId])[0];
		if (!item || item.factoryId !== ctx.factory.id) fail("forbidden", "No authorized directed job for this coordinator");
		requireSquad(tx,item.squad,item.currentRevision,actor,ctx.factory.generation);
	}
	return ctx;
}
/** @param {Tx} tx @param {string} goalId @param {string} actor @returns {Basis} */
export function captureDelivery(tx, goalId, actor) {
	const { completion, task, factory, definition, policy, goal } = owner(tx, goalId, actor);
	requireAdmission(tx, task);
	if (policy.acceptance !== "artifact-command") fail("interactive_product_unsupported", "No qualified interactive product evidence adapter; offscreen checks cannot substitute");
	if (goal.limits.deadline && Date.parse(goal.limits.deadline) <= Date.parse(tx.timestamp())) fail("deadline_exhausted", "Delivery deadline elapsed");
	const item = tx.list("backlog_items", "WHERE goal_id=?", [goalId])[0];
	const templateId = item?.template ?? text(definition.completionTaskId, "completion template");
	const template = array(record(definition.goal).tasks, record).find(row => row.id === templateId);
	if (!template) fail("delivery_acceptance_missing", "No immutable factory product acceptance definition");
	const checks = templateChecks(definition, templateId, template.checks);
	if (!checks.length || checks.some(c => c.kind !== "command" || !c.artifactFiles?.length)
		|| !equal(checks, task.checks)) fail("delivery_acceptance_mismatch", "Only the exact authority-pinned artifact-command acceptance can qualify a product");
	const inputs = resolvedInputs(tx, task);
	if (!inputs || completion.requiredInputs.some(input => !task.inputs.some(i => equal(i, input)))) {
		fail("delivery_inputs_missing", "Publish every required named input before preparing the joined product");
	}
	let required = inputs;
	const prior = load(tx, goalId);
	const pinnedSources = prior?.manifest.revision === completion.revision && prior.manifest.taskVersion === task.version
		? prior.manifest.sources : [];
	if (!inputs.length) {
		// An unsplit item is both producer and integrator. Its first publication
		// is not acceptance; pin the actual named result, then run a fresh attempt
		// on the joined bytes. Never reuse the preliminary artifact-only pass.
		const name = task.deliverable ?? "product";
		const published = task.outputs.find(out => out.name === name);
		const pinned = pinnedSources.find(source => source.input.taskId === task.id && source.input.output === name)?.input;
		if (pinned) required = [pinned];
		else {
			if (!published || task.state !== "done") fail("delivery_inputs_missing", `Publish the named ${name} bundle before product integration`);
			required = [{taskId:task.id,output:name,version:published.version}];
		}
	}
	const sources = required.map(input => {
		const output = inputOutput(tx, input);
		if (!output || !["code","artifact"].includes(output.kind)) fail("delivery_unpublished", "Every delivery input must be a published code or artifact version");
		const pinned = pinnedSources.find(source => equal(source.input, input));
		const source = tx.list("results", `WHERE state='done' AND attempt_id IN (SELECT id FROM attempts WHERE task_id=?)
			AND id IN (SELECT result_id FROM outcomes WHERE promoted=1)`, [input.taskId])
			.findLast(result => (!pinned || result.id === pinned.resultId) && result.outputs.some(o => equal(o, output)));
		if (!source) fail("delivery_unpublished", "Missing promoted source result");
		const attempt = tx.get("attempts", source.attemptId);
		const evidence = source.evidence.filter(e => e.outcome === "passed" && e.candidate?.version === output.version);
		if (!attempt.baseCommit || !evidence.length || evidence.some(e => e.candidate?.files.some(file => !goal.scope.paths.some(p => containsPath(p, file.path))))) {
			fail("delivery_input_provenance", "Input lacks its observed Git baseline, evaluated bundle or goal path authority");
		}
		return { input, output, base: attempt.baseCommit, resultId: source.id, attemptId: attempt.id };
	});
	return { goalId, revision: completion.revision, factoryId: factory.id, generation: factory.generation, policyHash: factory.source.sha256,
		taskId: task.id, taskVersion: task.version, policy, checks, inputs, sources };
}
/** @param {string} db @param {Basis} basis @returns {{expectedTip:string,tree:string}} */
export function prepareJoin(db, basis) {
	const expectedTip = targetTip(db, basis.policy.targetRef);
	const tree = joinTree(db, expectedTip, basis.sources);
	return { expectedTip, tree };
}
/** Capture and recheck the inputs in separate transactions; Git joins do not hold the writer lock.
 * @param {import("./database.mjs").Database} db @param {string} goalId @param {string} actor */
export function prepareDelivery(db, goalId, actor) {
	const basis = db.read(captureDelivery, goalId, actor);
	const joined = prepareJoin(db.databasePath, basis);
	return db.write(recordJoin, basis, joined, actor);
}
/** @typedef {Basis & {expectedTip:string,tree:string,targetRef:string,format:1}} Manifest */
/** @typedef {{id:string,manifest:Manifest,newTip:string,qualified:{resultId:string,attemptId:string,evidenceIds:string[]}|null,
 * intent:{token:string,actor:string,state:"issued"|"blocked",reason?:string}|null,
 * landed:{receiptId:string,targetRef:string,newTip:string}|null}} Delivery */
/** @typedef {{goalId:string,policy:DeliveryPolicy,revision:number,manifestId?:string,manifest?:Manifest,newTip?:string,
 * published:boolean,qualified:Delivery["qualified"],landed:Delivery["landed"],released:false,closed:boolean,
 * releaseCapability:"unsupported",interactiveCapability:"unsupported",
 * intent:Pick<NonNullable<Delivery["intent"]>,"state"|"reason">|null,
 * previous:({manifestId:string,revision:number}&Pick<Delivery,"qualified"|"landed">)|null}} ProductStatus */
/** @typedef {{action:"prepare"}|{action:"qualify"|"land"|"reconcile",manifestId:string}} DeliveryAction */
/** @param {Tx} tx @param {string} goalId @param {string} [id] @returns {Delivery|undefined} */
function load(tx, goalId, id) {
	const row = id === undefined ? tx.db.prepare("SELECT * FROM delivery_manifests WHERE goal_id=? ORDER BY rowid DESC LIMIT 1").get(goalId)
		: tx.db.prepare("SELECT * FROM delivery_manifests WHERE goal_id=? AND id=?").get(goalId,id);
	if (!row) return;
	/** @type {Delivery} */
	const d = JSON.parse(text(row.document, "delivery manifest"));
	if (d.id !== row.id || digest(json(d.manifest)) !== d.id || d.manifest.goalId !== goalId) fail("delivery_identity", "Stored delivery manifest identity mismatch");
	return d;
}
/** @param {Tx} tx @param {Delivery} d */
function save(tx, d) {
	tx.db.prepare(`INSERT INTO delivery_manifests(id,goal_id,document) VALUES(?,?,?)
		ON CONFLICT(id) DO UPDATE SET document=excluded.document`).run(d.id, d.manifest.goalId, JSON.stringify(d));
}
/** @param {Tx} tx @param {Basis} captured @param {{expectedTip:string,tree:string}} joined @param {string} actor @returns {Delivery} */
export function recordJoin(tx, captured, joined, actor) {
	const basis = captureDelivery(tx, captured.goalId, actor);
	if (!equal(captured, basis) || targetTip(tx.databasePath, basis.policy.targetRef) !== joined.expectedTip) fail("delivery_stale_tip", "Job or ref changed during independent preparation");
	const old = load(tx, basis.goalId);
	if (old?.landed && old.manifest.revision === basis.revision) fail("delivery_already_landed","This revision has a landed receipt; another ref update cannot stand in for release");
	/** @type {Manifest} */
	const manifest = { format: 1, ...basis, ...joined, targetRef: basis.policy.targetRef };
	if (old?.id === digest(json(manifest))) return old;
	if (old?.intent && old.intent.state !== "blocked" && !old.landed) fail("delivery_uncertain", "Reconcile the prior issued ref update before replacing its manifest");
	if (old?.manifest.taskVersion === basis.taskVersion || !basis.inputs.length) {
		const task = tx.get("tasks", basis.taskId);
		if (task.currentAttemptId && (outstanding(tx, tx.get("attempts",task.currentAttemptId), true) || task.waiting?.kind === "input")) {
			fail("delivery_in_flight", "Settle outstanding product checks before recomputing this lane");
		}
		// The previous writer has finished. The job owner staffs the fresh combined check.
		if (task.currentAttemptId && tx.get("attempts", task.currentAttemptId).nativeId === task.owner) task.owner = actor;
		revise(tx, task, actor);
		manifest.taskVersion = task.version;
	}
	const id = digest(json(manifest));
	const d = { id, manifest, newTip: candidateCommit(tx.databasePath, manifest.tree, manifest.expectedTip, id), qualified: null, intent: null, landed: null };
	save(tx, d);
	return d;
}
/** @param {Tx} tx @param {string} attemptId @returns {{manifestId:string,tree:string}|undefined} */
export function productCheckPlan(tx, attemptId) {
	const attempt = tx.get("attempts", attemptId), task = tx.get("tasks", attempt.taskId);
	const completion = tx.optional("goal_completions", task.goalId);
	if (!completion || completion.taskId !== task.id || record(tx.get("factory_controls",completion.factoryId).definition).delivery === undefined) return;
	const factory = requireAdmission(tx, task);
	const d = load(tx, task.goalId);
	if (!task.inputs.length && (!d || d.manifest.revision !== completion.revision || d.manifest.taskVersion !== task.version)) return;
	if (!d || d.manifest.revision !== completion.revision || d.manifest.generation !== factory?.generation || d.manifest.taskVersion !== task.version
		|| task.currentAttemptId !== attempt.id || !equal(d.manifest.checks, attempt.checks) || !equal(d.manifest.inputs, attempt.inputs)) {
		fail("delivery_manifest_required", "Prepare a current versioned manifest before running product acceptance");
	}
	return { manifestId: d.id, tree: d.manifest.tree };
}
/** @param {Tx} tx @param {string} goalId @param {string} id @param {string} actor */
function current(tx, goalId, id, actor) {
	const d = load(tx, goalId);
	if (!d || d.id !== id) fail("delivery_superseded", "Only the current versioned delivery can advance");
	const basis = captureDelivery(tx, goalId, actor);
	const {format: _f, expectedTip: _e, tree: _t, targetRef: _r, ...snapshot} = d.manifest;
	if (!equal(basis,snapshot)) fail("delivery_superseded", "Acceptance, source versions or activation changed; retain history and prepare again");
	return d;
}
/** @param {Tx} tx @param {Delivery} d */
function checkedResult(tx, d) {
	const { taskId, goalId, revision } = d.manifest;
	const { task, completion } = context(tx, goalId);
	if (task.id !== taskId || task.state !== "done" || !task.currentAttemptId || !completion.accepted || completion.accepted.revision !== revision
		|| !completion.accepted.tasks.every(item => {
			const t = tx.get("tasks", item.id);
			return t.state === "done" && t.version === item.version && equal(resolvedInputs(tx,t) ?? null, item.inputs);
		}) || !equal(productionClosure(tx,completion).map(t => t.id).sort(), completion.accepted.tasks.map(t => t.id).sort())) {
		fail("delivery_not_qualified", "Current product acceptance and its entire required production closure must be promoted");
	}
	const result = tx.list("results", "WHERE attempt_id=? AND state='done' AND id IN (SELECT result_id FROM outcomes WHERE promoted=1)",[task.currentAttemptId])[0];
	if (!result) fail("delivery_not_qualified", "No promoted product result");
	const latest = latestEvidence(admittedEvidence(tx, result.attemptId));
	const ids = d.manifest.checks.map(check => {
		const e = latest.get(JSON.stringify([check.id,check.version]));
		if (!e || e.outcome !== "passed" || !e.candidate || !result.evidence.some(receipt => equal(e, receipt))) {
			fail("delivery_not_qualified", "Each required product check needs its latest passing, admitted native receipt");
		}
		const evidenceDir = path.join(path.dirname(tx.databasePath), "evidence");
		const stat = lstatSync(e.reference);
		if (!stat.isFile() || stat.nlink !== 1 || realpathSync(e.reference) !== e.reference || path.dirname(e.reference) !== evidenceDir) {
			fail("delivery_evidence_changed", "Invalid native product receipt path");
		}
		const content = readFileSync(e.reference);
		if (e.id !== `evidence:${createHash("sha256").update(content).digest("hex")}`) fail("delivery_evidence_changed", "Admitted native product receipt changed");
		const raw = record(JSON.parse(content.toString("utf8")));
		if (!equal(raw.product ?? null, { manifestId: d.id, tree: d.manifest.tree }) || raw.state !== "finished" || raw.exitCode !== 0 || raw.error !== null
			|| raw.checkVersion !== check.version || raw.command !== check.command || raw.attemptId !== result.attemptId) {
			fail("delivery_not_qualified", "Native runner did not pass this exact product manifest and joined tree");
		}
		return e.id;
	});
	return { resultId: result.id, attemptId: result.attemptId, evidenceIds: ids };
}
/** @param {Tx} tx @param {Delivery} d */
function seal(tx, d) {
	if (!d.qualified) return;
	const { completion, task } = context(tx,d.manifest.goalId);
	if (completion.closed) return;
	completion.closed = true;
	tx.put("goal_completions",completion);
	finishClosure(tx, task, tx.get("results",d.qualified.resultId));
	accepted(tx,task.goalId,d.qualified.resultId);
}
/** @param {Tx} tx @param {string} goalId @param {string} id @param {string} actor @returns {Delivery} */
export function qualifyDelivery(tx, goalId, id, actor) {
	const d = current(tx,goalId,id,actor);
	if (targetTip(tx.databasePath,d.manifest.targetRef) !== d.manifest.expectedTip) fail("delivery_stale_tip", "Recompute and requalify this lane against the current target");
	d.qualified = checkedResult(tx, d);
	save(tx, d);
	if (d.manifest.policy.level === "qualified") seal(tx, d);
	return d;
}
/** @param {Tx} tx @param {string} goalId @param {string} id @param {string} actor @returns {Delivery} */
export function authorizeLanding(tx, goalId, id, actor) {
	const d = current(tx,goalId,id,actor);
	const { goal, task } = context(tx,goalId);
	// Isolated artifact qualification does not move refs. Do not interpret prose
	// as clearance for the separate shared mutation.
	if (goal.scope.restrictions.length || task.scope.restrictions.length) fail("delivery_restricted", "Ambiguous scope restrictions do not grant shared ref-update authority");
	if (d.manifest.policy.level === "qualified") fail("delivery_unauthorized", "Qualification alone grants no permission to update a branch");
	if (!d.qualified || !equal(checkedResult(tx,d), d.qualified)) fail("delivery_not_qualified", "Qualify this manifest before issuing its local landing");
	if (d.intent && d.intent.state !== "blocked") fail("delivery_uncertain", "Reconcile the original intent instead of blindly resubmitting");
	if (targetTip(tx.databasePath,d.manifest.targetRef) !== d.manifest.expectedTip) fail("delivery_stale_tip", "Recompute and requalify this lane");
	return d;
}
/** @param {Tx} tx @param {string} goalId @param {string} id @param {string} actor @returns {{target:Manifest & {newTip:string},token:string}} */
export function issueLanding(tx, goalId, id, actor) {
	const d = authorizeLanding(tx, goalId, id, actor);
	d.intent = {token: randomUUID(), actor, state: "issued"};
	save(tx,d);
	return {target:{...d.manifest,newTip:d.newTip}, token:d.intent.token};
}
/** @param {Tx} tx @param {string} goalId @param {string} id @param {string} token @param {string} reason @returns {void} */
export function blockLanding(tx, goalId, id, token, reason) {
	const d = load(tx,goalId,id);
	if (!d?.intent || d.intent.token !== token || d.landed) return;
	d.intent.state = "blocked";
	d.intent.reason = reason;
	save(tx,d);
}
/** @param {Tx} tx @param {string} goalId @param {string} id @param {string} actor @returns {Delivery} */
export function reconcileLanding(tx, goalId, id, actor) {
	const { completion, factory, goal } = context(tx,goalId);
	if (goal.owner !== actor || completion.owner !== actor) fail("forbidden","Only the actual bounded owner can reconcile its landing");
	const d = load(tx,goalId,id);
	if (!d?.qualified || !d.intent || d.intent.state !== "issued") fail("delivery_unissued", "No issued landing to reconcile");
	if (!d.landed) {
		if (!observedLanding(tx.databasePath,{...d.manifest,newTip:d.newTip},d.intent.token)) fail("delivery_uncertain", "No attributable Git reflog receipt; retain intent and do not resubmit");
		d.landed = {receiptId:`landed:${d.intent.token}`, targetRef:d.manifest.targetRef, newTip:d.newTip};
		save(tx,d);
		enqueueLandedRetirements(tx, goalId, d.landed);
	}
	if (!completion.closed && d.manifest.revision === completion.revision && factory.state === "active" && factory.generation === d.manifest.generation) {
		// Revocation after issuance does not erase the actual Git transaction,
		// nor does a late receipt qualify a changed or cancelled closure.
		try { current(tx,goalId,id,actor); checkedResult(tx,d); }
		catch (error) { if (error instanceof FoundryError) return d; throw error; }
		if (d.manifest.policy.level === "landed") seal(tx,d);
	}
	return d;
}
/** @param {Tx} tx @param {string} goalId @param {string} actor @returns {ProductStatus} */
export function deliveryStatus(tx, goalId, actor) {
	if (!goalMember(tx,tx.get("goals",goalId),actor)) fail("forbidden","Only job participants can inspect this delivery");
	const d = load(tx,goalId);
	const {completion,policy,task} = context(tx,goalId);
	const active = d?.manifest.revision === completion.revision && d.manifest.taskVersion === task.version ? d : undefined;
	const inputs = resolvedInputs(tx,task);
	const published = Boolean(active || inputs && (inputs.length || task.state === "done" && task.outputs.some(o => o.name === (task.deliverable ?? "product"))));
	return {goalId, policy, revision:completion.revision, manifestId:active?.id, manifest:active?.manifest, newTip:active?.newTip,
		published, qualified:active?.qualified ?? null, landed:active?.landed ?? null, released:false,
		releaseCapability:"unsupported", interactiveCapability:"unsupported", closed:completion.closed,
		intent:active?.intent ? {state:active.intent.state,reason:active.intent.reason} : null,
		previous:d && !active ? {manifestId:d.id,revision:d.manifest.revision,qualified:d.qualified,landed:d.landed} : null};
}

/** The native host, not a tool argument or a policy boolean, must actually own
 * the matching repository and freeze checkout/registry transitions until apply
 * returns. The current Desktop SDK does not expose this capability.
 * @typedef {(request:{databasePath:string,goalId:string,actor:string,manifestId:string,targetRef:string,expectedTip:string,newTip:string}, apply:()=>void)=>Promise<void>} LandingLease
 * @param {import("./database.mjs").Database} db @param {LandingLease|undefined} lease
 * @param {string} goalId @param {string} id @param {string} actor @param {()=>boolean} isCurrent @returns {Promise<Delivery>} */
export async function landDelivery(db, lease, goalId, id, actor, isCurrent) {
	if (!lease) fail("landing_host_unsupported","Native host cannot authorize and freeze local checkout/worktree changes across an expected-tip update");
	const status = db.write(authorizeLanding, goalId,id,actor);
	let applied = false, open = true;
	try {
		await lease({databasePath:db.databasePath,goalId,actor,manifestId:id,targetRef:status.manifest.targetRef,
			expectedTip:status.manifest.expectedTip,newTip:status.newTip}, () => {
			if (!open || applied || !isCurrent()) fail("landing_context_changed","Landing lease lost its exact caller context");
			applied = true;
			const {target,token} = db.write(issueLanding, goalId,id,actor);
			try { applyExpectedTip(db.databasePath,target,token); }
			catch (error) {
				if (error instanceof FoundryError) db.write(blockLanding, goalId,id,token,error.code);
				throw error;
			}
		});
	} finally { open = false; }
	if (!applied) fail("landing_host_unsupported","No verified checkout-topology lease was granted");
	return db.write(reconcileLanding, goalId,id,actor);
}

/** @param {Tx} tx @param {string} goalId @param {string} actor @returns {DeliveryAction|undefined} */
export function nextDelivery(tx, goalId, actor) {
	const completion = tx.get("goal_completions",goalId), factory = tx.get("factory_controls",completion.factoryId);
	if (completion.closed || completion.owner !== actor || factory.state !== "active" || record(factory.definition).delivery === undefined) return;
	const task = tx.get("tasks",completion.taskId), d = load(tx,goalId);
	if (task.state === "cancelled") return;
	if (d?.intent && d.intent.state !== "blocked" && !d.landed) return { action:"reconcile", manifestId:d.id };
	const inputs = resolvedInputs(tx,task);
	if (!inputs || !inputs.length && !d && task.state !== "done") return;
	if (!d || d.manifest.revision !== completion.revision || d.manifest.taskVersion !== task.version || d.manifest.generation !== factory.generation
		|| !d.landed && targetTip(tx.databasePath,d.manifest.targetRef) !== d.manifest.expectedTip) return {action:"prepare"};
	if (d.landed || d.intent?.state === "blocked") return;
	if (!d.qualified) return task.state === "done" ? {action:"qualify",manifestId:d.id} : undefined;
	return {action:"land",manifestId:d.id};
}
