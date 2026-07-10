---
name: workflow
description: >-
  Use this skill when the user asks for a workflow, "workflow: <task>", "xtreme: <task>",
  parallel/fan-out agents,
  cross-checking, adversarial verification, large codebase audits or migrations, ranking/triage of
  many items, custom research workflows, or work that one conversation context cannot reliably hold.
  Prefer the deep-research skill for source-backed web research reports. Do not use it for simple
  lookups, ordinary single-file edits, or tasks you can finish directly in a few tool calls.
compatibility: GitHub Copilot CLI with the workflow extension loaded.
metadata:
  copilot.user-invocable: "true"
  copilot.runtime: "workflow"
user-invocable: true
---

# Dynamic workflows on the Copilot CLI

Author and run a small **async JavaScript** harness (`.mjs`) that coordinates many `copilot`
subagents. The harness owns branching, loops, checkpoints, and intermediate results; this keeps the
main conversation focused on the final synthesized answer.

**Execution path.** The workflow extension exposes the native `run_workflow` tool. It runs the harness
in-process (no Python), spawns `copilot` subagents, accounts AIC, persists durable run artifacts, and
— for background runs — wakes you on completion. Inspect runs with the `/workflow` slash command
(`/wf` for short) or the `list_workflow_runs` tool.

`workflow: <task>` is the general dynamic-workflow shortcut. `xtreme: <task>` uses the same path but
should set `preset: "xtreme"`.

## Decision boundary

Use a workflow when the task genuinely benefits from independent contexts or repeatable quality
gates:

- Codebase-wide audits, sweeps, migrations, or multi-file reviews.
- Custom research workflows that need a harness beyond the saved `deep-research` workflow.
- Large ranking, triage, clustering, or comparative-judgment tasks.
- Plans or designs worth drafting from several independent angles before execution.
- Any request where you would otherwise paste dozens of items into one prompt.

Do **not** use a workflow for quick questions, simple searches, ordinary single-file edits, or work
you can complete with a few direct tool calls. Workflows spend more time and AIC.

## Required process

1. **Scout inline first.** Discover the work list yourself with normal tools: changed files, target
   directories, sources, tickets, endpoints, or candidate options. Do not fan out until you know the
   shape of the work.
2. **Pick the pattern.** Default to `pipeline()` for multi-stage per-item work. Use a barrier
   (`fanOut`, `parallel`, `synthesize`) only when a stage needs all previous results at once.
3. **Rubber-duck reusable designs.** Before implementing a new reusable workflow, a broad audit, or
   a large harness change, have an independent reviewer critique the plan for missing gates, unsafe
   tool access, budget/coverage blind spots, and result-integrity issues. Fold in the high-signal
   feedback before writing code.
4. **Write a harness.** Inline `script` for one-offs, or save `~/.copilot/workflows/<name>.mjs`
   for reusable workflows. Harnesses are an **async JavaScript body** using injected globals; a final
   `return <value>` is the workflow's result. Begin with a literal `export const meta = { name,
   description, phases }` block.
5. **Preview and confirm paid runs.** Before spending AIC, show the user phases, approximate subagent
   count, models, and an AIC budget. Ask for confirmation unless the user already told you to go
   ahead. Preview for free with `run_workflow({ …, dryRun: true })`.
6. **Run with a budget.** Call `run_workflow({ scriptPath|name|script, budget: <N> })`. Non-dry runs
   default to `background: true` and notify you on completion; set `background: false` for small/test
   runs that should return the final result inline. Other params: `args`, `model`, `effort`,
   `context`, `preset`, `concurrency`, `enableMcp`, `restricted`, `strictBudget`, `memory`, `cwd`,
   `timeoutSec`, `resume`. Built-in MCP is **off** by default; set `enableMcp` only when agents need
   GitHub/MCP/web tools.
7. **Return the result.** `run_workflow` returns the harness's final answer (foreground) or a `runId`
   + artifact paths (background). Inspect any run with `/workflow` (or `/wf`), `/workflow <runId>`,
   `/workflow runs`, `/workflow result <runId>`, `/workflow artifacts <runId>`, or
   `list_workflow_runs`. Re-invoke with
   `resume: <runId>` to continue — unchanged agents return instantly from checkpoints.

## Defaults that avoid common mistakes

- Prefer modern, capable models by default. Any model Copilot offers works — GPT, Claude, Gemini, a
  BYOK provider, or `auto`; the workflow runtime passes the model string through opaquely. Use a fast
  current model for broad fan-out and a stronger one for synthesis, judging, or hard verification.
- Let the harness pick a model per agent, but honor the user when they want to choose: `model`,
  `effort` (`none…max`), and `context` (`default|long_context`) set the **session defaults** agents
  inherit, while a per-agent value pinned in the script wins. Note `effort` only affects
  reasoning-capable models, so don't set a session `effort` when the harness's agents run on models
  that don't support it.
- Use `preset: "xtreme"` for big high-confidence runs: it fills unset defaults with provider-neutral
  high-effort settings (`model=auto`, `effort=xhigh`, `context=long_context`) and a 1,000,000 AIC
  budget. Treat a user request written as `xtreme: <task>` as a workflow request with this preset.
- For critical consensus checks, encourage model-family diversity without making it the default:
  `consensus(subject, rubric, { models: [...] })` lets reviewers use different families.
- Leave MCP disabled by default for fan-out. Opt in with `enableMcp` or per-agent `enableMcp: true`
  only for stages that need it.
- Tag inner agents with `phase` and `label` so progress stays readable. For concurrent work, pass an
  explicit per-agent `phase` (the top-level `phase("x")` sets a shared current phase).
- Prefer `structured()` over hand-parsing JSON from agent text. Use `result.content` to read an
  agent's text — JavaScript cannot overload `String(result)`.
- Keep harness code clean and boring: small named helpers, explicit input normalization, clear phase
  labels, no broad catches that turn failures into success, and no clever parsing when a primitive
  exists.
- Treat `budget` as an observed-AIC soft cap: in-flight agents may finish and overshoot before new
  agents are skipped. Use `strictBudget: true` only when the harness should stop after the cap is
  observed. Read it with `budget.total`, `budget.spent()`, `budget.remaining()`.
- Run status is integrity-sensitive: handled agent failures, skipped agents, dropped branches, or a
  reached soft budget produce `partial` (with the partial result preserved); strict-budget
  termination produces `failed`. Inspect failed/skipped/dropped counts rather than treating any
  non-error result as complete.
- Harnesses can read the injected `dryRun` boolean. `structured()` supplies deterministic
  schema-shaped placeholders during previews, but workflows with data-dependent arrays must derive
  their own preview arity from inputs or deterministic host discovery.
- Default paid workflow previews to enough budget for thorough fan-out and verification: roughly
  10,000 AIC for small/medium workflows and several hundred thousand (or more) for broad
  audits/research; only choose a tight budget when the user asks or the task is a small smoke run.
- For recurring workflows, persist progress with a `memory` file: read prior state with
  `memory.read()` and record next steps with `memory.append(...)` (per-run checkpoints reset each
  run). Drive recurrence from the CLI scheduler (`/every`) invoking `run_workflow` per tick. Start
  from `examples/loop-memory.mjs`.
- Use `worktree()` as a convenience for small isolated edits or experiments (callback form
  `worktree(name, async (dir) => …)` or lifecycle `const wt = await worktree.create(name)`), or
  `agent(prompt, { isolation: "worktree" })`. Don't default to one worktree per agent in large
  fan-outs. Dirty worktrees are preserved for inspection; clean ones are removed automatically.
- Quarantine agents that read untrusted/public content: `quarantine()`. Verifier/synthesis agents
  that consume untrusted-derived text should also avoid pre-authorized tools:
  `quarantine({ allowAllTools: false })`. Deny rules always win over allow rules.
- For untrusted harness authors, use `restricted: true` plus an OS/agent sandbox (`copilot --cloud`
  or `/sandbox`). `restricted` is determinism + footgun prevention, **not** a security jail: the
  harness runs in a `node:vm` context, which is escapable via injected globals.
- Never silently cap coverage. If you sample, drop top-N items, skip retries, or stop due to budget,
  log it with `log()` and say so in the final answer.

## Minimal harness

Start from `examples/minimal-review.mjs`; copy it and adapt the prompts, rubric, and input list.
Keep examples as `.mjs` files so they stay runnable and syntax-checkable.

```js
export const meta = { name: "review", description: "Review items and summarize.", phases: ["review", "report"] };

const items = args || ["one", "two"];
const findings = await fanOut(items, (item) => agent(`Review: ${item}`, { agentType: "worker", label: String(item).slice(0, 24) }));
const report = await synthesize(findings, { prompt: "Summarize the findings.", label: "report" });
return report.content;
```

Run it:

```
run_workflow({ script: "<the harness source>", budget: 10000, args: ["one", "two"], background: false })
```

## Load more only when needed

- Read [the harness API reference](references/wf-api.md) when writing a harness or checking an exact
  signature.
- Read [workflow recipes](references/recipes.md) when choosing between pipeline, fan-out, adversarial
  verification, tournaments, generate-and-filter, classify-and-route, loop-until-done, or quarantine
  patterns.
- Use the files in `examples/` as copyable harness templates; do not paste large examples into the
  skill body.
