import { handler } from "./results.mjs";
import { DIGEST, NON_EMPTY, objectSchema, PLAN_ID } from "./schema.mjs";

/** @param {Pick<import("../tools.mjs").ToolOperations, "preparePlanRepair"|"launchPlanRepair"|"reconcilePlanRepair"|"importPlanRepair">} operations */
export function repairTools(operations) {
	const identity = { preparationId: DIGEST, preparationDigest: DIGEST };
	/** @satisfies {import("@github/copilot-sdk").Tool[]} */
	const tools = [
		{
			name: "foundry_prepare_plan_repair",
			description: "Prepare owner-bound recovery of a completed native plan's semantic rejection. Reads and retains original inputs, critics and lineage without resetting historical claims. Fresh effects require independent substantive review and authentic atomic native admission; unavailable providers hold. Does not launch or approve.",
			parameters: objectSchema(["runId", "repositoryPath"], { runId: NON_EMPTY(), repositoryPath: NON_EMPTY(), continuationOf: NON_EMPTY() }),
			handler: handler((input, invocation) => operations.preparePlanRepair(input, { invocation, signal: invocation.signal })),
		},
		{
			name: "foundry_launch_plan_repair",
			description: "Request an independently reviewed exact proposed repair effect with authentic atomic native authority/resource/budget admission and normal permission. Local intent is only an outbox; plain tools.execute is not an admission provider. No automatic repair loop or plan approval. Uncertain outcomes reconcile without replacement invocation.",
			parameters: objectSchema(Object.keys(identity), { ...identity, effectId: DIGEST }),
			handler: handler((input, invocation) => operations.launchPlanRepair(input, { invocation, signal: invocation.signal })),
		},
		{
			name: "foundry_reconcile_plan_repair",
			description: "Read a unique matching owner-native repair observation for the retained preparation after uncertain admission. Never launches, resets the budget or treats tool-call correlation as idempotency. Missing/ambiguous observations retain the hold.",
			parameters: objectSchema(Object.keys(identity), { ...identity, effectId: DIGEST }),
			handler: handler((input, invocation) => operations.reconcilePlanRepair(input, { invocation, signal: invocation.signal })),
		},
		{
			name: "foundry_import_plan_repair",
			description: "Import a ready independently conservation-reviewed repair into an ordinary draft after rechecking native source/result, owner, repository/factory authority and durable journal. Original failed result remains immutable. Normal submission and exact-revision plan approval remain required.",
			parameters: objectSchema([...Object.keys(identity), "id", "repository", "runId", "expectedRevision"], {
				...identity, effectId: DIGEST, id: PLAN_ID, runId: NON_EMPTY(), expectedRevision: { const: 0 },
				repository: objectSchema(["workingDirectory", "baseBranch"], { workingDirectory: NON_EMPTY(), baseBranch: NON_EMPTY() }),
			}),
			handler: handler((input, invocation) => operations.importPlanRepair(input, { invocation, signal: invocation.signal })),
		},
	];
	return tools.map(tool => ({ ...tool, skipPermission: undefined }));
}
