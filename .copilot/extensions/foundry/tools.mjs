import { LIMITS, PLAN_STATUS, TASK_STATUS } from "./plan/values.mjs";
import { factoryTools } from "./tools/factory.mjs";
import { parallelTools } from "./tools/parallel.mjs";
import { handler } from "./tools/results.mjs";
import { ATTEMPT_ID, DIGEST, EVIDENCE_INPUT, FACTORY_ID, FACTORY_LEARNING, FACTORY_REPORT, KNOWLEDGE_REF, NON_EMPTY, objectSchema, PACKAGE_DECOMPOSITION, PLAN_ID, REFERENCES, REQUEST_ID, REVISION, SESSION_INVENTORY, STRING_LIST, TASK_ID } from "./tools/schema.mjs";

/** Tool transport deliberately does not depend on operation result internals.
 * @typedef {Record<Exclude<keyof import("./operations.mjs").FoundryOperations,
 * "storeFor" | "factoryFor" | "getPlan" | "getWorkflow" | "nextTasks" | "getActive" | "getActivation" | "deactivate">,
 * (input: unknown, options?: import("./requests.mjs").OperationContext) => unknown> & {deactivate: () => unknown}} ToolOperations */

/**
 * Builds the complete globally unique Foundry tool catalog.
 *
 * @param {ToolOperations} operations
 */
export function buildFoundryTools(operations) {
	/** @satisfies {import("@github/copilot-sdk").Tool[]} */
	const tools = [
		...factoryTools(operations),
		...parallelTools(operations),
		{
			name: "foundry_capture_analysis",
			description: "Ingest the exact completed current-session audit, research, review, security or triage report as scoped non-governing knowledge with run identity/digest and explicit uncertainty. Requires an existing capability; never launches research or promotes findings into requirements. Reports above 48,000 characters require deliberate scoped knowledge capture instead.",
			parameters: objectSchema(["repositoryPath", "unitId", "runId", "expectedRevision", "actor"], {
				repositoryPath: NON_EMPTY(4096), unitId: FACTORY_ID, runId: NON_EMPTY(256), expectedRevision: REVISION, actor: NON_EMPTY(256),
			}),
			handler: handler((args) => operations.captureAnalysis(args)),
		},
		{
			name: "foundry_create_evaluation_plan",
			description: "Create a separately owned read-only evaluation draft for an immutable delivered candidate and selected pinned evaluators. No implementation step, rebinding, code change or generation retry. Normal plan approval/reservation/App attachment/native verification still apply; original completion and selection remain unchanged.",
			parameters: objectSchema(["id", "repository", "candidateId", "expectedRevision", "expectedFactoryRevision"], {
				id: PLAN_ID, candidateId: FACTORY_ID, expectedRevision: { const: 0 }, expectedFactoryRevision: REVISION,
				repository: objectSchema(["workingDirectory", "baseBranch"], { workingDirectory: NON_EMPTY(4096), baseBranch: NON_EMPTY(512) }),
				evaluations: REFERENCES,
			}),
			handler: handler((args) => operations.createEvaluationPlan(args)),
		},
		{
			name: "foundry_record_human_judgment",
			description: "Record an actual explicitly requested human judgment against the exact pinned rubric/candidate. Ask the human first; never relabel an agent report. Supply the stable claimed judgmentId, actual source reference and performedAt separately from the publication receipt id. Retrying or renaming publication must not invent a new source/time. Identity remains claimed, not authenticated.",
			parameters: objectSchema(["repositoryPath", "expectedRevision", "id", "candidateId", "evaluation", "contractDigest", "contextDigest", "commit", "procedureDigest", "outcome", "environment", "workload", "report", "actor", "reason", "sourceRef", "judgmentId", "performedAt"], {
				repositoryPath: NON_EMPTY(4096), expectedRevision: REVISION, id: FACTORY_ID, candidateId: FACTORY_ID,
				evaluation: KNOWLEDGE_REF, contractDigest: DIGEST, contextDigest: DIGEST, procedureDigest: DIGEST,
				commit: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
				outcome: { type: "string", enum: ["passed", "failed", "inconclusive"] },
				environment: NON_EMPTY(2048), workload: NON_EMPTY(2048), report: NON_EMPTY(16000),
				actor: NON_EMPTY(256), reason: NON_EMPTY(8000), sourceRef: NON_EMPTY(4096), judgmentId: NON_EMPTY(512), performedAt: NON_EMPTY(64),
			}),
			handler: handler((args) => operations.recordHumanJudgment(args)),
		},
		{
			name: "foundry_create_factory_plan",
			description: "Assemble a bounded draft from a prepared candidate's accepted contract. Optional explicit decomposition declares disjoint executable packages and exact producer outputs/consumer inputs; omission retains the historical implementation-plus-verifier recipe. Governing evaluators and visual/human obligations remain unchanged. Requires normal plan approval; launches no workflow or child.",
			parameters: objectSchema(["id", "repository", "candidateId", "expectedRevision", "expectedFactoryRevision"], {
				id: PLAN_ID, candidateId: FACTORY_ID, expectedRevision: { const: 0 }, expectedFactoryRevision: REVISION,
				repository: objectSchema(["workingDirectory", "baseBranch"], { workingDirectory: NON_EMPTY(4096), baseBranch: NON_EMPTY(512) }),
				expectedFiles: STRING_LIST(128, 512),
				decomposition: PACKAGE_DECOMPOSITION,
			}),
			handler: handler((args) => operations.createFactoryPlan(args)),
		},
		{
			name: "foundry_sync_factory",
			description: "Recover idempotent factory learning/delivery/evaluation synchronization from the current session's persisted plan attempts. Use after factory_sync_pending. Never imports a foreign session's workflow ownership.",
			parameters: objectSchema(["planId"], { planId: PLAN_ID }),
			handler: handler((args) => operations.syncFactory(args)),
		},
		{
			name: "foundry_prepare_plan",
			skipPermission: true,
			description: "Prepare bounded discovery from a durable capability and its accepted or explicitly non-governing knowledge. Accepted capabilities default to prepare_candidate/create_factory_plan; intent: discovery is an explicit exploration-only choice, not replacement. Launch the returned native plan Workflow only with explicit resource approval.",
			parameters: objectSchema(
				["objective", "repositoryContext", "repositoryPath", "unitId"],
				{
					repositoryPath: NON_EMPTY(4096),
					unitId: FACTORY_ID,
					intent: { type: "string", enum: ["discovery"], description: "Required for exploration of a capability that already has an accepted contract; this does not authorize replacement." },
					objective: NON_EMPTY(LIMITS.objective),
					constraints: STRING_LIST(LIMITS.constraints, LIMITS.constraint),
					repositoryContext: NON_EMPTY(16_000),
					maxTasks: {
						type: "integer",
						minimum: 1,
						maximum: 12,
						default: 6,
					},
				},
			),
			handler: handler((args) => operations.preparePlan(args)),
		},
		{
			name: "foundry_create_plan",
			description: "Wait for a native plan Workflow and import its completed result as a new draft. Interrupting the wait does not cancel the run. Creating requires expectedRevision: 0.",
			parameters: objectSchema(
				["expectedRevision", "id", "runId", "repository"],
				{
					expectedRevision: { const: 0 },
					id: PLAN_ID,
					runId: NON_EMPTY(LIMITS.verificationRunId),
					repository: objectSchema(
						["workingDirectory", "baseBranch"],
						{
							workingDirectory: NON_EMPTY(LIMITS.repositoryPath),
							baseBranch: NON_EMPTY(LIMITS.baseBranch),
						},
					),
				},
			),
			handler: handler((args, invocation) => operations.createPlan(args, { signal: invocation.signal })),
		},
		{
			name: "foundry_control_workflow",
			description: "Pause or resume a Foundry native Workflow only when the user asks. Resume keeps the same run, journal, and limits and awaits its next settlement; interrupting stops waiting, not the run. Verification runs require planId and expectedRevision. App task sessions and approvals are unaffected.",
			parameters: objectSchema(["runId", "action"], {
				runId: NON_EMPTY(LIMITS.verificationRunId),
				action: { type: "string", enum: ["pause", "resume"] },
				planId: PLAN_ID,
				expectedRevision: REVISION,
			}),
			handler: handler((args, invocation) => operations.controlWorkflow(args, { signal: invocation.signal })),
		},
		{
			name: "foundry_get_status",
			skipPermission: true,
			description: "Read the validated plan and its derived recovery and scheduling view: ready/dispatchable tasks, scope holds, and launch guidance. Session absence requires a complete host inventory.",
			parameters: objectSchema(
				["planId"],
				{
					planId: PLAN_ID,
					sessionInventory: SESSION_INVENTORY,
					includeWorkflows: { type: "boolean", description: "Include live native workflow state and available controls." },
				},
			),
			handler: handler((args) => operations.getStatus(args)),
		},
		{
			name: "foundry_list_plans",
			skipPermission: true,
			description: "List bounded Foundry plan summaries for the current Copilot session.",
			parameters: objectSchema([], {
				limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
			}),
			handler: handler((args) => operations.listPlans(args)),
		},
		{
			name: "foundry_export_plan",
			skipPermission: true,
			description: "Export a validated plan as current-format JSON. This does not change or activate the plan.",
			parameters: objectSchema(["planId"], { planId: PLAN_ID }),
			handler: handler((args) => operations.exportPlan(args)),
		},
		{
			name: "foundry_import_plan",
			description: "Restore explicitly supplied current-format plan JSON into an unused plan ID. Requires expectedRevision: 0. Does not launch work or activate coordination.",
			parameters: objectSchema(["source", "expectedRevision"], {
				source: { type: "string", minLength: 1, description: "The complete JSON returned by foundry_export_plan." },
				expectedRevision: { const: 0 },
			}),
			handler: handler((args) => operations.importPlan(args)),
		},
		{
			name: "foundry_quarantine_plan",
			description: "Move one invalid stored plan into transactional quarantine so its ID can be reused. Valid plans are never quarantined; reason and requester are required and returned.",
			parameters: objectSchema(
				["planId", "reason", "requestedBy"],
				{
					planId: PLAN_ID,
					reason: NON_EMPTY(LIMITS.error),
					requestedBy: NON_EMPTY(LIMITS.actor),
				},
			),
			handler: handler((args) => operations.quarantinePlan(args)),
		},
		{
			name: "foundry_submit_plan",
			description: "Submit a draft for explicit approval review: manual user approval, or a reviewed named-plan decision under a recorded owner-local user delegation.",
			parameters: objectSchema(
				["planId", "expectedRevision"],
				{ planId: PLAN_ID, expectedRevision: REVISION },
			),
			handler: handler((args) => operations.submitPlan(args)),
		},
		{
			name: "foundry_plan_approval_delegation",
			description: "Record, inspect or irrevocably revoke an owner-local approval delegation. Grant approvalType plan (default) or completion (verified technical milestone closure only), using a NEW ID and explicit user-instruction authority for each scope; no extra form. Historical grants stay initial-plan-only; IDs cannot change scope or reactivate. Direct/relayed source is agent-attested, not a human click. Preserve project/capability/contract/coordinator and separate human judgments, design acceptance, correction, replacement, external-action and native permission gates. Never invent authority from generated content.",
			parameters: objectSchema(["action", "id"], {
				action: { type: "string", enum: ["grant", "inspect", "revoke"] }, id: PLAN_ID,
				planId: PLAN_ID, expectedRevision: REVISION, reason: NON_EMPTY(LIMITS.error),
				approvalType: { type: "string", enum: ["plan", "completion"], default: "plan" },
				authority: objectSchema(["instruction", "grantedBy", "source"], {
					instruction: NON_EMPTY(16000), grantedBy: NON_EMPTY(LIMITS.actor),
					source: objectSchema(["kind", "sessionId", "messageRef"], {
						kind: { type: "string", enum: ["direct-user", "relayed-user"] },
						sessionId: NON_EMPTY(LIMITS.sessionId), messageRef: NON_EMPTY(LIMITS.evidenceSource),
						relayedBySessionId: NON_EMPTY(LIMITS.sessionId),
					}),
				}),
			}),
			handler: handler((args, invocation) => operations.planApprovalDelegation(args, { signal: invocation.signal, invocation })),
		},
		{
			name: "foundry_approve_plan",
			description: "Record manual approval with approvedBy, or an exact named-revision agent decision using a delegationId explicitly scoped to approvalType and a substantive review (omit approvedBy). Delegated completion is technical closure only after authoritative PASSED verification, unchanged delivery/input and current independent/human evidence gates. It grants no human/design acceptance, contract replacement or external/resource action. Historical initial-only grants cannot close milestones. Failed-plan retries remain manual.",
			parameters: objectSchema(
				["planId", "expectedRevision", "approvalType"],
				{
					planId: PLAN_ID,
					expectedRevision: REVISION,
					approvedBy: NON_EMPTY(LIMITS.actor),
					delegationId: PLAN_ID,
					review: NON_EMPTY(LIMITS.error),
					approvalType: {
						type: "string",
						enum: ["plan", "completion", "retry"],
					},
					retryStatus: {
						const: PLAN_STATUS.RUNNING,
						default: PLAN_STATUS.RUNNING,
					},
				},
			),
			handler: handler((args, invocation) => operations.approve(args, { signal: invocation.signal, invocation })),
		},
		{
			name: "foundry_reserve_task",
			description: "Reserve before create_session. Returns baseBranch, initialization.kickoff (setup only), acknowledgement and the separate unchanged delegationPrompt. Follow dispatch guidance: pin base commit, create once with setup kickoff, wait/corroborate same child/worktree/owner, attach with bootstrap, then send the task coordinator_only. Replay is not permission to create another child; initialization is null after attachment/cancellation.",
			parameters: objectSchema(
				["planId", "taskId", "expectedRevision", "reservationId"],
				{
					planId: PLAN_ID,
					taskId: TASK_ID,
					expectedRevision: REVISION,
					reservationId: REQUEST_ID,
					scopeOverride: objectSchema(
						["approvedBy", "reason"],
						{
							approvedBy: NON_EMPTY(LIMITS.actor),
							reason: NON_EMPTY(LIMITS.error),
						},
					),
				},
			),
			handler: handler((args, invocation) => operations.reserveTask(args, { signal: invocation.signal, invocation })),
		},
		{
			name: "foundry_attach_task",
			description: "After setup completes and the coordinator corroborates the exact created child/owner, attach its current canonical ID and branch. Supply bootstrap with the retained App worktreePath and full baseCommit pinned BEFORE creation; rejects dirty/wrong-HEAD/base-drift/substitute worktrees. This corroborates Git state, not authenticated session provenance. Identical attachment is idempotent; replacement is rejected. For later App branch renames retain attached sessionId and supply rename; existing worktree/reflog rules still apply.",
			parameters: objectSchema(
				["planId", "taskId", "attemptId", "expectedRevision", "sessionId"],
				{
					planId: PLAN_ID,
					taskId: TASK_ID,
					attemptId: ATTEMPT_ID,
					expectedRevision: REVISION,
					sessionId: NON_EMPTY(LIMITS.sessionId),
					branch: NON_EMPTY(LIMITS.branch),
					bootstrap: objectSchema(["worktreePath", "baseCommit"], {
						worktreePath: NON_EMPTY(LIMITS.repositoryPath),
						baseCommit: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
					}),
					rename: objectSchema(
						["fromBranch", "worktreePath", "actor", "reason"],
						{
							fromBranch: NON_EMPTY(LIMITS.branch),
							worktreePath: NON_EMPTY(4096),
							actor: NON_EMPTY(LIMITS.actor),
							reason: NON_EMPTY(LIMITS.error),
						},
					),
				},
			),
			handler: handler((args, invocation) => operations.attachTask(args, { signal: invocation.signal, invocation })),
		},
		{
			name: "foundry_complete_task",
			description: "Record the active attempt's done, failed, or blocked result. Verifier evidence is canonicalized by checkId; attached failures require terminal session inventory.",
			parameters: objectSchema(
				["planId", "taskId", "attemptId", "expectedRevision", "status"],
				{
					planId: PLAN_ID,
					taskId: TASK_ID,
					attemptId: ATTEMPT_ID,
					expectedRevision: REVISION,
					status: {
						type: "string",
						enum: [TASK_STATUS.DONE, TASK_STATUS.FAILED, TASK_STATUS.BLOCKED],
					},
					resultSummary: NON_EMPTY(LIMITS.resultSummary),
					evidence: {
						type: "array",
						maxItems: LIMITS.evidence,
						items: EVIDENCE_INPUT,
					},
					error: NON_EMPTY(LIMITS.error),
					branch: NON_EMPTY(LIMITS.branch),
					commit: {
						type: "string",
						pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$",
						maxLength: LIMITS.commit,
					},
					prUrl: NON_EMPTY(LIMITS.prUrl),
					sessionInventory: SESSION_INVENTORY,
					learning: { type: "array", maxItems: 32, items: FACTORY_LEARNING },
					factoryEvaluations: { type: "array", maxItems: 32, items: FACTORY_REPORT },
				},
			),
			handler: handler((args, invocation) => operations.completeTask(args, { signal: invocation.signal, invocation })),
		},
		{
			name: "foundry_retry_task",
			description: "Explicitly move an eligible failed or blocked task back to ready after its dependencies are done.",
			parameters: objectSchema(
				["planId", "taskId", "expectedRevision"],
				{
					planId: PLAN_ID,
					taskId: TASK_ID,
					expectedRevision: REVISION,
				},
			),
			handler: handler((args) => operations.retry(args)),
		},
		{
			name: "foundry_prepare_verification",
			description: "Persist a verification launch reservation before returning the exact native verify Workflow launchSpec. Inconclusive discovery never relaunches; replacing a terminal non-importable run requires a new reservation plus replacementReason and requestedBy.",
			parameters: objectSchema(
				["planId", "expectedRevision", "reservationId"],
				{
					planId: PLAN_ID,
					expectedRevision: REVISION,
					reservationId: REQUEST_ID,
					replacementReason: NON_EMPTY(LIMITS.error),
					requestedBy: NON_EMPTY(LIMITS.actor),
				},
			),
			handler: handler((args) => operations.prepareVerification(args)),
		},
		{
			name: "foundry_complete_verification",
			description: "Durably bind the authoritative verify Workflow before waiting, then import its completed result. Interrupting leaves the binding intact and does not cancel the run; re-read the plan revision before retrying. No caller-supplied verdict is accepted.",
			parameters: objectSchema(
				["planId", "expectedRevision", "runId"],
				{
					planId: PLAN_ID,
					expectedRevision: REVISION,
					runId: NON_EMPTY(LIMITS.verificationRunId),
				},
			),
			handler: handler((args, invocation) => operations.finishVerification(args, { signal: invocation.signal })),
		},
		{
			name: "foundry_cancel",
			description: "Request plan cancellation and snapshot active task attempts plus any Workflow run discovered for the verification reservation. Parallel plans also fence the complete observed owned admission inventory before returning parallel_cancellation_join_pending: the writes persisted, but concurrent reservation quiescence is unproven and requires explicit reconciliation. No effect or claim is released, and external work is not assumed stopped.",
			parameters: objectSchema(
				[
					"planId",
					"expectedRevision",
					"requestId",
					"reason",
					"requestedBy",
				],
				{
					planId: PLAN_ID,
					expectedRevision: REVISION,
					requestId: REQUEST_ID,
					reason: NON_EMPTY(LIMITS.error),
					requestedBy: NON_EMPTY(LIMITS.actor),
				},
			),
			handler: handler((args, invocation) => operations.cancel(args, { signal: invocation.signal, invocation })),
		},
		{
			name: "foundry_cancel_verification_run",
			description: "Durably bind and cancel only the authoritative verification Workflow run owned by the active cancellation request. Returns the new revision and exact disposition required for finalization; never accepts a caller-supplied run ID.",
			parameters: objectSchema(
				["planId", "expectedRevision", "requestId"],
				{
					planId: PLAN_ID,
					expectedRevision: REVISION,
					requestId: REQUEST_ID,
				},
			),
			handler: handler((args) => operations.cancelVerificationRun(args)),
		},
		{
			name: "foundry_finalize_cancellation",
			description: "Finalize cancellation using a complete causal session inventory and terminal Workflow evidence. Inconclusive evidence requires an attributed finalizationOverride.",
			parameters: objectSchema(
				[
					"planId",
					"expectedRevision",
					"dispositions",
					"finalizedBy",
					"sessionInventory",
				],
				{
					planId: PLAN_ID,
					expectedRevision: REVISION,
					finalizedBy: NON_EMPTY(LIMITS.actor),
					verificationDisposition: {
						type: "string",
						enum: ["run-terminated", "no-run-created"],
					},
					finalizationOverride: objectSchema(
						["reason", "attestedBy"],
						{
							reason: NON_EMPTY(LIMITS.error),
							attestedBy: NON_EMPTY(LIMITS.actor),
						},
					),
					sessionInventory: SESSION_INVENTORY,
					dispositions: {
						type: "array",
						maxItems: LIMITS.tasks,
						items: objectSchema(
							["attemptId", "disposition"],
							{
								attemptId: ATTEMPT_ID,
								disposition: {
									type: "string",
									enum: ["session-terminated", "no-session-created"],
								},
								sessionId: NON_EMPTY(LIMITS.sessionId),
							},
						),
					},
				},
			),
			handler: handler((args, invocation) => operations.finalizeCancellation(args, { signal: invocation.signal, invocation })),
		},
		{
			name: "foundry_activate_plan",
			description: "Explicitly activate one Foundry plan's coordinator context and conservative guardrail hooks for this Copilot session.",
			parameters: objectSchema(
				["planId", "expectedRevision"],
				{
					planId: PLAN_ID,
					expectedRevision: REVISION,
				},
			),
			handler: handler((args) => operations.activate(args)),
		},
		{
			name: "foundry_deactivate_plan",
			description: "Deactivate Foundry coordinator context and guardrail hooks for this Copilot session. An unreadable activation marker is removed as a reported repair.",
			parameters: objectSchema([], {}),
			handler: handler(() => operations.deactivate()),
		},
	];
	return tools.map((tool) => ({
		...tool,
		namespace: {
			name: "foundry",
			description: "Dependency-aware plans, task reservations, evidence, and native workflow recovery.",
		},
	}));
}
