/**
 * Browser renderer for the Mobius loopback canvas.
 *
 * @module mobius/renderer
 */

/**
 * @typedef {object} EvidenceRecord
 * @property {string} id
 * @property {string} type
 * @property {string} summary
 * @property {string | null} source
 * @property {string} outcome
 * @property {string} producer
 * @property {string} trust
 */

/**
 * @typedef {object} PlanSnapshot
 * @property {any} plan Authoritative Mobius plan document.
 * @property {any} projection Derived operational projection.
 */

/**
 * Requires an HTML element that must exist in the static renderer template.
 *
 * @param {string} selector
 * @returns {HTMLElement}
 */
function requiredElement(selector) {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLElement)) {
        throw new Error(`Missing required renderer element: ${selector}`);
    }
    return node;
}

/**
 * Requires a metadata element embedded by the loopback server.
 *
 * @param {string} selector
 * @returns {HTMLMetaElement}
 */
function requiredMeta(selector) {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLMetaElement)) {
        throw new Error(`Missing required renderer metadata: ${selector}`);
    }
    return node;
}

/** Per-instance action token embedded by the loopback server. */
const token = requiredMeta('meta[name="mobius-token"]').content;

/** Stable plan ID embedded by the loopback server. */
const planId = requiredMeta('meta[name="mobius-plan-id"]').content;

/** Plan statuses that no longer permit cancellation requests. */
const terminalPlanStatuses = new Set(["completed", "cancelled"]);

/** Error returned by a failed loopback API envelope. */
class MobiusRequestError extends Error {
    /**
     * @param {string} message
     * @param {string | undefined} code
     */
    constructor(message, code) {
        super(message);
        this.name = "MobiusRequestError";
        this.code = code;
    }
}

/** @type {any} */
let currentPlan = null;

/** @type {any} */
let currentProjection = null;

/**
 * Creates a DOM element and assigns text through `textContent`.
 *
 * @param {string} tag
 * @param {string} className
 * @param {unknown} [text]
 * @returns {HTMLElement}
 */
function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

/**
 * Adds a labeled row when the value is present.
 *
 * @param {HTMLElement} parent
 * @param {string} label
 * @param {unknown} value
 * @returns {void}
 */
function addLabeledValue(parent, label, value) {
    if (value === null || value === undefined || value === "") return;
    const row = element("div", "detail-row");
    row.append(element("strong", "", `${label}: `));
    row.append(document.createTextNode(String(value)));
    parent.append(row);
}

/**
 * Calls a loopback API endpoint and unwraps the Mobius response envelope.
 *
 * @param {string} path
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 * @throws {Error} When the server returns a failed Mobius envelope.
 */
async function request(path, options) {
    const response = await fetch(path, options);
    const payload = await response.json();
    if (!response.ok || payload.ok !== true) {
        throw new MobiusRequestError(
            payload.error?.message ?? `Request failed with ${response.status}`,
            payload.error?.code,
        );
    }
    return payload.value;
}

/**
 * Replaces renderer state with a complete server snapshot.
 *
 * @param {PlanSnapshot} snapshot
 * @returns {void}
 */
function acceptSnapshot(snapshot) {
    currentPlan = snapshot.plan;
    currentProjection = snapshot.projection;
    render();
    requiredElement("#error").textContent = "";
}

/**
 * Reloads the authoritative plan and derived projection.
 *
 * @returns {Promise<void>}
 */
async function loadPlan() {
    try {
        acceptSnapshot(await request("/api/plan"));
    } catch (error) {
        requiredElement("#error").textContent = error.message;
    }
}

/**
 * Executes a confirmed, token-authenticated canvas mutation.
 *
 * @param {Record<string, unknown>} body
 * @returns {Promise<PlanSnapshot>}
 */
async function action(body) {
    return request("/api/action", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-mobius-token": token,
        },
        body: JSON.stringify({ ...body, confirmed: true }),
    });
}

/**
 * Renders plan-level progress and provenance cards.
 *
 * @returns {void}
 */
function renderSummary() {
    const summary = requiredElement("#summary");
    summary.replaceChildren();
    for (const [label, value] of [
        ["Status", currentPlan.status],
        ["Revision", currentPlan.revision],
        [
            "Progress",
            `${currentProjection.progress.done}/${currentProjection.progress.total} (${currentProjection.progress.percent}%)`,
        ],
        ["Attempts", currentProjection.progress.attempts],
        ["Planning", currentPlan.planning
			? `Factory · ${currentPlan.planning.runId}`
            : "Unlinked"],
        ["Base branch", currentPlan.repository.baseBranch],
        ["Updated", currentPlan.updatedAt],
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
 * @param {any} attempt
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
 * @param {any} task
 * @returns {HTMLElement}
 */
function makeTaskCard(task) {
    const card = element("article", "task-card");
    const heading = element("div", "task-heading");
    heading.append(element("h4", "", `${task.id} — ${task.title}`));
    heading.append(element("span", `status status-${task.status}`, task.status));
    card.append(heading, element("p", "", task.description));

    const details = element("div", "details");
    addLabeledValue(details, "Depends on", task.dependsOn.join(", ") || "None");
    addLabeledValue(details, "Expected scope", task.expectedFiles.join(", ") || "Unspecified");
    card.append(details);
    if (task.attempts.length > 0) {
        const attempts = element("div", "attempts");
        for (const attempt of [...task.attempts].reverse()) attempts.append(makeAttempt(attempt));
        card.append(attempts);
    }

    if (task.status === "blocked" || task.status === "failed") {
        const controls = element("div", "card-actions");
        const retry = element("button", "", "Retry");
        retry.setAttribute("type", "button");
        retry.addEventListener("click", async () => {
            if (!window.confirm(`Retry ${task.id} with a fresh attempt?`)) return;
            try {
                acceptSnapshot(await action({
                    action: "retry",
                    revision: currentPlan.revision,
                    taskId: task.id,
                }));
            } catch (error) {
                requiredElement("#error").textContent = error.message;
            }
        });
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
    const host = requiredElement("#tasks");
    host.replaceChildren();
    const groups = new Map();
    for (const task of currentPlan.tasks) {
        if (!groups.has(task.status)) groups.set(task.status, []);
        groups.get(task.status).push(task);
    }
    for (const status of ["running", "ready", "planned", "blocked", "failed", "done", "cancelled"]) {
        const tasks = groups.get(status);
        if (!tasks) continue;
        const section = element("section", "task-group");
        section.append(element("h3", "", `${status} (${tasks.length})`));
        for (const task of tasks) section.append(makeTaskCard(task));
        host.append(section);
    }
}

/**
 * Renders the bound verification reservation, run, and outcome.
 *
 * @returns {void}
 */
function renderVerification() {
    const host = requiredElement("#verification");
    host.replaceChildren();
    addLabeledValue(host, "Status", currentPlan.verification.status);
    addLabeledValue(host, "Run", currentPlan.verification.runId);
    addLabeledValue(host, "Input digest", currentPlan.verification.inputDigest);
    addLabeledValue(host, "Summary", currentPlan.verification.summary);
    addLabeledValue(host, "Evidence IDs", currentPlan.verification.evidence.join(" · "));
    addLabeledValue(host, "Missing evidence", currentPlan.verification.missingEvidence.join(" · "));
    addLabeledValue(
        host,
        "Correction tasks",
        currentPlan.verification.correctionTaskIds.join(", "),
    );
}

/**
 * Renders derived recovery guidance and cancellation requirements.
 *
 * @returns {void}
 */
function renderRecovery() {
    const host = requiredElement("#recovery");
    host.replaceChildren();
    addLabeledValue(host, "Next action", currentProjection.nextAction.kind);
    if (currentProjection.dependencyWaits.length > 0) {
        addLabeledValue(
            host,
            "Dependency waits",
            currentProjection.dependencyWaits
                .map((entry) => `${entry.taskId} ← ${entry.dependencies
                    .map((dependency) => `${dependency.taskId} (${dependency.status})`)
                    .join(", ")}`)
                .join(" · "),
        );
    }
    if (currentPlan.cancellation) {
        addLabeledValue(host, "Cancellation reason", currentPlan.cancellation.reason);
        addLabeledValue(
            host,
            "Required attempts",
            currentPlan.cancellation.requiredAttemptIds.join(", ") || "None",
        );
        addLabeledValue(
            host,
            "Verification reservation",
            currentPlan.cancellation.verificationReservationId,
        );
        addLabeledValue(host, "Verification run", currentPlan.cancellation.verificationRunId);
        host.append(element(
            "p",
            "warning",
            "Mobius has only requested cancellation. Stop or archive every listed App session and cancel the listed Conveyor run before finalization.",
        ));
    }
    const actions = element("ol", "action-list");
    for (const entry of currentProjection.actions) {
        actions.append(element("li", "", JSON.stringify(entry)));
    }
    if (actions.childNodes.length > 0) host.append(actions);
}

/**
 * Shows only controls valid for the current plan status.
 *
 * @returns {void}
 */
function renderControls() {
    const approve = requiredElement("#approve-button");
    if (currentPlan.status === "awaiting-approval") {
        approve.hidden = false;
        approve.textContent = "Approve plan";
        approve.dataset.type = "plan";
    } else if (currentPlan.status === "awaiting-completion-approval") {
        approve.hidden = false;
        approve.textContent = "Approve completion";
        approve.dataset.type = "completion";
    } else {
        approve.hidden = true;
    }
    requiredElement("#cancel-plan-button").hidden =
        terminalPlanStatuses.has(currentPlan.status) || currentPlan.status === "cancelling";
}

/**
 * Renders the current complete snapshot.
 *
 * @returns {void}
 */
function render() {
    requiredElement("#plan-title").textContent = currentPlan.title;
    requiredElement("#plan-objective").textContent = currentPlan.objective;
    renderSummary();
    renderTasks();
    renderVerification();
    renderRecovery();
    renderControls();
}

requiredElement("#refresh-button").addEventListener("click", loadPlan);
requiredElement("#approve-button").addEventListener("click", async (event) => {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const approvalType = event.currentTarget.dataset.type;
    if (!window.confirm(approvalType === "completion"
        ? "Approve this entire plan as complete?"
        : "Approve this plan and make dependency-ready tasks available?")) return;
    try {
        acceptSnapshot(await action({
            action: "approve",
            revision: currentPlan.revision,
            approvalType,
        }));
    } catch (error) {
        requiredElement("#error").textContent = error.message;
    }
});
requiredElement("#cancel-plan-button").addEventListener("click", async () => {
    const reason = window.prompt("Why should this plan enter cancellation?");
    if (!reason || !window.confirm(
        `Request cancellation for ${planId}? External App sessions keep running until explicitly stopped.`,
    )) return;
    try {
        acceptSnapshot(await action({
            action: "cancel",
            revision: currentPlan.revision,
            requestId: crypto.randomUUID(),
            target: "plan",
            reason,
        }));
    } catch (error) {
        requiredElement("#error").textContent = error.message;
    }
});

const events = new EventSource("/events");
events.addEventListener("change", loadPlan);
events.onerror = () => {
    requiredElement("#error").textContent = "Live updates disconnected; use Refresh.";
};
loadPlan();
