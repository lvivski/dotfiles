# Cancellation

Read before cancelling a plan. Cancellation is a two-phase protocol; requesting it does not prove
that external work has stopped.

1. Call `foundry_cancel` once with a stable request ID, reason, and user identity.
2. Archive or stop every attached App child session listed by the cancellation snapshot. Only
   archive sessions this coordinator created. Also reconcile retained created-but-unattached children,
   in-flight admissions and any supplemental activity. Record `no-session-created` only when creation
   definitively produced no worker; lack of attachment is not that proof.
3. Call `foundry_cancel_verification_run` with the current revision and the same cancellation request
   ID. Use its `verificationDisposition`; never supply an arbitrary Workflow run ID.
4. Capture a fresh exhaustive App session inventory after those termination attempts.
5. Call `foundry_finalize_cancellation` with exact attempt dispositions, the returned verification
   disposition when present, and the fresh inventory.

For composed parallel admissions, after the durable `foundry_cancel` fence and before finalization,
call `foundry_reconcile_parallel` with `planId`, `taskId`, `reservationId` for each retained admission
as needed. It verifies the plan fence, enumerates owned admissions internally, fences them through
the shared writer and reconciles the requested identity once using trusted host observations.
It does not itself stop an App child, accept caller inventory or prove uncertain effects terminated.
Missing required recovery/outcome observations retain the hold; default production host ports remain
unavailable. Neither tool registration nor another route's support authorizes a fallback.

Workflow cancellation uses the required `WorkflowAnalysisPort.isMissingWorkflowRun` and
`isTerminalWorkflowStatus` classifiers injected by root composition from canonical native guards.
Missing, active and paused observations remain conservative holds; unrelated errors propagate.
Do not replace these functions with permissive defaults, copied status lists or message matching.

The current composed source returns `parallel_cancellation_join_pending` after persisting the plan
fence and fencing the complete observed owned admission inventory. The admission port lacks a
durable plan-wide claim fence, so a crashed stale reservation writer can outlive that census.
Reconciliation can settle known admissions but cannot prove writer quiescence. Parallel finalization
retains this separate source-level hold; neither caller inventory nor `finalizationOverride` closes
it. Do not retry in a polling loop or label the join complete. Repair requires authorized source
correction, not an invented host observation.

Prepared is not started; attached is not stopped; historical DONE is not proof that supplemental
activity is terminal. Account for late native outcomes after cancellation and retain reservations/
resource claims while any owned effect, child or authoritative run is uncertain. Only the shared
admission writer settles/releases claims through its fenced protocol; cancellation is not a second
claim writer, timeout release or foreign-owner takeover. Missing supported invocation remains a hold,
not permission to switch paths. A missing [correction binding](dispatch.md#supplemental-original-owner-corrections)
cannot be repaired by reopening DONE, inventing an attachment or creating a replacement child.

An absent, ambiguous, unreadable, paused, or still-active session/Workflow state blocks finalization.
Use `finalizationOverride` only after the user explicitly accepts the uncertainty and supplies the
attributed reason.
