import { arrayOf, isList, isRecord, nullable, property, readBoolean, readJsonValue, readNumber, readString, recordOf } from "../data.mjs";
import { safeJson } from "../prompt.mjs";
import { diffLineChanges, evidenceFacts } from "./evidence.mjs";

/** @typedef {Exclude<Awaited<ReturnType<typeof import("./preparation.mjs").prepareQueue>>, string>["prs"][number]} QueuedPullRequest */
/** @typedef {QueuedPullRequest["units"][number]} DiffUnit */

/** @param {Pick<import("@github/copilot-sdk").WorkflowContext, "args" | "phase" | "agent" | "pipeline" | "parallel" | "step" | "log" | "pause">} workflow */
export async function prepareQueue(workflow) {
	const workflowArgs = workflow.args;
	const opts =
		isRecord(workflowArgs)
			? workflowArgs
			: {};
	if (opts.pauseBeforeWork !== undefined && typeof opts.pauseBeforeWork !== "boolean") {
		throw new Error("review-queue: pauseBeforeWork must be a boolean");
	}
	const input = opts.prs ?? workflowArgs;
	const fetch = isRecord(opts.fetch) ? opts.fetch : {};
	const fetchComplete = fetch.version === 1
		&& fetch.complete === true && isList(fetch.failures) && fetch.failures.length === 0;
	const fetchFailures = fetchComplete ? [] : (
		isList(fetch.failures) && fetch.failures.length
			? fetch.failures.map((entry) => `${property(entry, "platform") || "provider"}/${property(entry, "account") || "unknown account"}: ${property(entry, "stage") || "fetch"}: ${property(entry, "message") || "Unknown fetch failure"}`)
			: ["Invalid or incomplete fetch manifest."]
	);
	if (!isList(input) || !input.length) {
		if (!fetchComplete) return `# Review queue incomplete\n\nNo PRs were returned, but the queue could not be fully fetched.\n\n${fetchFailures.map((failure) => `- ${failure}`).join("\n")}`;
		return "review-queue: no PRs supplied. Fetch the queue first and pass { prs: [...] }.";
	}

	/** @param {string} name @param {number} fallback @param {number} minimum */
	function integer(name, fallback, minimum) {
		const value = Number(opts[name] ?? fallback);
		if (!Number.isSafeInteger(value) || value < minimum) {
			throw new Error(`review-queue: ${name} must be a safe integer of at least ${minimum}`);
		}
		return value;
	}

	const chunkChars = integer("diff_chunk_chars", 24000, 1);
	const maxChunks = opts.max_total_chunks === undefined ? undefined : integer("max_total_chunks", 0, 1);
	const identities = new Set();
	/** @param {unknown} raw @param {number} index */
	function normalizePullRequest(raw, index) {
		if (!isRecord(raw)) {
			throw new Error(`review-queue: PR ${index + 1} must be an object`);
		}
		const repo = String(raw.repo || "").trim();
		const number = Number(raw.number);
		if (!repo || !Number.isInteger(number) || number < 1) {
			throw new Error(`review-queue: PR ${index + 1} needs repo and a positive number`);
		}
		const facts = evidenceFacts(raw, repo, number);
		const identityKey = facts.sourceKey;
		if (identities.has(identityKey)) {
			throw new Error(`review-queue: duplicate PR ${repo}#${number}`);
		}
		identities.add(identityKey);
		const rawFiles = isList(raw.files) ? raw.files : [];
		const files = [...new Set(rawFiles.map(String).filter(Boolean))];
		const diff = String(raw.diff || "");
		if (maxChunks !== undefined && diff.length > chunkChars * maxChunks) {
			throw new Error(
				`review-queue: PR ${index + 1} diff exceeds the configured chunk budget`,
			);
		}
		return {
			repo,
			number,
			title: String(raw.title || ""),
			diff,
			lineChanges: diffLineChanges(diff),
			files,
			me: String(raw.me || ""),
			myTeams: (isList(raw.my_teams) ? raw.my_teams : []).map(String),
			reviewers: (isList(raw.reviewers) ? raw.reviewers : []).filter(Boolean).map((entry) => readJsonValue(entry)),
			codeowners: String(raw.codeowners || ""),
			coverage: String(raw.coverage || ""),
			platform: String(raw.platform || ""),
			url: String(raw.url || ""),
			updatedAt: String(raw.updatedAt || ""),
			freshness: raw.freshness && typeof raw.freshness === "object" ? readJsonValue(raw.freshness) : null,
			...facts,
		};
	}
	const normalized = input.map(normalizePullRequest);
	/** @typedef {ReturnType<typeof normalizePullRequest>} PullRequest */
	/** @typedef {{id: string, content: string}} DiffUnit */
	/** @typedef {Omit<PullRequest, "diff"> & {units: DiffUnit[]}} PreparedPullRequest */
	/** @typedef {PreparedPullRequest & {reason: string}} QueuedPullRequest */

	/** @param {unknown} value */
	const identity = (value) => {
		const text = String(value || "").trim().toLowerCase();
		return !text ? "" : text.startsWith("@") || text.includes("@") ? text : `@${text}`;
	};

	/** @param {string} pattern */
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

	/** @param {Omit<PullRequest, "diff">} pr */
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
			/** @type {string[]} */
			let owners = [];
			for (const rule of rules) {
				const raw = rule.pattern.replace(/^\/+/, "").replace(/\/+$/, "");
				if (!raw) continue;
				const prefix = rule.pattern.startsWith("/") || raw.includes("/") ? "^" : "(?:^|.*/)";
				const suffix = rule.pattern.endsWith("/") ? "/.*"
					: /[*?]/.test(raw.split("/").at(-1) ?? "") ? "" : "(?:/.*)?";
				if (new RegExp(`${prefix}${globSource(raw)}${suffix}$`).test(file)) owners = rule.owners;
			}
			if (owners.some((owner) => mine.has(identity(owner)))) return "codeowner";
		}
		if (pr.platform === "azure") {
			if (pr.assignments.some((assignment) => property(assignment, "required") === true)) return "required-policy";
			return pr.assignments.length && property(property(pr.evidence, "completeness"), "assignments") === true ? "manual" : "unknown";
		}
		if (
			pr.reviewers.some(
				(reviewer) => property(reviewer, "required") && mine.has(identity(property(reviewer, "name"))),
			)
		) {
			return "required-policy";
		}
		return "manual";
	}

	/** @param {PullRequest} pr */
	function preparePullRequest(pr) {
		const { diff, ...metadata } = pr;
		const parts = [];
		if (diff.trim()) {
			for (let offset = 0; offset < diff.length; offset += chunkChars) {
				parts.push({
					id: String(parts.length + 1),
					content: diff.slice(offset, offset + chunkChars),
				});
			}
		}
		return { ...metadata, units: parts };
	}

	const selectedChunks = normalized.reduce(
		(total, pr) => total + (pr.diff.trim() ? Math.ceil(pr.diff.length / chunkChars) : 0), 0,
	);
	if (maxChunks !== undefined && selectedChunks > maxChunks) {
		throw new Error(`review-queue: ${selectedChunks} diff chunks exceed max_total_chunks=${maxChunks}`);
	}
	const readPreparedPr = recordOf({
		repo: readString, number: readNumber, title: readString,
		lineChanges: recordOf({ additions: nullable(readNumber), deletions: nullable(readNumber), net: nullable(readNumber), incomplete: readBoolean }),
		files: arrayOf(readString), me: readString, myTeams: arrayOf(readString), reviewers: arrayOf((value) => readJsonValue(value)),
		codeowners: readString, coverage: readString, platform: readString, url: readString, updatedAt: readString,
		freshness: (value) => readJsonValue(value), evidence: (value) => readJsonValue(value),
		evidenceComplete: readBoolean, evidenceFailures: arrayOf(readString), assignments: arrayOf((value) => readJsonValue(value)),
		sourceKey: readString, units: arrayOf(recordOf({ id: readString, content: readString })),
	});
	const prepared = recordOf({
		prs: arrayOf(readPreparedPr), evidenceCount: readNumber, approveOnlyLowRiskManual: readBoolean,
		freshness: readString, fetchComplete: readBoolean, fetchFailures: arrayOf(readString),
	})(await workflow.step(
		"review-queue:prepared-queue:v3",
		() => ({
			prs: normalized.map(preparePullRequest),
			evidenceCount: selectedChunks,
			approveOnlyLowRiskManual: Boolean(opts.approve_only_low_risk_manual),
			freshness: String(opts.freshness ?? "input queue"),
			fetchComplete,
			fetchFailures,
		}),
	));
	const { evidenceCount, approveOnlyLowRiskManual, freshness } = prepared;
	const prs = prepared.prs.map((pr) => ({ ...pr, reason: codeownerReason(pr) }));
	const queueComplete = prepared.fetchComplete;
	const queueFailures = prepared.fetchFailures;
	workflow.log(`review-queue: ${prs.length} PR(s), ${evidenceCount} diff chunk(s)`);
	if (opts.pauseBeforeWork) {
		workflow.log(`review-queue: prepared queue ${safeJson({
			prs: prs.map(({ repo, number, title, files, coverage, updatedAt, reason, units, evidence, assignments, evidenceComplete }) => ({
				repo, number, title, files, coverage, updatedAt, reason, chunks: units.length,
				evidence, assignments, evidenceComplete,
			})),
			approveOnlyLowRiskManual, freshness, fetchComplete: queueComplete, fetchFailures: queueFailures,
		}, 0)}`);
		await workflow.pause("review-queue:before-review:v2");
	}
	return { prs, queueComplete, queueFailures, approveOnlyLowRiskManual, evidenceCount, freshness };
}
