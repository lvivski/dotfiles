import { catalog } from "../work/catalog.mjs";
import { loadEntry } from "./fixture.mjs";

/** Project declarations only. No hook, tool, evaluator or canvas is invoked. */
export async function declaredInterface() {
	/** @type {string[]} */ const events = [];
	const entry = await loadEntry({sessionId:"specification", on(/** @type {string} */ event) { events.push(event); }});
	return {
		charts: catalog(),
		tools: Object.fromEntries(entry.tools.map(t =>
			[t.name, {description:t.description, parameters:t.parameters}])),
		canvases: Object.fromEntries(entry.canvases.map(({declaration:c}) =>
			[c.id, {inputSchema:c.inputSchema, actions:Object.fromEntries((c.actions ?? []).map(a=>[a.name,a.inputSchema ?? null]))}])),
		workflows: Object.fromEntries(entry.workflows.map(({meta}) => [meta.name,meta.argsSchema])),
		agents: Object.fromEntries(entry.agents.map(a => [a.name,a.tools])),
		hooks: Object.keys(entry.hooks).sort(),
		events: events.sort(),
	};
}

if (import.meta.main) process.stdout.write(JSON.stringify(await declaredInterface(),null,2)+"\n");
