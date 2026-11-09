import { effectiveDeliveryRequirement } from "./delivery.mjs";
import { fail, isPlainObject } from "./fields.mjs";
import { taskMap } from "./queries.mjs";
import { validateEvaluationTarget } from "./schemas/factory.mjs";
import { DELIVERY_REQUIREMENT, LIMITS } from "./values.mjs";

/** @typedef {import("../types/plan.js").EvaluationTarget} EvaluationTarget */
/** @typedef {import("../types/plan.js").BlueprintTask} BlueprintTask */

/**
 * Validates task identity, dependency references, and graph acyclicity.
 *
 * @param {Array<{id: string, dependsOn: string[]}>} tasks
 * @returns {true}
 */
export function validateDependencyGraph(tasks) {
	if (!Array.isArray(tasks)) {
		fail("invalid_array", "tasks must be an array", { path: "tasks" });
	}

	/** @type {Map<string, {id: string, dependsOn: string[]}>} */
	const byId = new Map();
	for (let index = 0; index < tasks.length; index += 1) {
		const task = tasks[index];
		if (!isPlainObject(task) || typeof task.id !== "string") {
			fail("invalid_task", `tasks[${index}] must have an id`, { path: `tasks[${index}].id` });
		}
		if (byId.has(task.id)) {
			fail("duplicate_task_id", `Task id ${task.id} appears more than once`, {
				path: `tasks[${index}].id`,
				details: { id: task.id },
			});
		}
		byId.set(task.id, task);
	}

	for (let index = 0; index < tasks.length; index += 1) {
		const task = tasks[index];
		const seen = new Set();
		for (let dependencyIndex = 0; dependencyIndex < task.dependsOn.length; dependencyIndex += 1) {
			const dependencyId = task.dependsOn[dependencyIndex];
			const dependencyPath = `tasks[${index}].dependsOn[${dependencyIndex}]`;
			if (dependencyId === task.id) {
				fail("self_dependency", `Task ${task.id} cannot depend on itself`, {
					path: dependencyPath,
					details: { id: task.id },
				});
			}
			if (seen.has(dependencyId)) {
				fail("duplicate_dependency", `Task ${task.id} repeats dependency ${dependencyId}`, {
					path: dependencyPath,
					details: { id: task.id, dependencyId },
				});
			}
			if (!byId.has(dependencyId)) {
				fail("unknown_dependency", `Task ${task.id} depends on unknown task ${dependencyId}`, {
					path: dependencyPath,
					details: { id: task.id, dependencyId },
				});
			}
			seen.add(dependencyId);
		}
	}

	/** @type {Map<string, "visiting" | "done">} */
	const state = new Map();
	/** @type {string[]} */
	const stack = [];
	/**
	 * Performs depth-first cycle detection from one task ID.
	 *
	 * @param {string} id
	 * @returns {void}
	 */
	const visit = (id) => {
		if (state.get(id) === "done") {
			return;
		}
		if (state.get(id) === "visiting") {
			const start = stack.indexOf(id);
			const cycle = [...stack.slice(start), id];
			fail("dependency_cycle", `Dependency cycle detected: ${cycle.join(" -> ")}`, {
				path: "tasks",
				details: { cycle },
			});
		}
		state.set(id, "visiting");
		stack.push(id);
		const task = byId.get(id);
		if (!task) fail("unknown_dependency", `Task ${id} is missing from the dependency graph`);
		for (const dependencyId of task.dependsOn) {
			visit(dependencyId);
		}
		stack.pop();
		state.set(id, "done");
	};

	for (const id of byId.keys()) {
		visit(id);
	}
	return true;
}

/**
 * Validates the implementation DAG and its unique final verifier task.
 *
 * @template {{
 *   id: string,
 *   kind: "implement"|"verify",
 *   dependsOn: string[],
 *   acceptanceCriteria: string[],
 *   deliveryRequirement: "branch"|"commit"|"pr"
 * }} T
 * @param {T[]} tasks
 * @param {EvaluationTarget | null} [evaluationTarget]
 * @returns {{verifyTask: T, targetTask: T | null}}
 */
export function validateTaskTopology(tasks, evaluationTarget = null) {
	const implementTasks = tasks.filter((task) => task.kind === "implement");
	const verifyTasks = tasks.filter((task) => task.kind === "verify");
	if (evaluationTarget !== null) {
		validateEvaluationTarget(evaluationTarget);
		if (tasks.length !== 1 || verifyTasks.length !== 1 || verifyTasks[0].dependsOn.length !== 0) {
			fail("invalid_evaluation_topology", "Read-only evaluation plans require exactly one verifier with no implementation task");
		}
		return { verifyTask: verifyTasks[0], targetTask: null };
	}
	if (implementTasks.length === 0 || verifyTasks.length !== 1) {
		fail(
			"invalid_task_topology",
			"Plans require implementation tasks and exactly one verifier task",
			{ path: "tasks" },
		);
	}
	const verifyTask = verifyTasks[0];
	const dependedOn = new Set(tasks.flatMap((task) => task.dependsOn));
	const sinks = tasks.filter((task) => !dependedOn.has(task.id));
	if (sinks.length !== 1 || sinks[0].id !== verifyTask.id) {
		fail("invalid_task_topology", "The verifier task must be the only sink", {
			path: "tasks",
			details: { sinkTaskIds: sinks.map((task) => task.id) },
		});
	}
	if (verifyTask.dependsOn.length !== 1) {
		fail("invalid_task_topology", "The verifier must depend on one final implementation task", {
			path: `tasks[${tasks.indexOf(verifyTask)}].dependsOn`,
		});
	}
	const byId = taskMap(tasks);
	const targetTask = byId.get(verifyTask.dependsOn[0]);
	if (!targetTask || targetTask.kind !== "implement") {
		fail("invalid_task_topology", "The verifier dependency must be an implementation task", {
			path: `tasks[${tasks.indexOf(verifyTask)}].dependsOn`,
		});
	}
	const reachable = new Set();
	/** @param {string} taskId */
	const visit = (taskId) => {
		if (reachable.has(taskId)) return;
		reachable.add(taskId);
		const task = byId.get(taskId);
		if (!task) {
			fail("unknown_dependency", `Task ${taskId} is missing from the dependency graph`, {
				path: "tasks",
			});
		}
		for (const dependencyId of task.dependsOn) visit(dependencyId);
	};
	visit(targetTask.id);
	const missing = implementTasks
		.map((task) => task.id)
		.filter((taskId) => !reachable.has(taskId));
	if (missing.length > 0) {
		fail("invalid_task_topology", "Every implementation task must converge before verification", {
			path: "tasks",
			details: { unreachableTaskIds: missing },
		});
	}
	const targetDelivery = effectiveDeliveryRequirement(targetTask);
	if (targetDelivery !== DELIVERY_REQUIREMENT.COMMIT
		&& targetDelivery !== DELIVERY_REQUIREMENT.PR) {
		fail(
			"invalid_task_topology",
			"The final implementation task must require commit or pr delivery",
			{ path: `tasks[${tasks.indexOf(targetTask)}].deliveryRequirement` },
		);
	}
	const criterionCount = implementTasks.reduce(
		(total, task) => total + task.acceptanceCriteria.length,
		0,
	);
	if (criterionCount > LIMITS.evidence - 2) {
		fail(
			"too_many_verification_checks",
			`Implementation criteria must not exceed ${LIMITS.evidence - 2}`,
			{ path: "tasks", details: { criterionCount } },
		);
	}
	return { verifyTask, targetTask };
}

/** @param {Pick<BlueprintTask, "id" | "kind" | "acceptanceCriteria">[]} tasks @param {EvaluationTarget | null} [evaluationTarget] @returns {string[]} */
export function verificationCheckIds(tasks, evaluationTarget = null) {
	if (evaluationTarget) {
		const verifier = tasks.find((task) => task.kind === "verify");
		if (!verifier) fail("invalid_evaluation_topology", "Read-only evaluation requires a verifier");
		return [
			...evaluationTarget.criteria.map((_criterion, index) => `${verifier.id}-C${String(index + 1).padStart(3, "0")}`),
			"final-integration", "workspace-integrity",
		];
	}
	return [
		...tasks
			.filter((task) => task.kind === "implement")
			.sort((left, right) => left.id.localeCompare(right.id))
			.flatMap((task) => task.acceptanceCriteria.map(
				(_criterion, index) => `${task.id}-C${String(index + 1).padStart(3, "0")}`,
			)),
		"final-integration",
		"workspace-integrity",
	];
}
