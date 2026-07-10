import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const IGNORE_DIRS = new Set([".git", ".deepsec", ".security-review", "node_modules", "vendor", "dist", "build", ".next", ".turbo", "coverage", "__pycache__", "__tests__", "test", "tests", "fixtures", "samples"]);
const SOURCE_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rb",
	".go",
	".rs",
	".java",
	".kt",
	".kts",
	".cs",
	".php",
	".swift",
	".scala",
	".clj",
	".ex",
	".exs",
	".erl",
	".hrl",
	".lua",
	".sh",
	".bash",
	".zsh",
	".ps1",
	".sql",
	".tf",
	".yml",
	".yaml",
	".json",
	".toml",
]);
const NOISE = { precise: 0, normal: 1, noisy: 2 };
const SEVERITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "HIGH_BUG", "BUG", "LOW"]);

const MATCHERS = [
	{
		slug: "secrets-exposure",
		label: "secret-looking assignment",
		tier: "precise",
		patterns: [/\b(api[_-]?key|secret|token|password|passwd|private[_-]?key)\b\s*[:=]\s*['"][^'"\n]{12,}/i, /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
	},
	{
		slug: "sql-injection",
		label: "raw SQL or string-built query",
		tier: "normal",
		patterns: [/\b(queryRawUnsafe|executeRawUnsafe|rawQuery|raw\s*\(|exec\s*\(\s*[`'"]\s*select\b)/i, /\bSELECT\b.+(\+|\$\{|%s|format\()/i],
	},
	{
		slug: "command-injection",
		label: "shell command execution",
		tier: "normal",
		patterns: [/\b(exec|execFile|spawn|system|popen|ProcessBuilder|Runtime\.getRuntime\(\)\.exec)\s*\(/, /\bsubprocess\.(run|Popen|call|check_output)\s*\(/],
	},
	{
		slug: "path-traversal",
		label: "path/file operation with dynamic input",
		tier: "normal",
		patterns: [/\b(readFile|writeFile|createReadStream|createWriteStream|sendFile|open|unlink|rename)\s*\(/, /\b(path\.join|Path\(|filepath\.Join|os\.Open)\s*\(/],
	},
	{
		slug: "ssrf",
		label: "server-side fetch/request",
		tier: "normal",
		patterns: [/\b(fetch|axios\.|request\.|http\.get|https\.get|urllib\.request|requests\.(get|post)|Net::HTTP)\b/],
	},
	{ slug: "open-redirect", label: "redirect sink", tier: "normal", patterns: [/\b(redirect|res\.redirect|NextResponse\.redirect|RedirectResponse|sendRedirect)\s*\(/] },
	{
		slug: "dangerous-html",
		label: "unsafe HTML rendering",
		tier: "normal",
		patterns: [/\b(dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|v-html)\b/, /\b(render_template_string|mark_safe|html_safe|raw\()\b/],
	},
	{
		slug: "auth-bypass",
		label: "auth bypass or debug gate",
		tier: "normal",
		patterns: [/(skip[_-]?auth|disable[_-]?auth|bypass[_-]?auth|dev[_-]?auth|mock[_-]?user)/i, /(isAdmin|admin)\s*[=!]==?\s*(true|1|['"]true['"])/i],
	},
	{ slug: "weak-crypto", label: "weak crypto/hash usage", tier: "normal", patterns: [/\b(md5|sha1|DES|RC4|ECB|Math\.random|random\.random)\b/] },
	{
		slug: "github-workflow-security",
		label: "privileged GitHub workflow",
		tier: "normal",
		patterns: [/pull_request_target/, /permissions:\s*(write-all|.*contents:\s*write|.*pull-requests:\s*write)/],
		paths: [/^\.github\/workflows\/.*\.ya?ml$/],
	},
	{
		slug: "service-entry-point",
		label: "public entry point",
		tier: "noisy",
		patterns: [
			/\b(app|router)\.(get|post|put|patch|delete|all)\s*\(/,
			/@\w+\.(get|post|put|patch|delete)\s*\(/,
			/\bexport\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/,
			/\bfunc\s+\w+\s*\([^)]*http\.(ResponseWriter|Request)/,
			/\b(public\s+)?(async\s+)?Task<.*>\s+\w+\s*\(/,
		],
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

function relPath(root, path) {
	const rel = relative(root, path).replaceAll("\\", "/");
	return rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel) ? rel : null;
}

function ignored(path) {
	const parts = path.split("/");
	if (parts.some((part) => IGNORE_DIRS.has(part))) return true;
	return path.endsWith(".lock") || path.endsWith(".min.js") || path.endsWith(".map") || path.endsWith(".d.ts") || path.endsWith(".md") || path.endsWith(".mdx");
}

function safeFile(root, path, maxFileSize, direct) {
	if (!path || path.startsWith("../") || isAbsolute(path) || (!direct && ignored(path))) return false;
	if (!direct && !SOURCE_EXTS.has(extname(path).toLowerCase())) return false;
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

function readText(path) {
	const data = readFileSync(path);
	if (data.includes(0)) throw new Error("binary file");
	return data.toString("utf8").replaceAll("\r\n", "\n");
}

const snippet = (line) => line.trim().replace(/\s+/g, " ").slice(0, 240);

function scanFile(root, path, direct, maxPerFile) {
	const content = readText(scopedPath(root, path));
	const candidates = [];
	for (const matcher of MATCHERS) {
		if (matcher.paths && !matcher.paths.some((pattern) => pattern.test(path))) continue;
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
	return {
		record: {
			filePath: path,
			fileHash: createHash("sha256").update(content).digest("hex"),
			candidates: unique.slice(0, maxPerFile),
			reviewMode: unique.length ? "candidate-anchored" : "full-static-review",
		},
		candidateCount: unique.length,
		candidatesDropped: Math.max(0, unique.length - maxPerFile),
		include: direct || unique.length > 0,
	};
}

function rankRecord(record, priorityPaths) {
	const tiers = record.candidates.map((candidate) => NOISE[candidate.noiseTier] ?? 1);
	const noise = tiers.length ? Math.min(...tiers) : 3;
	const priority = priorityPaths.findIndex((prefix) => record.filePath === prefix || record.filePath.startsWith(prefix + "/"));
	return [noise, priority < 0 ? priorityPaths.length : priority, -record.candidates.length, record.filePath];
}

function compareTuple(left, right) {
	for (let i = 0; i < left.length; i++) {
		if (left[i] < right[i]) return -1;
		if (left[i] > right[i]) return 1;
	}
	return 0;
}

export async function discover(input = {}, ctx) {
	const opts = input && typeof input === "object" && !Array.isArray(input) ? input : {};
	if (opts.root && Array.isArray(opts.files) && opts.files.length) throw new Error("security-review: choose root or files, not both");
	const root = realInside(ctx.cwd, inside(ctx.cwd, opts.root || "."));
	if (!statSync(root).isDirectory()) throw new Error(`security-review: root is not a directory: ${opts.root}`);
	const maxFileSize = positiveInt(opts.max_file_size, 200000, "max_file_size", 5_000_000);
	const maxFiles = positiveInt(opts.max_files, 60, "max_files", 200);
	const maxCandidates = positiveInt(opts.max_candidates, 500, "max_candidates", 2000);
	const maxPerFile = positiveInt(opts.max_candidates_per_file, 20, "max_candidates_per_file", 100);
	const priorityPaths = (Array.isArray(opts.priority_paths) ? opts.priority_paths : []).map((path) => String(path).replace(/^\/+|\/+$/g, "")).filter(Boolean);

	let selected;
	let source;
	let direct = false;
	if (Array.isArray(opts.files) && opts.files.length) {
		direct = true;
		source = "explicit files";
		selected = [...new Set(opts.files.map((path) => String(path).replace(/^\/+/, "")).filter((path) => safeFile(root, path, maxFileSize, true)))].sort();
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

	const records = [];
	let unreadable = 0;
	let candidateCount = 0;
	let candidatesDropped = 0;
	for (const path of selected) {
		try {
			const scanned = scanFile(root, path, direct, maxPerFile);
			candidateCount += scanned.candidateCount;
			candidatesDropped += scanned.candidatesDropped;
			if (scanned.include) records.push(scanned.record);
		} catch {
			unreadable++;
		}
	}
	records.sort((left, right) => compareTuple(rankRecord(left, priorityPaths), rankRecord(right, priorityPaths)));
	const preCapRecords = records.length;
	const boundaries = [];
	if (records.length > maxFiles) {
		records.length = maxFiles;
		boundaries.push(`Selected ${maxFiles}/${preCapRecords} review record(s) (max_files=${maxFiles}).`);
	}
	let remaining = maxCandidates;
	const capped = [];
	for (const record of records) {
		if (!direct && remaining <= 0) break;
		const keep = direct && !record.candidates.length ? [] : record.candidates.slice(0, remaining);
		candidatesDropped += Math.max(0, record.candidates.length - keep.length);
		remaining -= keep.length;
		if (direct || keep.length) capped.push({ ...record, candidates: keep });
	}
	if (candidateCount > maxCandidates) boundaries.push(`Selected at most ${maxCandidates}/${candidateCount} candidate hit(s) (max_candidates=${maxCandidates}).`);
	if (candidatesDropped) boundaries.push(`${candidatesDropped} candidate hit(s) omitted by per-file/global caps.`);
	if (unreadable) boundaries.push(`${unreadable} selected file(s) were unreadable or binary.`);

	return {
		root,
		source,
		direct,
		selectedCount: selected.length,
		preCapRecords,
		records: capped,
		candidateCount: capped.reduce((count, record) => count + record.candidates.length, 0),
		preCapCandidateCount: candidateCount,
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

export async function validateFindings(input = {}, ctx) {
	const requestedRoot = inside(ctx.cwd, relative(ctx.cwd, resolve(String(input.root || ctx.cwd))));
	const root = realInside(ctx.cwd, requestedRoot);
	const allowed = new Map((Array.isArray(input.records) ? input.records : []).map((record) => [String(record.filePath), record]));
	const valid = [];
	const rejected = [];
	const seen = new Set();
	for (const finding of Array.isArray(input.findings) ? input.findings : []) {
		const filePath = String(finding?.filePath || "").replace(/^\/+/, "");
		const record = allowed.get(filePath);
		if (!record) {
			rejected.push({ finding, reason: "file is outside the enumerated batch" });
			continue;
		}
		try {
			const content = readText(scopedPath(root, filePath));
			const hash = createHash("sha256").update(content).digest("hex");
			if (hash !== record.fileHash) {
				rejected.push({ finding, reason: "file changed after discovery" });
				continue;
			}
			const lines = content.split("\n");
			const line = Number(finding.line);
			if (!Number.isInteger(line) || line < 1 || line > lines.length) {
				rejected.push({ finding, reason: "line is outside the current file" });
				continue;
			}
			const severity = String(finding.severity || "");
			if (!SEVERITIES.has(severity)) {
				rejected.push({ finding, reason: "invalid severity" });
				continue;
			}
			const signature = `${filePath}:${line}:${String(finding.vulnClass || "")}:${String(finding.title || "").trim().toLowerCase()}`;
			if (seen.has(signature)) continue;
			seen.add(signature);
			valid.push({ ...finding, filePath, line, fileHash: hash, evidence: evidenceFor(lines, line) });
		} catch (error) {
			rejected.push({ finding, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { valid, rejected };
}
