# review-queue.cwf.py — triage every PR I'm asked to review (GitHub + Azure DevOps).
#
#   ~/.copilot/skills/review-queue/scripts/review-queue-fetch.sh > /tmp/prs.json
#   cwf run ~/.copilot/workflows/review-queue.cwf.py --budget 10000 --args @/tmp/prs.json
#
# args: a JSON array of normalized PR records (see review-queue-fetch.sh), or
#       {"prs":[...]}. Read-only: reviewers are quarantined over the provided diff.
import fnmatch

META = {
    "name": "review-queue",
    "description": "Triage assigned PRs: approve-now vs needs-review, with why-assigned and focus hints.",
    "phases": ["review", "decide", "report"],
}

prs = args.get("prs") if isinstance(args, dict) else args
if not prs:
    print("review-queue: no PRs supplied. Pipe review-queue-fetch.sh output via --args @file.json")
    raise SystemExit(0)

no_tools = wf.quarantine(allow_all_tools=False)
deep = bool(args.get("deep")) if isinstance(args, dict) else False
review_conc = (args.get("concurrency") or 6) if deep else None  # throttle parallel clones in deep mode


def _owns(pr):
    """Why was I added? CODEOWNERS last-match wins; else required policy; else manual."""
    mine = {("@" + me).lower() for me in [pr.get("me", "")] + list(pr.get("my_teams") or [])}
    files = pr.get("files") or []
    final = []
    for line in (pr.get("codeowners") or "").splitlines():
        pat, *owners = line.split("#", 1)[0].split()
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
        body += "\n\nThe PR is checked out at the working dir; read surrounding code for context."
    return wf.agent(
        "Review this pull request as a careful reviewer. Note bugs, risky changes, missing tests, "
        "and anything needing human judgment. Be concise; cite file/line where you can.\n\n" + body,
        agent="worker", label="%s#%s" % (pr.get("repo"), pr.get("number")), phase="review",
        **extra, **wf.quarantine(),  # untrusted diff: read-only, no shell/write/network/MCP
    )


def review(pr):
    reason = _owns(pr)
    # Deep mode: clone-once + worktree per PR so the reviewer can grep neighbors/tests. Stays
    # quarantined (read-only) — the runtime does the trusted checkout; the agent never runs code.
    # Any clone/fetch failure (private repo, no creds, ADO auth) falls back to a diff-only review.
    if deep and pr.get("clone_url") and pr.get("pr_ref"):
        try:
            with wf.worktree(str(pr["number"]), repo=pr["clone_url"], ref=pr["pr_ref"]) as path:
                return {"pr": pr, "reason": reason, "finding": _review_agent(pr, cwd=path)}
        except Exception as e:
            wf.log("review-queue: deep checkout failed for %s#%s (%s); diff-only"
                   % (pr.get("repo"), pr.get("number"), e))
    return {"pr": pr, "reason": reason, "finding": _review_agent(pr)}


def decide(row):
    required = (row["reason"] != "manual")
    verdict = wf.structured(
        "Given this review of %s#%s (I was added as: %s; required=%s), classify whether it is safe "
        "to APPROVE now or NEEDS_REVIEW. List focus hints only if needs_review.\n\nReview:\n%s"
        % (row["pr"].get("repo"), row["pr"].get("number"), row["reason"], required,
           row["finding"].content),
        {"type": "object",
         "properties": {"decision": {"enum": ["approve", "needs_review"]},
                        "risk": {"enum": ["low", "medium", "high"]},
                        "focus": {"type": "array", "items": {"type": "string"}}},
         "required": ["decision", "risk"]},
        label="%s#%s" % (row["pr"].get("repo"), row["pr"].get("number")), phase="decide",
        **no_tools,
    )
    row["verdict"] = verdict.value if verdict.ok else {"decision": "needs_review", "risk": "high",
                                                       "focus": ["verdict parse failed"]}
    return row


rows = [r for r in wf.pipeline(prs, review, decide, concurrency=review_conc) if r is not None]
wf.log("review-queue: triaged %d PR(s)" % len(rows))

lines = []
for r in rows:
    v, pr = r["verdict"], r["pr"]
    lines.append("- %s#%s [%s, why=%s, risk=%s] %s | %s"
                 % (pr.get("repo"), pr.get("number"), v.get("decision"), r["reason"],
                    v.get("risk"), pr.get("url", ""), "; ".join(v.get("focus") or []) or "ok"))

report = wf.synthesize(
    lines,
    prompt="Produce a PR-review triage report. Two sections: 'Approve now' and 'Needs review'. "
           "Within each, hardest/riskiest first; for needs-review give the focus hints. "
           "Weight CODEOWNERS/required-policy PRs as higher stakes than manual asks.",
    label="report", **no_tools,
)
print(report.content)
