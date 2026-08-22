// Classify and summarize a batch of tickets using native Factory structured agents.
import {
	UNTRUSTED_DATA_WARNING,
	untrustedBlock,
} from "../prompts.mjs";
const TICKETS_SCHEMA = {
	type: "array",
	items: {
		anyOf: [
			{ type: "string" },
			{ type: "object" },
		],
	},
};
const MAX_SUBAGENTS_PER_TICKET = 2;

export const meta = {
	name: "triage",
	description:
		"Classify tickets, suggest next actions, and render a triage table. " +
		"Args: { tickets: Array<string|object> } or a ticket array.",
	phases: [{ title: "Triage" }],
	argsSchema: {
		anyOf: [
			TICKETS_SCHEMA,
			{
				type: "object",
				required: ["tickets"],
				properties: { tickets: TICKETS_SCHEMA },
			},
		],
	},
	limits: {
		maxConcurrentSubagents: 8,
		maxTotalSubagents: 100,
		timeoutSeconds: 900,
		maxAiCredits: 10000,
	},
};

export async function run(factory) {
const factoryArgs = factory.args;
const input =
	factoryArgs && typeof factoryArgs === "object" && !Array.isArray(factoryArgs)
		? factoryArgs.tickets
		: factoryArgs;
if (!Array.isArray(input) || !input.length) {
	throw new Error("triage: provide a non-empty array of tickets or { tickets: [...] }");
}
const maxTickets = Math.floor(
	meta.limits.maxTotalSubagents / MAX_SUBAGENTS_PER_TICKET,
);
if (input.length > maxTickets) {
	throw new Error(
		`triage: ${input.length} tickets exceed the retry-safe ${maxTickets}-ticket limit`,
	);
}
factory.log(`triage: ${input.length} ticket(s)`);

const MAX_TICKET_CHARS = 8000;
const tickets = input.map((ticket, index) => {
	if (typeof ticket === "string" && ticket.trim()) {
		const text = ticket.trim();
		return {
			id: String(index + 1),
			text: text.slice(0, MAX_TICKET_CHARS),
			truncated: text.length > MAX_TICKET_CHARS,
		};
	}
	if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) {
		throw new Error(`triage: ticket ${index + 1} must be a non-empty string or object`);
	}
	const title = String(ticket.title || ticket.summary || "").trim();
	const body = String(ticket.body || ticket.description || "").trim();
	const text = [title, body].filter(Boolean).join("\n\n");
	if (!text) throw new Error(`triage: ticket ${index + 1} has no usable text`);
	const id = String(ticket.id ?? index + 1).trim() || String(index + 1);
	if (id.length > 256) {
		throw new Error(`triage: ticket ${index + 1} id exceeds 256 characters`);
	}
	return {
		id,
		text: text.slice(0, MAX_TICKET_CHARS),
		truncated: text.length > MAX_TICKET_CHARS,
	};
});

const TRIAGE = {
	type: "object",
	properties: {
		category: { enum: ["bug", "incident", "feature", "question", "task"] },
		priority: { enum: ["p0", "p1", "p2", "p3"] },
		confidence: { enum: ["high", "medium", "low"] },
		rationale: { type: "string" },
		action: { type: "string" },
	},
	required: ["category", "priority", "confidence", "rationale", "action"],
};

factory.phase("Triage");
const results = await factory.pipeline(tickets, async (ticket, _original, index) => {
	const detail = await factory.agent(
		`Triage this ticket. Choose category and priority, state calibrated confidence, explain briefly, and give one concrete next action.

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("TICKET", ticket.text)}`,
		{ label: `ticket:${index + 1}:${ticket.id}`, schema: TRIAGE },
	);
	if (
		detail === null ||
		!String(detail.rationale || "").trim() ||
		!String(detail.action || "").trim()
	) {
		return null;
	}
	return detail;
});

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
const out = [
	"| ID | Status | Category | Priority | Confidence | Rationale | Next action |",
	"| --- | --- | --- | --- | --- | --- | --- |",
];
let failed = 0;
for (let index = 0; index < tickets.length; index++) {
	const ticket = tickets[index];
	const detail = results[index];
	if (detail === null) {
		failed++;
		out.push(`| ${cell(ticket.id)} | Failed |  |  |  | Agent failed | Retry triage |`);
		continue;
	}
	out.push(
		`| ${cell(ticket.id)} | Triaged | ${cell(detail.category)} | ${cell(
			String(detail.priority).toUpperCase(),
		)} | ${cell(detail.confidence)} | ${cell(detail.rationale)} | ${cell(detail.action)} |`,
	);
}
const truncated = tickets.filter((ticket) => ticket.truncated).length;
out.push(
	"",
	`_Coverage: ${tickets.length}/${tickets.length} processed; ${tickets.length - failed} triaged, ${failed} failed, ${truncated} truncated._`,
);
return out.join("\n");
}
