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
