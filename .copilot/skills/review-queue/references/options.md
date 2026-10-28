# Queue options

Use these controls only when the default fetch and run need adjustment.

## Fetch scope and freshness

Pass fetch options to `scripts/review-queue-fetch.sh`, resolved from this skill's base directory.
Use `--help` for the complete CLI, dependency requirements, and exit codes; it works without
authentication or installed fetch dependencies.

| Need | Option |
| --- | --- |
| Change the result limit per account/team or Azure lookup | `--limit N` (default: 100) |
| Include older PRs | `--max-age-days N` (default: 30), or `--all-ages` |
| Restrict platforms | `--github-only` or `--azure-only` |
| Select an Azure organization/project | `--ado-org ORG --ado-project PROJECT` |
| Include additional Azure scopes | Repeat `--ado-scope ORG PROJECT` |

GitHub queries all locally authenticated `github.com` accounts without changing the active account.
Azure DevOps requires `az login`; explicit scopes override or supplement the configured/default
organization and project. Fetch limits apply to individual lookups, not the deduplicated total.
Use a positive integer for `--limit` and a non-negative integer for `--max-age-days`; zero days
disables the age filter. The two platform-only flags are mutually exclusive. `--no-diff` produces
metadata-only evidence that cannot support an approval recommendation.

## Workflow arguments

Pass these optional fields alongside `prs` in `run_dynamic_workflow`'s `args`.

| Field | Effect |
| --- | --- |
| `approve_only_low_risk_manual: true` | Recommend approval only for clean, independently verified, manually assigned PRs |
| `diff_chunk_chars` | Set the character count per diff chunk |
| `max_total_chunks` | Bound the total supplied diff chunks admitted by the workflow |
| `freshness` | Label the input queue's freshness in the report |
| `pauseBeforeWork: true` | Journal and show the prepared PR/chunk scope, then pause once before reviewers start |

The default chunk limit is 300, and the current 700-agent ceiling supports up to 350 chunks.
Each chunk reserves one reviewer and one independent verifier. Structured-output correction turns
reuse those agents, though their time and credits still count toward the runtime limits.
Checkpoints default to off. Resuming the same run reuses the prepared scope and completed agents;
it does not refetch the queue or grant approval to any PR.

GitHub CODEOWNERS is evaluated per changed file. Azure DevOps uses required-policy/manual attribution.
Assignment policy never bypasses evidence or verification requirements. Chunk controls do not override
the workflow's declared runtime limits; pass `limits` only for an explicitly requested user override,
and never lower a declared limit without an explicit user request.

## Recovery

Inspect the original `runId` before deciding whether work failed. Resume a resumable paused or failed run with
`run_dynamic_workflow({ resumeFromRunId: "<run-id>" })` to reuse completed work. A reached limit needs explicit
user authorization before it is raised; do not refetch or start another run to evade it.
If the workflow is unavailable, report the missing Foundry prerequisite instead of running a
replacement review pool.
