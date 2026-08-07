# Mobius

Mobius is a dependency-aware engineering coordinator for Copilot sessions. It stores a validated plan
in the session workspace, dispatches one App-native child session per task attempt, records claimed
evidence, and gates completion through a native verification Factory.

## Runtime boundaries

- **Native Agent Factories:** `mobius-plan` creates and critiques a plan; `mobius-verify` reviews
  recorded evidence and produces the final verdict.
- **Mobius:** owns plan state, optimistic revisions, task dependencies, reservations, evidence,
  cancellation, recovery, hooks, and the board projection.
- **App sessions:** own repository mutation and task delivery.
- **Foreground coordinator:** invokes tools, creates child sessions, attaches their IDs, and records
  outcomes.

There is no separate Conveyor artifact or import protocol. Mobius registers its bundled scripts as
native factories and reads their native run envelopes.

## Planning

1. Call `mobius_prepare_plan`.
2. Run the returned `launchSpec` exactly with `run_factory`.
3. Review the completed Factory result.
4. Call `mobius_create_plan` with the Factory `runId`, a stable plan ID, repository identity, and
   `expectedRevision: 0`.
5. Submit and explicitly approve the plan.

Example launch specification:

```json
{
  "name": "mobius-plan",
  "args": {
    "objective": "Implement the feature",
    "constraints": [],
    "repositoryContext": "Repository summary",
    "maxTasks": 6,
    "inputDigest": "..."
  },
  "limits": {
    "maxConcurrentSubagents": 2,
    "maxTotalSubagents": 8,
    "timeoutSeconds": 300,
    "maxAiCredits": 20
  }
}
```

## Task delivery

1. Read dependency-ready work with `mobius_next_tasks`.
2. Reserve one task with `mobius_reserve_task` before creating a session.
3. Create the App child session using the returned base branch and delegation prompt.
4. Attach the resulting session with `mobius_attach_task`.
5. Record `done`, `failed`, or `blocked` with `mobius_complete_task`.
6. Retry eligible work explicitly with `mobius_retry_task`.

Reservations close the session-creation race. Attempts retain session, branch, commit, PR, summary,
and evidence provenance. Claimed evidence is untrusted input to verification, not proof by itself.

## Verification

After every task is done:

1. Call `mobius_prepare_verification` with a stable reservation ID.
2. Run the returned `mobius-verify` launch specification with `run_factory`.
3. Bind the native run with `mobius_begin_verification`.
4. Import its completed result with `mobius_complete_verification`.
5. If verification passes, explicitly approve completion.
6. If it fails, Mobius reopens attributed tasks and their dependants for a correction wave.

The verifier consumes canonical criterion IDs and evidence IDs. A passing result must cover every
criterion with passed evidence and contain no unresolved integration gap.

## Cancellation

`mobius_cancel` records a cancellation request and snapshots active task attempts plus the bound
Factory run. The coordinator must then:

1. Stop or archive every listed App session.
2. Cancel the listed Factory run through the native Factory API.
3. Supply exact attempt dispositions to `mobius_finalize_cancellation`.

Finalization succeeds only after every snapshotted attempt is resolved and any bound Factory run is
observed terminal.

## Persistence

Plans are stored under the Copilot session workspace with strict schema validation, atomic writes,
optimistic revisions, and stale-lock recovery. Invalid or unreadable artifacts are never overwritten.
Activation is session-local and enables conservative coordinator hooks.

## Tool surface

| Area | Tools |
| --- | --- |
| Planning | `mobius_prepare_plan`, `mobius_create_plan`, `mobius_submit_plan`, `mobius_approve_plan` |
| Inspection | `mobius_get_plan`, `mobius_get_status`, `mobius_list_plans` |
| Tasks | `mobius_next_tasks`, `mobius_reserve_task`, `mobius_attach_task`, `mobius_complete_task`, `mobius_retry_task` |
| Verification | `mobius_prepare_verification`, `mobius_begin_verification`, `mobius_complete_verification` |
| Cancellation | `mobius_cancel`, `mobius_finalize_cancellation` |
| Session hooks | `mobius_activate_plan`, `mobius_deactivate_plan` |

## Validation

```sh
node --test .copilot/extensions/conveyor/*.test.mjs
node --test .copilot/extensions/mobius/*.test.mjs
```
