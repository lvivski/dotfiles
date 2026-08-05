// loop-until-dry.mjs — repeat discovery until two consecutive rounds find nothing new.
export const meta = { name: "loop-until-dry", description: "Iteratively discover findings until the well runs dry, then summarize." };

const question = context.args || "Find likely issues in this project.";
const seen = new Set();
let dryRounds = 0;

const findMore = async (roundIndex) => {
	const result = await phase("discover", () => agent(`Find new issues not already seen.\n\nQuestion: ${question}\n\nAlready seen:\n${[...seen].sort()}`, { agentType: "worker", label: `round-${roundIndex}` }));
	const candidates = result.content.split("\n").map((line) => line.trim()).filter(Boolean);
	const fresh = candidates.filter((line) => !seen.has(line));
	fresh.forEach((line) => seen.add(line));
	dryRounds = fresh.length ? 0 : dryRounds + 1;
	log(`round ${roundIndex}: ${fresh.length} new finding(s)`);
	return fresh;
};

for (let round = 0; round < 6 && dryRounds < 2; round++) await findMore(round);

const report = await agent(`Deduplicate and summarize these findings. Note uncertainty and evidence gaps.\n\n${[...seen].sort().join("\n")}`, { label: "report" });
return report.content;
