// classify-route.cwf.mjs — classify each ticket into a category, suggest an action, summarize.
export const meta = { name: "classify-route", description: "Classify tickets, suggest next actions, and synthesize a triage report." };

const tickets = args || ["app crashes on export", "please add dark mode", "how do I reset my password?"];
const noTools = quarantine({ allowAllTools: false });

const classifyTicket = (ticket) => classify(ticket, ["bug", "feature", "question"], { label: "classify", ...noTools });

const suggestAction = async (kind, ticket) => {
	const detail = await agent(`In one sentence, suggest the next action for this ${kind}: ${ticket}`, { agentType: "worker", phase: "triage", label: kind, ...noTools });
	return { ticket, kind, action: detail.content.trim() };
};

const rows = (await pipeline(tickets, classifyTicket, suggestAction)).filter((row) => row !== null);
const report = await synthesize(
	rows.map((row) => `${row.kind}: ${row.ticket} -> ${row.action}`),
	{ prompt: "Group these by kind into a short triage report.", label: "report", ...noTools },
);
return report.content;
