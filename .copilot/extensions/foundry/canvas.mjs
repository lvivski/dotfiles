import { CanvasError, createCanvas } from "@github/copilot-sdk/extension";
import { startBoard } from "./work/board.mjs";
import { record, text } from "./work/values.mjs";

/** @param {ReturnType<typeof import("./work/runtime.mjs").createRuntime>} runtime */
export function createFoundryCanvas(runtime) {
	/** @type {Map<string,Awaited<ReturnType<typeof startBoard>>>} */
	const boards = new Map();
	/** @type {Map<string,string|undefined>} */
	const goals = new Map();
	return createCanvas({
		id: "foundry-board", displayName: "Foundry",
		description: "Inspect organizations, accountable coordinators, collaboration commitments and versioned delivered work.",
		inputSchema: { type: "object", additionalProperties: false, properties: { goalId: { type: "string" } } },
		actions: [{
			name: "get_snapshot", description: "Read the current canonical work records displayed by this board.",
			handler: context => {
				if (!boards.has(context.instanceId)) throw new CanvasError("board_not_open", "This Foundry board is not open");
				return runtime.store().snapshot(goals.get(context.instanceId));
			},
		}],
		open: async context => {
			const input = context.input === null || context.input === undefined ? {} : record(context.input);
			const goalId = input.goalId === undefined ? undefined : text(input.goalId, "goal id");
			const existing = boards.get(context.instanceId);
			if (existing) {
				if (goals.get(context.instanceId) !== goalId) throw new CanvasError("board_scope_changed", "Open a different instance for another goal");
				return { title: "Foundry", status: "Ready", url: existing.url };
			}
			const board = await startBoard({ snapshot: () => runtime.store().snapshot(goalId), log: runtime.log });
			boards.set(context.instanceId, board);
			goals.set(context.instanceId, goalId);
			return { title: "Foundry", status: "Ready", url: board.url };
		},
		onClose: async context => {
			const board = boards.get(context.instanceId);
			boards.delete(context.instanceId);
			goals.delete(context.instanceId);
			await board?.close();
		},
	});
}
