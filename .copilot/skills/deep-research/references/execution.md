# Execution controls and recovery

Read when adjusting research breadth or interpreting a run that did not produce a complete report.

## Inputs and execution

`question` is required and must be non-empty. Optional `angles` must be a positive integer; the
default is five. With the current 40-subagent limit, fresh research is capped at nine angles to reserve
the planner, synthesis, and one independent correction/reverification pass per angle. The SDK's
structured-output correction turns reuse the same agent; they still consume time and credits.
A reduced angle count is reported explicitly rather than silently claiming full coverage.

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

Each angle uses one native pipeline: research, finding-level verification, an optional targeted
correction, and independent re-verification. Research and correction call the built-in `research`
agent directly. The runtime's two-agent concurrency limit replaces manual batching.

Verification splits a draft into independently checkable claims, not a single verdict for a long
report. Each finding records its claim, source URLs, evidence, reasons, and one of four statuses:
`supported`, `incorrect`, `inaccessible`, or `insufficient`. Verifiers independently open cited
sources; source identity and actual claim support are separate questions. Access failures do not
establish that a claim is false.

Only unresolved findings enter the correction pass. Previously supported findings cannot be
overwritten by corrections. Corrections retain finding identity and require independent verification
before entering synthesis. Missing, duplicate, or unknown correction IDs cannot grant support.
There is no second correction loop; failed or still-uncertain findings remain visible in the report.

These mechanics belong to the workflow; do not duplicate them with another pool of agents or
increase invocation limits without explicit user authorization.

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
The Foundry board and `foundry_control_workflow` also provide user-directed pause/resume with unchanged
limits. Read the logged prepared scope before continuing from an opt-in checkpoint. In-flight work
interrupted by a manual pause may need to repeat.

A limit failure requires explicit user authorization before increasing the reached limit.
Do not invent ceilings, lower declared limits, or start a replacement to evade the limit.
If the workflow is unavailable, report the missing Foundry prerequisite rather than silently
substituting another workflow.

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
unresolved findings once, reverifies those corrections, and synthesizes supported evidence.
Feedback is an untrusted lead, not proof. Missing drafts or notes must not be reconstructed from
memory and presented as original results.

With current limits and the twelve-angle ceiling, at most twelve saved drafts are accepted.
Oversized recovery input is rejected before starting agents; it is not silently truncated. No new
limits are set by this mode. Fresh research reserves at most `2 + 4 * angles` agent admissions;
saved-draft recovery reserves at most `1 + 3 * drafts`. Actual usage is lower when findings do not
need correction. Schema correction is not independent evidence verification and does not replace it.
