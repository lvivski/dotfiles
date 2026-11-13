import { errorCode, property } from "./data.mjs";
import { inspectWriteBoundary } from "./hooks/paths.mjs";
import { classifyShellCommand } from "./hooks/shell.mjs";

/** @typedef {{plan: {id: string, revision: number, status: string, factory?: import("./types/plan.js").PlanFactoryBinding | null}}} ActivePlan */

/** Prefix shared by every Foundry-owned tool. */
const FOUNDRY_TOOL_PREFIX = "foundry_";

/** Foundry tools safe to auto-allow while a plan is active. */
const READ_ONLY_FOUNDRY_TOOLS = new Set([
	"foundry_prepare_plan",
	"foundry_get_status",
	"foundry_list_plans",
	"foundry_export_plan",
]);

/**
 * Renders the durable coordinator workflow injected for an active plan.
 *
 * @param {ActivePlan} active
 * @returns {string}
 */
function coordinatorContext(active) {
	const plan = active.plan;
	return `Foundry plan ${plan.id} is active at revision ${plan.revision} (${plan.status}).

Coordinator contract:
1. Reserve before create_session. Follow dispatch guidance: pin the base commit, create once with initialization.kickoff, await setup and corroborate the same child/owner/worktree, attach with bootstrap, then send the unchanged delegationPrompt coordinator_only. Never send task work in kickoff or recreate on uncertain admission.
2. Record terminal attempt state before dispatching newly-unblocked work; never duplicate active work or expand the approved DAG.
3. Overlapping declared scopes require an auditable scopeOverride.
4. Re-read after revision conflicts; replay only when the exact postcondition already exists.
5. Workflow agents perform analysis only; App-native child sessions own repository mutation.
6. Use each prepare result once: launch its exact launchSpec, or reuse its runId when launchSpec is null.
7. The final verify task follows the ordinary task flow and must report canonical checkId evidence plus its observed commit.
8. Failed or blocked attached tasks require a complete, causally newer terminal session inventory.
9. Cancellation is two-phase: stop owned sessions, terminate the bound verification run, then finalize with fresh complete inventory; overrides must be explicit and attributed.
10. Repository capability ${plan.factory?.unitId ?? "(missing factory context)"} governs durable intent, conserved boundaries and shared dependencies. Inspect accepted versus non-governing knowledge with foundry_get_factory.
11. Capture implementation learning and scoped analysis observations without promoting them to requirements. Pinned contract changes and replacement selection require explicit attributed decisions.
12. Reconstruction uses fresh candidate context, never a retry label or comparison-only prior source. The verifier reports pinned factoryEvaluations; completion alone is not regeneration. Missing/stale/independence evidence blocks replacement.
13. Recover factory_sync_pending with foundry_sync_factory, not repeated external work. A sibling may inspect repository knowledge but never acquire this session's native workflow ownership.`;
}

/**
 * Builds inert-until-activated SDK hooks for Foundry coordination.
 *
 * @param {{
 *   operations: {getActive: () => Promise<ActivePlan | null>, getActivation: () => Promise<object | null>},
 *   getSession?: () => import("./hooks/paths.mjs").HelperSession | null | undefined,
 * }} options
 */
export function buildFoundryHooks(options) {
	/**
	 * Reads the current activation marker and plan.
	 *
	 * @returns {Promise<ActivePlan | null>}
	 */
	const active = async () => options.operations.getActive();

	return /** @satisfies {import("@github/copilot-sdk").SessionHooks} */ ({
		/** @param {Partial<Parameters<NonNullable<import("@github/copilot-sdk").SessionHooks["onSessionStart"]>>[0]>} [_input] */
		onSessionStart: async (_input = {}) => {
			try {
				const current = await active();
				return current ? { additionalContext: coordinatorContext(current) } : {};
			} catch (error) {
				return {
					additionalContext: `Foundry activation state could not be read (${errorCode(error) ?? "error"}). Do not assume a plan is active until the marker is repaired or deactivated.`,
				};
			}
		},
		/**
		 * @param {{toolName?: string, toolArgs?: unknown, workingDirectory?: string, sessionId?: string}} input
		 * @param {{sessionId: string}} [invocation]
		 */
		onPreToolUse: async (input, invocation) => {
			let current;
			try {
				current = await options.operations.getActivation();
			} catch (error) {
				return {
					permissionDecision: "ask",
					permissionDecisionReason: `Foundry activation state is unreadable (${errorCode(error) ?? "error"}); confirm this tool call before proceeding.`,
				};
			}
			if (!current) {
				return {};
			}
			const toolName = String(input.toolName ?? "");
			if (READ_ONLY_FOUNDRY_TOOLS.has(toolName)) {
				return { permissionDecision: "allow" };
			}
			if (toolName.startsWith(FOUNDRY_TOOL_PREFIX)) {
				return {};
			}
			if (toolName === "bash" || toolName === "shell" || toolName === "powershell") {
				const command = property(input.toolArgs, "command") ?? input.toolArgs;
				const classified = classifyShellCommand(command, input.workingDirectory);
				if (classified) {
					return {
						permissionDecision: classified.decision,
						permissionDecisionReason: classified.reason,
					};
				}
			}
			const session = options.getSession?.();
			const boundary = await inspectWriteBoundary(
				toolName,
				input.toolArgs,
				input.workingDirectory,
				session && input.sessionId === session.sessionId && invocation?.sessionId === session.sessionId
					? session : undefined,
			);
			if (boundary) {
				return {
					permissionDecision: boundary.decision,
					permissionDecisionReason: boundary.reason,
				};
			}
			return {};
		},
		/** @param {{toolName?: string, toolResult?: unknown}} input */
		onPostToolUse: async (input) => {
			const toolName = String(input.toolName ?? "");
			if (toolName === "foundry_deactivate_plan") {
				return {
					additionalContext: "Foundry coordinator context and guardrails are now deactivated for this session.",
				};
			}
			if (toolName === "foundry_activate_plan") {
				try {
					const current = await active();
					return current ? { additionalContext: coordinatorContext(current) } : {};
				} catch {
					return { additionalContext: "Foundry activation state is unreadable. Repair or deactivate it before coordinating more plan work." };
				}
			}
			return {};
		},
		/** @param {{toolName?: string, error?: unknown}} input */
		onPostToolUseFailure: async (input) => {
			if (!String(input.toolName ?? "").startsWith(FOUNDRY_TOOL_PREFIX)) {
				return {};
			}
			let current;
			try {
				current = await options.operations.getActivation();
			} catch {
				return {
					additionalContext: "Foundry activation state is unreadable. Do not retry plan mutations until it is repaired.",
				};
			}
			if (!current) {
				return {};
			}
			return {
				additionalContext: "The Foundry operation failed. Re-read the current plan revision before retrying; do not blindly replay a stale mutation.",
			};
		},
	});
}
