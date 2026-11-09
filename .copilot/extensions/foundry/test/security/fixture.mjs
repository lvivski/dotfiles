export function securityFinding(index = 0) {
	return {
		title: `Reachable injection ${index + 1}`,
		severity: "high",
		confidence: "high",
		vulnerabilityClass: "injection",
		file: `src/${index}.js`,
		line: index + 1,
		source: "input",
		control: "none",
		sink: "eval",
		attack: "execute",
		contraryEvidence: "none",
		description: "reachable",
		recommendation: "validate",
	};
}
