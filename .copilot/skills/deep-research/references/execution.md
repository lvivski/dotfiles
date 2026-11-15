# Execution controls and recovery

Read when adjusting research breadth or interpreting a run that did not produce a complete report.
These controls apply to authorized heavy research; satisfy the
[activation gate](../SKILL.md#activation-gate) before launching, not merely because a question needs sources.

## Inputs and execution

`question` is required and must be non-empty. Optional `angles` must be a positive integer; when
omitted, the planner chooses the substantively useful angles. There is no built-in angle ceiling or
declared runtime budget. Omitted worker, concurrency, time and credit limits are unbounded.
Pass runtime limits only when the user specifies them. If a planner exceeds an explicit angle count,
the workflow retains the requested number and logs the omitted angles rather than claiming full coverage.
The SDK's structured-output correction turns reuse the same agent and still consume time and credits.

When the user wants to review the scope before broad research, add `pauseBeforeWork: true` to the
object arguments. It defaults to false. The workflow journals its prepared angles and any recovery
drafts, logs that scope, and pauses once after planning. Native resume reuses that scope and completed
agent calls; it does not restart broad discovery or discard the run's accumulated usage.

```text
run_dynamic_workflow({
  name: "deep-research",
  args: { question: "<bounded research question>", angles: 3 }
})
```

Each angle uses one native pipeline: research, finding-level verification, targeted corrections
when needed, and independent re-verification. Research and correction call the built-in `research`
agent directly. The native runtime applies concurrency limits only when the user approved one;
the workflow does not impose a two-agent cap or manual batching.

Verification splits a draft into independently checkable claims, not a single verdict for a long
report. Each finding records its claim, source URLs, evidence, reasons, and one of four statuses:
`supported`, `incorrect`, `inaccessible`, or `insufficient`. Verifiers independently open cited
sources; source identity and actual claim support are separate questions. Access failures do not
establish that a claim is false.

Only unresolved findings enter correction passes. Previously supported findings cannot be
overwritten by corrections. Corrections retain finding identity and require independent verification
before entering synthesis. Missing, duplicate, or unknown correction IDs cannot grant support.
Corrections continue while they make progress; failed or still-uncertain findings remain visible in the report.

These mechanics belong to the workflow; do not duplicate them with another pool of agents or
change invocation limits without explicit user authorization.

## Result handling

| Result | Meaning and action |
| --- | --- |
| Cited report | Return supported findings and preserve the verification notes, correction history, and coverage note |
| `Research unsupported` | No findings are supported after the allowed verification/correction work; retain specific rejection and uncertainty reasons, not just a failure count |
| `Research incomplete` | Planning or workflow stages failed without verified findings, or synthesis failed; if verified findings exist, the workflow returns them directly with their citations |
| Partial coverage | Keep supported, incorrect, inaccessible, insufficient, failed-stage, and correction-pass counts visible; unresolved candidates are diagnostics, not recommendations |

## Recovery

Inspect the original `runId` with `dynamic_workflows_manage` using `operation: "inspect-run"`. Wait for a
running run instead of polling or relaunching it. After the user asks to continue, resume a paused
or failed run with native `canResume: true` using
`run_dynamic_workflow({ resumeFromRunId: "<run-id>" })` so completed work is reused.
For a time-review checkpoint or exhausted time limit, follow the explicit time-extension procedure below.
Use the native workflow controls for user-directed pause/resume with unchanged limits.
Read the logged prepared scope before continuing from an opt-in checkpoint. In-flight work
interrupted by a manual pause may need to repeat.

A limit failure requires explicit user authorization before increasing the reached limit.
Do not invent ceilings, change approved limits, or start a replacement to evade the limit.
If the workflow is unavailable, report the missing Foundry prerequisite rather than silently
substituting another workflow.

### Hourly time decisions

There is no default timeout or hourly checkpoint. If the user approved a `timeoutSeconds` ceiling,
unfinished research requests a durable checkpoint 60 seconds before that ceiling. The checkpoint key is
`deep-research:time-review:v1:<approved-timeout-seconds>`, distinct from the optional scope checkpoint.
Research that finishes first returns normally. Native journaled results survive the pause; interrupted
agents can repeat, so do not promise cost-free continuation.

Foundry's native dialog owns the decision on supported hosts: **Extend by one hour**, **Keep paused**,
or **Stop**. Do not ask a competing question, infer approval from a paused notification, or resume
with unchanged limits to bypass this review. An accepted extension resumes the original run with
only `timeoutSeconds` raised by 3,600. Keeping it paused or dismissing the dialog starts no work;
Stop cancels only that workflow. Another unfinished hour produces another decision.

If native dialogs are unavailable, Foundry reports that limitation; ask the user with those same
choices using `ask_user`. A native dialog failure must be surfaced, not silently switched to another
approval path. If the user then explicitly requests manual continuation, inspect the original run
again. Require `canResume: true` and confirm that the checkpoint, approved budget, and eligibility have
not changed. For example, if the approved ceiling is 3,600 seconds, one extension raises it to 7,200:

```text
run_dynamic_workflow({
  resumeFromRunId: "<original-run-id>",
  limits: { timeoutSeconds: 7200 }
})
```

For every extension, add 3,600 to the **current approved
total**, not to zero or to elapsed wall time. Leave all other limits omitted. The SDK cannot raise
the ceiling of a running attempt in place; do not start a replacement run or automatically approve
more credits or agents. An explicitly unbounded timeout has no hourly deadline.

The hard timeout can still win during sleep, disconnection, or slow cooperative shutdown. Foundry
offers the same recovery choice for a new timeout on a run it observed active, not old timed-out
history. Otherwise surface the interruption and ask before extending. Inspect retained journal
evidence rather than claiming the research was lost. After a provider restart, a recent unresolved
checkpoint may be offered again, but never automatically resumed. Keeping a run paused is not a
completed report; retain its ID for the user's later decision.

### Recovering saved drafts

A terminal completed run, including `Research unsupported`, is not made resumable by a code change.
Changed prompts or schemas also have different native journal identities; do not promise that an
old run will replay newly changed calls without cost.

After explicit user approval of a recovery run, supply saved drafts and their available verifier
feedback through `drafts` instead of `angles`:

```text
run_dynamic_workflow({
  name: "deep-research",
  args: {
    question: "<original bounded question and actual comparison baseline>",
    drafts: [{
      angle: "<saved research angle>",
      text: "<saved draft text>",
      feedback: "<saved verifier reasons, when available>"
    }]
  }
})
```

This skips planning and broad research. It independently verifies the saved claims, corrects only
unresolved findings while making progress, reverifies those corrections, and synthesizes supported evidence.
Feedback is an untrusted lead, not proof. Missing drafts or notes must not be reconstructed from
memory and presented as original results.

There is no built-in draft-count ceiling. Recovery retains every valid supplied draft without
truncation and sets no new runtime limits. The number of correction/reverification calls depends
on unresolved findings and progress; do not promise a fixed agent-reservation formula.
Schema correction is not independent evidence verification and does not replace it.
