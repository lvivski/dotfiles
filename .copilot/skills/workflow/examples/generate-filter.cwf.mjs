// generate-filter.cwf.mjs — generate many candidates, dedupe, and keep those passing a rubric.
export const meta = { name: "generate-filter", description: "Generate candidates, deduplicate, and filter by a rubric." };

const prompt = args || "Propose an API name for this feature.";

const candidates = await generateAndFilter(prompt, { n: 8, rubric: "short, memorable, unambiguous, and consistent with this repository", label: "name" });

return candidates.map((candidate, index) => `${index + 1}. ${candidate.content.trim()}`).join("\n");
