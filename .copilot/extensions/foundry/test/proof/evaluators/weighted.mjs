import assert from "node:assert/strict";

/** Evaluate the later workload independently of the original unit-weight oracle. @param {import("../types.js").Schedule} schedule */
export function evaluateWeighted(schedule) {
	/** @param {string} id @param {Partial<import("../types.js").AdmissionTask>} [fields] @returns {import("../types.js").AdmissionTask} */
	const task = (id, fields = {}) => ({ id, dependsOn: [], status: "pending", resources: [], ...fields });
	try {
		const tasks = [task("a", { slots: 3 }), task("b", { slots: 2 }), task("c"), task("d")];
		const before = structuredClone(tasks);
		assert.deepEqual(schedule(tasks, 3), {
			ready: ["a", "b", "c", "d"], admitted: ["a"], held: ["b", "c", "d"],
		});
		assert.deepEqual(tasks, before);
		assert.deepEqual(schedule([
			task("a", { slots: 4 }), task("b", { slots: 2 }), task("c"),
		], 3).admitted, ["b", "c"]);
		assert.deepEqual(schedule([
			task("running", { status: "running", resources: ["shared"], slots: 2 }),
			task("a", { slots: 2, resources: ["shared"] }), task("b", { slots: 2 }),
			task("c", { dependsOn: ["a"], slots: 1 }),
		], 3), { ready: ["a", "b"], admitted: ["b"], held: ["a"] });
		for (const item of tasks) {
			Object.freeze(item.dependsOn);
			Object.freeze(item.resources);
			Object.freeze(item);
		}
		Object.freeze(tasks);
		assert.deepEqual(schedule(tasks, 3).admitted, ["a"]);
		for (const slots of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
			assert.throws(() => schedule([task("invalid", { slots, status: "done" })], 1), { name: "RangeError" });
		}
		assert.throws(() => schedule([
			task("a", { slots: 2, dependsOn: ["b"] }),
			task("b", { slots: 2, dependsOn: ["a"] }),
		], 4), { code: "invalid_graph" });
		return { evaluationId: "weighted-capacity", outcome: "passed", detail: "Weighted capacity, ownership, graph, and conservation assertions passed" };
	} catch (error) {
		return { evaluationId: "weighted-capacity", outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
	}
}
