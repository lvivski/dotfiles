// deep-research.cwf.mjs — decompose a question into angles, research + verify each, synthesize.
export const meta = { name: "deep-research", description: "Fan out web research over angles, verify sourced claims, synthesize a cited answer." };

const question = typeof args === "string" ? args : "What changed in this topic recently?";
const noTools = quarantine({ allowAllTools: false });

const plan = await structured(`Break this research question into 4 independent angles:\n\n${question}`, { type: "array", items: { type: "string" } }, { label: "plan", ...noTools });
let angles = plan.ok ? plan.value.map((angle) => String(angle).trim()).filter(Boolean) : [];
if (!angles.length) angles = [question];

const research = async (angle) => [
	angle,
	await agent(`Research this angle. Cite every factual claim with a source URL and flag uncertainty.\n\nAngle: ${angle}`, { agentType: "researcher", phase: "research", label: angle.slice(0, 24), ...quarantine({ denyUrl: [], enableMcp: true }) }),
];

const verifyFinding = async (reviewed) => {
	const [angle, finding] = reviewed;
	const verdict = await verify(finding, "every factual claim has a credible source URL and uncertainty is explicit", { phase: "verify", label: angle.slice(0, 24), ...noTools });
	return [angle, finding, verdict];
};

const checked = (await pipeline(angles, research, verifyFinding)).filter((row) => row !== null);
const trusted = checked.filter(([, , verdict]) => verdict.passed).map(([, finding]) => finding);
const fallback = checked.map(([, finding]) => finding);

const report = await synthesize(trusted.length ? trusted : fallback, { prompt: `Answer the question with only sourced claims. Question: ${question}`, label: "report", ...noTools });
return report.content;
