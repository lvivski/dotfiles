# Foundry

Foundry is the Copilot extension control plane for native Agent Factories and dependency-aware
engineering plans across App-native project sessions. It owns the plan state machine, task attempts,
reservations, evidence, approvals, recovery, cancellation, and final Factory verdict. App sessions
own repository work.

The extension also registers the independent `audit`, `deep-research`, `review-queue`,
`security-review`, and `triage` factories. They use the native Factory lifecycle directly and do not
participate in Foundry plan state.

## Plan shape

A plan contains:

- one or more `implement` tasks;
- exactly one final `verify` task;
- one dependency path from every implementation task into the verifier's single implementation
  dependency.

The final implementation task must deliver a full commit or PR. The verifier is an ordinary Foundry
task with `deliveryRequirement: "commit"`, no authored files, and no authored acceptance criteria.
It reuses the same reservation, session attachment, retry, cancellation, and projection machinery
as implementation tasks.

## Planning

1. Call `foundry_prepare_plan`.
2. Run its exact `launchSpec` with `run_factory`.
3. Import the completed run with `foundry_create_plan`.
4. Submit the draft and obtain explicit plan approval.
5. Activate the plan to enable coordinator context and conservative hooks.

`maxTasks` counts implementation tasks; the planning Factory adds the verifier task.

## Task delivery

For every ready task:

1. Call `foundry_reserve_task` before `create_session`.
2. Create the App child session from the returned `baseBranch` and unchanged
   `delegationPrompt`.
3. Attach the returned session with `foundry_attach_task`.
4. Record `done`, `failed`, or `blocked` with `foundry_complete_task`.
5. Retry terminal failures explicitly with `foundry_retry_task`.

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

Foundry canonicalizes verifier evidence by `checkId`, rejects missing/extra/duplicate checks, stamps it
as `independent-claim`, and records the verifier's final observed commit in the normal attempt
`commit` field. Failed checks still produce a successful verifier report (`task.status: done`); the
Factory turns those failures into an attributed correction wave.

## Final Factory verification

After every task is done:

1. Call `foundry_prepare_verification` with a stable reservation ID.
2. Run the exact `verify` launch specification once.
3. Import the authoritative terminal result with `foundry_complete_verification`.
4. Request explicit completion approval after a pass.

Task-owner evidence is context only. A pass requires the verifier's observed commit to match the
target commit and every canonical verifier check to pass. Evidence remains reported data, not
cryptographic attestation.

## Cancellation and recovery

`foundry_cancel` snapshots every active task attempt and any verification Factory run. The
coordinator stops or archives the listed App sessions, calls `foundry_cancel_verification_run`, then
calls `foundry_finalize_cancellation` with exact dispositions and a fresh complete session inventory.

Plans use optimistic revisions, atomic file replacement, strict validation, stale-lock recovery, and
deterministic recovery projections. Invalid artifacts are reported and never overwritten.

## Tool surface

| Area | Tools |
| --- | --- |
| Planning | `foundry_prepare_plan`, `foundry_create_plan`, `foundry_submit_plan`, `foundry_approve_plan` |
| Inspection | `foundry_get_plan`, `foundry_get_status`, `foundry_list_plans` |
| Tasks | `foundry_next_tasks`, `foundry_reserve_task`, `foundry_attach_task`, `foundry_complete_task`, `foundry_retry_task` |
| Verification | `foundry_prepare_verification`, `foundry_complete_verification` |
| Cancellation | `foundry_cancel`, `foundry_cancel_verification_run`, `foundry_finalize_cancellation` |
| Hooks | `foundry_activate_plan`, `foundry_deactivate_plan` |

## Validation

```sh
node --test .copilot/extensions/foundry/*.test.mjs
```
