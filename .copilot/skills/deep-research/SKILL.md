---
name: deep-research
description: >-
  Use this skill when the user wants a source-backed research report, market/technology research,
  current-state investigation, or a deep answer that should fan out across independent web research
  angles and verify cited claims. Do not use it for local codebase audits, PR review queues, or quick
  factual lookups that can be answered directly.
compatibility: GitHub Copilot CLI with the workflow extension loaded.
metadata:
  copilot.user-invocable: "true"
  copilot.runtime: "workflow"
user-invocable: true
---

# Deep research

Invoke the saved workflow; do not write a new harness.

Use `name: "deep-research"` with args as either a string question or
`{ "question": "...", "angles": 5 }` (`angles` is clamped to at most 12). A missing question is an
input error; the workflow never substitutes a sample topic. Preview first, then run with a deliberate
budget:

```text
run_copilot_workflow({ name: "deep-research", dryRun: true, budget: 10000,
               args: { "question": "<question>", "angles": 5 } })

run_copilot_workflow({ name: "deep-research", budget: 10000,
               args: { "question": "<question>", "angles": 5 } })
```

For broad/high-stakes research, use `preset: "xtreme"` instead of manually raising every tuning
knob. The preset binds the parent session's concrete model with `xhigh` effort and long context. If
the parent uses Auto routing, the selected model's defaults are retained. The harness uses
`profile: "research"` only for research and source-verification agents.

Research verifiers independently open cited URLs. If no angle passes source verification, the
workflow returns an explicitly unsupported report and never synthesizes unverified findings. Return
the cited report, `runId`, AIC used, and any explicit limits/open questions from the workflow.
