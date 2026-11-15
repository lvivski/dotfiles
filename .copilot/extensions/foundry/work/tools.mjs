/** @typedef {import("./model.js").Json} Json */
/** @typedef {ReturnType<typeof import("./runtime.mjs").createRuntime>} Runtime */

const string = { type: "string", minLength: 1 };
const object = { type: "object" };
const strings = { type: "array", items: string };
const list = { type: "array", items: object };

/** @type {Array<[string,string,Record<string,Json>,string[]]>} */
const definitions = [
	["start_goal", "Create a user-authorized goal and compile accepted work without model planning or extra approvals. Scope uses explicit mode, allowed workTypes, paths, restrictions and delegation. Optional limits are recorded workers, observed credits, absolute deadline and extra repairs. Source contracts are .foundry foundry-contract version 1.", { source: string, title: string, projectId: string, scope: object, limits: object, tasks: list }, []],
	["get_context", "Read relevant owned work, named inputs, scoped lessons and ready tasks. Consume this owner's wake generation and return coalesced outgoing native messages; do not poll or forward leaf progress globally.", { goalId: string, taskId: string }, []],
	["create_team", "Create a named team with local context under an existing authorized goal. Team names are open-ended, not a compiled organization chart.", { goalId: string, name: string, context: strings }, ["goalId", "name"]],
	["create_task", "Delegate a recorded unit under existing scope. Supply only narrowing scope overrides; inherited restrictions are preserved automatically. Only named inputs determine readiness. Checks use stable id, origin, requirement, kind and pinned version.", { goalId: string, parentId: string, teamId: string, title: string, assignment: string, workType: string, scope: object, checks: list, inputs: list }, ["goalId", "title", "assignment", "workType"]],
	["prepare_dispatch", "Reserve eligible work and return prepared complete create_session calls plus explicit per-task blockers. Already prepared calls are never hidden by a later capacity wait. Execute independent calls concurrently. Native hooks record issuance and bind returned identities, without activation or another approval.", { goalId: string, taskIds: strings }, []],
	["start_task", "Reserve in-session work under its goal's own limits and bind it to this actual caller. Resume a capacity-parked repair in its existing worker; do not create a replacement session or fabricate a creation effect.", { taskId: string }, ["taskId"]],
	["prepare_check", "Prepare the assigned immutable command oracle for execution through the ordinary native bash permission pipeline. Execute the returned command; its raw artifact is captured as evidence. No extra model verifier or completion approval.", { taskId: string, attemptId: string, checkId: string }, ["taskId", "checkId"]],
	["run_check", "Run an assigned immutable check through the native bash permission pipeline in one call. Optional artifactFiles checks execute a captured file bundle and return evidence.candidate for evaluated output publication. With repair:true, a checked failure records and reserves a fresh same-worker attempt atomically under its goal's limits; implement next, without activation, bookkeeping or a parent wake.", { taskId: string, attemptId: string, checkId: string, repair: { type: "boolean" } }, ["taskId", "checkId"]],
	["reconcile_native", "Inspect an actual native session and reconcile its issued assignment inline. Native inspection verifies the original creator and project. Caller-provided receipts, tokens and names do not grant ownership.", { sessionId: string }, ["sessionId"]],
	["report_result", "Record an outcome from admitted pinned evidence. With repair:true, record a checked failure and reserve its fresh same-worker attempt atomically under its goal's limits. Parked repairs retain that worker; stale/cancelled outcomes remain history and cannot start repairs.", { taskId: string, attemptId: string, resultId: string, state: { enum: ["done", "failed", "blocked"] }, summary: string, outputs: list, findings: list, repair: { type: "boolean" } }, ["taskId", "summary"]],
	["retry_task", "Reopen the exact failed or blocked current attempt for an in-scope repair; its next reservation receives a fresh token. Repair is not a new approval plan.", { taskId: string, attemptId: string }, ["taskId", "attemptId"]],
	["wait_task", "Mark a real native input request, solely waiting parent or capacity wait. Release execution capacity only after substantive commands have settled; preserve native request identity.", { taskId: string, kind: { enum: ["input", "children", "capacity"] }, requestId: string, reason: string }, ["taskId", "kind", "reason"]],
	["resume_task", "Reacquire available capacity under this goal's limits for local integration or resumed work on the same attempt. Do not duplicate the native worker or automatically steal a freed child slot.", { taskId: string }, ["taskId"]],
	["cancel_task", "Cancel the recorded subtree and prepare cooperative stops for every known descendant, including late bindings. Commands and claims remain tracked until settled. Never archive user worktrees or require global terminal inventories.", { taskId: string }, ["taskId"]],
	["claim", "Claim an actual mutable surface/resource for an owned attempt. Separate worktrees can edit the same relative path concurrently; shared integration surfaces require local claims.", { attemptId: string, surface: string, resource: string }, ["attemptId", "surface", "resource"]],
	["release_claim", "Release only this attempt's settled resource claim, without releasing a newer attempt's claim.", { claimId: string }, ["claimId"]],
	["prepare_command", "Associate an ordinary native bash command with this actual executing unit when multiple local attempts share the caller. This is attribution, not a governing check or another approval.", { taskId: string, attemptId: string, command: string }, ["taskId", "command"]],
	["reassign_task", "Transfer an owned subtree to another native coordinator under existing authority. Preserve original native creation provenance; do not self-adopt a sibling or reinterpret old evidence.", { taskId: string, newOwner: string }, ["taskId", "newOwner"]],
	["reassign_team", "Transfer an existing team's charter and coordinator-owned units to a verified replacement. Preserve delegated leaves, context and original native creation ancestry.", { teamId: string, newOwner: string }, ["teamId", "newOwner"]],
	["evolve_task", "Revise this task's derived checks or named inputs under existing scope. Preserve user/contract/standing obligations, retire superseded attempts and invalidate only unpinned real dependents. Explicitly pinned published inputs retain their versions. No global DAG approval.", { taskId: string, expectedVersion: { type: "integer", minimum: 1 }, checks: list, inputs: list }, ["taskId", "expectedVersion"]],
	["record_usage", "Debit an actual observed native AI-credit event once, including late attempt usage. Do not substitute tokens or estimates for credits or advertise post-hoc accounting as a hard ceiling.", { attemptId: string, credits: { type: "number", minimum: 0 }, eventId: string }, ["attemptId", "credits", "eventId"]],
	["record_signal", "Route an evidenced, scoped observation to the affected team's or task's accountable coordinator. Signals do not silently become requirements or a globally reapproved DAG.", { goalId: string, taskId: string, teamId: string, kind: string, summary: string, references: strings }, ["goalId", "kind", "summary"]],
	["record_lesson", "Preserve a concise evidenced lesson by goal and work type for relevant future assignments, not another global prohibition or full-history prompt.", { goalId: string, workType: string, summary: string, references: strings }, ["goalId", "workType", "summary"]],
	["mark_wake_sent", "Record native queue acceptance for one coalesced wake generation. Sending is not task execution; generation N cannot swallow a concurrent N+1 wake.", { wakeId: string, generation: { type: "integer", minimum: 1 } }, ["wakeId", "generation"]],
];

/** @param {Runtime} runtime @returns {import("@github/copilot-sdk").Tool[]} */
export function buildTools(runtime) {
	return definitions.map(([operation, description, properties, required]) => ({
		name: `foundry_${operation}`, description,
		parameters: { type: "object", additionalProperties: false, properties, required },
		handler: async (args, invocation) => {
			try {
				return JSON.stringify(await runtime.operation(operation, args, invocation.sessionId));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const code = error instanceof Error && "code" in error ? String(error.code) : "foundry_error";
				runtime.log(`${operation}: ${message}`);
				return { resultType: "failure", textResultForLlm: JSON.stringify({ code, message }) };
			}
		},
	}));
}
