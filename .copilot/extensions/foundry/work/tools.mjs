/** @typedef {ReturnType<typeof import("./runtime.mjs").createRuntime>} Runtime */
export const primaryOnly = "Foundry operations belong to the assigned native session, not its subagents";
/** @param {{sessionId:string,agentId?:string,parentAgentId?:string,agentType?:string}} input @param {string} primary */
export const fromHelper = (input, primary) => !!(input.agentId || input.parentAgentId || input.agentType) || input.sessionId !== primary;
const string = { type: "string", minLength: 1 };
const strings = { type: "array", items: string, uniqueItems: true };
/** @typedef {Record<string,import("./model.js").Json>} Properties */
/** @type {Array<[name:string,description:string,required:Properties,optional?:Properties]>} */
const definitions = [
	["start", "Start or resume a committed .foundry brief only on explicit operator direction. goalCheck defines the finish line for squads; seed selects a one-off instead.", { source: string }],
	["resume", "On explicit owner request, continue an existing paused run or retry missing goal evidence or interrupted unbound discovery. Never create a run or replay a writer.", { source: string }],
	["pause", "Stop new Foundry work without discarding native calls, evidence, worktrees or checked products.", { run: string }],
	["submit", "Bound writer: after joining helpers, capture and check your complete directory. Optionally identify exact offered blobs you used or actually compared against the product. These are writer reports, not check results. A failed check returns a bounded repair or blocker.", { run: string, token: string }, { usedArtifacts: strings, comparedArtifacts: strings }],
	["publish", "Offer one explicitly selected regular file as immutable reference material, not a new requirement. file is relative to your checkout; to lists recipient charter areas or assignment directories. Only the owner or the writing assignment that owns the file (include token) may publish.", { run: string, file: string, to: strings }, { token: string }],
	["status", "Inspect assignments, blockers and exact receipts. A goal checkpoint is not qualification. For an explicit owner request use detail: proof, cleanup or usage. Reading never advances or archives work.", { run: string }, { detail: { type: "string", enum: ["proof", "cleanup", "usage"] } }],
	["reference", "Bound Foundry researcher: read a permitted UTF-8 file from a local sibling Git checkout at the exact published commit. Not a checkout read, shell, or visual observation.", { run: string, review: string, repo: string, revision: string, path: string }],
];

/** @param {Runtime} runtime @param {()=>string} primary @returns {import("@github/copilot-sdk").Tool[]} */
export function buildTools(runtime, primary) {
	return definitions.map(([op, description, required, optional]) => ({
		name: `foundry_${op}`, description, parameters: { type: "object", properties: { ...required, ...optional }, required: Object.keys(required), additionalProperties: false },
		handler: async (args, invocation) => {
			try {
				if (op === "reference") {
					if (invocation.sessionId !== primary() || !invocation.agentId) throw new Error("Only a bound research subagent may use the pinned reader");
					return runtime.readReference(args, invocation.sessionId);
				}
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
