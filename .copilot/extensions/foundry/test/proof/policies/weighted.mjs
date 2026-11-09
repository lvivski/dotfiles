const statuses = new Set(["pending", "running", "done", "failed", "blocked", "cancelled"]);

/** @typedef {import("../types.js").AdmissionTask} AdmissionTask */
/** @typedef {{task: AdmissionTask, slots: number, indegree: number, dependents: GraphNode[]}} GraphNode */
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
	const byId = new Map();
	for (const task of tasks) {
		if (task === null || typeof task !== "object" || Array.isArray(task)) {
			throw new TypeError("Each task must be a record");
		}
		if (typeof task.id !== "string" || task.id.length === 0) {
			throw new TypeError("Task IDs must be nonempty strings");
		}
		if (!statuses.has(task.status)) {
			throw new TypeError("Invalid task status");
		}
		if (!Array.isArray(task.dependsOn) || !Array.isArray(task.resources)) {
			throw new TypeError("Task dependencies and resources must be arrays");
		}
		for (const dependency of task.dependsOn) {
			if (typeof dependency !== "string") {
				throw new TypeError("Task dependencies must be strings");
			}
		}
		for (const resource of task.resources) {
			if (typeof resource !== "string") {
				throw new TypeError("Task resources must be strings");
			}
		}

		const slots = "slots" in task ? task.slots : 1;
		if (!Number.isSafeInteger(slots) || /** @type {number} */ (slots) <= 0) {
			throw new RangeError("slots must be a positive safe integer");
		}
		if (byId.has(task.id)) {
			throw invalidGraph(`Duplicate task ID: ${task.id}`);
		}
		byId.set(task.id, {
			task,
			slots: /** @type {number} */ (slots),
			indegree: task.dependsOn.length,
			dependents: [],
		});
	}

	for (const node of byId.values()) {
		for (const id of node.task.dependsOn) {
			const dependency = byId.get(id);
			if (!dependency) {
				throw invalidGraph(`Missing dependency: ${id}`);
			}
			dependency.dependents.push(node);
		}
	}

	const queue = [];
	for (const node of byId.values()) {
		if (node.indegree === 0) {
			queue.push(node);
		}
	}
	for (let index = 0; index < queue.length; index += 1) {
		for (const dependent of queue[index].dependents) {
			dependent.indegree -= 1;
			if (dependent.indegree === 0) {
				queue.push(dependent);
			}
		}
	}
	if (queue.length !== byId.size) {
		throw invalidGraph("Task dependencies contain a cycle");
	}

	const ready = [];
	const claimed = new Set();
	for (const { task } of byId.values()) {
		// Running slots are already accounted for in the supplied capacity.
		if (task.status === "running") {
			for (const resource of task.resources) {
				claimed.add(resource);
			}
		} else if (task.status === "pending"
			&& task.dependsOn.every(id => /** @type {GraphNode} */ (byId.get(id)).task.status === "done")) {
			ready.push(task.id);
		}
	}
	ready.sort();

	const admitted = [];
	const held = [];
	let remaining = capacity;
	for (const id of ready) {
		const { task, slots } = /** @type {GraphNode} */ (byId.get(id));
		if (slots > remaining || task.resources.some(resource => claimed.has(resource))) {
			held.push(id);
			continue;
		}
		admitted.push(id);
		remaining -= slots;
		for (const resource of task.resources) {
			claimed.add(resource);
		}
	}
	return { ready, admitted, held };
}
