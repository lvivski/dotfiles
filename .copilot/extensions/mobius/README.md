# Mobius

Mobius is a user-scoped Copilot extension for reviewed, dependency-aware
engineering plans. This dotfiles copy syncs to `~/.copilot/extensions/mobius`,
including its pinned Conveyor planning and verification scripts.

Mobius owns strict plan semantics, approvals, attempts, evidence, cancellation
state, and the live board. Conveyor owns durable analysis. The foreground
Copilot App session coordinates native child project sessions.

## Boundary

- **Mobius:** validates every transition and persists revision-checked session
  artifacts.
- **Conveyor:** runs only the pinned, restricted `plan.mjs` and `verify.mjs`
  workflows.
- **Foreground coordinator:** previews and launches Conveyor, creates and
  archives App sessions, records results, and confirms external termination.
- **Child project sessions:** own repository mutation in App-managed worktrees.

Mobius never launches sessions, invokes shell commands, manages worktrees,
stops external processes, or accepts a coordinator-supplied verification
verdict.

## Planning

1. Call `mobius_prepare_plan` with the objective, constraints, repository
   context, and optional task limit.
2. Preview its exact `launchSpec` with Conveyor using `dryRun: true`.
3. Launch the immutable preview plan.
4. Review the completed Conveyor result.
5. Call `mobius_create_plan` with a stable plan ID, `expectedRevision: 0`, the
   completed run ID, and repository identity.
6. Submit and explicitly approve the plan.

Mobius independently verifies the persisted script hash, arguments, limits,
restrictions, result shape, critic perspectives, and final planning verdict.
Project-local scripts cannot shadow the bundled absolute path.

## Coordinating implementation

The task lifecycle deliberately reserves state before the external App side
effect:

1. Optionally activate the plan with `mobius_activate_plan`.
2. Call `mobius_next_tasks`.
3. For one `dispatchableTaskId`, call `mobius_reserve_task` with a stable
   `reservationId`.
4. Use the returned `baseBranch` as `create_session.base_branch` and pass the
   returned `delegationPrompt` unchanged.
5. Immediately call `mobius_attach_task` with the returned App session ID.
6. When the child finishes, call `mobius_complete_task` with the exact
   `attemptId`, result, delivery metadata, and typed evidence.
7. Record the result before displaying it or launching newly-unblocked work.

Reservation and identical attachment are idempotent. If the coordinator loses
the response from `create_session`, the durable reserved attempt remains
visible and can be attached after the session is rediscovered. A session ID
cannot be attached to two attempts.

### Attempts

Attempts are append-only and use deterministic IDs such as `T-001-A001`.
Retries never erase old sessions, branches, commits, PRs, evidence, errors, or
timestamps.

Attempt states are:

- `reserved`
- `running`
- `done`
- `blocked`
- `failed`
- `cancel-requested`
- `cancelled`

A task is `running` whenever it owns the sole nonterminal attempt, including a
reserved attempt awaiting `create_session`. `blocked` is a terminal attempt
outcome. A downstream task waiting on failed dependency work remains `planned`;
it becomes ready automatically after the dependency succeeds on a later
attempt.

### Dependency delivery

Every successful attempt records its branch and optional commit and PR.
Mobius derives the next attempt's base deterministically:

- no dependency delivery: the plan base branch;
- one distinct dependency branch: that branch;
- several distinct dependency branches: the first dependency branch in task-ID
  order, with the remaining deliveries listed as `integrationRequired`.

The dependent task owns that integration. It cannot complete successfully
without passed `integration` evidence when additional deliveries were listed.
Mobius does not claim branches are merged because it has no authoritative PR or
Git observer.

### Scope overlap

Reserved attempts occupy their declared file scopes before a child session
exists. Overlap is rejected unless `mobius_reserve_task` receives an auditable
`scopeOverride` containing the approving actor and reason.

## Evidence

Task evidence is structured and bounded:

```json
{
  "type": "test",
  "summary": "All 42 tests passed",
  "source": "node --test",
  "outcome": "passed"
}
```

Supported types are `command`, `test`, `integration`, `commit`, `pr`,
`session`, `artifact`, and `manual`. Mobius assigns deterministic evidence IDs
such as `T-001-A001-E001`, the producer session, and `trust: "claimed"`.

The caller cannot assign evidence IDs, producer identity, or a stronger trust
classification. `claimed` is provenance, not proof. The restricted verifier
treats every record as untrusted and may reference only canonical evidence IDs.

## Verification and correction

1. Call `mobius_prepare_verification` after every task is done, passing the
   current revision and a stable verification `reservationId`. This mutation
   persists before returning the launch spec.
2. Preview and launch the pinned Conveyor spec.
3. Bind the run with `mobius_begin_verification`, passing the same reservation.
4. Import it with `mobius_complete_verification`.
5. Approve completion explicitly after a passing result.

The verifier maps every stable criterion ID, such as `T-001-C001`, to canonical
evidence IDs. Unknown IDs do not count as coverage.

Failed verification records `correctionTaskIds`. On explicit plan retry,
Mobius reopens those tasks and every transitive descendant while retaining all
prior attempts. Unattributed or malformed failure attribution reopens every
task. New attempts must provide the evidence for the next verification cycle.

## Cancellation

Cancellation is two-phase because Mobius cannot stop App sessions itself.

1. Call `mobius_cancel` with a stable `requestId`, `requestedBy`, and reason.
2. The plan enters `cancelling`, snapshots active attempt IDs plus any reserved
   or bound verification launch, and marks active attempts `cancel-requested`.
3. Wait for every in-flight `create_session` call to settle. Attach any session
   that was created after the cancellation request.
4. Stop or archive every listed App session with native App tools.
5. Wait for any in-flight Conveyor launch to settle. Bind the returned run to
   the snapshotted verification reservation, or confirm that no run was
   created.
6. Cancel a bound Conveyor run with Conveyor controls.
7. Call `mobius_finalize_cancellation` with one exact disposition per
   snapshotted attempt plus `run-terminated` or `no-run-created` for a
   snapshotted verification reservation.

An attached attempt requires `session-terminated` with the matching session ID.
An unattached reservation requires `no-session-created`. Mobius independently
checks that a bound Conveyor run is terminal. App termination remains an
explicit coordinator acknowledgement because the extension has no privileged
session-liveness API.

The final plan artifact retains every acknowledgement, actor, and timestamp.

## Recovery projection

`mobius_get_status` returns:

```text
{ plan, projection }
```

The projection is derived, never persisted. It contains progress, active
attempts, dependency waits, ordered available actions, and one deterministic
`nextAction`.

Callers may provide a host session inventory:

```json
{
  "complete": true,
  "capturedAt": "2026-08-06T12:00:00.000Z",
  "sessions": [{ "id": "session-id", "status": "idle" }]
}
```

Mobius reports a recorded session as absent only when `complete` is true.
Omitted or partial inventories produce `unknown`, never a false orphan.

## Tool surface

| Tool | Purpose |
|---|---|
| `mobius_prepare_plan` | Build the pinned restricted planning launch spec. |
| `mobius_create_plan` | Import a completed planning run as a draft. |
| `mobius_get_plan` | Read the validated authoritative artifact. |
| `mobius_get_status` | Read the plan plus its derived recovery projection. |
| `mobius_list_plans` | List bounded plan summaries. |
| `mobius_submit_plan` | Request plan approval. |
| `mobius_approve_plan` | Approve plan, correction retry, or completion. |
| `mobius_next_tasks` | Return ready work, delivery guidance, and scope holds. |
| `mobius_reserve_task` | Persist an attempt before creating an App session. |
| `mobius_attach_task` | Attach the App session to its reserved attempt. |
| `mobius_complete_task` | Record the attempt result and claimed evidence. |
| `mobius_retry_task` | Make failed or blocked work ready for a fresh attempt. |
| `mobius_prepare_verification` | Persist a launch reservation, then return canonical evidence input and launch spec. |
| `mobius_begin_verification` | Bind a validated Conveyor run. |
| `mobius_complete_verification` | Import the exact persisted verdict. |
| `mobius_cancel` | Request cancellation and snapshot external work. |
| `mobius_finalize_cancellation` | Finalize after external termination. |
| `mobius_activate_plan` / `mobius_deactivate_plan` | Toggle coordinator hooks. |

Every mutation requires the expected revision. Read again after conflicts.

## Canvas

Open `mobius-board` with:

```json
{ "planId": "plan-short-id" }
```

The board loads by stable plan ID and survives extension reload. It shows
planning provenance, progress, attempts, sessions, delivery, typed evidence,
verification, correction tasks, cancellation requirements, and recovery
actions.

Canvas cancellation only requests cancellation. It never presents a request as
completed external termination.

## State and storage

Plans live at:

```text
<session.workspacePath>/files/mobius/<plan-id>.json
```

The optional activation marker is:

```text
<session.workspacePath>/files/mobius/.active-plan.json
```

Mobius validates complete documents, rejects symlink escapes, serializes
multi-process writers, heartbeats ownership locks, atomically replaces
artifacts, and preserves invalid existing JSON.

Conveyor persists run identity, source, arguments, budgets, checkpoints,
activity, and results under its own run directory. Mobius imports through
Conveyor's versioned read-only API.

## Coordinator restraint and guardrails

Hooks are inert until `mobius_activate_plan`. While active they:

- inject the reserve-before-create and attach contract;
- prohibit duplicate child implementation and undeclared DAG expansion;
- allow intervention for explicit steering, cancellation, stuck work, or child
  requests;
- deny destructive Git reset/clean and broad recursive deletion;
- deny obvious file-tool writes outside the coordinator workspace;
- keep state-changing Mobius calls under normal permission handling.

These are coordinator guardrails, not a shell sandbox.

## Deliberate exclusions

Mobius has no daemon, SQLite scheduler, polling loop, runtime adapter,
persistent named personas, global team memory, Git-notes state backend,
worktree ownership, automatic PR merge, or cross-repository transaction.

Minions and Squad informed the design, but Mobius does not import, call, embed,
modify, or depend on either project.

## Development

All hand-authored production JavaScript in the extension uses JSDoc for module
boundaries, named callables, and exported contracts. Bundled Conveyor workflow
scripts are excluded because their executable schemas and prompts are the
runtime contract. `extension.test.mjs` enforces this documentation policy.

Run:

```bash
node --test .copilot/extensions/conveyor/runs.test.mjs \
  .copilot/extensions/mobius/*.test.mjs
```

When changing a bundled workflow, update its canonical-LF SHA-256 in
`scripts.mjs`. `copilot-extension.json` makes the extension share/install
compatible.
