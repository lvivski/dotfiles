# Task dispatch

Read before dispatching ready work or recording an attempt's result.

1. Call `foundry_get_status` and read `projection.scheduling`.
2. Dispatch only IDs in `projection.scheduling.dispatchableTaskIds`. Read its `launches` and
   `scopeConflicts` for delivery guidance and holds. Readiness is derived, not a stored task state.
   An overlapping task needs a user-attributed
   `scopeOverride`; never manufacture one.
3. Reserve each task with a unique stable `reservationId` and the current revision.
4. Resolve the current repository's App project, then call `create_session` with:
   - `base_branch` equal to the reservation's `baseBranch`;
   - `kickoff.prompt` equal to `delegationPrompt`;
   - coordination enabled and an idle notification requested.
5. Immediately attach the returned session ID and branch with `foundry_attach_task`.
6. If session creation fails after reservation, record the unattached attempt as `blocked`; retry
   only through `foundry_retry_task`.
7. Wait for idle notifications rather than polling. Intervene only for a child request, explicit
   steering, a stuck session, or cancellation.
8. Record `done`, `failed`, or `blocked` with the child result, branch, commit/PR when present, and
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
