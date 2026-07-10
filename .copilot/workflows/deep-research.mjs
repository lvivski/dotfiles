// deep-research.mjs — fan out research across angles, cross-check, synthesize a cited report.
//
//   run_workflow({ name: "deep-research", budget: 3000,
//                  args: "What changed in Python packaging between 2020 and 2024?" })
//   run_workflow({ name: "deep-research", args: { question: "...", angles: 6 } })
//
// Research workers use whatever web-search/fetch tools the agent has, so that stage opts into
// MCP/network explicitly (network access is the point here).
export const meta = {
	name: "deep-research",
	description: "Fan out web research, verify sourced claims, and synthesize a cited report.",
	phases: ["plan", "research", "verify", "report"],
};

// ---- inputs ---------------------------------------------------------------
let question, maxAngles;
if (args && typeof args === "object" && !Array.isArray(args)) {
	question = args.question || args.q;
	maxAngles = Number(args.angles ?? 5);
} else if (typeof args === "string") {
	question = args;
	maxAngles = 5;
} else {
	question = null;
	maxAngles = 5;
}

question = String(question || "").trim();
if (!question) throw new Error("deep-research: provide a non-empty question");
if (!Number.isInteger(maxAngles) || maxAngles < 1) throw new Error("deep-research: angles must be a positive integer");
const requestedAngles = maxAngles;
maxAngles = Math.min(maxAngles, 12);
const angleBoundary = requestedAngles > maxAngles ? `Requested ${requestedAngles} angles; capped at ${maxAngles}.` : "";

// ---- 1) decompose into independent angles ---------------------------------
const noTools = quarantine({ allowAllTools: false });
const sourceTools = quarantine({ denyUrl: [], enableMcp: true });
const plan = await structured(
	`Break the following research question into ${maxAngles} independent sub-questions or angles to investigate.\n\nQuestion: ${question}`,
	{ type: "array", items: { type: "string" } },
	{ label: "plan", phase: "plan", ...noTools },
);
if (!plan.ok) return `# Research incomplete\n\nPlanning failed: ${plan.error || "planner agent failed"}. No research was performed.`;
let angles = dryRun ? Array.from({ length: maxAngles }, (_, index) => `${question} — dry-run angle ${index + 1}`) : plan.value.map((angle) => String(angle).trim()).filter(Boolean);
const seen = new Set();
angles = angles.filter((angle) => {
	const key = angle.toLowerCase().replace(/\s+/g, " ");
	if (seen.has(key)) return false;
	seen.add(key);
	return true;
});
const proposedAngles = angles.length;
angles = angles.slice(0, maxAngles);
if (!angles.length) return "# Research incomplete\n\nThe planner returned no usable research angles. No research was performed.";
log(`deep-research: ${angles.length} angle(s)`);

// ---- 2/3) research each angle, then verify as soon as it returns -----------
const research = async (angle) => [
	angle,
	await agent(
		`Research this question using web search. State concrete findings and cite EVERY claim with a source URL. If evidence is thin or conflicting, say so.\n\nQuestion: ${angle}`,
		{ agentType: "researcher", label: angle.slice(0, 24), phase: "research", ...sourceTools },
	),
];

const verifyFinding = async (reviewed) => {
	const [angle, finding] = reviewed;
	if (!finding.ok) return [angle, finding, null];
	const verdict = await verify(finding, "Open the cited URLs and pass only if every material factual claim is supported by a credible source. Reject inaccessible, mismatched, or circular citations.", {
		refute: true,
		phase: "verify",
		label: angle.slice(0, 24),
		...sourceTools,
	});
	return [angle, finding, verdict];
};

const checked = await pipeline(angles, research, verifyFinding, { errors: "raise" });
const findings = checked.map(([, f]) => f);
const trusted = checked.filter(([, f, v]) => f.ok && v?.ok && v.passed).map(([, f]) => f);
const failed = checked.filter(([, f, v]) => !f.ok || (v && !v.ok)).length;
const rejected = checked.filter(([, f, v]) => f.ok && v?.ok && !v.passed).length;
log(`deep-research: ${trusted.length}/${findings.length} findings survived verification`);
const boundaries = [angleBoundary, proposedAngles > angles.length ? `${proposedAngles - angles.length} planner angle(s) exceeded the cap.` : ""].filter(Boolean);
const coverage = `Coverage: ${angles.length} angle(s) researched; ${trusted.length} source-verified, ${rejected} rejected, ${failed} failed.${boundaries.length ? ` Limits: ${boundaries.join(" ")}` : ""}`;

if (!trusted.length && !dryRun) return `# Research unsupported\n\nNo research angle passed source verification. No unverified findings were synthesized.\n\n_${coverage}_`;

// ---- 4) synthesize a cited report -----------------------------------------
const report = await synthesize(dryRun ? findings : trusted, {
	prompt: `Write a well-structured, cited report that answers the question below using the findings. Keep only well-sourced claims; list any open questions at the end.\n\nQuestion: ${question}`,
	label: "report",
	...noTools,
});
if (!report.ok) return `# Research incomplete\n\nVerified research could not be synthesized: ${report.error || "report agent failed"}\n\n_${coverage}_`;
return `${report.content}\n\n_${coverage}_`;
