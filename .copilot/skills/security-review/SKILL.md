---
name: security-review
description: >-
  Use this skill when the user wants a security review, deep security review, or security audit.
compatibility: GitHub Copilot CLI with the conveyor extension loaded.
metadata:
  copilot.user-invocable: "true"
  copilot.runtime: "conveyor"
user-invocable: true
---

# Security review

Invoke the saved `security-review` Conveyor. It uses native Factory agents to orient around the
repository, investigate the requested scope from independent security perspectives, deduplicate
candidates, and send every candidate through a skeptical verifier.

With no args it reviews the current repository. Scope it to a subtree, explicit files, or a branch
comparison:

```text
run_conveyor({
  name: "security-review",
  args: { root: "src/", perspectives: 8 },
  limits: {
    maxConcurrentSubagents: 6,
    maxTotalSubagents: 80,
    timeoutSeconds: 3600,
    maxAiCredits: 1000
  }
})

run_conveyor({ name: "security-review", args: { files: ["src/a.js", "src/b.js"] } })
run_conveyor({ name: "security-review", args: { base: "main", head: "HEAD" } })
```

Args:

- Scope: `root`, `files`, or `base` plus optional `head`.
- `perspectives`: independent review lenses, 1–12; default 6.
- `context`: operator-supplied architecture or threat-model context.
- `model`: optional native Factory agent model override.

Every investigator must establish an attacker-controlled source, a missing or bypassed control, and
a dangerous sink. Reviewers must follow authorization and data-flow code, search for mitigations,
state contrary evidence, and avoid speculative hygiene findings. Verification fails closed: only
`true-positive` findings appear in the report.

Treat the result as bounded static coverage, not proof that the code is vulnerability-free.
