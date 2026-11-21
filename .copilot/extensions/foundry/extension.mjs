import { joinSession } from "@github/copilot-sdk/extension";
import { identify } from "./work/native.mjs";
import { permissionCheck } from "./work/permissions.mjs";
import { recover } from "./work/recovery.mjs";
import { createRuntime } from "./work/runtime.mjs";
import { buildTools, fromHelper, primaryOnly } from "./work/tools.mjs";

/** @type {import("@github/copilot-sdk").CopilotSession} */
let session;
const runtime = createRuntime(process.cwd(), {
	mode: () => session.rpc.mode.get(),
	helpersRunning: async () => (await session.rpc.tasks.list()).tasks.some(t => t.type === "agent" && t.status === "running"),
	permissionBlocker: permissionCheck(() => session.rpc.managedSettings.get(), () => session.rpc.permissions.getMode()),
	confirm: message => session.ui.confirm(message),
	select: (message, options) => session.ui.select(message, options),
	execute: (name, args, toolCallId) => session.rpc.tools.execute({ name, arguments: args, toolCallId }),
	remind: (run, token) => session.send({ source: "system", mode: "enqueue",
		prompt: `Foundry repair ${token}: read foundry_status({run:"${run}"}). If this is still your writable token, repair the checked failure in your assigned directory and submit it. No new assignment or permission is granted by this notice.` }),
	recover: effect => recover(page => session.rpc.eventLog.read(page), effect),
	log: message => session.log(message, { level: "warning" }),
});
session = await joinSession({
	tools: buildTools(runtime, () => session.sessionId),
	hooks: {
		onSessionStart(input, ctx) {
			if (!fromHelper(input, ctx.sessionId)) runtime.sessionStart(ctx.sessionId, input.workingDirectory, input.initialPrompt);
		},
		async onPreToolUse(input, ctx) {
			const name = input.toolName.split(".").at(-1) ?? "";
			if (fromHelper(input, ctx.sessionId)) {
				if (name.startsWith("foundry_") || identify(name, input.toolArgs))
					return { permissionDecision: "deny", permissionDecisionReason: primaryOnly };
				return;
			}
			if (!["create_session", "send_session_message", "bash"].includes(name))
				return;
			try {
				await runtime.pre(name, input.toolArgs, ctx.sessionId, input.toolCallId ?? "");
			}
			catch (error) {
				return { permissionDecision: "deny", permissionDecisionReason: String(error) };
			}
		},
		onPostToolUse(input, ctx) {
			if (input.toolCallId && !fromHelper(input, ctx.sessionId))
				runtime.post(input.toolCallId, input.toolResult, ctx.sessionId);
		},
		onSessionEnd(input, ctx) { if (!fromHelper(input, ctx.sessionId)) runtime.close(); },
	},
});
session.on("assistant.turn_start", event => {
	if (!event.agentId && !event.data.parentToolCallId)
		runtime.turn(session.sessionId);
});
session.on("system.notification", event => {
	const kind = event.data.kind;
	if (!event.agentId && kind.type === "shell_completed")
		runtime.turn(session.sessionId, kind.shellId); // A matching shell wakes the ledger, not proof its check passed.
});
session.on("permission.completed", event => runtime.refusal(event, session.sessionId));
session.on("tool.execution_complete", event => runtime.refusal(event, session.sessionId));
