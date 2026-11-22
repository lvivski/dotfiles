import { CanvasError, createCanvas } from "@github/copilot-sdk/extension";
import { example, mapSnapshot } from "./map/model.mjs";
import { serveMap } from "./map/server.mjs";
import { name, record } from "./work/values.mjs";

/** @param {(run:string, actor:string)=>Promise<ReturnType<typeof import("./work/status.mjs").status>>} readStatus
 * @param {(actor:string)=>string|undefined} defaultRun */
export function foundryBoard(readStatus, defaultRun) {
	/** @type {Map<string,{run:string|null|undefined, actor:string, snapshot:Parameters<typeof serveMap>[0], server:ReturnType<typeof serveMap>}>} */
	const boards = new Map();
	return createCanvas({
		id: "foundry-board", displayName: "Foundry dependency map",
		description: "See parallel assignments, dependencies and blockers for one Foundry run, or open a labeled example.",
		inputSchema: { type: "object", oneOf: [
			{ type: "object", maxProperties: 0 },
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
			const input = record(ctx.input ?? {}), run = input.example === true ? null : input.run === undefined ? undefined : name(input.run, "run");
			let board = boards.get(ctx.instanceId);
			if (board && (board.run !== run || board.actor !== ctx.sessionId))
				throw new CanvasError("map_scope_changed", "Open a new panel for a different run");
			if (!board) {
				let selected = run;
				const snapshot = async () => {
					if (selected === null) return example;
					selected ??= defaultRun(ctx.sessionId);
					return selected ? mapSnapshot(await readStatus(selected, ctx.sessionId)) :
						{ notice: "No Foundry run is visible in this session. Open the map in a run’s owner or writer session." };
				};
				const server = snapshot().then(() => serveMap(snapshot));
				board = { run, actor: ctx.sessionId, snapshot, server };
				boards.set(ctx.instanceId, board);
				server.catch(() => { if (boards.get(ctx.instanceId) === board) boards.delete(ctx.instanceId); });
			}
			return { url: (await board.server).url, title: run ? `Foundry · ${run}` : run === null ? "Foundry · Example map" : "Foundry dependency map" };
		},
		onClose: async ctx => {
			const board = boards.get(ctx.instanceId);
			if (!board || board.actor !== ctx.sessionId) return;
			boards.delete(ctx.instanceId);
			await (await board.server).close();
		},
	});
}
