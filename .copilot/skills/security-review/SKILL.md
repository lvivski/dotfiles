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

Invoke the saved workflow; do not write a new harness. It runs an agent-driven pipeline: a read-only
**scanner agent** enumerates candidate security-sensitive locations (across a common vulnerability
taxonomy), investigation agents review each batch, findings are adversarially **verified**, and a
severity-sorted Markdown report is synthesized.

Preview first (no AIC spent):

```text
run_workflow({ name: "security-review", dryRun: true, budget: 6000 })
```

Then run. With no args it reviews the staged/unstaged changes (`git diff`), or the current directory
if there are none:

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

Treat the report as **bounded coverage** — an agent-driven scan, not proof that the code is
vulnerability-free. MCP stays off; the scanner uses read-only tools with no network egress. Do not use
`restricted` (the scanner needs read/git tool access). Return the Markdown report plus `runId`, AIC
used, and the coverage note.
