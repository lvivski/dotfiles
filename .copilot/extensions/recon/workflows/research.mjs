import { arrayOf, isList, nullable, readString, recordOf } from "../data.mjs";
import { analysisInputDigest } from "../digest.mjs";
import { UNTRUSTED_DATA_WARNING, safeJson, untrustedBlock } from "../prompt.mjs";
import { researchWithTimeReview } from "../research/budget.mjs";
import { STATUSES, isRecord, readFinding, readReview, text } from "../research/evidence.mjs";
import { markdown, reviewNotes, sourceNotes } from "../research/report.mjs";

/** @typedef {import("../research/evidence.mjs").ResearchRow} ResearchRow */
/** @typedef {Pick<import("@github/copilot-sdk").WorkflowContext, "args" | "phase" | "agent" | "pipeline" | "step" | "log" | "pause" | "runId" | "signal">
 * & {session: {workflow: Pick<import("@github/copilot-sdk").SessionWorkflowApi, "getRunDetail">}}} ResearchWorkflow */
/** @typedef {{angle: string, text: string, feedback?: string}} SavedDraft */

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

/** @type {import("@github/copilot-sdk").WorkflowMeta} */
export const meta = {
	name: "deep-research",
	description:
		"Heavy, multi-angle web research with independent claim verification, progress-governed corrections, and retained partial evidence. " +
		"Only for explicit deep-research requests or user-approved heavy escalation; use ordinary search for routine questions. " +
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
};

/** @param {ResearchWorkflow} workflow */
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
	if (recovering && (!isList(options.drafts) || !options.drafts.length)) {
		throw new Error("deep-research: drafts must be a non-empty array");
	}
	const rawDrafts = isList(options.drafts) ? options.drafts : [];
	/** @type {SavedDraft[]} */
	const drafts = [];
	for (const draft of rawDrafts) {
		if (!isRecord(draft) || !text(draft.angle) || !text(draft.text) ||
			(draft.feedback !== undefined && typeof draft.feedback !== "string")) {
			throw new Error("deep-research: each saved draft requires an angle, text, and optional string feedback");
		}
		drafts.push({ angle: text(draft.angle), text: text(draft.text), ...(draft.feedback === undefined ? {} : { feedback: draft.feedback }) });
	}
	const requestedAngles = recovering ? drafts.length : options.angles;
	if (requestedAngles !== undefined && (typeof requestedAngles !== "number" || !Number.isSafeInteger(requestedAngles) || requestedAngles < 1)) {
		throw new Error("deep-research: angles must be a positive integer");
	}
	const maxAngles = requestedAngles;
	const boundaries = "";

	return researchWithTimeReview(workflow, () => research(workflow, {
		question, recovering, drafts, maxAngles, boundaries, pauseBeforeWork: options.pauseBeforeWork === true,
	}));
}

/** @param {ResearchWorkflow} workflow @param {{question: string, recovering: boolean, drafts: SavedDraft[], maxAngles?: number, boundaries: string, pauseBeforeWork?: boolean}} options */
async function research(workflow, { question, recovering, drafts, maxAngles, boundaries, pauseBeforeWork }) {
	workflow.phase("Plan");
	const planned = recovering ? drafts.map((draft) => draft.angle) : await workflow.agent(
		`Break this research question into ${maxAngles === undefined ? "the substantively useful" : maxAngles} independent, non-overlapping angles.

Question: ${question}`,
		{ label: "plan", schema: { type: "array", items: { type: "string" } } },
	);
	if (!isList(planned)) {
		return "# Research incomplete\n\nPlanning failed. No research was performed.";
	}
	const prepared = arrayOf(recordOf({ angle: readString, draft: nullable(readString), feedback: readString }))(await workflow.step("deep-research:prepared-angles:v2", () => {
		const seen = new Set();
		const angles = planned.map(text).filter(Boolean).filter((angle) => {
			const key = angle.trim().replace(/\s+/g, " ").toLowerCase();
			if (!recovering && seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		if (maxAngles !== undefined && angles.length > maxAngles) {
			workflow.log(`deep-research: omitted planner angles beyond the requested count ${maxAngles}: ${safeJson(angles.slice(maxAngles), 0)}`);
		}
		return (maxAngles === undefined ? angles : angles.slice(0, maxAngles)).map((angle, index) => ({
			angle,
			draft: recovering ? text(drafts[index].text) : null,
			feedback: recovering ? text(drafts[index].feedback) : "",
		}));
	}));
	if (!prepared.length) {
		return "# Research incomplete\n\nThe planner returned no usable research angles.";
	}
	workflow.log(`deep-research: ${prepared.length} angle(s)${recovering ? " from saved drafts" : ""}.${boundaries}`);
	if (pauseBeforeWork) {
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
		corrections: [],
	}));
	/** @param {string} stage @param {ResearchRow} row */
	const label = (stage, row) => `${stage}:${row.index + 1}:${row.angle.slice(0, 32)}`;

	/** @param {ResearchRow} row @param {import("../research/evidence.mjs").Finding[]} unresolved @param {string} [effect] */
	async function propose(row, unresolved, effect = "") {
		workflow.signal.throwIfAborted();
		row.correctionAttempted = true;
		row.correction = text(await workflow.agent(
			`Propose targeted corrections for only these unresolved findings. Use the verifier's specific reasons and source evidence to fix claims or find accessible supporting sources. Preserve each finding ID and its subject; do not add unrelated findings, repeat the broad research, or change already supported findings.
For every supplied ID, give the corrected atomic claim and source evidence, or explicitly explain why it remains unresolved. Do not claim that your own correction is independently verified. Further work requires independently evidenced resolution of an unresolved finding without losing established evidence; cosmetic changes or new diagnostics alone are not progress. Normal native permission and resource budgets apply to every admission.

Question:
${question}

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("RESEARCH-ANGLE", row.angle)}
${untrustedBlock("UNRESOLVED-FINDINGS", unresolved)}`,
			{ agent: "research", label: label("correct-findings", row) + effect },
		)) || null;
		if (row.correction === null) {
			row.failures.push("Targeted correction failed; initial findings and rejection reasons are retained.");
			row.corrections?.push(safeJson({ before: row.findings, proposal: null, review: null }));
		}
	}

	workflow.phase("Research");
	let reviewedCorrections = 0;
	const checked = await workflow.pipeline(
		rows,
		async (_row, _original, index) => {
			const row = rows[index];
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
		async (_row, _original, index) => {
			const row = rows[index];
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
		async (_row, _original, index) => {
			const row = rows[index];
			const unresolved = row.findings.filter((finding) => finding.status !== "supported");
			if (!unresolved.length) return row;
			await propose(row, unresolved);
			return row;
		},
		async (_row, _original, index) => {
			const row = rows[index];
			let effect = "";
			while (row.correction !== null) {
				workflow.signal.throwIfAborted();
				const before = structuredClone(row.findings);
				const unresolved = before.filter((finding) => finding.status !== "supported");
				const limitations = row.limitations.length;
				const review = await workflow.agent(
					`Independently reverify the proposed corrections. Return exactly one finding for each supplied ID, preserving the ID and subject. Do not emit findings for already supported claims or new subjects. Assess the corrected claim itself, not the fact that a correction was attempted. If no adequate correction is provided, retain the original claim and its unresolved status. A supported result must resolve that same substantive issue under the original question and evidence policy; renaming or weakening the subject is not resolution.
${EVIDENCE_POLICY}

Question:
${question}

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("RESEARCH-ANGLE", row.angle)}
${untrustedBlock("UNRESOLVED-FINDINGS", unresolved)}
${untrustedBlock("PROPOSED-CORRECTIONS", row.correction)}`,
					{ label: label("reverify-findings", row) + effect, schema: REVISION_SCHEMA },
				);
				row.corrections?.push(safeJson({ before, proposal: row.correction, review }));
				const revisions = readReview(review, row, "Correction verification");
				if (revisions === null) return row;
				reviewedCorrections++;
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
					revised.history = [...original.history, `${original.status}: ${original.reasons}`];
					row.findings[row.findings.findIndex(finding => finding.id === original.id)] = revised;
				}
				const pending = row.findings.filter(finding => finding.status !== "supported");
				if (!pending.length) return row;
				const resolved = unresolved.some(original => row.findings.some(finding => finding.id === original.id && finding.status === "supported"));
				// Only independently supported resolutions decrease this frozen set; diagnostics do not.
				if (!resolved || row.limitations.length !== limitations) {
					row.limitations.push("Further correction held: no conserved substantive progress or unresolved review uncertainty.");
					return row;
				}
				effect = `:${analysisInputDigest({ question, angle: row.angle, findings: row.findings })}`;
				await propose(row, pending, effect);
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
		`${reviewedCorrections} independently reviewed targeted correction passes.${boundaries}`;
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
	const ledger = rows.flatMap((row) => row.findings.filter((finding) => finding.status === "supported")
		.map((finding) => `- **${finding.id} (${markdown(row.angle)}):** ${markdown(finding.claim)} ` +
			`${markdown(finding.reasons)} Sources: ${sourceNotes(finding)}`)).join("\n");
	const narrative = report || "# Research incomplete\n\nSynthesis failed. The independently verified findings are preserved below without a narrative synthesis.";
	return `${narrative}\n\n## Supported findings ledger\n\n${ledger}\n\n${suffix}`;
}
