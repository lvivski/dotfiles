export const meta = {
	name: "loop-until-dry",
	description: "Discover findings until two consecutive rounds produce nothing new.",
	limits: { maxConcurrentSubagents: 1, maxTotalSubagents: 12, maxAiCredits: 30 },
};

const question = context.args || "Find likely issues in this project.";
const seen = new Set();
let dryRounds = 0;

phase("Discover");
for (let round = 0; round < 10 && dryRounds < 2; round++) {
	const result = await agent(
		`Find new issues not already listed.

Question: ${question}

Already seen:
${JSON.stringify([...seen])}`,
		{ label: `round:${round}` },
	);
	if (result === null) {
		dryRounds++;
		continue;
	}
	const before = seen.size;
	result.split("\n").map((line) => line.trim()).filter(Boolean).forEach((line) => seen.add(line));
	dryRounds = seen.size === before ? dryRounds + 1 : 0;
	log(`round ${round}: ${seen.size - before} new finding(s)`);
}

phase("Report");
return agent(
	`Deduplicate and summarize these findings. Note uncertainty and evidence gaps:\n\n${[...seen].join("\n")}`,
	{ label: "report" },
);
