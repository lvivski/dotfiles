import { isUtf8 } from "node:buffer";
import { realpathSync } from "node:fs";
import path from "node:path";
import { commitAt, committedFile, git, rootAt } from "./product.mjs";
import { fail, fields, name, record, relative, text, waitTarget } from "./values.mjs";

/** @satisfies {import("@github/copilot-sdk").CustomAgentConfig} */
export const researchAgent = {
	name: "foundry-research", description: "Answer one Foundry planning question using source and public documentation.",
	tools: ["glob", "rg", "view", "foundry_reference", "web_search", "web_fetch"], infer: true,
	prompt: "Use only permitted sources. Never send private source, identifiers or credentials to external services. Attribute findings; missing evidence is unknown, not a product gap.",
};

const string = { type: "string" };
export const researchSchema = {
	type: "object", additionalProperties: false, required: ["status", "reason", "findings"],
	properties: { status: { type: "string", enum: ["answered", "unknown"] }, reason: string, waitFor: string,
		references: { type: "array", items: { type: "object", additionalProperties: false, required: ["repo", "revision"],
			properties: { repo: string, revision: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" } } } },
		findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "source", "finding"],
			properties: { kind: string, source: string, finding: string } } } },
};

/** @param {unknown} v @returns {import("./model.js").Finding[]} */
function findings(v) {
	if (!Array.isArray(v)) fail("invalid_research", "Expected a list of cited research findings");
	return v.map(value => {
		const f = record(value);
		fields(f, ["kind", "source", "finding"]);
		return { kind: text(f.kind, "source kind"), source: text(f.source, "source locator"), finding: text(f.finding, "finding") };
	});
}

/** @param {unknown} value */
function references(value) {
	if (!Array.isArray(value)) fail("invalid_research", "Expected a list of shared reference revisions");
	const seen = new Set();
	return value.map(v => {
		const p = record(v); fields(p, ["repo", "revision"]);
		const repo = name(p.repo, "reference checkout"), revision = text(p.revision, "reference revision");
		if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision) || seen.has(repo))
			fail("invalid_research", `Expected one full immutable commit for ${repo}`);
		seen.add(repo); return { repo, revision };
	});
}

/** Use the product's primary worktree, not a transient writer worktree, to locate its sibling.
 * @param {string} cwd @param {import("./model.js").Reference} pin @param {string} file */
export function referenceText(cwd, pin, file) {
	const first = git(cwd, ["worktree", "list", "--porcelain", "-z"]).toString().split("\0", 1)[0];
	if (!first.startsWith("worktree ")) fail("missing_reference", "Missing primary product worktree");
	const primary = realpathSync(first.slice(9)), repo = path.join(path.dirname(primary), name(pin.repo, "reference checkout"));
	if (repo === primary || realpathSync(repo) !== repo || rootAt(repo) !== repo || commitAt(repo, pin.revision) !== pin.revision)
		fail("missing_reference", `No matching sibling checkout and commit for ${pin.repo}@${pin.revision}`);
	const bytes = committedFile(repo, pin.revision, relative(file));
	if (bytes.includes(0) || !isUtf8(bytes)) fail("unsupported_reference", "The pinned blob is not UTF-8 text; no visual observation was made");
	return bytes.toString("utf8");
}

/** Only the bound research review uses this wire format. Its sources remain
 * attributed observations, not charter file citations or evaluator receipts.
 * @param {unknown} raw @param {string} charter @returns {import("./model.js").Observation} */
export function researchResult(raw, charter) {
	if (raw === null) return { outcome: "unresolved", reason: "The research agent returned no evidence. The question remains unresolved.",
		evidence: [charter], grains: [], findings: [] };
	const result = record(raw);
	fields(result, ["status", "reason", "findings", "references", "waitFor"]);
	const cited = findings(result.findings), reason = text(result.reason, "research reason");
	if (result.status !== "unknown" && !(result.status === "answered" && cited.length))
		fail("invalid_research", "An answered investigation requires cited findings; otherwise report unknown");
	if (result.waitFor !== undefined && result.status !== "unknown") fail("invalid_research", "Only an unresolved researcher may wait for a producer");
	return { outcome: result.status === "answered" ? "researched" : result.waitFor !== undefined ? "waiting" : "unresolved",
		...(result.waitFor !== undefined ? { waitFor: waitTarget(result.waitFor) } : {}),
		...(result.references !== undefined ? { references: references(result.references) } : {}), reason, evidence: [charter], grains: [], findings: cited };
}
