/** @typedef {import("../types.js").AdmissionTask} AdmissionTask */
/** Intentionally mutable initial implementation: the proof must still detect its sort.
 * @param {AdmissionTask[]} tasks @param {number} capacity */
export function schedule(tasks, capacity) {
	if (!Number.isSafeInteger(capacity) || capacity < 0) throw new RangeError("Invalid capacity");
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const invalid = () => { throw Object.assign(new Error("Invalid dependency graph"), { code: "invalid_graph" }); };
	if (byId.size !== tasks.length) invalid();
	/** @type {Set<string>} */
	const visiting = new Set();
	/** @type {Set<string>} */
	const visited = new Set();
	/** @param {string} id */
	const visit = (id) => {
		if (!byId.has(id) || visiting.has(id)) invalid();
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of /** @type {AdmissionTask} */ (byId.get(id)).dependsOn) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const task of tasks) visit(task.id);
	const occupied = new Set(tasks.filter((task) => task.status === "running").flatMap((task) => task.resources));
	const ready = tasks.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
		.filter((task) => task.status === "pending" && task.dependsOn.every((id) => /** @type {AdmissionTask} */ (byId.get(id)).status === "done"));
	const admitted = [];
	const held = [];
	for (const task of ready) {
		if (admitted.length >= capacity || task.resources.some((resource) => occupied.has(resource))) {
			held.push(task.id);
			continue;
		}
		admitted.push(task.id);
		for (const resource of task.resources) occupied.add(resource);
	}
	return { ready: ready.map((task) => task.id), admitted, held };
}
