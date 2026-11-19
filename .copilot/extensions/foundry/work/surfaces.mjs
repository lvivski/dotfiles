import { attemptToken } from "./prompt.mjs";
import { FoundryError, record } from "./values.mjs";

/** @param {import("./database.mjs").Transaction} tx @param {string} actor */
export function sharedCoordinator(tx, actor) {
	return Boolean(tx.db.prepare(`SELECT 1 FROM effects e
		JOIN attempts a ON a.id=e.attempt_id JOIN tasks t ON t.id=a.task_id WHERE a.native_id=? AND e.kind='create'
		AND json_extract(e.document,'$.request.workspace_type')='branch' AND json_extract(t.document,'$.role')='coordinator' LIMIT 1`).get(actor));
}

/** @param {import("./model.d.ts").Task} task @param {string|undefined} base @returns {"branch"|"worktree"} */
export function workspaceFor(task, base) {
	// A branch session inherits the existing checkout. Never pass a base ref
	// that would switch everybody sharing it to a different revision.
	return task.role === "coordinator" && base === undefined && !task.dispatch?.generator ? "branch" : "worktree";
}

const ledger = new Set([
	"foundry_get_context", "foundry_advance", "foundry_inspect_evidence", "foundry_observe_work",
	"foundry_wait_task", "foundry_dispatch", "foundry_create_task", "foundry_create_unit", "foundry_cancel_task",
	"foundry_request_collaboration", "foundry_respond_collaboration", "foundry_record_signal", "foundry_record_lesson",
	"foundry_reconcile_native", "foundry_mark_wake_sent", "foundry_handoff_task", "foundry_reassign_task", "foundry_reassign_unit",
	"foundry_retry_task", "foundry_evolve_task", "foundry_delivery",
	"get_session", "send_session_message", "ask_user", "task_complete",
]);
/** @param {string} name @param {unknown} args @param {(token:string)=>boolean} isPrepared @returns {void} */
export function guardSharedTool(name, args, isPrepared) {
	if (ledger.has(name)) return;
	if (name === "create_session") {
		const kickoff = record(record(args).kickoff ?? {});
		const token = typeof kickoff.prompt === "string" ? attemptToken(kickoff.prompt) : undefined;
		if (token && isPrepared(token)) return; // Normal pre-hook verifies exact immutable request.
	}
	throw new FoundryError("ledger_surface", "This coordinator shares a branch checkout for ledger work only. Dispatch an isolated producer for commands, checks or edits.");
}
