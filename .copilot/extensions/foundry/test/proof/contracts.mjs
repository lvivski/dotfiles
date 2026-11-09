const behavior = [
	["dependency-readiness", "Only pending tasks whose dependencies are all done are ready. Failed, blocked, cancelled, running, and done tasks never become ready."],
	["logical-ownership", "Running tasks and newly admitted tasks exclusively claim their named resources. A candidate conflicting with any claimed resource is held; continue considering later candidates."],
	["deterministic-admission", "Sort ready tasks by JavaScript string comparison of IDs, not locale-dependent order. Greedily admit in that order. Return ready, admitted, and held ID arrays in that order."],
	["capacity", "capacity is the number of available slots for NEW admissions, already accounting for running work. It must be a nonnegative safe integer. Zero capacity holds all ready tasks."],
	["graph-integrity", "Reject duplicate IDs, missing dependencies, and cycles with an Error whose code is invalid_graph, including defects in tasks not currently ready."],
];

export const initialContract = {
	title: "Dependency-aware admission policy",
	intent: "Deterministically admit dependency-ready work without conflicting logical mutation owners.",
	interface: {
		export: "schedule(tasks, capacity)",
		input: "tasks is an array of records {id: nonempty string, dependsOn: string[], status: pending|running|done|failed|blocked|cancelled, resources: string[]}. Resource names are exact opaque tokens, not paths or globs.",
		output: "{ready: string[], admitted: string[], held: string[]}",
	},
	obligations: behavior,
	assumptions: ["Each newly admitted task consumes one slot."],
};

export const reconstructionContract = {
	...initialContract,
	obligations: [...behavior, [
		"input-conservation",
		"Do not mutate any caller-owned input: task order, records, dependencies, and resource arrays must remain identical. Frozen inputs must work. Return fresh output arrays.",
	]],
};

export const renewalContract = {
	...reconstructionContract,
	interface: {
		...initialContract.interface,
		input: `${initialContract.interface.input} Each record may additionally contain slots: a positive safe integer, defaulting to 1.`,
	},
	obligations: [
		...reconstructionContract.obligations,
		["weighted-capacity", "The sum of slots for newly admitted tasks must not exceed capacity. A ready task too large for the remaining capacity is held; continue considering later smaller tasks. Reject any invalid slots value with RangeError, even on a task not currently ready."],
	],
	assumptions: ["capacity measures available slot units, not a count of tasks."],
};
