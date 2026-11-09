import assert from "node:assert/strict";

/** @param {string} id @param {Partial<import("../types.js").AdmissionTask>} [fields] @returns {import("../types.js").AdmissionTask} */
const task = (id, fields = {}) => ({ id, dependsOn: [], status: "pending", resources: [], ...fields });
const graph = () => [
	task("consumer", { dependsOn: ["foundation"], resources: ["catalog"] }),
	task("foundation", { status: "done" }),
	task("running", { status: "running", resources: ["accounts"] }),
	task("account-write", { resources: ["accounts"] }),
	task("blocked", { status: "blocked" }),
	task("failed", { status: "failed" }),
	task("waiting", { dependsOn: ["consumer"] }),
	task("free"),
];

/** Generated modules are callable claims, not trusted typed implementations.
 * @param {unknown} policy @returns {import("../types.js").Schedule} */
export function readSchedule(policy) {
	if (!policy || typeof policy !== "object" || !("schedule" in policy) || typeof policy.schedule !== "function") {
		throw new TypeError("Generated policy must export schedule");
	}
	const schedule = policy.schedule;
	return (tasks, capacity) => {
		/** @type {unknown} */
		const result = schedule.call(policy, tasks, capacity);
		assertResult(result);
		return result;
	};
}

/** @param {unknown} result @returns {asserts result is import("../types.js").AdmissionResult} */
function assertResult(result) {
	assert.ok(result && typeof result === "object");
	for (const key of ["ready", "admitted", "held"]) {
		/** @type {unknown} */
		const value = /** @type {Record<string, unknown>} */ (result)[key];
		assert.ok(Array.isArray(value) && value.every((/** @type {unknown} */ id) => typeof id === "string"));
	}
}

/** Execute independent boundary evaluations; every failure remains a receipt.
 * @param {import("../types.js").Schedule} schedule @param {{conservation?: boolean, weighted?: boolean}} [options] */
export function evaluate(schedule, { conservation = true, weighted = false } = {}) {
	/** @type {Array<[string, () => void]>} */
	const checks = [
		["dependency-readiness", () => {
			assert.deepEqual(schedule(graph(), 4).ready, ["account-write", "consumer", "free"]);
		}],
		["logical-ownership", () => {
			const result = schedule(graph(), 4);
			assert.deepEqual(result.admitted, ["consumer", "free"]);
			assert.deepEqual(result.held, ["account-write"]);
			assert.deepEqual(schedule([task("b", { resources: ["shared"] }), task("a", { resources: ["shared"] })], 2).admitted, ["a"]);
		}],
		["deterministic-admission", () => {
			assert.deepEqual(schedule([task("a"), task("B"), task("z")], 2), {
				ready: ["B", "a", "z"], admitted: ["B", "a"], held: ["z"],
			});
			for (let mask = 0; mask < 16; mask++) {
				const nodes = [
					task("z", { dependsOn: mask & 1 ? ["a"] : [], resources: ["shared"] }),
					task("a", { status: mask & 2 ? "done" : "pending" }),
					task("b", { resources: mask & 4 ? ["shared"] : ["other"] }),
					task("running", { status: "running", resources: mask & 8 ? ["shared"] : [] }),
				];
				for (let capacity = 0; capacity < 4; capacity++) {
					const result = schedule(structuredClone(nodes), capacity);
					assert.deepEqual(result, schedule(structuredClone(nodes).reverse(), capacity));
					assert.ok(result.admitted.length <= capacity);
					assert.deepEqual([...result.admitted, ...result.held].sort(), [...result.ready].sort());
					assert.equal(new Set(result.admitted).size, result.admitted.length);
					const occupied = new Set(nodes.filter((entry) => entry.status === "running").flatMap((entry) => entry.resources));
					for (const id of result.admitted) {
						const selected = nodes.find((entry) => entry.id === id);
						assert.ok(selected && selected.status === "pending");
						assert.ok(selected.dependsOn.every((dependency) => nodes.find((entry) => entry.id === dependency)?.status === "done"));
						assert.ok(selected.resources.every((resource) => !occupied.has(resource)));
						for (const resource of selected.resources) occupied.add(resource);
					}
				}
			}
		}],
		["capacity", () => {
			assert.deepEqual(schedule([task("a")], 0), { ready: ["a"], admitted: [], held: ["a"] });
			assert.deepEqual(schedule([task("running", { status: "running" }), task("a")], 1).admitted, ["a"]);
			for (const capacity of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
				assert.throws(() => schedule([], capacity), { name: "RangeError" });
			}
		}],
		["graph-integrity", () => {
			for (const tasks of [
				[task("a"), task("a")],
				[task("a", { dependsOn: ["missing"], status: "done" })],
				[task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })],
			]) assert.throws(() => schedule(tasks, 4), { code: "invalid_graph" });
		}],
	];
	if (conservation) checks.push(["input-conservation", () => {
		const tasks = graph();
		const before = structuredClone(tasks);
		schedule(tasks, 3);
		assert.deepEqual(tasks, before);
		for (const item of tasks) {
			Object.freeze(item.dependsOn);
			Object.freeze(item.resources);
			Object.freeze(item);
		}
		Object.freeze(tasks);
		assert.deepEqual(schedule(tasks, 3).admitted, ["consumer", "free"]);
	}]);
	if (weighted) checks.push(["weighted-capacity", () => {
		assert.deepEqual(schedule([
			task("a", { slots: 3 }), task("b", { slots: 2 }), task("c"), task("d"),
		], 3), {
			ready: ["a", "b", "c", "d"], admitted: ["a"], held: ["b", "c", "d"],
		});
		assert.deepEqual(schedule([task("a", { slots: 4 }), task("b", { slots: 2 }), task("c")], 3).admitted, ["b", "c"]);
		for (const slots of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
			assert.throws(() => schedule([task("bad", { slots, status: "done" })], 1), { name: "RangeError" });
		}
	}]);
	return checks.map(([id, check]) => {
		try {
			check();
			return { evaluationId: id, outcome: "passed", detail: "Boundary assertion passed" };
		} catch (error) {
			return { evaluationId: id, outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
		}
	});
}
