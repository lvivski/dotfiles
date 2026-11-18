import { hasSlot, preparedDispatch, runnable } from "./attempts.mjs";
import { coordinatorsBound } from "./organization.mjs";
import { budgetAvailable, requireAdmission } from "./policy.mjs";
import { inputOutput } from "./tasks.mjs";
import { FoundryError } from "./values.mjs";

/** @param {import("./database.mjs").Transaction} tx @param {import("./model.d.ts").Task} task */
export function lane(tx, task) {
	const result = (/** @type {string} */ reason, /** @type {string} */ next) => ({ taskId: task.id, owner: task.owner, reason, next });
	const goal = tx.get("goals", task.goalId);
	if (task.state === "done") return result("published", "No further execution for this task version; see delivery receipts for landing.");
	if (task.state === "cancelled") return result("cancelled", "Settle outstanding effects; do not dispatch.");
	try { requireAdmission(tx, task); }
	catch (error) {
		if (!(error instanceof FoundryError)) throw error;
		return result(error.code, error.message);
	}
	const attempt = task.currentAttemptId ? tx.get("attempts", task.currentAttemptId) : undefined;
	if (task.waiting?.kind === "input") return result("external-input", `${task.waiting.reason}; native request ${task.waiting.requestId ?? "not recorded"}`);
	if (attempt && (attempt.state === "issued" || attempt.state === "uncertain")) return result("native-receipt", `Reconcile original create:${attempt.id}; never issue a second writer.`);
	if (task.state === "failed" || task.state === "blocked") return result(task.state, task.waiting?.reason ?? "Inspect this attempt's recorded outcome; repair only within the assigned limits.");
	if (!budgetAvailable(tx, goal)) return result("budget", "The goal deadline or observed credit bound is exhausted.");
	if (!coordinatorsBound(tx, task)) return result("prerequisite", "Bind the assigned parent coordinator before staffing this subtree.");
	const missing = task.inputs.filter(input => !inputOutput(tx, input));
	if (missing.length) return result("prerequisite", `Waiting for ${missing.map(input => `${input.taskId}/${input.output}${input.version ? `@${input.version}` : ""}`).join(", ")}.`);
	const peer = tx.list("collaborations", "WHERE json_extract(document,'$.consumerTaskId')=?", [task.id])
		.find(item => item.required && (!item.bound || item.state !== "fulfilled"));
	if (peer) return result("peer-prerequisite", `${peer.destinationTaskId}: ${peer.output} is ${peer.state}; fulfill and bind, or explicitly release.`);
	const unavailable = tx.list("wakes", "WHERE owner=? AND goal_id=?", [task.owner, goal.id]).find(wake => wake.unavailable);
	if (unavailable?.unavailable) return result("unavailable-host", `${unavailable.unavailable.message}; reconcile or hand off to ${unavailable.unavailable.fallback}.`);
	if (preparedDispatch(tx, task)) return result("prepared", "Owner has a reserved native call. Issue on the next supported owner turn.");
	if (task.waiting?.kind === "events") return result(task.coordination && task.coordination.generation > task.coordination.handled ? "coordination-pending" : "no-demand",
		task.coordination && task.coordination.generation > task.coordination.handled ? "Owner drains the unhandled coordination generation." : `Wait for a changed owner generation: ${task.waiting.reason}`);
	if (task.state === "running") return result("executing", "Wait for the worker result, input request or actual command receipt.");
	if (!runnable(tx, task)) return result("prerequisite", task.waiting?.reason ?? "Wait for an eligible dependency or task revision.");
	if (!hasSlot(tx, goal)) return result("capacity", `Wait for a slot release in ${goal.id}; other goals retain their own capacity.`);
	return result("eligible", `Next owner turn may ${task.repairReservation ? "resume the reserved repair" : task.state === "waiting" ? "resume this attempt" : "dispatch"}${task.createdAt ? `; admitted ${task.createdAt}` : ""}.`);
}
