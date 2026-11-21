/** @typedef {ReturnType<typeof import("./runtime.mjs").createRuntime>} Runtime */
export const primaryOnly = "Foundry operations belong to the assigned native session, not its subagents";
/** @param {{sessionId:string,agentId?:string,parentAgentId?:string,agentType?:string}} input @param {string} primary */
export const fromHelper = (input, primary) => !!(input.agentId || input.parentAgentId || input.agentType) || input.sessionId !== primary;
const string = { type: "string", minLength: 1 };
/** @type {Array<[string,string,Record<string,import("./model.js").Json>]>} */
const definitions = [
	["start", "Start or resume a committed .foundry brief only on explicit operator direction. goalCheck defines the finish line for squads; seed selects a one-off instead.", { source: string }],
	["pause", "Stop new Foundry work without discarding native calls, evidence, worktrees or checked products.", { run: string }],
	["submit", "Bound writer: after joining your helpers and integrating their files, capture and check the complete assigned directory. A failed check returns its bounded repair or blocker. Never supply a command or a success claim.", { run: string, token: string }],
	["status", "Inspect assignments, blockers and exact receipts. A goal checkpoint is not qualification. For an explicit owner request use detail: proof, cleanup or usage. Reading never advances or archives work.", { run: string, detail: { type: "string", enum: ["proof", "cleanup", "usage"] } }],
];

/** @param {Runtime} runtime @param {()=>string} primary @returns {import("@github/copilot-sdk").Tool[]} */
export function buildTools(runtime, primary) {
	return definitions.map(([op, description, properties]) => ({
		name: `foundry_${op}`, description, parameters: { type: "object", properties, required: Object.keys(properties).filter(k => k !== "detail"), additionalProperties: false },
		handler: async (args, invocation) => {
			try {
				if (fromHelper(invocation, primary()))
					throw new Error(primaryOnly);
				return JSON.stringify(await runtime.operation(op, args, invocation.sessionId));
			}
			catch (error) {
				return { resultType: "failure", textResultForLlm: error instanceof Error ? error.message : String(error) };
			}
		},
	}));
}
