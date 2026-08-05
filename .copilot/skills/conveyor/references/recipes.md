# Workflow recipes

## Pipeline by default

Use `pipeline()` when each item follows the same stages. It lets fast items advance without waiting
for the slowest sibling.

```js
const checked = await pipeline(
  files,
  (file) => agent(`Review ${file}`, { profile: "read-only" }),
  (review, file) => verify(review, `Verify against ${file}`, { profile: "read-only" }),
);
```

Each stage receives `(prev, item, index)`. The first stage's `prev` is the item itself, which is why
stage one above takes `(file)` and stage two takes `(review, file)`. The index is the third
parameter.

## Barrier only for cross-item work

Use `parallel()` when the next step genuinely needs every result, such as global deduplication.

```js
const reviews = await parallel(files.map((file) => () => agent(`Review ${file}`)));
const report = await agent(`Merge these reviews into one summary.\n\n${reviews.map((r) => r.content).join("\n\n")}`, { profile: "none" });
```

## Failure policy

- `raise`: abort on the first failed outcome or callback exception.
- `drop`: return `null`, mark the run partial, and preserve siblings.
- `keep`: return the failed `AgentOutcome` so workflow code can report it explicitly.

Choose deliberately; never rely on implicit partial success.

## Structured output

```js
const result = await agent("Classify the ticket.", {
  profile: "none",
  schema: {
    type: "object",
    properties: { kind: { enum: ["bug", "feature"] } },
    required: ["kind"],
  },
});
```

## Adversarial verification

Use `verify` for checks that must fail closed. For independent reviewers, run `verify` several times
with `parallel()` and decide the quorum in the harness. Verifiers consuming untrusted findings should
normally use `profile: "none"` or `"read-only"`.

## Deep research

1. Decompose with `agent(..., { schema, profile: "none" })`.
2. Research each angle with `profile: "research"`.
3. Verify source support with another research-profile agent.
4. Synthesize only verified findings with `profile: "none"`.

## Loop until dry

Use normal JavaScript:

```js
let dry = 0;
for (let round = 0; round < 10 && dry < 2; round++) {
  const result = await agent(`Find new issues; round ${round}`);
  dry = foundSomething(result) ? 0 : dry + 1;
}
```

## Durable memory

Use `context.memory`. A run must treat memory reads as external state; Persistence journals them for
deterministic replay.

## Host effects

Put deterministic filesystem/git discovery in `.host.mjs`. Keep model judgment in `agent()`.
Mutating effects must be declared and are skipped during preview.

## Coverage reporting

If a workflow caps, samples, truncates, drops, or cannot verify work, log the boundary and include it
in the final result. Silent partial coverage is a correctness bug.
