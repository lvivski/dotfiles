# Recon

Recon registers five standalone native Copilot workflows:

| Workflow | Result |
|---|---|
| `audit` | Findings from checking specified paths for a concern and independently verifying the reviews. |
| `deep-research` | A report on a question from multiple angles, with source checks and unresolved claims identified. |
| `review-queue` | A triage table for supplied PR diffs and fetch evidence. An approval recommendation is not a PR approval. |
| `security-review` | A report from independent security perspectives on a repository scope, with findings verified. |
| `triage` | A table classifying supplied tickets and suggesting next actions. |

Use `run_dynamic_workflow` when the user explicitly requests work at this scale or an activated
skill directs it. Inspect the argument schema with `dynamic_workflows_manage inspect` and the
report with `inspect-run`. The native runtime owns limits, checkpoints and results; use the
original run ID to resume. When deep research reaches a time review, the user can extend the
same run by an hour, keep it paused, or stop. Dismissing the decision leaves it stopped.

The host supplies the SDK. From the repository root, run the offline behavioral tests with
`node --test '.copilot/extensions/recon/**/*.test.mjs'`. To type-check against the host's
declarations, pass `.copilot/extensions/recon` as the fifth argument to the
[installed-SDK checker](../foundry/README.md#installed-sdk-checker-contract).
