---
name: review-queue
description: >-
  Use this skill when the user wants to triage their PR review queue — gather every pull request
  they are assigned to review (directly or via a team) across GitHub and Azure DevOps, review them
  in parallel, and report which are safe to approve vs which need a real look, with focus hints and
  why they were added (CODEOWNERS / required policy vs manual). Do not use it for a single named PR.
compatibility: GitHub Copilot CLI with the Foundry extension loaded; gh + jq required, az optional.
metadata:
  copilot.user-invocable: "true"
user-invocable: true
---

# Review queue

Fetch first, then run `review-queue`. Never approve PRs; report triage only.

1. **Fetch queue data (free).**
   ```bash
   ~/.copilot/skills/review-queue/scripts/review-queue-fetch.sh --limit 100 > /tmp/review-queue.json
   ```
   GitHub uses all locally authenticated `github.com` accounts; do not ask the user to switch active
   accounts. Azure DevOps is optional and uses `az login` plus configured/default org/project or
   explicit `--ado-org` / `--ado-project` / repeated `--ado-scope ORG PROJECT`. If the JSON is `[]`,
   report that nothing is assigned and stop.
2. **Run.** Show PR count, platforms, and supplied diff coverage, then launch:
   ```text
   run_factory({
     name: "review-queue",
     args: { prs: <contents of /tmp/review-queue.json> }
   })
   ```
   Do not pass `limits` to `run_factory`; use the factory's declared limits unless the user explicitly
   requests an override. Never lower a declared limit without an explicit user request.
3. **Return** the resulting triage table with linked PRs, platform/account, coverage, decision, risk,
   why-assigned, justification, and focus hints.

Useful knobs: fetch stale PRs with `--max-age-days N` / `--all-ages`; pass
`approve_only_low_risk_manual: true`, `diff_chunk_chars`, or `max_total_chunks`. The workflow reviews
only supplied diff evidence. Missing, binary-only, or partial diffs cannot produce `Approve`.
GitHub CODEOWNERS is evaluated per changed file; Azure DevOps uses required-policy/manual
attribution. Every low-risk chunk must also pass independent verification.
