dotfiles
========

Just use `. sync`

## cwf — dynamic workflows on the Copilot CLI

`. sync` also installs **cwf**, which orchestrates many GitHub Copilot CLI subagents in parallel
(fan-out/synthesize, adversarial verification, tournaments, …) from a small Python harness, with
checkpoint/resume, budgets, and a live progress view. Say `ultrawork: <task>` in a `copilot`
session, or run `cwf run <harness.py>`.

See [`.local/lib/copilot_workflows/README.md`](.local/lib/copilot_workflows/README.md).

