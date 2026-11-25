import { FoundryError } from "./values.mjs";

/** @typedef {Pick<ReturnType<typeof import("./runtime.mjs").createRuntime>, "inspect"|"claimWriter"|"operation"|"readReference">} Commands */
export const primaryOnly = "Foundry operations belong to the assigned native session, not its subagents";
/** @param {{sessionId:string,agentId?:string,parentAgentId?:string,agentType?:string}} input @param {string} primary */
export const fromHelper = (input, primary) => !!(input.agentId || input.parentAgentId || input.agentType) || input.sessionId !== primary;
const string = { type: "string", minLength: 1 };
const strings = { type: "array", items: string, uniqueItems: true };
const stop = {type:"object",properties:{check:string,reason:string},required:["check","reason"],additionalProperties:false};
/** @typedef {Record<string,import("./model.js").Json>} Properties */
/** @type {Array<[name:string,description:string,required:Properties,optional?:Properties]>} */
const definitions = [
	["workspace", "Bound pooled writer only: open the fresh checkout inside this session's native worktree for this assignment, or verify its existing checkout after reload. Work only under the returned node's workspace. Does not switch branches, copy old work or run checks.", {run:string,token:string}],
	["restore","Owner on operator direction: request approval for a fresh writer to attest only the unchanged, orphaned primary of a formerly checked mixed grant. The current owner retains all its integration files. Name the historical and current product check IDs and settled current goal ID. No prior output or verdict is edited or reused.",{run:string,from:string,historical:string,retainer:string,to:string,checkpoint:string,goal:string}],
	["pair","Owner on operator direction: request approval for one read-only observation after a signed exit-1 restoration. Name the failed check, unchanged checkpoint and goal, and the published retainer's exact grain, candidate and passing component check. Only a different assembly is eligible. No writer, edit, verdict replacement or retry of a negative pair.",{run:string,grain:string,failed:string,checkpoint:string,goal:string,retainer:string,candidate:string,component:string}],
	["reuse", "On operator direction, the run owner may request one same-run successor for an exhausted, failed component. Supply its grain, failed component check ID, exact retained candidate commit and a correction blob already offered to this directory. On approval the new writer starts with that directory on the current checked product. No old receipt is replayed or promoted.", {run:string,grain:string,check:string,candidate:string,blob:string}],
	["correct", "Owner: request approval to remove one verbatim contradictory clause from an original, still-bound comparison or checked stopped-predecessor handoff. Name the assigning review, existing worker and a file + verbatim excerpt from the frozen product (in grant for a handoff). Does not add instructions, grant reads, notify or launch a writer, or run checks. After approval, direct that writer to read its status.", {run:string, grain:string, review:string, worker:string, clause:string, file:string, excerpt:string}],
	["attribute", "Owner only: route a shared failed step from the current unmet goal when its evaluator lacked structured blocker data. Quote the receipt verbatim. blocked counts dependent journeys not run, excluding the one failure. Scheduling context, not a verdict.", {run:string,receipt:string,id:string,directory:string,excerpt:string,blocked:{type:"integer",minimum:1}}],
	["configure", "On operator direction, change scheduling for future reservations without pausing. Use the current scheduling.revision from owner status. workers:null restores the committed ceiling. checkpointReviews controls new pending-goal and source-backed comparisons, and automatic discovery from prior failures while a goal is pending or after exit 2.", {run:string,revision:{type:"integer",minimum:0}}, {workers:{type:["integer","null"],minimum:1},checkpointReviews:{type:"boolean"}}],
	["iterate", "Owner: route an offered comparison to one production directory. Use the unmet goal ID, or the passing product check ID while its goal is pending. After a settled exit 2, use the current goal ID and source:{commit,file,excerpt} for an operator-approved new review on that exact checked product. Alternatively use historical:{receipt,step} for an omitted same-product failure, or the original directory/blob for a superseded exhausted-directory overlap on unchanged inputs. Starts a scoped review, not a writer or release check; cannot repurpose live work.", {run: string, directory: string, receipt: string, blob: string, question: string},
		{files:{...strings,minItems:1,description:"Exact existing integration files for a source-backed review with a file-aware product checker; never grants a parent directory."}, historical:{type:"object", properties:{receipt:string, step:string}, required:["receipt","step"], additionalProperties:false},
			transfer:{type:"object",description:"Separately approve a conditional transfer from the exact qualified parent to a new ID. Requires source, files and an exclusion-aware checker.",properties:{from:string,candidate:string,to:string},required:["from","candidate","to"],additionalProperties:false},
			successor:{type:"object",description:"Separately approve one new, strictly narrower assignment from the current product after writer-relinquished or writer-cannot-repair. Requires source and the original signed component check. Does not seed a candidate or release sibling paths.",properties:{from:string,check:string,to:string},required:["from","check","to"],additionalProperties:false},
			source:{type:"object",properties:{commit:string,file:string,excerpt:string},required:["commit","file","excerpt"],additionalProperties:false}}],
	["preview", "Bound writer, after joining helpers: pin a midpoint snapshot of all assigned directories on the frozen generation for owner inspection. No submission, validation, permission change or new assignment.", {run: string, token: string}],
	["review_note", "Owner only: attach an exact historical goal receipt and a question to the named squad's next normal review. Does not start discovery or assign work. Use a receipt ID from proof status; optional excerpt must be verbatim.", { run: string, squad: string, receipt: string, question: string }, { excerpt: string }],
	["start", "Activate a committed .foundry brief only on explicit operator direction. Use resume to recover existing reservations or a missing observation. goalCheck defines the finish line for squads; seed selects a one-off instead.", { source: string }],
	["resume", "On explicit owner request, continue a paused run, recover interrupted discovery or an unclaimed writer launch, or retry missing goal evidence. Never create a run or replay an issued call.", { source: string }],
	["pause", "Stop new Foundry work without discarding native calls, evidence, worktrees or checked products.", { run: string }],
	["claim", "Recover only an existing uncertain writer. Select by grain, or from the original child by its own kickoff token. The child proves its kickoff and native get_session identity; the original issuer confirms by grain. Never launches or checks work.", { run: string }, { grain: string, token: string }],
	["retire", "On explicit owner request, verify a dead pre-journal goal runner in the original owner's native history. Request approval to retire that reservation without a verdict and integrate retained outputs. Never rerun the old goal.", { run: string, check: string }],
	["recheck", "On explicit operator request, approve one fresh observation after a proven pre-claim launcher exit or a signed goal with exit:null. Name the exact current check ID. Preserve its evidence. Never use for a claimed or unknown runner without an outcome or an evaluator's numeric exit.", { run: string, check: string }],
	["rereview", "Owner: recover one current review blocked by a proven scout budget failure or by omission of its approved source from the original packet. Source recovery asks for approval of one fresh scout on the same comparison. No old report, writer or check is replayed.", { run: string, review: string }],
	["clarify", "Only on the owner's explicit request after losing a charter question: reopen that exact native text dialog using its recovery fields from foundry_status. The operator enters the clarification; it cannot change the contract or approve permissions.", { run: string, review: string, presentation: string }],
	["repin", "Owner: request approval of an evaluator-only committed diff. Omit kind for the final goal. kind:product requires a quiescent checked checkpoint, opts into exact-file ownership and rechecks the same bytes before fresh goal assessment. Declare ownership:retain-except-transferred only for a reviewed exclusion-aware checker. Grants no transfer.", { run: string, from: string, revision: string, files: strings }, {kind:{type:"string",enum:["product"]},ownership:{type:"string",enum:["retain-except-transferred"]}}],
	["submit", "Bound writer, after joining helpers: submit all assigned roots together. For a genuinely missing input, use missingInput. If status shows cannotRepair and the assignment permits no further repair, use cannotRepair:{check,reason}. If status shows relinquish and neither a scoped fix nor a missing input exists, use relinquish:{check,reason} with that exact check. Relinquishing a repair retains its numeric failure without capturing, checking, or promoting bytes. For changed work after an older incomplete check, pass changedFrom from status to spend one repair.", { run: string, token: string }, { missingInput: string, cannotRepair:stop, relinquish:stop, changedFrom: string, usedArtifacts: strings, comparedArtifacts: strings }],
	["publish", "Offer a reference file with file and to (writers also need token). Or, on operator direction, the owner can request approval for original missing-input writers by assignment ID: readBaselines allows inspection of their exact prior directories without starting work, even during a check; baselines starts a bounded repair after a settled unmet goal. Use only one form. File offers never grant access.", { run: string }, { file: string, to: strings, token: string, baselines: strings, readBaselines: strings }],
	["status", "Inspect assignments, blockers and exact receipts. A goal checkpoint is not qualification. For an explicit owner request use detail: proof, cleanup or usage. Reading never advances or archives work.", { run: string }, { detail: { type: "string", enum: ["proof", "cleanup", "usage"] } }],
	["reference", "Bound Foundry researcher: read a permitted UTF-8 file from a local sibling Git checkout at the exact published commit. Not a checkout read, shell, or visual observation.", { run: string, review: string, repo: string, revision: string, path: string }],
];

/** @param {Commands} runtime @param {()=>string} primary @returns {import("@github/copilot-sdk").Tool[]} */
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
				if (op === "status") return JSON.stringify(runtime.inspect(args, invocation.sessionId));
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
