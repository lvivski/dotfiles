---
name: review-queue
description: >-
  Use this skill when the user wants to triage their PR review queue — gather every pull request
  they are assigned to review (directly or via a team) across GitHub and Azure DevOps, review them
  in parallel, and report which are safe to approve vs which need a real look, with focus hints and
  why they were added (CODEOWNERS / required policy vs manual). Do not use it for a single named PR.
compatibility: GitHub Copilot CLI with cwf on PATH; gh + jq required, az optional; Python 3.9+.
metadata:
  copilot.user-invocable: "true"
  copilot.runtime: "cwf"
user-invocable: true
---

# Review-queue triage

Fan out reviewers over the user's whole PR review queue and report what's approvable vs what needs
attention. Fetch is deterministic (no AIU); the cwf harness spends AIU only on the reviews.

## Process

1. **Fetch the queue (free, read-only).** Run the bundled script — it normalizes both platforms and
   skips a side whose CLI is missing/unauthed:
   ```bash
   ~/.copilot/skills/review-queue/scripts/review-queue-fetch.sh --limit 30 > /tmp/review-queue.json
   ```
   GitHub needs `gh auth`; Azure needs `az login` + `--ado-org/--ado-project` (or `AZURE_DEVOPS_ORG/_PROJECT`).
   If the file is `[]`, tell the user nothing is assigned and stop.
2. **Preview.** Show count, platforms, model, and budget; confirm before the paid run.
3. **Run.** Each PR gets a quarantined reviewer, a structured approve|needs_review verdict, and a
   synthesized report; CODEOWNERS/required-policy PRs are weighted higher than manual asks:
   ```
   run_workflow({ scriptPath: "~/.copilot/workflows/review-queue.cwf.py",
                  budget: 10000, args: { prs: <contents of /tmp/review-queue.json>, deep: false } })
   ```
   Headless: `cwf run ~/.copilot/workflows/review-queue.cwf.py --budget 10000 --args @/tmp/review-queue.json`.
4. **Return** the two-section triage (Approve now / Needs review) plus AIU used and `runId`.

## Notes

- Read-only: reviewers see only the captured diff; never auto-approve — surface, don't act.
- "Why assigned" = `codeowner` (file matches a CODEOWNERS rule listing you/your team), `required-policy`
  (required ADO reviewer), else `manual`. This drives the risk weight.
- Big queues: add `--budget` headroom or `--no-diff` to fetch (titles/files only) for a cheap pass.
- **Depth:** default reviewers reason over the captured diff (cheap, fully parallel). For deeper
  review pass `deep: true` in args; the harness checks out each PR (GitHub or ADO) in an isolated
  worktree so reviewers can grep neighbors/tests — still read-only, capped (default 6, set
  `concurrency`), never runs PR code. A PR whose clone needs creds it lacks falls back to diff.
- See `.local/lib/copilot_workflows/README.md` for cwf internals; harness: `review-queue.cwf.py`.
