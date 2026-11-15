import { attemptToken } from "./work/prompt.mjs";
import { toolName } from "./work/native.mjs";

/** @param {ReturnType<typeof import("./work/runtime.mjs").createRuntime>} runtime */
export function buildHooks(runtime) {
	let tracking = false;
	return /** @satisfies {import("@github/copilot-sdk").SessionHooks} */ ({
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
			if (name.startsWith("foundry_")) tracking = true;
			if (!tracking || !["create_session", "bash", "shell", "read_bash", "stop_bash"].includes(name)) return;
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
					|| ("command" in args && typeof args.command === "string" && args.command.includes("check-runner.mjs")));
				return related ? { permissionDecision: "deny", permissionDecisionReason: message }
					: { additionalContext: `Foundry observation failed: ${message}. This unrelated native call is not paused.` };
			}
		},
		onPostToolUse: async (input, invocation) => {
			if (!tracking) return;
			try {
				runtime.post(input.toolName, input.toolArgs, input.toolResult, invocation.sessionId);
				if (toolName(input.toolName) === "create_session") await runtime.deliverStops(invocation.sessionId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				runtime.log(`Foundry native observation: ${message}`);
				return { additionalContext: `Foundry bookkeeping needs reconciliation: ${message}. Keep the actual native result. Do not duplicate an issued creation; unrelated assignment work is not paused.` };
			}
		},
	});
}
