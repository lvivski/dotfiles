import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";
import { foundryBoard } from "./canvas.mjs";
import { identify } from "./work/native.mjs";
import { permissionCheck } from "./work/permissions.mjs";
import { recover } from "./work/recovery.mjs";
import { researchAgent } from "./work/research.mjs";
import { createRuntime } from "./work/runtime.mjs";
import { scoutAgent, scoutDefinition } from "./work/scouts.mjs";
import { buildTools, fromHelper, primaryOnly } from "./work/tools.mjs";

/** @type {import("@github/copilot-sdk").CopilotSession} */
let session;
const runtime = createRuntime(process.cwd(), {
	mode: () => session.rpc.mode.get(),
	helpersRunning: async () => (await session.rpc.tasks.list()).tasks.some(t => t.type === "agent" && t.status === "running"),
	permissionBlocker: permissionCheck(() => session.rpc.managedSettings.get(), () => session.rpc.permissions.getMode()),
	ask: message => session.ui.input(message),
	execute: (name, args, toolCallId) => session.rpc.tools.execute({ name, arguments: args, toolCallId }),
	scout: (run, dispatch) => session.workflow.run("foundry-scout", { args: { run, dispatch }, notifyOnComplete: false }),
	scoutState: id => session.workflow.waitForRun(id),
	notify: prompt => session.send({ source: "system", mode: "enqueue", prompt }),
	recover: effect => recover(page => session.rpc.eventLog.read(page), effect),
	log: message => session.log(message, { level: "warning" }),
});
session = await joinSession({
	customAgents: [scoutAgent, researchAgent],
	workflows: [defineWorkflow(scoutDefinition(() => runtime))],
	tools: buildTools(runtime, () => session.sessionId),
	canvases: [foundryBoard((run, actor) => runtime.operation("status", { run }, actor), runtime.defaultMapRun)],
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
