import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { inspectRetirementTree } from "./preservation.mjs";
import { effectsForAttempt } from "./effects.mjs";
import { nativeObject, toolName } from "./native.mjs";
import { FoundryError, digest, json, nativeSessionName, record, text } from "./values.mjs";
import { wake } from "./wakes.mjs";

/** @typedef {import("./database.mjs").Transaction} Tx */
/** @typedef {import("./model.d.ts").Effect} Effect */
/** @typedef {import("./model.d.ts").Json} Json */
/** @typedef {ReturnType<typeof import("./store.mjs").openWorkStore>} Store */
/** @typedef {{receiptId:string,targetRef:string,newTip:string}} Landing */
/** @typedef {import("./preservation.mjs").TreeProof} Tree */
/** @typedef {{reason:string}|{guardToken:string, tree:Tree, constraintsDigest:string}} Inspection */
/** @typedef {{readSession?:(id:string)=>Promise<unknown>,execute?:(name:string,args:Json,callId?:string)=>Promise<unknown>,readCommand?:(actor:string,callId:string)=>Promise<import("./recovery.mjs").CommandEvents>}} Host */

export const archiveProtocol = "foundry-conditional-archive/v1";
// Never pass extension fields to the historical id-only archive_session tool:
// its implementation extracts id and may silently ignore every other field.
const guardedTool = "archive_session_if_safe";
const archiveGap = "host-lacks-atomic-archive-guard";
const terminal = new Set(["done", "cancelled", "failed"]);
/** @param {unknown} value */
const object = value => value !== null && typeof value === "object" && !Array.isArray(value) ? record(value) : {};

/** @param {Tx} tx @param {string} goalId @param {string|undefined} taskId @param {Landing|undefined} landing */
function enqueue(tx, goalId, taskId, landing) {
	const creations = tx.list("effects", `WHERE kind='create' AND attempt_id IN
		(SELECT a.id FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE t.goal_id=? ${taskId ? "AND t.id=?" : ""})`,
		taskId ? [goalId, taskId] : [goalId]);
	for (const creation of creations) {
		if (object(creation.result).neverIssued === true || creation.state === "prepared") continue;
		const attempt = tx.get("attempts", creation.attemptId);
		const id = `archive:${attempt.id}`;
		if (tx.optional("effects", id)) continue;
		tx.put("effects", { id, kind: "archive", state: "prepared", attemptId: attempt.id, owner: creation.owner,
			request: json({ creationId: creation.id, goalId, ...(landing ? { landing } : { cancelled: true }) }),
			result: { disposition: "queued" } });
		wake(tx, creation.owner, goalId, `retirement:${attempt.taskId}`);
	}
}

/** Call only in the transaction recording actual or natively reconciled landing.
 * @param {Tx} tx @param {string} goalId @param {Landing} landing @returns {void} */
export function enqueueLandedRetirements(tx, goalId, landing) { enqueue(tx, goalId, undefined, landing); }
/** @param {Tx} tx @param {import("./model.d.ts").Task} task @returns {void} */
export function enqueueCancelledRetirements(tx, task) { enqueue(tx, task.goalId, task.id, undefined); }

/** @param {Tx} tx @param {Effect} effect @param {string} owner */
function target(tx, effect, owner) {
	if (effect.kind !== "archive" || effect.owner !== owner) throw new FoundryError("foreign_archive", "Only the original native creator may retire its session");
	const attempt = tx.get("attempts", effect.attemptId);
	const task = tx.get("tasks", attempt.taskId);
	const goal = tx.get("goals", task.goalId);
	const creation = tx.get("effects", `create:${attempt.id}`);
	const { nativeId } = attempt;
	const restrictions = new Set(goal.scope.restrictions);
	for (const other of nativeId ? tx.list("attempts", "WHERE native_id=?", [nativeId]) : [attempt]) {
		const assigned = tx.get("tasks", other.taskId);
		for (const restriction of [...assigned.scope.restrictions, ...tx.get("goals", assigned.goalId).scope.restrictions]) restrictions.add(restriction);
	}
	return { attempt, task, goal, creation, nativeId, restrictions: [...restrictions].sort() };
}

/** @param {Tx} tx @param {Effect} effect @param {string} owner @param {string} [workspacePath] */
function ledgerBlocker(tx, effect, owner, workspacePath) {
	const { attempt, task, goal, creation, nativeId } = target(tx, effect, owner);
	if (effect.owner !== attempt.creator || creation.owner !== owner || nativeId === owner) return "creation-owner-mismatch";
	if (creation.state !== "settled" || !nativeId || !creation.result || object(creation.result).neverIssued) return "creation-identity-unresolved";
	const spec = object(creation.request);
	if (spec.workspace_type !== "worktree" || spec.coordinate_with_creator !== true || spec.detached || spec.session_kind === "chat") return "not-an-owned-dedicated-worktree";
	if (object(effect.request).cancelled && task.state !== "cancelled") return "cancellation-no-longer-current";
	const completion = tx.optional("goal_completions", goal.id);
	if (completion) {
		const factory = tx.get("factory_controls", completion.factoryId);
		if (factory.state !== "active" || factory.pausedWorkers.includes(owner) || factory.pausedWorkers.includes(nativeId)) return "factory-paused";
		if (!object(effect.request).cancelled && !completion.closed) return "job-open-or-reopened";
	}
	if (tx.list("factory_controls", "WHERE owner=?", [nativeId]).length || tx.list("goals", "WHERE owner=?", [nativeId]).length) return "durable-owner-responsibility";
	if (tx.db.prepare("SELECT 1 FROM squads s JOIN tasks t ON s.task_id=t.id WHERE t.owner=? LIMIT 1").get(nativeId)) return "squad-subscription-owner";
	if (tx.list("tasks", "WHERE (owner=? AND state NOT IN ('done','cancelled','failed')) OR json_extract(document,'$.repairReservation.worker')=?", [nativeId, nativeId]).length)
		return "live-task-or-repair";
	const assigned = tx.list("attempts", "WHERE native_id=?", [nativeId]);
	if (assigned.some(other => other.id !== attempt.id && tx.optional("effects", `create:${other.id}`))) return "ambiguous-native-creation";
	if (assigned.some(other => other.slot || !terminal.has(other.state) || other.waiting?.kind === "input")) return "live-assignment-or-input";
	if (assigned.some(other => {
		const assignedTask = tx.get("tasks", other.taskId);
		return other.taskId !== attempt.taskId && assignedTask.state !== "cancelled"
			&& !(assignedTask.goalId === goal.id && object(effect.request).landing);
	})) return "other-assignment-not-retired";
	const paths = new Set(assigned.flatMap(other => other.executionDirectory ? [other.executionDirectory] : []));
	if (workspacePath) paths.add(workspacePath);
	let creatorDirectory;
	try { creatorDirectory = realpathSync(tx.cwd); } catch { return "creator-workspace-unverified"; }
	if ([...paths].some(directory => creatorDirectory === directory || creatorDirectory.startsWith(`${directory}${sep}`))) return "creator-shares-workspace";
	if (paths.size > 1) return "workspace-path-mismatch";
	for (const directory of paths) {
		if (tx.list("attempts", "WHERE native_id IS NOT ? AND json_extract(document,'$.executionDirectory')=?", [nativeId, directory]).length
			|| tx.list("claims", "WHERE json_extract(document,'$.surface')=?", [directory]).length) return "shared-workspace-or-claim";
	}
	for (const other of assigned) {
		if (tx.list("claims", "WHERE attempt_id=?", [other.id]).length) return "outstanding-claim";
		const pending = effectsForAttempt(tx, other.id).find(item => item.kind !== "archive" && item.state !== "settled");
		if (pending) return `pending-${pending.kind}:${pending.id}`;
	}
	if (tx.list("deliveries", "WHERE owner=? AND state<>'settled'", [nativeId]).length
		|| tx.list("wakes", "WHERE owner=? AND json_extract(document,'$.generation')>json_extract(document,'$.consumed')", [nativeId]).length) return "pending-native-wake";
	const children = tx.list("effects", "WHERE kind='create' AND owner=?", [nativeId]);
	for (const child of children) {
		if (object(child.result).neverIssued) continue;
		const retired = tx.list("effects", "WHERE kind='archive' AND attempt_id=? AND state='settled'", [child.attemptId]);
		if (!retired.some(e => object(e.result).disposition === "archived")) return "unretired-descendant";
	}
	return undefined;
}

/** An explicit reopen/evolution can reuse durable work, but never an archived
 * native worker. Fall back along actual creation receipts, not an arbitrary peer.
 * @param {Tx} tx @param {string} nativeId @returns {string|undefined} */
export function archivedCreator(tx, nativeId) {
	let owner = nativeId;
	const seen = new Set();
	while (!seen.has(owner)) {
		seen.add(owner);
		const effect = tx.list("effects", "WHERE kind='archive' AND state='settled' AND json_extract(document,'$.request.nativeId')=? AND json_extract(document,'$.result.disposition')='archived'", [owner])[0];
		if (!effect) return owner === nativeId ? undefined : owner;
		owner = effect.owner;
	}
	throw new FoundryError("archive_identity_cycle", "Native creation provenance must not cycle");
}

/** Fence new work between ledger issuance and native completion/recovery. This
 * does not exclude historical evidence, usage or the settlement of existing work.
 * @param {Tx} tx @param {string} table @param {Record<string,unknown>} row @returns {void} */
export function guardRetirementWrite(tx, table, row) {
	const directory = table === "claims" ? row.surface : table === "attempts" && !terminal.has(String(row.state)) ? row.executionDirectory : undefined;
	if (typeof directory === "string" && tx.db.prepare(`SELECT 1 FROM effects WHERE kind='archive' AND state IN ('issued','uncertain')
		AND json_extract(document,'$.request.arguments.guard.workspace.path')=? LIMIT 1`).get(directory))
		throw new FoundryError("workspace_retired", "This checkout has an unresolved native archive claim");
	/** @type {unknown[]} */
	let identities;
	if (table === "tasks" && !terminal.has(String(row.state))) identities = [row.owner, object(row.repairReservation).worker];
	else if (table === "attempts" && (row.slot || !terminal.has(String(row.state)) || object(row.waiting).kind === "input")) identities = [row.nativeId, row.creator];
	else if (table === "goals" || table === "factory_controls") identities = [row.owner];
	else if (table === "effects" && row.kind !== "archive" && row.state !== "settled" || table === "claims")
		identities = [row.owner, tx.optional("attempts", String(row.attemptId))?.nativeId];
	else return;
	for (const id of new Set(identities.filter(value => typeof value === "string"))) {
		if (tx.db.prepare(`SELECT 1 FROM effects WHERE kind='archive' AND json_extract(document,'$.request.nativeId')=?
			AND (state IN ('issued','uncertain') OR json_extract(document,'$.result.disposition')='archived') LIMIT 1`).get(String(id)))
			throw new FoundryError("workspace_retired", "This native session is archived or its archive receipt is outstanding; assign a different live owner");
	}
}

/** @param {ReturnType<typeof import("./database.mjs").openDatabase>} db */
export function retirementStore(db) {
	return {
		/** @param {string} actor @param {string} [goalId] */
		retirements(actor, goalId) {
			return db.transaction(tx => tx.list("effects", `WHERE kind='archive' AND owner=? ${goalId ? "AND json_extract(document,'$.request.goalId')=?" : ""}`,
				goalId ? [actor, goalId] : [actor]), false);
		},
		/** @param {string} id @param {string} actor */
		retirementTarget(id, actor) { return db.transaction(tx => {
			const effect = tx.get("effects", id);
			return { ...target(tx, effect, actor), reason: ledgerBlocker(tx, effect, actor) };
		}, false); },
		/** @param {string} id @param {string} actor @param {Inspection} inspection */
		reserveArchive(id, actor, inspection) { return db.transaction(tx => {
			const effect = tx.get("effects", id);
			const { nativeId, restrictions } = target(tx, effect, actor);
			if (effect.state !== "prepared") return;
			const reason = ledgerBlocker(tx, effect, actor, "tree" in inspection ? inspection.tree.path : undefined)
				?? ("tree" in inspection && inspection.constraintsDigest !== digest(json(restrictions)) ? "retention-constraints-changed" : undefined);
			if (reason || "reason" in inspection || !nativeId) {
				const result = { disposition: "retained", reason: reason ?? ("reason" in inspection ? inspection.reason : "creation-identity-unresolved") };
				if (object(effect.result).reason !== result.reason) tx.put("effects", { ...effect, result });
				return;
			}
			const callId = randomUUID();
			const arguments_ = { id: nativeId, guard: { protocol: archiveProtocol, token: inspection.guardToken, owner: actor,
				operationId: callId, workspace: inspection.tree, constraintsDigest: inspection.constraintsDigest } };
			tx.put("effects", { ...effect, state: "issued", request: json({ ...object(effect.request), nativeId, callId, arguments: arguments_ }),
				result: { disposition: "awaiting-native-receipt" } });
			return { arguments: arguments_, callId };
		}); },
		/** @param {string} id @param {string} actor @param {unknown} receipt @param {boolean} recovered */
		archiveReceipt(id, actor, receipt, recovered) { return db.transaction(tx => {
			const effect = tx.get("effects", id);
			target(tx, effect, actor);
			if (!["issued", "uncertain"].includes(effect.state)) return;
			const request = object(effect.request);
			const value = object(receipt);
			const match = value.protocol === archiveProtocol && value.operationId === request.callId && value.sessionId === request.nativeId
				&& value.owner === actor && typeof value.receiptId === "string" && value.receiptId.length > 0;
			if (match && (value.outcome === "archived" || recovered && value.outcome === "not-applied" && typeof value.reason === "string")) {
				const result = { disposition: value.outcome === "archived" ? "archived" : "retained", receipt: json(value), recovered,
					...(value.outcome === "not-applied" ? { reason: value.reason } : {}) };
				tx.put("effects", { ...effect, state: "settled", result: json(result) });
				// Retry only a positively reconciled, unapplied guard conflict, under a
				// fresh token. Permission refusals and unavailable history never retry.
				if (value.outcome === "not-applied" && value.reason === "guard-expired") {
					const { nativeId, callId, arguments: args, ...original } = request;
					tx.put("effects", { ...effect, id: `archive:${effect.attemptId}:${callId}`, state: "prepared",
						request: json({ ...original, previousCallId: callId, expiredToken: object(object(args).guard).token }),
						result: { disposition: "queued" } });
				}
			} else if (effect.state !== "uncertain") tx.put("effects", { ...effect, state: "uncertain",
				result: { disposition: "retained", reason: "archive-issuance-unreconciled" } });
		}); },
	};
}

/** @param {unknown} raw @param {Exclude<Awaited<ReturnType<Store["retirementTarget"]>>,undefined>} target @param {string} databasePath @param {Effect} effect @returns {Inspection} */
function inspect(raw, target, databasePath, effect) {
	const detail = nativeObject(raw);
	if (object(raw).resultType !== undefined && object(raw).resultType !== "success" || !detail
		|| detail.id !== target.nativeId || detail.creator_session_id !== effect.owner || detail.coordinating_creator_session_id !== effect.owner
		|| target.goal.projectId && detail.project_id !== target.goal.projectId) return { reason: "native-owner-or-project-unverified" };
	const name = object(target.creation.request).name;
	if (typeof name !== "string" || detail.name !== nativeSessionName(name)) return { reason: "creation-name-changed-or-unverified" };
	if (detail.awaiting_user_input !== false || detail.awaiting_input || detail.pending_plan || detail.repository_trust) return { reason: "user-input-or-approval-unresolved" };
	if (detail.was_interrupted !== false || object(detail.activity).status !== "idle" || detail.last_error) return { reason: "session-not-confirmed-idle" };
	if (detail.pr_number || detail.pr_url) return { reason: "linked-pull-request" };
	if (typeof detail.path !== "string") return { reason: "workspace-path-unverified" };
	const landing = object(object(effect.request).landing);
	const inspected = inspectRetirementTree(detail.path, databasePath, target.attempt.executionDirectory,
		typeof landing.targetRef === "string" && typeof landing.newTip === "string" ? { targetRef: landing.targetRef, newTip: landing.newTip } : undefined);
	if (!inspected.proof) return { reason: inspected.reason };
	const guard = object(detail.archive_guard);
	if (guard.protocol !== archiveProtocol || typeof guard.token !== "string" || !guard.token || !detail.project_id) return { reason: archiveGap };
	const constraintsDigest = digest(json(target.restrictions));
	if (target.restrictions.length && guard.constraintsDigest !== constraintsDigest) return { reason: "workspace-retention-policy-unverified" };
	if (guard.token === object(effect.request).expiredToken) return { reason: "fresh-native-archive-guard-required" };
	// All fields must be explicit, not inferred from absence in get_session.
	for (const field of ["noOpenPr", "noAgentMerge", "noAutomation", "noUserInput", "noUserRetention", "noUserDrafts", "noDescendants",
		"noRunningWork", "noPendingMessages", "exclusiveWorkspace", "archiveAllowed"]) {
		if (guard[field] !== true) return { reason: `unproven-native-safeguard:${field}` };
	}
	return { guardToken: guard.token, tree: inspected.proof, constraintsDigest };
}

/** Only original owner event history, never model-provided receipts or "not found".
 * @param {Effect} effect @param {Host} host */
async function recover(effect, host) {
	const request = object(effect.request);
	if (!host.readCommand) return;
	const events = await host.readCommand(effect.owner, text(request.callId, "archive call id"));
	const start = record(events.start), end = record(events.completion);
	const a = object(start.data), b = object(end.data);
	if (start.type !== "tool.execution_start" || end.type !== "tool.execution_complete" || start.agentId || end.agentId
		|| a.agentId || b.agentId || a.parentToolCallId || b.parentToolCallId
		|| a.toolCallId !== request.callId || b.toolCallId !== request.callId || toolName(String(a.toolName)) !== guardedTool
		|| a.turnId !== b.turnId || digest(json(a.arguments)) !== digest(json(request.arguments))
		|| b.success !== true) return;
	const result = object(b.result);
	return nativeObject(result.structuredContent ?? { textResultForLlm: result.content })?.archive_receipt;
}

/** @param {Store} db @param {Host} host @param {string} actor @param {string|undefined} goalId @param {()=>boolean} current */
export async function advanceRetirements(db, host, actor, goalId, current) {
	for (const effect of db.retirements(actor, goalId)) {
		if (!current()) break;
		if (effect.state === "settled") continue;
		if (effect.state !== "prepared") {
			let receipt;
			try { receipt = await recover(effect, host); } catch { /* Missing history is not proof of non-issuance. */ }
			db.archiveReceipt(effect.id, actor, receipt, true);
			continue;
		}
		const target = db.retirementTarget(effect.id, actor);
		/** @type {Inspection} */
		let inspection = { reason: target.reason ?? "native-session-inspection-unavailable" };
		if (!target.reason && host.readSession && target.nativeId) {
			try { inspection = inspect(await host.readSession(target.nativeId), target, db.databasePath, effect); }
			catch { /* Missing/malformed owner detail retains the worktree. */ }
		}
		if (!host.execute || !host.readCommand) inspection = { reason: "reason" in inspection ? inspection.reason : "recoverable-native-archive-unavailable" };
		if (!current()) break;
		const issued = db.reserveArchive(effect.id, actor, inspection);
		if (!issued || !host.execute) continue;
		let receipt;
		try {
			const response = await host.execute(guardedTool, issued.arguments, issued.callId);
			if (object(response).resultType === "success") receipt = nativeObject(response)?.archive_receipt;
		} catch { /* The host may have applied the operation. Only reconcile. */ }
		db.archiveReceipt(effect.id, actor, receipt, false);
	}
	return db.retirements(actor, goalId).map(retirementView);
}

/** @param {Effect} effect */
export function retirementView(effect) {
	const result = object(effect.result), request = object(effect.request);
	return { effectId: effect.id, attemptId: effect.attemptId, owner: effect.owner, state: effect.state, goalId: request.goalId,
		disposition: result.disposition, reason: result.reason, receiptId: object(result.receipt).receiptId };
}
