---
name: deep-research
description: >-
  Use this skill when the user wants a source-backed research report, market/technology research,
  current-state investigation, or a deep answer that should fan out across independent web research
  angles and verify cited claims. Do not use it for local codebase audits, PR review queues, or quick
  factual lookups that can be answered directly.
compatibility: GitHub Copilot CLI with cwf on PATH; Python 3.9+.
metadata:
  copilot.user-invocable: "true"
  copilot.runtime: "cwf"
user-invocable: true
---

# Deep research

Invoke the saved workflow; do not write a new harness.

Use `name: "deep-research"` with args as either a string question or
`{ "question": "...", "angles": 5 }`. Preview first, then run with a deliberate budget:

```text
run_workflow({ name: "deep-research", dryRun: true, budget: 10000,
               args: { "question": "<question>", "angles": 5 } })

run_workflow({ name: "deep-research", budget: 10000,
               args: { "question": "<question>", "angles": 5 } })
```

For broad/high-stakes research, use `preset: "xtreme"` instead of manually raising every tuning
knob. Do **not** set global `enableMcp`; the harness opts MCP/network in only for research agents.

Return the cited report, `runId`, AIC used, and any explicit limits/open questions from the workflow.
