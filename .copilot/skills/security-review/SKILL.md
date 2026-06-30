---
name: security-review
description: >-
  Use this skill when the user wants a security review, deep security review, or security audit.
compatibility: GitHub Copilot CLI with cwf; Python 3.9+; git optional for diff mode.
metadata:
  copilot.user-invocable: "true"
  copilot.runtime: "cwf"
user-invocable: true
---

# Security review

Invoke the saved workflow; do not write a new harness.

Preview first:

```text
run_workflow({ scriptPath: "~/.copilot/workflows/security-review.cwf.py",
               dryRun: true, budget: 10000,
               args: { "root": ".", "diff": "origin/main", "max_files": 20 } })
```

Then run with an explicit file source and budget:

```text
run_workflow({ scriptPath: "~/.copilot/workflows/security-review.cwf.py",
               budget: 10000, model: "claude-opus-4.8", effort: "high",
               context: "long_context",
               args: { "root": ".", "diff": "origin/main", "batch_size": 4,
                       "max_files": 40, "state": ".security-review/state.json",
                       "comment_out": ".security-review/comment.md",
                       "revalidate_with_git": true, "fail_on_findings": true } })
```

Use exactly one file source: `files`, `files_from`, `diff`, `diff_staged`, or `diff_working`.
With no source, the workflow uses repo-wide regex-gated scanning; treat its report as bounded
coverage, not proof that the repo is vulnerability-free.

Key args: `include`, `exclude`, `priority_paths`, `batch_size`, `concurrency`, `max_files`, `state`,
`comment_out`, `net_new_only`, `summarize`, `fail_on_findings`, `revalidate_with_git`,
`revalidate_force`, and `revalidate_limit`.

MCP is off by default and should stay off. Do not use `restricted` for diff/state modes because the
workflow needs local file and git access. Return the Markdown report plus `runId`, AIC used, and any
coverage boundary.
