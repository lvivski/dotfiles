import { isList, isOneOf, isRecord, property, readJsonValue, readString } from "../data.mjs";

/** @param {string} diff */
export function diffLineChanges(diff) {
	let additions = 0;
	let deletions = 0;
	let hunks = 0;
	let oldLines = 0;
	let newLines = 0;
	let incomplete = false;
	for (const line of diff.split(/\r?\n/)) {
		const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
		if (hunk) {
			incomplete ||= oldLines !== 0 || newLines !== 0;
			oldLines = Number(hunk[1] ?? 1);
			newLines = Number(hunk[2] ?? 1);
			hunks++;
			continue;
		}
		if (/^(?:Binary files |GIT binary patch|@@@|Azure content unavailable)/.test(line)) {
			incomplete = true;
		}
		if (!oldLines && !newLines) continue;
		if (line === "\\ No newline at end of file") continue;
		if (line.startsWith("+") && newLines > 0) {
			additions++;
			newLines--;
		} else if (line.startsWith("-") && oldLines > 0) {
			deletions++;
			oldLines--;
		} else if (line.startsWith(" ") && oldLines > 0 && newLines > 0) {
			oldLines--;
			newLines--;
		} else {
			incomplete = true;
			oldLines = 0;
			newLines = 0;
		}
	}
	return {
		additions: hunks ? additions : null,
		deletions: hunks ? deletions : null,
		net: hunks ? additions - deletions : null,
		incomplete: incomplete || oldLines !== 0 || newLines !== 0,
	};
}

/** @param {Record<string, unknown>} raw @param {string} repo @param {number} number */
export function evidenceFacts(raw, repo, number) {
	const evidence = isRecord(raw.evidence) ? raw.evidence : {};
	const source = isRecord(evidence.source) ? evidence.source : {};
	const assignments = isList(raw.assignments) ? raw.assignments.map((entry) => readJsonValue(entry)) : [];
	let url;
	try { url = new URL(readString(raw.url)); } catch (error) { if (!(error instanceof TypeError)) throw error; }
	const identityValid = evidence?.version === 1
		&& isOneOf(source.platform, ["github", "azure"])
		&& source.platform === raw.platform
		&& typeof source.host === "string" && url?.protocol === "https:" && source.host === url.host
		&& !url.username && !url.password
		&& typeof source.repository === "string" && source.repository.toLowerCase() === repo.toLowerCase()
		&& source.number === number
		&& typeof source.account === "string" && source.account.trim() !== "" && source.account === raw.me;
	const sourceValid = identityValid && typeof source.baseRevision === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(source.baseRevision)
		&& typeof source.headRevision === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(source.headRevision)
		&& (source.platform !== "azure" || (typeof source.iteration === "number" && Number.isSafeInteger(source.iteration) && source.iteration > 0));
	const failures = [];
	if (!sourceValid) failures.push("Missing or invalid versioned source/revision identity.");
	if (!assignments.length || assignments.some((entry) => !isRecord(entry)
		|| entry.account !== source.account || !isOneOf(entry.kind, ["user", "team"])
		|| typeof entry.reviewer !== "string" || !entry.reviewer.trim())) {
		failures.push("Assignment attribution is incomplete.");
	}
	if (!isList(evidence.failures)) failures.push("Missing fetch failure ledger.");
	else for (const failure of evidence.failures) {
		failures.push(isRecord(failure) && typeof failure.message === "string" ? failure.message : "Malformed fetch failure.");
	}
	for (const field of ["files", "diff", "assignments"]) {
		if (property(evidence.completeness, field) !== true) failures.push(`Incomplete ${field} evidence.`);
	}
	return {
		evidence: readJsonValue(raw.evidence ?? null),
		evidenceComplete: failures.length === 0,
		evidenceFailures: failures,
		assignments,
		sourceKey: identityValid
			? `${source.platform}:${source.host}:${repo}#${number}:${source.account}`.toLowerCase()
			: `${repo}#${number}`.toLowerCase(),
	};
}
