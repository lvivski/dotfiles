# Execution controls and recovery

Read when adjusting research breadth or interpreting a run that did not produce a complete report.

## Inputs and execution

`question` is required and must be non-empty. Optional `angles` must be a positive integer; the
default is five, capped at twelve and the factory's supported workload.

```text
run_factory({
  name: "deep-research",
  args: { question: "<bounded research question>", angles: 3 }
})
```

Each angle runs directly as the built-in `research` agent in one native pipeline.
The runtime's two-agent concurrency limit replaces manual batching.
Verifiers independently open cited URLs and check material claims. These mechanics belong to
the factory; do not duplicate them with another pool of agents.

## Result handling

| Result | Meaning and action |
| --- | --- |
| Cited report | Return supported findings and preserve the coverage note and open questions |
| `Research unsupported` | No angle passed source verification; do not synthesize an answer from rejected findings |
| `Research incomplete` | Planning produced no usable angles or synthesis failed; report the stated limitation rather than a successful research conclusion |
| Partial coverage | Keep the researched, verified, rejected, and failed angle counts visible |

## Recovery

Inspect the original `runId` with `factories_manage` using `operation: "inspect-run"`. Wait for a
running run instead of polling or relaunching it. After the user asks to continue, resume a paused
or failed run with native `canResume: true` using
`run_factory({ resumeFromRunId: "<run-id>" })` so completed work is reused.

A limit failure requires explicit user authorization before increasing the reached limit.
Do not invent ceilings, lower declared limits, or start a replacement to evade the limit.
If the factory is unavailable, report the missing Foundry prerequisite rather than silently
substituting another workflow.
