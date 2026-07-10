---
name: security-review
description: >-
  Use this skill when the user wants a security review, deep security review, or security audit.
compatibility: GitHub Copilot CLI with the workflow extension loaded; git optional for change-scoped mode.
metadata:
  copilot.user-invocable: "true"
  copilot.runtime: "workflow"
user-invocable: true
---

# Security review

Invoke the saved workflow; do not write a new harness. A read-only host sidecar deterministically
enumerates the git/filesystem scope, scans a common vulnerability taxonomy, applies explicit caps,
and hashes candidate files. Investigation agents review bounded batches, host code revalidates each
reported path/line against current file content, and read-only verifier agents inspect the original
source before a severity-sorted report is produced.

Preview first (no AIC spent):

```text
run_workflow({ name: "security-review", dryRun: true, budget: 6000 })
```

Then run. With no args it reviews staged, unstaged, and untracked changes, or the current directory if
there are none:

```text
run_workflow({ name: "security-review", budget: 6000,
               model: "claude-opus-4.8", effort: "high", context: "long_context" })
```

Scope it to a subtree or explicit files, and tune batching:

```text
run_workflow({ name: "security-review", budget: 6000,
               args: { root: "src/", batch_size: 4, concurrency: 6, summarize: true } })
```

Args:

- Scope (choose one): omit for staged/unstaged changes; `root: "<dir>"` for a subtree; or an array of
  file paths / `{ files: [...] }` for explicit files.
- `batch_size` (default 4), `concurrency` (parallel batches), `summarize` (default true).
- Coverage caps: `max_files` (default 60), `max_candidates` (default 500),
  `max_candidates_per_file` (default 20), and `max_file_size` (default 200000 bytes). Every applied
  cap is included in the report.

Treat the report as **bounded candidate coverage**, not proof that the code is vulnerability-free.
Discovery and evidence validation bypass resume caching so changed files cannot replay stale scope.
MCP/network stays off and model agents are read-only. Do not use `restricted` because host effects are
required. Return the Markdown report plus `runId`, AIC used, and the coverage note.
