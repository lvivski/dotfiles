# cwf — dynamic workflows on the GitHub Copilot CLI

`cwf` reproduces Claude Code's **dynamic workflows** on top of the GitHub Copilot CLI. You (or
Copilot itself) write a small **harness** — plain synchronous Python — that fans work out to many
`copilot` subagents in parallel: fan-out/synthesize, adversarial verification, tournaments,
generate-and-filter, classify-and-route, loop-until-done. The loop, branching, and intermediate
results live in the harness, so your conversation context only holds the **final synthesized
answer**. That structurally defeats the failure modes of long single-context runs — *agentic
laziness*, *self-preferential bias*, and *goal drift* — by giving each subagent its own clean
context and an isolated, verifiable goal.

Pure Python standard library + the `copilot` binary. No pip installs, no Node.

## Install

These files live in the dotfiles repo and deploy to `$HOME` via `. sync`:

| Repo path | Deploys to | What |
| --- | --- | --- |
| `.local/bin/cwf` | `~/.local/bin/cwf` | the CLI |
| `.local/lib/copilot_workflows/` | `~/.local/lib/copilot_workflows/` | the runtime library |
| `.copilot/skills/workflow/` | `~/.copilot/skills/workflow/` | the `workflow` skill (trigger) |
| `.copilot/agents/*.md` | `~/.copilot/agents/*.md` | reusable persona subagents |
| `.copilot/workflows/*.cwf.py` | `~/.copilot/workflows/*.cwf.py` | bundled + saved workflows |

Run `. sync` from the dotfiles repo, then make sure `~/.local/bin` is on your `PATH`.
Requires Python 3.9+ and `copilot` (the GitHub Copilot CLI).

## Quick start

Two ways to use it.

**1. Let Copilot author a workflow.** In an interactive `copilot` session, say:

```
ultrawork: audit every endpoint under src/routes for missing auth checks
```

The `workflow` skill kicks in: Copilot decomposes the task, writes a harness, shows the planned
phases + a credit budget, asks you to confirm, runs it, and returns the synthesis.

**2. Write/run a harness yourself.**

```bash
cwf run ~/.copilot/workflows/deep-research.cwf.py --budget 30 \
    --args '"What changed in HTTP/3 adoption since 2022?"'
```

The harness prints its final answer to **stdout**; cwf prints progress + stats to **stderr**.

## The `wf` API

A harness is executed with two names injected: `wf` (the runtime) and `args` (the parsed `--args`
value, or `None`). Everything is synchronous — never use `async`/`await`.

```python
r = wf.agent(prompt, *, model=None, agent=None, effort=None, cwd=None, phase=None,
             disable_mcp=False, timeout=None, label=None,
             allow=None, deny=None, allow_url=None, deny_url=None, add_dir=None, mcp=None)
#   -> AgentResult: .content .ok .premium_requests .output_tokens
#                   .session_id .model .cached .error   (str(r) == r.content)
#   phase= assigns the progress group explicitly (use inside pipeline()/parallel()).

wf.follow_up(r, prompt, **kw)               # another turn in the same session

rows    = wf.pipeline(items, stage1, stage2, ...)   # DEFAULT for multi-stage work:
#   each item streams through ALL stages independently — NO barrier between stages.
#   stage is called stage(prev, item, idx) (1–3 args); prev is the prior stage's return
#   (the item for stage 1). A stage that raises drops that item to None (others continue).
results = wf.parallel([lambda: wf.agent(a), lambda: wf.agent(b)])  # barrier over thunks
results = wf.fan_out(items, fn)             # barrier map keyed by items; fn may nest wf.agent
merged  = wf.synthesize(results, prompt=..., model=...)
verdict = wf.verify(work, rubric=..., refute=True)     # -> Verdict(.passed .score .reasons .raw)
winner  = wf.tournament(candidates, criteria=...)
kept    = wf.generate_and_filter(prompt, n=8, rubric=...)   # or keep=callable
label   = wf.classify(text, ["bug", "feature", "question"])
hist    = wf.loop_until(step, done, max_iters=10)
s       = wf.structured(prompt, schema, retries=2)  # validated JSON + retry -> Structured(.value .ok .attempts)
#   schema = a shape-schema dict (type/properties/required/enum/items/additionalProperties)
#   or a callable validate(obj) -> "" when ok else error string. Feeds the error back and retries.
out     = wf.workflow("name-or-path", args=...)     # run a saved harness inline; returns what it printed

with wf.phase("name"): ...                  # group agents in the live view
with wf.worktree(f"fix-{item}") as path:    # isolated checkout — unique name per branch
    wf.agent("apply the fix", cwd=path)
q = wf.quarantine()                         # reader of untrusted content: no shell/write tools
wf.budget(20); wf.log("..."); wf.spent      # cost controls
wf.budget_total; wf.remaining()             # budget introspection (remaining() is inf if uncapped)
```

> **pipeline vs barrier.** `pipeline()` streams — item A can be in stage 3 while B is in
> stage 1, so wall-clock is the slowest single-item *chain*. `fan_out`/`parallel`/`synthesize`
> are barriers — they wait for every branch. Default to `pipeline()`; use a barrier only when
> a stage needs all prior results at once (dedupe/merge, zero-count early-exit, cross-refs).

> **wf.workflow() composition.** Runs a saved harness inline on the same runtime (shared
> budget/concurrency/checkpoints/progress) and returns its printed output. Top-level only (raises
> inside a parallel branch), one level deep; child checkpoint keys are namespaced so resume stays sound.

## Patterns

- **Pipeline (default)** — stream each item through stages with no inter-stage barrier.
- **Fan-out-and-synthesize** — split work, one agent per piece, merge at a barrier.
- **Adversarial verification** — a separate agent attacks each finding against a rubric; keep survivors.
- **Tournament** — pairwise comparative judgment (more reliable than absolute scoring) for ranking/taste.
- **Generate-and-filter** — generate N ideas, dedupe, keep those passing a rubric/predicate.
- **Classify-and-route** — tag an item, then branch on the tag.
- **Loop-until-done** — repeat until a stop condition (no new findings, tests pass).
- **Quarantine** — agents reading untrusted content get no privileged tools; a separate trusted
  actor agent, fed only their structured output, takes any privileged action.

## CLI

```
cwf run <harness.py> [--args JSON|@file] [--model M] [--budget N] [--strict-budget]
                     [--concurrency K] [--disable-mcp] [--resume RUN_ID] [--run-id ID]
                     [--runs-dir DIR] [--dry-run] [--quiet]
cwf loop <harness.py> --every 5m [--max-runs N] [<same run flags>]   # recurring triage/research
cwf runs [--runs-dir DIR]                                            # list recent runs
cwf watch <run_id> [--no-follow]                                     # live/replay progress
```

- **Budget** is in premium-request credits — always set `--budget`. By default, once the budget is
  hit, remaining agents are skipped (graceful drain); `--strict-budget` stops hard.
- **Resume** — every completed agent is checkpointed to `results.ndjson`. Re-run with
  `--resume <runId>` and finished agents return instantly.
- **Live view** — a TTY shows a panel (running agents, credits, elapsed); pipes get one line per agent.

Run state lives under `~/.copilot/workflows/runs/<runId>/` (`harness.py`, `meta.json`,
`results.ndjson`, `progress.ndjson`).

## Bundled workflows

| File | What |
| --- | --- |
| `deep-research.cwf.py` | decompose a question → fan-out web research → adversarially verify claims → cited report |
| `audit.cwf.py` | review files for a concern → verify findings → severity-grouped report |
| `triage.cwf.py` | classify + summarize a batch of tickets |

Drop your own polished harnesses in `~/.copilot/workflows/` and rerun them any time; read `args`
to parameterize them.

## Cost & safety

Dynamic workflows spend meaningfully more than a single session — use them for large, parallel,
adversarial, or cross-checked work, not routine edits. Use a small model (`claude-haiku-4.5`) for
wide fan-out and a strong one (`claude-sonnet-4.5`) only for synthesis/judging. Gauge cost by
running a small slice first (`--dry-run` previews the plan for free). Use `wf.quarantine()` for any
agent that reads untrusted/public content.

## Persona agents

`~/.copilot/agents/` ships reusable subagent personas — `verifier`, `refuter`, `synthesizer`,
`judge`, `researcher`, `classifier` — usable via `wf.agent(prompt, agent="verifier")` or
`copilot --agent verifier`. The built-in patterns already embed strong personas, so these are for
extra steering.

## Testing

Zero-credit: subagents are stubbed by `tests/fake_copilot.py`.

```bash
python3 -m unittest discover -s ~/.local/lib/copilot_workflows/tests
```

## Layout

```
copilot_workflows/
  agent.py        # spawn one copilot subagent, parse JSONL -> AgentResult
  runtime.py      # the wf facade: agent/fan_out/patterns, concurrency, budget, checkpoints, worktrees
  patterns.py     # synthesize/verify/tournament/generate_and_filter/classify/loop_until/quarantine
  checkpoint.py   # append-only resumable result store
  worktree.py     # per-agent git worktree isolation
  progress.py     # live panel + progress.ndjson + replay (cwf watch)
  examples/       # hello.py, patterns_demo.py
  tests/          # fake_copilot.py + unittest suite
```

## Relation to Claude Code dynamic workflows

Same idea — an agent-authored harness that orchestrates many subagents with the plan held *outside*
the model context — re-implemented on Copilot CLI primitives: each subagent is a
`copilot -p … --output-format json` subprocess; cost is tracked in premium-request credits; the
`workflow` skill plays the role of `ultracode`.
