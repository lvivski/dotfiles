import { catalog } from "../work/catalog.mjs";
import { loadEntry } from "./fixture.mjs";

/** Project declarations only. No hook, tool, evaluator or canvas is invoked. */
export async function declaredInterface() {
	/** @type {string[]} */ const events = [];
	const entry = await loadEntry({sessionId:"specification", on(/** @type {string} */ event) { events.push(event); }});
	return {
		charts: catalog(),
		tools: Object.fromEntries(entry.tools.map((/** @type {import("@github/copilot-sdk").Tool} */ t) =>
			[t.name, {description:t.description, parameters:t.parameters}])),
		canvases: Object.fromEntries(entry.canvases.map((/** @type {{id:string,inputSchema:object,actions:{name:string,inputSchema?:object}[]}} */ c) =>
			[c.id, {inputSchema:c.inputSchema, actions:Object.fromEntries(c.actions.map(a=>[a.name,a.inputSchema ?? null]))}])),
		workflows: Object.fromEntries(entry.workflows.map((/** @type {{meta:{name:string,argsSchema:object}}} */ w) => [w.meta.name,w.meta.argsSchema])),
		agents: Object.fromEntries(entry.customAgents.map((/** @type {{name:string,tools:string[]}} */ a) => [a.name,a.tools])),
		hooks: Object.keys(entry.hooks).sort(),
		events: events.sort(),
	};
}

if (import.meta.main) process.stdout.write(JSON.stringify(await declaredInterface(),null,2)+"\n");
