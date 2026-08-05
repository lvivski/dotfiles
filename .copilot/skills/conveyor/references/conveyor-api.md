# Conveyor API

A workflow is a plain JavaScript async body. It must start with:

```js
export const meta = {
  name: "audit",
  description: "Audit files and report verified findings.",
  phases: ["review", "verify", "report"],
};
```

The harness has five core orchestration primitives and four namespaces.

## Core primitives

### `agent(prompt, options?)`

Returns an `AgentOutcome`:

```js
{
  kind: "agent",
  value,                    // text, or validated object when schema is set
  content,                  // textual response
  ok, error, sessionId,
  model, durationMs,
  cached, skipped, usageUnknown,
  warnings,
}
```

Options:

- `schema`: supported JSON-shape schema; validated output is returned as `value`.
- `profile`: `"inherit"`, `"none"`, `"read-only"`, or `"research"`.
- `tools`: `{ available?, excluded? }`, narrowing only.
- `permissions`: `{ deny?, denyUrls?, paths? }`, narrowing only.
- `mcp`: `"inherit"` or `"off"`.
- `model`, `effort`, `context`, `agentType`, `label`, `cwd`, `timeout`, `key`.
- `isolation: "worktree"` for an automatically-managed isolated checkout.

Use `agent.followUp(result, prompt, options?)` for another turn in the same session.

Each agent runs in its own Copilot session, which the run disposes of when it completes: sessions
whose agent failed, and every session of a run that ended in any state other than `complete`, are
preserved for inspection (`copilot --resume <sessionId>`) and listed as `preservedSessions` in
`run.json`. Set `CONVEYOR_KEEP_SESSIONS=1` to keep them all.

### `parallel(thunks, options?)`

A barrier over zero-argument functions. Results preserve input order.

### `pipeline(items, ...stages, options?)`

Streams each item independently through every stage. One-stage `pipeline(items, fn)` is the
fan-out/map primitive.

Every stage is called as `stage(prev, item, index)`, where `prev` is the previous stage's result, so
on the first stage `prev` and `item` are the same value. The index is the third parameter —
`pipeline(items, (item, i) => ...)` binds `i` to the item, not the index:

```js
await pipeline(files, (file, _same, index) => agent(`Review ${index}: ${file}`));
```

Both helpers accept:

- `concurrency`
- `onFailure: "raise" | "drop" | "keep"`; default `"raise"`.

The policy applies to thrown callback errors and failed `AgentOutcome` values.

### `phase(name, callback)`

Runs the callback in a lexical phase scope and returns its exact value:

```js
const findings = await phase("review", () =>
  pipeline(files, (file) => agent(`Review ${file}`, { profile: "read-only" })),
);
```

### `log(message, options?)`

Adds a workflow progress message. Treat data derived from files, web pages, or agents as untrusted.

## Namespaces

### `context`

- `context.args`
- `context.dryRun`
- `context.budget.total`, `spent()`, `remaining()`, `hit`
- `context.capabilities`
- `context.memory.read()`, `append()`, `write()`, `clear()`, `enabled`

The harness cannot mutate the launch budget. When a non-strict run reaches the boundary it asks the
host to approve more headroom, and repeats that each time the raised ceiling is exhausted, so a long
run is never silently truncated. Declining stops the asking for the rest of the run — including
after a resume. Every decision is journaled, and the newest approved ceiling is restored on resume.

### `verify(subject, rubric, options?)`

Checks `subject` against `rubric` with an adversarial reviewer and returns a verdict:

```js
{ passed, score, reasons, raw, ok, error }
```

Fail-closed: if the verifier agent itself fails, the verdict is `{ ok: false, passed: false }` — it
never throws and never silently passes. Options are the same as `agent()`; `refute: false` swaps the
skeptical persona for a neutral one.

Anything else (merging, classifying, ranking, generate-and-filter) is a prompt plus `agent()`, so
write it in the harness where you can see it.

### `host`

`host.<effect>(input, options?)` invokes a function exported by the adjacent `.host.mjs` sidecar.
Effects run as trusted host code, are checkpointed, and receive `{ cwd, dryRun, restricted, signal,
log }`. Mark mutating effects with `fn.mutates = true`; they are skipped during dry-run.

### `workspace`

- `workspace.worktree(name, options, callback)`
- `workspace.worktree.create(name, options)`

Dirty worktrees are preserved; clean worktrees are removed.

## Profiles and permission state

- `none`: no tools.
- `read-only`: repository reads; shell, writes, URLs, and MCP denied.
- `research`: reads plus inherited network/MCP; shell and writes denied.
- `inherit`: no additional profile restriction.

Parent `allow-all on` is inherited as pre-authorization, narrowed by the selected profile, workflow
directories, URL denials, tool filters, and MCP settings. Parent `allow-all auto` uses Copilot's
native auto-approval judge in each child; recommendations that still require confirmation are
denied because workflow agents are non-interactive. Parent autopilot mode is inherited too.

The SDK does not expose an authoritative evaluator for arbitrary fine-grained parent rules. With
normal permission mode, `read-only` and `research` fail closed, while `inherit` becomes tool-free.
Inspect `context.capabilities.permissions` and the persisted run's permission inheritance fields.

## Run artifacts and control

Runs persist `manifest.json`, `journal.jsonl`, `script.js`, `state.json`,
`run.json`, `result.json`, `progress.jsonl`, `meta.json`, and optional `host.mjs`. A transient
`.lock/owner.json` holds the run's lease and is removed when the lease is released.

Use:

- `list_conveyor_runs`
- `inspect_conveyor_run({ runId })`
- `get_conveyor_result({ runId, offset?, limit? })`
- `control_conveyor_run({ runId, action: "pause" | "resume" | "cancel", invalidate? })`

Pause quiesces and persists the run. Resume re-executes from the beginning and replays durable
checkpoints; JavaScript continuations are never serialized. To rerun only selected parallel or
pipeline branches, pass canonical branch paths such as `invalidate: ["/0", "/2/1"]`. `/` is the
root and invalidates the entire workflow; invalidating a parent includes every descendant while
sibling checkpoints remain reusable. `inspect_conveyor_run` and `inspect_conveyor_agent` expose
branch paths and prior invalidation generations.
