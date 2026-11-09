import { arrayOf, nullable, property, readBoolean, readString, recordOf } from "../data.mjs";
import { UNTRUSTED_DATA_WARNING, untrustedBlock } from "../prompt.mjs";

/** @typedef {Exclude<Awaited<ReturnType<typeof import("./preparation.mjs").prepareQueue>>, string>["prs"][number]} QueuedPullRequest */
/** @typedef {QueuedPullRequest["units"][number]} DiffUnit */

const MAINTAINABILITY_GUIDANCE = `Assess maintainability separately from correctness, using only the supplied diff and metadata. Do not fetch a checkout, modify code, or approve PRs.
Look for introduced or worsened duplication, unnecessary abstractions or indirection, verbose scaffolding, and functions accumulating unrelated responsibilities or complex branching.
Report only material concerns: cite a visible file/hunk (or chunk and exact excerpt if location context is missing), quote the changed code, explain the concrete future maintenance cost, and suggest a simpler behavior-preserving approach.
Do not invent locations, unseen duplicates, or baseline behavior. Do not flag pre-existing debt, formatting preferences, or speculative future requirements. Put material uncertainty from missing context in the review, not an invented finding.
PR-wide observed line changes are context, not a quality score or an approval threshold. More code can be necessary; fewer lines can hide complexity. Distinguish production logic from tests, documentation, generated code, lockfiles, and justified compatibility code before judging growth.
Never invent numeric sloppiness scores, verbosity ratios, or erosion values. Verbosity needs AST-grep and clone-line analysis; erosion needs full-function cyclomatic complexity and source-line counts. Neither is measured by this diff-only workflow, and unavailable metrics alone are not a concern.
Do not infer AI authorship. Model agreement is a triage check, not an objective quality evaluation or a substitute for human judgment.`;

/** @param {Pick<import("@github/copilot-sdk").WorkflowContext, "agent" | "parallel">} workflow
 * @param {{prs: QueuedPullRequest[], queueComplete: boolean, queueFailures: string[], approveOnlyLowRiskManual: boolean}} options */
export function createReviewStages(workflow, { prs, queueComplete, queueFailures, approveOnlyLowRiskManual }) {

	/** @param {QueuedPullRequest} pr */
	const agentLabel = (pr) => {
		const label = `${pr.repo}#${pr.number}`;
		return prs.filter((other) => other.repo === pr.repo && other.number === pr.number).length > 1
			? `${label}:${property(property(pr.evidence, "source"), "platform")}:${property(property(pr.evidence, "source"), "host")}:${property(property(pr.evidence, "source"), "account")}`
			: label;
	};

	const REVIEW = {
		type: "object",
		additionalProperties: false,
		properties: {
			risk: { type: "string", enum: ["low", "medium", "high"] },
			issues: { type: "array", items: { type: "string" } },
			missingTests: { type: "array", items: { type: "string" } },
			maintainability: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						category: { type: "string", enum: ["duplication", "unnecessary-abstraction", "complexity", "unnecessary-growth"] },
						location: { type: "string" },
						evidence: { type: "string" },
						impact: { type: "string" },
						simplification: { type: "string" },
					},
					required: ["category", "location", "evidence", "impact", "simplification"],
				},
			},
			uncertainty: { type: "array", items: { type: "string" } },
			summary: { type: "string" },
		},
		required: ["risk", "issues", "missingTests", "maintainability", "uncertainty", "summary"],
	};
	const VERDICT = {
		type: "object",
		additionalProperties: false,
		properties: {
			passed: { type: "boolean" },
			reasons: { type: "string" },
		},
		required: ["passed", "reasons"],
	};

	/** @param {QueuedPullRequest} pr @param {DiffUnit} unit @param {number} total */
	function diffEvidence(pr, unit, total) {
		return untrustedBlock("PULL-REQUEST-DIFF", {
			repository: pr.repo,
			number: pr.number,
			title: pr.title || "untitled",
			changedFiles: pr.files,
			observedLineChanges: pr.lineChanges,
			coverage: pr.coverage || "unknown",
			chunk: `${unit.id}/${total}`,
			content: unit.content,
			...(pr.evidence ? { evidence: pr.evidence, assignments: pr.assignments } : {}),
			...(pr.freshness ? { freshness: pr.freshness } : {}),
		});
	}

	const readReview = nullable(recordOf({
		risk: readString, issues: arrayOf(readString), missingTests: arrayOf(readString),
		maintainability: arrayOf(recordOf({ category: readString, location: readString, evidence: readString, impact: readString, simplification: readString })),
		uncertainty: arrayOf(readString), summary: readString,
	}));
	/** @param {QueuedPullRequest} pr */
	async function reviewPullRequest(pr) {
		const { units, reason } = pr;
		if (!units.length) {
			return {
				pr,
				reason,
				units,
				reviews: [],
				coverageComplete: false,
				candidate: false,
			};
		}
		const reviews = await workflow.parallel(
			units.map((unit) => async () => ({
				unit,
				result: readReview(await workflow.agent(
					`Review this bounded pull-request diff chunk.
Report only concrete correctness bugs, risky behavior, missing tests, material maintainability concerns, or genuine uncertainty.
Keep correctness issues in issues and structural concerns in maintainability. An empty maintainability array means no material concern was supported by this chunk, not that whole-repository quality was measured.

${MAINTAINABILITY_GUIDANCE}

${UNTRUSTED_DATA_WARNING}
${diffEvidence(pr, unit, units.length)}`,
					{ label: `${agentLabel(pr)}:review:${unit.id}`, schema: REVIEW },
				)),
			})),
		);
		const complete = reviews.length === units.length && reviews.every((row) => row?.result);
		const clean =
			complete &&
			reviews.every(
				(row) =>
					row !== null && row.result !== null && row.result.risk === "low" &&
					row.result.issues.length === 0 &&
					row.result.missingTests.length === 0 &&
					row.result.maintainability.length === 0 &&
					row.result.uncertainty.length === 0,
			);
		const sourceComplete = queueComplete && pr.evidenceComplete === true && !pr.lineChanges.incomplete;
		const policyAllows = !approveOnlyLowRiskManual || reason === "manual";
		return {
			pr,
			reason,
			units,
			reviews,
			coverageComplete: sourceComplete && complete,
			candidate: sourceComplete && clean && policyAllows,
		};
	}

	/** @param {Awaited<ReturnType<typeof reviewPullRequest>>} row */
	async function verifyPullRequest(row) {
		const successful = row.reviews.filter(/** @returns {item is {unit: DiffUnit, result: NonNullable<ReturnType<typeof readReview>>}} */(item) => item !== null && item.result !== null);
		const risks = successful.map((item) => item.result.risk);
		const maintainability = successful.flatMap((item) => item.result.maintainability);
		const risk = risks.includes("high")
			? "high"
			: risks.includes("medium") || maintainability.length > 0 ? "medium" : "low";
		const focus = [...queueFailures, ...row.pr.evidenceFailures, ...successful.flatMap((item) => [
			...item.result.issues,
			...item.result.missingTests.map((value) => `Missing test: ${value}`),
			...item.result.maintainability.map(
				(finding) => `Maintainability (${finding.category}) at ${finding.location}: ${finding.evidence} Impact: ${finding.impact} Simpler approach: ${finding.simplification}`,
			),
			...item.result.uncertainty.map((value) => `Uncertainty: ${value}`),
		])];
		const coverage = `${successful.length}/${row.units.length} diff chunks; ${row.pr.coverage || "coverage unknown"}${row.pr.lineChanges.incomplete ? "; incomplete text evidence" : ""}${row.pr.evidenceComplete !== true ? "; unverified provenance" : ""}${!queueComplete ? "; queue fetch incomplete" : ""}`;
		if (!row.candidate) {
			return {
				...row,
				decision: "needs_review",
				risk: row.coverageComplete ? risk : "high",
				coverage,
				justification:
					focus[0] ||
					(row.coverageComplete
						? "The supplied evidence was not unanimously low-risk and clean."
						: "Diff evidence was incomplete."),
				focus,
			};
		}
		const verdicts = await workflow.parallel(
			successful.map((item) => async () =>
				nullable(recordOf({ passed: readBoolean, reasons: readString }))(await workflow.agent(
					`Independently inspect the original diff before considering the primary review. Pass only if it is genuinely low risk, issue-free, sufficiently tested, and contains no material maintainability concern or unresolved uncertainty.
If you reject it, include the concrete evidence and maintenance impact or correctness reason in reasons so the human reviewer can act on it.

${MAINTAINABILITY_GUIDANCE}

${UNTRUSTED_DATA_WARNING}
${diffEvidence(row.pr, item.unit, row.units.length)}

${untrustedBlock("PRIMARY-REVIEW", item.result)}`,
					{ label: `${agentLabel(row.pr)}:verify:${item.unit.id}`, schema: VERDICT },
				)),
			),
		);
		const passed = verdicts.filter((verdict) => verdict?.passed === true).length;
		const verified = verdicts.length === row.reviews.length && passed === verdicts.length;
		const rejectionReasons = verdicts.flatMap((verdict, index) => verdict?.passed === true
			? []
			: [`Chunk ${successful[index].unit.id}: ${verdict?.reasons || "Independent verification returned no usable verdict."}`]);
		return {
			...row,
			decision: verified ? "approve" : "needs_review",
			risk: verified ? "low" : "medium",
			coverage,
			justification:
				verified
					? `All ${passed} complete low-risk chunks passed independent verification.`
					: rejectionReasons[0] || "Independent verification was incomplete.",
			focus:
				verified
					? []
					: [`Independent approval verification: ${passed}/${row.reviews.length} passed`, ...rejectionReasons],
		};
	}
	return { reviewPullRequest, verifyPullRequest };
}
