// tournament.mjs — pick the single best option via pairwise elimination judging.
export const meta = { name: "tournament", description: "Comparative single-elimination judging picks one winner." };

const options = args || ["Use a flat JSON config file.", "Use a typed configuration module.", "Use environment variables only."];

const winner = await tournament(options, "clearest API design, lowest maintenance risk, and easiest migration path", { label: "judge" });
return String(winner);
