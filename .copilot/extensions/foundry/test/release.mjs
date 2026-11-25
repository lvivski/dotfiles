import assert from "node:assert/strict";
import { factory } from "./fixture.mjs";

export const run = "example", source = ".foundry/example.json", journey = ".foundry/example/journey.md";
export const api = "producer/version", stored = "consumer/stored";
/** @param {import("node:test").TestContext} t @param {string[]} ids @param {string} goal @param {number} [assignments] @param {typeof factory} [build] */
export function fixture(t, ids, goal, assignments, build = factory) {
	return build(t, run, source, {
		[source]: JSON.stringify({ version:2, id:run, target:"refs/heads/main", direction:"Ship a usable output.",
			productCheck:"product.mjs", goalCheck:"goal.mjs", limits:{assignments},
			squads:ids.map(id => ({id, areas:[id], charter:`${id}.md`, checks:["unit.mjs"]})) }),
		[journey]:"Ship a usable output.", ...Object.fromEntries(ids.map(id => [`${id}.md`,`Own ${id}.`])),
		[api]:"v1", "consumer/version":"v1", "reference":"Another implementation.", "manual/next":"Further evidence.",
		"product.mjs":"", "unit.mjs":"", "goal.mjs":`import {existsSync as has, readFileSync} from "node:fs";
		const read = p => readFileSync(p,"utf8"); if (!(${goal})) process.exit(1);`,
	});
}
/** @param {string} id @param {string[]} [evidence] @param {string[]} [needs] */
export const propose = (id, evidence = [`${id}.md`], needs = []) => ({outcome:"regenerate", reason:`Implement ${id}.`, evidence,
	grains:[{id, directory:id, task:`Implement ${id}.`, check:"unit.mjs", needs}]});
/** @param {string} id */
export const noGap = id => ({outcome:"no-gap",reason:"Nothing to change.",evidence:[`${id}.md`],grains:[]});
/** @param {string} file */
export const readFile = file => ({outcome:"needs-evidence",reason:"Read the interface.",file,evidence:[journey],grains:[]});
/** @param {ReturnType<typeof fixture>} f @param {string} id */
export const worker = (f,id) => f.workers.get(f.owner.inspect({run},"owner").nodes.find(n=>n.grain===id)?.worker ?? "") ?? assert.fail(`missing ${id}`);
/** @param {ReturnType<typeof fixture>} f @param {ReturnType<typeof worker>} w */
export const submit = (f,w) => f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
/** @param {ReturnType<typeof fixture>} f */
export const proof = f => f.owner.inspect({run,detail:"proof"},"owner");
