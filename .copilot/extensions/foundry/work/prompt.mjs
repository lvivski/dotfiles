/** @typedef {import("./model.js").Goal} Goal */
/** @typedef {import("./model.js").Task} Task */
/** @typedef {import("./model.js").Attempt} Attempt */

/** @param {Goal} goal @param {Task} task @param {Attempt} attempt @param {string[]} [context] @returns {string} */
export function assignmentPrompt(goal, task, attempt, context = []) {
	return [
		`Foundry attempt: ${attempt.token}`,
		`Goal: ${goal.title} (${goal.id})`,
		`Task: ${task.title} (${task.id}); attempt ${attempt.id}.`,
		`Local accountable coordinator: ${attempt.creator}.`,
		"",
		"Start this assignment now under the user's scope and native permissions; no readiness acknowledgment is needed.",
		task.assignment,
		...(task.role === "coordinator" ? [
			"",
			"Own the combined result. Foundry staffs producers named on a milestone observation; do not duplicate them. Follow discovery actions from foundry_advance and handle only remaining prepared native calls.",
			`Keep this coordinator attempt between events. Yield capacity with foundry_wait_task kind:events, attemptId ${attempt.id}. Mark a generation handled only after dealing with its work.`,
			"Use foundry_request_collaboration for a missing named peer output. The director owns priorities, cross-team tradeoffs and shared delivery blockers, not routine staffing.",
		] : []),
		"",
		`Execution scope: ${JSON.stringify(task.scope)}`,
		`Shared goal limits: ${JSON.stringify(goal.limits)}. These are not fresh per-child budgets.`,
		...(task.role !== "coordinator" ? [
			`Assigned acceptance checks: ${JSON.stringify(attempt.checks.map(({ id, version, requirement, kind }) => ({ id, version, requirement, kind })))}`,
			`Versioned inputs: ${JSON.stringify(attempt.inputs)}`,
			...(attempt.checks.length ? ["Use foundry_get_context with assignmentId and checkId for an exact evaluator when needed."] : []),
			"Run assigned checks with foundry_run_check (repair:true for a same-worker retry). Publish with publish:<output name> or foundry_report_result. A parked repair stays with you; resume it with foundry_start_task after the capacity wake.",
		] : []),
		...(attempt.checks.some(check => check.artifactFiles) ? [
			"Artifact-bound checks execute a captured file bundle, not the mutable checkout. Include required evaluator files with pinned oracleFiles. Report code/artifact outputs using the returned evidence.candidate.version and its reference or a declared filename; publication retains those evaluated bytes. All artifact-bound checks for this unit must evaluate the same final file set/version.",
			"When you intend to publish the complete evaluated unit, pass publish:<output name> to foundry_run_check. It publishes through the normal result path only after every governing check passes on the same candidate; incomplete acceptance keeps the task running.",
		] : []),
		...(context.length ? ["Relevant context:", ...context] : []),
		"",
		"Wait only on a concrete dependency, capacity, or verified native request. Use foundry_get_context for changed records or a delivery fallback; never replay an uncertain send or command.",
		task.scope.delegation
			? "Use foundry_create_task and foundry_dispatch only for independent work not already assigned. Started workers are already running."
			: "This task does not authorize further delegation or creation of sessions.",
		"Use send_session_message for scoped questions, advisory feedback, and handoff notes when you know the native session bound to the peer's assignment. A directory owner alone does not establish that binding. If you cannot identify or reach the peer and work is blocked, ask your local coordinator for help. Escalate decisions outside your scope there too. Do not turn advisory feedback into a dependency.",
		"Report concrete blockers or native input requests to the current local owner. Do not broaden scope, commit, push or release without the user's actual authorization.",
	].join("\n");
}

/** @param {string} prompt @returns {string|undefined} */
export function attemptToken(prompt) {
	return /(?:^|\n)Foundry attempt: ([a-zA-Z0-9_-]+)(?:\n|$)/u.exec(prompt)?.[1];
}
