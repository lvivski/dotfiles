# Conveyor recipes

## Independent review pipeline

```js
phase("Review");
const rows = await pipeline(
  files,
  (file, _original, index) =>
    agent(`Review ${file}`, { label: `review:${index}` }),
  (review, file, index) =>
    review === null
      ? null
      : agent(`Verify against ${file}:\n\n${review}`, { label: `verify:${index}` }),
);
```

## Barrier before synthesis

```js
const reviews = await parallel(
  files.map((file, index) => () =>
    agent(`Review ${file}`, { label: `review:${index}` }),
  ),
);
const usable = reviews.filter((value) => value !== null);
const report = await agent(`Synthesize:\n\n${usable.join("\n\n")}`, {
  label: "report",
});
```

## Structured output

```js
const schema = {
  type: "object",
  properties: {
    risk: { enum: ["low", "medium", "high"] },
    reason: { type: "string" },
  },
  required: ["risk", "reason"],
};

const result = await agent("Classify this change.", {
  label: "classifier",
  schema,
});
if (result === null) return { status: "failed" };
```

## Durable computation

```js
const inventory = await step("inventory-v1", () => computeInventory());
```

The key is the full identity. Rename it when inputs or behavior change. Use `{ volatile: true }` only
when the producer must run again on resume.

## Loop until dry

```js
const seen = new Set();
let dry = 0;
for (let round = 0; round < 10 && dry < 2; round++) {
  const result = await agent(
    `Find new issues not in ${JSON.stringify([...seen])}`,
    { label: `finder:${round}` },
  );
  if (result === null) {
    dry++;
    continue;
  }
  const before = seen.size;
  result.split("\n").filter(Boolean).forEach((item) => seen.add(item));
  dry = seen.size === before ? dry + 1 : 0;
}
```
