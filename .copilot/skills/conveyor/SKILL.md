---
name: conveyor
description: Run deterministic JavaScript orchestration over many Copilot agents.
---

# Dynamic workflows on the Copilot CLI

Use a workflow for broad audits, migrations, ranking, research, adversarial verification, or any task
whose branching/intermediate state should live in code instead of the main conversation.

Do not use a workflow for routine edits or lookups that fit in a few direct tool calls.

## Required process

1. Scout inline first and identify the real work list.
2. Choose `pipeline()` for per-item stages; use `parallel()` only for genuine barriers.
3. Rubber-duck reusable or high-risk designs.
4. Write a plain `.mjs` harness; start it with a literal `meta` block so runs are named in listings.
5. Preview with `run_conveyor({ ..., dryRun: true })`.
6. Show phases, projected agents, models/profiles, and budget before a paid run unless already approved.
7. Run with an explicit budget.
8. Inspect with `inspect_conveyor_run`; retrieve results with `get_conveyor_result`.

## Minimal workflow

```js
export const meta = {
  name: "review",
  description: "Review items and summarize verified findings.",
  phases: ["review", "report"],
};

const items = context.args || ["one", "two"];
const findings = await phase("review", () =>
  pipeline(items, (item) =>
    agent(`Review: ${item}`, {
      agentType: "worker",
      profile: "read-only",
      label: String(item).slice(0, 24),
    }),
  ),
);
const report = await phase("report", () =>
  agent(`Summarize the findings.\n\n${findings.map((f) => f.content).join("\n\n")}`, {
    profile: "none",
    label: "report",
  }),
);
return report.content;
```

## Defaults

- `onFailure` defaults to `raise`.
- `profile: "none"` for planners, judges, and synthesis that need no tools.
- `profile: "read-only"` for repository inspection.
- `profile: "research"` only when web/MCP access is required.
- Parent `allow-all on`, `allow-all auto`, and autopilot posture are inherited; profiles can only
  narrow them. Fine-grained parent rules are not exposed, so tool-using profiles fail closed in
  normal permission mode.
- MCP configuration and extra paths belong to `run_conveyor`, never agent options.
- The harness cannot mutate budget. The host may ask the user once to approve an increase at the boundary.
- Declared timeout, total-agent, and AIC limits are cumulative across resumes.
- Dry-run executes read-only effects for accurate discovery and skips mutating effects.
- The harness VM provides determinism, not a security boundary. Use an OS/cloud sandbox for
  untrusted workflow authors.

## Durable runs

The runtime atomically persists ownership, replay values, usage, state, and results.
Pause/resume is deterministic replay, not continuation serialization.

Use:

```text
inspect_conveyor_run({ runId })
get_conveyor_result({ runId })
get_conveyor_progress({ runId, afterSeq?, beforeSeq?, phaseId?, limit? })
control_conveyor_run({ runId, action: "pause" | "resume" | "cancel", invalidate?: ["/0", "/2/1"] })
```

On resume, `invalidate` reruns selected parallel/pipeline branches and their descendants while
retaining sibling replay values. Use `/` to rerun the whole workflow.

Replay identifies each `parallel`/`pipeline` group by the text of the harness line that
created it, so comments, reordering and edits elsewhere keep a group's cached branches. Two groups
that share one identity — created from the same line by a shared helper, or from two byte-identical
lines — are ordered by when they start. Create such groups synchronously (`items.map(helper)`,
`Promise.all([...])`, or an enclosing `parallel([...])`) rather than behind independent awaits, or
they may exchange cached results on resume.

## References

- [Conveyor API](references/conveyor-api.md)
- [Recipes](references/recipes.md)
