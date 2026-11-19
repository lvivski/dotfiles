import { joinSession } from "@github/copilot-sdk/extension";
import { createFoundryCanvas } from "./canvas.mjs";
import { buildHooks } from "./hooks.mjs";
import { createRuntime } from "./work/runtime.mjs";
import { buildTools } from "./work/tools.mjs";
import { FoundryError, record } from "./work/values.mjs";
import { createIssueSource } from "./work/issues.mjs";
import { readCommandEvents } from "./work/recovery.mjs";

/** @type {import("@github/copilot-sdk").CopilotSession|undefined} */
let session;
const runtime = createRuntime({
	directory: process.cwd(),
	log: message => session?.log(message, { level: "warning" }),
	readSession: async id => {
		if (!session) throw new Error("Native session is not attached yet");
		return session.rpc.tools.execute({ name: "get_session", arguments: { project_session_id: id } });
	},
	readCommand: async (actor, toolCallId) => {
		if (!session || session.sessionId !== actor) throw new FoundryError("native_identity_mismatch", "Read command history only for this extension's actual native owner");
		return readCommandEvents(args => {
			if (!session || session.sessionId !== actor) throw new FoundryError("native_identity_mismatch", "The native history owner changed");
			return session.rpc.eventLog.read(args);
		}, toolCallId);
	},
	execute: async (name, args, toolCallId) => {
		if (!session) throw new Error("Native session is not attached yet");
		if (name === "archive_session_if_safe" && record(record(args).guard).owner !== session.sessionId)
			throw new FoundryError("native_identity_mismatch", "Guarded archival must run in the actual native creator");
		return session.rpc.tools.execute({ name, arguments: args, ...(toolCallId === undefined ? {} : { toolCallId }) });
	},
	createSession: async (args, toolCallId) => {
		if (!session) throw new Error("Native session is not attached yet");
		return session.rpc.tools.execute({ name: "create_session", arguments: args, toolCallId });
	},
	confirm: async message => {
		if (!session?.capabilities.ui?.elicitation) throw new FoundryError("native_authorization_unavailable", "The host does not expose native user confirmation");
		return session.ui.confirm(message);
	},
	readMode: async actor => {
		if (!session || session.sessionId !== actor) throw new FoundryError("native_identity_mismatch", "Inspect execution mode only for this extension's actual native owner");
		return session.rpc.mode.get();
	},
	...createIssueSource(async args => {
		if (!session) throw new FoundryError("native_session_unavailable", "Native source inspection requires an attached session");
		return session.rpc.tools.execute({ name: "bash", arguments: args });
	}),
});
session = await joinSession({
	tools: buildTools(runtime),
	canvases: [createFoundryCanvas(runtime)],
	hooks: buildHooks(runtime),
});
runtime.attachUsage(session.sessionId);
session.on("assistant.turn_start", event => {
	if (!session) return;
	try { runtime.usageTurn(event, session.sessionId); }
	catch (error) { runtime.log(`Native usage affinity failed: ${error instanceof Error ? error.message : String(error)}`); }
	if (!event.agentId) runtime.ownerTurn(session.sessionId);
});
session.on("assistant.usage", event => {
	if (!session) return;
	try { runtime.usage(event, session.sessionId); }
	catch (error) { runtime.log(`Native AI-credit observation failed: ${error instanceof Error ? error.message : String(error)}`); }
});
session.on("tool.execution_complete", event => {
	if (session) runtime.toolComplete(event.data, session.sessionId);
});
session.on("abort", event => {
	if (session && !event.agentId) runtime.nativeAbort(event.data, session.sessionId);
});
session.on("session.completion_receipt", event => {
	if (session && !event.agentId) runtime.nativeAbort(event.data, session.sessionId);
});
