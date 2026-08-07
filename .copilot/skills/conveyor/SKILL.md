---
name: conveyor
description: Run plain JavaScript orchestration on the native Agent Factory runtime.
---

# Conveyor

Conveyor resolves inline, path-based, or saved `.mjs` harnesses and executes them as native Agent
Factory runs. Use it for substantial fan-out, pipelines, repeated discovery, and independent
verification. Use direct tools for routine edits and lookups.

## Process

1. Identify the real work list before launching agents.
2. Use `pipeline()` when each item advances independently; use `parallel()` only for a real barrier.
3. Write plain JavaScript with a literal `meta` block and native Factory limits.
4. Give every independent `agent()` call a unique `label`.
5. Launch with `run_conveyor`.
6. Resume by run ID with `run_factory({ resumeFromRunId, limits? })`.
7. Inspect runs with `factories_manage` operations `runs` and `inspect`.

## Minimal harness

```js
export const meta = {
  name: "review",
  description: "Review items and summarize the findings.",
  limits: {
    maxConcurrentSubagents: 4,
    maxTotalSubagents: 20,
    timeoutSeconds: 600,
    maxAiCredits: 20,
  },
};

const items = context.args;

phase("Review");
const findings = await pipeline(items, (item, _original, index) =>
  agent(`Review: ${item}`, { label: `review:${index}` }),
);

phase("Report");
const report = await agent(
  `Summarize these findings:\n\n${findings.filter((v) => v !== null).join("\n\n")}`,
  { label: "report" },
);
return report;
```

Invoke it with exactly one source selector:

```text
run_conveyor({
  name: "review",
  args: ["one", "two"],
  limits: { maxAiCredits: 30 }
})
```

## Native semantics

- `agent(prompt, { label?, schema?, model? })` returns text, structured JSON, or `null`.
- Ordinary agent failures return `null`; cancellation and hard Factory failures reject the run.
- Identical prompt/options calls memoize to one subagent. Use unique labels for independent work.
- `parallel(thunks)` is a barrier and converts ordinary thunk failures to `null`.
- `pipeline(items, ...stages)` advances each item independently; failed items become `null`.
- `phase(title)` is run-global. Call it only at run-level transitions.
- `step(key, producer, { volatile? })` uses the key as its complete durable identity.
- The harness receives `context.args`, `context.runId`, and `context.signal`.
- Harness results must be strict JSON or `undefined`.

The native Factory runtime owns limits, durable replay, accounting, resume, cancellation, progress,
and results.

## References

- [Conveyor API](references/conveyor-api.md)
- [Recipes](references/recipes.md)
