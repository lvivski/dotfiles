// Matcher and severity self-tests for the security-review workflow.
//   node --test .copilot/workflows/security-review.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const host = await import(resolve(here, "security-review.host.mjs"));
const workflowSource = readFileSync(resolve(here, "security-review.mjs"), "utf8");

// The workflow body is not a module: the harness wraps it and it uses a top-level return.
function loadWorkflowHelpers() {
	const slice = (marker) => {
		const at = workflowSource.indexOf(marker);
		assert.notEqual(at, -1, `missing ${marker}`);
		let depth = 0;
		for (let i = workflowSource.indexOf("{", at); i < workflowSource.length; i++) {
			if (workflowSource[i] === "{") depth++;
			else if (workflowSource[i] === "}" && --depth === 0) return workflowSource.slice(workflowSource.lastIndexOf("\n", at), i + 1);
		}
		throw new Error(`unterminated ${marker}`);
	};
	const body = [slice("const SEVERITY_MATRIX"), slice("function deriveSeverity"), slice("function validateFindings")].join("\n");
	return new Function(
		"TEXT_KEYS",
		"ANCHOR_PATTERN",
		`${body}; return { deriveSeverity, validateFindings };`,
	)(["vulnClass", "title", "source", "control", "sink", "counterEvidence", "description", "recommendation"], /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
}

const { deriveSeverity, validateFindings } = loadWorkflowHelpers();
const matchers = host.__matchers;

test("matcher registry is well formed", () => {
	assert.ok(matchers.length > 0, "no matchers exported");
	const slugs = new Set();
	for (const matcher of matchers) {
		assert.match(matcher.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `bad slug: ${matcher.slug}`);
		assert.ok(!slugs.has(matcher.slug), `duplicate slug: ${matcher.slug}`);
		slugs.add(matcher.slug);
		assert.ok(["precise", "normal", "noisy"].includes(matcher.tier), `bad tier on ${matcher.slug}`);
		assert.ok(Array.isArray(matcher.patterns) && matcher.patterns.length, `no patterns on ${matcher.slug}`);
		assert.ok(matcher.label && matcher.label.length <= 80, `bad label on ${matcher.slug}`);
		if (matcher.requires) {
			const { tech, sentinel } = matcher.requires;
			assert.ok(tech || sentinel, `empty requires on ${matcher.slug}`);
			if (tech) assert.ok(Array.isArray(tech) && tech.length, `empty requires.tech on ${matcher.slug}`);
			if (sentinel) assert.ok(Array.isArray(sentinel) && sentinel.length, `empty requires.sentinel on ${matcher.slug}`);
		}
	}
});

test("every matcher carries a reviewer note", () => {
	for (const matcher of matchers) {
		assert.ok(matcher.notes && matcher.notes.trim().length > 20, `${matcher.slug} needs a substantive note`);
		assert.ok(matcher.notes.length <= 500, `${matcher.slug} note is too long for the batch budget`);
	}
});

test("matcher examples match their own patterns", () => {
	for (const matcher of matchers) {
		assert.ok(Array.isArray(matcher.examples) && matcher.examples.length, `${matcher.slug} has no examples`);
		for (const example of matcher.examples) {
			const hit = matcher.patterns.some((pattern) => pattern.test(example));
			assert.ok(hit, `${matcher.slug} failed to match its own example: ${example}`);
		}
	}
});

test("matcher counter-examples do not match", () => {
	for (const matcher of matchers) {
		for (const counterExample of matcher.counterExamples || []) {
			const hit = matcher.patterns.some((pattern) => pattern.test(counterExample));
			assert.ok(!hit, `${matcher.slug} wrongly matched counter-example: ${counterExample}`);
		}
	}
});

test("matcher patterns are not catastrophically slow", () => {
	const payload = `${"a".repeat(2000)} ${"./x".repeat(400)}`;
	for (const matcher of matchers) {
		for (const pattern of matcher.patterns) {
			const started = process.hrtime.bigint();
			pattern.test(payload);
			const ms = Number(process.hrtime.bigint() - started) / 1e6;
			assert.ok(ms < 50, `${matcher.slug} pattern took ${ms.toFixed(1)}ms on a hostile line`);
		}
	}
});

test("tech detection never disables a matcher", () => {
	// activeMatchers takes no gating input by design: detection is advisory only.
	assert.equal(host.__activeMatchers().matchers.length, matchers.length);
	for (const slug of ["python-entry-point", "go-entry-point", "ruby-entry-point", "php-entry-point", "java-entry-point"]) {
		assert.ok(matchers.some((m) => m.slug === slug), `${slug} missing from the registry`);
	}
	// A polyglot repo whose root manifest is Node must still scan Python files.
	const python = matchers.find((m) => m.slug === "python-entry-point");
	assert.ok(host.__scanContent("svc/views.py", "@app.route('/users')", [python]).length > 0, "python matcher was suppressed");
});

test("every tech-gated matcher still carries path or content evidence", () => {
	for (const matcher of matchers) {
		if (!matcher.requires?.tech) continue;
		assert.ok(matcher.filePatterns || matcher.requires.sentinel, `${matcher.slug} relies on tech alone, which no longer gates`);
	}
});

test("sentinel gating suppresses matchers in the wrong kind of file", () => {
	const sentinelled = matchers.filter((matcher) => matcher.requires?.sentinel);
	assert.ok(sentinelled.length, "expected at least one sentinel-gated matcher");
	for (const matcher of sentinelled) {
		assert.ok(Array.isArray(matcher.sentinelExamples) && matcher.sentinelExamples.length, `${matcher.slug} needs sentinelExamples`);
		for (const sample of matcher.sentinelExamples) {
			assert.ok(matcher.requires.sentinel.some((pattern) => pattern.test(sample)), `${matcher.slug} sentinel does not match its own sentinelExample: ${sample}`);
		}
		const example = matcher.examples[0];
		assert.equal(host.__scanContent("probe.ts", example, [matcher]).length, 0, `${matcher.slug} fired without its sentinel`);
		assert.ok(host.__scanContent("probe.ts", `${matcher.sentinelExamples[0]}\n${example}`, [matcher]).length > 0, `${matcher.slug} did not fire with its sentinel present`);
	}
});

test("gated matchers are inert outside their file types", () => {
	for (const matcher of matchers) {
		if (!matcher.filePatterns) continue;
		const example = matcher.examples[0];
		const sentinel = matcher.sentinelExamples?.[0] ? `${matcher.sentinelExamples[0]}\n` : "";
		assert.equal(
			host.__scanContent("unrelated.txt", `${sentinel}${example}`, [matcher]).length,
			0,
			`${matcher.slug} fired on a path its filePatterns should exclude`,
		);
	}
});

test("severity matrix is mechanical and degrades safely", () => {
	const security = (impact, likelihood, immediateThreat = false) => deriveSeverity({ kind: "security", impact, likelihood, immediateThreat });
	assert.equal(security("high", "high"), "HIGH");
	assert.equal(security("high", "high", true), "CRITICAL");
	assert.equal(security("medium", "high", true), "MEDIUM", "critical gate applies only at high/high");
	assert.equal(security("high", "unknown"), "MEDIUM");
	assert.equal(security("unknown", "high"), "MEDIUM");
	assert.equal(security("medium", "medium"), "LOW");
	assert.equal(security("ignore", "high"), "IGNORE");
	assert.equal(security("high", "ignore"), "IGNORE");
	assert.equal(deriveSeverity({ kind: "bug", impact: "high", likelihood: "low" }), "HIGH_BUG");
	assert.equal(deriveSeverity({ kind: "bug", impact: "low", likelihood: "low" }), "BUG");
	assert.equal(deriveSeverity({ kind: "bug", impact: "ignore", likelihood: "low" }), "IGNORE");
	assert.equal(deriveSeverity({}), "LOW", "missing facts must degrade, never escalate");
});

test("finding validation enforces the evidence contract", () => {
	const batch = [{ filePath: "a.js" }];
	const base = {
		filePath: "a.js",
		anchor: "user-id-into-raw-sql",
		vulnClass: "sql-injection",
		title: "t",
		source: "s",
		control: "c",
		sink: "k",
		counterEvidence: "e",
		description: "d",
		recommendation: "r",
	};
	assert.deepEqual(validateFindings(batch, [base]), []);
	assert.match(validateFindings(batch, [{ ...base, anchor: "sql-injection-line-42" }])[0], /not a location/);
	assert.match(validateFindings(batch, [{ ...base, anchor: "Bad_Anchor" }])[0], /lowercase slug/);
	assert.match(validateFindings(batch, [{ ...base, anchor: "ab" }])[0], /lowercase slug/);
	assert.deepEqual(validateFindings(batch, [{ ...base, anchor: "md5-used-for-passwords" }]), [], "alphanumeric segments stay legal");
	assert.match(validateFindings(batch, [{ ...base, counterEvidence: "" }])[0], /counterEvidence/);
	assert.match(validateFindings(batch, [{ ...base, source: "   " }])[0], /source/);
	assert.match(validateFindings(batch, [{ ...base, filePath: "other.js" }])[0], /outside the batch/);
	assert.match(validateFindings(batch, Array(9).fill(base))[0], /at most 8/);
});

test("git refs reject argument injection", async () => {
	const ctx = { cwd: resolve(here, "..", ".."), dryRun: false };
	for (const bad of ["--upload-pack=evil", "-x", "a;b", "$(id)", "a b"]) {
		await assert.rejects(() => host.discover({ base: bad }, ctx), /not a valid git ref/, `accepted ${bad}`);
	}
	await assert.rejects(() => host.discover({ base: "no/such/ref/xyz" }, ctx), /does not resolve to a commit/);
	await assert.rejects(() => host.discover({ base: "HEAD", root: "src" }, ctx), /choose one scope/);
	await assert.rejects(() => host.discover({ head: "HEAD" }, ctx), /head requires base/);
});

test("artifact names cannot escape the artifact directory", async () => {
	const ctx = { cwd: resolve(here, "..", ".."), dryRun: false };
	for (const bad of ["../escape", "a/b", "", ".."]) {
		await assert.rejects(() => host.writeFindings({ root: ".", name: bad, findings: [] }, ctx), /invalid artifact name/, `accepted ${bad}`);
	}
	assert.equal(host.writeFindings.mutates, true, "writeFindings must be declared mutating so dry runs skip it");
});

// Real anchors observed across two consecutive live runs of the same file.
test("run-over-run reconciliation tolerates anchor wording drift", () => {
	const reconcile = loadReconciler();
	const prior = [
		{ filePath: "api.js", vulnClass: "command-injection", anchor: "query-param-into-shell-command" },
		{ filePath: "api.js", vulnClass: "debug-endpoint", anchor: "unauthenticated-env-dump-endpoint" },
		{ filePath: "api.js", vulnClass: "env-secret-fallback", anchor: "hardcoded-default-jwt-secret" },
		{ filePath: "api.js", vulnClass: "weak-crypto", anchor: "math-random-for-security-token" },
	];
	const current = [
		{ filePath: "api.js", vulnClass: "command-injection", anchor: "query-param-concatenated-into-shell-command" },
		{ filePath: "api.js", vulnClass: "sql-injection", anchor: "query-param-interpolated-into-raw-sql" },
		{ filePath: "api.js", vulnClass: "env-secret-fallback", anchor: "hardcoded-default-jwt-signing-secret" },
		{ filePath: "api.js", vulnClass: "mass-assignment", anchor: "request-body-spread-into-user-record-update" },
		{ filePath: "api.js", vulnClass: "weak-crypto", anchor: "math-random-used-for-security-token" },
	];
	const result = reconcile(prior, current);
	assert.equal(result.carried.length, 3, "three findings persisted across runs");
	assert.equal(result.approximate, 3, "all three matched by file and class, not exact anchor");
	assert.deepEqual(result.added.map((f) => f.vulnClass).sort(), ["mass-assignment", "sql-injection"]);
	assert.deepEqual(result.gone.map((f) => f.vulnClass), ["debug-endpoint"]);
});

test("run-over-run reconciliation prefers exact anchors and pairs one-to-one", () => {
	const reconcile = loadReconciler();
	const prior = [
		{ filePath: "a.js", vulnClass: "xss", anchor: "first-sink" },
		{ filePath: "a.js", vulnClass: "xss", anchor: "second-sink" },
	];
	const current = [
		{ filePath: "a.js", vulnClass: "xss", anchor: "second-sink" },
		{ filePath: "a.js", vulnClass: "xss", anchor: "third-sink" },
	];
	const result = reconcile(prior, current);
	assert.equal(result.carried.length, 2, "one exact match plus one class fallback");
	assert.equal(result.approximate, 1);
	assert.equal(result.added.length, 0);
	assert.equal(result.gone.length, 0, "a prior finding is consumed only once");
});

// Mirrors the reconciliation block in security-review.mjs.
function loadReconciler() {
	return (priorFindings, verified) => {
		const exactKey = (f) => `${f.filePath}:${f.vulnClass}:${f.anchor}`;
		const classKey = (f) => `${f.filePath}:${f.vulnClass}`;
		const priorPool = [...priorFindings];
		const carried = [];
		const added = [];
		let approximate = 0;
		const pending = [];
		for (const finding of verified) {
			const at = priorPool.findIndex((p) => exactKey(p) === exactKey(finding));
			if (at === -1) pending.push(finding);
			else {
				carried.push(finding);
				priorPool.splice(at, 1);
			}
		}
		for (const finding of pending) {
			const at = priorPool.findIndex((p) => classKey(p) === classKey(finding));
			if (at === -1) added.push(finding);
			else {
				carried.push(finding);
				priorPool.splice(at, 1);
				approximate++;
			}
		}
		return { carried, added, gone: priorPool, approximate };
	};
}

// Regression: a single-pass loop let an early class-fallback consume a prior that a later
// finding matched exactly, reporting the exact match as NEW.
test("reconciliation matches all exact anchors before any fallback", () => {
	const reconcile = loadReconciler();
	const prior = [{ filePath: "a.js", vulnClass: "xss", anchor: "anchor-x" }];
	const current = [
		{ filePath: "a.js", vulnClass: "xss", anchor: "anchor-y" },
		{ filePath: "a.js", vulnClass: "xss", anchor: "anchor-x" },
	];
	const result = reconcile(prior, current);
	assert.deepEqual(result.carried.map((f) => f.anchor), ["anchor-x"], "the exact match must win regardless of order");
	assert.deepEqual(result.added.map((f) => f.anchor), ["anchor-y"]);
	assert.equal(result.approximate, 0, "an exact match must not be counted as approximate");
	assert.equal(result.gone.length, 0);
});

test("the artifact directory is never scanned, even in direct mode", () => {
	for (const direct of [true, false]) {
		assert.equal(host.__safeFile(process.cwd(), ".security-review/findings-x.json", 200000, direct), false, `direct=${direct}`);
		assert.equal(host.__safeFile(process.cwd(), "sub/.security-review/findings-x.json", 200000, direct), false, `nested direct=${direct}`);
	}
});

test("per-file candidate caps keep precise anchors over noisy ones", () => {
	const noisy = { slug: "noisy-probe", label: "noisy", tier: "noisy", patterns: [/NOISE/] };
	const precise = { slug: "precise-probe", label: "precise", tier: "precise", patterns: [/PRECISE/] };
	// Noisy hits come first by line order and would fill the cap under registry ordering.
	const content = `${"NOISE\n".repeat(10)}PRECISE\n`;
	const hits = host.__scanContent("f.js", content, [noisy, precise]);
	assert.equal(hits.length, 11);
	const capped = host.__rankForCap(hits, 3);
	assert.ok(capped.some((c) => c.vulnClass === "precise-probe"), "the precise anchor was truncated away");
	assert.equal(capped.length, 3);
});
