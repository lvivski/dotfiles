import assert from "node:assert/strict";
import { openDatabase } from "../work/database.mjs";
import { put } from "./fixture.mjs";
import { fixture, propose, run as trial, submit, worker } from "./release.mjs";

export const activation = 1700000000000, base = "a".repeat(40), tip = "b".repeat(40), commit = "c".repeat(40);
/** @returns {import("../work/model.js").Run} */
export function run() {
	return { id: "catalog", owner: "owner", activatedAt: activation, active: true, nodes: {}, effects: [], products: [],
		policy: { id: "catalog", base, target: "refs/heads/main", source: ".foundry/test.json", direction: "Find a price",
			productCheck: "invariants", files: [], squads: [], repairs: 0 } };
}
/** @param {string} id */
export const prompt = id => `Foundry assignment: catalog private-token-${id}\nImplement ${id}`;
/** @param {string} nativeId @param {number} [delta] @returns {import("../work/model.js").NativeCall} */
export const writer = (nativeId, delta = 3) => ({ id: `effect-${nativeId}`, issuer: "owner", nativeId, state: "done", kind: "writer",
	tool: "create_session", args: { kickoff: { prompt: prompt(nativeId) } }, boundAt: activation + delta });

/** Keep the release evidence real; only the two display clocks are synthetic.
 * @param {import("node:test").TestContext} t @param {number} delay @param {boolean} baseline */
export async function finished(t,delay,baseline){
	const f=fixture(t,["prices"],baseline?"true":"has('prices/value')");
	await f.start();
	if(!baseline){
		await f.scouts[0].report(propose("prices"));
		const w=worker(f,"prices");put(w.cwd,"prices/value","10");await submit(f,w);await f.settle();
	}
	const db=openDatabase(f.root);
	try{
		const saved=db.read(trial)??assert.fail(),r=structuredClone(saved),p=r.products.at(-1);
		assert.ok(p?.qualifiedAt && r.goal?.commit===p.commit);
		for(const id of [p.check,r.goal.check]){
			const e=saved.effects.find(e=>e.id===id);assert.ok(e?.tool==="bash" && e.receipt?.exit===0);db.verifySigned(trial,e);
		}
		r.activatedAt=activation;p.qualifiedAt=activation+delay;return r;
	}finally{db.close();}
}
