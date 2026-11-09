/**
 * Foundry extension entry point.
 *
 * Registers workflows, tools, hooks, canvases, and native run observation
 * against the current foreground Copilot session.
 *
 * @module foundry/extension
 */
import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";

import { createFoundryCanvas } from "./canvas.mjs";
import { publishPlanChange, publishWorkflowChange, subscribeToPlan } from "./events.mjs";
import { buildFoundryHooks } from "./hooks.mjs";
import { createFoundryOperations } from "./operations.mjs";
import { createResearchTimeReview } from "./research/review.mjs";
import { buildFoundryTools } from "./tools.mjs";
import { createWorkflowAnalysis } from "./workflow.mjs";
import { FOUNDRY_WORKFLOWS } from "./workflows/registry.mjs";

/** @type {import("@github/copilot-sdk").CopilotSession | null} */
let session = null;
/** @type {ReturnType<typeof createResearchTimeReview> | null} */
let timeReviews = null;
let unsubscribeWorkflows = () => { };
const getUi = () => session?.capabilities.ui?.elicitation ? session.ui : undefined;

const workflows = Object.values(FOUNDRY_WORKFLOWS).map(
	/** @param {import("@github/copilot-sdk").WorkflowDefinition} definition */
	(definition) => defineWorkflow(definition),
);

/** Shared service boundary used by tools, hooks, and canvases. */
const operations = createFoundryOperations({
	getWorkspacePath: () => session?.workspacePath,
	analysis: createWorkflowAnalysis(() => session?.workflow),
	notify: publishPlanChange,
});

session = await joinSession({
	workflows,
	tools: buildFoundryTools(operations),
	hooks: {
		...buildFoundryHooks({ operations }),
		onSessionEnd: () => {
			timeReviews?.close();
			unsubscribeWorkflows();
			return {};
		},
	},
	canvases: [
		createFoundryCanvas({
			operations,
			getWorkspacePath: () => session?.workspacePath,
			getUi,
			subscribe: subscribeToPlan,
		}),
	],
});

timeReviews = createResearchTimeReview({
	workflow: session.workflow,
	getUi,
	log: (message) => session?.log(message, { level: "warning" }),
});
unsubscribeWorkflows = session.on("workflow.run_updated", (event) => {
	publishWorkflowChange(event.data);
	void timeReviews?.refresh(event.data.runId);
});
void timeReviews.refresh();
