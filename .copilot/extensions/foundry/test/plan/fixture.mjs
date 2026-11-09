import assert from "node:assert/strict";
import { errorCode } from "../../data.mjs";
import { attachTaskAttempt, completeTaskAttempt, reserveTaskAttempt } from "../../plan/execution.mjs";
import { approvePlan, createDraftPlan, transitionPlan } from "../../plan/lifecycle.mjs";
import { ATTEMPT_STATUS, EVIDENCE_TYPE, PLAN_STATUS } from "../../plan/values.mjs";

/** @typedef {import("../../types/plan.js").BlueprintTask} BlueprintTask */
/** @typedef {{id?: string, title?: string, objective?: string, constraints?: string[], planning?: import("../../types/plan.js").Planning | null, tasks?: BlueprintTask[]}} DraftOptions */

export const CREATED_AT = "2026-08-05T16:00:00.000Z";

const APPROVED_AT = "2026-08-05T16:01:00.000Z";

export const RESERVED_AT = "2026-08-05T16:02:00.000Z";

export const STARTED_AT = "2026-08-05T16:03:00.000Z";

export const COMPLETED_AT = "2026-08-05T16:04:00.000Z";

export const CANCELLED_AT = "2026-08-05T16:05:00.000Z";

/** @param {string} id @param {string[]} [dependsOn] @returns {BlueprintTask} */
export function task(id, dependsOn = []) {
	return {
		id,
		title: `Task ${id}`,
		kind: "implement",
		description: `Implement ${id}`,
		dependsOn,
		acceptanceCriteria: [`${id} is observable`],
		expectedFiles: [`src/${id.toLowerCase()}.mjs`],
		deliveryRequirement: "commit",
	};
}

/** @param {BlueprintTask[]} tasks @returns {BlueprintTask[]} */
function withVerifier(tasks) {
	if (tasks.some((entry) => entry.kind === "verify")) return tasks;
	const dependedOn = new Set(tasks.flatMap((entry) => entry.dependsOn));
	const sinks = tasks.filter((entry) => !dependedOn.has(entry.id));
	let normalized = [...tasks];
	let target = sinks[0];
	if (sinks.length !== 1) {
		target = task("T-998", sinks.map((entry) => entry.id));
		normalized.push(target);
	}
	return [
		...normalized,
		{
			id: "T-997",
			title: "Verify",
			kind: "verify",
			description: "Verify the final delivery",
			dependsOn: [target.id],
			acceptanceCriteria: [],
			expectedFiles: [],
			deliveryRequirement: "commit",
		},
	];
}

/** @param {DraftOptions} [options] */
export function draft(options = {}) {
	const tasks = withVerifier(options.tasks ?? [
		task("T-001"),
		task("T-002", ["T-001"]),
	]);
	return createDraftPlan({
		id: options.id ?? "sample-plan",
		title: options.title ?? "Sample plan",
		objective: options.objective ?? "Deliver a dependency-aware change",
		constraints: options.constraints ?? ["Keep the change scoped"],
		repository: {
			workingDirectory: "/tmp/sample-repository",
			baseBranch: "main",
		},
		planning: options.planning ?? null,
		tasks,
	}, { now: CREATED_AT });
}

/** @param {DraftOptions} [options] */
export function approved(options = {}) {
	const submitted = transitionPlan(draft(options), PLAN_STATUS.AWAITING_APPROVAL, {
		at: CREATED_AT,
	});
	return approvePlan(submitted, "octocat", { at: APPROVED_AT });
}

export function claimedEvidence(summary = "node --test passed") {
	return [{
		type: EVIDENCE_TYPE.TEST,
		summary,
		source: "node --test",
		outcome: "passed",
	}];
}

/**
 * Requires a value in test setup and narrows its type.
 *
 * @template T
 * @param {T | null | undefined} value
 * @param {string} [message]
 * @returns {T}
 */
export function required(value, message = "Expected test fixture value") {
	assert.ok(value, message);
	return value;
}

/** @param {import("../../types/plan.js").FoundryPlan} plan @param {string} taskId
 * @param {NonNullable<Parameters<typeof completeTaskAttempt>[4]> & {reservationId?: string, sessionId?: string, scopeOverride?: import("../../types/plan.js").ScopeOverride}} [options] */
export function completeTask(plan, taskId, options = {}) {
	const reservationId = options.reservationId ?? `reserve-${taskId}-${plan.revision}`;
	let candidate = reserveTaskAttempt(plan, taskId, {
		reservationId,
		scopeOverride: options.scopeOverride ?? null,
		at: RESERVED_AT,
	});
	const taskRecord = required(candidate.tasks.find((entry) => entry.id === taskId));
	const attempt = required(taskRecord.attempts.at(-1));
	candidate = attachTaskAttempt(candidate, taskId, attempt.id, {
		sessionId: options.sessionId ?? `session-${attempt.id}`,
		branch: options.branch ?? `work/${attempt.id.toLowerCase()}`,
		at: STARTED_AT,
	});
	const taskEvidence = taskRecord.kind === "verify"
		? [
			...candidate.tasks
				.filter((entry) => entry.kind === "implement")
				.sort((left, right) => left.id.localeCompare(right.id))
				.flatMap((entry) => entry.acceptanceCriteria.map(
					(_criterion, index) => ({
						checkId: `${entry.id}-C${String(index + 1).padStart(3, "0")}`,
						type: EVIDENCE_TYPE.TEST,
						summary: "Independent check passed",
						source: "node --test",
						outcome: "passed",
					}),
				)),
			{
				checkId: "final-integration",
				type: EVIDENCE_TYPE.INTEGRATION,
				summary: "Integration passed",
				source: "node --test",
				outcome: "passed",
			},
			{
				checkId: "workspace-integrity",
				type: EVIDENCE_TYPE.COMMAND,
				summary: "Workspace remained clean",
				source: "git status --porcelain",
				outcome: "passed",
			},
		]
		: claimedEvidence();
	candidate = completeTaskAttempt(candidate, taskId, attempt.id, ATTEMPT_STATUS.DONE, {
		resultSummary: options.resultSummary ?? `Implemented ${taskId}`,
		evidence: options.evidence ?? taskEvidence,
		branch: options.branch ?? `work/${attempt.id.toLowerCase()}`,
		commit: options.commit ?? "a".repeat(40),
		prUrl: options.prUrl ?? null,
		at: COMPLETED_AT,
	});
	return { plan: candidate, attemptId: attempt.id };
}

/** @param {() => unknown} operation @param {string} code */
export function throwsCode(operation, code) {
	assert.throws(operation, (error) => {
		assert.equal(errorCode(error), code);
		return true;
	});
}
