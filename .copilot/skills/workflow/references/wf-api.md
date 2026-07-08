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
  `host.fn(input, { cache: false })` opts out of checkpointing (flags the run non-resume-safe).
- **Provide effects** two ways (either/both): a sibling `~/.copilot/workflows/<name>.host.mjs`, or
  `run_workflow({ host: "/path/to/effects.mjs" })`.
- **Author an effect** as `export async function name(input, ctx) { … }`. Mark side-effecting ones
  via `export const meta = { mutates: ["writeManifest"] }` (or `fn.mutates = true`); mutating effects
  are **skipped under dry-run**, and all `host.*` is denied in **restricted** mode.
- **`ctx`** hands each effect the run's `{ cwd, dryRun, restricted, log }` plus a host-realm toolkit so
  sidecars compose without fragile imports (type it via the ambient `EffectCtx` from the co-located
  `workflow.d.ts` — no import needed):
  - `ctx.git(...args)` — read-only git (allowlist: `diff`/`log`/`show`/`status`/`rev-parse`/
    `merge-base`/`rev-list`/`ls-files`/…); returns stdout, rejects on mutation or non-zero exit.
  - `ctx.files.readText|readJson|exists(path)`, `ctx.files.glob(pattern, opts?)` (sorted; prunes
    `node_modules`+dotfiles), `ctx.files.writeText|writeJson(path, …)` (byte-stable sorted JSON).
  - `ctx.parseDiff(text)` → `FileDiff[]` (`{ path, oldPath, hunks:[{ header, oldStart, newStart,
    changes:[{ type:"add"|"del"|"context", text, oldLine, newLine }] }] }`); `ctx.path.{basename,
    dirname,join,relative,extname,sep}`.
- **Standard capability:** a bundled `standard.host.mjs` (in `~/.copilot/workflows/`, beside the
  standard harnesses) exposes generic `git`/`readText`/`readJson`/`exists`/`glob`/`writeText`/
  `writeJson` effects — reference it with `host: "standard"`, or `export * from "./standard.host.mjs"`
  in your own sidecar.

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
  **host sidecar** (`<name>.host.mjs`) as an effect and call it via `host.<name>(input)`; use the
  `ctx` toolkit (`ctx.git`, `ctx.files.readJson`/`writeJson`, `ctx.parseDiff`) inside the effect.
  Don't ask an agent to re-run a deterministic classifier — mine in the sidecar (checkpointed) and
  reserve agents for judgment (safety assessment, reports).
- Python keyword args become an options object, e.g. `agent="worker", enable_mcp=True` → `{ agentType: "worker", enableMcp: true }`

Save converted workflows as `~/.copilot/workflows/<name>.mjs`. The JavaScript harness is async, uses
top-level `await`, and ends with `return <value>`.
