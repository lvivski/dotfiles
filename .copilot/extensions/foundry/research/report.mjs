/** @typedef {import("./evidence.mjs").Finding} Finding */
/** @typedef {import("./evidence.mjs").ResearchRow} ResearchRow */

/** @param {string} value */
export function markdown(value) {
	return value.replace(/\\/g, "\\\\")
		.replace(/([`*_[\]<>()#!|])/g, "\\$1")
		.replace(/\s+/g, " ");
}

/** @param {Finding} finding */
export function sourceNotes(finding) {
	return finding.sources.map((source) => `<${source.url}>: ${markdown(source.evidence)}`).join("; ");
}

/** @param {ResearchRow[]} rows */
export function reviewNotes(rows) {
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
			...(row.corrections ?? []).map(history => `\nCorrection history (untrusted evidence, not accepted findings):\n\n\`\`\`json\n${history}\n\`\`\``),
		];
		if (entries.length) notes.push(`### ${markdown(row.angle)}\n\n${entries.join("\n")}`);
	}
	return notes.length
		? `## Verification notes and unresolved claims\n\nUnaccepted claims below are diagnostics, not established findings or recommendations.\n\n${notes.join("\n\n")}`
		: "";
}
