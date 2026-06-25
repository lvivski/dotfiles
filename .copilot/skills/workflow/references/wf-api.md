# wf API reference

Harnesses are executed with `wf` (the runtime) and `args` (the parsed `--args` value or `None`).
Everything is synchronous.

## Agents

Call `wf.agent(prompt, model=None, agent=None, effort=None, cwd=None, phase=None,
disable_mcp=False, timeout=None, label=None, allow=None, deny=None, allow_url=None,
deny_url=None, add_dir=None, mcp=None)`.

Returns `AgentResult`:

- `content`, `ok`, `error`
- `premium_requests`, `output_tokens`
- `session_id`, `model`, `cached`
- `str(result) == result.content`

Use `wf.follow_up(result, prompt, **kw)` for another turn in the same subagent session. It raises if
the result has no `session_id`.

## Concurrency primitives

### `wf.pipeline(items, stage1, stage2, ..., concurrency=None)`

Streams each item through all stages independently. Stage N for item A can run while item B is still
in stage 1. Each stage receives `(prev, item, index)` and may accept 1, 2, or 3 positional arguments.
If a stage raises, that item becomes `None` and the remaining items continue.

Use this by default for multi-stage per-item work. Copy `examples/pipeline-review.cwf.py` when you
need a runnable starting point.

### `wf.fan_out(items, fn, concurrency=None)`

Runs `fn(item)` for every item concurrently and returns results in input order. This is a barrier:
later code waits for every branch. Use it when the next stage needs all results at once.

### `wf.parallel(thunks, concurrency=None)`

Runs zero-argument callables concurrently and returns results in order. Branch exceptions become
`None`; `BudgetExceeded` still propagates in strict mode.

## Patterns

### `wf.synthesize(results, prompt=..., model=None, label="synthesize", **kw)`

Merges many inputs into one `AgentResult`. Pass no-tool/quarantine kwargs if inputs include
untrusted-derived text.

### `wf.verify(subject, rubric=..., refute=True, model=None, label="verify", **kw)`

Returns `Verdict(passed, score, reasons, raw)`. Use for adversarial checking before reporting or
acting on findings.

### `wf.structured(prompt, schema, retries=2, model=None, label="structured", **kw)`

Gets a JSON value matching a shape schema or callable validator. Prefer this over parsing JSON by
hand. Returns `Structured(value, ok, error, raw, attempts)`.

Supported shape-schema keywords: `type`, `properties`, `required`, `enum`, `items`,
`additionalProperties`, and `description`.

### `wf.tournament(candidates, criteria=..., model=None, label="judge", **kw)`

Single-elimination pairwise judging for ranking/taste. Raises if a judge fails or does not return a
valid winner.

### `wf.generate_and_filter(generate, n=5, keep=None, rubric=None, dedupe=True, model=None)`

Generates candidates, deduplicates, then filters with either `keep(result)` or `wf.verify()`.

### `wf.classify(text, classes, model=None, label="classify", instructions=None, **kw)`

Returns exactly one class. Raises if the classifier fails or returns no valid category.

### `wf.loop_until(step, done, max_iters=10)`

Runs `step(i)` until `done(result)` is true or `max_iters` is reached. Exceptions from `done`
propagate.

## Safety, isolation, and cost

- `wf.worktree()` requires a git repository and a unique name per concurrent branch.
- `wf.quarantine()` denies shell/write/egress by default and disables built-in MCPs.
- Use `wf.quarantine(deny_url=[], disable_mcp=False)` only when a reader legitimately needs network
  or MCP access, such as web research.
- Use `wf.quarantine(allow_all_tools=False)` for verifier/synthesis agents that only need to reason
  over prior untrusted-derived text.
- `wf.budget()` is a soft observed-spend cap. In-flight agents may overshoot before new agents are
  skipped.
- `wf.memory` is a durable text file shared across runs and `cwf loop` ticks (enable with
  `--memory PATH`). Call `wf.memory.read()` / `.append(text)` / `.write(text)` / `.clear()`. It is
  disabled and no-ops without `--memory`, and read-only under `--dry-run`. Use it so a recurring loop
  records "what's done / what's next" for its next tick; it works in `--restricted` (the runtime owns
  the file I/O).

## Saved workflows

`wf.workflow(name_or_path, args=...)` runs a saved harness inline on the same runtime, sharing
budget, concurrency, checkpoints, and progress. Call only at top level, not inside `fan_out`,
`pipeline`, or `parallel`; nesting is limited to one level.

## CLI

```bash
cwf run <harness.py> --budget <N> [--args JSON|@file] [--model MODEL] [--disable-mcp]
cwf run <harness.py> --resume <runId>
cwf run <harness.py> --dry-run
cwf run <harness.py> --memory <state.md>                 # durable wf.memory, persists across runs
cwf loop <harness.py> --every 10m --memory <state.md>    # recurring loop that accretes state
cwf runs
cwf watch <runId>
```

State lives under `~/.copilot/workflows/runs/<runId>/`: `harness.py`, `meta.json`,
`results.ndjson`, and `progress.ndjson`.
