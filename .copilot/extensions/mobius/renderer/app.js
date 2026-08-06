const token = document.querySelector('meta[name="mobius-token"]').content;
const planId = document.querySelector('meta[name="mobius-plan-id"]').content;
const terminalPlanStatuses = new Set(["completed", "cancelled"]);
const cancellableTaskStatuses = new Set(["planned", "ready", "running", "blocked", "failed"]);
let currentPlan = null;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

function addLabeledValue(parent, label, value) {
    if (value === null || value === undefined || value === "") return;
    const row = element("div", "detail-row");
    row.append(element("strong", "", `${label}: `));
    row.append(document.createTextNode(String(value)));
    parent.append(row);
}

async function request(path, options) {
    const response = await fetch(path, options);
    const payload = await response.json();
    if (!response.ok || payload.ok !== true) {
        const error = new Error(payload.error?.message ?? `Request failed with ${response.status}`);
        error.code = payload.error?.code;
        throw error;
    }
    return payload.value;
}

async function loadPlan() {
    try {
        currentPlan = await request("/api/plan");
        render(currentPlan);
        document.querySelector("#error").textContent = "";
    } catch (error) {
        document.querySelector("#error").textContent = error.message;
    }
}

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

function renderSummary(plan) {
    const summary = document.querySelector("#summary");
    summary.replaceChildren();
    const done = plan.tasks.filter((task) => task.status === "done").length;
    for (const [label, value] of [
        ["Status", plan.status],
        ["Revision", plan.revision],
        ["Progress", `${done}/${plan.tasks.length}`],
        ["Planning", plan.planning
            ? `${plan.planning.backend} · ${plan.planning.runId}`
            : "Unlinked"],
        ["Base branch", plan.repository.baseBranch],
        ["Updated", plan.updatedAt],
    ]) {
        const item = element("div", "summary-item");
        item.append(element("span", "muted", label));
        item.append(element("strong", "", value));
        summary.append(item);
    }
}

function makeTaskCard(task) {
    const card = element("article", "task-card");
    const heading = element("div", "task-heading");
    heading.append(element("h4", "", `${task.id} — ${task.title}`));
    heading.append(element("span", `status status-${task.status}`, task.status));
    card.append(heading, element("p", "", task.description));

    const details = element("div", "details");
    addLabeledValue(details, "Depends on", task.dependsOn.join(", ") || "None");
    addLabeledValue(details, "Expected scope", task.expectedFiles.join(", ") || "Unspecified");
    addLabeledValue(details, "Session", task.sessionId);
    addLabeledValue(details, "Branch", task.branch);
    addLabeledValue(details, "Result", task.resultSummary);
    addLabeledValue(details, "Blocked/error", task.error);
    if (task.prUrl) {
        const row = element("div", "detail-row");
        row.append(element("strong", "", "Pull request: "));
        const link = element("a", "", task.prUrl);
        link.href = task.prUrl;
        link.target = "_blank";
        link.rel = "noreferrer";
        row.append(link);
        details.append(row);
    }
    if (task.evidence.length > 0) {
        addLabeledValue(details, "Evidence", task.evidence.join(" · "));
    }
    card.append(details);

    const controls = element("div", "card-actions");
    if (task.status === "blocked" || task.status === "failed") {
        const retry = element("button", "", "Retry");
        retry.type = "button";
        retry.addEventListener("click", async () => {
            if (!window.confirm(`Retry ${task.id}?`)) return;
            try {
                currentPlan = await action({
                    action: "retry",
                    revision: currentPlan.revision,
                    taskId: task.id,
                });
                render(currentPlan);
            } catch (error) {
                document.querySelector("#error").textContent = error.message;
            }
        });
        controls.append(retry);
    }
    if ((currentPlan.status === "approved" || currentPlan.status === "running")
        && cancellableTaskStatuses.has(task.status)) {
        const cancel = element("button", "danger-secondary", "Cancel task and plan");
        cancel.type = "button";
        cancel.addEventListener("click", async () => {
            const reason = window.prompt(`Why should ${task.id} be cancelled?`);
            if (!reason || !window.confirm(`Cancel required task ${task.id} and the entire plan?`)) return;
            try {
                currentPlan = await action({
                    action: "cancel",
                    revision: currentPlan.revision,
                    target: "task",
                    taskId: task.id,
                    reason,
                });
                render(currentPlan);
            } catch (error) {
                document.querySelector("#error").textContent = error.message;
            }
        });
        controls.append(cancel);
    }
    if (controls.childNodes.length > 0) card.append(controls);
    return card;
}

function renderTasks(plan) {
    const host = document.querySelector("#tasks");
    host.replaceChildren();
    const groups = new Map();
    for (const task of plan.tasks) {
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

function renderVerification(plan) {
    const host = document.querySelector("#verification");
    host.replaceChildren();
    addLabeledValue(host, "Status", plan.verification.status);
    addLabeledValue(host, "Backend", plan.verification.backend);
    addLabeledValue(host, "Run", plan.verification.runId);
    addLabeledValue(host, "Input digest", plan.verification.inputDigest);
    addLabeledValue(host, "Summary", plan.verification.summary);
    addLabeledValue(host, "Evidence", plan.verification.evidence.join(" · "));
    addLabeledValue(host, "Missing evidence", plan.verification.missingEvidence.join(" · "));
}

function renderControls(plan) {
    const approve = document.querySelector("#approve-button");
    if (plan.status === "awaiting-approval") {
        approve.hidden = false;
        approve.textContent = "Approve plan";
        approve.dataset.type = "plan";
    } else if (plan.status === "awaiting-completion-approval") {
        approve.hidden = false;
        approve.textContent = "Approve completion";
        approve.dataset.type = "completion";
    } else {
        approve.hidden = true;
    }
    document.querySelector("#cancel-plan-button").hidden = terminalPlanStatuses.has(plan.status);
}

function render(plan) {
    document.querySelector("#plan-title").textContent = plan.title;
    document.querySelector("#plan-objective").textContent = plan.objective;
    renderSummary(plan);
    renderTasks(plan);
    renderVerification(plan);
    renderControls(plan);
}

document.querySelector("#refresh-button").addEventListener("click", loadPlan);
document.querySelector("#approve-button").addEventListener("click", async (event) => {
    const approvalType = event.currentTarget.dataset.type;
    if (!window.confirm(approvalType === "completion"
        ? "Approve this entire plan as complete?"
        : "Approve this plan and make dependency-ready tasks available?")) return;
    try {
        currentPlan = await action({
            action: "approve",
            revision: currentPlan.revision,
            approvalType,
        });
        render(currentPlan);
    } catch (error) {
        document.querySelector("#error").textContent = error.message;
    }
});
document.querySelector("#cancel-plan-button").addEventListener("click", async () => {
    const reason = window.prompt("Why should this plan be cancelled?");
    if (!reason || !window.confirm(`Cancel Mobius plan ${planId}?`)) return;
    try {
        currentPlan = await action({
            action: "cancel",
            revision: currentPlan.revision,
            target: "plan",
            reason,
        });
        render(currentPlan);
    } catch (error) {
        document.querySelector("#error").textContent = error.message;
    }
});

const events = new EventSource("/events");
events.addEventListener("change", loadPlan);
events.onerror = () => {
    document.querySelector("#error").textContent = "Live updates disconnected; use Refresh.";
};
loadPlan();
