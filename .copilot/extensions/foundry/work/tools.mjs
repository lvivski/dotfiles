import { FoundryError } from "./values.mjs";

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
	["resume", "On explicit owner request, continue a paused run, recover interrupted discovery or an unclaimed writer launch, or retry missing goal evidence. Never create a run or replay an issued call.", { source: string }],
	["pause", "Stop new Foundry work without discarding native calls, evidence, worktrees or checked products.", { run: string }],
	["claim", "Recover only an existing uncertain writer: the original child proves its kickoff and native get_session identity, then the original issuer verifies the launch request. Never launches or checks work.", { run: string, grain: string }],
	["rereview", "Only on explicit owner request: start one fresh review for this still-current blocked review ID after verifying its terminal native no-report prompt-budget failure. No sibling or refused work is retried.", { run: string, review: string }],
	["clarify", "Only on the owner's explicit request after losing a charter question: reopen that exact native text dialog using its recovery fields from foundry_status. The operator enters the clarification; it cannot change the contract or approve permissions.", { run: string, review: string, presentation: string }],
	["repin", "Owner only: request operator approval of an exact committed fix to the final goal evaluator and its helpers. Provide the current pin, new full commit ID and complete changed file list. Does not change the brief, product, or in-flight checks.", { run: string, from: string, revision: string, files: strings }],
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
					return await runtime.readReference(args, invocation.sessionId, invocation.agentId);
				}
				if (fromHelper(invocation, primary()))
					throw new Error(primaryOnly);
				if (op === "claim") return JSON.stringify(await runtime.claimWriter(args, invocation.sessionId));
				return JSON.stringify(await runtime.operation(op, args, invocation.sessionId));
			}
			catch (error) {
				if (error instanceof FoundryError && error.code === "approval_declined")
					return { resultType: "rejected", textResultForLlm: error.message };
				return { resultType: "failure", textResultForLlm: error instanceof Error ? error.message : String(error) };
			}
		},
	}));
}
