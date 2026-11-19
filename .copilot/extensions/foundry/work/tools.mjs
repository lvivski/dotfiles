/** @typedef {ReturnType<typeof import("./runtime.mjs").createRuntime>} Runtime */
const string = { type: "string", minLength: 1 };
const strings = { type: "array", items: string };
/** @type {Array<[string,string,Record<string,import("./model.js").Json>]>} */
const definitions = [
	["start", "Start or resume a committed .foundry graph on explicit operator direction. A seed is one-off; otherwise squads discover work.", { source: string }],
	["pause", "Stop new Foundry work without discarding native calls, evidence, worktrees or checked products.", { run: string }],
	["observe", "Bound scout: cite committed evidence. Only regenerate requests owned grains; otherwise leave grains empty. For needs-decision, put the contract question in reason.", { run: string, token: string, outcome: { type: "string", enum: ["regenerate", "no-gap", "needs-decision"] }, reason: string, evidence: strings, grains: strings }],
	["submit", "Bound writer: capture and check the complete assigned directory. A failed check returns its bounded repair or blocker. Never supply a command or a success claim.", { run: string, token: string }],
	["status", "Inspect the graph, operator questions, blockers, prepared native calls and exact qualified product. Reading does not advance it.", { run: string }],
];

/** @param {Runtime} runtime @returns {import("@github/copilot-sdk").Tool[]} */
export function buildTools(runtime) {
	return definitions.map(([op, description, properties]) => ({
		name: `foundry_${op}`, description, parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
		handler: async (args, invocation) => {
			try {
				if (invocation.agentId)
					throw new Error("Foundry operations belong to the assigned native session, not its subagents");
				return JSON.stringify(await runtime.operation(op, args, invocation.sessionId));
			}
			catch (error) {
				return { resultType: "failure", textResultForLlm: error instanceof Error ? error.message : String(error) };
			}
		},
	}));
}
