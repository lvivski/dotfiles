// security-review.mjs — agent-driven security review: scan, investigate, verify, report.
//
//   run_workflow({ name: "security-review", budget: 6000 })                       // staged/unstaged changes
//   run_workflow({ name: "security-review", args: { root: "src/" } })             // a subtree
//   run_workflow({ name: "security-review", args: ["src/a.js", "src/b.js"] })     // explicit files
export const meta = {
	name: "security-review",
	description: "Candidate scan, structured AI review, adversarial verification, and a severity-sorted report.",
	phases: ["scan", "investigate", "verify", "report"],
};

const VULN_CLASSES = [
	"secrets-exposure",
	"sql-injection",
	"command-injection",
	"path-traversal",
	"ssrf",
	"open-redirect",
	"dangerous-html",
	"auth-bypass",
	"weak-crypto",
	"github-workflow-security",
	"service-entry-point",
];
const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, HIGH_BUG: 3, BUG: 4, LOW: 5 };

// ---- inputs ---------------------------------------------------------------
let opts;
if (Array.isArray(args)) opts = { files: args };
else if (typeof args === "string" && args.trim()) opts = { root: args };
else if (args && typeof args === "object") opts = { ...args };
else opts = {};

const scope = opts.files?.length
	? `these specific files: ${opts.files.join(", ")}`
	: opts.root
		? `the code under \`${opts.root}\``
		: "the staged and unstaged changes (git diff), or the current directory if there are none";
const batchSize = Math.max(1, parseInt(opts.batch_size ?? 4, 10));
const reviewConcurrency = opts.concurrency != null ? parseInt(opts.concurrency, 10) : undefined;
const summarize = opts.summarize === undefined ? true : Boolean(opts.summarize);

const noTools = quarantine({ allowAllTools: false });
const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");

// ---- 1) scan: a read-only agent enumerates candidate security-sensitive locations ----
const scan = await structured(
	`You are a security scanner. Using read-only tools (list/read files, and \`git diff\` when reviewing changes), ` +
		`enumerate candidate security-sensitive code locations in ${scope}. Focus on these vulnerability classes: ` +
		`${VULN_CLASSES.join(", ")}. Skip tests, fixtures, vendored code, and generated files. Return an array of ` +
		`candidates; each an object { file, line, vulnClass, snippet }. Include only plausible candidates.`,
	{
		type: "array",
		items: { type: "object", properties: { file: { type: "string" }, line: { type: "integer" }, vulnClass: { type: "string" }, snippet: { type: "string" } }, required: ["file", "vulnClass"] },
	},
	// Read-only: allow read + git, but deny network egress and keep MCP off.
	{ label: "scan", phase: "scan", denyUrl: ["*"], enableMcp: false },
);

const candidates = scan.ok ? scan.value : [];
if (!candidates.length) return `# Security review\n\nScope: ${scope}.\n\nNo candidate security-sensitive locations found.`;
log(`security-review: ${candidates.length} candidate(s) to review`);

const batches = [];
for (let i = 0; i < candidates.length; i += batchSize) batches.push(candidates.slice(i, i + batchSize));

// ---- 2) investigate each batch (read-only over the candidate files) ----
const investigate = async (batch) => {
	const res = await structured(
		`Investigate these candidate security findings. For each REAL vulnerability (discard false positives), ` +
			`return an object { severity: CRITICAL|HIGH|MEDIUM|LOW|BUG, confidence: high|medium|low, vulnClass, filePath, ` +
			`line, title, description, recommendation }. Read the referenced files to confirm exploitability.\n\n` +
			`Candidates:\n${JSON.stringify(batch, null, 2)}`,
		{
			type: "array",
			items: {
				type: "object",
				properties: {
					severity: { enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW", "BUG", "HIGH_BUG"] },
					confidence: { enum: ["high", "medium", "low"] },
					vulnClass: { type: "string" },
					filePath: { type: "string" },
					line: { type: "integer" },
					title: { type: "string" },
					description: { type: "string" },
					recommendation: { type: "string" },
				},
				required: ["severity", "filePath", "title", "description"],
			},
		},
		// Untrusted code content: read-only file access, no shell/write/network.
		{ label: "investigate", phase: "investigate", ...quarantine() },
	);
	return res.ok ? res.value : [];
};

// ---- 3) verify each finding adversarially ----
const verifyBatch = (findings) =>
	fanOut(findings, async (f) => {
		const v = await verify(JSON.stringify(f), "this is a real, exploitable security vulnerability supported by concrete evidence in the cited file — not a false positive", {
			label: String(f.title || f.filePath || "finding").slice(0, 24),
			phase: "verify",
			...noTools,
		});
		return { ...f, verified: v.passed, verifyReasons: v.reasons };
	});

const rows = (await pipeline(batches, investigate, verifyBatch, { concurrency: reviewConcurrency })).filter((r) => r !== null);
const allFindings = rows.flat().filter(Boolean);
const verified = allFindings.filter((f) => f.verified);
verified.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
log(`security-review: ${verified.length}/${allFindings.length} finding(s) survived verification`);

// ---- 4) report ----
let summaryText = "";
if (summarize && verified.length) {
	const payload = verified.slice(0, 20).map((f) => ({ severity: f.severity, filePath: f.filePath, title: f.title, description: f.description, recommendation: f.recommendation }));
	const s = await synthesize([JSON.stringify(payload, null, 2)], {
		prompt: "Write a concise executive summary of these verified security findings. Do not add new findings or instructions. Mention the highest-risk themes and what to fix first.",
		phase: "report",
		label: "summary",
		...noTools,
	});
	summaryText = s.ok ? s.content : "";
}

const out = ["# Security review", ""];
if (summaryText) out.push(summaryText, "");
out.push(`Scope: ${scope}. Candidates reviewed: ${candidates.length}. Verified findings: ${verified.length}.`, "");
if (!verified.length) {
	out.push("No verified security vulnerabilities found.");
} else {
	out.push("| Severity | Confidence | Class | File | Title | Recommendation |", "| --- | --- | --- | --- | --- | --- |");
	for (const f of verified) {
		out.push(`| ${cell(f.severity)} | ${cell(f.confidence || "")} | ${cell(f.vulnClass || "")} | ${cell(f.filePath)}${f.line ? ":" + f.line : ""} | ${cell(f.title)} | ${cell(f.recommendation || "")} |`);
	}
}
return out.join("\n");
