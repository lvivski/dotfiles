import { FoundryWire } from "./contracts.mjs";
import { addLabeledValue, element, requiredElement } from "./dom.mjs";
import { newerObservation } from "./snapshot.mjs";
/** @typedef {ReturnType<typeof import("./contracts.mjs").FoundryWire.snapshot>} PlanSnapshot */
/** @typedef {NonNullable<PlanSnapshot["workflows"]>} WorkflowListing */

/** @param {{
 * enqueue: (runId: string, options: {beforeSeq?: number, selectPage: boolean}) => void,
 * action: ReturnType<typeof import("./actions.mjs").createActions>["action"],
 * getPlanRevision: () => number,
 * isNative: () => boolean,
 * isClosed: () => boolean,
 * readDetail: typeof import("./client.mjs").readWorkflowDetail,
 * }} dependencies */
export function createWorkflowView({ enqueue, action, getPlanRevision, isNative, isClosed, readDetail }) {
	/** @type {WorkflowListing | null} */
	let currentWorkflows = null;

	/** @type {Set<string>} */
	const pendingWorkflowActions = new Set();

	let workflowControlError = "";

	/** @type {Map<string, ReturnType<typeof createWorkflowRow>>} */
	const workflowRows = new Map();

	const workflowNotices = element("div", "");

	const workflowList = element("div", "");

	const workflowFooter = element("p", "muted");
	/** @param {unknown} value */
	function amount(value) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "Unavailable";
		if (value > 0 && value < 0.001) return "<0.001";
		return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
	}

	/** @param {unknown} milliseconds */
	function duration(milliseconds) {
		if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) return "Unavailable";
		const seconds = milliseconds / 1000;
		return seconds < 60 ? `${amount(seconds)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
	}

	/** @param {unknown} value @param {number | undefined} limit @param {object | null | undefined} approved @param {(value: unknown) => string} [format] */
	function usage(value, limit, approved, format = amount) {
		const ceiling = approved === null ? "not yet approved"
			: approved === undefined ? "limit unavailable"
				: limit === undefined ? "unbounded" : format(limit);
		return `${format(value)} / ${ceiling}${typeof limit === "number" && typeof value === "number" && value > limit ? " (limit exceeded)" : ""}`;
	}

	/** @param {string} runId */
	function createWorkflowRow(runId) {
		const row = element("article", "workflow-run");
		const heading = element("div", "task-heading");
		const metadata = element("div", "workflow-metrics");
		const controls = element("div", "card-actions");
		const disclosure = document.createElement("details");
		disclosure.className = "workflow-progress";
		const detailStatus = element("p", "muted");
		detailStatus.setAttribute("role", "status");
		const observations = element("div", "workflow-observations");
		const progress = element("pre", "");
		const paging = element("div", "card-actions");
		const older = document.createElement("button");
		older.type = "button";
		older.textContent = "Older progress";
		const latest = document.createElement("button");
		latest.type = "button";
		latest.textContent = "Latest progress";
		paging.append(older, latest);
		const summary = element("summary", "", "Agents, phases and progress");
		disclosure.append(summary, detailStatus, observations, element("h4", "", "Progress"), progress, paging);
		row.append(heading, metadata, controls, disclosure);
		/** @type {{detail: Omit<ReturnType<typeof FoundryWire.workflowDetail>, "progress"> | null, page: ReturnType<typeof FoundryWire.workflowDetail>["progress"] | null, history: boolean, loading: boolean, error: string}} */
		const state = { detail: null, page: null, history: false, loading: false, error: "" };
		/** @type {Map<string, HTMLButtonElement>} */
		const buttons = new Map();
		disclosure.addEventListener("toggle", () => {
			if (disclosure.open) void loadWorkflow(runId);
		});
		older.addEventListener("click", () => {
			if (!state.loading && state.page?.hasMoreOlder && state.page.oldestSeq !== null) {
				void loadWorkflow(runId, state.page.oldestSeq, true);
			}
		});
		latest.addEventListener("click", () => {
			if (!state.loading) void loadWorkflow(runId, undefined, true);
		});
		return { row, heading, metadata, controls, disclosure, summary, detailStatus, observations, progress, older, latest, state, buttons };
	}
	/** @param {string} runId @param {number} [beforeSeq] @param {boolean} [selectPage] */
	function loadWorkflow(runId, beforeSeq = undefined, selectPage = false) {
		const view = workflowRows.get(runId);
		if (!view || !view.disclosure.open || isClosed() || document.hidden) return;
		enqueue(runId, { beforeSeq, selectPage });
	}
	/** @param {string} runId @param {{beforeSeq?: number, selectPage: boolean}} options */
	async function readWorkflow(runId, { beforeSeq, selectPage }) {
		const view = workflowRows.get(runId);
		if (!view || !view.disclosure.open || isClosed() || document.hidden) return;
		view.state.loading = true;
		view.state.error = "";
		renderWorkflowDetail(view);
		try {
			const detail = await readDetail(runId, beforeSeq);
			if (isClosed()) return;
			if (detail.runId !== runId) throw new Error("Workflow detail belongs to another run");
			const previous = view.state.detail;
			const fresh = !previous || !newerObservation(previous, detail);
			const { progress, ...observation } = detail;
			if (fresh) view.state.detail = observation;
			if (selectPage || (!view.state.history && fresh)) {
				if (selectPage || !view.state.page || progress.revision >= view.state.page.revision) {
					view.state.page = progress;
					view.state.history = beforeSeq !== undefined;
					if (selectPage) view.progress.scrollTop = 0;
				}
			}
		} catch (error) {
			view.state.error = `${FoundryWire.errorMessage(error)}. Refresh or reopen the run to retry.`;
		} finally {
			view.state.loading = false;
			renderWorkflowDetail(view);
		}
	}
	/** @param {ReturnType<typeof createWorkflowRow>} view */
	function renderWorkflowDetail(view) {
		const { detail, page, loading, error, history } = view.state;
		view.detailStatus.className = error ? "error" : "muted";
		view.detailStatus.textContent = error || (loading ? "Loading workflow details..."
			: detail ? `Observed ${new Date(detail.observedAt).toLocaleString()}${history ? " - browsing older progress" : ""}`
				: "Expand to load native observations.");
		if (detail) {
			const sections = [];
			for (const phase of detail.phases) {
				sections.push(element("p", "detail-row",
					`${phase.title}: ${phase.status} - ${duration(phase.accumulatedActiveMs + phase.currentActiveMs)} active - ${phase.liveAgentCount}/${phase.totalAgentCount} direct agents live`));
			}
			if (!detail.phases.length) sections.push(element("p", "muted", "No phase observations."));
			sections.push(element("h4", "", "Agents"));
			if (!detail.agents.length) sections.push(element("p", "muted", "No direct agents have been observed."));
			for (const agent of detail.agents) {
				const item = element("div", "workflow-agent");
				item.append(element("strong", "", agent.label), element("span", "muted", ` - ${agent.status}`));
				addLabeledValue(item, "Model", agent.resolvedModel ?? "Not resolved");
				if (agent.requestedModel && agent.requestedModel !== agent.resolvedModel) addLabeledValue(item, "Requested model", agent.requestedModel);
				addLabeledValue(item, "Active time", duration(agent.activeMs));
				addLabeledValue(item, "Activity", agent.activity);
				sections.push(item);
			}
			if (JSON.stringify(detail.declaredLimits) !== JSON.stringify(detail.approved)) {
				const limits = detail.declaredLimits;
				const declared = element("div", "workflow-metrics");
				addLabeledValue(declared, "AI credits", limits.maxAiCredits === undefined ? "Unbounded" : amount(limits.maxAiCredits));
				addLabeledValue(declared, "Active time", limits.timeoutSeconds === undefined ? "Unbounded" : duration(limits.timeoutSeconds * 1000));
				addLabeledValue(declared, "Admissions", limits.maxTotalSubagents === undefined ? "Unbounded" : amount(limits.maxTotalSubagents));
				const concurrency = limits.maxConcurrentSubagents ?? limits.maxTotalSubagents;
				addLabeledValue(declared, "Concurrency limit", concurrency === undefined ? "Unbounded" : amount(concurrency));
				sections.push(element("h4", "", "Declared limits"), declared);
			}
			view.observations.replaceChildren(element("h4", "", "Phases"), ...sections);
		}
		const text = page ? page.records.map((entry) => `#${entry.seq} [attempt ${entry.attempt}] ${entry.text}`).join("\n")
			|| "No progress records." : "Progress has not been loaded.";
		if (view.progress.textContent !== text) {
			const position = view.progress.scrollTop;
			view.progress.textContent = text;
			view.progress.scrollTop = position;
		}
		view.older.hidden = !page?.hasMoreOlder;
		view.older.disabled = loading;
		view.latest.hidden = !history;
		view.latest.disabled = loading;
	}
	/** @param {string} runId @param {string} operation */
	async function controlWorkflow(runId, operation) {
		const key = `${runId}:${operation}`;
		if (pendingWorkflowActions.has(key) || (!isNative() && !window.confirm(operation === "pause"
			? `Pause workflow ${runId}? In-flight work may need to repeat on resume. App task sessions keep running.`
			: `Resume workflow ${runId} with its existing journal and limits? This does not approve the plan.`))) return;
		pendingWorkflowActions.add(key);
		workflowControlError = "";
		renderWorkflows();
		try {
			await action({ action: `${operation}-workflow`, runId, revision: getPlanRevision() });
		} catch (error) {
			workflowControlError = FoundryWire.errorMessage(error);
		} finally {
			pendingWorkflowActions.delete(key);
			renderWorkflows();
		}
	}
	function renderWorkflows() {
		const host = requiredElement("#workflows");
		if (workflowList.parentElement !== host) host.replaceChildren(workflowNotices, workflowList, workflowFooter);
		workflowNotices.replaceChildren();
		workflowFooter.textContent = "";
		if (workflowControlError) {
			const error = element("p", "error", workflowControlError);
			error.setAttribute("role", "alert");
			workflowNotices.append(error);
		}
		if (!currentWorkflows || currentWorkflows.state === "unavailable") {
			workflowList.hidden = true;
			const message = currentWorkflows?.state === "unavailable"
				? `Workflow status unavailable: ${currentWorkflows.error} Use Refresh to retry.`
				: "Workflow status has not been loaded. Use Refresh to retry.";
			workflowNotices.append(element("p", "warning", message));
			return;
		}
		workflowList.hidden = false;
		if (currentWorkflows.warning) workflowNotices.append(element("p", "warning", currentWorkflows.warning));
		if (currentWorkflows.runs.length === 0) {
			workflowFooter.textContent = "No recent Foundry workflows in this session. Start one through Copilot to see its progress here.";
		}
		for (const [runId, view] of workflowRows) {
			if (!currentWorkflows.runs.some((run) => run.runId === runId)) {
				view.row.remove();
				workflowRows.delete(runId);
			}
		}
		for (const [index, run] of currentWorkflows.runs.entries()) {
			let view = workflowRows.get(run.runId);
			if (!view) {
				view = createWorkflowRow(run.runId);
				workflowRows.set(run.runId, view);
			}
			if (workflowList.children[index] !== view.row) {
				workflowList.insertBefore(view.row, workflowList.children[index] ?? null);
			}
			view.heading.replaceChildren(element("h3", "", run.workflowName), element("span", `status status-${run.status}`, run.status));
			view.metadata.replaceChildren();
			addLabeledValue(view.metadata, "Run", run.runId);
			addLabeledValue(view.metadata, "Phase", run.currentPhase?.id);
			addLabeledValue(view.metadata, "Live agents (direct)", run.liveAgentCount);
			addLabeledValue(view.metadata, "AI credits", usage(
				typeof run.consumed?.nanoAiu === "number" ? run.consumed.nanoAiu / 1_000_000_000 : undefined,
				run.approved?.maxAiCredits, run.approved));
			addLabeledValue(view.metadata, "Active time", usage(run.consumed?.activeMs,
				run.approved?.timeoutSeconds === undefined ? undefined : run.approved.timeoutSeconds * 1000,
				run.approved, duration));
			addLabeledValue(view.metadata, "Admissions", usage(run.consumed?.subagents, run.approved?.maxTotalSubagents, run.approved));
			const concurrency = run.approved?.maxConcurrentSubagents ?? run.approved?.maxTotalSubagents;
			addLabeledValue(view.metadata, "Concurrency limit", run.approved === null ? "Not yet approved"
				: run.approved === undefined ? "Unavailable"
					: concurrency === undefined ? "Unbounded" : amount(concurrency));
			const pause = run.terminal?.pauseInfo;
			if (pause?.type === "checkpoint") addLabeledValue(view.metadata, "Review checkpoint", pause.key);
			if (pause?.type === "user") addLabeledValue(view.metadata, "Paused by", "User");
			addLabeledValue(view.metadata, "Error", run.terminal?.error);
			if (run.terminal?.failure?.type === "workflow_limit_reached") {
				view.metadata.append(element("p", "warning", "A runtime limit was reached. Ask Copilot to resume with an approved increase to that limit."));
			}
			if (run.terminal?.failure?.type === "workflow_accounting_incomplete") {
				view.metadata.append(element("p", "warning", "Usage accounting is incomplete; displayed consumption is not a final total."));
			}
			const focusedControl = [...view.buttons.values()].some((button) => button === document.activeElement);
			for (const [operation, button] of view.buttons) {
				if (!run.actions.includes(operation)) {
					button.remove();
					view.buttons.delete(operation);
				}
			}
			for (const operation of run.actions) {
				let button = view.buttons.get(operation);
				if (!button) {
					button = document.createElement("button");
					button.type = "button";
					button.addEventListener("click", () => controlWorkflow(run.runId, operation));
					view.buttons.set(operation, button);
					view.controls.append(button);
				}
				const pending = pendingWorkflowActions.has(`${run.runId}:${operation}`);
				const label = operation === "pause" ? "Pause" : "Resume";
				button.textContent = pending
					? operation === "pause" ? "Pausing..." : "Resuming..."
					: label;
				button.setAttribute("aria-label", `${label} ${run.workflowName} workflow ${run.runId}`);
				button.disabled = pending;
				if (pending) {
					button.setAttribute("aria-busy", "true");
				} else {
					button.removeAttribute("aria-busy");
				}
			}
			if (focusedControl && ![...view.buttons.values()].some((button) => button === document.activeElement)) {
				([...view.buttons.values()].find((button) => !button.disabled) ?? view.summary).focus();
			}
			renderWorkflowDetail(view);
		}
		if (currentWorkflows.omittedOlder) {
			workflowFooter.textContent = "Older runs are available in native Workflow history.";
		}
	}
	return {
		read: readWorkflow,
		clearError: () => { workflowControlError = ""; },
		/** @param {WorkflowListing | null} value */
		update(value) { currentWorkflows = value; renderWorkflows(); },
		refreshOpen() {
			if (!document.hidden && currentWorkflows?.state === "available") {
				for (const [runId, view] of workflowRows) if (view.disclosure.open) loadWorkflow(runId);
			}
		},
	};
}
