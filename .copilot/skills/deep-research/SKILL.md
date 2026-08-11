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

`question` is required; `angles` defaults to 5 and is capped at 12. Research verifiers independently
open cited URLs. If no angle passes source verification, the factory returns an explicitly
unsupported report and never synthesizes unverified findings. Return the cited report and its
explicit limitations or open questions.
