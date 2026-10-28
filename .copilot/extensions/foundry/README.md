# Foundry

Foundry is the Copilot extension control plane for native Dynamic Workflows and dependency-aware
engineering plans across App-native project sessions.

## When to use Foundry

Foundry coordination is already opt-in. Routine changes can use native plan mode and direct tools;
ordinary multi-session work and dependent PRs can use the native `orchestrate` and `pr-stack` flows.
Those flows do not require a Foundry plan.

Use Foundry when explicitly requesting a durable dependency-aware plan with approval gates,
reserved task attempts, delivery/evidence contracts, and cross-session recovery. Native workflow
journals and session tools provide the execution primitives, not an equivalent to those policies.
An explicit Foundry request still follows the complete coordinator protocol, including importing
its planning workflow result; native plan mode is not a substitute for that result.

## Dynamic workflows

| Workflow | Purpose |
| --- | --- |
| `plan` | Create, critique, synthesize, and verify a dependency-aware plan |
| `verify` | Produce the final fail-closed evidence verdict |
| `audit` | Audit files for a specified concern |
| `deep-research` | Verify individual sourced findings, correct unresolved claims once, and retain partial results |
| `review-queue` | Triage correctness and maintainability risks in supplied diffs |
| `security-review` | Run a multi-perspective static security review |
| `triage` | Classify and prioritize tickets |

Invoke these workflows with `run_dynamic_workflow` and inspect the returned `runId` with
`dynamic_workflows_manage` (`inspect-run`). The five general workflows use the native workflow
lifecycle directly and never mutate Foundry plan state.

Definitions live in `workflows/` and register through `defineWorkflow` and `joinSession({ workflows })`.
The control-plane adapter uses `session.workflow` for inspection, pause, resume, and cancellation. Registered
names, reservation markers, and persisted Foundry plan fields are unchanged.

Plan and verification imports use native `waitForRun` for active runs instead of requiring a
separate wait/inspect/retry cycle. Interrupting the tool stops waiting, not the Workflow.
Paused or failed runs still require explicit recovery; verification rechecks revision and
reservation ownership after waiting, and completion still requires user approval.

### Pause, resume, and checkpoints

Use the board's Pause/Resume buttons or `foundry_control_workflow({ runId, action: "pause" | "resume" })`
only when the user requests it. Resume checks native `canResume`, keeps the same run, journal,
arguments, accounting, and limits, and waits for the next settled attempt. Board updates remain live
while that request waits, so Pause remains available once execution starts. These controls do not
pause App task sessions, import results, grant approvals, or start replacement runs.
Interrupting the tool or closing the board stops its wait, not the resumed workflow.

Verification controls also require `planId` and `expectedRevision`; the run must be the unique owner
of the running plan's active reservation. Controls are unavailable during cancellation or after the
reservation has been consumed. Reached limits require an explicitly approved increase through native
`run_dynamic_workflow`, not an automatic retry with higher limits.

All five standalone recipes accept `pauseBeforeWork: true` in their object arguments. The default is
false, and existing string/array shorthand still works. Research pauses after angle planning and
security review after orientation; audit, triage, and review queue pause after preparing their bounded
work scope but before bulk agents start. Read the logged scope before resuming.

Prepared scopes use versioned native `step` journals; agents retain the SDK's own memoization.
The one-shot `pause` checkpoint stops the first attempt and returns on resume. The workflow body
restarts, replaying completed work; interrupted agents may need to run again. These checkpoints are
not Foundry approval records. The `plan` and `verify` recipes keep their existing approval protocol.

The board follows native `workflow.run_updated` invalidations and re-reads current state, showing
phases, live-agent counts, checkpoint details, and prepared-scope progress. Native revisions are
separate from plan revisions. Recent history is bounded to 20 terminal runs plus active runs;
the current plan's verification run is included even outside that window. Unrelated verification
runs are excluded. Disconnected views refresh on SSE reconnection; Refresh is also available.
`foundry_get_status` exposes the same view with `includeWorkflows: true`; unavailable native state
is reported separately and never prevents reading the plan.

### Structured output and workload bounds

Every workflow declares an SDK argument schema so structurally malformed model invocations fail before
approval or credit spend. Workload bounds count actual agent admissions: the SDK's structured-output
correction turns reuse the same agent, consuming time and credits but no additional agent slots.
Independent review, correction, and verification stages still need separate agents.

Structured output objects declare explicit types, all fields as required, and
`additionalProperties: false`. Flat audit/review-queue verification verdicts, security verdicts, and
ticket classifications fit the provider-native schema subset on eligible model routes. Array-heavy
result contracts retain their existing shapes and the SDK's parsed/validated fallback rather than
adding conversion layers.
Runtime schema validation is structural, not full JSON Schema validation; semantic and evidence
checks remain necessary on every route.

Deep research batches atomic claim verdicts within each angle, preserving supported findings while
distinguishing incorrect claims, inaccessible sources, and insufficient evidence. Only unresolved
findings get one targeted correction and independent re-verification. Synthesis receives supported
claims and their source evidence, not unverified drafts; rejection reasons, correction history, and
stage failures remain in the returned report. If synthesis fails, verified claims and citations are
returned directly with the failure stated.

Explicitly supplied `drafts` can recover saved research without repeating planning or broad discovery.
The existing limits are unchanged: capacity is reserved for independent correction and reverification,
allowing up to nine fresh angles or twelve saved drafts. Oversized recovery input is rejected, not
truncated. See the
[deep-research skill](../../skills/deep-research/SKILL.md) for approval and recovery rules.

The review queue pipelines each PR through review and verification independently. A PR must still
finish every chunk review before it can enter verification, and only complete, clean evidence that
passes the configured policy can be recommended for approval. The final queue report waits for all
PRs; pipelining does not reduce reviewer count or expand the supplied-evidence scope.

Review covers correctness and maintainability. The report includes observed line changes and
actionable concerns rather than quality scores; counts alone do not block approval. Material
concerns and incomplete evidence require human review. The workflow remains diff-only, without
additional checkouts, analyzers, or reviewers. Start with the
[review-queue skill](../../skills/review-queue/SKILL.md); load its local references only when adjusting
queue options or interpreting the detailed review criteria and metric limits.

## Plan model

A plan contains one or more implementation tasks and exactly one final verifier task. Every
implementation path converges into the verifier's single implementation dependency. The final
implementation task must deliver a commit or PR; the read-only verifier reports canonical evidence
for every acceptance criterion plus `final-integration` and `workspace-integrity`.

Foundry owns:

- optimistic plan revisions and explicit approval gates;
- reserve-before-create task attempts and immediate App-session attachment;
- delivery requirements for branches, commits, and pull requests;
- causal session inventories for retry and cancellation safety;
- canonical evidence, correction waves, and final workflow verification;
- atomic storage, cross-process locks, stale-lock recovery, and deterministic recovery projections;
- session-local guardrails and the interactive `foundry-board` canvas;
- a bounded, revisioned activity timeline rendered from the authoritative plan document.

Workflow agents perform analysis only. App-native project sessions own repository mutation.

## Tool surface

| Area | Tools |
| --- | --- |
| Planning | `foundry_prepare_plan`, `foundry_create_plan`, `foundry_submit_plan`, `foundry_approve_plan` |
| Inspection | `foundry_get_plan`, `foundry_get_status`, `foundry_list_plans` |
| Native workflows | `foundry_control_workflow` |
| Recovery | `foundry_quarantine_plan` |
| Tasks | `foundry_next_tasks`, `foundry_reserve_task`, `foundry_attach_task`, `foundry_complete_task`, `foundry_retry_task` |
| Verification | `foundry_prepare_verification`, `foundry_complete_verification` |
| Cancellation | `foundry_cancel`, `foundry_cancel_verification_run`, `foundry_finalize_cancellation` |
| Hooks | `foundry_activate_plan`, `foundry_deactivate_plan` |

The coordinator protocol lives in
[`../../skills/foundry/SKILL.md`](../../skills/foundry/SKILL.md).

Activation and plan storage are local to the current Copilot session. The shell classifiers are
conservative friction, not a sandbox or a complete shell parser; indirect execution remains subject
to the host permission boundary. Deactivation removes an unreadable activation marker and reports
that repair instead of leaving the session stuck behind a corrupt marker.

Coordinator context is supplied on activation and session start. Ordinary successful Foundry tool
calls do not add repetitive reminders; activation, deactivation, unreadable-state, and failure
guidance remain available. This does not change permission checks or revision enforcement.

The board can request cancellation, but the coordinator must still stop owned App sessions, cancel
the authoritative verification workflow run, and finalize with a fresh causal inventory.

Plan artifacts have one strict current shape. Activity entries contain only the event, timestamp,
and resulting revision. Unsupported fields and stale artifact shapes are rejected rather than
migrated. `foundry_list_plans` reports
their validation details; after explicit approval, `foundry_quarantine_plan` preserves an unreadable
artifact under a hidden filename and returns the requester and reason so the plan ID can be reused.

## Validation

```sh
node --test .copilot/extensions/foundry/*.test.mjs
```

With TypeScript and Node.js type declarations available, check the offline SDK contracts and
compile-only regression cases with:

```sh
tsc --project .copilot/extensions/foundry/jsconfig.json
```

The local SDK declarations cover the surfaces Foundry consumes. Tool results use namespaced
telemetry, and workflow inspection preserves typed failure and pause metadata. A paused attempt
is settled in the SDK, but is still not terminal evidence for Foundry cancellation.
