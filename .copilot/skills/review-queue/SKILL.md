---
name: review-queue
description: >-
  Use this skill when the user wants to triage their PR review queue — gather every pull request
  they are assigned to review (directly or via a team) across GitHub and Azure DevOps, review them
  in parallel, and report which are safe to approve vs which need a real look, with focus hints and
  why they were added (CODEOWNERS / required policy vs manual). Do not use it for a single named PR.
compatibility: GitHub Copilot CLI with the workflow extension loaded; gh + jq required, az optional.
metadata:
  copilot.user-invocable: "true"
  copilot.runtime: "workflow"
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
   run_workflow({ name: "review-queue",
                  budget: 10000,
                  args: { prs: <contents of /tmp/review-queue.json> } })
   ```
3. **Return the triage table** with linked PRs, platform/account, coverage, decision, risk,
   why-assigned, justification, focus hints, AIC used, and `runId`.

Useful knobs: fetch stale PRs with `--max-age-days N` / `--all-ages`; pass workflow args
`auto_deep: false` for diff-only, `deep: true` to checkout every PR, or
`approve_only_low_risk_manual: true` for conservative approval guidance. Diff/checkouts are bounded
into chunks (`diff_chunk_chars`, `file_chunk_size`, `max_chunks`, `max_total_chunks`) and every cap is
reported. The default queue capacity is 300 chunks (up to roughly 7.2 MB of diff at the default chunk
size, or 18 MB with `diff_chunk_chars: 60000`); larger queues must be split across runs. GitHub
CODEOWNERS is fetched from the PR base branch and evaluated per changed file; Azure DevOps remains
required-policy/manual attribution only. `Approve` is emitted only when every chunk is complete,
low-risk, clean, and independently reverified against the original diff/files. A failed checkout, a
missing/deleted/symlinked checkout path, or a binary/metadata-only diff is degraded coverage and
cannot approve. Big queues may need more than 10,000 AIC.
