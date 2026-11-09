import { createActions } from "./actions.mjs";
import { readWorkflowDetail } from "./client.mjs";
import { requiredElement, requiredMeta } from "./dom.mjs";
import { createFactoryView } from "./factory.mjs";
import { createPlanView } from "./plan.mjs";
import { createReader } from "./reader.mjs";
import { mergeSnapshot } from "./snapshot.mjs";
import { createWorkflowView } from "./workflows.mjs";

const planId = requiredMeta('meta[name="foundry-plan-id"]').content;
const token = requiredMeta('meta[name="foundry-token"]').content;
/** @type {import("./snapshot.mjs").BoardState | null} */
let current = null;
let planControlError = "";
function renderPlanError(message = "") {
	requiredElement("#error").textContent = [planControlError, message].filter(Boolean).join("\n");
}
const reader = createReader({
	acceptSnapshot, readWorkflow: (runId, options) => workflows.read(runId, options), reportError: renderPlanError, needsRefresh: () =>
		current?.factory?.state === "available" || (current?.workflows?.state === "available"
			&& current.workflows.runs.some((run) => run.status === "running" || run.status === "pending"))
});
const isNative = () => current?.native === true;
const actions = createActions({
	token, isNative, refresh: reader.refresh, reportError: (message) => {
		planControlError = message;
		renderPlanError();
	}
});
const plan = createPlanView(actions.planAction, planId);
const factory = createFactoryView(actions.planAction, plan.revision);
const workflows = createWorkflowView({ enqueue: reader.enqueue, action: actions.action, getPlanRevision: plan.revision, isNative, isClosed: reader.isClosed, readDetail: readWorkflowDetail });

/** @param {ReturnType<typeof import("./contracts.mjs").FoundryWire.snapshot>} snapshot */
function acceptSnapshot(snapshot) {
	const accepted = mergeSnapshot(current, snapshot, planId);
	if (!accepted) return;
	current = accepted.state;
	plan.update(current.plan, current.projection, current.readOnly, accepted.planChanged,
		current.factory?.state === "available" ? current.factory.repository?.commonDirectory ?? "" : "");
	if (current.plan) workflows.update(current.workflows ?? null);
	factory.update(current.factory, current.readOnly, Boolean(current.plan));
	reader.updateTimer();
	workflows.refreshOpen();
	renderPlanError();
}

requiredElement("#refresh-button").addEventListener("click", () => {
	workflows.clearError();
	planControlError = "";
	return reader.refresh();
});
reader.start();
