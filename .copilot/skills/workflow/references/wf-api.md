# Harness API quick reference

A harness is an **async JavaScript body** (`.mjs`) run in a deterministic `node:vm` sandbox with
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

Dropped slots are counted and make an otherwise usable run `partial`; they are never compatible with
`complete`. A fail-fast outer stage should convert item-local model/parse failures to explicit
sentinels and reserve thrown errors for systemic failures.

## AI patterns

- `synthesize(inputs, opts?)` merges many inputs via one agent call → `AgentResult`.
- `verify(subject, rubric, opts?)` → `{ passed, score, reasons, raw, ok, error }` (fail-closed).
- `consensus(subject, rubric, opts?)` runs quorum-backed multi-review (`{ reviewers, models }`) →
  `{ passed, passedCount, failedCount, erroredCount, reviewers, reasons, dissent, verdicts, ok, error }`.
- `structured(prompt, schema, opts?)` gets validated JSON → `{ value, ok, error, raw, attempts }`.
  `schema` is a shape-schema (`type`/`properties`/`required`/`enum`/`items`/`additionalProperties`)
  or a `validate(obj)` callable; retries feed the error back (default `retries: 2`). During dry-run it
  makes one synthetic call and returns a deterministic schema-shaped placeholder without retries;
  array placeholders are empty, so data-dependent harnesses should use `dryRun` plus input-derived
  arity when previewing fan-out.
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
- `dryRun` is `true` only during a no-AIC preview.
- `memory.read()` / `memory.append(text)` / `memory.write(text)` / `memory.clear()` / `memory.enabled`
  use the durable `memory` file (disabled → reads `""`, writes no-op; dry-run → read-only).
- `log(message)` narrates progress into the run.

## Host effects (`host.*`) via a sidecar

Deterministic (or impure-but-recorded) host work — git, filesystem, parsing, anything a workflow
needs — lives in a **sidecar** the runtime imports in the host realm (full Node), *not* in the
sandboxed harness. The harness calls effects through the injected `host.<name>(input)` namespace;
each call is **checkpointed by `(name, input)`** in the same journal agents use, so a resumed run
replays recorded results instead of re-running. This is the code analogue of `agent()`: the harness
stays a pure function of `(args, agent results, effect results)`, and each workflow declares exactly
the effects it needs — the core API never grows per workflow.

- **Call:** `await host.mine({ base, head })`. Results must be plain JSON (like agent results).
  Repeated calls with the same input are distinct (occurrence-keyed), so read-after-write is correct.
  `host.fn(input, { cache: false })` opts out of checkpointing. Use it for filesystem/git discovery
  or evidence validation that must be fresh on resume; otherwise the raw input—not file state—is the
  checkpoint key.
- **Provide effects** two ways (either/both): a sibling `~/.copilot/workflows/<name>.host.mjs`, or
  `run_workflow({ host: "/path/to/effects.mjs" })`.
- **Author an effect** as `export async function name(input, ctx) { … }`. Mark side-effecting ones
  via `fn.mutates = true` (survives `export *`) or `export const meta = { mutates: [...] }`; mutating
  effects are **skipped under dry-run**, and all `host.*` is denied in **restricted** mode.
- **`ctx` is deliberately minimal** — `{ cwd, dryRun, restricted, signal, log }`, nothing else. The
  framework provides **no** git/fs/parse toolkit; a sidecar implements whatever host I/O it needs with
  raw Node (`node:child_process`, `node:fs`, `fetch`, npm), resolving paths against `ctx.cwd` and
  passing `ctx.signal` to its own `spawn`/`fetch` for cancellation. Reusable helpers live in userland
  (e.g. one shared sidecar that others `export *`), not in the framework.

Keep exotic/nondeterministic-and-unrecordable work (network, long builds, branch creation) in an
`agent()` — outside the determinism boundary by design.

## Inspecting runs

`/workflow` or `/wf` (latest) · `/workflow <runId>` · `/workflow runs` ·
`/workflow result <runId>` · `/workflow artifacts <runId>`, or the `list_workflow_runs` tool. Each run
persists `script.mjs`, `run.json`, `result.json`, `state.json`, `progress.jsonl`, `journal.jsonl`, and
`meta.json` under `~/.copilot/workflows/runs/<runId>/`.

## Migrating old Python workflows

Translate Python `wf.*` calls to injected JavaScript globals:

- `wf.agent(...)` → `await agent(...)`
- `wf.fan_out(items, fn)` → `await fanOut(items, fn)`
- `wf.generate_and_filter(...)` → `await generateAndFilter(...)`
- `wf.loop_until(step, done)` → `await loopUntil(step, done)`
- `wf.follow_up(result, prompt)` → `await followUp(result, prompt)`
- `wf.budget_total` / `wf.spent` / `wf.remaining()` → `budget.total` / `budget.spent()` / `budget.remaining()`
- `with wf.phase("x"):` → `phase("x")` plus explicit per-agent `phase` for concurrent work
- `str(result)` / `as_text(result)` → `result.content`
- `subprocess`/`git diff`/`Path.read_text`/`json.dump` inline → move that deterministic work into a
  **host sidecar** (`<name>.host.mjs`) as an effect and call it via `host.<name>(input)`; implement the
  I/O with raw Node (`node:child_process`, `node:fs`) inside the effect. Don't ask an agent to re-run a
  deterministic classifier — mine in the sidecar (checkpointed) and reserve agents for judgment.
- Python keyword args become an options object, e.g. `agent="worker", enable_mcp=True` → `{ agentType: "worker", enableMcp: true }`

Save converted workflows as `~/.copilot/workflows/<name>.mjs`. The JavaScript harness is async, uses
top-level `await`, and ends with `return <value>`.
