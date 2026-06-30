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

# Review queue

Fetch first, then invoke the saved workflow. Do not write a new harness and never approve PRs; report
triage only.

1. **Fetch queue data (free).**
   ```bash
   ~/.copilot/skills/review-queue/scripts/review-queue-fetch.sh --limit 100 > /tmp/review-queue.json
   ```
   GitHub uses all locally authenticated `github.com` accounts; do not ask the user to switch active
   accounts. Azure DevOps is optional and uses `az login` plus configured/default org/project or
   explicit `--ado-org` / `--ado-project` / repeated `--ado-scope ORG PROJECT`. If the JSON is `[]`,
   report that nothing is assigned and stop.
2. **Preview/run.** Show PR count, platforms, budget, and whether deep checkout is enabled. Then run:
   ```text
   run_workflow({ scriptPath: "~/.copilot/workflows/review-queue.cwf.py",
                  budget: 10000,
                  args: { prs: <contents of /tmp/review-queue.json> } })
   ```
   Headless equivalent:
   ```bash
   cwf run ~/.copilot/workflows/review-queue.cwf.py --budget 10000 --args @/tmp/review-queue.json
   ```
3. **Return the triage table** with linked PRs, platform/account, coverage, decision, risk,
   why-assigned, justification, focus hints, AIC used, and `runId`.

Useful knobs: fetch stale PRs with `--max-age-days N` / `--all-ages`; pass workflow args
`auto_deep: false` for diff-only, `deep: true` to checkout every PR, or
`approve_only_low_risk_manual: true` for conservative approval guidance. Big queues may need more
than 10,000 AIC.
