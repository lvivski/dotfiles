// security-review.host.mjs — deterministic scope, candidate anchoring, and evidence validation.
//
// Regex matchers here are attention hints and a ranking key. They are deliberately NOT the finding
// ontology: investigation agents read whole files, follow imports, and may report anything they can
// evidence anywhere in the scope manifest.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const IGNORE_DIRS = new Set([".git", ".security-review", "node_modules", "vendor", "dist", "build", ".next", ".turbo", "coverage", "__pycache__", "__tests__", "test", "tests", "fixtures", "samples"]);
const SOURCE_EXTS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".cs", ".php",
	".swift", ".scala", ".clj", ".ex", ".exs", ".erl", ".hrl", ".lua", ".sh", ".bash", ".zsh", ".ps1", ".sql", ".tf",
	".yml", ".yaml", ".json", ".toml",
]);
// Security-relevant files that carry no extension.
const ARTIFACT_DIR = ".security-review";
const SOURCE_FILENAMES = new Set(["Dockerfile", "Containerfile", "Jenkinsfile", "Procfile"]);

const NOISE = { precise: 0, broad: 1 };
const SEVERITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW", "HIGH_BUG", "BUG"]);
const ROLES = new Set(["source", "control", "sink", "evidence"]);

// Severity is derived from frozen facts rather than argued by the model, so the same evidence
// always produces the same level. A severe consequence never decays to LOW because the path is
// awkward today: "hard to reach" describes the current code, not the damage. Unknown likelihood is
// absence of evidence, not evidence of safety.
const SEVERITY_MATRIX = {
	high: { high: "HIGH", medium: "HIGH", low: "MEDIUM", unknown: "MEDIUM" },
	medium: { high: "MEDIUM", medium: "MEDIUM", low: "LOW", unknown: "LOW" },
	low: { high: "LOW", medium: "LOW", low: "LOW", unknown: "LOW" },
	unknown: { high: "MEDIUM", medium: "LOW", low: "LOW", unknown: "LOW" },
};

// CRITICAL is reached only through named, checkable facts a verifier can re-derive from the code.
// There is deliberately no "would a triage team call this critical" flag: that is the subjective
// judgment this whole mechanism exists to remove.
export function deriveSeverity(finding) {
	const impact = String(finding?.impact || "unknown");
	const likelihood = String(finding?.likelihood || "unknown");
	if (impact === "ignore" || likelihood === "ignore") return "IGNORE";
	if (finding?.kind === "bug") return impact === "high" ? "HIGH_BUG" : "BUG";
	const level = SEVERITY_MATRIX[impact]?.[likelihood] || "LOW";
	if (level !== "HIGH") return level;
	const escalates = finding?.unauthenticated === true && (finding?.crossTenant === true || finding?.rceOrCredential === true);
	return escalates ? "CRITICAL" : "HIGH";
}

// Two tiers only, because the tier's single job is deciding what survives a cap.
// `examples`/`counterExamples` live in the test file: keeping literal vulnerable strings out of
// this module stops the scanner from ranking its own rule table as the repository's top target.
const MATCHERS = [
	{
		slug: "secrets-exposure",
		label: "hardcoded credential, key material, or secret fallback",
		tier: "precise",
		patterns: [
			/\b(api[_-]?key|secret|token|password|passwd|private[_-]?key)\b\s*[:=]\s*['"][^'"\n]{12,}/i,
			/-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
			/process\.env\.\w*(SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL)\w*\s*\|\|\s*['"][^'"]+['"]/i,
			/os\.environ\.get\s*\(\s*['"][^'"]*(SECRET|KEY|TOKEN|PASSWORD)[^'"]*['"]\s*,\s*['"][^'"]+['"]/i,
		],
		notes: "A placeholder, example, or test fixture is not a finding. Confirm the value is real, reachable, and shipped. A default secret is effectively public because it is identical in every deployment.",
	},
	{
		slug: "unsafe-deserialization",
		label: "deserialization of untrusted data",
		tier: "precise",
		patterns: [/\b(pickle|cPickle)\.loads?\s*\(/, /\byaml\.load\s*\(/, /\bMarshal\.load\s*\(/, /\bunserialize\s*\(/, /\bnew\s+ObjectInputStream\s*\(/],
		notes: "These formats instantiate arbitrary types, so reaching one with attacker bytes is remote code execution. A safe loader or schema-validated JSON parse defeats it.",
	},
	{
		slug: "raw-sql",
		label: "raw or string-built SQL",
		tier: "precise",
		patterns: [
			/\$(queryRaw|executeRaw)Unsafe\s*\(/,
			/\b(queryRawUnsafe|executeRawUnsafe|rawQuery)\s*\(/,
			/\bsql\.raw\s*\(/,
			/\bSELECT\b.+(\+|\$\{|%s|format\()/i,
			/\bexec\s*\(\s*[`'"]\s*select\b/i,
		],
		notes: "Flag interpolated SQL only when the interpolated value is attacker-reachable. Parameterized placeholders, ORM object filters, and tagged templates such as sql`` bind their arguments and are safe.",
	},
	{
		slug: "command-execution",
		label: "shell or process execution",
		tier: "precise",
		patterns: [/\b(exec|execFile|spawn|system|popen|ProcessBuilder|Runtime\.getRuntime\(\)\.exec)\s*\(/, /\bsubprocess\.(run|Popen|call|check_output)\s*\(/],
		notes: "Discrete argument arrays without a shell are safe. Flag shell:true, concatenation into a shell string, or user input reaching the command name.",
	},
	{
		slug: "dynamic-code-eval",
		label: "code or template compiled at runtime",
		tier: "precise",
		patterns: [/\bnew\s+Function\s*\(/, /\beval\s*\(/, /\brender_template_string\s*\(/, /\bjinja2\.Template\s*\(/, /\bHandlebars\.compile\s*\(/],
		notes: "Compiling a template or expression from user input executes in the host or engine context, which is usually full code execution. Passing user data as template variables is safe.",
	},
	{
		slug: "jwt-weak-verify",
		label: "unverified or weakly verified token",
		tier: "precise",
		patterns: [/\bjwt\.decode\s*\((?![^)]*algorithms)/, /algorithms?\s*[:=]\s*\[?\s*['"]none['"]/i, /ignoreExpiration\s*:\s*true/i, /verify_signature\s*[:=]\s*False/],
		notes: "Decoding without verifying, or accepting the none algorithm, means the token is attacker-authored. Verification must pin an explicit algorithm allowlist.",
	},
	{
		slug: "insecure-random-token",
		label: "security value from a non-cryptographic RNG",
		tier: "precise",
		patterns: [/\b(token|session|nonce|salt|otp|reset|verification|apikey)\w*\s*[:=]\s*(Math\.random|random\.random|rand\.Int)/i, /(Math\.random|random\.random)\s*\(\s*\)[^;\n]{0,40}\b(token|nonce|salt|otp|session)\b/i],
		notes: "These generators are predictably seeded, so a value that must be unguessable becomes guessable. crypto.randomBytes, secrets, or crypto/rand are the fix.",
	},
	{
		slug: "xxe",
		label: "XML parser with external entities",
		tier: "precise",
		patterns: [/resolve_entities\s*=\s*True/, /\bnoent\s*[:=]\s*(true|True)/, /DocumentBuilderFactory\.newInstance\s*\(/],
		notes: "External entity resolution turns XML parsing into file read and SSRF. Only a finding when the document is attacker-supplied and entity resolution is not disabled.",
	},
	{
		slug: "auth-bypass",
		label: "auth bypass or debug gate",
		tier: "precise",
		patterns: [/(skip[_-]?auth|disable[_-]?auth|bypass[_-]?auth|dev[_-]?auth|mock[_-]?user)/i, /\b(isAdmin|isAuthenticated|authorized|isSuperuser)\s*(={1,3}|!={1,2})\s*(true|1|['"]true['"])/i],
		notes: "Only middleware that wraps the handler directly counts as a control. Edge, proxy, CDN, and WAF rules are not sufficient alone because routes can escape their matchers.",
	},
	{
		slug: "http-entry-point",
		label: "HTTP route or handler",
		tier: "broad",
		patterns: [
			/\b(app|router|r|mux|e|bp|blueprint)\.(get|post|put|patch|delete|all|handle|handlefunc)\s*\(/i,
			/\bexport\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/,
			/@(app|router|bp|blueprint)\.(route|get|post|put|patch|delete)\s*\(/i,
			/@(RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\s*\(/,
			/\bRoute::(get|post|put|patch|delete|any)\s*\(/,
			/\bfunc\s+\w*\s*\([^)]*http\.ResponseWriter/,
			/\bclass\s+\w+Controller\b/,
		],
		notes: "Weak anchor: an entry point is only a finding when user input reaches a sink, or a sensitive operation runs with no authentication and no authorization check on the specific resource. Confirm the framework's own guard is absent before flagging.",
	},
	{
		slug: "server-action-or-rpc",
		label: "server action or RPC procedure",
		tier: "broad",
		patterns: [/['"]use server['"]/, /\bpublicProcedure\b/, /\bt\.procedure\b/, /\b(resolvers?|Query|Mutation)\s*[:=]\s*\{/],
		notes: "These are public POST endpoints with no implicit auth. Flag any that do not explicitly check both authentication and ownership of the record they touch; for GraphQL check field-level authorization, not just the top-level query.",
	},
	{
		slug: "auth-middleware",
		label: "auth middleware or guard",
		tier: "broad",
		patterns: [/\bexport\s+(async\s+)?function\s+middleware\s*\(/, /\bexport\s+const\s+config\s*=\s*\{[^}]*matcher/, /\b(before_action|skip_before_action)\b/, /\b(requireAuth|ensureAuthenticated|authGuard|login_required)\b/i],
		notes: "The gap is usually coverage, not logic: check which routes the matcher or filter misses, which actions skip it, and whether the decision reads a spoofable header.",
	},
	{
		slug: "webhook-receiver",
		label: "webhook receiver",
		tier: "broad",
		patterns: [/['"`][^'"`]*\/webhooks?\/[^'"`]*['"`]/i, /\bwebhook\w*\s*(handler|Handler|=|:)/],
		notes: "A webhook endpoint is public by definition, so it must verify a provider signature and reject replays. Report when no signature check precedes the side effect.",
	},
	{
		slug: "dangerous-html",
		label: "unsafe HTML rendering",
		tier: "broad",
		patterns: [/\b(dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|v-html)\b/, /\b(mark_safe|html_safe)\b/],
		notes: "Database-stored HTML is still untrusted. Flag unless a sanitizer sits between the data and the render. JSON embedded in a script tag needs `</` escaping too.",
	},
	{
		slug: "path-traversal",
		label: "file operation on a non-literal path",
		tier: "broad",
		patterns: [/\b(readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|sendFile|unlink|rename)\s*\(\s*(?!['"`])/, /\b(os\.Open|ioutil\.ReadFile|File\.open)\s*\(\s*(?!['"`])/],
		notes: "Requires attacker-controlled path segments. Resolve-then-verify-prefix, or a path built only from constants and validated identifiers, defeats this.",
	},
	{
		slug: "outbound-request",
		label: "server-side request to a non-literal destination",
		tier: "broad",
		patterns: [/\b(fetch|axios\.(get|post|put|request)|requests\.(get|post)|http\.get|https\.get|urlopen)\s*\(\s*(?!['"`])/],
		notes: "Only SSRF when the destination host is attacker-influenced. A constant base URL with an interpolated path segment usually is not; a host allowlist defeats it.",
	},
	{
		slug: "mass-assignment",
		label: "request body spread into a write",
		tier: "broad",
		patterns: [/\b(create|update|insert|save|build|upsert)\s*\([^)]*\.\.\.\s*(req|request)\.(body|query)/, /\.(create|update|insert|save|upsert)\s*\(\s*(req|request)\.body\s*[,)]/],
		notes: "Spreading a request body into a model write lets an attacker set fields the form never exposed, such as role, isAdmin, or ownerId. An explicit field pick defeats it.",
	},
	{
		slug: "tenant-scoped-lookup",
		label: "record lookup keyed by request-supplied identity",
		tier: "broad",
		patterns: [
			/\b(findOne|findById|findUnique|findFirst|get|delete|update)\s*\(\s*\{?\s*[^)]{0,60}\b(id|userId|teamId|orgId|accountId|tenantId)\b\s*:\s*(req|request|params|searchParams|query|body)\b/i,
			/\b(where|filter)\s*\(?\s*\{[^}]{0,60}\b(userId|teamId|orgId|accountId|tenantId)\b\s*:\s*(req|request|params|query|body)\b/i,
		],
		notes: "The classic IDOR and cross-tenant shape: the tenant or owner key comes from the request instead of the authenticated session. A finding when no ownership check ties the record back to the caller's identity.",
	},
	{
		slug: "agent-tool-surface",
		label: "model prompt or agent tool handler",
		tier: "broad",
		patterns: [
			/\b(registerTool|addTool|setRequestHandler)\s*\(\s*['"`]/,
			/CallToolRequestSchema/,
			/\b(prompt|messages|system|instructions)\s*[:=][^;\n]{0,80}\$\{/,
			/\.(complete|chat|invoke|generate|createMessage)\s*\(\s*[^)]*\b(req|request|input|userInput|body)\b/,
		],
		notes: "Text from files, pages, tickets, or tool output can carry instructions the model follows. Report when such data reaches a prompt and the model can then call a tool with side effects, or when a tool performs a privileged action with no per-call authorization.",
	},
	{
		slug: "infra-exposure",
		label: "privileged or publicly exposed infrastructure",
		tier: "broad",
		patterns: [/0\.0\.0\.0\/0/, /\bacl\s*=\s*['"]public-read/, /\bpublicly_accessible\s*=\s*true/, /"Principal"\s*:\s*"\*"/, /\bprivileged\s*:\s*true/, /\bUSER\s+root\b/, /hostNetwork\s*:\s*true/, /pull_request_target/, /permissions:\s*write-all/],
		notes: "Report when the exposed resource carries data or an admin port, or when a privileged workflow also checks out untrusted pull-request code. Open 80/443 on a public load balancer is usually intended; 22, 3389, or a database port is not.",
	},
	{
		slug: "weak-crypto",
		label: "weak hash or cipher protecting a security decision",
		tier: "broad",
		patterns: [/\b(md5|sha1|DES|RC4|ECB)\b/i],
		notes: "Hashing for a cache key, ETag, or non-security fingerprint is fine. Flag only when the weak primitive protects passwords, signatures, tokens, or identifiers that must be unguessable.",
	},
	{
		slug: "secret-in-log",
		label: "credential written to a log",
		tier: "broad",
		patterns: [/\b(console\.(log|info|warn|error|debug)|logger?\.(info|debug|warn|error)|print|println|fmt\.Print\w*)\s*\([^)\n]{0,120}\b(password|passwd|secret|token|api[_-]?key|credential|authorization)\b/i],
		notes: "Logs are retained longer and read more widely than the data they carry. Report when a real credential value, not merely its name, reaches the sink.",
	},
];

function positiveInt(value, fallback, name, max) {
	const number = Number(value ?? fallback);
	if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`security-review: ${name} must be an integer from 1 to ${max}`);
	return number;
}

function inside(base, value) {
	const path = resolve(base, value || ".");
	const rel = relative(base, path);
	if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`security-review: path escapes workflow cwd: ${value}`);
	return path;
}

function realInside(base, path) {
	const realBase = realpathSync(base);
	const realPath = realpathSync(path);
	const rel = relative(realBase, realPath);
	if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`security-review: real path escapes scope: ${path}`);
	return realPath;
}

function scopedPath(root, path) {
	return realInside(root, inside(root, path));
}

// ctx.cwd can contain a symlinked ancestor (macOS /tmp -> /private/tmp, container bind mounts, a
// symlinked home). discover() hands back a canonicalized absolute root and the workflow passes it
// straight to the other effects, so both sides are canonicalized here: comparing a raw path against
// a resolved one reads as an escape and would make every effect after discovery throw.
function rootOf(ctx, value) {
	const base = realpathSync(ctx.cwd);
	return realInside(base, resolve(base, String(value ?? ".")));
}

function relPath(root, path) {
	const rel = relative(root, path).replaceAll("\\", "/");
	return rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel) ? rel : null;
}

// Walk mode only. A file you explicitly changed or listed is always reviewed, tests included:
// `direct` callers bypass this. Test and spec files are excluded from repository sweeps because
// they are dense in mock credentials and sample payloads that anchor matchers without shipping.
function ignored(path) {
	const parts = path.split("/");
	if (parts.some((part) => IGNORE_DIRS.has(part))) return true;
	if (/\.(test|spec)\.[a-z]+$/i.test(path)) return true;
	return path.endsWith(".lock") || path.endsWith(".min.js") || path.endsWith(".map") || path.endsWith(".d.ts") || path.endsWith(".md") || path.endsWith(".mdx");
}

function safeFile(root, path, maxFileSize, direct) {
	if (!path || path.startsWith("../") || isAbsolute(path) || (!direct && ignored(path))) return false;
	// Our own output can contain verbatim secret-bearing evidence lines; never feed it back in.
	if (path === ARTIFACT_DIR || path.startsWith(`${ARTIFACT_DIR}/`) || path.includes(`/${ARTIFACT_DIR}/`)) return false;
	if (!direct && !SOURCE_EXTS.has(extname(path).toLowerCase()) && !SOURCE_FILENAMES.has(basename(path))) return false;
	try {
		const full = scopedPath(root, path);
		const stat = statSync(full);
		return stat.isFile() && stat.size <= maxFileSize;
	} catch {
		return false;
	}
}

function walk(root, maxFileSize) {
	const found = [];
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = resolve(dir, entry.name);
			const rel = relPath(root, full);
			if (!rel) continue;
			if (entry.isDirectory()) {
				if (!IGNORE_DIRS.has(entry.name)) visit(full);
			} else if (entry.isFile() && safeFile(root, rel, maxFileSize, false)) {
				found.push(rel);
			}
		}
	};
	visit(root);
	return found.sort();
}

function git(root, args) {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
	if (result.status !== 0) return null;
	return String(result.stdout || "")
		.split(/\r?\n/)
		.map((line) => line.trim().replaceAll("\\", "/"))
		.filter(Boolean);
}

function changedFiles(root) {
	let tracked = git(root, ["diff", "--name-only", "--relative", "--diff-filter=AMRC", "HEAD", "--", "."]);
	if (tracked == null) {
		const staged = git(root, ["diff", "--name-only", "--relative", "--cached", "--diff-filter=AMRC", "--", "."]) || [];
		const working = git(root, ["diff", "--name-only", "--relative", "--diff-filter=AMRC", "--", "."]) || [];
		tracked = [...staged, ...working];
	}
	const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "--", "."]) || [];
	return [...new Set([...tracked, ...untracked])].sort();
}

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]{0,254}$/;

// Refs reach git as argv entries, so a leading "-" would be parsed as a flag.
function checkedRef(root, value, name) {
	const ref = String(value ?? "").trim();
	if (!REF_PATTERN.test(ref)) throw new Error(`security-review: ${name} is not a valid git ref: ${value}`);
	if (!git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) throw new Error(`security-review: ${name} does not resolve to a commit: ${ref}`);
	return ref;
}

function branchDiffFiles(root, base, head) {
	const range = `${base}...${head}`;
	const changed = git(root, ["diff", "--name-only", "--relative", "--diff-filter=AMRC", range, "--", "."]);
	if (changed == null) throw new Error(`security-review: unable to diff ${range}`);
	return [...new Set(changed)].sort();
}

// Candidates are read from the working tree, so reviewing a ref we are not on would report findings
// against content that was never examined.
function requireCheckedOut(root, head) {
	const headSha = git(root, ["rev-parse", "--verify", "--quiet", `${head}^{commit}`])?.[0];
	const currentSha = git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?.[0];
	if (!headSha || !currentSha) throw new Error("security-review: unable to resolve HEAD for the branch diff");
	if (headSha !== currentSha) {
		throw new Error(
			`security-review: head (${head} = ${headSha.slice(0, 8)}) is not the checked-out commit (${currentSha.slice(0, 8)}). ` +
				"Files are reviewed from the working tree, so check that ref out first or omit head.",
		);
	}
}

// git() trims each line, so --porcelain status columns cannot be parsed positionally here.
function dirtyAmong(root, paths) {
	const selected = new Set(paths);
	const unstaged = git(root, ["diff", "--name-only", "--relative", "--", "."]) || [];
	const staged = git(root, ["diff", "--name-only", "--relative", "--cached", "--", "."]) || [];
	return [...new Set([...unstaged, ...staged])].filter((path) => selected.has(path)).sort();
}

function readText(path) {
	const data = readFileSync(path);
	if (data.includes(0)) throw new Error("binary file");
	return data.toString("utf8").replaceAll("\r\n", "\n");
}

const snippet = (line) => line.trim().replace(/\s+/g, " ").slice(0, 240);

function scanContent(path, content, matchers) {
	const candidates = [];
	for (const matcher of matchers) {
		if (matcher.filePatterns && !matcher.filePatterns.some((pattern) => pattern.test(path))) continue;
		// Whole-file precondition: the anchor only means anything in the right kind of file.
		if (matcher.requires?.sentinel && !matcher.requires.sentinel.some((pattern) => pattern.test(content))) continue;
		for (const [index, line] of content.split("\n").entries()) {
			if (!matcher.patterns.some((pattern) => pattern.test(line))) continue;
			candidates.push({
				vulnClass: matcher.slug,
				noiseTier: matcher.tier,
				line: index + 1,
				snippet: snippet(line),
				matchedPattern: matcher.label,
			});
		}
	}
	const unique = [];
	const seen = new Set();
	for (const candidate of candidates) {
		const key = `${candidate.vulnClass}:${candidate.line}:${candidate.matchedPattern}`;
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(candidate);
		}
	}
	return unique;
}

// Precise anchors must survive the per-file cap ahead of broad ones.
function rankForCap(candidates, maxPerFile) {
	if (candidates.length <= maxPerFile) return candidates;
	return [...candidates]
		.sort((left, right) => (NOISE[left.noiseTier] ?? 1) - (NOISE[right.noiseTier] ?? 1) || left.line - right.line)
		.slice(0, maxPerFile);
}

const MAX_CANDIDATES_PER_FILE = 20;

function scanFile(root, path, matchers) {
	const content = readText(scopedPath(root, path));
	const unique = scanContent(path, content, matchers);
	return {
		filePath: path,
		fileHash: createHash("sha256").update(content).digest("hex"),
		candidates: rankForCap(unique, MAX_CANDIDATES_PER_FILE),
	};
}

function rankRecord(record) {
	const tiers = record.candidates.map((candidate) => NOISE[candidate.noiseTier] ?? 1);
	const noise = tiers.length ? Math.min(...tiers) : 2;
	return [noise, -record.candidates.length, record.filePath];
}

function compareTuple(left, right) {
	for (let i = 0; i < left.length; i++) {
		if (left[i] < right[i]) return -1;
		if (left[i] > right[i]) return 1;
	}
	return 0;
}

const dirOf = (path) => {
	const at = path.lastIndexOf("/");
	return at === -1 ? "." : path.slice(0, at);
};

function groupByDirectory(records) {
	const byDir = new Map();
	for (const record of records) {
		const dir = dirOf(record.filePath);
		if (!byDir.has(dir)) byDir.set(dir, []);
		byDir.get(dir).push(record);
	}
	return byDir;
}

// A cap silently turns ranking into selection: whatever the matchers like best becomes the only
// thing reviewed, and unremarkable-looking authorization code is never read. So the budget is spent
// round-robin across directories, with a slice reserved for files no matcher anchored. The reserve
// is a floor, not a ceiling: whatever one pool cannot spend flows back to the other, so the review
// always uses the whole budget rather than shrinking to the size of the anchored pool.
function selectWithinCaps(records, maxFiles) {
	const directoriesTotal = groupByDirectory(records).size;
	if (records.length <= maxFiles) {
		return { kept: [...records], omitted: 0, directoriesTotal, directoriesCovered: directoriesTotal, unanchoredKept: records.filter((record) => !record.candidates.length).length };
	}
	const kept = [];
	// Returns whatever the budget could not take, so a later pass can spend the remainder.
	const drain = (pool, budget) => {
		if (budget <= 0 || !pool.length) return pool;
		const queues = [...groupByDirectory(pool).entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1)).map(([, group]) => group);
		let added = 0;
		while (added < budget) {
			let progressed = false;
			for (const queue of queues) {
				if (added >= budget) break;
				const next = queue.shift();
				if (!next) continue;
				kept.push(next);
				added++;
				progressed = true;
			}
			if (!progressed) break;
		}
		return queues.flat();
	};
	const unanchored = records.filter((record) => !record.candidates.length);
	const anchored = records.filter((record) => record.candidates.length);
	const spareUnanchored = drain(unanchored, Math.min(unanchored.length, Math.floor(maxFiles * 0.2)));
	const spareAnchored = drain(anchored, maxFiles - kept.length);
	drain(spareUnanchored, maxFiles - kept.length);
	drain(spareAnchored, maxFiles - kept.length);
	kept.sort((left, right) => compareTuple(rankRecord(left), rankRecord(right)));
	return {
		kept,
		omitted: records.length - kept.length,
		directoriesTotal,
		directoriesCovered: groupByDirectory(kept).size,
		unanchoredKept: kept.filter((record) => !record.candidates.length).length,
	};
}

// Related handlers, services, and helpers usually share a directory, so a directory-shaped batch
// hands the investigation its local call graph instead of an arbitrary slice of the rank order.
function batchByDirectory(records, batchSize) {
	const byDir = groupByDirectory(records);
	const batches = [];
	let current = [];
	for (const dir of [...byDir.keys()].sort()) {
		const group = byDir.get(dir);
		if (group.length >= batchSize) {
			if (current.length) {
				batches.push(current);
				current = [];
			}
			for (let at = 0; at < group.length; at += batchSize) batches.push(group.slice(at, at + batchSize));
			continue;
		}
		if (current.length + group.length > batchSize) {
			batches.push(current);
			current = [];
		}
		current.push(...group);
	}
	if (current.length) batches.push(current);
	return batches;
}

export async function discover(input = {}, ctx) {
	const opts = input && typeof input === "object" && !Array.isArray(input) ? input : {};
	const hasFiles = Array.isArray(opts.files) && opts.files.length > 0;
	const scopes = [opts.root ? "root" : null, hasFiles ? "files" : null, opts.base ? "base" : null].filter(Boolean);
	if (scopes.length > 1) throw new Error(`security-review: choose one scope, not ${scopes.join(" and ")}`);
	if (opts.head && !opts.base) throw new Error("security-review: head requires base");
	const root = rootOf(ctx, opts.root || ".");
	if (!statSync(root).isDirectory()) throw new Error(`security-review: root is not a directory: ${opts.root}`);
	const maxFileSize = 200000;
	const maxFiles = positiveInt(opts.max_files, 60, "max_files", 400);
	const batchSize = positiveInt(opts.batch_size, 5, "batch_size", 20);

	let selected;
	let source;
	let direct = false;
	let branchDiffDirty = [];
	if (hasFiles) {
		direct = true;
		source = "explicit files";
		selected = [...new Set(opts.files.map((path) => String(path).replace(/^\/+/, "")).filter((path) => safeFile(root, path, maxFileSize, true)))].sort();
	} else if (opts.base) {
		const base = checkedRef(root, opts.base, "base");
		const head = checkedRef(root, opts.head ?? "HEAD", "head");
		requireCheckedOut(root, head);
		direct = true;
		source = `branch diff ${base}...${head}`;
		selected = branchDiffFiles(root, base, head).filter((path) => safeFile(root, path, maxFileSize, true));
		branchDiffDirty = dirtyAmong(root, selected);
	} else if (opts.root) {
		source = `root:${opts.root}`;
		selected = walk(root, maxFileSize);
	} else {
		const changed = changedFiles(root).filter((path) => safeFile(root, path, maxFileSize, true));
		if (changed.length) {
			direct = true;
			source = "staged, unstaged, and untracked changes";
			selected = changed;
		} else {
			source = "repository scan (no local changes)";
			selected = walk(root, maxFileSize);
		}
	}

	// Every eligible file becomes a review record, anchored or not. Dropping unanchored files here
	// would make the matchers the real selector and leave the reserved slice below with nothing to
	// protect: unremarkable-looking authorization code is exactly what regexes cannot see.
	const records = [];
	let unreadable = 0;
	for (const path of selected) {
		try {
			records.push(scanFile(root, path, MATCHERS));
		} catch {
			unreadable++;
		}
	}
	records.sort((left, right) => compareTuple(rankRecord(left), rankRecord(right)));
	const preCapRecords = records.length;
	const selection = selectWithinCaps(records, maxFiles);

	// Supporting evidence may live in any reviewable file, including one this scope never selected:
	// a handler under review can reach a sink in an untouched service. The manifest is the set of
	// files a finding is allowed to cite, and it is always the whole eligible tree.
	const manifest = [...new Set([...walk(root, maxFileSize), ...selection.kept.map((record) => record.filePath)])].sort();

	const boundaries = [];
	if (selection.omitted) {
		boundaries.push(
			`Reviewed ${selection.kept.length}/${preCapRecords} eligible file(s) (max_files=${maxFiles}); ${selection.omitted} omitted. ` +
				`Directory coverage ${selection.directoriesCovered}/${selection.directoriesTotal}; ${selection.unanchoredKept} file(s) with no matcher hit were reviewed anyway.`,
		);
	}
	if (unreadable) boundaries.push(`${unreadable} selected file(s) were unreadable or binary.`);
	if (branchDiffDirty.length) {
		boundaries.push(
			`${branchDiffDirty.length} file(s) in the diff have uncommitted changes; the review covers the working tree, not the committed diff: ${branchDiffDirty.slice(0, 5).join(", ")}${branchDiffDirty.length > 5 ? ", ..." : ""}.`,
		);
	}

	const presentSlugs = new Set(selection.kept.flatMap((record) => record.candidates.map((candidate) => candidate.vulnClass)));
	const slugNotes = {};
	for (const matcher of MATCHERS) if (matcher.notes && presentSlugs.has(matcher.slug)) slugNotes[matcher.slug] = matcher.notes;

	return {
		root,
		source,
		direct,
		matchersTotal: MATCHERS.length,
		slugNotes,
		selectedCount: selected.length,
		preCapRecords,
		records: selection.kept,
		batches: batchByDirectory(selection.kept, batchSize),
		manifest,
		manifestCount: manifest.length,
		reviewPaths: selection.kept.map((record) => record.filePath),
		candidateCount: selection.kept.reduce((count, record) => count + record.candidates.length, 0),
		unreadable,
		boundaries,
	};
}

function evidenceFor(lines, line) {
	const start = Math.max(0, line - 3);
	const end = Math.min(lines.length, line + 2);
	return lines
		.slice(start, end)
		.map((text, index) => `${start + index + 1}: ${text}`)
		.join("\n")
		.slice(0, 2000);
}

// The batch is an attention boundary, not a reporting boundary: a finding may name any file in the
// scope manifest so handler -> service -> DAO chains can be reported at the place that must change.
// Every cited location is still re-read from disk, and any file we hashed at discovery must still
// match that hash, so nothing is reported against content nobody examined.
export async function validateFindings(input = {}, ctx) {
	const root = rootOf(ctx, input.root);
	const manifest = new Set((Array.isArray(input.manifest) ? input.manifest : []).map(String));
	const reviewPaths = new Set((Array.isArray(input.reviewPaths) ? input.reviewPaths : []).map(String));
	const discoveryHashes = new Map((Array.isArray(input.records) ? input.records : []).map((record) => [String(record.filePath), String(record.fileHash || "")]));
	const requireReviewTouch = Boolean(input.requireReviewTouch);
	const cache = new Map();
	const readOnce = (filePath) => {
		if (!cache.has(filePath)) {
			const content = readText(scopedPath(root, filePath));
			cache.set(filePath, { lines: content.split("\n"), hash: createHash("sha256").update(content).digest("hex") });
		}
		return cache.get(filePath);
	};
	const locate = (filePath, line) => {
		if (!manifest.has(filePath)) return { error: "file is outside the reviewed scope" };
		const file = readOnce(filePath);
		const expected = discoveryHashes.get(filePath);
		if (expected && expected !== file.hash) return { error: "file changed after discovery" };
		if (!Number.isInteger(line) || line < 1 || line > file.lines.length) return { error: "line is outside the current file" };
		return { file };
	};

	const valid = [];
	const rejected = [];
	const seen = new Set();
	let suppressed = 0;
	for (const finding of Array.isArray(input.findings) ? input.findings : []) {
		const filePath = String(finding?.filePath || "").replace(/^\/+/, "");
		const line = Number(finding?.line);
		try {
			// Policy suppression runs before any evidence work: self-only harm, unachievable
			// preconditions, and privileged-only reach are not worth a disk read or a verifier call.
			const severity = deriveSeverity(finding);
			if (severity === "IGNORE") {
				suppressed++;
				continue;
			}
			if (!SEVERITIES.has(severity)) {
				rejected.push({ finding, reason: "severity could not be derived" });
				continue;
			}
			const primary = locate(filePath, line);
			if (primary.error) {
				rejected.push({ finding, reason: primary.error });
				continue;
			}
			const anchor = String(finding.anchor || "").trim();
			if (!anchor) {
				rejected.push({ finding, reason: "missing semantic anchor" });
				continue;
			}
			const supporting = [];
			let supportingError = null;
			for (const entry of Array.isArray(finding.supporting) ? finding.supporting.slice(0, 6) : []) {
				const supportPath = String(entry?.filePath || "").replace(/^\/+/, "");
				const supportLine = Number(entry?.line);
				const found = locate(supportPath, supportLine);
				if (found.error) {
					supportingError = `supporting location ${supportPath}:${entry?.line} ${found.error}`;
					break;
				}
				supporting.push({ filePath: supportPath, line: supportLine, role: ROLES.has(String(entry?.role)) ? String(entry.role) : "evidence" });
			}
			if (supportingError) {
				rejected.push({ finding, reason: supportingError });
				continue;
			}
			// In a change-scoped review the finding must touch the change, or every pre-existing
			// bug in the repository would land in a pull-request report.
			if (requireReviewTouch && !reviewPaths.has(filePath) && !supporting.some((entry) => reviewPaths.has(entry.filePath))) {
				rejected.push({ finding, reason: "no cited location falls inside the reviewed change" });
				continue;
			}
			const signature = `${filePath}:${String(finding.vulnClass || "")}:${anchor}`;
			if (seen.has(signature)) continue;
			seen.add(signature);
			valid.push({ ...finding, severity, filePath, line, supporting, fileHash: primary.file.hash, evidence: evidenceFor(primary.file.lines, line) });
		} catch (error) {
			rejected.push({ finding, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { valid, rejected, suppressed };
}

const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const artifactStamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");

export async function writeFindings(input = {}, ctx) {
	const root = rootOf(ctx, input.root);
	const label = String(input.name ?? artifactStamp()).trim();
	if (!ARTIFACT_NAME_PATTERN.test(label)) throw new Error(`security-review: invalid artifact name: ${input.name}`);
	mkdirSync(resolve(root, ARTIFACT_DIR), { recursive: true });
	// realpath after mkdir: a symlinked artifact directory would otherwise escape the root.
	const dir = realInside(root, resolve(root, ARTIFACT_DIR));
	const fileName = `findings-${label}.json`;
	const target = resolve(dir, fileName);
	if (relative(dir, target) !== fileName) throw new Error("security-review: artifact path escaped the artifact directory");
	if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("security-review: refusing to write through a symlink");
	const document = {
		schemaVersion: "1.0",
		documentType: "security-review.findings",
		generatedAt: new Date().toISOString(),
		scope: input.scope ?? null,
		root: relative(ctx.cwd, root) || ".",
		stats: input.stats ?? {},
		boundaries: Array.isArray(input.boundaries) ? input.boundaries : [],
		findings: Array.isArray(input.findings) ? input.findings : [],
	};
	writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return { path: relative(ctx.cwd, target), count: document.findings.length };
}
writeFindings.mutates = true;

const CONTEXT_SOURCES = [".security-review/CONTEXT.md", "SECURITY.md", ".github/SECURITY.md", "docs/SECURITY.md"];
const CONTEXT_LIMIT = 8000;

// Policy data, never instructions: the caller wraps this in the untrusted-input rule.
// In branch-diff mode the policy is read from the base ref, so a change under review cannot
// widen its own exemptions.
export async function resolveContext(input = {}, ctx) {
	const root = rootOf(ctx, input.root);
	const inline = String(input.context ?? "").trim();
	if (inline) return { source: "inline args.context", text: inline.slice(0, CONTEXT_LIMIT), truncated: inline.length > CONTEXT_LIMIT, trusted: true };
	const base = String(input.base ?? "").trim();
	if (base && REF_PATTERN.test(base)) {
		for (const candidate of CONTEXT_SOURCES) {
			const lines = git(root, ["show", `${base}:${candidate}`]);
			if (!lines?.length) continue;
			const text = lines.join("\n").trim();
			if (!text) continue;
			return { source: `${candidate} @ ${base}`, text: text.slice(0, CONTEXT_LIMIT), truncated: text.length > CONTEXT_LIMIT, trusted: true };
		}
		return { source: null, text: "", truncated: false, trusted: true };
	}
	for (const candidate of CONTEXT_SOURCES) {
		try {
			const full = scopedPath(root, candidate);
			if (!statSync(full).isFile()) continue;
			const text = readText(full).trim();
			if (!text) continue;
			return { source: candidate, text: text.slice(0, CONTEXT_LIMIT), truncated: text.length > CONTEXT_LIMIT, trusted: false };
		} catch {
			/* absent or unreadable */
		}
	}
	return { source: null, text: "", truncated: false, trusted: false };
}

// Test-only surface; not part of the workflow host effect contract.
export const __matchers = MATCHERS;
export const __scanContent = scanContent;
export const __safeFile = safeFile;
export const __rankForCap = rankForCap;
export const __selectWithinCaps = selectWithinCaps;
export const __batchByDirectory = batchByDirectory;
