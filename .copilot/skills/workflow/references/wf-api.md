# wf API quick reference

Harnesses run synchronously with injected globals: `wf` (the runtime) and `args` (parsed JSON or
`None`). The implementation README, `.local/lib/copilot_workflows/README.md`, is the source of truth
for signatures and exact semantics; keep this file as a compact index.

## Core calls

- `wf.agent(prompt, ..., enable_mcp=False, label=None, phase=None, **tool_kwargs)` → `AgentResult`
- `wf.follow_up(result, prompt, **kw)` resumes an agent session.
- `wf.pipeline(items, stage1, stage2, ..., concurrency=None, errors="drop")` streams each item through stages; failed items become `None` unless `errors="raise"`.
- `wf.fan_out(items, fn, concurrency=None, errors="raise")` runs a barrier map; use `errors="drop"` to return `None` for failed slots.
- `wf.parallel(thunks, concurrency=None, errors="drop")` runs thunks as a barrier; use `errors="raise"` to abort on branch errors.

## AI patterns

- `wf.synthesize(results, prompt=..., **kw)` merges many inputs.
- `wf.verify(subject, rubric=..., refute=True, **kw)` returns a `Verdict`.
- `wf.consensus(subject, rubric=..., reviewers=3, models=None, **kw)` runs quorum-backed multi-review.
- `wf.structured(prompt, schema, validate=None, retries=2, **kw)` gets validated JSON.
- `wf.tournament(candidates, criteria=..., **kw)` chooses a comparative winner.
- `wf.generate_and_filter(generate, n=5, keep=None, rubric=None, dedupe=True, model=None)` creates and filters candidates.
- `wf.classify(text, classes, instructions=None, **kw)` returns exactly one class.
- `wf.loop_until(step, done, max_iters=10)` repeats until a stop condition.

## Safety, state, and execution helpers

- `wf.quarantine(...)` returns kwargs for read-only/no-egress agents; pass `enable_mcp=True` only
  for stages that genuinely need MCP/network.
- `wf.worktree(name, base_ref=None, repo=None, ref=None, clone_dir=None)` creates an isolated checkout.
- `wf.phase(name)` groups progress.
- `wf.budget(aic)`, `wf.remaining()`, `wf.spent`, and `wf.budget_total` expose budget controls.
- `wf.memory.read()/append()/write()/clear()` use the durable `--memory` file.
- `wf.xtreme()` fills unset defaults with the high-confidence preset.

## CLI reminders

```bash
cwf run <harness.py> --budget <N> [--args JSON|@file] [--model MODEL] [--enable-mcp]
cwf run <harness.py> --preset xtreme
cwf run <harness.py> --resume <runId>
cwf loop <harness.py> --every 10m --memory <state.md>
```
