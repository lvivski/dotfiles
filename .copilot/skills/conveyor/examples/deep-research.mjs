// deep-research.mjs — decompose a question into angles, research + verify each, synthesize.
export const meta = { name: "deep-research", description: "Fan out web research over angles, verify sourced claims, synthesize a cited answer." };

const question = typeof context.args === "string" ? context.args : "What changed in this topic recently?";

const plan = await agent(`Break this research question into 4 independent angles:\n\n${question}`, {
	schema: { type: "array", items: { type: "string" } },
	label: "plan",
	profile: "none",
});
let angles = plan.ok ? plan.value.map((angle) => String(angle).trim()).filter(Boolean) : [];
if (!angles.length) angles = ["Investigate the original question as a whole."];

const contextFor = (angle) => `Original research question:\n${question}\n\nAssigned angle:\n${angle}`;
const research = async (angle) => [
	angle,
	await phase("research", () => agent(`Research the assigned angle. Keep the work within that angle and use the original question only to resolve context. Cite every material claim with a source URL and flag uncertainty.\n\n${contextFor(angle)}`, { agentType: "researcher", label: angle.slice(0, 24), profile: "research" })),
];

const verifyFinding = async (reviewed) => {
	const [angle, finding] = reviewed;
	const reviewSubject = `${contextFor(angle)}\n\nFinding:\n${finding.content}`;
	const verdict = await phase("verify", () => verify(reviewSubject, "Every material claim has a credible source URL and uncertainty is explicit. Treat source support as the primary gate; reject for relevance only when the finding is clearly off-topic or about a different subject.", { label: angle.slice(0, 24), profile: "none" }));
	return [angle, finding, verdict];
};

const checked = (await pipeline(angles, research, verifyFinding)).filter((row) => row !== null);
const trusted = checked.filter(([, , verdict]) => verdict.passed).map(([, finding]) => finding);
const fallback = checked.map(([, finding]) => finding);

const sources = (trusted.length ? trusted : fallback).map((r) => (typeof r === "string" ? r : r.content)).join("\n\n");
const report = await agent(`Answer the question with only sourced claims. Question: ${question}\n\n${sources}`, { label: "report", profile: "none" });
return report.content;
