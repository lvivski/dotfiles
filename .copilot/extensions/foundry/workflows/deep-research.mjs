// Verify atomic findings, repair unresolved claims once, and preserve partial evidence.
import {
	UNTRUSTED_DATA_WARNING,
	safeJson,
	untrustedBlock,
} from "../prompts.mjs";
const DRAFTS_SCHEMA = {
	type: "array",
	items: {
		type: "object",
		required: ["angle", "text"],
		properties: {
			angle: { type: "string" },
			text: { type: "string" },
			feedback: { type: "string" },
		},
	},
};
const RESEARCH_OPTIONS_SCHEMA = {
	type: "object",
	required: ["question"],
	properties: {
		question: { type: "string" },
		angles: { type: "integer" },
		drafts: DRAFTS_SCHEMA,
		pauseBeforeWork: { type: "boolean" },
	},
};
// Schema correction reuses its agent; independent correction and verification do not.
const MAX_FIXED_SUBAGENTS = 2;
const MAX_SUBAGENTS_PER_ANGLE = 4;
const MAX_SUBAGENTS_PER_DRAFT = 3;
const STATUSES = ["supported", "incorrect", "inaccessible", "insufficient"];
const FINDING_PROPERTIES = {
	claim: { type: "string" },
	status: { type: "string", enum: STATUSES },
	reasons: { type: "string" },
	sources: {
		type: "array",
		items: {
			type: "object",
			additionalProperties: false,
			required: ["url", "evidence"],
			properties: {
				url: { type: "string" },
				evidence: { type: "string" },
			},
		},
	},
};
const REVIEW_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["findings", "limitations"],
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: Object.keys(FINDING_PROPERTIES),
				properties: FINDING_PROPERTIES,
			},
		},
		limitations: { type: "array", items: { type: "string" } },
	},
};
const REVISION_SCHEMA = {
	...REVIEW_SCHEMA,
	properties: {
		...REVIEW_SCHEMA.properties,
		findings: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", ...Object.keys(FINDING_PROPERTIES)],
				properties: { id: { type: "string" }, ...FINDING_PROPERTIES },
			},
		},
	},
};
const EVIDENCE_POLICY = `Use one finding per independently checkable claim; split compound claims so a wrong detail does not discard unrelated supported facts. Preserve important rejected and uncertain claims rather than silently dropping them.
Use supported only for the exact, qualified claim established by sources you independently opened. Supply the supporting URLs and a brief evidence description or locator, not just a homepage or an assertion of verification.
Use incorrect for a claim contradicted by evidence, inaccessible when necessary sources could not be accessed, and insufficient when accessible evidence does not establish the claim. Inaccessibility is not evidence of falsehood. Seek a credible alternative source where practical; never bypass access restrictions.
Separate source identity from what its contents prove. Do not infer missing coverage from an incomplete baseline, claim an entire work was checked from a synopsis, or add conclusions beyond the evidence. Record unresolved scope and access limitations explicitly.`;

/**
 * @typedef {{url: string, evidence: string}} Source
 * @typedef {{id: string, claim: string, status: string, reasons: string,
 *   sources: Source[], history: string[]}} Finding
 * @typedef {{index: number, angle: string, draft: string | null, feedback: string,
 *   findings: Finding[], limitations: string[], failures: string[],
 *   correction: string | null, correctionAttempted: boolean}} ResearchRow
 */

/** @type {import("@github/copilot-sdk").WorkflowMeta & {limits: Required<import("@github/copilot-sdk").WorkflowLimits>}} */
export const meta = {
	name: "deep-research",
	description:
		"Research and verify individual claims, correct unresolved findings once, and report partial evidence. " +
		"Args: { question: string, angles?: number, drafts?: { angle: string, text: string, feedback?: string }[], pauseBeforeWork?: boolean } or a question string. Use drafts instead of angles to recover saved research.",
	phases: [{ title: "Plan" }, { title: "Research" }, { title: "Report" }],
	argsSchema: {
		anyOf: [
			{ type: "string" },
			RESEARCH_OPTIONS_SCHEMA,
			{
				type: "object",
				required: ["q"],
				properties: {
					q: { type: "string" },
					angles: { type: "integer" },
					drafts: DRAFTS_SCHEMA,
					pauseBeforeWork: { type: "boolean" },
				},
			},
		],
	},
	limits: {
		maxConcurrentSubagents: 2,
		maxTotalSubagents: 40,
		timeoutSeconds: 3600,
		maxAiCredits: 10000,
	},
};

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value */
function text(value) {
	return typeof value === "string" ? value.trim() : "";
}

/** @param {unknown} value @returns {Source[] | null} */
function readSources(value) {
	if (!Array.isArray(value)) return null;
	const sources = [];
	for (const item of value) {
		if (!isRecord(item) || !text(item.url) || !text(item.evidence)) return null;
		let url;
		try {
			url = new URL(text(item.url));
		} catch (error) {
			if (error instanceof TypeError) return null;
			throw error;
		}
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
			return null;
		}
		sources.push({ url: url.href, evidence: text(item.evidence) });
	}
	return sources;
}

/** @param {unknown} value @param {string} id @param {string} [fallbackClaim] @returns {Finding} */
function readFinding(value, id, fallbackClaim = "Unspecified claim") {
	const record = isRecord(value) ? value : {};
	const claim = text(record.claim);
	const reasons = text(record.reasons);
	const status = text(record.status);
	const sources = readSources(record.sources);
	const malformed = !claim || !reasons || !STATUSES.includes(status) || sources === null;
	const unsupportedPass = status === "supported" && !sources?.length;
	return {
		id,
		claim: claim || fallbackClaim,
		status: malformed || unsupportedPass ? "insufficient" : status,
		reasons: malformed
			? `Malformed finding or source evidence; not accepted. ${reasons}`.trim()
			: unsupportedPass
				? `Supported verdict lacked source evidence; not accepted. ${reasons}`
				: reasons,
		sources: sources ?? [],
		history: [],
	};
}

/** @param {unknown} value @param {ResearchRow} row @param {string} stage */
function readReview(value, row, stage) {
	if (!isRecord(value) || !Array.isArray(value.findings)) {
		row.failures.push(`${stage} returned no usable review; earlier verified findings are retained.`);
		return null;
	}
	if (!Array.isArray(value.limitations) || !value.limitations.every((item) => text(item))) {
		row.limitations.push(`${stage} supplied incomplete limitation notes; its findings are assessed individually.`);
	}
	if (Array.isArray(value.limitations)) {
		row.limitations.push(...value.limitations.map((item) => text(item)).filter(Boolean));
	}
	return value.findings;
}

/** @param {string} value */
function markdown(value) {
	return value.replace(/\\/g, "\\\\")
		.replace(/([`*_[\]<>()#!|])/g, "\\$1")
		.replace(/\s+/g, " ");
}

/** @param {Finding} finding */
function sourceNotes(finding) {
	return finding.sources.map((source) => `<${source.url}>: ${markdown(source.evidence)}`).join("; ");
}

/** @param {ResearchRow[]} rows */
function reviewNotes(rows) {
	const notes = [];
	for (const row of rows) {
		const entries = [
			...row.failures.map((reason) => `- **Stage failure:** ${markdown(reason)}`),
			...row.limitations.map((reason) => `- **Limitation:** ${markdown(reason)}`),
			...row.findings.filter((finding) => finding.status !== "supported").map((finding) =>
				`- **${finding.id}: ${finding.status} (not accepted)** - ${markdown(finding.claim)}. ` +
				`${markdown(finding.reasons)}${finding.sources.length ? ` Sources checked: ${sourceNotes(finding)}` : ""}`,
			),
			...row.findings.filter((finding) => finding.history.length).map((finding) =>
				`- **Correction ${finding.id}: ${finding.status}.** Initial review: ${markdown(finding.history.join("; "))}`,
			),
		];
		if (entries.length) notes.push(`### ${markdown(row.angle)}\n\n${entries.join("\n")}`);
	}
	return notes.length
		? `## Verification notes and unresolved claims\n\nUnaccepted claims below are diagnostics, not established findings or recommendations.\n\n${notes.join("\n\n")}`
		: "";
}

export async function run(workflow) {
	const input = workflow.args;
	const options = isRecord(input) ? input : {};
	if (options.pauseBeforeWork !== undefined && typeof options.pauseBeforeWork !== "boolean") {
		throw new Error("deep-research: pauseBeforeWork must be a boolean");
	}
	const question = text(typeof input === "string" ? input : options.question || options.q);
	if (!question) throw new Error("deep-research: provide a non-empty question");

	const recovering = options.drafts !== undefined;
	if (recovering && options.angles !== undefined) {
		throw new Error("deep-research: use drafts instead of angles");
	}
	if (recovering && (!Array.isArray(options.drafts) || !options.drafts.length)) {
		throw new Error("deep-research: drafts must be a non-empty array");
	}
	const drafts = Array.isArray(options.drafts) ? options.drafts : [];
	for (const draft of drafts) {
		if (!isRecord(draft) || !text(draft.angle) || !text(draft.text) ||
			(draft.feedback !== undefined && typeof draft.feedback !== "string")) {
			throw new Error("deep-research: each saved draft requires an angle, text, and optional string feedback");
		}
	}
	const requestedAngles = recovering ? drafts.length : options.angles ?? 5;
	if (typeof requestedAngles !== "number" || !Number.isInteger(requestedAngles) || requestedAngles < 1) {
		throw new Error("deep-research: angles must be a positive integer");
	}
	const budgetedAngles = Math.floor(
		(meta.limits.maxTotalSubagents - (recovering ? 1 : MAX_FIXED_SUBAGENTS)) /
			(recovering ? MAX_SUBAGENTS_PER_DRAFT : MAX_SUBAGENTS_PER_ANGLE),
	);
	const maxAngles = Math.min(requestedAngles, 12, budgetedAngles);
	if (recovering && drafts.length > maxAngles) {
		throw new Error(`deep-research: at most ${maxAngles} saved drafts are supported by the angle and correction limits; none were processed`);
	}
	const boundaries = requestedAngles > maxAngles
		? ` Requested ${requestedAngles} angles; capped at ${maxAngles} to reserve independent correction and reverification.`
		: "";

	workflow.phase("Plan");
	const planned = recovering ? drafts.map((draft) => draft.angle) : await workflow.agent(
		`Break this research question into ${maxAngles} independent, non-overlapping angles.

Question: ${question}`,
		{ label: "plan", schema: { type: "array", items: { type: "string" } } },
	);
	if (!Array.isArray(planned)) {
		return "# Research incomplete\n\nPlanning failed. No research was performed.";
	}
	const prepared = await workflow.step("deep-research:prepared-angles:v1", () => {
		const seen = new Set();
		return planned.map(text).filter(Boolean).filter((angle) => {
			const key = angle.toLowerCase().replace(/\s+/g, " ");
			if (!recovering && seen.has(key)) return false;
			seen.add(key);
			return true;
		}).slice(0, maxAngles).map((angle, index) => ({
			angle,
			draft: recovering ? text(drafts[index].text) : null,
			feedback: recovering ? text(drafts[index].feedback) : "",
		}));
	});
	if (!prepared.length) {
		return "# Research incomplete\n\nThe planner returned no usable research angles.";
	}
	workflow.log(`deep-research: ${prepared.length} angle(s)${recovering ? " from saved drafts" : ""}.${boundaries}`);
	if (options.pauseBeforeWork) {
		workflow.log(`deep-research: prepared scope ${safeJson({
			question, angles: prepared.map(({ angle }) => angle), savedDrafts: recovering,
		}, 0)}`);
		await workflow.pause("deep-research:before-research:v1");
	}

	/** @type {ResearchRow[]} */
	const rows = prepared.map((scope, index) => ({
		index, ...scope,
		findings: [], limitations: [], failures: [],
		correction: null, correctionAttempted: false,
	}));
	const label = (stage, row) => `${stage}:${row.index + 1}:${row.angle.slice(0, 32)}`;

	workflow.phase("Research");
	const checked = await workflow.pipeline(
		rows,
		async (row) => {
			if (recovering) return row;
			row.draft = text(await workflow.agent(
				`Research the assigned angle using web search. Cite every material claim with a source URL and flag thin or conflicting evidence. Do not add unsupported claims.

Original question:
${question}

Assigned angle from the planning agent:
${UNTRUSTED_DATA_WARNING}
${untrustedBlock("RESEARCH-ANGLE", row.angle)}`,
				{ agent: "research", label: label("research", row) },
			)) || null;
			if (row.draft === null) row.failures.push("Research returned no usable draft.");
			return row;
		},
		async (row) => {
			if (row.draft === null) return row;
			const review = await workflow.agent(
				`Independently check the draft's material claims and cited sources. Return atomic findings, not one pass/fail verdict for the whole report.
${EVIDENCE_POLICY}

Question:
${question}

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("RESEARCH-ANGLE", row.angle)}
${untrustedBlock("RESEARCH-DRAFT", row.draft)}
${untrustedBlock("PRIOR-FEEDBACK", row.feedback)}`,
				{ label: label("verify-findings", row), schema: REVIEW_SCHEMA },
			);
			const findings = readReview(review, row, "Initial verification");
			if (findings !== null) {
				row.findings = findings.map((finding, index) => readFinding(finding, `${row.index + 1}.${index + 1}`));
				if (!findings.length) row.limitations.push("Verification returned no findings; the draft is not treated as supported.");
			}
			return row;
		},
		async (row) => {
			const unresolved = row.findings.filter((finding) => finding.status !== "supported");
			if (!unresolved.length) return row;
			row.correctionAttempted = true;
			row.correction = text(await workflow.agent(
				`Perform one targeted correction pass on only these unresolved findings. Use the verifier's specific reasons and source evidence to fix claims or find accessible supporting sources. Preserve each finding ID and its subject; do not add unrelated findings, repeat the broad research, or change already supported findings.
For every supplied ID, give the corrected atomic claim and source evidence, or explicitly explain why it remains unresolved. Do not claim that your own correction is independently verified.

Question:
${question}

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("RESEARCH-ANGLE", row.angle)}
${untrustedBlock("UNRESOLVED-FINDINGS", unresolved)}`,
				{ agent: "research", label: label("correct-findings", row) },
			)) || null;
			if (row.correction === null) row.failures.push("Targeted correction failed; initial findings and rejection reasons are retained.");
			return row;
		},
		async (row) => {
			if (row.correction === null) return row;
			const unresolved = row.findings.filter((finding) => finding.status !== "supported");
			const review = await workflow.agent(
				`Independently reverify the proposed corrections. Return exactly one finding for each supplied ID, preserving the ID and subject. Do not emit findings for already supported claims or new subjects. Assess the corrected claim itself, not the fact that a correction was attempted. If no adequate correction is provided, retain the original claim and its unresolved status.
${EVIDENCE_POLICY}

Question:
${question}

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("RESEARCH-ANGLE", row.angle)}
${untrustedBlock("UNRESOLVED-FINDINGS", unresolved)}
${untrustedBlock("PROPOSED-CORRECTIONS", row.correction)}`,
				{ label: label("reverify-findings", row), schema: REVISION_SCHEMA },
			);
			const revisions = readReview(review, row, "Correction verification");
			if (revisions === null) return row;
			const expected = new Set(unresolved.map((finding) => finding.id));
			for (const revision of revisions) {
				if (!isRecord(revision) || !expected.has(text(revision.id))) {
					row.limitations.push("Reverification returned an unknown finding ID; that result was not accepted.");
				}
			}
			for (const original of unresolved) {
				const matches = revisions.filter((revision) => isRecord(revision) && revision.id === original.id);
				if (matches.length !== 1) {
					row.limitations.push(`Finding ${original.id} had ${matches.length} reverified results; its original unresolved verdict is retained.`);
					continue;
				}
				const revised = readFinding(matches[0], original.id, original.claim);
				revised.history = [`${original.status}: ${original.reasons}`];
				row.findings[row.findings.indexOf(original)] = revised;
			}
			return row;
		},
	);
	// Keep completed verification if a later ordinary pipeline stage fails.
	for (const [index, result] of checked.entries()) {
		if (result === null) rows[index].failures.push("An angle pipeline stage failed; previously completed findings are retained.");
	}
	const findings = rows.flatMap((row) => row.findings);
	const trusted = findings.filter((finding) => finding.status === "supported");
	const coverage = `Coverage: ${rows.length} angles ${recovering ? "reused from saved drafts" : "researched"}; ` +
		`${trusted.length} source-verified findings; ` +
		`${findings.filter((finding) => finding.status === "incorrect").length} incorrect, ` +
		`${findings.filter((finding) => finding.status === "inaccessible").length} inaccessible, ` +
		`${findings.filter((finding) => finding.status === "insufficient").length} insufficient; ` +
		`${rows.reduce((count, row) => count + row.failures.length, 0)} failed stages; ` +
		`${rows.filter((row) => row.correctionAttempted).length} targeted correction passes (at most one per angle).${boundaries}`;
	workflow.log(`deep-research: ${coverage}`);
	const notes = reviewNotes(rows);
	const suffix = `${notes ? `${notes}\n\n` : ""}_${coverage}_`;
	if (!trusted.length) {
		const heading = rows.some((row) => row.failures.length) ? "Research incomplete" : "Research unsupported";
		return `# ${heading}\n\nNo source-verified findings are available. Saved drafts and diagnostics are not established evidence.\n\n${suffix}`;
	}

	workflow.phase("Report");
	const verified = rows.flatMap((row) => row.findings.filter((finding) => finding.status === "supported")
		.map(({ id, claim, sources }) => ({ id, angle: row.angle, claim, sources })));
	const report = text(await workflow.agent(
		`Write a cited report answering the question using only these independently verified atomic findings. Preserve their qualifications and use their supplied source URLs. Do not invent facts, citations, or missing coverage. Do not conduct further research. A separate deterministic appendix will report unresolved findings and stage failures; do not claim comprehensive coverage.

Question:
${question}

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("VERIFIED-RESEARCH", verified)}`,
		{ label: "report-findings" },
	));
	if (!report) {
		const preserved = trusted.map((finding) => `- ${markdown(finding.claim)} Sources: ${sourceNotes(finding)}`).join("\n");
		return `# Research incomplete\n\nSynthesis failed. The independently verified findings are preserved below without a narrative synthesis.\n\n${preserved}\n\n${suffix}`;
	}
	return `${report}\n\n${suffix}`;
}
