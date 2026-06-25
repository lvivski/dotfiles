---
name: workflow
description: >-
  Use this skill when the user asks for ultrawork, a workflow, parallel/fan-out agents,
  cross-checking, adversarial verification, deep research, large codebase audits or migrations,
  ranking/triage of many items, or work that one conversation context cannot reliably hold. Do not
  use it for simple lookups, ordinary single-file edits, or tasks you can finish directly in a few
  tool calls.
compatibility: GitHub Copilot CLI with cwf available on PATH; Python 3.9+ and the copilot CLI.
metadata:
  copilot.user-invocable: "true"
  copilot.runtime: "cwf"
user-invocable: true
---

# Dynamic workflows on the Copilot CLI

Use `cwf` to author and run a small synchronous Python harness that coordinates many `copilot`
subagents. The harness owns branching, loops, checkpoints, and intermediate results; this keeps the
main conversation focused on the final synthesized answer.

**Execution path.** When the cwf extension is loaded, run workflows via the native `run_workflow`
tool — it streams progress into the session and returns a structured result. The `cwf` CLI commands
shown below are the headless/fallback equivalent (used for `cwf loop`, scripting, or when the
extension isn't loaded); tool params map 1:1 to the CLI flags.

## Decision boundary

Use a workflow when the task genuinely benefits from independent contexts or repeatable quality
gates:

- Codebase-wide audits, sweeps, migrations, or multi-file reviews.
- Deep research that should fan out over sources, angles, or claims.
- Large ranking, triage, clustering, or comparative-judgment tasks.
- Plans or designs worth drafting from several independent angles before execution.
- Any request where you would otherwise paste dozens of items into one prompt.

Do **not** use a workflow for quick questions, simple searches, ordinary single-file edits, or work
you can complete with a few direct tool calls. Workflows spend more time and premium credits.

## Required process

1. **Scout inline first.** Discover the work list yourself with normal tools: changed files, target
   directories, sources, tickets, endpoints, or candidate options. Do not fan out until you know the
   shape of the work.
2. **Pick the pattern.** Default to `wf.pipeline()` for multi-stage per-item work. Use a barrier
   (`wf.fan_out`, `wf.parallel`, `wf.synthesize`) only when a stage needs all previous results at
   once.
3. **Write a harness.** Use `./<name>.cwf.py` for one-offs or `~/.copilot/workflows/<name>.py` for
   reusable workflows. Harnesses are plain synchronous Python; never use `async`/`await`.
4. **Preview and confirm paid runs.** Before spending credits, show the user phases, approximate
   subagent count, models, and a premium-credit budget. Ask for confirmation unless the user already
   told you to go ahead. Preview for free with the `run_workflow` tool (`dryRun: true`) — or
   `cwf run harness.py --dry-run` headless.
5. **Run with a budget.** Call `run_workflow` with `{ scriptPath, budget: <N> }` — params map 1:1 to
   the CLI (`disableMcp`, `concurrency`, `model`, `restricted`, `strictBudget`, `args`). Headless:
   `cwf run harness.py --budget <N> ...`. Set `disableMcp` when agents do not need GitHub/MCP. Start
   with a small slice for large or unknown-cost jobs.
6. **Return the result.** The `run_workflow` tool returns the harness's final answer plus its `runId`
   and persisted harness path, and streams progress live; present the result. To iterate or continue,
   re-invoke with the same `scriptPath` or `resume: <runId>`. (Headless: the harness prints the answer
   to stdout and progress/stats to stderr; resume with `cwf run harness.py --resume <runId>`.)

## Defaults that avoid common mistakes

- Use small models for wide fan-out and stronger models only for synthesis, judging, or hard
  verification.
- Tag inner agents with `phase=` and `label=` so progress stays readable.
- Prefer `wf.structured()` over hand-parsing JSON from agent text.
- Treat `--budget` / `wf.budget()` as an observed-spend soft cap: in-flight agents may finish and
  overshoot before new agents are skipped. Use `--strict-budget` only when the harness should raise
  after the cap is observed.
- For recurring loops (`cwf loop --every ...`), persist progress with `--memory PATH`: each tick is a
  fresh run, so read prior state with `wf.memory.read()` and record next steps with
  `wf.memory.append(...)` (checkpoints are per-run only). Start from `examples/loop-memory.cwf.py`.
- Quarantine agents that read untrusted/public content: `wf.quarantine()`. Later verifier or
  synthesis agents that consume untrusted-derived text should also avoid pre-authorized tools, e.g.
  `wf.quarantine(allow_all_tools=False)`.
- For untrusted harness authors, use `cwf run --restricted` plus an OS/agent sandbox
  (`copilot --cloud` or `/sandbox`). `--restricted` is determinism and footgun prevention, not a
  security jail.
- Never silently cap coverage. If you sample, drop top-N items, skip retries, or stop due to budget,
  log it with `wf.log()` and say so in the final answer.

## Minimal harness

Start from `examples/minimal-review.cwf.py`; copy it to `./<name>.cwf.py` and adapt the prompts,
rubric, and input list. Keep examples as Python files so they are runnable and syntax-checkable.

Run the copied harness via the `run_workflow` tool:

```
run_workflow({ scriptPath: "harness.cwf.py", budget: 10, disableMcp: true, args: ["one", "two"] })
```

Headless / fallback equivalent:

```bash
cwf run harness.cwf.py --budget 10 --disable-mcp --args '["one", "two"]'
```

## Load more only when needed

- Read [the wf API reference](references/wf-api.md) when writing a harness or checking an exact
  method signature.
- Read [workflow recipes](references/recipes.md) when choosing between pipeline, fan-out,
  adversarial verification, tournaments, generate-and-filter, classify-and-route, loop-until-done,
  or quarantine patterns.
- Use the files in `examples/` as copyable harness templates; do not paste large Python examples
  into the skill body.
- Read `.local/lib/copilot_workflows/README.md` from the dotfiles repo only when you need full
  implementation details or CLI behavior beyond this skill.
