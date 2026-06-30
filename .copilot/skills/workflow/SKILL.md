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
you can complete with a few direct tool calls. Workflows spend more time and AIC.

## Required process

1. **Scout inline first.** Discover the work list yourself with normal tools: changed files, target
   directories, sources, tickets, endpoints, or candidate options. Do not fan out until you know the
   shape of the work.
2. **Pick the pattern.** Default to `wf.pipeline()` for multi-stage per-item work. Use a barrier
   (`wf.fan_out`, `wf.parallel`, `wf.synthesize`) only when a stage needs all previous results at
   once.
3. **Rubber-duck reusable designs.** Before implementing a new reusable workflow, a broad audit, or
   a large harness change, have an independent reviewer critique the plan for missing gates,
   unsafe tool access, budget/coverage blind spots, and result-integrity issues. Fold in the
   high-signal feedback before writing code.
4. **Write a harness.** Use `./<name>.cwf.py` for one-offs or `~/.copilot/workflows/<name>.py` for
   reusable workflows. Harnesses are plain synchronous Python; never use `async`/`await`.
5. **Preview and confirm paid runs.** Before spending AIC, show the user phases, approximate
   subagent count, models, and an AIC budget. Ask for confirmation unless the user already
   told you to go ahead. Preview for free with the `run_workflow` tool (`dryRun: true`) — or
   `cwf run harness.py --dry-run` headless.
6. **Run with a budget.** Call `run_workflow` with `{ scriptPath, budget: <N> }` — params map 1:1 to
   the CLI (`disableMcp`, `concurrency`, `model`, `effort`, `context`, `restricted`, `strictBudget`,
   `args`). Headless: `cwf run harness.py --budget <N> ...`. Set `disableMcp` when agents do not need
   GitHub/MCP. Bias generated workflows toward generous caps and let the user request tighter constraints when cost matters.
7. **Return the result.** The `run_workflow` tool returns the harness's final answer plus its `runId`
   and persisted harness path, and streams progress live; when reporting progress or status, include
   the cumulative AIC used. To iterate or continue, re-invoke with the same
   `scriptPath` or `resume: <runId>`. (Headless: the harness prints the answer to stdout and
   progress/stats to stderr; resume with `cwf run harness.py --resume <runId>`.)

## Defaults that avoid common mistakes

- Prefer modern, capable models by default rather than old/cheap defaults. Any model Copilot offers
  works — GPT, Claude, Gemini, a BYOK provider, or `auto` (let Copilot pick); cwf passes the model
  string through opaquely and should not bias generated workflows toward a single provider. Use a
  fast current model for broad fan-out and a stronger current model for synthesis, judging, or hard
  verification.
- Let the harness pick a model per agent, but honor the user when they want to choose: `model`,
  `effort` (`none…max`), and `context` (`default|long_context`) set the **session defaults** agents
  inherit, while a per-agent value pinned in the script wins (mirrors Claude Code: an `agent()`
  inherits the session model/effort unless it sets its own). Surface them in the preview so the user
  can pick the model, reasoning effort, or context-window tier before the run starts. Note `effort`
  only affects reasoning-capable models (Copilot enforces this), so don't set a session `effort` when
  the harness's agents run on models that don't support it.
- Tag inner agents with `phase=` and `label=` so progress stays readable.
- Prefer `wf.structured()` over hand-parsing JSON from agent text.
- Keep harness code clean and boring: small named helpers, explicit input normalization, clear
  phase labels, no broad catches that turn failures into success, and no clever parsing when a
  `wf` primitive exists.
- Keep constants simple. Start with the smallest useful defaults, group related constants near the
  logic that uses them, and avoid sprawling catalogs in the harness. If a constant set becomes large
  or reused across workflows, move it into a shared helper or documented data file instead of
  growing the harness indefinitely.
- Treat `--budget` / `wf.budget()` as an observed-AIC soft cap: in-flight agents may finish and
  overshoot before new agents are skipped. Use `--strict-budget` only when the harness should raise
  after the cap is observed.
- Default paid workflow previews to enough budget for thorough fan-out and verification. Use roughly
  10,000 AIC for small/medium workflows and several hundred thousand (or more) for broad audits/research;
  only choose a tight budget when the user asks for it or the task is intentionally a small smoke run.
- For recurring loops (`cwf loop --every ...`), persist progress with `--memory PATH`: each tick is a
  fresh run, so read prior state with `wf.memory.read()` and record next steps with
  `wf.memory.append(...)` (checkpoints are per-run only). Start from `examples/loop-memory.cwf.py`.
- Use `wf.worktree()` as a convenience for small isolated edits or experiments. Do not default to one
  worktree per agent in large fan-outs; when many agents will edit, prefer launching the whole
  workflow from an already-isolated worktree.
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
run_workflow({ scriptPath: "harness.cwf.py", budget: 1000, disableMcp: true, args: ["one", "two"] })
```

Headless / fallback equivalent:

```bash
cwf run harness.cwf.py --budget 1000 --disable-mcp --args '["one", "two"]'
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
