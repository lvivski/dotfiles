// fanout-synthesize.mjs — fan out summaries over items (a barrier), then merge into one overview.
export const meta = { name: "fanout-synthesize", description: "Summarize each item in parallel, then synthesize one overview." };

const items = args || ["README.md"];

const parts = await fanOut(items, (item) => agent(`Summarize the relevant facts from ${item}.`, { agentType: "worker", phase: "summarize", label: String(item).slice(0, 24) }));

const report = await synthesize(parts, { prompt: "Write one coherent overview from these summaries.", label: "report" });
return report.content;
