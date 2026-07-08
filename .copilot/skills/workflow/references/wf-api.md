# Harness API quick reference

A harness is an **async JavaScript body** (`.cwf.mjs`) run in a deterministic `node:vm` sandbox with
injected globals (no `wf.` prefix). It ends with `return <value>` — the workflow result. Read an
agent's text with `result.content` (JavaScript cannot overload `String(result)`). Blocked in the
sandbox: `eval`/`new Function`, `Math.random`, `Date.now()`/argless `new Date()`, and direct
filesystem/process/network access (agents do that work, not the harness).

## Metadata

```js
export const meta = {
  name: "audit-auth",
  description: "Audit routes for missing authentication checks",
  phases: ["scan", "verify", "report"],
};
```

## Core calls

- `agent(prompt, opts?)` → `AgentResult` (`{ content, ok, error, sessionId, model, cached, skipped,
  label, nanoAiu, aic, outputTokens, inputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
  durationMs }`). Per-agent `opts`: `model`, `effort`, `context`, `agentType`, `cwd`, `label`,
  `phase`, `allow`, `deny`, `allowUrl`, `denyUrl`, `addDir`, `mcp`, `enableMcp`, `allowAllTools`,
  `timeout`, `isolation: "worktree"`, `resume`.
- `followUp(result, prompt, opts?)` sends another turn to an agent's session (multi-turn resume).
- `pipeline(items, ...stages, opts?)` streams each item through stages independently; a failed item
  becomes `null` unless `opts.errors === "raise"`. Optional trailing `{ concurrency, errors }`.
- `fanOut(items, fn, opts?)` runs a barrier map (`errors: "raise"` default; `"drop"` → `null` slots).
- `parallel(thunks, opts?)` runs zero-arg thunks as a barrier (`errors: "drop"` default).

## AI patterns

- `synthesize(inputs, opts?)` merges many inputs via one agent call → `AgentResult`.
- `verify(subject, rubric, opts?)` → `{ passed, score, reasons, raw, ok, error }` (fail-closed).
- `consensus(subject, rubric, opts?)` runs quorum-backed multi-review (`{ reviewers, models }`) →
  `{ passed, passedCount, failedCount, erroredCount, reviewers, reasons, dissent, verdicts, ok, error }`.
- `structured(prompt, schema, opts?)` gets validated JSON → `{ value, ok, error, raw, attempts }`.
  `schema` is a shape-schema (`type`/`properties`/`required`/`enum`/`items`/`additionalProperties`)
  or a `validate(obj)` callable; retries feed the error back (default `retries: 2`).
- `tournament(candidates, criteria, opts?)` returns the comparative winner (throws on judge failure).
- `generateAndFilter(promptOrPrompts, opts?)` → array of kept `AgentResult`s (`{ n, keep, rubric,
  dedupe }`).
- `classify(text, classes, opts?)` returns exactly one class string (throws if none valid).
- `loopUntil(step, done, opts?)` repeats `step(i)` until `done(result)` or `opts.maxIters` (default 10);
  returns the history array.

## Safety, state, and execution helpers

- `quarantine(opts?)` returns `agent()` options for read-only/no-egress agents (deny shell+write,
  deny all URLs, MCP off). Extra keys pass through; `quarantine({ allowAllTools: false })` for a
  no-tools verifier/synthesizer. Deny rules win over allow rules.
- `worktree(name, optsOrCallback?, callback?)` — callback form auto-cleans; `worktree.create(name,
  opts?)` returns a `{ path, cleanup }` handle. `opts`: `{ baseRef, repo, ref, cloneDir }`. Dirty
  worktrees are preserved; clean ones removed.
- `phase(name)` sets the current phase for subsequently-launched agents (pass explicit per-agent
  `phase` for concurrent work).
- `budget.total`, `budget.spent()`, `budget.remaining()`, `budget.hit`, and `budget.set(aic)` expose
  and adjust the observed-AIC soft cap.
- `memory.read()` / `memory.append(text)` / `memory.write(text)` / `memory.clear()` / `memory.enabled`
  use the durable `memory` file (disabled → reads `""`, writes no-op; dry-run → read-only).
- `log(message)` narrates progress into the run.

## Inspecting runs

`/cwf` (latest) · `/cwf <runId>` · `/cwf runs` · `/cwf result <runId>` · `/cwf artifacts <runId>`, or
the `list_workflow_runs` tool. Each run persists `script.js`, `run.json`, `result.json`, `state.json`,
`progress.jsonl`, `journal.jsonl`, and `meta.json` under `~/.copilot/workflows/runs/<runId>/`.

## Migrating from the old Python `wf` API

`wf.agent`→`agent`, `wf.fan_out`→`fanOut`, `wf.generate_and_filter`→`generateAndFilter`,
`wf.loop_until`→`loopUntil`, `wf.follow_up`→`followUp`; `wf.budget_total`→`budget.total`,
`wf.spent`→`budget.spent()`, `wf.remaining()`→`budget.remaining()`; `with wf.phase("x"):`→`phase("x")`
(+ per-agent `phase`); `str(result)`/`as_text(result)`→`result.content`; keyword args
(`agent="worker"`, `enable_mcp=True`) → the `opts` object (`{ agentType: "worker", enableMcp: true }`).
Everything is `await`-ed (JS is async); there is no `wf.` prefix.

**Intentionally not ported** (present in the Python `wf` API but unused by any workflow, and a poor
fit for the JS idiom): `wf.spec()` (build `agent()` opts inline instead), `wf.xtreme()` /
`wf.apply_preset()` (use the run-level `preset: "xtreme"`), and the injected `AgentSpec`/`AgentResult`
classes (results are plain objects — test with `result.ok`, not `instanceof`).
