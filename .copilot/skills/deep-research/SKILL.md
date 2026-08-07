---
name: deep-research
description: >-
  Use this skill when the user wants a source-backed research report, market/technology research,
  current-state investigation, or a deep answer that should fan out across independent web research
  angles and verify cited claims. Do not use it for local codebase audits, PR review queues, or quick
  factual lookups that can be answered directly.
compatibility: GitHub Copilot CLI with the conveyor extension loaded.
metadata:
  copilot.user-invocable: "true"
  copilot.runtime: "conveyor"
user-invocable: true
---

# Deep research

Invoke the saved workflow; do not write a new harness.

Use `name: "deep-research"` with args as either a string question or
`{ "question": "...", "angles": 5 }` (`angles` is capped at 12). A missing question is an input
error.

```text
run_conveyor({
  name: "deep-research",
  args: { "question": "<question>", "angles": 5 },
  limits: {
    maxConcurrentSubagents: 6,
    maxTotalSubagents: 40,
    timeoutSeconds: 1800,
    maxAiCredits: 200
  }
})
```

Research verifiers independently open cited URLs. If no angle passes source verification, the
workflow returns an explicitly unsupported report and never synthesizes unverified findings. Return
the cited report and any explicit limitations or open questions.
