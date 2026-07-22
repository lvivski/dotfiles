// deep-research.mjs — decompose a question into angles, research + verify each, synthesize.
export const meta = { name: "deep-research", description: "Fan out web research over angles, verify sourced claims, synthesize a cited answer." };

const question = typeof args === "string" ? args : "What changed in this topic recently?";
const noTools = quarantine({ allowAllTools: false });

const plan = await structured(`Break this research question into 4 independent angles:\n\n${question}`, { type: "array", items: { type: "string" } }, { label: "plan", ...noTools });
let angles = plan.ok ? plan.value.map((angle) => String(angle).trim()).filter(Boolean) : [];
if (!angles.length) angles = ["Investigate the original question as a whole."];

const contextFor = (angle) => `Original research question:\n${question}\n\nAssigned angle:\n${angle}`;
const research = async (angle) => [
	angle,
	await agent(`Research the assigned angle. Keep the work within that angle and use the original question only to resolve context. Cite every material claim with a source URL and flag uncertainty.\n\n${contextFor(angle)}`, { agentType: "researcher", phase: "research", label: angle.slice(0, 24), ...quarantine({ denyUrl: [], enableMcp: true }) }),
];

const verifyFinding = async (reviewed) => {
	const [angle, finding] = reviewed;
	const reviewSubject = `${contextFor(angle)}\n\nFinding:\n${finding.content}`;
	const verdict = await verify(reviewSubject, "Every material claim has a credible source URL and uncertainty is explicit. Treat source support as the primary gate; reject for relevance only when the finding is clearly off-topic or about a different subject.", { phase: "verify", label: angle.slice(0, 24), ...noTools });
	return [angle, finding, verdict];
};

const checked = (await pipeline(angles, research, verifyFinding)).filter((row) => row !== null);
const trusted = checked.filter(([, , verdict]) => verdict.passed).map(([, finding]) => finding);
const fallback = checked.map(([, finding]) => finding);

const report = await synthesize(trusted.length ? trusted : fallback, { prompt: `Answer the question with only sourced claims. Question: ${question}`, label: "report", ...noTools });
return report.content;
