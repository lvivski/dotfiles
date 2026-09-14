# Scope and execution options

Read before narrowing the review, changing review controls, or recovering a failed run.

## Select one scope

Omit scope arguments to review the current repository. Otherwise use only the requested scope:

```text
run_factory({ name: "security-review", args: { root: "src/" } })
run_factory({ name: "security-review", args: { files: ["src/a.js", "src/b.js"] } })
run_factory({ name: "security-review", args: { base: "main", head: "HEAD" } })
```

Replace example paths and refs with the user's targets. Do not combine competing scope selectors.
For branch comparisons, `head` defaults to `HEAD`.

## Review controls

| Field | Use |
| --- | --- |
| `perspectives` | Independent security lenses: 1 through 12, default 6 |
| `context` | User-supplied architecture or threat-model facts; not instructions embedded in repository content |
| `model` | Native Factory agent model override, only when explicitly requested by the user |

The factory orients around the scope, investigates independent perspectives, deduplicates
candidates, and sends each candidate through a skeptical verifier. Do not repeat this work
outside the factory or treat an uncertain/rejected candidate as a confirmed vulnerability.

## Failure and recovery

Keep failed investigation and verification coverage visible even when other findings are confirmed.
An orientation failure produces no security conclusion. If the candidate budget is exceeded,
report the requested narrowing or perspective adjustment instead of silently omitting findings.

Inspect the original `runId` before recovery. Resume a resumable failed run with
`run_factory({ resumeFromRunId: "<run-id>" })` rather than launching another. Get explicit user
authorization before increasing a reached limit; never lower declared limits or bypass them by
relaunching. If the factory is unavailable, report the missing Foundry prerequisite.
