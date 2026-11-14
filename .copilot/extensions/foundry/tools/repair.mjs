import { handler } from "./results.mjs";
import { DIGEST, NON_EMPTY, objectSchema, PLAN_ID } from "./schema.mjs";

/** @param {Pick<import("../tools.mjs").ToolOperations, "preparePlanRepair"|"launchPlanRepair"|"reconcilePlanRepair"|"importPlanRepair">} operations */
export function repairTools(operations) {
	const identity = { preparationId: DIGEST, preparationDigest: DIGEST };
	/** @satisfies {import("@github/copilot-sdk").Tool[]} */
	const tools = [
		{
			name: "foundry_prepare_plan_repair",
			description: "Prepare one owner-bound repair of an eligible completed native plan's semantic rejection. Reads native source; accepts no supplied results or critics. Retains the exact source and one durable shared allowance. Does not launch, approve or modify the original. Repeats return the existing preparation/hold.",
			parameters: objectSchema(["runId", "repositoryPath"], { runId: NON_EMPTY(256), repositoryPath: NON_EMPTY(4096) }),
			handler: handler((input, invocation) => operations.preparePlanRepair(input, { invocation, signal: invocation.signal })),
		},
		{
			name: "foundry_launch_plan_repair",
			description: "Admit exactly the retained plan-repair launch through the offered run_dynamic_workflow tool and normal native resource permission. Durable intent precedes one invocation. Denied, unavailable or uncertain outcomes retain the claim; never retry or manually relaunch its launchSpec. This grants no plan approval.",
			parameters: objectSchema(Object.keys(identity), identity),
			handler: handler((input, invocation) => operations.launchPlanRepair(input, { invocation, signal: invocation.signal })),
		},
		{
			name: "foundry_reconcile_plan_repair",
			description: "Read a unique matching owner-native repair observation for the retained preparation after uncertain admission. Never launches, resets the budget or treats tool-call correlation as idempotency. Missing/ambiguous observations retain the hold.",
			parameters: objectSchema(Object.keys(identity), identity),
			handler: handler((input, invocation) => operations.reconcilePlanRepair(input, { invocation, signal: invocation.signal })),
		},
		{
			name: "foundry_import_plan_repair",
			description: "Import a ready independently conservation-reviewed repair into an ordinary draft after rechecking native source/result, owner, repository/factory authority and durable journal. Original failed result remains immutable. Normal submission and exact-revision plan approval remain required.",
			parameters: objectSchema([...Object.keys(identity), "id", "repository", "runId", "expectedRevision"], {
				...identity, id: PLAN_ID, runId: NON_EMPTY(256), expectedRevision: { const: 0 },
				repository: objectSchema(["workingDirectory", "baseBranch"], { workingDirectory: NON_EMPTY(4096), baseBranch: NON_EMPTY(512) }),
			}),
			handler: handler((input, invocation) => operations.importPlanRepair(input, { invocation, signal: invocation.signal })),
		},
	];
	return tools.map(tool => ({ ...tool, skipPermission: undefined }));
}
