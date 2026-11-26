import { CanvasError, createCanvas } from "@github/copilot-sdk/extension";
import { example, mapSnapshot } from "./map/model.mjs";
import { serveMap } from "./map/server.mjs";
import { catalog } from "./work/catalog.mjs";
import { name, record } from "./work/values.mjs";

/** @param {(run:string, actor:string)=>ReturnType<typeof import("./work/visibility.mjs").boardFacts>} readBoard
 * @param {(actor:string)=>string|undefined} defaultRun
 * @param {(run:string,actor:string,grain:string)=>string|undefined} readSpecification */
export function foundryBoard(readBoard, defaultRun, readSpecification) {
	/** @type {Map<string,{run:string|null|undefined, machine:boolean, actor:string, snapshot:Parameters<typeof serveMap>[0], server:ReturnType<typeof serveMap>}>} */
	const boards = new Map();
	return createCanvas({
		id: "foundry-board", displayName: "Foundry",
		description: "Inspect run dependencies or simulate Foundry’s release and recovery transitions without running work.",
		inputSchema: { type: "object", oneOf: [
			{ type: "object", maxProperties: 0 },
			{ type: "object", properties: { run: { type: "string", minLength: 1 } }, required: ["run"], additionalProperties: false },
			{ type: "object", properties: { example: { const: true } }, required: ["example"], additionalProperties: false },
			{ type: "object", properties: { machine: { const:true } }, required:["machine"], additionalProperties:false },
		] },
		actions: [{ name: "get_snapshot", description: "Read the displayed dependency map without advancing the factory.",
			handler: ctx => {
				const board = boards.get(ctx.instanceId);
				if (board?.actor !== ctx.sessionId) throw new CanvasError("map_not_open", "This Foundry map is not open in this session");
				return board.snapshot();
			} }],
		open: async ctx => {
			const input = record(ctx.input ?? {}), run = input.example === true ? null : input.run === undefined ? undefined : name(input.run, "run");
			const machine=input.machine===true;
			let board = boards.get(ctx.instanceId);
			if (board && (board.run !== run || board.actor !== ctx.sessionId || board.machine!==machine))
				throw new CanvasError("map_scope_changed", "Open a new panel for a different run");
			if (!board) {
				let selected = run;
				const snapshot = async () => {
					if (machine) return catalog();
					if (selected === null) return example;
					selected ??= defaultRun(ctx.sessionId);
					return selected ? mapSnapshot(readBoard(selected, ctx.sessionId)) :
						{ notice: "No Foundry run is visible in this session. Open the map in a run’s owner or writer session." };
				};
				const server = snapshot().then(() => serveMap(snapshot,machine,
					machine || selected===null ? undefined : grain=>selected?readSpecification(selected,ctx.sessionId,grain):undefined));
				board = { run, machine, actor: ctx.sessionId, snapshot, server };
				boards.set(ctx.instanceId, board);
				server.catch(() => { if (boards.get(ctx.instanceId) === board) boards.delete(ctx.instanceId); });
			}
			return { url: (await board.server).url, title: machine ? "Foundry · State explorer" : run ? `Foundry · ${run}` : run === null ? "Foundry · Example map" : "Foundry" };
		},
		onClose: async ctx => {
			const board = boards.get(ctx.instanceId);
			if (!board || board.actor !== ctx.sessionId) return;
			boards.delete(ctx.instanceId);
			await (await board.server).close();
		},
	});
}
