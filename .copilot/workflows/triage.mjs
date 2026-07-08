// triage.mjs — classify, cross-check, and summarize a batch of tickets.
//   run_workflow({ name: "triage", args: ["...", "..."] })
export const meta = {
	name: "triage",
	description: "Classify tickets, suggest next actions, and synthesize a triage report.",
	phases: ["triage", "report"],
};

const tickets = args || ["app crashes on export", "please add dark mode", "how do I reset my password?"];
const noTools = quarantine({ allowAllTools: false });

const classifyTicket = (ticket) => classify(ticket, ["bug", "feature", "question"], noTools);

const suggestAction = async (kind, ticket) => {
	const detail = await agent(`In one sentence, suggest next action for this ${kind}: ${ticket}`, { agentType: "worker", label: kind, ...noTools });
	return { ticket, kind, action: detail.content.trim() };
};

phase("triage");
const rows = (await pipeline(tickets, classifyTicket, suggestAction)).filter((r) => r !== null);

const report = await synthesize(
	rows.map((r) => `${r.kind}: ${r.ticket} -> ${r.action}`),
	{ prompt: "Group these by kind into a short triage report.", ...noTools },
);
return report.content;
