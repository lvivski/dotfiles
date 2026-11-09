const STATUSES = new Set([
	"pending",
	"running",
	"done",
	"failed",
	"blocked",
	"cancelled",
]);

/** @typedef {import("../types.js").AdmissionTask} AdmissionTask */
/** @typedef {{task: AdmissionTask, remaining: number, dependents: GraphNode[]}} GraphNode */
/** @param {unknown} value @returns {value is string[]} */
function isStringArray(value) {
	if (!Array.isArray(value)) return false;
	for (const item of value) {
		if (typeof item !== "string") return false;
	}
	return true;
}

/** @param {string} message */
function invalidGraph(message) {
	/** @type {Error & {code?: string}} */
	const error = new Error(message);
	error.code = "invalid_graph";
	return error;
}

/** @param {AdmissionTask[]} tasks @param {number} capacity */
export function schedule(tasks, capacity) {
	if (!Array.isArray(tasks)) {
		throw new TypeError("tasks must be an array");
	}
	if (!Number.isSafeInteger(capacity) || capacity < 0) {
		throw new RangeError("capacity must be a nonnegative safe integer");
	}

	/** @type {Map<string, GraphNode>} */
	const graph = new Map();
	for (let index = 0; index < tasks.length; index += 1) {
		const task = tasks[index];
		if (
			task === null ||
			typeof task !== "object" ||
			Array.isArray(task) ||
			typeof task.id !== "string" ||
			task.id.length === 0 ||
			!isStringArray(task.dependsOn) ||
			!STATUSES.has(task.status) ||
			!isStringArray(task.resources)
		) {
			throw new TypeError(
				`tasks[${index}] must have a nonempty string id, string-array dependsOn and resources, and a valid status`,
			);
		}
		if (graph.has(task.id)) {
			throw invalidGraph(`Duplicate task ID: ${task.id}`);
		}
		graph.set(task.id, {
			task,
			remaining: task.dependsOn.length,
			dependents: [],
		});
	}

	const queue = [];
	for (const node of graph.values()) {
		for (const dependencyId of node.task.dependsOn) {
			const dependency = graph.get(dependencyId);
			if (!dependency) {
				throw invalidGraph(
					`Task ${node.task.id} has a missing dependency: ${dependencyId}`,
				);
			}
			dependency.dependents.push(node);
		}
		if (node.remaining === 0) queue.push(node);
	}

	for (let index = 0; index < queue.length; index += 1) {
		for (const dependent of queue[index].dependents) {
			dependent.remaining -= 1;
			if (dependent.remaining === 0) queue.push(dependent);
		}
	}
	if (queue.length !== graph.size) {
		throw invalidGraph("Task dependencies contain a cycle");
	}

	const ready = [];
	const claimed = new Set();
	for (const { task } of graph.values()) {
		if (task.status === "running") {
			for (const resource of task.resources) claimed.add(resource);
		} else if (
			task.status === "pending" &&
			task.dependsOn.every((id) => /** @type {GraphNode} */ (graph.get(id)).task.status === "done")
		) {
			ready.push(task.id);
		}
	}
	ready.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

	const admitted = [];
	const held = [];
	for (const id of ready) {
		const { resources } = /** @type {GraphNode} */ (graph.get(id)).task;
		if (
			admitted.length >= capacity ||
			resources.some((resource) => claimed.has(resource))
		) {
			held.push(id);
			continue;
		}
		admitted.push(id);
		for (const resource of resources) claimed.add(resource);
	}
	return { ready, admitted, held };
}
