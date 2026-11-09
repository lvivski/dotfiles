import { addLabeledValue, element, requiredElement } from "./dom.mjs";
/** @typedef {ReturnType<typeof import("./contracts.mjs").FoundryWire.snapshot>} PlanSnapshot */
/** @typedef {NonNullable<PlanSnapshot["plan"]>["tasks"][number]} TaskView */
/** @typedef {TaskView["attempts"][number]["evidence"][number]} EvidenceRecord */

/** @param {ReturnType<typeof import("./actions.mjs").createActions>["planAction"]} planAction @param {string} planId */
export function createPlanView(planAction, planId) {
	/** @type {PlanSnapshot["plan"]} */
	let currentPlan = null;

	/** @type {PlanSnapshot["projection"]} */
	let currentProjection = null;

	let readOnlyInteractions = false;

	/** Plan statuses that no longer permit cancellation requests. */
	const terminalPlanStatuses = new Set(["completed", "cancelled"]);

	/** Supported projection actions only; recovery guidance is not HTTP authority. */
	const approvalControls = new Map([
		["approve-plan", {
			label: "Approve plan",
			approvalType: "plan",
			confirmation: "Approve this plan and make dependency-ready tasks available?",
		}],
		["approve-completion", {
			label: "Approve completion",
			approvalType: "completion",
			confirmation: "Approve this entire plan as complete?",
		}],
	]);
	let repositoryName = "";
	/** Requires the paired plan/projection before rendering plan-only sections. */
	function planView() {
		if (!currentPlan || !currentProjection) throw new Error("Plan rendering requires its current projection");
		return { plan: currentPlan, projection: currentProjection };
	}

	function renderSummary() {
		const { plan, projection } = planView();
		const summary = requiredElement("#summary");
		summary.replaceChildren();
		for (const [label, value] of [
			["Status", plan.status],
			["Revision", plan.revision],
			[
				"Progress",
				`${projection.progress.done}/${projection.progress.total} (${projection.progress.percent}%)`,
			],
			["Attempts", projection.progress.attempts],
			["Planning", plan.planning
				? `Workflow · ${plan.planning.runId}`
				: plan.factory?.candidateId ? "Sealed contract" : "Unlinked"],
			["Base branch", plan.repository.baseBranch],
			["Updated", plan.updatedAt],
		]) {
			const item = element("div", "summary-item");
			item.append(element("span", "muted", label));
			item.append(element("strong", "", value));
			summary.append(item);
		}
	}

	/**
	 * Renders one typed evidence record.
	 *
	 * @param {EvidenceRecord} entry
	 * @returns {HTMLElement}
	 */
	function makeEvidence(entry) {
		const item = element("li", "evidence-item");
		item.append(element("code", "", entry.id));
		item.append(document.createTextNode(
			` · ${entry.type}/${entry.outcome} · ${entry.summary} · ${entry.trust} by ${entry.producer}`,
		));
		if (entry.source) item.append(document.createTextNode(` · ${entry.source}`));
		return item;
	}

	/**
	 * Renders one immutable task-attempt history entry.
	 *
	 * @param {TaskView["attempts"][number]} attempt
	 * @returns {HTMLElement}
	 */
	function makeAttempt(attempt) {
		const details = element("details", "attempt");
		const summary = element(
			"summary",
			"",
			`${attempt.id} · ${attempt.status}${attempt.sessionId ? ` · ${attempt.sessionId}` : ""}`,
		);
		details.append(summary);
		const body = element("div", "details");
		addLabeledValue(body, "Reservation", attempt.reservationId);
		addLabeledValue(body, "Base", attempt.baseBranch);
		addLabeledValue(body, "Branch", attempt.branch);
		addLabeledValue(body, "Commit", attempt.commit);
		addLabeledValue(body, "PR", attempt.prUrl);
		addLabeledValue(body, "Result", attempt.resultSummary);
		addLabeledValue(body, "Error", attempt.error);
		addLabeledValue(body, "Reserved", attempt.reservedAt);
		addLabeledValue(body, "Started", attempt.startedAt);
		addLabeledValue(body, "Cancel requested", attempt.cancelRequestedAt);
		addLabeledValue(body, "Completed", attempt.completedAt);
		if (attempt.scopeOverride) {
			addLabeledValue(
				body,
				"Scope override",
				`${attempt.scopeOverride.approvedBy}: ${attempt.scopeOverride.reason}`,
			);
		}
		if (attempt.integrationRequired.length > 0) {
			addLabeledValue(
				body,
				"Integrated deliveries",
				attempt.integrationRequired
					.map((entry) => `${entry.taskId}/${entry.attemptId}`)
					.join(", "),
			);
		}
		if (attempt.evidence.length > 0) {
			const evidence = element("ul", "evidence-list");
			for (const entry of attempt.evidence) evidence.append(makeEvidence(entry));
			body.append(evidence);
		}
		details.append(body);
		return details;
	}

	/**
	 * Renders a task card, attempt history, and eligible controls.
	 *
	 * @param {TaskView} task
	 * @param {string} status Derived display status.
	 * @returns {HTMLElement}
	 */
	function makeTaskCard(task, status) {
		const { projection } = planView();
		const card = element("article", "task-card");
		const heading = element("div", "task-heading");
		heading.append(element("h4", "", `${task.id} — ${task.title}`));
		heading.append(element("span", `status status-${status}`, status));
		card.append(heading, element("p", "", task.description));

		const details = element("div", "details");
		addLabeledValue(details, "Kind", task.kind);
		addLabeledValue(details, "Depends on", task.dependsOn.join(", ") || "None");
		addLabeledValue(details, "Expected scope", task.expectedFiles.join(", ") || "Unspecified");
		addLabeledValue(details, "Required delivery", task.deliveryRequirement || "branch");
		card.append(details);
		if (task.attempts.length > 0) {
			const attempts = element("div", "attempts");
			for (const attempt of [...task.attempts].reverse()) attempts.append(makeAttempt(attempt));
			card.append(attempts);
		}

		if (projection.actions.some(
			(entry) => entry.kind === "retry-task" && entry.taskId === task.id,
		)) {
			const controls = element("div", "card-actions");
			const retry = element("button", "", "Retry");
			retry.setAttribute("type", "button");
			retry.addEventListener("click", () => planAction({
				action: "retry", revision: planView().plan.revision, taskId: task.id,
			}, retry, () => window.confirm(`Retry ${task.id} with a fresh attempt?`) ? {} : null));
			controls.append(retry);
			card.append(controls);
		}
		return card;
	}

	/**
	 * Groups and renders tasks in lifecycle order.
	 *
	 * @returns {void}
	 */
	function renderTasks() {
		const { plan, projection } = planView();
		const host = requiredElement("#tasks");
		host.replaceChildren();
		/** @type {Map<string, TaskView[]>} */
		const groups = new Map();
		for (const task of plan.tasks) {
			const status = task.status === "planned" && projection.scheduling.readyTaskIds.includes(task.id)
				? "ready" : task.status;
			const group = groups.get(status) ?? [];
			group.push(task);
			groups.set(status, group);
		}
		for (const status of ["running", "ready", "planned", "blocked", "failed", "done", "cancelled"]) {
			const tasks = groups.get(status);
			if (!tasks) continue;
			const section = element("section", "task-group");
			section.append(element("h3", "", `${status} (${tasks.length})`));
			for (const task of tasks) section.append(makeTaskCard(task, status));
			host.append(section);
		}
	}

	/**
	 * Renders the bound verification reservation, run, and outcome.
	 *
	 * @returns {void}
	 */
	function renderVerification() {
		const { plan } = planView();
		const host = requiredElement("#verification");
		host.replaceChildren();
		addLabeledValue(host, "Status", plan.verification.status);
		addLabeledValue(host, "Run", plan.verification.runId);
		addLabeledValue(host, "Input digest", plan.verification.inputDigest);
		addLabeledValue(host, "Summary", plan.verification.summary);
		addLabeledValue(host, "Evidence IDs", plan.verification.evidence.join(" · "));
		addLabeledValue(host, "Missing evidence", plan.verification.missingEvidence.join(" · "));
		addLabeledValue(
			host,
			"Correction tasks",
			plan.verification.correctionTaskIds.join(", "),
		);
	}

	/**
	 * Renders derived recovery guidance and cancellation requirements.
	 *
	 * @returns {void}
	 */
	function renderRecovery() {
		const { plan, projection } = planView();
		const host = requiredElement("#recovery");
		host.replaceChildren();
		addLabeledValue(host, "Next action", projection.nextAction.kind);
		addLabeledValue(host, "Factory hold", projection.factoryHold?.reason);
		if (projection.dependencyWaits.length > 0) {
			addLabeledValue(
				host,
				"Dependency waits",
				projection.dependencyWaits
					.map((entry) => `${entry.taskId} ← ${entry.dependencies
						.map((dependency) => `${dependency.taskId} (${dependency.status})`)
						.join(", ")}`)
					.join(" · "),
			);
		}
		if (plan.cancellation) {
			addLabeledValue(host, "Cancellation reason", plan.cancellation.reason);
			addLabeledValue(
				host,
				"Required attempts",
				plan.cancellation.requiredAttemptIds.join(", ") || "None",
			);
			addLabeledValue(
				host,
				"Verification reservation",
				plan.cancellation.verificationReservationId,
			);
			addLabeledValue(host, "Verification run", plan.cancellation.verificationRunId);
			host.append(element(
				"p",
				"warning",
				"Foundry has only requested cancellation. Stop or archive every listed App session and cancel the authoritative workflow run before finalization.",
			));
		}
		const actions = element("ol", "action-list");
		for (const entry of projection.actions) {
			actions.append(element("li", "", JSON.stringify(entry)));
		}
		if (actions.childNodes.length > 0) host.append(actions);
	}

	/**
	 * Renders the newest bounded plan activity retained in the authoritative document.
	 *
	 * @returns {void}
	 */
	function renderActivity() {
		const { plan } = planView();
		const host = requiredElement("#activity");
		host.replaceChildren();
		const entries = [...plan.activity].reverse().slice(0, 20);
		if (entries.length === 0) {
			host.append(element("p", "muted", "No activity has been recorded."));
			return;
		}
		const list = element("ol", "activity-list");
		for (const entry of entries) {
			const item = element("li", "activity-item");
			item.append(element("code", "", entry.event));
			item.append(element(
				"span",
				"muted",
				`revision ${entry.revision} · ${entry.at}`,
			));
			list.append(item);
		}
		host.append(list);
	}

	/**
	 * Maps supported semantic approval actions to controls.
	 *
	 * @returns {void}
	 */
	function renderControls() {
		const { plan, projection } = planView();
		const approve = requiredElement("#approve-button");
		const approval = projection.actions
			.map((entry) => approvalControls.get(entry.kind))
			.find(Boolean);
		approve.hidden = !approval || readOnlyInteractions;
		if (approval) approve.textContent = approval.label;
		requiredElement("#cancel-plan-button").hidden =
			terminalPlanStatuses.has(plan.status) || plan.status === "cancelling"
			|| projection.factoryHold?.blocksAllExecution === true;
		if (readOnlyInteractions) requiredElement("#cancel-plan-button").hidden = true;
	}
	/**
	 * Renders the current complete snapshot.
	 *
	 * @returns {void}
	 */
	function render(planChanged = true) {
		requiredElement("#surface-label").textContent = readOnlyInteractions ? "Foundry (read-only)" : "Foundry engineering plan";
		for (const id of ["summary", "workflow-section", "task-section", "verification-section", "recovery-section", "activity-section"]) {
			requiredElement(`#${id}`).hidden = !currentPlan;
		}
		if (!currentPlan) {
			requiredElement("#surface-label").textContent = "Foundry (read-only)";
			requiredElement("#plan-title").textContent = "Repository factory";
			requiredElement("#plan-objective").textContent = repositoryName;
			requiredElement("#approve-button").hidden = true;
			requiredElement("#cancel-plan-button").hidden = true;
			return;
		}
		if (planChanged) {
			requiredElement("#plan-title").textContent = currentPlan.title;
			requiredElement("#plan-objective").textContent = currentPlan.objective;
			renderSummary();
			renderTasks();
			renderVerification();
			renderRecovery();
			renderActivity();
			renderControls();
		}
	}
	requiredElement("#approve-button").addEventListener("click", async () => {
		const approval = currentProjection?.actions
			.map((entry) => approvalControls.get(entry.kind))
			.find(Boolean);
		if (!approval) return;
		await planAction({
			action: "approve", revision: planView().plan.revision, approvalType: approval.approvalType,
		}, requiredElement("#approve-button"), () => {
			const approvedBy = window.prompt("Who is approving this action?");
			return approvedBy?.trim() && window.confirm(approval.confirmation)
				? { approvedBy: approvedBy.trim() } : null;
		});
	});
	requiredElement("#cancel-plan-button").addEventListener("click", async () => {
		await planAction({
			action: "cancel", revision: planView().plan.revision, requestId: crypto.randomUUID(),
		}, requiredElement("#cancel-plan-button"), () => {
			const reason = window.prompt("Why should this plan enter cancellation?");
			const requestedBy = window.prompt("Who is requesting cancellation?");
			return reason && requestedBy?.trim() && window.confirm(
				`Request cancellation for ${planId}? External App sessions keep running until explicitly stopped.`,
			) ? { reason, requestedBy: requestedBy.trim() } : null;
		});
	});
	return {
		revision: () => planView().plan.revision,
		/** @param {PlanSnapshot["plan"]} plan @param {PlanSnapshot["projection"]} projection
		 * @param {boolean} readOnly @param {boolean} changed @param {string} repository */
		update(plan, projection, readOnly, changed, repository) {
			currentPlan = plan;
			currentProjection = projection;
			readOnlyInteractions = readOnly;
			repositoryName = repository;
			render(changed);
		},
	};
}
