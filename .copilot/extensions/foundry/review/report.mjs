import { isOneOf, property } from "../data.mjs";

/** @typedef {Exclude<Awaited<ReturnType<typeof import("./preparation.mjs").prepareQueue>>, string>["prs"][number]} QueuedPullRequest */
/** @typedef {{pr: QueuedPullRequest, reason: string, decision: string, risk: string, coverage: string, justification: string, focus: string[]}} ReviewRow */

/** @param {{rows: ReviewRow[], prs: QueuedPullRequest[], evidenceCount: number, freshness: string}} input */
export function renderQueue({ rows, prs, evidenceCount, freshness }) {

	/** @param {unknown} value */
	const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
	/** @type {Record<string, string>} */
	const labels = { codeowner: "CODEOWNERS", "required-policy": "Required policy", manual: "Manual", unknown: "Unknown" };
	/** @param {string} value */
	const label = (value) => labels[value] || value;
	/** @param {QueuedPullRequest} pr */
	const lineChanges = (pr) => {
		const { additions, deletions, net, incomplete } = pr.lineChanges;
		if (net === null) return "Unavailable (no text hunks)";
		const scope = incomplete || pr.evidenceComplete !== true ? "; partial" : "";
		return `+${additions}/-${deletions}; net ${net > 0 ? "+" : ""}${net}${scope}`;
	};
	/** @param {QueuedPullRequest} pr */
	const freshnessLabel = (pr) => {
		if (pr.platform !== "azure") return pr.updatedAt.slice(0, 10) || "Unknown";
		const source = property(pr.freshness, "source");
		const timestamp = property(pr.freshness, "timestamp");
		if (typeof timestamp !== "string" || !timestamp
			|| !isOneOf(source, ["iteration.updatedDate", "iteration.createdDate"])) {
			return "Unknown (iteration freshness)";
		}
		return `${timestamp.slice(0, 10)} (iteration ${source === "iteration.updatedDate" ? "updated" : "created"})`;
	};
	const sorted = [...rows].sort((left, right) => {
		/** @type {Record<string, number>} */
		const decision = { needs_review: 0, approve: 1 };
		return (decision[left.decision] ?? 2) - (decision[right.decision] ?? 2);
	});
	const out = [
		"| Decision | Risk | Source | Freshness | Files | Diff lines | Coverage | Why | PR | Justification | Focus |",
		"| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- |",
	];
	for (const row of sorted) {
		const pr = row.pr;
		const link = pr.url ? `[${pr.repo}#${pr.number}](${pr.url})` : `${pr.repo}#${pr.number}`;
		out.push(
			`| ${row.decision === "approve" ? "Approve" : "Needs review"} | ${cell(row.risk)} | ${cell(
				`${pr.platform || ""}<br>${pr.me || ""}${pr.assignments?.length ? `<br>${pr.assignments.map((entry) => `${property(entry, "kind") || "unknown"}: ${property(entry, "reviewer") || "unknown"}`).join("; ")}` : ""}`,
			)} | ${cell(freshnessLabel(pr))} | ${pr.files.length} | ${cell(lineChanges(pr))} | ${cell(row.coverage)} | ${cell(
				label(row.reason),
			)} | ${link} | ${cell(row.justification)} | ${cell(row.focus.join("; ") || "—")} |`,
		);
	}
	out.push(
		"",
		`_Coverage: ${rows.length}/${prs.length} PRs triaged from supplied diff evidence (${evidenceCount} chunks). Freshness: ${freshness}. Deep checkout is not part of the native dynamic workflow._`,
		...(prs.some((pr) => pr.platform === "azure")
			? ["", "_Azure freshness is latest-iteration activity, not the last comment, review, or general PR metadata update. Unknown timestamps are not treated as old._"] : []),
		"",
		"_Diff lines count added/deleted textual hunk lines, including comments, blanks, tests, docs, generated code, and lockfiles; they are not source LOC or an approval threshold. Partial counts cover only observed text. Verbosity and erosion: not measured (full-source AST/clone and complexity analysis required). Maintainability findings are evidence-backed review prompts, not numeric quality scores or claims of AI authorship. Independent model agreement is not proof of quality._",
	);
	return out.join("\n");

}
