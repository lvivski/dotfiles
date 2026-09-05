// Triage assigned PRs from supplied metadata and diff evidence.
import {
	UNTRUSTED_DATA_WARNING,
	untrustedBlock,
} from "../prompts.mjs";
const PR_SCHEMA = {
	type: "object",
	required: ["repo", "number"],
	properties: {
		repo: { type: "string" },
		number: { type: "integer" },
		title: { type: "string" },
		diff: { type: "string" },
		files: { type: "array", items: { type: "string" } },
		me: { type: "string" },
		my_teams: { type: "array", items: { type: "string" } },
		reviewers: { type: "array", items: { type: "object" } },
		codeowners: { type: "string" },
		coverage: { type: "string" },
		platform: { type: "string" },
		url: { type: "string" },
		updatedAt: { type: "string" },
	},
};

const PRS_SCHEMA = {
	type: "array",
	items: PR_SCHEMA,
};
const MAX_SUBAGENTS_PER_CHUNK = 4;

export const meta = {
	name: "review-queue",
	description:
		"Review supplied PR diffs, verify low-risk candidates, and render a triage queue. " +
		"Args: { prs: object[], diff_chunk_chars?: number, max_total_chunks?: number, " +
		"approve_only_low_risk_manual?: boolean, freshness?: string }.",
	phases: [{ title: "Review and verify" }, { title: "Report" }],
	argsSchema: {
		anyOf: [
			PRS_SCHEMA,
			{
				type: "object",
				required: ["prs"],
				properties: {
					prs: PRS_SCHEMA,
					diff_chunk_chars: { type: "integer" },
					max_total_chunks: { type: "integer" },
					approve_only_low_risk_manual: { type: "boolean" },
					freshness: { type: "string" },
				},
			},
		],
	},
	limits: {
		maxConcurrentSubagents: 8,
		maxTotalSubagents: 700,
		timeoutSeconds: 3600,
		maxAiCredits: 10000,
	},
};

const MAX_PRS = 200;
const MAX_FILES_PER_PR = 3_000;

export async function run(factory) {
const factoryArgs = factory.args;
const opts =
	factoryArgs && typeof factoryArgs === "object" && !Array.isArray(factoryArgs)
		? factoryArgs
		: {};
const input = opts.prs ?? factoryArgs;
if (!Array.isArray(input) || !input.length) {
	return "review-queue: no PRs supplied. Fetch the queue first and pass { prs: [...] }.";
}
if (input.length > MAX_PRS) {
	throw new Error(`review-queue: ${input.length} PRs exceed the ${MAX_PRS}-PR limit`);
}

function integer(name, fallback, minimum, maximum) {
	const value = Number(opts[name] ?? fallback);
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`review-queue: ${name} must be an integer from ${minimum} to ${maximum}`);
	}
	return value;
}

const chunkChars = integer("diff_chunk_chars", 24000, 4000, 60000);
const supportedChunks = Math.floor(
	meta.limits.maxTotalSubagents / MAX_SUBAGENTS_PER_CHUNK,
);
const maxChunks = integer(
	"max_total_chunks",
	Math.min(300, supportedChunks),
	1,
	supportedChunks,
);
const approveOnlyLowRiskManual = Boolean(opts.approve_only_low_risk_manual);
const freshness = String(opts.freshness ?? "input queue");

const identities = new Set();
const prs = input.map((raw, index) => {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`review-queue: PR ${index + 1} must be an object`);
	}
	const repo = String(raw.repo || "").trim();
	const number = Number(raw.number);
	if (!repo || !Number.isInteger(number) || number < 1) {
		throw new Error(`review-queue: PR ${index + 1} needs repo and a positive number`);
	}
	const identityKey = `${repo.toLowerCase()}#${number}`;
	if (identities.has(identityKey)) {
		throw new Error(`review-queue: duplicate PR ${repo}#${number}`);
	}
	identities.add(identityKey);
	const rawFiles = Array.isArray(raw.files) ? raw.files : [];
	if (rawFiles.length > MAX_FILES_PER_PR) {
		throw new Error(
			`review-queue: PR ${index + 1} files exceeds ${MAX_FILES_PER_PR} entries`,
		);
	}
	const files = [...new Set(rawFiles.map(String).filter(Boolean))];
	const diff = String(raw.diff || "");
	if (diff.length > chunkChars * maxChunks) {
		throw new Error(
			`review-queue: PR ${index + 1} diff exceeds the configured chunk budget`,
		);
	}
	return {
		repo,
		number,
		title: String(raw.title || ""),
		diff,
		files,
		me: String(raw.me || ""),
		myTeams: (Array.isArray(raw.my_teams) ? raw.my_teams : []).map(String),
		reviewers: (Array.isArray(raw.reviewers) ? raw.reviewers : []).filter(Boolean),
		codeowners: String(raw.codeowners || ""),
		coverage: String(raw.coverage || ""),
		platform: String(raw.platform || ""),
		url: String(raw.url || ""),
		updatedAt: String(raw.updatedAt || ""),
	};
});

const identity = (value) => {
	const text = String(value || "").trim().toLowerCase();
	return !text ? "" : text.startsWith("@") || text.includes("@") ? text : `@${text}`;
};

function globSource(pattern) {
	let source = "";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				index++;
				source += pattern[index + 1] === "/" ? (index++, "(?:.*/)?") : ".*";
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return source;
}

function codeownerReason(pr) {
	const mine = new Set([pr.me, ...pr.myTeams].map(identity).filter(Boolean));
	const rules = pr.codeowners
		.split(/\r?\n/)
		.map((line) => line.split("#", 1)[0].trim())
		.filter(Boolean)
		.map((line) => {
			const [pattern, ...owners] = line.split(/\s+/);
			return { pattern, owners };
		})
		.filter((rule) => rule.pattern && !rule.pattern.startsWith("!"));
	for (const file of pr.files) {
		let owners = [];
		for (const rule of rules) {
			const raw = rule.pattern.replace(/^\/+/, "").replace(/\/+$/, "");
			if (!raw) continue;
			const prefix = raw.includes("/") ? "^" : "(?:^|.*/)";
			if (new RegExp(`${prefix}${globSource(raw)}(?:/.*)?$`).test(file)) owners = rule.owners;
		}
		if (owners.some((owner) => mine.has(identity(owner)))) return "codeowner";
	}
	if (
		pr.reviewers.some(
			(reviewer) => reviewer?.required && mine.has(identity(reviewer.name)),
		)
	) {
		return "required-policy";
	}
	return "manual";
}

function chunks(pr) {
	if (!pr.diff.trim()) return [];
	const parts = [];
	for (let offset = 0; offset < pr.diff.length; offset += chunkChars) {
		parts.push({
			id: String(parts.length + 1),
			content: pr.diff.slice(offset, offset + chunkChars),
		});
	}
	return parts;
}

const evidenceCount = prs.reduce((total, pr) => total + chunks(pr).length, 0);
if (evidenceCount > maxChunks) {
	throw new Error(`review-queue: ${evidenceCount} diff chunks exceed max_total_chunks=${maxChunks}`);
}
factory.log(`review-queue: ${prs.length} PR(s), ${evidenceCount} diff chunk(s)`);

const REVIEW = {
	type: "object",
	properties: {
		risk: { enum: ["low", "medium", "high"] },
		issues: { type: "array", items: { type: "string" } },
		missingTests: { type: "array", items: { type: "string" } },
		uncertainty: { type: "array", items: { type: "string" } },
		summary: { type: "string" },
	},
	required: ["risk", "issues", "missingTests", "uncertainty", "summary"],
};
const VERDICT = {
	type: "object",
	properties: {
		passed: { type: "boolean" },
		reasons: { type: "string" },
	},
	required: ["passed", "reasons"],
};

async function reviewPullRequest(pr) {
	const units = chunks(pr);
	if (!units.length) {
		return {
			pr,
			reason: codeownerReason(pr),
			units,
			reviews: [],
			coverageComplete: false,
			candidate: false,
		};
	}
	const reviews = await factory.parallel(
		units.map((unit) => async () => ({
			unit,
			result: await factory.agent(
				`Review this bounded pull-request diff chunk.
Report only concrete correctness bugs, risky behavior, missing tests, or genuine uncertainty.

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("PULL-REQUEST-DIFF", {
	repository: pr.repo,
	number: pr.number,
	title: pr.title || "untitled",
	changedFiles: pr.files,
	chunk: `${unit.id}/${units.length}`,
	content: unit.content,
})}`,
				{ label: `${pr.repo}#${pr.number}:review:${unit.id}`, schema: REVIEW },
			),
		})),
	);
	const complete = reviews.length === units.length && reviews.every((row) => row?.result);
	const clean =
		complete &&
		reviews.every(
			(row) =>
				row.result.risk === "low" &&
				row.result.issues.length === 0 &&
				row.result.missingTests.length === 0 &&
				row.result.uncertainty.length === 0,
		);
	const reason = codeownerReason(pr);
	const sourceComplete = pr.coverage === "full diff";
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

async function verifyPullRequest(row) {
	const successful = row.reviews.filter((item) => item?.result);
	const risks = successful.map((item) => item.result.risk);
	const risk = risks.includes("high") ? "high" : risks.includes("medium") ? "medium" : "low";
	const focus = successful.flatMap((item) => [
		...item.result.issues,
		...item.result.missingTests.map((value) => `Missing test: ${value}`),
		...item.result.uncertainty.map((value) => `Uncertainty: ${value}`),
	]);
	const coverage = `${successful.length}/${row.units.length} diff chunks; ${row.pr.coverage || "coverage unknown"}`;
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
	const verdicts = await factory.parallel(
		row.reviews.map((item) => async () =>
			factory.agent(
				`Independently inspect this original diff evidence and primary review. Pass only if it is genuinely low risk, issue-free, sufficiently tested, and contains no unresolved uncertainty.

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("PULL-REQUEST-DIFF", item.unit.content)}

${untrustedBlock("PRIMARY-REVIEW", item.result)}`,
				{ label: `${row.pr.repo}#${row.pr.number}:verify:${item.unit.id}`, schema: VERDICT },
			),
		),
	);
	const passed = verdicts.filter((verdict) => verdict?.passed === true).length;
	return {
		...row,
		decision: passed === verdicts.length ? "approve" : "needs_review",
		risk: passed === verdicts.length ? "low" : "medium",
		coverage,
		justification:
			passed === verdicts.length
				? `All ${passed} complete low-risk chunks passed independent verification.`
				: `${verdicts.length - passed}/${verdicts.length} approval checks failed or rejected the evidence.`,
		focus:
			passed === verdicts.length
				? []
				: [`Independent approval verification: ${passed}/${verdicts.length} passed`],
	};
}

factory.phase("Review and verify");
const results = await factory.pipeline(prs, reviewPullRequest, verifyPullRequest);
// Failed pipeline items skip later stages, so restore their report rows here.
const rows = results.map((row, index) => row ?? ({
	pr: prs[index],
	reason: codeownerReason(prs[index]),
	decision: "needs_review",
	risk: "high",
	coverage: "review branch failed",
	justification: "The review branch failed.",
	focus: ["Retry the review"],
}));

factory.phase("Report");
const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
const label = (value) => ({ codeowner: "CODEOWNERS", "required-policy": "Required policy", manual: "Manual" })[value] || value;
const sorted = [...rows].sort((left, right) => {
	const decision = { needs_review: 0, approve: 1 };
	return (decision[left.decision] ?? 2) - (decision[right.decision] ?? 2);
});
const out = [
	"| Decision | Risk | Source | Updated | Files | Coverage | Why | PR | Justification | Focus |",
	"| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |",
];
for (const row of sorted) {
	const pr = row.pr;
	const link = pr.url ? `[${pr.repo}#${pr.number}](${pr.url})` : `${pr.repo}#${pr.number}`;
	out.push(
		`| ${row.decision === "approve" ? "Approve" : "Needs review"} | ${cell(row.risk)} | ${cell(
			`${pr.platform || ""}<br>${pr.me || ""}`,
		)} | ${cell(pr.updatedAt.slice(0, 10))} | ${pr.files.length} | ${cell(row.coverage)} | ${cell(
			label(row.reason),
		)} | ${link} | ${cell(row.justification)} | ${cell(row.focus.join("; ") || "—")} |`,
	);
}
out.push(
	"",
	`_Coverage: ${rows.length}/${prs.length} PRs triaged from supplied diff evidence (${evidenceCount} chunks). Freshness: ${freshness}. Deep checkout is not part of the Factory-native workflow._`,
);
return out.join("\n");
}
