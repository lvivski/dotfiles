import { errorCode, errorMessage, isOneOf } from "../data.mjs";
import { FoundryFactoryError } from "../factory/fields.mjs";
import { isTerminatedSessionState, normalizeInventory, sessionState } from "../inventory.mjs";
import { taskCompletionRequirements } from "../plan/delivery.mjs";
import { attachTaskAttempt, completeTaskAttempt, reserveTaskAttempt, retryTask } from "../plan/execution.mjs";
import { buildDelegationPrompt, buildTaskInitialization } from "../plan/prompt.mjs";
import { activeTaskAttempt } from "../plan/queries.mjs";
import { findScopeConflicts, selectNonOverlappingTasks } from "../plan/scope.mjs";
import { ATTEMPT_STATUS, TASK_STATUS } from "../plan/values.mjs";
import { FoundryOperationError, revisionConflict } from "./errors.mjs";
import { attachVerifierWorktree, checkTaskBootstrap, checkTaskBranchRename } from "../evidence/worktrees.mjs";
import { checkTaskRepository } from "./repository.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("../types/plan.js").FoundryAttempt} FoundryAttempt */
/** @template {keyof typeof import("../requests.mjs").requestShapes} K @typedef {import("../requests.mjs").Request<K>} Request */

/**
 * Finds one attempt by task and attempt identity.
 *
 * @param {FoundryPlan} plan
 * @param {string} taskId
 * @param {string} attemptId
 */
function findAttempt(plan, taskId, attemptId) {
	return plan.tasks.find((task) => task.id === taskId)
		?.attempts.find((attempt) => attempt.id === attemptId) ?? null;
}

/**
 * Surfaces actionable requirements before constructing a completed attempt.
 *
 * @param {FoundryPlan} plan
 * @param {string} taskId
 * @param {FoundryAttempt | null} attempt
 * @param {{resultSummary?: unknown, evidence?: unknown, branch?: unknown, commit?: unknown, prUrl?: unknown}} input
 * @returns {void}
 */
function validateDonePayload(plan, taskId, attempt, input) {
	const task = plan.tasks.find((candidate) => candidate.id === taskId);
	if (!task || !attempt) return;
	const requirements = taskCompletionRequirements(task, {
		...attempt,
		...input,
		branch: input.branch ?? attempt.branch,
	});
	const { requirement } = requirements;
	const missing = [...requirements.missing, ...requirements.missingDelivery];
	if (missing.length > 0) {
		throw new FoundryOperationError(
			"task_completion_incomplete",
			`Task ${taskId} cannot complete without ${missing.join(", ")}`,
			{ taskId, attemptId: attempt.id, requirement, missing },
		);
	}
}

/**
 * Finds the task attempt that owns an idempotent reservation ID.
 *
 * @param {FoundryPlan} plan
 * @param {string} reservationId
 */
function findReservation(plan, reservationId) {
	for (const task of plan.tasks) {
		const attempt = task.attempts.find(
			(candidate) => candidate.reservationId === reservationId,
		);
		if (attempt) return { task, attempt };
	}
	return null;
}

/** @param {{
 * storeFor: ReturnType<typeof import("./storage.mjs").createSessionStorage>["storeFor"],
 * persist: ReturnType<typeof import("./mutation.mjs").createPlanMutations>["persist"],
 * factory: Pick<ReturnType<typeof import("../bridge.mjs").createFactoryBridge>, "requireOwner" | "sync" | "prompt" | "activateEvaluation" | "validateLearning" | "validateReports" | "preflight" | "captureRejectedReport" | "requireRetry">,
 * syncFactoryPlan: ReturnType<typeof import("./repository.mjs").createRepositoryOperations>["syncFactoryPlan"],
 * }} dependencies */
export function createTaskOperations({ storeFor, persist, factory, syncFactoryPlan }) {

	/**
	 * Persists an idempotent attempt reservation before `create_session`.
	 *
	 * @param {Request<"reserveTask">} input
	 */
	const reserveTask = async ({
		planId,
		taskId,
		expectedRevision,
		reservationId,
		scopeOverride,
	}) => {
		const plan = await storeFor().read(planId);
		factory.requireOwner(plan);
		factory.sync(plan);
		factory.prompt(plan, plan.tasks.find((task) => task.id === taskId) ?? { kind: "implement" });
		const existing = findReservation(plan, reservationId);
		if (existing) {
			if (existing.task.id !== taskId) {
				throw new FoundryOperationError(
					"duplicate_request_id",
					`Reservation ${reservationId} belongs to ${existing.task.id}`,
				);
			}
			if (!isOneOf(existing.attempt.status, [
				ATTEMPT_STATUS.RESERVED,
				ATTEMPT_STATUS.RUNNING,
				ATTEMPT_STATUS.CANCEL_REQUESTED,
			])) {
				throw new FoundryOperationError(
					"duplicate_request_id",
					`Reservation ${reservationId} is already terminal`,
				);
			}
			factory.activateEvaluation(plan);
			return {
				plan,
				taskId,
				attemptId: existing.attempt.id,
				baseBranch: existing.attempt.baseBranch,
				integrationRequired: existing.attempt.integrationRequired,
				initialization: buildTaskInitialization(plan, existing.task, existing.attempt),
				delegationPrompt: `${factory.prompt(plan, existing.task)}\n${buildDelegationPrompt(plan, existing.task, existing.attempt)}`,
			};
		}
		if (plan.revision !== expectedRevision) {
			throw revisionConflict(planId, expectedRevision, plan.revision);
		}
		const task = plan.tasks.find((item) => item.id === taskId);
		if (!task) {
			throw new FoundryOperationError(
				"task_not_found",
				`Task ${taskId} does not exist`,
			);
		}
		const running = plan.tasks.filter((item) => item.status === TASK_STATUS.RUNNING);
		const selection = selectNonOverlappingTasks([task], running);
		if (selection.heldTaskIds.includes(taskId) && !scopeOverride) {
			throw new FoundryOperationError(
				"scope_overlap_requires_approval",
				`Task ${taskId} overlaps an active task scope`,
				{
					taskId,
					occupiedTaskIds: selection.occupiedTaskIds,
					conflicts: findScopeConflicts([task, ...running]),
				},
			);
		}
		const updated = await persist(
			planId,
			expectedRevision,
			(current) => {
				const reserved = reserveTaskAttempt(current, taskId, {
					reservationId,
					scopeOverride: scopeOverride ?? null,
				});
				factory.activateEvaluation(reserved);
				return reserved;
			},
			(candidate) => {
				const reserved = findReservation(candidate, reservationId);
				if (!reserved) throw new FoundryOperationError("reservation_invariant_failed", `Task ${taskId} has no reserved attempt`);
				return `task-reserved:${taskId}:${reserved.attempt.id}`;
			},
		);
		const updatedTask = updated.tasks.find((item) => item.id === taskId);
		const attempt = updatedTask ? activeTaskAttempt(updatedTask) : null;
		if (!updatedTask || !attempt) {
			throw new FoundryOperationError(
				"reservation_invariant_failed",
				`Task ${taskId} has no active persisted attempt`,
			);
		}
		return {
			plan: updated,
			taskId,
			attemptId: attempt.id,
			baseBranch: attempt.baseBranch,
			integrationRequired: attempt.integrationRequired,
			initialization: buildTaskInitialization(updated, updatedTask, attempt),
			delegationPrompt: `${factory.prompt(updated, updatedTask)}\n${buildDelegationPrompt(updated, updatedTask, attempt)}`,
		};
	};

	/**
	 * Attaches an App child session to its reserved attempt.
	 *
	 * @param {Request<"attachTask">} input
	 */
	const attachTask = async ({
		planId,
		taskId,
		attemptId,
		expectedRevision,
		sessionId,
		branch,
		rename,
		bootstrap,
	}) => {
		const plan = await storeFor().read(planId);
		factory.requireOwner(plan);
		const current = findAttempt(plan, taskId, attemptId);
		if (current?.sessionId === sessionId
			&& current.branch === (branch ?? null)) {
			return plan;
		}
		if (plan.revision !== expectedRevision) {
			throw revisionConflict(planId, expectedRevision, plan.revision);
		}
		if (bootstrap && (!current || current.sessionId !== null || current.status !== ATTEMPT_STATUS.RESERVED || rename)) {
			throw new FoundryOperationError("task_bootstrap_mismatch", "Setup corroboration applies only to the same unattached reserved attempt, not a replacement or rename");
		}
		if (rename) {
			if (!current || current.sessionId !== sessionId || !current.startedAt
				|| current.branch !== rename.fromBranch || !branch) {
				throw new FoundryOperationError("task_branch_rename_mismatch", "Reconciliation must retain the exact attached session and previous branch");
			}
			const pinned = current.verifierWorktree ?? current.branchRenames?.at(-1)?.worktree;
			if (plan.tasks.find((task) => task.id === taskId)?.kind === "verify" && !pinned) {
				throw new FoundryOperationError("task_branch_rename_unsupported", "The verifier's original worktree identity was not captured");
			}
			const observed = checkTaskBranchRename(
				plan.repository.workingDirectory, rename.fromBranch, branch, rename.worktreePath,
				current.startedAt, pinned,
			);
			const branchRename = {
				from: rename.fromBranch, to: branch, actor: rename.actor, reason: rename.reason,
				at: new Date().toISOString(), ...observed,
			};
			return persist(
				planId, expectedRevision,
				(candidate) => attachTaskAttempt(candidate, taskId, attemptId, { sessionId, branch, branchRename }),
				`task-branch-reconciled:${taskId}:${attemptId}`,
			);
		}
		const bootstrapWorktree = bootstrap && current
			? checkTaskBootstrap(plan.repository.workingDirectory, current.baseBranch, branch ?? null, bootstrap) : undefined;
		const verifierWorktree = plan.tasks.find((task) => task.id === taskId)?.kind === "verify"
			? bootstrapWorktree ?? attachVerifierWorktree(plan.repository.workingDirectory, branch ?? null) : undefined;
		return persist(
			planId,
			expectedRevision,
			(current) => attachTaskAttempt(current, taskId, attemptId, {
				sessionId,
				branch: branch ?? null,
				...(verifierWorktree ? { verifierWorktree } : {}),
			}),
			`task-attached:${taskId}:${attemptId}`,
		);
	};

	/**
	 * Records the terminal result of the currently active task attempt.
	 *
	 * @param {Request<"completeTask">} input
	 */
	const completeTask = async ({
		planId,
		taskId,
		attemptId,
		expectedRevision,
		status,
		resultSummary,
		evidence,
		error,
		branch,
		commit,
		prUrl,
		sessionInventory,
		learning,
		factoryEvaluations,
	}) => {
		factory.validateLearning(learning ?? []);
		let updated;
		try {
			/** @type {import("../types/plan.js").RepositoryCheck | undefined} */
			let repositoryCheck;
			/** @type {number | undefined} */
			let factoryRevision;
			if (status === TASK_STATUS.DONE) {
				const plan = await storeFor().read(planId);
				factory.requireOwner(plan);
				if (plan.revision !== expectedRevision) throw revisionConflict(planId, expectedRevision, plan.revision);
				const current = findAttempt(plan, taskId, attemptId);
				validateDonePayload(plan, taskId, current, { resultSummary, evidence, branch, commit, prUrl });
				// Reject stale subjects and malformed reports before reading external Git state.
				completeTaskAttempt(plan, taskId, attemptId, status, { resultSummary, evidence, error, branch, commit, prUrl, learning, factoryEvaluations });
				factoryRevision = factory.validateReports(plan, taskId, factoryEvaluations, evidence, commit);
				if (current) repositoryCheck = checkTaskRepository(plan, taskId, current, commit);
			}
			updated = await persist(planId, expectedRevision, (plan) => {
				const current = findAttempt(plan, taskId, attemptId);
				if (status === TASK_STATUS.DONE) {
					validateDonePayload(plan, taskId, current, {
						resultSummary,
						evidence,
						branch,
						commit,
						prUrl,
					});
				}
				let sessionTerminatedAt;
				if (isOneOf(status, [TASK_STATUS.FAILED, TASK_STATUS.BLOCKED])
					&& current
					&& current.sessionId !== null) {
					const inventory = normalizeInventory(sessionInventory);
					const observedAt = current?.startedAt ?? current?.reservedAt;
					if (!inventory.complete
						|| inventory.capturedAt === null
						|| !observedAt
						|| Date.parse(inventory.capturedAt) <= Date.parse(observedAt)
						|| !isTerminatedSessionState(sessionState(current, inventory))) {
						throw new FoundryOperationError(
							"task_session_not_terminated",
							"Attached task failure requires a complete current terminal session inventory",
							{ taskId, attemptId, sessionId: current?.sessionId ?? null },
						);
					}
					sessionTerminatedAt = inventory.capturedAt;
				}
				const completed = completeTaskAttempt(plan, taskId, attemptId, status, {
					resultSummary,
					evidence,
					error,
					branch,
					commit,
					prUrl,
					sessionTerminatedAt,
					at: sessionTerminatedAt,
					learning,
					factoryEvaluations,
					repositoryCheck,
				});
				factory.preflight(completed, factoryRevision);
				return completed;
			}, `task-${status}:${taskId}:${attemptId}`);
		} catch (failure) {
			if (failure instanceof FoundryFactoryError
				&& /^factory_(?:evidence|evaluator|visual|human|generation|execution|provenance|commit|integration|worktree|repository)/.test(failure.code)) {
				let retained;
				try {
					const current = await storeFor().read(planId);
					retained = factory.captureRejectedReport(current, taskId, { attemptId, commit, resultSummary, factoryEvaluations, evidence }, failure);
				} catch (captureError) {
					retained = { error: { code: errorCode(captureError) ?? "capture_failed", message: errorMessage(captureError) } };
				}
				throw new FoundryOperationError(failure.code, failure.message, { validation: failure.details, nonGoverningLearning: retained, taskCompleted: false });
			}
			throw failure;
		}
		syncFactoryPlan(updated);
		return updated;
	};

	/**
	 * Makes failed or blocked work ready for a fresh attempt.
	 *
	 * @param {{planId: string, taskId: string, expectedRevision: number}} input
	 */
	const retry = async ({ planId, taskId, expectedRevision }) => {
		return persist(
			planId,
			expectedRevision,
			(plan) => {
				factory.requireRetry(plan, taskId);
				return retryTask(plan, taskId);
			},
			`task-retried:${taskId}`,
		);
	};
	return { reserveTask, attachTask, completeTask, retry };
}
