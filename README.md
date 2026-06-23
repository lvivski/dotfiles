dotfiles
========

Just run `source ./sync` (or `. ./sync`).

It must be **sourced** so it can reload your shell afterwards, and the leading
`./` is required — a bare `. sync` would source `/bin/sync` instead. Works from
both zsh and bash.

## cwf — dynamic workflows on the Copilot CLI

`source ./sync` also installs **cwf**, which orchestrates many GitHub Copilot CLI subagents in parallel
(fan-out/synthesize, adversarial verification, tournaments, …) from a small Python harness, with
checkpoint/resume, budgets, and a live progress view. Say `ultrawork: <task>` in a `copilot`
session, or run `cwf run <harness.py>`.

See [`.local/lib/copilot_workflows/README.md`](.local/lib/copilot_workflows/README.md).

