# Task dispatch

Read before dispatching ready work or recording an attempt's result.

1. Call `foundry_get_status` and read `projection.scheduling`.
2. Dispatch only IDs in `projection.scheduling.dispatchableTaskIds`. Read its `launches` and
   `scopeConflicts` for delivery guidance and holds. Readiness is derived, not a stored task state.
   An overlapping task needs a user-attributed
   `scopeOverride`; never manufacture one.
3. Reserve each task with a unique stable `reservationId` and the current revision.
4. Resolve the plan repository's App project, then call `create_session` with:
   - `base_branch` equal to the reservation's `baseBranch`;
   - no kickoff yet, so the child cannot change its branch before attachment;
   - coordination enabled and an idle notification requested.
5. Immediately attach the returned session ID and branch with `foundry_attach_task`.
6. Send the reservation's exact `delegationPrompt` to the attached child with
   `send_session_message`. Do not add implementation or comparison-only material.
   The verifier's registered worktree is captured at attachment; only then may it
   detach to the exact target commit. Never substitute the coordinator's checkout
   for that verifier worktree.
7. If session creation fails after reservation, record the unattached attempt as `blocked`; retry
   only through `foundry_retry_task`.
8. Wait for idle notifications rather than polling. Intervene only for a child request, explicit
   steering, a stuck session, or cancellation.
9. Record `done`, `failed`, or `blocked` with the child result, branch, commit/PR when present, and
   concrete evidence. Resolve and record the full commit and PR metadata required by the task before
   recording `done`. Before recording an attached failure, terminate/archive its session and supply
   a fresh complete terminal inventory. Then re-read ready work.

Factory context is included in the reserved prompt. Do not add comparison-only prior implementation
to a reconstruction child's inputs. Keep the incumbent until explicit replacement selection.
Record discovered facts, inferences and proposals in `learning`; they are not accepted obligations.
The verifier must return selected pinned executable `factoryEvaluations` as well as canonical check
evidence. Human modalities/judgment procedures use explicit human review, never an agent verdict.
Verifier-only renewal plans retain an external immutable target; they do not contain or reopen an
implementation task.
If factory synchronization fails after task completion, recover with `foundry_sync_factory`;
the persisted attempt is the outbox, so never rerun the child to repair a receipt.
New work requires the current portable knowledge head. A divergent branch does not
authorize more dispatch, but existing owned attempts can still report results or
cancel against their pinned execution history.

If the App renames a branch after attachment, do not restore it with raw Git or replace the
attached session. Inspect the same App session's actual branch and canonical worktree path,
then call `foundry_attach_task` with the original session ID, current revision and new branch,
plus `rename: { fromBranch, worktreePath, actor, reason }`. This explicit reconciliation requires
an absent old ref, a direct post-attachment rename in the latest 256 Git reflog entries and the
same registered repository. Existing verifier or prior-reconciliation worktree pins cannot change;
a pinned detached verifier is supported if the new branch is not checked out elsewhere.
Session association remains a claim, not authenticated attestation. Missing evidence, unsupported
hosts or terminal/cancelling attempts remain blockers. Re-read state on conflicts; never edit
stored attempts or weaken completion's branch checks to bypass a mismatch.
