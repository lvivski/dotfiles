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
	maxAngles = parseInt(args.angles ?? 5, 10);
} else if (typeof args === "string") {
	question = args;
	maxAngles = 5;
} else {
	question = null;
	maxAngles = 5;
}

if (!question) {
	question = "What are the most important changes in HTTP/3 adoption since 2022?";
	log("deep-research: no question supplied via args; using a sample question.");
}

// ---- 1) decompose into independent angles ---------------------------------
const plan = await structured(
	`Break the following research question into ${maxAngles} independent sub-questions or angles to investigate.\n\nQuestion: ${question}`,
	{ type: "array", items: { type: "string" } },
	{ label: "plan" },
);
let angles = plan.ok ? plan.value.map((a) => String(a).trim()).filter(Boolean) : [];
if (!angles.length) angles = [question];
log(`deep-research: ${angles.length} angle(s)`);
const noTools = quarantine({ allowAllTools: false });

// ---- 2/3) research each angle, then verify as soon as it returns -----------
const research = async (angle) => [
	angle,
	await agent(
		`Research this question using web search. State concrete findings and cite EVERY claim with a source URL. If evidence is thin or conflicting, say so.\n\nQuestion: ${angle}`,
		// Reads untrusted web content -> deny shell/write to contain prompt injection, but keep
		// network + MCP (web access is the whole point of this step).
		{ agentType: "researcher", label: angle.slice(0, 24), phase: "research", ...quarantine({ denyUrl: [], enableMcp: true }) },
	),
];

const verifyFinding = async (reviewed) => {
	const [angle, finding] = reviewed;
	const verdict = await verify(finding, "every factual claim is supported by a cited, credible source URL", {
		refute: true,
		phase: "verify",
		label: angle.slice(0, 24),
		...noTools,
	});
	return [angle, finding, verdict];
};

const checked = (await pipeline(angles, research, verifyFinding)).filter((row) => row !== null);
const findings = checked.map(([, f]) => f);
const trusted = checked.filter(([, , v]) => v.passed).map(([, f]) => f);
log(`deep-research: ${trusted.length}/${findings.length} findings survived verification`);

// ---- 4) synthesize a cited report -----------------------------------------
const report = await synthesize(trusted.length ? trusted : findings, {
	prompt: `Write a well-structured, cited report that answers the question below using the findings. Keep only well-sourced claims; list any open questions at the end.\n\nQuestion: ${question}`,
	label: "report",
	...noTools,
});
return report.content;
