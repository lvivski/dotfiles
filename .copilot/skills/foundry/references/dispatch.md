# Task dispatch

Read before dispatching ready work or recording an attempt's result.

1. Call `foundry_next_tasks`.
2. Dispatch only IDs in `dispatchableTaskIds`. An overlapping task needs a user-attributed
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
