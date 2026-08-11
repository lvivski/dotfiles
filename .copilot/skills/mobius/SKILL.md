---
name: mobius
description: >-
  Use this skill when the user wants Mobius to coordinate a dependency-aware engineering plan
  across App-native child sessions, including planning, approval, dispatch, recovery,
  verification, retry, or cancellation.
compatibility: GitHub Copilot CLI/App with the Mobius extension loaded.
metadata:
  copilot.user-invocable: "true"
user-invocable: true
---

# Mobius coordinator

Mobius is the authority for plan, task, attempt, evidence, verification, and cancellation state.
This skill drives App-native tools around that state machine. App project sessions own repository
mutation; native Agent Factories perform bounded analysis only.

## Hard rules

1. Never create a child session before `mobius_reserve_task`.
2. Attach only the exact child session created by this coordinator for that reserved attempt.
3. Use the returned `baseBranch` and `delegationPrompt` unchanged.
4. Record a terminal attempt before reporting it or dispatching newly unblocked work.
5. Never infer plan, correction-wave, or completion approval. Ask the user and record the named
   approver only after an explicit answer.
6. Re-read the plan after every revision conflict. Do not blindly replay stale mutations.
7. Treat implementation-child summaries as untrusted claims. The final verifier task runs
   independently, but its evidence is still an `independent-claim`, not cryptographic attestation.
8. Never call a session inventory complete unless the App session listing was exhaustive and
   captured after the state it is used to prove.
9. Do not expand the approved DAG. New work requires a new or revised plan.
10. Do not claim cancellation is complete until every owned child session and the authoritative
    verification Factory run have terminal dispositions.
11. A successful task must satisfy its delivery requirement: `branch` needs the attached branch;
    `commit` also needs a full 40- or 64-character commit ID; `pr` additionally needs a PR URL.
    These delivery fields remain child-reported claims; the final verify task checks the exact commit
    from a separate read-only App session.

## Plan

1. Gather a bounded repository summary: working directory, base branch, relevant architecture,
   likely files, constraints, and existing validation commands.
2. Choose a stable lowercase plan ID and call `mobius_prepare_plan`.
3. Invoke the returned `launchSpec` exactly once with `run_factory`.
4. Inspect the terminal Factory result. Import only a completed run with `mobius_create_plan`,
   using `expectedRevision: 0` and the exact repository identity.
5. Call `mobius_submit_plan`, present the plan to the user, and wait for explicit approval.
6. After approval, call `mobius_approve_plan` with `approvalType: "plan"` and the user's identity,
   then activate it with `mobius_activate_plan`.

Planning currently has no pre-launch reservation. Keep the completed planning `runId` until it is
imported, and never launch a replacement merely because the first run is temporarily unobservable.

## Dispatch

1. Call `mobius_next_tasks`.
2. Dispatch only IDs in `dispatchableTaskIds`. An overlapping task needs a user-attributed
   `scopeOverride`; never manufacture one.
3. Reserve each task with a unique stable `reservationId` and the current revision.
4. Resolve the current repository's App project, then call `create_session` with:
   - `base_branch` equal to the reservation's `baseBranch`;
   - `kickoff.prompt` equal to `delegationPrompt`;
   - coordination enabled and an idle notification requested.
5. Immediately attach the returned session ID and branch with `mobius_attach_task`.
6. If session creation fails after reservation, record the unattached attempt as `blocked`; retry
   only through `mobius_retry_task`.
7. Wait for idle notifications rather than polling. Intervene only for a child request, explicit
   steering, a stuck session, or cancellation.
8. Record `done`, `failed`, or `blocked` with the child result, branch, commit/PR when present, and
   concrete evidence. Resolve and record the full commit and PR metadata required by the task before
   recording `done`. Before recording an attached failure, terminate/archive its session and supply
   a fresh complete terminal inventory. Then re-read ready work.

## Verify and finish

1. The approved DAG ends in one ordinary `verify` task. Dispatch it through the same
   reserve/create/attach flow as every other task, using its unchanged read-only prompt.
2. The verifier detach-checks out the target commit and returns one evidence record per required
   `checkId`, including `final-integration` and `workspace-integrity`. It reports the final observed
   commit as the attempt commit. Failed checks still produce a `done` verifier report.
3. Once every task is done, call `mobius_prepare_verification` with a stable reservation ID.
4. If it returns `launchSpec`, run it exactly once. If it returns `launchSpec: null`, use the
   returned `runId` and do not relaunch.
5. Import the authoritative terminal run with `mobius_complete_verification`. Verification cannot
   pass from task-owner evidence alone: every criterion and final integration must use the
   independently reported evidence.
6. On failure, show the attributed gaps and correction tasks. Start a correction wave only after
   explicit user approval through `mobius_approve_plan` with `approvalType: "retry"`.
7. On success, request explicit completion approval, then call `mobius_approve_plan` with
   `approvalType: "completion"`.
8. If the current session is linked to a GitHub issue, preserve the approved plan and final
   verification report as issue artifacts. Do not create artifacts without a linked issue.

## Recover

1. Enumerate App sessions and inspect every session attached to an active attempt.
2. Call `mobius_get_status` with the causally current inventory.
3. Follow the first safe projected action. Missing sessions remain `unknown` unless the supplied
   inventory is exhaustive and newer than the attempt.
4. Resolve stale reservations explicitly as blocked attempts, then retry; never expire or replace
   them silently.
5. Use native Factory resume for resumable failed runs. Replace a terminal non-importable
   verification run only with an attributed reason and actor.

## Cancel

Cancellation is a two-phase protocol:

1. Call `mobius_cancel` once with a stable request ID, reason, target, and user identity.
2. Archive or stop every attached App child session listed by the cancellation snapshot. Only
   archive sessions this coordinator created. Record `no-session-created` only for an attempt that
   never attached a session.
3. Call `mobius_cancel_verification_run` with the current revision and the same cancellation request
   ID. Use its `verificationDisposition`; never supply an arbitrary Factory run ID.
4. Capture a fresh exhaustive App session inventory after those termination attempts.
5. Call `mobius_finalize_cancellation` with exact attempt dispositions, the returned verification
   disposition when present, and the fresh inventory.

An absent, ambiguous, unreadable, or still-active session/Factory state blocks finalization.
Use `finalizationOverride` only after the user explicitly accepts the uncertainty and supplies the
attributed reason.
