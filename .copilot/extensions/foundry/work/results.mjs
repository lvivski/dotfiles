import { bindCandidateOutputs, normalizeCandidateOutputs, readCandidate } from "./artifacts.mjs";
import { releaseSlot, retryTask, runnable, startLocalTask } from "./attempts.mjs";
import { releaseOwnedClaims } from "./claims.mjs";
import { outstanding, retirePrepared } from "./effects.mjs";
import { productionClosure } from "./jobs.mjs";
import { ancestors, authorized, budgetAvailable, requireOwner, requireReporter } from "./policy.mjs";
import { decodeResult } from "./records.mjs";
import { inputOutput, resolvedInputs } from "./tasks.mjs";
import { FoundryError, containsPath, decodeEvidence, digest, json, latestEvidence, record, text } from "./values.mjs";
import { notifyOutcome, wake, wakeCapacity } from "./wakes.mjs";

/** @typedef {import("./model.d.ts").Task} Task */
/** @typedef {import("./model.d.ts").Attempt} Attempt */
/** @typedef {import("./model.d.ts").Effect} Effect */
/** @typedef {import("./model.d.ts").Result} Result */

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @param {Attempt} attempt @param {Result} result */
export function canPromote(tx, task, attempt, result) {
	if (task.currentAttemptId !== attempt.id || task.version !== attempt.taskVersion
		|| task.state === "cancelled" || ancestors(tx, task).some((parent) => parent.state === "cancelled")
		|| attempt.nativeId !== result.sender || !["running", "waiting"].includes(task.state)
		|| ["done", "failed", "cancelled"].includes(attempt.state)
		|| checksDigest(tx, task.checks) !== checksDigest(tx, attempt.checks)) return false;
	if (tx.optional("goal_completions", task.goalId)) {
		const completion = tx.get("goal_completions", task.goalId);
		const factory = tx.get("factory_controls", completion.factoryId);
		if (factory.state !== "active" || factory.pausedWorkers.includes(task.owner)
			|| attempt.nativeId !== undefined && factory.pausedWorkers.includes(attempt.nativeId)) return false;
		if (result.state === "done" && result.outputs.some(output => output.kind === "code")
			&& (!attempt.checks.length || attempt.checks.some(check => !check.artifactFiles?.length))) {
			throw new FoundryError("unattended_acceptance", "Factory code delivery requires executable checks bound to its evaluated files");
		}
	}
	const inputs = resolvedInputs(tx, task);
	if (!inputs || digest(json(inputs)) !== digest(json(attempt.inputs))) return false;
	const observations = admittedEvidence(tx, attempt.id);
	const admitted = new Map(observations.map(evidence => [evidence.id, evidence]));
	const latest = latestEvidence(observations);
	if (result.evidence.some((evidence) => {
		const check = attempt.checks.find((item) => item.id === evidence.checkId && item.version === evidence.checkVersion);
		const actual = admitted.get(evidence.id);
		return evidence.attemptId !== attempt.id || !check
			|| !actual || digest(json(actual)) !== digest(json(evidence));
	})) return false;
	if (result.state === "done" && attempt.checks.some((check) => {
		const evidence = latest.get(JSON.stringify([check.id, check.version]));
		return !evidence || evidence.outcome !== "passed" || !result.evidence.some((item) => item.id === evidence.id);
	})) return false;
	if (result.state === "done") for (const input of attempt.inputs) {
		const output = inputOutput(tx, input);
		if (output) readCandidate(output.reference, output.version, tx.databasePath);
	}
	const completion = tx.optional("goal_completions", task.goalId);
	if (result.state === "done" && completion?.taskId === task.id) {
		if (tx.list("collaborations").some(item => item.required
			&& (item.goalId === task.goalId && (item.state !== "fulfilled" || !item.bound)
				|| item.destinationGoalId === task.goalId && item.producerTaskId && item.state !== "fulfilled"))) return false;
		const closure = productionClosure(tx, completion);
		if (closure.some(producer => producer.id !== task.id && producer.state !== "done")) return false;
		if (closure.some(producer => producer.inputs.some(input => tx.get("tasks", input.taskId).goalId !== task.goalId && input.version === undefined))) {
			throw new FoundryError("floating_external_input", "Required cross-goal inputs must pin their fulfilled published version before acceptance");
		}
		completion.accepted = { revision: completion.revision, tasks: closure.map(producer => ({
			id: producer.id, version: producer.version, inputs: resolvedInputs(tx, producer) ?? [],
		})) };
		completion.closed = true;
		tx.put("goal_completions", completion);
		for (const coordinator of tx.list("tasks", "WHERE goal_id=? AND json_extract(document,'$.role')='coordinator' AND state NOT IN ('cancelled','failed')", [task.goalId])) {
			coordinator.state = "done";
			if (coordinator.currentAttemptId) {
				const lease = tx.get("attempts", coordinator.currentAttemptId);
				retirePrepared(tx, lease, "job accepted");
				lease.state = "done";
				lease.endedBy = result.sender;
				tx.put("attempts", lease);
				releaseSlot(tx, lease);
			}
			tx.put("tasks", coordinator);
		}
	}
	return true;
}

/** @param {import("./database.mjs").Transaction} tx @param {Result} result @param {boolean} [quiet] */
export function promote(tx, result, quiet = false) {
	const attempt = tx.get("attempts", result.attemptId);
	const task = tx.get("tasks", attempt.taskId);
	if (task.role === "coordinator") throw new FoundryError("coordination_result", "Publish bounded producer/integration work, not the coordinator's continuing role; yield with an event disposition");
	if (!canPromote(tx, task, attempt, result)) return false;
	if (result.state === "done") {
		result.outputs = bindCandidateOutputs(attempt.checks, admittedEvidence(tx, attempt.id), result.outputs, tx.databasePath);
		for (const output of result.outputs) {
			const published = inputOutput(tx, { taskId: task.id, output: output.name, version: output.version });
			if (published && digest(json(published)) !== digest(json(output))) {
				throw new FoundryError("output_version_conflict", "A published output version cannot change its reference or meaning");
			}
		}
	}
	task.state = result.state;
	delete task.waiting;
	if (result.state === "done") task.outputs = result.outputs;
	attempt.state = result.state === "done" ? "done" : "failed";
	attempt.endedBy = result.reportedBy ?? result.sender;
	tx.put("tasks", task);
	tx.put("attempts", attempt);
	releaseSlot(tx, attempt, !quiet, quiet && result.state === "failed");
	if (!quiet) notifyOutcome(tx, task);
	if (result.state === "done") {
		const consumers = tx.db.prepare("SELECT DISTINCT task_id FROM dependencies WHERE producer_id=?").all(task.id);
		for (const row of consumers) {
			const consumer = tx.get("tasks", text(row.task_id, "consumer"));
			if (runnable(tx, consumer)) wake(tx, consumer.owner, consumer.goalId, `output:${task.id}`);
		}
	}
	return true;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} attemptId @param {string} [effectId] @returns {import("./model.d.ts").Evidence[]} */
export function admittedEvidence(tx, attemptId, effectId) {
	return tx.db.prepare(`SELECT document FROM evidence_admissions WHERE attempt_id=?
		${effectId === undefined ? "" : "AND effect_id=?"} ORDER BY sequence`)
		.all(...(effectId === undefined ? [attemptId] : [attemptId, effectId])).map((row) => {
		/** @type {unknown} */
		const parsed = JSON.parse(text(row.document, "admitted evidence"));
		return decodeEvidence(parsed);
	});
}

/** @param {import("./database.mjs").Transaction} tx @param {import("./model.d.ts").Check[]} checks */
export function checksDigest(tx, checks) {
	return digest(json(checks.map(({ requirement: _prose, ...check }) => check).sort((a, b) => a.id.localeCompare(b.id))));
}

/** @param {import("./database.mjs").Transaction} tx @param {import("./model.d.ts").Check[]} checks @param {import("./model.d.ts").Scope} scope */
export function checkArtifactScope(tx, checks, scope) {
	for (const name of checks.flatMap(check => check.artifactFiles ?? [])) {
		if (name === "." || name.split("/")[0] === ".git" || !scope.paths.some(base => containsPath(base, name))) {
			throw new FoundryError("artifact_scope", `Declared artifact must be an implementation file inside this task's paths: ${name}`);
		}
	}
}

/** @param {import("./database.mjs").Transaction} tx @param {Effect} effect */
export function admitEffectEvidence(tx, effect) {
	if (effect.kind !== "command" || effect.state !== "settled" || effect.result === null
		|| typeof effect.result !== "object" || Array.isArray(effect.result) || effect.result.evidence === undefined) return;
	const observations = Array.isArray(effect.result.evidence) ? effect.result.evidence : [effect.result.evidence];
	for (const value of observations) {
		const evidence = decodeEvidence(value);
		const existing = tx.db.prepare("SELECT document FROM evidence_admissions WHERE id=?").get(evidence.id);
		if (existing) {
			/** @type {unknown} */
			const parsed = JSON.parse(text(existing.document, "admitted evidence"));
			if (digest(json(decodeEvidence(parsed))) !== digest(json(evidence))) {
				throw new FoundryError("evidence_identity_conflict", "An observation identity cannot change its assigned attempt or content");
			}
			continue;
		}
		tx.db.prepare("INSERT INTO evidence_admissions(id,attempt_id,effect_id,check_id,check_version,document) VALUES(?,?,?,?,?,?)")
			.run(evidence.id, evidence.attemptId, effect.id, evidence.checkId, evidence.checkVersion, JSON.stringify(evidence));
	}
}

/**
 * reportedSender is a separately supplied, native-verified identity for
 * parent-local reporting; it is never read from the result payload.
 * @param {import("./database.mjs").Transaction} tx
 * @param {Omit<Result, "createdAt" | "sender">} input @param {string} actor
 * @param {string} [reportedSender] @param {boolean} [quiet]
 * @returns {{result: Result, promoted: boolean}}
 */
export function recordResult(tx, input, actor, reportedSender, quiet = false) {
	text(actor, "actor");
	const attempt = tx.get("attempts", input.attemptId);
	const task = tx.get("tasks", attempt.taskId);
	const sender = reportedSender === undefined ? actor : text(reportedSender, "reportedSender");
	if (reportedSender !== undefined) requireOwner(tx, task, actor);
	else if (attempt.nativeId) requireReporter(tx, attempt, actor);
	else if (tx.list("tasks", "WHERE owner=?", [actor]).length && !authorized(tx, task, actor)) {
		throw new FoundryError("forbidden", "A sibling cannot report another worker's result");
	}
	const existing = tx.optional("results", input.id);
	const result = decodeResult({ ...record(input), sender,
		reportedBy: existing === undefined ? actor : existing.reportedBy, createdAt: existing?.createdAt ?? tx.timestamp() });
	if (new Set(result.outputs.map((output) => output.name)).size !== result.outputs.length
		|| new Set(result.evidence.map((evidence) => evidence.id)).size !== result.evidence.length) {
		throw new FoundryError("duplicate_evidence", "Output names and evidence identities must be unique within a result");
	}
	if (existing) {
		const alreadyPromoted = tx.db.prepare("SELECT promoted FROM outcomes WHERE result_id=?").get(existing.id)?.promoted === 1;
		if (alreadyPromoted && result.state === "done") {
			const reported = new Set(existing.evidence.map(evidence => evidence.id));
			result.outputs = normalizeCandidateOutputs(attempt.checks,
				admittedEvidence(tx, attempt.id).filter(evidence => reported.has(evidence.id)), result.outputs, tx.databasePath);
		}
		if (digest(json(existing)) !== digest(json(result))) throw new FoundryError("result_identity_conflict", "A result identity cannot be reused for a different observation");
		const promoted = alreadyPromoted || promote(tx, existing, quiet);
		tx.put("results", existing);
		tx.db.prepare("UPDATE outcomes SET promoted=? WHERE result_id=?").run(promoted ? 1 : 0, existing.id);
		return { result: existing, promoted };
	}
	const promoted = promote(tx, result, quiet);
	tx.put("results", result);
	tx.db.prepare("INSERT INTO outcomes(result_id,promoted) VALUES(?,?)").run(result.id, promoted ? 1 : 0);
	return { result, promoted };
}

/** @param {import("./database.mjs").Transaction} tx @param {Omit<Result, "createdAt" | "sender">} input @param {string} actor */
export function recordResultAndRepair(tx, input, actor) {
	const previouslyPromoted = tx.db.prepare("SELECT promoted FROM outcomes WHERE result_id=?").get(input.id)?.promoted === 1;
	const recorded = recordResult(tx, input, actor, undefined, input.state === "failed");
	const old = tx.get("attempts", input.attemptId);
	const task = tx.get("tasks", old.taskId);
	if (old.nativeId !== actor) throw new FoundryError("foreign_execution", "A local repair must retain the actual reporting worker");
	const announce = () => {
		releaseOwnedClaims(tx, tx.get("attempts", old.id));
		if (recorded.promoted && recorded.result.state === "failed" && !previouslyPromoted) {
			notifyOutcome(tx, task);
			wakeCapacity(tx, task.goalId);
		}
	};
	if (!recorded.promoted || recorded.result.state !== "failed") {
		announce();
		return { ...recorded, continuation: { state: "not-repaired", code: "unpromoted_failure" } };
	}
	const latest = latestEvidence(recorded.result.evidence);
	if (!old.checks.some(check => latest.get(JSON.stringify([check.id, check.version]))?.outcome === "failed")) {
		announce();
		return { ...recorded, continuation: { state: "not-repaired", code: "checked_failure_required" } };
	}
	const resumeRepair = task.repairReservation?.attemptId === old.id && task.repairReservation.worker === actor
		&& task.currentAttemptId === old.id && task.version === old.taskVersion + 1 && task.state === "ready";
	if (!resumeRepair && (task.currentAttemptId !== old.id || task.version !== old.taskVersion)) {
		const currentAttempt = task.currentAttemptId ? tx.get("attempts", task.currentAttemptId) : undefined;
		return { ...recorded, continuation: currentAttempt?.repairOf === old.id && currentAttempt.nativeId === actor
			? { state: currentAttempt.state, attempt: currentAttempt }
			: { state: "not-repaired", code: "already-recorded-or-superseded" } };
	}
	if (outstanding(tx, old, true)) {
		announce();
		return { ...recorded, continuation: { state: "waiting", code: "command_settlement_required" } };
	}
	if (!budgetAvailable(tx, tx.get("goals", task.goalId))) {
		announce();
		return { ...recorded, continuation: { state: "blocked", code: "limit_exhausted",
			message: "The goal's observed credits or absolute deadline are exhausted" } };
	}
	try { if (!resumeRepair) retryTask(tx, task.id, old.id, actor, false, true); }
	catch (error) {
		if (!(error instanceof FoundryError) || !["repair_limit", "stagnation"].includes(error.code)) throw error;
		announce();
		return { ...recorded, continuation: { state: "blocked", code: error.code, message: error.message } };
	}
	let next;
	try { next = startLocalTask(tx, task.id, actor, old.id); }
	catch (error) {
		if (!(error instanceof FoundryError) || error.code !== "limit_exhausted") throw error;
		announce();
		return { ...recorded, continuation: { state: "blocked", code: error.code, message: error.message } };
	}
	if (next instanceof FoundryError) announce();
	return { ...recorded, continuation: next instanceof FoundryError
		? { state: "waiting", code: next.code, message: next.message, taskId: task.id }
		: { state: next.state, attempt: next } };
}

/** @param {import("./database.mjs").Transaction} tx @param {string} attemptId @returns {Result[]} */
export function resultsForAttempt(tx, attemptId) { tx.get("attempts", attemptId); return tx.list("results", "WHERE attempt_id=?", [attemptId]); }

/** @param {import("./database.mjs").Transaction} tx @param {string} attemptId @param {string} [effectId] @returns {import("./model.d.ts").Evidence[]} */
export function evidenceForAttempt(tx, attemptId, effectId) { tx.get("attempts", attemptId); return admittedEvidence(tx, attemptId, effectId); }
