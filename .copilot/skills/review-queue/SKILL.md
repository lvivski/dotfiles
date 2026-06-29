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
   ~/.copilot/skills/review-queue/scripts/review-queue-fetch.sh --limit 100 > /tmp/review-queue.json
   ```
   GitHub needs `gh auth` for each desired account; all authenticated `github.com` accounts are
   scanned without switching the active account. Azure needs `az login` plus `--ado-org` /
   `--ado-project`, `AZURE_DEVOPS_ORG` / `AZURE_DEVOPS_PROJECT`, or configured `az devops` defaults.
   Add extra Azure scopes with repeated `--ado-scope ORG PROJECT` flags. Use project `*`
   to scan every project in an org.
   If the file is `[]`, tell the user nothing is assigned and stop.
2. **Preview.** Show count, platforms, model, and budget; confirm before the paid run.
3. **Run.** Each PR gets a quarantined reviewer and a structured approve|needs_review verdict;
   CODEOWNERS/required-policy PRs are weighted higher than manual asks:
   ```
   run_workflow({ scriptPath: "~/.copilot/workflows/review-queue.cwf.py",
                  budget: 10000, args: { prs: <contents of /tmp/review-queue.json>, deep: false } })
   ```
   Headless: `cwf run ~/.copilot/workflows/review-queue.cwf.py --budget 10000 --args @/tmp/review-queue.json`.
   Auto-deepening reviews the fetched diff first, then checks out only PRs that need surrounding
   code. It creates a git worktree from `~/Developer/<repo>`, cloning missing repos there first.
4. **Return** the Markdown triage table with linked PRs, source account/platform, updated date,
   changed-file count, coverage, decision, risk, why-assigned, justification, focus hints, plus
   AIU used and `runId`.

## Notes

- Read-only: reviewers see only the captured diff; never auto-approve — surface, don't act.
- "Why assigned" = `codeowner` (file matches a CODEOWNERS rule listing you/your team), `required-policy`
  (required ADO reviewer), else `manual`. This drives the risk weight.
- Stale PRs are skipped by default: only PRs updated in the last 30 days are fetched. Use
  `--max-age-days N` to tune that or `--all-ages` to include everything.
- Diffs are not truncated. Big queues may need budget headroom; use `--no-diff` only for a cheap
  metadata pass.
- Coverage values are explicit: `full diff`, `partial diff`, `summary only`, `diff unavailable`,
  `no diff`, or `deep checkout`.
- Conservative approval mode: pass `approve_only_low_risk_manual: true` in workflow args to force
  anything other than low-risk manual requests into `needs_review`.
- Deepening: `auto_deep` defaults to `true`; set `auto_deep: false` for diff-only, or `deep: true`
  to check out every PR immediately. Repos live under `~/Developer` unless `developer_root` is
  passed; missing repos are cloned there and reused.
- **Azure scopes:** `--ado-scope https://dev.azure.com/example-org/ '*'` scans every project in
  another org. `AZURE_DEVOPS_EXTRA_SCOPES='org|project;otherorg|*'` adds the same scopes
  non-interactively.
- See `.local/lib/copilot_workflows/README.md` for cwf internals; harness: `review-queue.cwf.py`.
