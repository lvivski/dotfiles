---
name: deep-research
description: >-
  Use this skill when the user wants a source-backed research report, market/technology research,
  current-state investigation, or a deep answer that should fan out across independent web research
  angles and verify cited claims. Do not use it for local codebase audits, PR review queues, or quick
  factual lookups that can be answered directly.
compatibility: GitHub Copilot CLI with the Foundry extension loaded.
metadata:
  copilot.user-invocable: "true"
user-invocable: true
---

# Deep research

```text
run_factory({
  name: "deep-research",
  args: { "question": "<question>", "angles": 5 }
})
```

Do not pass `limits` to `run_factory`; use the factory's declared limits unless the user explicitly
requests an override. Never lower a declared limit without an explicit user request.

`question` is required; `angles` defaults to 5 and is capped at 12. Factory-owned routing agents
synchronously delegate each angle to the built-in `research` agent. Angle pipelines run in batches of
two to avoid multiplying parallel searches and upstream timeouts. Verifiers independently open cited
URLs. If no angle passes source verification, the factory returns an explicitly unsupported report
and never synthesizes unverified findings. Return the cited report and its explicit limitations or
open questions.
