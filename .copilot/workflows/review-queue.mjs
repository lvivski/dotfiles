// review-queue.mjs — triage every PR I'm asked to review (GitHub + Azure DevOps).
//
//   ~/.copilot/skills/review-queue/scripts/review-queue-fetch.sh > /tmp/prs.json
//   run_workflow({ name: "review-queue", budget: 10000, args: <parsed /tmp/prs.json> })
//
// args: a JSON array of normalized PR records (see review-queue-fetch.sh), or { prs: [...] }.
// Read-only: reviewers are quarantined over the provided diff.
export const meta = {
	name: "review-queue",
	description: "Triage assigned PRs: approve-now vs needs-review, with why-assigned and focus hints.",
	phases: ["review", "decide"],
};

const opts = args && typeof args === "object" && !Array.isArray(args) ? args : {};
const prs = args && typeof args === "object" && !Array.isArray(args) ? args.prs : args;
if (!prs || !prs.length) return "review-queue: no PRs supplied. Pipe review-queue-fetch.sh output via args.";

const noTools = quarantine({ allowAllTools: false });
const deep = Boolean(opts.deep);
const autoDeep = opts.auto_deep === undefined ? true : Boolean(opts.auto_deep);
const approveOnlyLowRiskManual = Boolean(opts.approve_only_low_risk_manual);
const freshness = opts.freshness ?? "input queue; fetch default excludes PRs older than 30 days";
const developerRoot = opts.developer_root || "~/Developer";
const reviewConc = deep || autoDeep ? opts.concurrency || 6 : undefined; // throttle parallel checkouts

/** Shell-style pattern match: `*` any, `?` one char, `[set]`. */
function fnmatch(name, pat) {
	let re = "";
	for (let i = 0; i < pat.length; i++) {
		const c = pat[i];
		if (c === "*") re += ".*";
		else if (c === "?") re += ".";
		else if (c === "[") {
			let j = i + 1;
			let neg = "";
			if (pat[j] === "!") {
				neg = "^";
				j++;
			}
			let set = "";
			while (j < pat.length && pat[j] !== "]") {
				set += /[\\^\]]/.test(pat[j]) ? "\\" + pat[j] : pat[j];
				j++;
			}
			if (j >= pat.length) {
				re += "\\[";
			} else {
				re += `[${neg}${set}]`;
				i = j;
			}
		} else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
	}
	return new RegExp("^" + re + "$").test(name);
}

/** Why was I added? CODEOWNERS last-match wins; else required policy; else manual. */
function owns(pr) {
	const mine = new Set([pr.me || "", ...(pr.my_teams || [])].map((m) => ("@" + m).toLowerCase()));
	const files = pr.files || [];
	let final = [];
	for (const line of (pr.codeowners || "").split("\n")) {
		const parts = line.split("#")[0].split(/\s+/).filter(Boolean);
		if (!parts.length) continue;
		const [pat, ...owners] = parts;
		const bare = pat.replace(/^\/+|\/+$/g, "");
		if (files.some((f) => f === bare || f.startsWith(bare + "/") || fnmatch(f, pat))) final = owners;
	}
	if (final.some((o) => mine.has(o.toLowerCase()))) return "codeowner";
	if ((pr.reviewers || []).some((r) => r.required)) return "required-policy";
	return "manual";
}

async function reviewAgent(pr, cwd = null) {
	let body = `Title: ${pr.title || ""}\nFiles (${(pr.files || []).length}): ${(pr.files || []).slice(0, 40).join(", ")}\n\nDIFF:\n${pr.diff || "(no diff)"}`;
	const extra = {};
	if (cwd) {
		extra.cwd = cwd;
		body += "\n\nThe PR is checked out at the working dir. Stay focused: inspect the changed files listed above, their immediate callers/imports, and directly related tests. Do not broadly audit the repo.";
	}
	return agent("Review this pull request as a careful reviewer. Note bugs, risky changes, missing tests, and anything needing human judgment. Be concise; cite file/line where you can.\n\n" + body, {
		agentType: "worker",
		label: `${pr.repo}#${pr.number}`,
		phase: "review",
		...extra,
		...quarantine(), // untrusted diff: read-only, no shell/write/network/MCP
	});
}

async function deepReview(pr) {
	if (!pr.clone_url || !pr.pr_ref) throw new Error("missing clone URL or PR ref");
	return worktree(String(pr.number), { repo: pr.clone_url, ref: pr.pr_ref, cloneDir: developerRoot }, async (path) => {
		const finding = await reviewAgent(pr, path);
		return [finding, "deep checkout"];
	});
}

async function review(pr) {
	const reason = owns(pr);
	if ((deep || (autoDeep && pr.coverage !== "full diff")) && pr.clone_url && pr.pr_ref) {
		try {
			const [finding, coverage] = await deepReview(pr);
			return { pr, reason, coverage, finding };
		} catch (e) {
			log(`review-queue: deep checkout failed for ${pr.repo}#${pr.number} (${e instanceof Error ? e.message : e}); diff-only`);
		}
	}
	return { pr, reason, coverage: pr.coverage || "unknown", finding: await reviewAgent(pr) };
}

async function decide(row, suffix = "") {
	const required = row.reason !== "manual";
	const verdict = await structured(
		`Given this review of ${row.pr.repo}#${row.pr.number} (I was added as: ${row.reason}; required=${required}), classify whether it is safe to APPROVE now or NEEDS_REVIEW. Provide a concise justification for the decision, and list focus hints only if needs_review. If approve_only_low_risk_manual=${approveOnlyLowRiskManual}, only approve PRs that are both low risk and manually requested; classify everything else as NEEDS_REVIEW. Set needs_deep_review=true only when checking surrounding files/tests in a checkout could materially change the decision or resolve uncertainty; do not set it merely because the review already found a concrete issue.\n\nCoverage: ${row.coverage}\nReview:\n${row.finding.content}`,
		{
			type: "object",
			properties: {
				decision: { enum: ["approve", "needs_review"] },
				risk: { enum: ["low", "medium", "high"] },
				justification: { type: "string" },
				needs_deep_review: { type: "boolean" },
				focus: { type: "array", items: { type: "string" } },
			},
			required: ["decision", "risk", "justification", "needs_deep_review"],
		},
		{ label: `${row.pr.repo}#${row.pr.number}${suffix ? "-" + suffix : ""}`, phase: "decide", ...noTools },
	);
	row.verdict = verdict.ok ? verdict.value : { decision: "needs_review", risk: "high", justification: "Verdict parse failed.", needs_deep_review: false, focus: ["verdict parse failed"] };
	if (approveOnlyLowRiskManual && (row.reason !== "manual" || row.verdict.risk !== "low") && row.verdict.decision === "approve") {
		row.verdict = {
			decision: "needs_review",
			risk: row.verdict.risk || "medium",
			justification: "Conservative policy requires manual review unless the PR is both low risk and manually requested.",
			focus: ["Policy gate: not a low-risk manual request"],
		};
	}
	return row;
}

function needsDeep(row) {
	if (deep || !autoDeep) return false;
	if (String(row.coverage || "").startsWith("deep checkout")) return false;
	if (row.coverage !== "full diff") return true;
	return Boolean(row.verdict?.needs_deep_review);
}

async function deepenIfNeeded(row) {
	if (!needsDeep(row)) return row;
	const pr = row.pr;
	let finding, coverage;
	try {
		[finding, coverage] = await deepReview(pr);
	} catch (e) {
		log(`review-queue: conditional deep review unavailable for ${pr.repo}#${pr.number} (${e instanceof Error ? e.message : e})`);
		row.coverage = `${row.coverage || "unknown"}; deep unavailable`;
		(row.verdict.focus ??= []).push(`Deep checkout unavailable: ${e instanceof Error ? e.message : e}`);
		return row;
	}
	return decide({ pr, reason: row.reason, coverage, finding }, "deep");
}

const rows = (await pipeline(prs, review, decide, deepenIfNeeded, { concurrency: reviewConc })).filter((r) => r !== null);
log(`review-queue: triaged ${rows.length} PR(s)`);

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
const title = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
const decisionLabel = (d) => ({ approve: "Approve", needs_review: "Needs review" })[d] || d;
const reasonLabel = (r) => ({ codeowner: "CODEOWNERS", "required-policy": "Required policy", manual: "Manual" })[r] || r;
const dateOf = (v) => String(v ?? "").slice(0, 10);
const source = (pr) => `${pr.platform || ""}<br>${pr.me || ""}`;

/** Sort key tuple: decision, risk, reason, repo, number. */
function rank(row) {
	const v = row.verdict;
	return [{ needs_review: 0, approve: 1 }[v.decision] ?? 2, { high: 0, medium: 1, low: 2 }[v.risk] ?? 3, { codeowner: 0, "required-policy": 1, manual: 2 }[row.reason] ?? 3, row.pr.repo || "", row.pr.number || 0];
}
function cmpRank(a, b) {
	const ra = rank(a);
	const rb = rank(b);
	for (let i = 0; i < ra.length; i++) {
		if (ra[i] < rb[i]) return -1;
		if (ra[i] > rb[i]) return 1;
	}
	return 0;
}

const out = [];
out.push("| Decision | Risk | Source | Updated | Files | Coverage | Why | PR | Justification | Focus |");
out.push("| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |");
for (const row of [...rows].sort(cmpRank)) {
	const v = row.verdict;
	const pr = row.pr;
	const prLabel = `${pr.repo}#${pr.number}`;
	let prLink = pr.url ? `[${cell(prLabel)}](${pr.url})` : cell(prLabel);
	if (pr.title) prLink += `<br>${cell(pr.title)}`;
	const focus = (v.focus || []).join("; ");
	out.push(
		`| ${cell(decisionLabel(v.decision))} | ${cell(title(v.risk || ""))} | ${cell(source(pr))} | ${cell(dateOf(pr.updatedAt))} | ${cell((pr.files || []).length)} | ${cell(row.coverage)} | ${cell(reasonLabel(row.reason))} | ${prLink} | ${cell(v.justification)} | ${cell(focus || "OK")} |`,
	);
}

const platforms = {};
const coverages = {};
for (const row of rows) {
	const p = row.pr.platform || "unknown";
	platforms[p] = (platforms[p] || 0) + 1;
	const c = row.coverage || "unknown";
	coverages[c] = (coverages[c] || 0) + 1;
}
const kv = (obj) =>
	Object.keys(obj)
		.sort()
		.map((k) => `${k}=${obj[k]}`)
		.join(", ");

out.push("");
out.push(
	`_Reviewed ${rows.length} PR(s). Sources: ${kv(platforms)}. Coverage: ${kv(coverages)}. Freshness: ${freshness}. Auto-deep: ${autoDeep ? "on" : "off"}. Deep mode: ${deep ? "on" : "off"}. Developer root: \`${developerRoot}\`. Conservative approval policy: ${approveOnlyLowRiskManual ? "on" : "off"}._`,
);
return out.join("\n");
