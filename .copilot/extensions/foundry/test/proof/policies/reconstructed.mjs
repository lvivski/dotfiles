const statuses = new Set([
	"pending",
	"running",
	"done",
	"failed",
	"blocked",
	"cancelled",
]);

/** @typedef {import("../types.js").AdmissionTask} AdmissionTask */
/** @typedef {{task: AdmissionTask, remaining: number, dependents: GraphNode[]}} GraphNode */
/** @param {string} message */
function invalidGraph(message) {
	/** @type {Error & {code?: string}} */
	const error = new Error(message);
	error.code = "invalid_graph";
	return error;
}

/** @param {AdmissionTask[]} tasks @param {number} capacity */
export function schedule(tasks, capacity) {
	if (!Number.isSafeInteger(capacity) || capacity < 0) {
		throw new RangeError("capacity must be a nonnegative safe integer");
	}
	if (!Array.isArray(tasks)) {
		throw new TypeError("tasks must be an array");
	}

	/** @type {Map<string, GraphNode>} */
	const nodes = new Map();
	for (const task of tasks) {
		if (
			task === null ||
			typeof task !== "object" ||
			Array.isArray(task) ||
			typeof task.id !== "string" ||
			task.id.length === 0 ||
			!Array.isArray(task.dependsOn) ||
			!Array.isArray(task.resources) ||
			!statuses.has(task.status)
		) {
			throw new TypeError("Each task must match the admission task schema");
		}
		for (const tokens of [task.dependsOn, task.resources]) {
			for (const token of tokens) {
				if (typeof token !== "string") {
					throw new TypeError("Dependencies and resources must be strings");
				}
			}
		}
		if (nodes.has(task.id)) {
			throw invalidGraph(`Duplicate task ID: ${task.id}`);
		}
		nodes.set(task.id, {
			task,
			remaining: task.dependsOn.length,
			dependents: [],
		});
	}

	const queue = [];
	for (const node of nodes.values()) {
		for (const dependencyId of node.task.dependsOn) {
			const dependency = nodes.get(dependencyId);
			if (!dependency) {
				throw invalidGraph(`Missing dependency: ${dependencyId}`);
			}
			dependency.dependents.push(node);
		}
		if (node.remaining === 0) {
			queue.push(node);
		}
	}
	for (let index = 0; index < queue.length; index += 1) {
		for (const dependent of queue[index].dependents) {
			dependent.remaining -= 1;
			if (dependent.remaining === 0) {
				queue.push(dependent);
			}
		}
	}
	if (queue.length !== nodes.size) {
		throw invalidGraph("Task dependencies contain a cycle");
	}

	const claimedResources = new Set();
	const readyTasks = [];
	for (const task of tasks) {
		if (task.status === "running") {
			for (const resource of task.resources) {
				claimedResources.add(resource);
			}
		} else if (
			task.status === "pending" &&
			task.dependsOn.every((id) => /** @type {GraphNode} */ (nodes.get(id)).task.status === "done")
		) {
			readyTasks.push(task);
		}
	}
	readyTasks.sort((left, right) =>
		left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
	);

	const ready = readyTasks.map((task) => task.id);
	const admitted = [];
	const held = [];
	for (const task of readyTasks) {
		if (
			admitted.length >= capacity ||
			task.resources.some((resource) => claimedResources.has(resource))
		) {
			held.push(task.id);
			continue;
		}
		admitted.push(task.id);
		for (const resource of task.resources) {
			claimedResources.add(resource);
		}
	}

	return { ready, admitted, held };
}
