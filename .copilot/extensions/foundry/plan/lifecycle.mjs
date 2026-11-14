import { isList, isOneOf } from "../data.mjs";
import { assertKnownKeys, assertPlainObject, clone, fail, nowIso, requireActor } from "./fields.mjs";
import { emptyVerification } from "./schemas/verification.mjs";
import { validatePlan } from "./validation.mjs";
import { LIMITS, PLAN_STATUS, PLAN_STATUS_VALUES, TASK_STATUS, VERIFICATION_STATUS } from "./values.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("../types/plan.js").FoundryTask} FoundryTask */

const DRAFT_INPUT_KEYS = new Set([
	"id",
	"title",
	"objective",
	"constraints",
	"repository",
	"planning",
	"factory",
	"evaluationTarget",
	"tasks",
]);

const DRAFT_TASK_KEYS = new Set([
	"id",
	"title",
	"kind",
	"description",
	"dependsOn",
	"acceptanceCriteria",
	"expectedFiles",
	"deliveryRequirement",
]);

/**
 * Allowed top-level plan transitions excluding specialized workflows.
 *
 * @type {Readonly<Record<string, Set<string>>>}
 */
export const PLAN_TRANSITIONS = Object.freeze({
	[PLAN_STATUS.DRAFT]: new Set([
		PLAN_STATUS.AWAITING_APPROVAL,
		PLAN_STATUS.CANCELLING,
	]),
	[PLAN_STATUS.AWAITING_APPROVAL]: new Set([
		PLAN_STATUS.APPROVED,
		PLAN_STATUS.CANCELLING,
	]),
	[PLAN_STATUS.APPROVED]: new Set([
		PLAN_STATUS.RUNNING,
		PLAN_STATUS.FAILED,
		PLAN_STATUS.CANCELLING,
	]),
	[PLAN_STATUS.RUNNING]: new Set([
		PLAN_STATUS.AWAITING_COMPLETION_APPROVAL,
		PLAN_STATUS.FAILED,
		PLAN_STATUS.CANCELLING,
	]),
	[PLAN_STATUS.AWAITING_COMPLETION_APPROVAL]: new Set([
		PLAN_STATUS.COMPLETED,
		PLAN_STATUS.CANCELLING,
	]),
	[PLAN_STATUS.FAILED]: new Set([PLAN_STATUS.CANCELLING]),
	[PLAN_STATUS.CANCELLING]: new Set([PLAN_STATUS.CANCELLED]),
	[PLAN_STATUS.COMPLETED]: new Set(),
	[PLAN_STATUS.CANCELLED]: new Set(),
});

/**
 * Creates a revision-one draft from a validated planning blueprint.
 *
 * @param {unknown} input
 * @param {{now?: Date|string|number|(() => Date|string|number)}} [options]
 * @returns {FoundryPlan}
 */
export function createDraftPlan(input, options = {}) {
	assertPlainObject(input, "input");
	assertKnownKeys(input, DRAFT_INPUT_KEYS, "input");
	if (!isList(input.tasks)) {
		fail("invalid_tasks", "input.tasks must be an array", { path: "input.tasks" });
	}

	const timestamp = nowIso(options.now);
	const plan = {
		revision: 1,
		id: input.id,
		title: input.title,
		objective: input.objective,
		constraints: clone(input.constraints ?? []),
		status: PLAN_STATUS.DRAFT,
		repository: clone(input.repository),
		planning: clone(input.planning ?? null),
		factory: clone(input.factory ?? null),
		evaluationTarget: clone(input.evaluationTarget ?? null),
		factoryVerification: null,
		tasks: input.tasks.map((task, index) => {
			assertPlainObject(task, `input.tasks[${index}]`);
			assertKnownKeys(task, DRAFT_TASK_KEYS, `input.tasks[${index}]`);
			return {
				id: task.id,
				title: task.title,
				kind: task.kind,
				description: task.description,
				dependsOn: clone(task.dependsOn ?? []),
				status: TASK_STATUS.PLANNED,
				acceptanceCriteria: clone(task.acceptanceCriteria ?? []),
				expectedFiles: clone(task.expectedFiles ?? []),
				deliveryRequirement: task.deliveryRequirement,
				attempts: [],
			};
		}),
		gates: {
			planApprovedAt: null,
			planApprovedBy: null,
			completionApprovedAt: null,
			completionApprovedBy: null,
		},
		verification: emptyVerification(),
		cancellation: null,
		activity: [{
			event: "plan-created",
			at: timestamp,
			revision: 1,
		}],
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	return validatePlan(plan);
}

/**
 * Applies a non-specialized top-level plan transition.
 *
 * Cancellation, verification reservation, and correction retry use dedicated
 * functions because they update multiple coupled sub-states.
 *
 * @param {FoundryPlan} plan
 * @param {string} nextStatus
 * @param {{actor?: string, at?: Date|string|number}} [options]
 * @returns {FoundryPlan}
 */
export function transitionPlan(plan, nextStatus, options = {}) {
	validatePlan(plan);
	if (!isOneOf(nextStatus, PLAN_STATUS_VALUES)) {
		fail("invalid_plan_status", `Unknown target plan status ${String(nextStatus)}`, {
			path: "status",
		});
	}
	if (nextStatus === PLAN_STATUS.CANCELLING || nextStatus === PLAN_STATUS.CANCELLED) {
		fail("specialized_transition_required", "Cancellation must use the cancellation workflow", {
			path: "status",
		});
	}
	const allowed = PLAN_TRANSITIONS[plan.status];
	if (!allowed.has(nextStatus)) {
		fail("invalid_plan_transition", `Cannot move plan from ${plan.status} to ${nextStatus}`, {
			path: "status",
			details: { from: plan.status, to: nextStatus },
		});
	}
	const timestamp = nowIso(options.at);
	const candidate = clone(plan);
	candidate.status = nextStatus;
	candidate.updatedAt = timestamp;

	if (nextStatus === PLAN_STATUS.APPROVED) {
		requireActor(options.actor, "actor");
		candidate.gates.planApprovedAt = timestamp;
		candidate.gates.planApprovedBy = options.actor;
	}
	if (nextStatus === PLAN_STATUS.COMPLETED) {
		requireActor(options.actor, "actor");
		candidate.gates.completionApprovedAt = timestamp;
		candidate.gates.completionApprovedBy = options.actor;
	}

	validatePlan(candidate);
	return candidate;
}

/**
 * Records initial plan approval and resolves dependency-ready tasks.
 *
 * @param {FoundryPlan} plan
 * @param {string} actor
 * @param {{at?: Date|string|number}} [options]
 * @returns {FoundryPlan}
 */
export function approvePlan(plan, actor, options = {}) {
	return transitionPlan(plan, PLAN_STATUS.APPROVED, {
		actor,
		at: options.at,
	});
}

/**
 * Computes the selected correction tasks and every transitive descendant.
 *
 * @param {FoundryTask[]} tasks
 * @param {string[]} taskIds
 * @returns {Set<string>}
 */
function correctionClosure(tasks, taskIds) {
	const selected = new Set(taskIds);
	let changed = true;
	while (changed) {
		changed = false;
		for (const task of tasks) {
			if (!selected.has(task.id)
				&& task.dependsOn.some((dependencyId) => selected.has(dependencyId))) {
				selected.add(task.id);
				changed = true;
			}
		}
	}
	return selected;
}

/**
 * Starts a correction wave after failed verification while retaining attempts.
 *
 * @param {FoundryPlan} plan
 * @param {string} actor
 * @param {{at?: Date|string|number}} [options]
 * @returns {FoundryPlan}
 */
export function retryFailedPlan(plan, actor, options = {}) {
	validatePlan(plan);
	if (plan.status !== PLAN_STATUS.FAILED
		|| plan.verification.status !== VERIFICATION_STATUS.FAILED) {
		fail("invalid_plan_transition", `Plan ${plan.id} has no failed verification to correct`, {
			path: "status",
		});
	}
	requireActor(actor, "actor");
	const candidate = clone(plan);
	const reopened = correctionClosure(candidate.tasks, candidate.verification.correctionTaskIds);
	for (const task of candidate.tasks) {
		if (reopened.has(task.id)) {
			task.status = TASK_STATUS.PLANNED;
		}
	}
	candidate.status = PLAN_STATUS.RUNNING;
	const timestamp = nowIso(options.at);
	candidate.activity = [...candidate.activity, {
		event: "plan-approved:retry",
		at: timestamp,
		revision: plan.revision + 1,
		actor,
		...(plan.verification.runId ? { verificationRunId: plan.verification.runId } : {}),
	}];
	candidate.verification = emptyVerification();
	candidate.updatedAt = timestamp;
	return validatePlan(candidate);
}
