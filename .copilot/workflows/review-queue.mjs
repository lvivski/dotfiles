// review-queue.mjs — triage every PR I'm asked to review (GitHub + Azure DevOps).
//
//   ~/.copilot/skills/review-queue/scripts/review-queue-fetch.sh > /tmp/prs.json
//   run_workflow({ name: "review-queue", budget: 10000, args: <parsed /tmp/prs.json> })
//
// args: a JSON array of normalized PR records (see review-queue-fetch.sh), or { prs: [...] }.
export const meta = {
	name: "review-queue",
	description: "Triage assigned PRs: approve-now vs needs-review, with why-assigned and focus hints.",
	phases: ["review", "verify", "report"],
};

const workflowArgs = context.args;
const opts = workflowArgs && typeof workflowArgs === "object" && !Array.isArray(workflowArgs) ? workflowArgs : {};
const input = opts.prs ?? workflowArgs;
if (!Array.isArray(input) || !input.length) {
	return "review-queue: no PRs supplied. Pipe review-queue-fetch.sh output via args.";
}

function intOption(name, fallback, min, max) {
	const value = Number(opts[name] ?? fallback);
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`review-queue: ${name} must be an integer from ${min} to ${max}`);
	return value;
}

const deep = Boolean(opts.deep);
const autoDeep = opts.auto_deep === undefined ? true : Boolean(opts.auto_deep);
const approveOnlyLowRiskManual = Boolean(opts.approve_only_low_risk_manual);
const freshness = String(opts.freshness ?? "input queue; fetch default excludes PRs older than 30 days");
const developerRoot = String(opts.developer_root || "~/Developer");
const reviewConcurrency = deep || autoDeep ? intOption("concurrency", 6, 1, 32) : undefined;
const diffChunkChars = intOption("diff_chunk_chars", 24000, 4000, 60000);
const fileChunkSize = intOption("file_chunk_size", 20, 1, 50);
// A chunk can consume one diff review, one conditional deep review, and one approval verifier.
// Keeping the queue at 300 chunks leaves headroom under the runtime's 1,000-agent hard cap.
const MAX_SAFE_CHUNKS = 300;
const maxChunks = intOption("max_chunks", MAX_SAFE_CHUNKS, 1, MAX_SAFE_CHUNKS);
const maxTotalChunks = intOption("max_total_chunks", MAX_SAFE_CHUNKS, 1, MAX_SAFE_CHUNKS);

const prs = input.map((raw, index) => {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`review-queue: PR ${index + 1} must be an object`);
	const record = raw;
	const repo = String(record.repo || "").trim();
	const number = Number(record.number);
	if (!repo || !Number.isInteger(number) || number < 1) throw new Error(`review-queue: PR ${index + 1} needs repo and positive integer number`);
	return {
		...record,
		repo,
		number,
		title: String(record.title || ""),
		files: [...new Set((Array.isArray(record.files) ? record.files : []).map((file) => String(file).replace(/^\/+/, "")).filter(Boolean))],
		diff: String(record.diff || ""),
		me: String(record.me || ""),
		my_teams: (Array.isArray(record.my_teams) ? record.my_teams : []).map(String),
		reviewers: (Array.isArray(record.reviewers) ? record.reviewers : [])
			.filter((reviewer) => reviewer && typeof reviewer === "object" && !Array.isArray(reviewer))
			.map((reviewer) => {
				const value = reviewer;
				return { name: String(value.name || ""), required: Boolean(value.required) };
			}),
		codeowners: String(record.codeowners || ""),
		coverage: String(record.coverage || ""),
		platform: String(record.platform || ""),
		url: String(record.url || ""),
		updatedAt: String(record.updatedAt || ""),
		clone_url: String(record.clone_url || ""),
		pr_ref: String(record.pr_ref || ""),
	};
});
if (prs.length > maxTotalChunks) throw new Error(`review-queue: ${prs.length} PRs exceed max_total_chunks=${maxTotalChunks}; raise the cap or split the queue`);
const chunkLimit = Math.max(1, Math.min(maxChunks, Math.floor(maxTotalChunks / prs.length)));

// ---- assignment attribution ------------------------------------------------

const escapeRe = (value) => value.replace(/[.+^${}()|\\]/g, "\\$&");

function globSource(pattern) {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				i++;
				if (pattern[i + 1] === "/") {
					i++;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += escapeRe(char);
		}
	}
	return source;
}

/** GitHub CODEOWNERS matching for documented gitignore-style syntax. */
function codeownersMatch(file, rawPattern) {
	if (!rawPattern || rawPattern.startsWith("!") || /[\[\]]/.test(rawPattern)) return false;
	const rootAnchored = rawPattern.startsWith("/");
	const directory = rawPattern.endsWith("/");
	let pattern = rawPattern.replace(/^\/+/, "").replace(/\/+$/, "");
	if (!pattern) return false;
	const hasSlash = pattern.includes("/");
	const prefix = rootAnchored || hasSlash ? "^" : "(?:^|.*/)";
	const last = pattern.split("/").at(-1) || "";
	const recursive = directory || !/[*?]/.test(last);
	return new RegExp(prefix + globSource(pattern) + (recursive ? "(?:/.*)?" : "") + "$").test(file);
}

function codeownerRules(text) {
	const rules = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.split("#", 1)[0].trim();
		if (!line) continue;
		const [pattern, ...owners] = line.split(/\s+/);
		if (!pattern || pattern.startsWith("!") || /[\[\]]/.test(pattern)) continue;
		rules.push({ pattern, owners });
	}
	return rules;
}

function identity(value) {
	const text = String(value || "").trim().toLowerCase();
	if (!text) return "";
	if (text.startsWith("@") || text.includes("@")) return text;
	return "@" + text;
}

function owns(pr) {
	const mine = new Set([pr.me, ...pr.my_teams].map(identity).filter(Boolean));
	if (pr.platform === "github" && pr.codeowners) {
		const rules = codeownerRules(pr.codeowners);
		for (const file of pr.files) {
			let owners = [];
			for (const rule of rules) if (codeownersMatch(file, rule.pattern)) owners = rule.owners;
			if (owners.some((owner) => mine.has(identity(owner)))) return "codeowner";
		}
	}
	if (pr.reviewers.some((reviewer) => reviewer?.required && mine.has(identity(reviewer.name)))) return "required-policy";
	return "manual";
}

// ---- bounded evidence units ------------------------------------------------

function chunkLines(lines, prefix, limit, label) {
	const parts = [];
	const boundaries = [];
	let body = "";
	const flush = () => {
		if (body) parts.push(prefix + body);
		body = "";
	};
	if (prefix.length > limit) return { parts, boundaries: [`${label} metadata exceeds diff_chunk_chars=${limit}; chunk omitted.`] };
	for (const line of lines) {
		if (prefix.length + line.length > limit) {
			flush();
			boundaries.push(`${label} contains a diff line too large for diff_chunk_chars=${limit}; line omitted.`);
			continue;
		}
		if (body && prefix.length + body.length + line.length > limit) flush();
		body += line;
	}
	flush();
	if (!lines.length) parts.push(prefix);
	return { parts, boundaries };
}

function boundedParts(text, limit, file) {
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
	const hunkIndexes = lines.map((line, index) => (line.startsWith("@@") ? index : -1)).filter((index) => index >= 0);
	const filePrefix = `File: ${file || "(unknown)"}\n`;
	if (!hunkIndexes.length) {
		const chunked = chunkLines(lines, filePrefix, limit, file || "unknown file");
		chunked.boundaries.push(`${file || "Unknown file"} has no textual diff hunk; metadata/binary-only evidence cannot approve.`);
		return chunked;
	}

	const header = lines.slice(0, hunkIndexes[0]).join("");
	const parts = [];
	const boundaries = [];
	for (const [position, start] of hunkIndexes.entries()) {
		const end = hunkIndexes[position + 1] ?? lines.length;
		const hunkHeader = lines[start];
		const chunked = chunkLines(lines.slice(start + 1, end), filePrefix + header + hunkHeader, limit, `${file || "unknown file"} ${hunkHeader.trim()}`);
		parts.push(...chunked.parts);
		boundaries.push(...chunked.boundaries);
	}
	return { parts, boundaries };
}

function diffSections(diff) {
	const marker = /^diff --git /gm;
	let matches = [...diff.matchAll(marker)];
	if (!matches.length) matches = [...diff.matchAll(/^--- (?:a\/|\/dev\/null)/gm)];
	if (matches.length <= 1) return [diff];
	return matches.map((match, index) => diff.slice(match.index, matches[index + 1]?.index ?? diff.length));
}

function sectionFile(section) {
	const git = /^diff --git a\/(.+) b\/(.+)$/m.exec(section);
	if (git) return git[2];
	const unified = /^\+\+\+ b\/(.+)$/m.exec(section);
	return unified ? unified[1] : "";
}

function capUnits(units) {
	const total = units.length;
	const selected = units.slice(0, chunkLimit);
	return {
		units: selected,
		total,
		boundary: total > selected.length ? `Coverage capped at ${selected.length}/${total} chunks (per-PR limit ${chunkLimit}; max_chunks=${maxChunks}; max_total_chunks=${maxTotalChunks}).` : "",
	};
}

function diffUnits(pr) {
	if (!pr.diff) {
		return {
			...capUnits([{ id: "diff-1", kind: "diff", files: pr.files, content: `Changed files only; full diff unavailable:\n${pr.files.join("\n") || "(none)"}` }]),
			sourceComplete: false,
		};
	}
	const units = [];
	const boundaries = [];
	for (const section of diffSections(pr.diff)) {
		const file = sectionFile(section);
		const chunked = boundedParts(section, diffChunkChars, file);
		boundaries.push(...chunked.boundaries);
		for (const content of chunked.parts) {
			units.push({ id: `diff-${units.length + 1}`, kind: "diff", files: file ? [file] : pr.files, content });
		}
	}
	const capped = capUnits(units);
	if (capped.boundary) boundaries.push(capped.boundary);
	const uniqueBoundaries = [...new Set(boundaries)];
	return { ...capped, boundary: uniqueBoundaries.join(" "), sourceComplete: pr.coverage === "full diff" && !uniqueBoundaries.length };
}

function checkoutUnits(pr, inspection) {
	const units = [];
	for (let i = 0; i < inspection.present.length; i += fileChunkSize) {
		const files = inspection.present.slice(i, i + fileChunkSize);
		units.push({ id: `files-${units.length + 1}`, kind: "checkout", files, content: files.join("\n") });
	}
	const capped = capUnits(units);
	const boundaries = [
		capped.boundary,
		inspection.missing.length ? `Missing from PR-head checkout: ${inspection.missing.join(", ")}.` : "",
		inspection.uninspectable.length ? `Uninspectable checkout paths: ${inspection.uninspectable.join(", ")}.` : "",
	].filter(Boolean);
	return {
		...capped,
		boundary: boundaries.join(" "),
		sourceComplete: pr.files.length > 0 && inspection.present.length === pr.files.length && !boundaries.length,
	};
}

const REVIEW_SCHEMA = {
	type: "object",
	properties: {
		risk: { enum: ["low", "medium", "high"] },
		issues: { type: "array", items: { type: "string" } },
		missing_tests: { type: "array", items: { type: "string" } },
		uncertainty: { type: "array", items: { type: "string" } },
		needs_deep_review: { type: "boolean" },
		summary: { type: "string" },
	},
	required: ["risk", "issues", "missing_tests", "uncertainty", "needs_deep_review", "summary"],
};

function validateReview(value) {
	const errors = [];
	const listKeys = ["issues", "missing_tests", "uncertainty"];
	for (const key of listKeys) {
		const items = value[key] || [];
		if (items.length > 8) errors.push(`${key} must contain at most 8 items`);
		if (items.some((item) => !String(item).trim() || String(item).length > 500)) errors.push(`${key} items must be non-empty and at most 500 characters`);
		const unique = new Set(items.map((item) => String(item).trim().toLowerCase()));
		if (unique.size !== items.length) errors.push(`${key} must not contain duplicates`);
	}
	if (!String(value.summary || "").trim() || String(value.summary).length > 1000) errors.push("summary must be non-empty and at most 1000 characters");
	return errors;
}

async function reviewUnit(pr, unit, cwd) {
	const evidence =
		unit.kind === "checkout"
			? `Changed files in the checkout:\n${unit.content}\n\nOpen these files, their immediate callers/imports, and directly related tests.`
			: `Changed file(s): ${unit.files.join(", ") || "(unknown)"}\nOriginal self-contained diff chunk:\n${unit.content}`;
	const review = await phase("review", () => agent(
		`Review one bounded part of ${pr.repo}#${pr.number} (${pr.title || "untitled"}). Report only concrete bugs, risky behavior, missing tests, or uncertainty. Do not invent issues. Set needs_deep_review only when repository context outside this evidence could materially change a clean decision.\n\n${evidence}`,
		{
			schema: REVIEW_SCHEMA,
			validate: validateReview,
			retries: 0,
			agentType: "worker",
			label: `${pr.repo}#${pr.number}-${unit.id}`,
			...(cwd ? { cwd, profile: "read-only" } : { profile: "none" }),
		},
	));
	return review.ok ? { unit, ok: true, review: review.value } : { unit, ok: false, error: review.error || "review failed" };
}

async function reviewUnits(pr, evidence, cwd) {
	const raw = await pipeline(evidence.units, (unit) => reviewUnit(pr, unit, cwd), { onFailure: "drop" });
	return evidence.units.map((unit, index) => raw[index] || { unit, ok: false, error: "review branch failed" });
}

// ---- deterministic decision + independent approval verification ------------

const RISK_ORDER = { low: 0, medium: 1, high: 2 };
const riskMax = (left, right) => (RISK_ORDER[left] >= RISK_ORDER[right] ? left : right);

function analyze(pr, reason, evidence, reviews, mode) {
	const successful = reviews.filter((review) => review.ok);
	const unsuccessful = reviews.filter((review) => !review.ok);
	const failed = reviews.length - successful.length;
	const analyzedFiles = new Set(successful.flatMap((review) => review.unit.files));
	let risk = failed ? "high" : "low";
	const focus = [];
	let needsDeep = false;
	for (const item of successful) {
		risk = riskMax(risk, item.review.risk);
		needsDeep ||= item.review.needs_deep_review;
		for (const issue of item.review.issues) focus.push(issue);
		for (const missing of item.review.missing_tests) focus.push(`Missing test: ${missing}`);
		for (const uncertainty of item.review.uncertainty) focus.push(`Uncertainty: ${uncertainty}`);
	}
	for (const item of unsuccessful) focus.push(`${item.unit.id}: ${item.error || "review failed"}`);
	if (evidence.boundary) focus.push(evidence.boundary);
	const coverageComplete = evidence.sourceComplete && !evidence.boundary && failed === 0 && reviews.length === evidence.total;
	const allClean = successful.every(
		(item) =>
			item.review.risk === "low" &&
			!item.review.issues.length &&
			!item.review.missing_tests.length &&
			!item.review.uncertainty.length &&
			!item.review.needs_deep_review,
	);
	const policyAllows = !approveOnlyLowRiskManual || reason === "manual";
	const candidate = coverageComplete && allClean && policyAllows;
	if (!policyAllows) focus.push("Policy gate: only low-risk manual requests may be approved");
	const coverage = `${mode}: ${successful.length}/${evidence.total} chunk(s), ${analyzedFiles.size}/${pr.files.length} changed file(s) analyzed${evidence.boundary ? `; ${evidence.boundary}` : ""}`;
	return {
		pr,
		reason,
		evidence,
		reviews,
		needsDeep,
		coverageComplete,
		coverage,
		verdict: {
			decision: candidate ? "candidate_approve" : "needs_review",
			risk,
			justification: candidate
				? `All ${successful.length} bounded review chunk(s) were complete, low risk, and issue-free; independent verification is still required.`
				: `Conservative gate blocked approval: ${focus[0] || "review evidence was not unanimously low-risk, clean, and complete"}.`,
			focus,
		},
	};
}

async function verifyApproval(row, cwd) {
	if (row.verdict.decision !== "candidate_approve") return row;
	const approvedReviews = row.reviews.filter((item) => item.ok);
	const subjects = approvedReviews.map((item) => {
		const evidence =
			item.unit.kind === "checkout"
				? `Open and inspect these changed files in the checkout:\n${item.unit.files.join("\n")}`
				: `Changed file(s): ${item.unit.files.join(", ") || "(unknown)"}\nOriginal self-contained diff chunk:\n${item.unit.content}`;
		return {
			item,
			subject: `${evidence}\n\nPrimary review result:\n${JSON.stringify(item.review)}`,
		};
	});
	const raw = await phase("verify", () => pipeline(
		subjects,
		({ item, subject }) =>
			verify(subject, "Independently inspect the original evidence. Pass only if the chunk is genuinely low risk, issue-free, sufficiently tested, and contains no uncertainty requiring human review.", {
				refute: true,
				label: `${row.pr.repo}#${row.pr.number}-${item.unit.id}`,
				...(cwd ? { cwd, profile: "read-only" } : { profile: "none" }),
			}),
		{ onFailure: "drop" },
	));
	const passed = raw.filter((verdict) => verdict?.ok && verdict.passed).length;
	if (passed === subjects.length) {
		row.verdict.decision = "approve";
		row.verdict.justification = `All ${subjects.length} complete low-risk chunk(s) passed independent evidence-backed verification.`;
		row.verdict.focus = [];
	} else {
		row.verdict.decision = "needs_review";
		row.verdict.risk = riskMax(row.verdict.risk, "medium");
		row.verdict.justification = `Approval verification failed or rejected ${subjects.length - passed}/${subjects.length} evidence chunk(s).`;
		row.verdict.focus.push(`Independent approval verification: ${passed}/${subjects.length} passed`);
	}
	row.approvalVerification = `${passed}/${subjects.length}`;
	return row;
}

async function analyzeDiff(pr, reason) {
	const evidence = diffUnits(pr);
	const reviews = await reviewUnits(pr, evidence, null);
	return verifyApproval(analyze(pr, reason, evidence, reviews, pr.coverage || "diff coverage unknown"), null);
}

async function analyzeCheckout(pr, reason) {
	if (!pr.clone_url || !pr.pr_ref) throw new Error("missing clone URL or PR ref");
	return workspace.worktree(String(pr.number), { repo: pr.clone_url, ref: pr.pr_ref, cloneDir: developerRoot }, async (path) => {
		const inspection = await host.inspectCheckout({ root: path, files: pr.files }, { cache: false });
		const evidence = checkoutUnits(pr, inspection);
		const reviews = await reviewUnits(pr, evidence, path);
		return verifyApproval(analyze(pr, reason, evidence, reviews, "deep checkout"), path);
	});
}

function blockForDegradedCoverage(row, message) {
	row.coverageComplete = false;
	row.coverage += `; ${message}`;
	row.verdict.decision = "needs_review";
	row.verdict.risk = riskMax(row.verdict.risk, "medium");
	row.verdict.justification = message;
	row.verdict.focus.push(message);
	return row;
}

async function triagePr(pr) {
	const reason = owns(pr);
	const initiallyDeep = deep || (autoDeep && pr.coverage !== "full diff");
	if (initiallyDeep) {
		try {
			return await analyzeCheckout(pr, reason);
		} catch (error) {
			const message = `Deep checkout unavailable: ${error instanceof Error ? error.message : error}`;
			log(`review-queue: ${message} for ${pr.repo}#${pr.number}; using supplied diff`);
			return blockForDegradedCoverage(await analyzeDiff(pr, reason), message);
		}
	}

	const row = await analyzeDiff(pr, reason);
	if (!autoDeep || !row.needsDeep) return row;
	try {
		return await analyzeCheckout(pr, reason);
	} catch (error) {
		return blockForDegradedCoverage(row, `Conditional deep review unavailable: ${error instanceof Error ? error.message : error}`);
	}
}

const rows = await phase("review", () => pipeline(prs, triagePr, { concurrency: reviewConcurrency }));
log(`review-queue: triaged ${rows.length}/${prs.length} PR(s)`);

// ---- report ----------------------------------------------------------------

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
const title = (value) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : "");
const decisionLabel = (decision) => ({ approve: "Approve", candidate_approve: "Needs review", needs_review: "Needs review" })[decision] || decision;
const reasonLabel = (reason) => ({ codeowner: "CODEOWNERS", "required-policy": "Required policy", manual: "Manual" })[reason] || reason;
const dateOf = (value) => String(value ?? "").slice(0, 10);
const source = (pr) => `${pr.platform || ""}<br>${pr.me || ""}`;

function rank(row) {
	const verdict = row.verdict;
	return [
		{ needs_review: 0, candidate_approve: 0, approve: 1 }[verdict.decision] ?? 2,
		{ high: 0, medium: 1, low: 2 }[verdict.risk] ?? 3,
		{ codeowner: 0, "required-policy": 1, manual: 2 }[row.reason] ?? 3,
		row.pr.repo,
		row.pr.number,
	];
}

function cmpRank(left, right) {
	const a = rank(left);
	const b = rank(right);
	for (let i = 0; i < a.length; i++) {
		if (a[i] < b[i]) return -1;
		if (a[i] > b[i]) return 1;
	}
	return 0;
}

const out = [
	"| Decision | Risk | Source | Updated | Files | Coverage | Why | PR | Justification | Focus |",
	"| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |",
];
for (const row of [...rows].sort(cmpRank)) {
	const verdict = row.verdict;
	const pr = row.pr;
	const prLabel = `${pr.repo}#${pr.number}`;
	let prLink = pr.url ? `[${cell(prLabel)}](${pr.url})` : cell(prLabel);
	if (pr.title) prLink += `<br>${cell(pr.title)}`;
	const focus = verdict.focus.slice(0, 12);
	if (verdict.focus.length > focus.length) focus.push(`+${verdict.focus.length - focus.length} more`);
	out.push(
		`| ${cell(decisionLabel(verdict.decision))} | ${cell(title(verdict.risk))} | ${cell(source(pr))} | ${cell(dateOf(pr.updatedAt))} | ${cell(pr.files.length)} | ${cell(row.coverage)} | ${cell(reasonLabel(row.reason))} | ${prLink} | ${cell(verdict.justification)} | ${cell(focus.join("; ") || "OK")} |`,
	);
}

const platforms = {};
const coverages = {};
for (const row of rows) {
	platforms[row.pr.platform || "unknown"] = (platforms[row.pr.platform || "unknown"] || 0) + 1;
	coverages[row.coverage] = (coverages[row.coverage] || 0) + 1;
}
const kv = (object) =>
	Object.keys(object)
		.sort()
		.map((key) => `${key}=${object[key]}`)
		.join(", ");
out.push(
	"",
	`_Reviewed ${rows.length}/${prs.length} PR(s). Approvals: ${rows.filter((row) => row.verdict.decision === "approve").length}. Sources: ${kv(platforms)}. Coverage: ${kv(coverages)}. Freshness: ${freshness}. Auto-deep: ${autoDeep ? "on" : "off"}. Deep mode: ${deep ? "on" : "off"}. Chunking: ${diffChunkChars} diff chars / ${fileChunkSize} files, per-PR limit ${chunkLimit}, queue limit ${maxTotalChunks}. Conservative approval policy: ${approveOnlyLowRiskManual ? "on" : "off"}._`,
);
return out.join("\n");
