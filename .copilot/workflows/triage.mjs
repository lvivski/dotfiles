// triage.mjs — classify, cross-check, and summarize a batch of tickets.
//   run_workflow({ name: "triage", args: ["...", "..."] })
export const meta = {
	name: "triage",
	description: "Classify tickets, suggest next actions, and synthesize a triage report.",
	phases: ["triage", "report"],
};

const workflowArgs = context.args;
const input = workflowArgs && typeof workflowArgs === "object" && !Array.isArray(workflowArgs) ? workflowArgs.tickets : workflowArgs;
if (!Array.isArray(input) || !input.length) throw new Error("triage: provide a non-empty array of tickets or { tickets: [...] }");

const MAX_TICKET_CHARS = 8000;
const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");

const tickets = input.map((ticket, index) => {
	if (typeof ticket === "string" && ticket.trim()) return { id: String(index + 1), text: ticket.trim(), truncated: ticket.length > MAX_TICKET_CHARS };
	if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) throw new Error(`triage: ticket ${index + 1} must be a non-empty string or object`);
	const title = String(ticket.title || ticket.summary || "").trim();
	const body = String(ticket.body || ticket.description || "").trim();
	const text = [title, body].filter(Boolean).join("\n\n");
	if (!text) throw new Error(`triage: ticket ${index + 1} has no title, summary, body, or description`);
	return { id: String(ticket.id ?? index + 1), text, truncated: text.length > MAX_TICKET_CHARS };
});

const triageTicket = async (ticket) => {
	const detail = await agent(
		`Triage this ticket. Choose a category and priority, state calibrated confidence, explain briefly, and give one concrete next action.\n\nTicket:\n${ticket.text.slice(0, MAX_TICKET_CHARS)}`,
		{
			schema: {
				type: "object",
				properties: {
					category: { enum: ["bug", "incident", "feature", "question", "task"] },
					priority: { enum: ["p0", "p1", "p2", "p3"] },
					confidence: { enum: ["high", "medium", "low"] },
					rationale: { type: "string" },
					action: { type: "string" },
				},
				required: ["category", "priority", "confidence", "rationale", "action"],
			},
			label: ticket.id,
			profile: "none",
			validate: (value) => {
				const errors = [];
				if (!String(value.rationale || "").trim()) errors.push("rationale must be non-empty");
				if (!String(value.action || "").trim()) errors.push("action must be non-empty");
				return errors;
			},
		},
	);
	return detail.ok ? { ticket, ok: true, ...detail.value } : { ticket, ok: false, error: detail.error || "triage agent failed" };
};

const rows = await phase("triage", () => pipeline(tickets, triageTicket));

const out = [
	"| ID | Status | Category | Priority | Confidence | Rationale | Next action |",
	"| --- | --- | --- | --- | --- | --- | --- |",
];
for (const row of rows) {
	if (!row.ok) {
		out.push(`| ${cell(row.ticket.id)} | Failed |  |  |  | ${cell(row.error)} | Retry triage |`);
		continue;
	}
	out.push(`| ${cell(row.ticket.id)} | Triaged | ${cell(row.category)} | ${cell(row.priority.toUpperCase())} | ${cell(row.confidence)} | ${cell(row.rationale)} | ${cell(row.action)} |`);
}
const failed = rows.filter((row) => !row.ok).length;
const truncated = tickets.filter((ticket) => ticket.truncated).length;
out.push("", `_Coverage: ${rows.length}/${tickets.length} ticket(s) processed; ${rows.length - failed} triaged, ${failed} failed, ${truncated} input(s) truncated to ${MAX_TICKET_CHARS} characters for model review._`);
return out.join("\n");
