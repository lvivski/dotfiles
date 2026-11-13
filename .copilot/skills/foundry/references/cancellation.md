# Cancellation

Read before cancelling a plan. Cancellation is a two-phase protocol; requesting it does not prove
that external work has stopped.

1. Call `foundry_cancel` once with a stable request ID, reason, and user identity.
2. Stop every attached App child through a supported termination control. Archiving removes its
   worktree and requires separate explicit user authorization or the archive tool's verified
   finished-work eligibility; it is not an automatic substitute for unavailable termination.
   Only archive sessions this coordinator created. If no authorized control is available, retain
   the cancellation hold. Also reconcile retained created-but-unattached children, in-flight
   admissions and supplemental activity. Record `no-session-created` only when creation definitively
   produced no worker; lack of attachment is not that proof.
3. Call `foundry_cancel_verification_run` with the current revision and the same cancellation request
   ID. Use its `verificationDisposition`; never supply an arbitrary Workflow run ID.
4. Capture a fresh exhaustive App session inventory after those termination attempts.
5. Call `foundry_finalize_cancellation` with exact attempt dispositions, the returned verification
   disposition when present, and the fresh inventory.

For composed parallel admissions, `foundry_cancel` first persists the native plan request and then
installs the actual shared writer's permanent owner/plan fence through `cancelPlan`. The returned
`cancelling` plan acknowledges fencing, not native termination or released claims. An interrupted
two-database join or `storage_busy` remains a hold; reread and retry the same request ID rather than
inventing a new cancellation or resuming dispatch.

After that fence and before finalization,
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

The shared admission schema 3 fence rejects new claims and replays, including a stale writer after
all historical rows are released; unchanged v1/v2 writers reject the upgraded schema. Only the
admission initializer migrates it. `readCancellation` retains the consistent owner/plan census,
including released records and whole positive observations, not merely active plan attempts.
Parallel finalization requires every admission released through its writer and fresh trusted native
terminal observations for all bound history, including already-delivered producers. A released claim
is not a terminated child. Missing, stale or nonterminal observations retain
`parallel_cancellation_join_pending` or the explicit unavailable-observation hold; caller inventory
and `finalizationOverride` cannot bypass this proof. Existing native plan dispositions and the
authoritative verification-run guard still apply. Do not retry in a polling loop.
New ownership discovered during finalization of released history is retained as a whole positive
capture in the same owner's plan before returning a hold. Read the updated revision and obtain a
fresh observation; absence on a later capture, service restart or an old terminal delivery cannot
erase it. This observation-only field does not reopen admissions or grant new claim authority.

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
