import { CanvasError, createCanvas } from "@github/copilot-sdk/extension";
import { example, mapSnapshot } from "./map/model.mjs";
import { serveMap } from "./map/server.mjs";
import { name, record } from "./work/values.mjs";

/** @param {(run:string, actor:string)=>Promise<ReturnType<typeof import("./work/status.mjs").status>>} readStatus */
export function foundryBoard(readStatus) {
	/** @type {Map<string,{run:string|null, actor:string, snapshot:()=>Promise<import("./map/model.mjs").MapSnapshot>, server:ReturnType<typeof serveMap>}>} */
	const boards = new Map();
	return createCanvas({
		id: "foundry-board", displayName: "Foundry dependency map",
		description: "See parallel assignments, dependencies and blockers for one Foundry run, or open a labeled example.",
		inputSchema: { type: "object", oneOf: [
			{ type: "object", properties: { run: { type: "string", minLength: 1 } }, required: ["run"], additionalProperties: false },
			{ type: "object", properties: { example: { const: true } }, required: ["example"], additionalProperties: false },
		] },
		actions: [{ name: "get_snapshot", description: "Read the displayed dependency map without advancing the factory.",
			handler: ctx => {
				const board = boards.get(ctx.instanceId);
				if (board?.actor !== ctx.sessionId) throw new CanvasError("map_not_open", "This Foundry map is not open in this session");
				return board.snapshot();
			} }],
		open: async ctx => {
			const input = record(ctx.input), run = input.example === true ? null : name(input.run, "run");
			let board = boards.get(ctx.instanceId);
			if (board && (board.run !== run || board.actor !== ctx.sessionId))
				throw new CanvasError("map_scope_changed", "Open a new panel for a different run");
			if (!board) {
				const snapshot = async () => run === null ? example : mapSnapshot(await readStatus(run, ctx.sessionId));
				const server = snapshot().then(() => serveMap(snapshot));
				board = { run, actor: ctx.sessionId, snapshot, server };
				boards.set(ctx.instanceId, board);
				server.catch(() => { if (boards.get(ctx.instanceId) === board) boards.delete(ctx.instanceId); });
			}
			return { url: (await board.server).url, title: run ? `Foundry · ${run}` : "Foundry · Example map" };
		},
		onClose: async ctx => {
			const board = boards.get(ctx.instanceId);
			if (!board || board.actor !== ctx.sessionId) return;
			boards.delete(ctx.instanceId);
			await (await board.server).close();
		},
	});
}
