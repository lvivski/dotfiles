# Mobius

Mobius coordinates a dependency-aware engineering plan across App-native project sessions. It owns
the plan state machine, task attempts, reservations, evidence, approvals, recovery, cancellation,
and final Factory verdict. App sessions own repository work.

## Plan shape

A plan contains:

- one or more `implement` tasks;
- exactly one final `verify` task;
- one dependency path from every implementation task into the verifier's single implementation
  dependency.

The final implementation task must deliver a full commit or PR. The verifier is an ordinary Mobius
task with `deliveryRequirement: "commit"`, no authored files, and no authored acceptance criteria.
It reuses the same reservation, session attachment, retry, cancellation, and projection machinery
as implementation tasks.

## Planning

1. Call `mobius_prepare_plan`.
2. Run its exact `launchSpec` with `run_factory`.
3. Import the completed run with `mobius_create_plan`.
4. Submit the draft and obtain explicit plan approval.
5. Activate the plan to enable coordinator context and conservative hooks.

`maxTasks` counts implementation tasks; the planning Factory adds the verifier task.

## Task delivery

For every ready task:

1. Call `mobius_reserve_task` before `create_session`.
2. Create the App child session from the returned `baseBranch` and unchanged
   `delegationPrompt`.
3. Attach the returned session with `mobius_attach_task`.
4. Record `done`, `failed`, or `blocked` with `mobius_complete_task`.
5. Retry terminal failures explicitly with `mobius_retry_task`.

Delivery requirements are:

- `branch`: attached branch;
- `commit`: branch plus a full 40- or 64-character commit;
- `pr`: full commit plus an HTTP(S) PR URL.

Attached failed or blocked attempts require a complete, causally newer App session inventory proving
that their session is terminal. This prevents a retry from orphaning a still-running child.

## Verifier task

The verifier prompt is read-only and binds to its dependency's exact commit. It returns one evidence
record per canonical `checkId`:

- every implementation criterion (`T-001-C001`, and so on);
- `final-integration`;
- `workspace-integrity`.

Mobius canonicalizes verifier evidence by `checkId`, rejects missing/extra/duplicate checks, stamps it
as `independent-claim`, and records the verifier's final observed commit in the normal attempt
`commit` field. Failed checks still produce a successful verifier report (`task.status: done`); the
Factory turns those failures into an attributed correction wave.

## Final Factory verification

After every task is done:

1. Call `mobius_prepare_verification` with a stable reservation ID.
2. Run the exact `mobius-verify` launch specification once.
3. Import the authoritative terminal result with `mobius_complete_verification`.
4. Request explicit completion approval after a pass.

Task-owner evidence is context only. A pass requires the verifier's observed commit to match the
target commit and every canonical verifier check to pass. Evidence remains reported data, not
cryptographic attestation.

## Cancellation and recovery

`mobius_cancel` snapshots every active task attempt and any verification Factory run. The
coordinator stops or archives the listed App sessions, calls `mobius_cancel_verification_run`, then
calls `mobius_finalize_cancellation` with exact dispositions and a fresh complete session inventory.

Plans use optimistic revisions, atomic file replacement, strict validation, stale-lock recovery, and
deterministic recovery projections. Invalid artifacts are reported and never overwritten.

## Tool surface

| Area | Tools |
| --- | --- |
| Planning | `mobius_prepare_plan`, `mobius_create_plan`, `mobius_submit_plan`, `mobius_approve_plan` |
| Inspection | `mobius_get_plan`, `mobius_get_status`, `mobius_list_plans` |
| Tasks | `mobius_next_tasks`, `mobius_reserve_task`, `mobius_attach_task`, `mobius_complete_task`, `mobius_retry_task` |
| Verification | `mobius_prepare_verification`, `mobius_complete_verification` |
| Cancellation | `mobius_cancel`, `mobius_cancel_verification_run`, `mobius_finalize_cancellation` |
| Hooks | `mobius_activate_plan`, `mobius_deactivate_plan` |

## Validation

```sh
node --test .copilot/extensions/mobius/*.test.mjs
```
