# security-review.cwf.py - security review modeled on cwf.
#
#   cwf run ~/.copilot/workflows/security-review.cwf.py --budget 10000 --disable-mcp \
#       --args '{"root":".","diff":"origin/main","state":".security-review/state.json"}'
#   cwf run ~/.copilot/workflows/security-review.cwf.py --args '{"files":["src/app.ts"]}'
#
# This is a pragmatic security-review workflow. cwf owns orchestration; production-scale scanners
# should still own robust schemas, cross-worker locks, credential-brokered sandboxing, and exports.
import datetime
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile


META = {
    "name": "security-review",
    "description": "Candidate scan, structured AI review, verification, and report.",
    "phases": ["scan", "investigate", "verify", "git-revalidate", "report"],
}


SEVERITY_ORDER = {
    "CRITICAL": 0,
    "HIGH": 1,
    "MEDIUM": 2,
    "HIGH_BUG": 3,
    "BUG": 4,
    "LOW": 5,
}
CONFIDENCE_VALUES = ["high", "medium", "low"]
NOISE_SCORE = {"precise": 0, "normal": 1, "noisy": 2}

DEFAULT_IGNORE = [
    ".git/**",
    ".deepsec/data/**",
    ".security-review/**",
    "node_modules/**",
    "vendor/**",
    "dist/**",
    "build/**",
    ".next/**",
    ".turbo/**",
    "coverage/**",
    "__pycache__/**",
    "__tests__/**",
    "test/**",
    "tests/**",
    "fixtures/**",
    "samples/**",
    "*.lock",
    "*.min.js",
    "*.map",
    "*.d.ts",
    "*.md",
    "*.mdx",
]

SOURCE_EXTS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts",
    ".cs", ".php", ".swift", ".scala", ".clj", ".ex", ".exs",
    ".erl", ".hrl", ".lua", ".sh", ".bash", ".zsh", ".ps1",
    ".sql", ".tf", ".yml", ".yaml", ".json", ".toml",
}

MATCHERS = [
    {
        "slug": "secrets-exposure",
        "label": "secret-looking assignment",
        "tier": "precise",
        "patterns": [
            r"(?i)\b(api[_-]?key|secret|token|password|passwd|private[_-]?key)\b\s*[:=]\s*['\"][^'\"\n]{12,}",
            r"-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
        ],
    },
    {
        "slug": "sql-injection",
        "label": "raw SQL or string-built query",
        "tier": "normal",
        "patterns": [
            r"(?i)\b(queryRawUnsafe|executeRawUnsafe|rawQuery|raw\s*\(|exec\s*\(\s*[`'\"]\s*select\b)",
            r"(?i)\bSELECT\b.+(\+|\$\{|%s|format\()",
        ],
    },
    {
        "slug": "command-injection",
        "label": "shell command execution",
        "tier": "normal",
        "patterns": [
            r"\b(exec|execFile|spawn|system|popen|ProcessBuilder|Runtime\.getRuntime\(\)\.exec)\s*\(",
            r"\bsubprocess\.(run|Popen|call|check_output)\s*\(",
        ],
    },
    {
        "slug": "path-traversal",
        "label": "path/file operation with dynamic input",
        "tier": "normal",
        "patterns": [
            r"\b(readFile|writeFile|createReadStream|createWriteStream|sendFile|open|unlink|rename)\s*\(",
            r"\b(path\.join|Path\(|filepath\.Join|os\.Open)\s*\(",
        ],
    },
    {
        "slug": "ssrf",
        "label": "server-side fetch/request",
        "tier": "normal",
        "patterns": [
            r"\b(fetch|axios\.|request\.|http\.get|https\.get|urllib\.request|requests\.(get|post)|Net::HTTP)\b",
        ],
    },
    {
        "slug": "open-redirect",
        "label": "redirect sink",
        "tier": "normal",
        "patterns": [
            r"\b(redirect|res\.redirect|NextResponse\.redirect|RedirectResponse|sendRedirect)\s*\(",
        ],
    },
    {
        "slug": "dangerous-html",
        "label": "unsafe HTML rendering",
        "tier": "normal",
        "patterns": [
            r"\b(dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|v-html)\b",
            r"\b(render_template_string|mark_safe|html_safe|raw\()\b",
        ],
    },
    {
        "slug": "auth-bypass",
        "label": "auth bypass or debug gate",
        "tier": "normal",
        "patterns": [
            r"(?i)(skip[_-]?auth|disable[_-]?auth|bypass[_-]?auth|dev[_-]?auth|mock[_-]?user)",
            r"(?i)(isAdmin|admin)\s*[=!]==?\s*(true|1|['\"]true['\"])",
        ],
    },
    {
        "slug": "weak-crypto",
        "label": "weak crypto/hash usage",
        "tier": "normal",
        "patterns": [
            r"\b(md5|sha1|DES|RC4|ECB|Math\.random|random\.random)\b",
        ],
    },
    {
        "slug": "github-workflow-security",
        "label": "privileged GitHub workflow",
        "tier": "normal",
        "patterns": [
            r"pull_request_target",
            r"permissions:\s*(write-all|.*contents:\s*write|.*pull-requests:\s*write)",
        ],
        "path_patterns": [".github/workflows/*.yml", ".github/workflows/*.yaml"],
    },
    {
        "slug": "service-entry-point",
        "label": "public entry point",
        "tier": "noisy",
        "patterns": [
            r"\b(app|router)\.(get|post|put|patch|delete|all)\s*\(",
            r"@\w+\.(get|post|put|patch|delete)\s*\(",
            r"\bexport\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(",
            r"\bfunc\s+\w+\s*\([^)]*http\.(ResponseWriter|Request)",
            r"\b(public\s+)?(async\s+)?Task<.*>\s+\w+\s*\(",
        ],
    },
]


def _now():
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _opts():
    if isinstance(args, dict):
        return dict(args)
    if isinstance(args, list):
        return {"files": args}
    if isinstance(args, str) and args.strip():
        return {"root": args}
    return {}


opts = _opts()
root = os.path.abspath(os.path.expanduser(opts.get("root") or os.getcwd()))
if not os.path.isdir(root):
    print("security-review: root does not exist or is not a directory: %s" % root)
    raise SystemExit(2)

include_globs = list(opts.get("include") or ["**/*"])
exclude_globs = DEFAULT_IGNORE + list(opts.get("exclude") or [])
priority_paths = [str(p).replace("\\", "/").strip("/") for p in (opts.get("priority_paths") or [])]
batch_size = int(opts.get("batch_size") or 4)
review_concurrency = opts.get("concurrency")
if review_concurrency is not None:
    review_concurrency = int(review_concurrency)
max_file_size = int(opts.get("max_file_size") or 200000)
summarize = bool(opts.get("summarize", True))
fail_on_findings = bool(opts.get("fail_on_findings"))
verbose_rejected = bool(opts.get("verbose_rejected"))
state_arg = opts.get("state") or opts.get("state_path")
comment_out_arg = opts.get("comment_out") or opts.get("comment")
net_new_only = bool(opts.get("net_new_only", bool(state_arg)))
revalidate_with_git = bool(opts.get("revalidate_with_git"))
revalidate_force = bool(opts.get("revalidate_force"))
revalidate_limit = opts.get("revalidate_limit")
if revalidate_limit is not None:
    revalidate_limit = int(revalidate_limit)


def _rel(path):
    rel = os.path.relpath(os.path.abspath(path), root).replace("\\", "/")
    if rel == "." or rel.startswith("../") or os.path.isabs(rel):
        return None
    return rel


def _match_any(path, patterns):
    return any(fnmatch.fnmatch(path, p) or fnmatch.fnmatch("/" + path, p) for p in patterns)


def _is_ignored(path):
    return _match_any(path, exclude_globs)


def _is_included(path):
    return _match_any(path, include_globs)


def _ext(path):
    return os.path.splitext(path)[1].lower()


def _safe_file(path, direct=False):
    if not path or path.startswith("../") or os.path.isabs(path):
        return False
    if _is_ignored(path) or not _is_included(path):
        return False
    full = os.path.join(root, path)
    if not os.path.isfile(full):
        return False
    if not direct and _ext(path) not in SOURCE_EXTS:
        return False
    try:
        return os.path.getsize(full) <= max_file_size
    except OSError:
        return False


def _git_files(cmd):
    code, stdout, stderr = _git(cmd)
    if code != 0:
        raise RuntimeError(stderr or "git command failed")
    return [line.strip().replace("\\", "/") for line in stdout.splitlines() if line.strip()]


def _explicit_files():
    sources = [
        "files" if opts.get("files") else None,
        "diff" if opts.get("diff") is not None else None,
        "diff_staged" if opts.get("diff_staged") else None,
        "diff_working" if opts.get("diff_working") else None,
        "files_from" if opts.get("files_from") else None,
    ]
    sources = [s for s in sources if s]
    if len(sources) > 1:
        raise ValueError("choose only one file source, got: %s" % ", ".join(sources))
    if not sources:
        return None, "repo-scan"
    source = sources[0]
    if source == "files":
        files = [str(p).replace("\\", "/") for p in opts.get("files") or []]
        return files, "files"
    if source == "files_from":
        fp = os.path.abspath(os.path.expanduser(opts.get("files_from")))
        with open(fp, "r", encoding="utf-8") as fh:
            return [line.strip().replace("\\", "/") for line in fh if line.strip()], "files-from:%s" % fp
    if source == "diff":
        ref = str(opts.get("diff") or "HEAD")
        return _git_files(["diff", "--name-only", "--diff-filter=AMRC", ref]), "git-diff:%s" % ref
    if source == "diff_staged":
        return _git_files(["diff", "--name-only", "--cached", "--diff-filter=AMRC"]), "git-diff:staged"
    if source == "diff_working":
        tracked = _git_files(["diff", "--name-only", "--diff-filter=AMRC"])
        untracked = _git_files(["ls-files", "--others", "--exclude-standard"])
        return tracked + untracked, "git-diff:working"
    return None, "repo-scan"


def _walk_files():
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = _rel(dirpath) or ""
        keep_dirs = []
        for d in dirnames:
            p = ("%s/%s" % (rel_dir, d)).strip("/")
            if not _is_ignored(p + "/x"):
                keep_dirs.append(d)
        dirnames[:] = keep_dirs
        for name in filenames:
            path = ("%s/%s" % (rel_dir, name)).strip("/")
            if _safe_file(path, direct=False):
                found.append(path)
    return sorted(found)


def _select_files():
    explicit, source = _explicit_files()
    direct = explicit is not None
    if direct:
        seen = set()
        files = []
        for raw in explicit:
            rel = _rel(os.path.join(root, raw)) if os.path.isabs(raw) else raw.replace("\\", "/")
            if rel is None:
                continue
            rel = rel.strip("/")
            if rel and rel not in seen and _safe_file(rel, direct=True):
                seen.add(rel)
                files.append(rel)
        return sorted(files), source, True
    return _walk_files(), source, False


def _read(path):
    with open(os.path.join(root, path), "r", encoding="utf-8", errors="replace") as fh:
        return fh.read().replace("\r\n", "\n")


def _snippet(line):
    line = " ".join((line or "").split())
    return line[:240]


def _line_matches(content, matcher, path):
    path_patterns = matcher.get("path_patterns")
    if path_patterns and not _match_any(path, path_patterns):
        return []
    compiled = [re.compile(p) for p in matcher["patterns"]]
    matches = []
    for line_no, line in enumerate(content.splitlines(), 1):
        for pattern in compiled:
            if pattern.search(line):
                matches.append({
                    "vulnSlug": matcher["slug"],
                    "noiseTier": matcher["tier"],
                    "lineNumbers": [line_no],
                    "snippet": _snippet(line),
                    "matchedPattern": matcher["label"],
                })
                break
    return matches


def _scan(paths, direct):
    records = []
    skipped_unreadable = 0
    for path in paths:
        try:
            content = _read(path)
        except (OSError, UnicodeError):
            skipped_unreadable += 1
            continue
        candidates = []
        for matcher in MATCHERS:
            candidates.extend(_line_matches(content, matcher, path))
        if candidates or direct:
            records.append({
                "filePath": path,
                "fileHash": hashlib.sha256(content.encode("utf-8", errors="replace")).hexdigest(),
                "candidates": candidates,
            })
    return records, skipped_unreadable


def _priority(path):
    for idx, prefix in enumerate(priority_paths):
        if path == prefix or path.startswith(prefix + "/"):
            return idx
    return len(priority_paths)


def _record_noise(record):
    tiers = [c.get("noiseTier", "normal") for c in record.get("candidates") or []]
    if not tiers:
        return 3
    return min(NOISE_SCORE.get(t, 1) for t in tiers)


def _sort_records(records):
    return sorted(
        records,
        key=lambda r: (_record_noise(r), _priority(r["filePath"]), -len(r.get("candidates") or []), r["filePath"]),
    )


def _batch(records, size):
    by_dir = {}
    for record in records:
        d = os.path.dirname(record["filePath"])
        by_dir.setdefault(d, []).append(record)
    batches = []
    current = []
    for d in sorted(by_dir):
        group = by_dir[d]
        if len(group) >= size:
            for i in range(0, len(group), size):
                batches.append(group[i:i + size])
        elif len(current) + len(group) > size:
            if current:
                batches.append(current)
            current = list(group)
        else:
            current.extend(group)
    if current:
        batches.append(current)
    return batches


def _cap(records, source, direct):
    if "max_files" in opts:
        limit = opts.get("max_files")
    else:
        limit = None if direct else 60
    if limit is None:
        return records, ""
    limit = int(limit)
    if len(records) <= limit:
        return records, ""
    boundary = (
        "Coverage capped: selected %d of %d %s file(s). Set max_files:null for full coverage."
        % (limit, len(records), "direct" if direct else "candidate")
    )
    wf.log("security-review: %s" % boundary)
    return records[:limit], boundary


FINDINGS_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "filePath": {"type": "string"},
            "severity": {"enum": ["CRITICAL", "HIGH", "MEDIUM", "HIGH_BUG", "BUG", "LOW"]},
            "vulnSlug": {"type": "string"},
            "title": {"type": "string"},
            "description": {"type": "string"},
            "lineNumbers": {"type": "array", "items": {"type": "integer"}},
            "recommendation": {"type": "string"},
            "confidence": {"enum": CONFIDENCE_VALUES},
        },
        "required": [
            "filePath", "severity", "vulnSlug", "title", "description",
            "lineNumbers", "recommendation", "confidence",
        ],
        "additionalProperties": False,
    },
}


def _candidate_summary(record):
    return {
        "filePath": record["filePath"],
        "reviewMode": "candidate-anchored" if record.get("candidates") else "full-static-review",
        "candidates": record.get("candidates") or [],
    }


def _investigation_prompt(batch):
    payload = [_candidate_summary(r) for r in batch]
    return (
        "You are performing a static security investigation over a small batch "
        "of source files. The scanner supplied regex candidates as anchors, but candidates can "
        "be false positives and files with reviewMode=full-static-review have no candidates. "
        "For every file in the batch, read the source and look for real vulnerabilities or "
        "major non-security bugs. Do not execute code, run commands, send network requests, or "
        "attempt exploitation. Static source review only.\n\n"
        "Report only concrete, actionable issues with source evidence. If a candidate is fully "
        "mitigated, omit it. Use severity CRITICAL/HIGH/MEDIUM for security issues, HIGH_BUG/BUG "
        "for notable non-security bugs, and LOW only for low-impact security hardening. "
        "Every finding must have filePath exactly equal to one of the batch paths and one or more "
        "1-indexed lineNumbers.\n\n"
        "Important output rule: return exactly one combined top-level JSON array for the whole "
        "batch, not one array per file. Use [] if there are no findings.\n\n"
        "Batch candidates:\n%s" % json.dumps(payload, indent=2, sort_keys=True)
    )


def investigate(batch):
    label = "batch-%s" % (batch[0]["filePath"] if batch else "empty")
    valid_paths = set(r["filePath"] for r in batch)

    def validate_findings(findings):
        bad = []
        if not isinstance(findings, list):
            return "findings must be an array"
        for idx, finding in enumerate(findings):
            path = str(finding.get("filePath") or "").replace("\\", "/")
            if path not in valid_paths:
                bad.append("finding %d has filePath outside batch: %s" % (idx, path))
        return bad

    structured = wf.structured(
        _investigation_prompt(batch),
        FINDINGS_SCHEMA,
        validate=validate_findings,
        retries=1,
        cwd=root,
        phase="investigate",
        label=label[:48],
        **wf.quarantine(),
    )
    errors = []
    findings = []
    if not structured.ok:
        errors.append("investigation failed for %s: %s" % (", ".join(sorted(valid_paths)), structured.error))
    else:
        for finding in structured.value:
            path = str(finding.get("filePath") or "").replace("\\", "/")
            if path not in valid_paths:
                errors.append("dropped finding for path outside batch: %s" % path)
                continue
            finding["filePath"] = path
            finding["source"] = "security-review"
            findings.append(finding)
    return {"batch": batch, "findings": findings, "errors": errors}


def _finding_text(finding):
    return json.dumps(finding, indent=2, sort_keys=True)


def verify_one(finding):
    verdict = wf.verify(
        _finding_text(finding),
        rubric=(
            "The finding describes a real, actionable issue in the referenced source file. "
            "It includes enough line-level evidence to act, is not mitigated by nearby code, "
            "and the severity/confidence are plausible. For security findings, attacker control "
            "or a credible trust-boundary path must be present."
        ),
        refute=True,
        cwd=root,
        phase="verify",
        label=("%s:%s" % (finding.get("filePath"), finding.get("vulnSlug")))[:48],
        **wf.quarantine(),
    )
    row = dict(finding)
    if not verdict.ok:
        status = "unverified"
        reasons = verdict.error or verdict.reasons
    elif verdict.passed:
        status = "verified"
        reasons = verdict.reasons
    else:
        status = "rejected"
        reasons = verdict.reasons
    row["verification"] = {
        "status": status,
        "score": verdict.score,
        "reasons": reasons,
    }
    return row


def verify_batch(result):
    findings = result.get("findings") or []
    if not findings:
        result["verified"] = []
        return result
    result["verified"] = wf.fan_out(findings, verify_one, concurrency=min(len(findings), 4))
    return result


def _sig(finding):
    return "%s::%s::%s" % (
        finding.get("filePath", ""),
        finding.get("vulnSlug", ""),
        " ".join((finding.get("title") or "").split()).lower(),
    )


def _dedupe(findings):
    by_sig = {}
    for finding in findings:
        sig = _sig(finding)
        existing = by_sig.get(sig)
        if existing is None:
            by_sig[sig] = finding
            continue
        old_rank = SEVERITY_ORDER.get(existing.get("severity"), 99)
        new_rank = SEVERITY_ORDER.get(finding.get("severity"), 99)
        if new_rank < old_rank:
            by_sig[sig] = finding
    return sorted(
        by_sig.values(),
        key=lambda f: (
            SEVERITY_ORDER.get(f.get("severity"), 99),
            f.get("filePath", ""),
            min(f.get("lineNumbers") or [0]),
            f.get("title", ""),
        ),
    )


def _resolve_under_root(arg):
    if not arg:
        return None
    p = os.path.expanduser(str(arg))
    if not os.path.isabs(p):
        p = os.path.join(root, p)
    return os.path.abspath(p)


def _state_path():
    return _resolve_under_root(state_arg)


def _comment_path():
    return _resolve_under_root(comment_out_arg)


def _load_state(path):
    if not path or not os.path.isfile(path):
        return {"schema": "security-review-state-v1", "files": {}, "runs": []}
    with open(path, "r", encoding="utf-8") as fh:
        state = json.load(fh)
    if not isinstance(state, dict) or state.get("schema") != "security-review-state-v1":
        raise ValueError("unsupported state schema in %s" % path)
    state["schema"] = "security-review-state-v1"
    state.setdefault("files", {})
    state.setdefault("runs", [])
    return state


def _existing_index(path):
    if not path or not os.path.isfile(path):
        return set(), {}
    state = _load_state(path)
    signatures = set()
    verdicts = {}
    for record in (state.get("files") or {}).values():
        for finding in record.get("findings") or []:
            sig = _sig(finding)
            signatures.add(sig)
            verdict = finding.get("gitRevalidation")
            if verdict and verdict.get("verdict"):
                verdicts[sig] = verdict
    return signatures, verdicts


def _write_state(path, state):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".security-review-", suffix=".json", dir=parent or None)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except OSError:
            pass


def _run_id():
    if getattr(wf, "run_dir", None):
        return os.path.basename(wf.run_dir)
    return "dry-run-%s" % hashlib.sha1(_now().encode("utf-8")).hexdigest()[:8]


def _merge_state(records, findings, errors, source, boundary):
    path = _state_path()
    if not path:
        return None
    state = _load_state(path)
    run_id = _run_id()
    now = _now()
    state["root"] = root
    state["updatedAt"] = now
    state["runs"].append({
        "runId": run_id,
        "createdAt": now,
        "source": source,
        "filesConsidered": len(records),
        "findings": len(findings),
        "errors": errors,
        "boundary": boundary,
    })
    existing_files = state.get("files") or {}
    by_path = {}
    for record in records:
        prior = existing_files.get(record["filePath"]) or {}
        by_path.setdefault(record["filePath"], {
            "findings": list(prior.get("findings") or []),
            "analysisHistory": list(prior.get("analysisHistory") or []),
        })
        by_path[record["filePath"]].update({
            "filePath": record["filePath"],
            "fileHash": record.get("fileHash"),
            "candidates": record.get("candidates") or [],
            "lastScannedAt": now,
        })
    for finding in findings:
        rec = by_path.get(finding["filePath"])
        if rec is None:
            prior = existing_files.get(finding["filePath"]) or {}
            rec = {
                "filePath": finding["filePath"],
                "findings": list(prior.get("findings") or []),
                "analysisHistory": list(prior.get("analysisHistory") or []),
            }
            by_path[finding["filePath"]] = rec
        existing = {_sig(f): f for f in rec.get("findings") or []}
        sig = _sig(finding)
        merged = dict(existing.get(sig) or {})
        merged.update(finding)
        merged.setdefault("firstSeenRunId", run_id)
        merged["lastSeenRunId"] = run_id
        existing[sig] = merged
        rec["findings"] = sorted(existing.values(), key=lambda f: (SEVERITY_ORDER.get(f.get("severity"), 99), f.get("title", "")))
        history = rec.setdefault("analysisHistory", [])
        history.append({
            "runId": run_id,
            "investigatedAt": now,
            "findingSignature": sig,
            "verification": finding.get("verification", {}).get("status"),
        })
    for file_path, rec in by_path.items():
        state["files"][file_path] = rec
    _write_state(path, state)
    return path


def _without_run_flags(findings):
    clean = []
    for finding in findings:
        row = dict(finding)
        row.pop("isNew", None)
        clean.append(row)
    return clean


def _git(args):
    proc = subprocess.run(
        ["git", "-C", root] + args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def _run_git(args):
    code, stdout, stderr = _git(args)
    if code != 0:
        return "", (stderr or "git command failed")
    return stdout, ""


def _current_lines(path, lines):
    full = os.path.join(root, path)
    try:
        with open(full, "r", encoding="utf-8", errors="replace") as fh:
            all_lines = fh.read().replace("\r\n", "\n").splitlines()
    except OSError as e:
        return "", "current file unavailable: %s" % e
    if not all_lines:
        return "", ""
    nums = [n for n in lines if isinstance(n, int) and n > 0]
    if not nums:
        start, end = 1, min(len(all_lines), 20)
    else:
        start = max(1, min(nums) - 3)
        end = min(len(all_lines), max(nums) + 3)
    rendered = []
    for idx in range(start, end + 1):
        rendered.append("%5d  %s" % (idx, all_lines[idx - 1]))
    return "\n".join(rendered), ""


def _git_evidence(path, finding):
    lines = finding.get("lineNumbers") or []
    nums = [n for n in lines if isinstance(n, int) and n > 0]
    line_start = min(nums) if nums else 1
    line_end = max(nums) if nums else line_start
    current, current_error = _current_lines(path, nums)
    log_out, log_error = _run_git([
        "log", "--follow", "--date=short",
        "--format=%h %ad %an %s", "--max-count=8", "--", path,
    ])
    blame_out, blame_error = _run_git([
        "blame", "-L", "%d,%d" % (line_start, line_end), "--", path,
    ])
    show_out = ""
    show_error = ""
    if finding.get("firstSeenRunId"):
        show_out, show_error = _run_git([
            "log", "--date=short", "--format=%h %ad %an %s",
            "--all", "--grep", str(finding.get("title") or "")[:80], "--max-count=3",
        ])
    errors = [e for e in (current_error, log_error, blame_error, show_error) if e]
    return {
        "filePath": path,
        "lineRange": [line_start, line_end],
        "currentSnippet": current[-4000:],
        "recentFileHistory": log_out[-4000:],
        "currentBlame": blame_out[-4000:],
        "relatedHistorySearch": show_out[-2000:],
        "errors": errors,
    }


GIT_REVALIDATION_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"enum": ["true-positive", "fixed", "false-positive", "uncertain"]},
        "reasoning": {"type": "string"},
        "evidence": {"type": "string"},
    },
    "required": ["verdict", "reasoning", "evidence"],
    "additionalProperties": False,
}


def _needs_git_revalidation(finding):
    if revalidate_force:
        return True
    existing = finding.get("gitRevalidation") or {}
    return not existing.get("verdict")


def _git_revalidate_one(item):
    file_path, finding = item
    evidence = _git_evidence(file_path, finding)
    result = wf.structured(
        "Classify this stored security-review finding using the current source snippet and git "
        "history evidence. Verdict meanings: true-positive = issue still appears present and "
        "actionable; fixed = the vulnerable code is gone or clearly mitigated; false-positive = "
        "the original finding is not real or is fully mitigated; uncertain = evidence is "
        "insufficient or conflicting. Return JSON only.\n\nFinding:\n%s\n\nGit evidence:\n%s"
        % (json.dumps(finding, indent=2, sort_keys=True),
           json.dumps(evidence, indent=2, sort_keys=True)),
        GIT_REVALIDATION_SCHEMA,
        retries=1,
        phase="git-revalidate",
        label=("%s:%s" % (file_path, finding.get("vulnSlug")))[:48],
        **wf.quarantine(allow_all_tools=False),
    )
    if result.ok:
        verdict = dict(result.value)
    else:
        verdict = {
            "verdict": "uncertain",
            "reasoning": result.error or "git revalidation failed",
            "evidence": "workflow verifier did not return a valid verdict",
        }
    verdict.update({
        "revalidatedAt": _now(),
        "runId": _run_id(),
        "gitEvidence": evidence,
    })
    return file_path, _sig(finding), verdict


def _apply_git_revalidation():
    path = _state_path()
    if not path:
        return {}, {"enabled": False, "reason": "no state path supplied"}
    state = _load_state(path)
    targets = []
    for file_path in sorted((state.get("files") or {})):
        record = state["files"][file_path]
        for finding in record.get("findings") or []:
            if _needs_git_revalidation(finding):
                targets.append((file_path, finding))
    total_candidates = len(targets)
    if revalidate_limit is not None and len(targets) > revalidate_limit:
        targets = targets[:revalidate_limit]
        wf.log("security-review: git revalidation capped at %d of %d finding(s)"
               % (len(targets), total_candidates))
    if not targets:
        return {}, {"enabled": True, "checked": 0, "candidates": total_candidates, "verdicts": {}}
    rows = [r for r in wf.fan_out(targets, _git_revalidate_one, concurrency=review_concurrency) if r]
    by_sig = {}
    verdict_counts = {}
    for file_path, sig, verdict in rows:
        by_sig[sig] = verdict
        verdict_counts[verdict["verdict"]] = verdict_counts.get(verdict["verdict"], 0) + 1
        record = (state.get("files") or {}).get(file_path) or {}
        for finding in record.get("findings") or []:
            if _sig(finding) == sig:
                finding["gitRevalidation"] = verdict
    state["updatedAt"] = _now()
    state.setdefault("gitRevalidationRuns", []).append({
        "runId": _run_id(),
        "createdAt": _now(),
        "checked": len(rows),
        "candidates": total_candidates,
        "verdicts": verdict_counts,
    })
    _write_state(path, state)
    return by_sig, {"enabled": True, "checked": len(rows), "candidates": total_candidates, "verdicts": verdict_counts}


def _apply_git_verdicts(findings, by_sig):
    for finding in findings:
        verdict = by_sig.get(_sig(finding))
        if verdict:
            finding["gitRevalidation"] = verdict


def _is_git_resolved(finding):
    verdict = (finding.get("gitRevalidation") or {}).get("verdict")
    return verdict in ("fixed", "false-positive")


def _escape_cell(value):
    return str(value or "").replace("|", "\\|").replace("\n", "<br>")


def _line_ref(finding):
    lines = finding.get("lineNumbers") or []
    if not lines:
        return ""
    if len(lines) == 1:
        return ":%s" % lines[0]
    return ":%s-%s" % (min(lines), max(lines))


def _slug_counts(records):
    counts = {}
    for record in records:
        for candidate in record.get("candidates") or []:
            slug = candidate.get("vulnSlug") or "unknown"
            counts[slug] = counts.get(slug, 0) + 1
    return counts


def _render_report(source, selected_count, pre_cap_count, boundary, skipped_unreadable,
                   records, verified, active_verified, new_verified, rejected, unverified,
                   new_unverified, errors, state_path, comment_path,
                   git_summary, summary):
    print("# security-review report")
    print()
    print("Source: `%s`  " % source)
    print("Root: `%s`  " % root)
    print("Files reviewed: %d of %d selected file(s)  " % (selected_count, pre_cap_count))
    print("Candidate hits: %d across %d reviewed file(s)  " % (
        sum(len(r.get("candidates") or []) for r in records),
        len([r for r in records if r.get("candidates")]),
    ))
    print("Verified findings: %d active / %d total; rejected: %d; unverified: %d  " % (
        len(active_verified), len(verified), len(rejected), len(unverified),
    ))
    if net_new_only or state_path:
        print("Net-new verified findings: %d; net-new unverified: %d  " % (
            len(new_verified), len(new_unverified),
        ))
    print("AIC observed in harness: %.1f / %s  " % (
        getattr(wf, "spent", 0.0),
        "%.1f" % wf.budget_total if getattr(wf, "budget_total", None) is not None else "uncapped",
    ))
    if boundary:
        print()
        print("**Coverage boundary:** %s" % boundary)
    if skipped_unreadable:
        print()
        print("**Skipped unreadable files:** %d" % skipped_unreadable)
    if state_path:
        print()
        print("State updated: `%s`" % state_path)
    if comment_path:
        print()
        print("PR comment output: `%s`" % comment_path)
    if git_summary and git_summary.get("enabled"):
        print()
        print("Git revalidation: checked %d of %d candidate finding(s); verdicts: %s" % (
            git_summary.get("checked", 0),
            git_summary.get("candidates", 0),
            ", ".join("%s=%s" % (k, git_summary.get("verdicts", {}).get(k))
                      for k in sorted(git_summary.get("verdicts", {}))) or "none",
        ))
    print()
    if summary:
        print("## Summary")
        print()
        print(summary.strip())
        print()
    if verified:
        print("## Verified findings")
        print()
        print("| New | Severity | File | Slug | Confidence | Finding | Recommendation |")
        print("| --- | --- | --- | --- | --- | --- | --- |")
        for finding in verified:
            file_ref = "%s%s" % (finding.get("filePath"), _line_ref(finding))
            git_verdict = (finding.get("gitRevalidation") or {}).get("verdict")
            title = finding.get("title")
            if git_verdict in ("fixed", "false-positive"):
                title = "%s (git revalidation: %s)" % (title, git_verdict)
            print("| %s | %s | `%s` | `%s` | %s | %s | %s |" % (
                "yes" if finding.get("isNew") else "no",
                _escape_cell(finding.get("severity")),
                _escape_cell(file_ref),
                _escape_cell(finding.get("vulnSlug")),
                _escape_cell(finding.get("confidence")),
                _escape_cell("**%s**<br>%s" % (title, finding.get("description"))),
                _escape_cell(finding.get("recommendation")),
            ))
        print()
    else:
        print("No verified findings.")
        print()
    if unverified:
        print("## Unverified findings")
        print()
        print("These were not marked false positive; verification failed or was skipped (often budget).")
        print()
        for finding in unverified:
            v = finding.get("verification") or {}
            print("- `%s%s` **%s**: %s" % (
                finding.get("filePath"), _line_ref(finding), finding.get("title"), v.get("reasons") or "unverified",
            ))
        print()
    if verbose_rejected and rejected:
        print("## Rejected during verification")
        print()
        for finding in rejected:
            v = finding.get("verification") or {}
            print("- `%s%s` **%s**: %s" % (
                finding.get("filePath"), _line_ref(finding), finding.get("title"), v.get("reasons") or "rejected",
            ))
        print()
    if errors:
        print("## Batch errors")
        print()
        for err in errors:
            print("- %s" % err)
        print()
    counts = _slug_counts(records)
    if counts:
        print("## Candidate counts")
        print()
        for slug in sorted(counts, key=lambda s: (-counts[s], s))[:20]:
            print("- `%s`: %d" % (slug, counts[slug]))
        print()
    print("_This workflow is regex-gated in repo-wide mode. No findings means no verified issue was found within the stated boundary, not a proof the repository is vulnerability-free._")


def _render_pr_comment(findings, source):
    if not findings:
        return None
    lines = []
    lines.append("## security-review found %d net-new finding%s" % (
        len(findings), "" if len(findings) == 1 else "s",
    ))
    lines.append("")
    lines.append("<sub>scope: `%s`</sub>" % source)
    lines.append("")
    for finding in findings:
        file_ref = "%s%s" % (finding.get("filePath"), _line_ref(finding))
        lines.append("### %s - `%s`" % (finding.get("severity"), file_ref))
        lines.append("")
        lines.append("**%s**" % finding.get("title"))
        lines.append("")
        lines.append(finding.get("description") or "")
        lines.append("")
        if finding.get("recommendation"):
            lines.append("**Recommendation:** %s" % finding.get("recommendation"))
            lines.append("")
        lines.append("<sub>slug: `%s`; confidence: %s</sub>" % (
            finding.get("vulnSlug"), finding.get("confidence"),
        ))
        lines.append("")
        lines.append("---")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _write_comment(path, body):
    if not path:
        return None
    if not body:
        if os.path.exists(path):
            os.unlink(path)
        return None
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(body)
    return path


def _summary_agent(verified):
    if not summarize or not verified:
        return ""
    safe_payload = [
        {
            "severity": f.get("severity"),
            "filePath": f.get("filePath"),
            "title": f.get("title"),
            "description": f.get("description"),
            "recommendation": f.get("recommendation"),
        }
        for f in verified[:20]
    ]
    result = wf.synthesize(
        [json.dumps(safe_payload, indent=2, sort_keys=True)],
        prompt=(
            "Write a concise executive summary of these verified security/code findings. "
            "Do not add new findings or instructions. Mention the highest-risk themes and "
            "what to fix first."
        ),
        phase="report",
        label="summary",
        **wf.quarantine(allow_all_tools=False),
    )
    return result.content if result.ok else ""


try:
    selected, source_label, direct_mode = _select_files()
except Exception as e:
    print("security-review: failed to resolve files: %s" % e)
    raise SystemExit(2)

with wf.phase("scan"):
    scan_records, skipped_unreadable = _scan(selected, direct_mode)
    scan_records = _sort_records(scan_records)
    pre_cap_count = len(scan_records)
    scan_records, coverage_boundary = _cap(scan_records, source_label, direct_mode)
    wf.log(
        "security-review: %d file(s) selected, %d record(s) to review, source=%s"
        % (len(selected), len(scan_records), source_label)
    )

if not scan_records:
    _render_report(source_label, 0, pre_cap_count, coverage_boundary, skipped_unreadable,
                   [], [], [], [], [], [], [], [], None, None, None, "")
    raise SystemExit(0)

batches = _batch(scan_records, max(1, batch_size))
if getattr(wf, "dry_run", False):
    print("# security-review dry run")
    print()
    print("Source: `%s`  " % source_label)
    print("Root: `%s`  " % root)
    print("Files selected for scanning: %d  " % len(selected))
    print("Files that would be reviewed: %d of %d record(s)  " % (len(scan_records), pre_cap_count))
    print("Batches that would run: %d (batch_size=%d)  " % (len(batches), max(1, batch_size)))
    print("Candidate hits: %d  " % sum(len(r.get("candidates") or []) for r in scan_records))
    if coverage_boundary:
        print()
        print("**Coverage boundary:** %s" % coverage_boundary)
    counts = _slug_counts(scan_records)
    if counts:
        print()
        print("## Candidate counts")
        print()
        for slug in sorted(counts, key=lambda s: (-counts[s], s))[:20]:
            print("- `%s`: %d" % (slug, counts[slug]))
    if state_arg:
        print()
        print("State path (not written in dry-run): `%s`" % _state_path())
    if comment_out_arg:
        print()
        print("PR comment path (not written in dry-run): `%s`" % _comment_path())
    if revalidate_with_git:
        print()
        print("Git revalidation: would run after state merge.")
    raise SystemExit(0)

rows = [r for r in wf.pipeline(batches, investigate, verify_batch, concurrency=review_concurrency) if r is not None]

all_verified_rows = []
batch_errors = []
for row in rows:
    batch_errors.extend(row.get("errors") or [])
    all_verified_rows.extend(row.get("verified") or [])

all_verified_rows = _dedupe(all_verified_rows)
existing_signatures, existing_git_verdicts = _existing_index(_state_path())
for finding in all_verified_rows:
    finding["isNew"] = _sig(finding) not in existing_signatures
_apply_git_verdicts(all_verified_rows, existing_git_verdicts)
verified_findings = [f for f in all_verified_rows if (f.get("verification") or {}).get("status") == "verified"]
rejected_findings = [f for f in all_verified_rows if (f.get("verification") or {}).get("status") == "rejected"]
unverified_findings = [f for f in all_verified_rows if (f.get("verification") or {}).get("status") == "unverified"]

state_written = _merge_state(
    scan_records,
    _without_run_flags(verified_findings + unverified_findings),
    batch_errors,
    source_label,
    coverage_boundary,
)
git_verdicts, git_summary = ({}, {"enabled": False})
if revalidate_with_git:
    git_verdicts, git_summary = _apply_git_revalidation()
    _apply_git_verdicts(verified_findings + unverified_findings, git_verdicts)

active_verified_findings = [f for f in verified_findings if not _is_git_resolved(f)]
new_verified_findings = [f for f in active_verified_findings if f.get("isNew")]
new_unverified_findings = [f for f in unverified_findings if f.get("isNew")]
comment_written = _write_comment(_comment_path(), _render_pr_comment(new_verified_findings, source_label))
summary_text = _summary_agent(active_verified_findings)
_render_report(
    source_label,
    len(scan_records),
    pre_cap_count,
    coverage_boundary,
    skipped_unreadable,
    scan_records,
    verified_findings,
    active_verified_findings,
    new_verified_findings,
    rejected_findings,
    unverified_findings,
    new_unverified_findings,
    batch_errors,
    state_written,
    comment_written,
    git_summary,
    summary_text,
)

fail_findings = new_verified_findings if net_new_only else active_verified_findings
if fail_on_findings and fail_findings:
    raise SystemExit(1)
