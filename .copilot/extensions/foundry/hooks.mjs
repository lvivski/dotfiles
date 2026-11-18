import { attemptToken } from "./work/prompt.mjs";
import { runner, toolName } from "./work/native.mjs";
import { FoundryError } from "./work/values.mjs";

/** @typedef {Required<Pick<import("@github/copilot-sdk").SessionHooks,
 * "onSessionStart" | "onPreToolUse" | "onPostToolUse" | "onAgentStop" | "onSessionEnd">>} FoundryHooks */

/** @param {ReturnType<typeof import("./work/runtime.mjs").createRuntime>} runtime @returns {FoundryHooks} */
export function buildHooks(runtime) {
	let tracking = false;
	return {
		onSessionStart: (input, invocation) => {
			runtime.setDirectory(input.workingDirectory);
			const token = input.initialPrompt ? attemptToken(input.initialPrompt) : undefined;
			if (!token) return;
			tracking = true;
			runtime.beginUsage(invocation.sessionId, token);
			return { additionalContext: "This is a complete Foundry assignment, not a setup handshake. Execute it now. Your first ownership-specific mutation may reconcile actual native session metadata inline; do not wait for parent attachment or activation." };
		},
		onPreToolUse: (input, invocation) => {
			const name = toolName(input.toolName);
			try {
				if (runtime.guardSurface(name, input.toolArgs, invocation.sessionId)) tracking = true;
			} catch (error) {
				return { permissionDecision: "deny", permissionDecisionReason: error instanceof Error ? error.message : String(error) };
			}
			if (name.startsWith("foundry_")) tracking = true;
			if (!tracking || !["create_session", "send_session_message", "bash", "shell", "read_bash", "stop_bash", "apply_patch", "edit", "create", "write_file", "str_replace_editor"].includes(name)) return;
			runtime.setDirectory(input.workingDirectory);
			try {
				runtime.pre(input.toolName, input.toolArgs, invocation.sessionId, input.toolCallId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				runtime.log(`Foundry native issuance: ${message}`);
				const args = input.toolArgs;
				const related = typeof args === "object" && args !== null && (
					(name === "create_session" && "kickoff" in args && typeof args.kickoff === "object"
						&& args.kickoff !== null && "prompt" in args.kickoff && typeof args.kickoff.prompt === "string"
						&& attemptToken(args.kickoff.prompt) !== undefined)
					|| (name === "send_session_message" && "message" in args && typeof args.message === "string" && args.message.startsWith("Foundry wake: "))
					|| ("command" in args && typeof args.command === "string" && args.command.includes(runner)));
				const admissionFailure = error instanceof FoundryError && [
					"factory_paused", "job_closed", "job_cancelled", "stale_activation", "stale_attempt",
					"cancelled", "capacity_required", "assignment_changed", "foreign_execution", "command_retired",
				].includes(error.code);
				return related || admissionFailure ? { permissionDecision: "deny", permissionDecisionReason: message }
					: { additionalContext: `Foundry observation failed: ${message}. This unrelated native call is not paused.` };
			}
		},
		onPostToolUse: async (input, invocation) => {
			if (!tracking) return;
			try {
				runtime.post(input.toolName, input.toolArgs, input.toolResult, invocation.sessionId, input.toolCallId);
				if (toolName(input.toolName) === "create_session") await runtime.deliverStops(invocation.sessionId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				runtime.log(`Foundry native observation: ${message}`);
				return { additionalContext: `Foundry bookkeeping needs reconciliation: ${message}. Keep the actual native result. Do not duplicate an issued creation; unrelated assignment work is not paused.` };
			}
		},
		onAgentStop: (input, invocation) => {
			runtime.setDirectory(input.workingDirectory);
			try { return runtime.agentStop(invocation.sessionId, input.stopHookActive === true); }
			catch (error) {
				runtime.log(`Foundry continuation paused: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
		onSessionEnd: () => {
			runtime.close();
			return {};
		},
	};
}
