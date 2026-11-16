import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";
import { createFoundryCanvas } from "./canvas.mjs";
import { buildHooks } from "./hooks.mjs";
import { createResearchTimeReview } from "./research/review.mjs";
import { createRuntime } from "./work/runtime.mjs";
import { buildTools } from "./work/tools.mjs";
import { FOUNDRY_WORKFLOWS } from "./workflows/registry.mjs";

/** @type {import("@github/copilot-sdk").CopilotSession|undefined} */
let session;
/** @type {ReturnType<typeof createResearchTimeReview>|undefined} */
let timeReviews;
const runtime = createRuntime({
	directory: process.cwd(),
	log: message => session?.log(message, { level: "warning" }),
	readSession: async id => {
		if (!session) throw new Error("Native session is not attached yet");
		return session.rpc.tools.execute({ name: "get_session", arguments: { project_session_id: id } });
	},
	execute: async (name, args, toolCallId) => {
		if (!session) throw new Error("Native session is not attached yet");
		return session.rpc.tools.execute({ name, arguments: args, ...(toolCallId === undefined ? {} : { toolCallId }) });
	},
});
session = await joinSession({
	tools: buildTools(runtime),
	workflows: Object.values(FOUNDRY_WORKFLOWS).map(definition => defineWorkflow(definition)),
	canvases: [createFoundryCanvas(runtime)],
	hooks: {
		...buildHooks(runtime),
		onSessionEnd: () => {
			timeReviews?.close();
			runtime.close();
			return {};
		},
	},
});
timeReviews = createResearchTimeReview({
	workflow: session.workflow,
	getUi: () => session?.capabilities.ui?.elicitation ? session.ui : undefined,
	log: message => session?.log(message, { level: "warning" }),
});
runtime.attachUsage(session.sessionId);
session.on("assistant.turn_start", event => {
	if (!session) return;
	try { runtime.usageTurn(event, session.sessionId); }
	catch (error) { runtime.log(`Native usage affinity failed: ${error instanceof Error ? error.message : String(error)}`); }
});
session.on("assistant.usage", event => {
	if (!session) return;
	try { runtime.usage(event, session.sessionId); }
	catch (error) { runtime.log(`Native AI-credit observation failed: ${error instanceof Error ? error.message : String(error)}`); }
});
session.on("workflow.run_updated", event => { void timeReviews?.refresh(event.data.runId); });
session.on("tool.execution_complete", event => {
	if (session) runtime.toolComplete(event.data, session.sessionId);
});
void timeReviews.refresh();
