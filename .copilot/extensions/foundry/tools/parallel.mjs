import { handler } from "./results.mjs";
import { ATTEMPT_ID, objectSchema, PLAN_ID, REQUEST_ID, TASK_ID } from "./schema.mjs";

/** @param {Pick<import("../tools.mjs").ToolOperations, "dispatchReady" | "reconcileParallel" | "materializeInputs" | "assessPackage">} operations */
export function parallelTools(operations) {
	return [
		{
			name: "foundry_dispatch_ready",
			skipPermission: undefined,
			description: "Visit one bounded ready set through the owning coordinator's supported native host route. Reconcile retained reservations before admitting fresh work; persist delivery before readiness. Missing host observations hold without launching children or falling back to workflows.",
			parameters: objectSchema(["planId", "limit"], {
				planId: PLAN_ID, limit: { type: "integer", minimum: 1, maximum: 128 },
			}),
			handler: handler((args, invocation) => operations.dispatchReady(args, { signal: invocation.signal, invocation })),
		},
		{
			name: "foundry_reconcile_parallel",
			skipPermission: undefined,
			description: "Reconcile this exact owned admission once after an App notification or explicit request. No replacement, timers, guessed termination or caller inventory. Cancellation recovery requires the durable plan fence and complete owned admission enumeration.",
			parameters: objectSchema(["planId", "taskId", "reservationId"], {
				planId: PLAN_ID, taskId: TASK_ID, reservationId: REQUEST_ID,
			}),
			handler: handler((args, invocation) => operations.reconcileParallel(args, { signal: invocation.signal, invocation })),
		},
		{
			name: "foundry_materialize_inputs",
			skipPermission: undefined,
			description: "Materialize only the full immutable descriptor pinned in the creation journal, into its currently corroborated, attached and handed-off consumer worktree. The owning coordinator supplies identities only; manual copies, paths, receipts and imported history are not authority.",
			parameters: objectSchema(["planId", "taskId", "attemptId"], {
				planId: PLAN_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID,
			}),
			handler: handler((args, invocation) => operations.materializeInputs(args, { signal: invocation.signal, invocation })),
		},
		{
			name: "foundry_assess_package",
			skipPermission: undefined,
			description: "Prepare the exact delivered package assurance subject, or assess a report against it. Reviewer authority and a separate complete current all-contributor inventory (including runtime helpers) come only from trusted host readers. Delivery is not independent verification; executablePassed and pendingHuman remain distinct. This does not approve completion.",
			parameters: objectSchema(["planId", "taskId"], {
				planId: PLAN_ID, taskId: TASK_ID, report: { type: "object" },
			}),
			handler: handler((args, invocation) => operations.assessPackage(args, { signal: invocation.signal, invocation })),
		},
	];
}
