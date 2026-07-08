dotfiles
========

Just run `source ./sync` (or `. ./sync`).

It must be **sourced** so it can reload your shell afterwards, and the leading
`./` is required — a bare `. sync` would source `/bin/sync` instead. Works from
both zsh and bash.

## Copilot Workflow — dynamic workflows on the Copilot CLI

`source ./sync` also installs the **workflow** Copilot extension, which orchestrates many GitHub
Copilot CLI subagents in parallel (fan-out/synthesize, adversarial verification, tournaments, ...)
from an async JavaScript harness (`.mjs`), with checkpoint/resume, budgets, and a live progress
view. Say `workflow: <task>` in a `copilot` session (or `xtreme: <task>` to use the high-confidence
preset), invoke the `run_workflow` tool directly, and inspect runs with `/workflow` or `/wf`.

See [`.copilot/skills/workflow/SKILL.md`](.copilot/skills/workflow/SKILL.md).
