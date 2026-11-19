import { joinSession } from "@github/copilot-sdk/extension";
import { recover } from "./work/recovery.mjs";
import { createRuntime } from "./work/runtime.mjs";
import { buildTools } from "./work/tools.mjs";

/** @type {import("@github/copilot-sdk").CopilotSession} */
let session;
const runtime = createRuntime(process.cwd(), {
	mode: () => session.rpc.mode.get(),
	confirm: message => session.ui.confirm(message),
	execute: (name, args, toolCallId) => session.rpc.tools.execute({ name, arguments: args, toolCallId }),
	recover: effect => recover(page => session.rpc.eventLog.read(page), effect),
	log: message => session.log(message, { level: "warning" }),
});
session = await joinSession({
	tools: buildTools(runtime),
	hooks: {
		onSessionStart(input, ctx) {
			runtime.setDirectory(input.workingDirectory);
			if (input.initialPrompt)
				runtime.bind(ctx.sessionId, input.initialPrompt);
		},
		onPreToolUse(input, ctx) {
			const name = input.toolName.split(".").at(-1) ?? "";
			if (!["create_session", "send_session_message", "bash"].includes(name))
				return;
			try {
				runtime.pre(name, input.toolArgs, ctx.sessionId, input.toolCallId ?? "");
			}
			catch (error) {
				return { permissionDecision: "deny", permissionDecisionReason: String(error) };
			}
		},
		onPostToolUse(input, ctx) {
			if (input.toolCallId)
				runtime.post(input.toolCallId, input.toolResult, ctx.sessionId);
		},
		onSessionEnd() { runtime.close(); },
	},
});
session.on("assistant.turn_start", event => {
	if (!event.agentId)
		runtime.turn(session.sessionId);
});
session.on("permission.completed", event => runtime.refusal(event, session.sessionId));
session.on("tool.execution_complete", event => runtime.refusal(event, session.sessionId));
