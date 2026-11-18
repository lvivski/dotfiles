/** @typedef {import("./model.js").Goal} Goal */
/** @typedef {import("./model.js").Task} Task */
/** @typedef {import("./model.js").Attempt} Attempt */

/** @param {Goal} goal @param {Task} task @param {Attempt} attempt @param {string[]} [context] */
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
			"Own this subtree until delivery. Staff ready producers in parallel and assign one integration owner with named inputs and executable checks of the combined candidate. A blocked input or claim stops only dependent work. Keep the delivery scope and governing checks intact.",
			`Before staffing, yield with foundry_wait_task kind:events and attemptId ${attempt.id}; resume before doing your own implementation. Use foundry_advance for locally owned actions and execute the returned prepared calls. Keep this coordinator attempt between events; producers publish the deliverables.`,
			"Once the observed generation is staffed or explicitly waiting/exhausted, record handledGeneration and relevant relatedIds with the event wait. Reading isn't handling. Don't poll or redispatch a waiting coordinator.",
			"Use the directory from foundry_get_context to find peer coordinator tasks. Request needed versioned peer outputs through foundry_request_collaboration and staff accepted requests locally; required commitments must be fulfilled or explicitly released by their source.",
			"The director owns priorities, cross-team tradeoffs and shared delivery blockers that peers cannot resolve. Do not copy the director on routine exchanges, relay them through the hierarchy, or require director approval for work already within scope.",
		] : []),
		"",
		`Execution scope: ${JSON.stringify(task.scope)}`,
		`Shared goal limits: ${JSON.stringify(goal.limits)}. These are not fresh per-child budgets.`,
		`Assigned acceptance checks: ${JSON.stringify(attempt.checks)}`,
		`Versioned inputs: ${JSON.stringify(attempt.inputs)}`,
		...(attempt.checks.some(check => check.artifactFiles) ? [
			"Artifact-bound checks execute a captured file bundle, not the mutable checkout. Include required evaluator files with pinned oracleFiles. Report code/artifact outputs using the returned evidence.candidate.version and its reference or a declared filename; publication retains those evaluated bytes. All artifact-bound checks for this unit must evaluate the same final file set/version.",
			"When you intend to publish the complete evaluated unit, pass publish:<output name> to foundry_run_check. It publishes through the normal result path only after every governing check passes on the same candidate; incomplete acceptance keeps the task running.",
		] : []),
		...(context.length ? ["Relevant context:", ...context] : []),
		"",
		"Run assigned checks with foundry_run_check (repair:true for a same-worker retry). Publish with publish:<output name> or foundry_report_result. A parked repair stays with you; resume it with foundry_start_task after the capacity wake.",
		"Wait only on a concrete dependency, capacity, or verified native request. Use foundry_get_context for changed records or a delivery fallback; never replay an uncertain send or command.",
		task.scope.delegation
			? "Delegate independent work with foundry_create_task and foundry_prepare_dispatch. Execute the complete returned calls; keep independent writers in separate worktrees."
			: "This task does not authorize further delegation or creation of sessions.",
		"Use send_session_message for scoped questions, advisory feedback, and handoff notes when you know the native session bound to the peer's assignment. A directory owner alone does not establish that binding. If you cannot identify or reach the peer and work is blocked, ask your local coordinator for help. Escalate decisions outside your scope there too. Do not turn advisory feedback into a dependency.",
		"Report concrete blockers or native input requests to the current local owner. Do not broaden scope, commit, push or release without the user's actual authorization.",
	].join("\n");
}

/** @param {string} prompt */
export function attemptToken(prompt) {
	return /(?:^|\n)Foundry attempt: ([a-zA-Z0-9_-]+)(?:\n|$)/u.exec(prompt)?.[1];
}
