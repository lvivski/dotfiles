# review-queue.cwf.py — triage every PR I'm asked to review (GitHub + Azure DevOps).
#
#   ~/.copilot/skills/review-queue/scripts/review-queue-fetch.sh > /tmp/prs.json
#   cwf run ~/.copilot/workflows/review-queue.cwf.py --budget 10000 --args @/tmp/prs.json
#
# args: a JSON array of normalized PR records (see review-queue-fetch.sh), or
#       {"prs":[...]}. Read-only: reviewers are quarantined over the provided diff.
import fnmatch
import os

META = {
    "name": "review-queue",
    "description": "Triage assigned PRs: approve-now vs needs-review, with why-assigned and focus hints.",
    "phases": ["review", "decide"],
}

opts = args if isinstance(args, dict) else {}
prs = opts.get("prs") if opts else args
if not prs:
    print("review-queue: no PRs supplied. Pipe review-queue-fetch.sh output via --args @file.json")
    raise SystemExit(0)

no_tools = wf.quarantine(allow_all_tools=False)
deep = bool(opts.get("deep"))
auto_deep = bool(opts.get("auto_deep", True))
approve_only_low_risk_manual = bool(opts.get("approve_only_low_risk_manual"))
freshness = opts.get("freshness", "input queue; fetch default excludes PRs older than 30 days")
developer_root = os.path.expanduser(opts.get("developer_root", "~/Developer"))
review_conc = (opts.get("concurrency") or 6) if (deep or auto_deep) else None  # throttle parallel checkouts


def _owns(pr):
    """Why was I added? CODEOWNERS last-match wins; else required policy; else manual."""
    mine = {("@" + me).lower() for me in [pr.get("me", "")] + list(pr.get("my_teams") or [])}
    files = pr.get("files") or []
    final = []
    for line in (pr.get("codeowners") or "").splitlines():
        parts = line.split("#", 1)[0].split()
        if not parts:
            continue
        pat, *owners = parts
        bare = pat.strip("/")
        if any(f == bare or f.startswith(bare + "/") or fnmatch.fnmatch(f, pat) for f in files):
            final = owners  # last matching rule wins, even if it reassigns ownership
    if any(o.lower() in mine for o in final):
        return "codeowner"
    if any(r.get("required") for r in pr.get("reviewers") or []):
        return "required-policy"
    return "manual"


def _review_agent(pr, cwd=None):
    body = ("Title: %s\nFiles (%d): %s\n\nDIFF:\n%s"
            % (pr.get("title", ""), len(pr.get("files") or []),
               ", ".join((pr.get("files") or [])[:40]), pr.get("diff") or "(no diff)"))
    extra = {}
    if cwd:
        extra["cwd"] = cwd
        body += ("\n\nThe PR is checked out at the working dir. Stay focused: inspect the changed "
                 "files listed above, their immediate callers/imports, and directly related tests. "
                 "Do not broadly audit the repo.")
    return wf.agent(
        "Review this pull request as a careful reviewer. Note bugs, risky changes, missing tests, "
        "and anything needing human judgment. Be concise; cite file/line where you can.\n\n" + body,
        agent="worker", label="%s#%s" % (pr.get("repo"), pr.get("number")), phase="review",
        **extra, **wf.quarantine(),  # untrusted diff: read-only, no shell/write/network/MCP
    )


def _deep_review(pr):
    if not pr.get("clone_url") or not pr.get("pr_ref"):
        raise RuntimeError("missing clone URL or PR ref")
    with wf.worktree(str(pr["number"]), repo=pr["clone_url"], ref=pr["pr_ref"],
                     clone_dir=developer_root) as path:
        finding = _review_agent(pr, cwd=path)
        return finding, "deep checkout"


def review(pr):
    reason = _owns(pr)
    if (deep or (auto_deep and pr.get("coverage") != "full diff")) and pr.get("clone_url") and pr.get("pr_ref"):
        try:
            finding, coverage = _deep_review(pr)
            return {"pr": pr, "reason": reason, "coverage": coverage, "finding": finding}
        except Exception as e:
            wf.log("review-queue: deep checkout failed for %s#%s (%s); diff-only"
                   % (pr.get("repo"), pr.get("number"), e))
    return {"pr": pr, "reason": reason, "coverage": pr.get("coverage") or "unknown",
            "finding": _review_agent(pr)}


def decide(row, *, suffix=""):
    required = (row["reason"] != "manual")
    verdict = wf.structured(
        "Given this review of %s#%s (I was added as: %s; required=%s), classify whether it is safe "
        "to APPROVE now or NEEDS_REVIEW. Provide a concise justification for the decision, and list "
        "focus hints only if needs_review. If approve_only_low_risk_manual=%s, only approve PRs that "
        "are both low risk and manually requested; classify everything else as NEEDS_REVIEW. Set "
        "needs_deep_review=true only when checking surrounding files/tests in a checkout could "
        "materially change the decision or resolve uncertainty; do not set it merely because the "
        "review already found a concrete issue.\n\nCoverage: %s\nReview:\n%s"
        % (row["pr"].get("repo"), row["pr"].get("number"), row["reason"], required,
           approve_only_low_risk_manual, row.get("coverage"), row["finding"].content),
        {"type": "object",
         "properties": {"decision": {"enum": ["approve", "needs_review"]},
                        "risk": {"enum": ["low", "medium", "high"]},
                        "justification": {"type": "string"},
                        "needs_deep_review": {"type": "boolean"},
                        "focus": {"type": "array", "items": {"type": "string"}}},
         "required": ["decision", "risk", "justification", "needs_deep_review"]},
        label="%s#%s%s" % (row["pr"].get("repo"), row["pr"].get("number"),
                            ("-" + suffix) if suffix else ""),
        phase="decide",
        **no_tools,
    )
    row["verdict"] = verdict.value if verdict.ok else {"decision": "needs_review", "risk": "high",
                                                       "justification": "Verdict parse failed.",
                                                       "needs_deep_review": False,
                                                       "focus": ["verdict parse failed"]}
    if (approve_only_low_risk_manual
            and (row["reason"] != "manual" or row["verdict"].get("risk") != "low")
            and row["verdict"].get("decision") == "approve"):
        row["verdict"] = {
            "decision": "needs_review",
            "risk": row["verdict"].get("risk") or "medium",
            "justification": "Conservative policy requires manual review unless the PR is both low risk and manually requested.",
            "focus": ["Policy gate: not a low-risk manual request"],
        }
    return row


def _needs_deep(row):
    if deep or not auto_deep:
        return False
    if str(row.get("coverage") or "").startswith("deep checkout"):
        return False
    if row.get("coverage") != "full diff":
        return True
    return bool(row.get("verdict", {}).get("needs_deep_review"))


def deepen_if_needed(row):
    if not _needs_deep(row):
        return row
    pr = row["pr"]
    try:
        finding, coverage = _deep_review(pr)
    except Exception as e:
        wf.log("review-queue: conditional deep review unavailable for %s#%s (%s)"
               % (pr.get("repo"), pr.get("number"), e))
        row["coverage"] = "%s; deep unavailable" % (row.get("coverage") or "unknown")
        row["verdict"].setdefault("focus", []).append("Deep checkout unavailable: %s" % e)
        return row
    deep_row = {"pr": pr, "reason": row["reason"], "coverage": coverage, "finding": finding}
    return decide(deep_row, suffix="deep")


rows = [r for r in wf.pipeline(prs, review, decide, deepen_if_needed, concurrency=review_conc) if r is not None]
wf.log("review-queue: triaged %d PR(s)" % len(rows))


def _cell(value):
    text = str(value or "")
    return text.replace("|", "\\|").replace("\n", "<br>")


def _rank(row):
    verdict = row["verdict"]
    decision_rank = {"needs_review": 0, "approve": 1}.get(verdict.get("decision"), 2)
    reason_rank = {"codeowner": 0, "required-policy": 1, "manual": 2}.get(row["reason"], 3)
    risk_rank = {"high": 0, "medium": 1, "low": 2}.get(verdict.get("risk"), 3)
    return decision_rank, risk_rank, reason_rank, row["pr"].get("repo", ""), row["pr"].get("number", 0)


def _decision_label(decision):
    return {"approve": "Approve", "needs_review": "Needs review"}.get(decision, decision)


def _reason_label(reason):
    return {"codeowner": "CODEOWNERS", "required-policy": "Required policy", "manual": "Manual"}.get(reason, reason)


def _date(value):
    return str(value or "")[:10]


def _source(pr):
    return "%s<br>%s" % (pr.get("platform") or "", pr.get("me") or "")


print("| Decision | Risk | Source | Updated | Files | Coverage | Why | PR | Justification | Focus |")
print("| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |")
for row in sorted(rows, key=_rank):
    verdict = row["verdict"]
    pr = row["pr"]
    pr_label = "%s#%s" % (pr.get("repo"), pr.get("number"))
    pr_link = "[%s](%s)" % (_cell(pr_label), pr.get("url")) if pr.get("url") else _cell(pr_label)
    if pr.get("title"):
        pr_link += "<br>%s" % _cell(pr.get("title"))
    focus = "; ".join(verdict.get("focus") or [])
    print("| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |"
          % (_cell(_decision_label(verdict.get("decision"))),
             _cell(str(verdict.get("risk") or "").title()),
             _cell(_source(pr)),
             _cell(_date(pr.get("updatedAt"))),
             _cell(len(pr.get("files") or [])),
             _cell(row.get("coverage")),
             _cell(_reason_label(row["reason"])),
             pr_link,
             _cell(verdict.get("justification")),
             _cell(focus or "OK")))

platforms = {}
coverages = {}
for row in rows:
    platforms[row["pr"].get("platform") or "unknown"] = platforms.get(row["pr"].get("platform") or "unknown", 0) + 1
    coverages[row.get("coverage") or "unknown"] = coverages.get(row.get("coverage") or "unknown", 0) + 1

print()
print("_Reviewed %d PR(s). Sources: %s. Coverage: %s. Freshness: %s. Auto-deep: %s. Deep mode: %s. Developer root: `%s`. Conservative approval policy: %s._"
      % (len(rows),
         ", ".join("%s=%s" % (k, platforms[k]) for k in sorted(platforms)),
         ", ".join("%s=%s" % (k, coverages[k]) for k in sorted(coverages)),
         freshness,
         "on" if auto_deep else "off",
         "on" if deep else "off",
         developer_root,
         "on" if approve_only_low_risk_manual else "off"))
