// security-review.mjs — deterministic candidate discovery, read-only investigation, verification.
//
//   run_workflow({ name: "security-review", budget: 6000 })                    // local changes
//   run_workflow({ name: "security-review", args: { root: "src/" } })          // subtree
//   run_workflow({ name: "security-review", args: ["src/a.js", "src/b.js"] })  // explicit files
export const meta = {
	name: "security-review",
	description: "Deterministic candidate scan, structured AI investigation, evidence revalidation, and adversarial verification.",
	phases: ["scan", "investigate", "verify", "report"],
};

const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, HIGH_BUG: 3, BUG: 4, LOW: 5 };
const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");

let opts;
if (Array.isArray(context.args)) opts = { files: context.args };
else if (typeof context.args === "string" && context.args.trim()) opts = { root: context.args };
else if (context.args && typeof context.args === "object") opts = { ...context.args };
else opts = {};

function intOption(name, fallback, min, max) {
	const value = Number(opts[name] ?? fallback);
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`security-review: ${name} must be an integer from ${min} to ${max}`);
	return value;
}

const batchSize = intOption("batch_size", 4, 1, 20);
const reviewConcurrency = opts.concurrency == null ? undefined : intOption("concurrency", 6, 1, 32);
const summarize = opts.summarize === undefined ? true : Boolean(opts.summarize);

const scan = await phase("scan", () => host.discover(opts, { cache: false }));
const coverage = () =>
	`Scope: ${scan.source}. Root: \`${scan.root}\`. Files selected: ${scan.selectedCount}. Review records: ${scan.records.length}/${scan.preCapRecords}. Candidate hits: ${scan.candidateCount}/${scan.preCapCandidateCount}.`;

if (!scan.records.length) {
	const boundaries = scan.boundaries.length ? `\n\nCoverage boundaries:\n${scan.boundaries.map((boundary) => `- ${boundary}`).join("\n")}` : "";
	return `# Security review\n\n${coverage()}\n\nNo deterministic candidate records were selected. This is bounded candidate coverage, not proof that the scope is vulnerability-free.${boundaries}`;
}

const batches = [];
for (let index = 0; index < scan.records.length; index += batchSize) batches.push(scan.records.slice(index, index + batchSize));
log(`security-review: ${scan.records.length} record(s) in ${batches.length} batch(es)`);

const FINDINGS_SCHEMA = {
	type: "array",
	items: {
		type: "object",
		properties: {
			severity: { enum: ["CRITICAL", "HIGH", "MEDIUM", "HIGH_BUG", "BUG", "LOW"] },
			confidence: { enum: ["high", "medium", "low"] },
			vulnClass: { type: "string" },
			filePath: { type: "string" },
			line: { type: "integer" },
			title: { type: "string" },
			description: { type: "string" },
			recommendation: { type: "string" },
		},
		required: ["severity", "confidence", "vulnClass", "filePath", "line", "title", "description", "recommendation"],
	},
};

function validateFindings(batch, findings) {
	const errors = [];
	const files = new Set(batch.map((record) => record.filePath));
	if (findings.length > 8) errors.push("return at most 8 findings per batch");
	for (const [index, finding] of findings.entries()) {
		if (!files.has(String(finding.filePath || ""))) errors.push(`finding ${index + 1} references a file outside the batch`);
		const textKeys = ["vulnClass", "title", "description", "recommendation"];
		for (const key of textKeys) {
			const text = String(finding[key] || "").trim();
			if (!text) errors.push(`finding ${index + 1} ${key} must be non-empty`);
			if (text.length > 2000) errors.push(`finding ${index + 1} ${key} exceeds 2000 characters`);
		}
	}
	return errors;
}

function dryRunFinding(batch) {
	const record = batch[0];
	const candidate = record.candidates[0];
	return {
		severity: "HIGH",
		confidence: "high",
		vulnClass: candidate?.vulnClass || "dry-run",
		filePath: record.filePath,
		line: candidate?.line || 1,
		title: "dry-run candidate",
		description: "Synthetic finding used only to estimate verification fan-out.",
		recommendation: "No action; this is a dry-run placeholder.",
	};
}

async function investigate(batch) {
	const result = await phase("investigate", () => agent(
		`Investigate this deterministic batch of security-sensitive source locations. Open the referenced files and confirm exploitability in context. Regex candidates are anchors, not findings. Return only real, actionable vulnerabilities with exact current lines; return [] if none.\n\nBatch:\n${JSON.stringify(batch, null, 2)}`,
		{
			schema: FINDINGS_SCHEMA,
			validate: (findings) => validateFindings(batch, findings),
			label: batch[0]?.filePath || "investigate",
			cwd: scan.root,
			profile: "read-only",
		},
	));
	if (!result.ok) return { ok: false, error: result.error || "investigation failed", batch, findings: [], evidenceRejected: [] };
	const proposed = context.dryRun ? [dryRunFinding(batch)] : result.value;
	const checked = await host.validateFindings({ root: scan.root, records: batch, findings: proposed }, { cache: false });
	return { ok: true, batch, findings: checked.valid, evidenceRejected: checked.rejected };
}

const investigated = await pipeline(batches, investigate, { concurrency: reviewConcurrency });
const investigationFailures = investigated.filter((row) => !row.ok);
const evidenceRejected = investigated.flatMap((row) => row.evidenceRejected || []);
const discovered = investigated.flatMap((row) => row.findings || []);

const bySignature = new Map();
for (const finding of discovered) {
	const signature = `${finding.filePath}:${finding.line}:${finding.vulnClass}:${String(finding.title).trim().toLowerCase()}`;
	const prior = bySignature.get(signature);
	if (!prior || (SEVERITY_ORDER[finding.severity] ?? 99) < (SEVERITY_ORDER[prior.severity] ?? 99)) bySignature.set(signature, finding);
}
const findings = [...bySignature.values()];

const rawVerdicts = await phase("verify", () => pipeline(
	findings,
	async (finding) => ({
		finding,
		verdict: await verify(
			`Finding:\n${JSON.stringify(finding, null, 2)}`,
			`Open \`${finding.filePath}\` at the cited line and inspect the original source. Pass only if this is a real, exploitable security vulnerability with concrete evidence, not a regex false positive or hypothetical concern.`,
			{
				refute: true,
				label: String(finding.title || finding.filePath).slice(0, 24),
				cwd: scan.root,
				profile: "read-only",
			},
		),
	}),
	{ onFailure: "drop" },
));
const verdicts = findings.map((finding, index) => rawVerdicts[index] || { finding, verdict: null });
const verified = verdicts.filter((row) => row.verdict?.ok && row.verdict.passed).map((row) => row.finding);
const rejected = verdicts.filter((row) => row.verdict?.ok && !row.verdict.passed).length;
const unverified = verdicts.filter((row) => !row.verdict?.ok).length;
verified.sort((left, right) => (SEVERITY_ORDER[left.severity] ?? 99) - (SEVERITY_ORDER[right.severity] ?? 99) || left.filePath.localeCompare(right.filePath) || left.line - right.line);

let summaryText = "";
const reportBoundaries = [...scan.boundaries];
if (summarize && (verified.length || (context.dryRun && findings.length))) {
	const summaryLimit = 20;
	const payload = (context.dryRun ? findings : verified).slice(0, summaryLimit).map((finding) => ({
		severity: finding.severity,
		filePath: finding.filePath,
		line: finding.line,
		title: finding.title,
		description: finding.description,
		recommendation: finding.recommendation,
	}));
	if (verified.length > summaryLimit) reportBoundaries.push(`Executive summary covered ${summaryLimit}/${verified.length} verified findings; the table contains all findings.`);
	const summary = await phase("report", () =>
		agent(
			`Write a concise executive summary of only these verified security findings. Do not add findings. Mention the highest-risk themes and what to fix first.\n\n${JSON.stringify(payload, null, 2)}`,
			{ label: "summary", profile: "none" },
		),
	);
	if (summary.ok) summaryText = summary.content;
	else reportBoundaries.push(`Executive summary failed: ${summary.error || "summary agent failed"}.`);
}

const out = ["# Security review", ""];
if (summaryText && !context.dryRun) out.push(summaryText, "");
out.push(coverage(), "");
out.push(
	`Investigation: ${investigated.length - investigationFailures.length}/${batches.length} batch(es) completed; ${investigationFailures.length} failed. Evidence validation rejected ${evidenceRejected.length} finding(s). Verification: ${verified.length} verified, ${rejected} rejected, ${unverified} unverified.`,
	"",
);
if (reportBoundaries.length) out.push("## Coverage boundaries", "", ...reportBoundaries.map((boundary) => `- ${boundary}`), "");

const incomplete = investigationFailures.length > 0 || evidenceRejected.length > 0 || unverified > 0;
if (!verified.length) {
	out.push(
		incomplete
			? "No vulnerability passed verification, but the review was incomplete. Do not interpret this as a clean security result."
			: "No verified security vulnerabilities were found within the deterministic candidate scope.",
	);
} else {
	out.push("| Severity | Confidence | Class | File | Title | Recommendation |", "| --- | --- | --- | --- | --- | --- |");
	for (const finding of verified) {
		out.push(
			`| ${cell(finding.severity)} | ${cell(finding.confidence)} | ${cell(finding.vulnClass)} | ${cell(finding.filePath)}:${finding.line} | ${cell(finding.title)} | ${cell(finding.recommendation)} |`,
		);
	}
}
return out.join("\n");
