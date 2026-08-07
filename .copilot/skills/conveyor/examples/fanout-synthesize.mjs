export const meta = {
	name: "fanout-synthesize",
	description: "Summarize each item concurrently, then synthesize one overview.",
	limits: { maxConcurrentSubagents: 6, maxTotalSubagents: 30, maxAiCredits: 30 },
};

const items = context.args || ["README.md"];
phase("Summarize");
const parts = await parallel(
	items.map((item, index) => () =>
		agent(`Summarize the relevant facts from ${item}.`, {
			label: `summary:${index}`,
		}),
	),
);

phase("Report");
return agent(
	`Write one coherent overview from these summaries:\n\n${parts.filter((value) => value !== null).join("\n\n")}`,
	{ label: "report" },
);
