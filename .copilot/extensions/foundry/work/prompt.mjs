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
		"Execute this complete assignment now under the user's existing scope and native permissions. Bookkeeping does not require a readiness acknowledgment or an activation message.",
		task.assignment,
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
		"Use foundry_get_context only when you need this task's changed records. Run assigned procedures with foundry_run_check, repair:true. A checked failure records evidence and atomically reserves a fresh same-worker attempt under this goal's limits: implement next without report/retry/start bookkeeping, activation or a parent wake. A real capacity/limit wait is explicit; a parked repair remains yours across reload, so resume it with foundry_start_task or the exact failed report after its capacity wake. Report completed outputs with foundry_report_result. Native spend is observed automatically; do not manually repeat its receipts.",
		"Context/check calls recover your finished new runner receipts without rerunning a command; started-only or older unknown effects stay unknown. Self-ended settled claims release automatically and warm repair retains them. If context reports a disabled native message route, deliver its returned wake/stop arguments with the ordinary app tool; mark only the accepted wake generation with foundry_mark_wake_sent. Do not bypass host policy or replay an uncertain delivery.",
		task.scope.delegation
			? "Delegate useful independent recorded work below this task with foundry_create_task and foundry_prepare_dispatch. Pass complete kickoffs and explicit execution mode. Use separate native worktrees for writers. Lightweight in-session work remains part of your attempt."
			: "This task does not authorize further delegation or creation of sessions.",
		"Report concrete blockers or native input requests to the current local owner. Do not forward routine progress through every ancestor, broaden scope, commit, push or release without the user's actual authorization.",
	].join("\n");
}

/** @param {string} prompt */
export function attemptToken(prompt) {
	return /(?:^|\n)Foundry attempt: ([a-zA-Z0-9_-]+)(?:\n|$)/u.exec(prompt)?.[1];
}
