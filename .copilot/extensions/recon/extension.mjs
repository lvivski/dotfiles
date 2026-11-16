import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";
import { createResearchTimeReview } from "./research/review.mjs";
import { RECON_WORKFLOWS } from "./workflows/registry.mjs";

/** @type {ReturnType<typeof createResearchTimeReview>|undefined} */
let timeReviews;
const session = await joinSession({
	workflows: Object.values(RECON_WORKFLOWS).map(definition => defineWorkflow(definition)),
	hooks: { onSessionEnd: () => { timeReviews?.close(); return {}; } },
});
timeReviews = createResearchTimeReview({
	workflow: session.workflow,
	getUi: () => session.capabilities.ui?.elicitation ? session.ui : undefined,
	log: message => session.log(message, { level: "warning" }),
});
session.on("workflow.run_updated", event => { void timeReviews?.refresh(event.data.runId); });
void timeReviews.refresh();
