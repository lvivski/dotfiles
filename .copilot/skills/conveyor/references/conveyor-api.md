# Conveyor API

Conveyor is a source loader for one native Agent Factory named `conveyor`. A harness is a plain
JavaScript async body executed in a deterministic VM and supplied only the native orchestration
primitives below.

## Metadata

```js
export const meta = {
  name: "audit",
  description: "Audit files and verify findings.",
  limits: {
    maxConcurrentSubagents: 4,
    maxTotalSubagents: 30,
    timeoutSeconds: 600,
    maxAiCredits: 20,
  },
};
```

Only native Factory limit names are accepted.

## `agent(prompt, options?)`

Options are exactly:

- `label`
- `schema`
- `model`

Without a schema, the result is text. With a schema, it is parsed JSON. Ordinary failures return
`null`. Native Factory schemas enforce only their supported structural subset.

Calls with identical prompt and options are memoized into one subagent. Give independent calls unique
labels.

## `parallel(thunks)`

Runs thunks concurrently and waits for all of them. Ordinary thunk failures become `null`; hard
Factory failures propagate.

## `pipeline(items, ...stages)`

Processes each item through every stage without a barrier between stages. A stage receives
`(previous, originalItem, index)`. An ordinary stage failure drops that item to `null`.

## `phase(title)`

Sets the run-global phase. Concurrent phase calls race, so call it only between run-level stages.

## `step(key, producer, options?)`

Persists one strict-JSON producer result under `key`. The key is the complete identity; change it when
the producer meaning changes. `{ volatile: true }` bypasses durable replay.

## `log(message)`

Appends prompt-safe native Factory progress.

## `context`

```js
{
  args,   // invocation input
  runId,  // native Factory run ID
  signal, // cooperative cancellation
}
```

## Launch and lifecycle

`run_conveyor` accepts:

```text
{
  script?: string,
  scriptPath?: string,
  name?: string,
  args?: JSON,
  limits?: {
    maxConcurrentSubagents?: number,
    maxTotalSubagents?: number,
    timeoutSeconds?: number,
    maxAiCredits?: number
  }
}
```

Provide exactly one of `script`, `scriptPath`, or `name`. Named sources resolve from the nearest
`.copilot/conveyors/` directory and then `~/.copilot/conveyors/`.

The returned envelope is the native Factory result. Resume with:

```text
run_factory({
  resumeFromRunId: "<run-id>",
  limits: { maxAiCredits: 40 }
})
```

Use `factories_manage` to list or inspect runs. Factory arguments persist the exact source and input,
so a resume reuses the original harness bytes.

## VM boundary

The VM blocks clocks, randomness, dynamic imports, `eval`, and direct Node globals so resumed code is
less likely to diverge accidentally. It is not a security sandbox; only trusted harness authors
should supply source.
