# Recovery

Read before resuming uncertain work, repairing activation or plan artifacts, or replacing an
unusable verification run.

1. If activation state is unreadable, call `foundry_deactivate_plan`; it removes the invalid record
   and reports `repaired: true`.
2. If `foundry_list_plans` reports an invalid stored plan, show its validation details. Call
   `foundry_quarantine_plan` only after explicit user approval, with the user's identity and reason.
   Quarantine preserves the original document and attribution in SQLite while releasing the plan ID.
3. Enumerate App sessions and inspect every session attached to an active attempt, retained
   created-but-unattached child, in-flight admission and known supplemental activity.
4. Call `foundry_get_status` with the causally current inventory.
   For composed parallel work, caller inventory is not authority: the registered reconciliation path
   requires trusted current host observations.
5. Follow the first safe projected action. Missing sessions remain `unknown` unless the supplied
   inventory is exhaustive and newer than the attempt.
6. Resolve an unattached reservation as blocked only after definitive evidence that creation
   produced no worker. Any possible/existing child or uncertain admission retains its reservation,
   resource claims and receipts for reconciliation; never expire, replace or retry it blindly.
7. Inspect paused or failed runs with `dynamic_workflows_manage` (`inspect-run`), or include native
   state in `foundry_get_status` with `includeWorkflows: true`. After the user asks to continue,
   use `foundry_control_workflow` with `action: "resume"` and the same `runId`. Verification controls
   require `planId` and `expectedRevision`, and reject non-authoritative runs or cancelling plans.
   Eligibility comes from native `canResume`, not status alone. A paused run retains its reservation
   until explicitly cancelled. Replace a terminal non-importable verification run only with an
   attributed reason and actor.

For composed source, call `foundry_reconcile_parallel` with exactly `planId`, `taskId` and the retained
`reservationId` once per actual App notification or explicit authorized request. It reconciles the
existing admission, not a replacement; a DONE attempt can repair its durable delivery receipt, not
be reopened for fresh work. Host readers supply observations, never caller JSON. Preserve the
distinction between prepared, reserved, initialized,
attached, executing, delivered and independently verified; metadata, missing notifications and an
idle flag cannot advance stages. No polling timers or fabricated cross-child event subscription.
The admission owner alone settles/releases shared claims; recovery uses its fenced transitions,
not a second writer. Separate-store gaps and late native outcomes remain obligations.
During cancellation, reconciliation installs/reads the permanent owner/plan fence in shared
admission schema 3 before consuming native observations. Its census includes released history;
an empty active-attempt list is not proof of no owned work. A lost host callback cannot downgrade
even an empty retained plan fence to legacy writes. The admission owner migrates v1/v2; old cached
writers reject schema 3 and must restart, never clear the fence or overwrite the database.

For [original-owner corrections](dispatch.md#supplemental-original-owner-corrections), retain the
delivery hold until an explicit authorized correction decision and an existing supported current
reservation/attachment binding cover the original session/worktree, active integration attempt,
bounded paths/base/resources and authority. No such binding exists here. DONE history, previous
attachments and coordinator notes cannot authorize fresh work; do not reopen tasks or transfer scope.

Scope and dispatch holds apply to the target plan, not automatically to every plan in the repository.
An independent, explicitly approved new plan with distinct workers/worktrees and pinned immutable
inputs may proceed while an older plan remains unresolved. Activation selects context; it neither
closes the older plan nor releases its attempts. Preserve older attempts and evidence: do not reuse
the old worker or mutable branch, or treat failed/uncompleted results as successful delivery.
The new plan must still pass native provenance, approval, authority, synchronization and scope checks;
shared writable-resource conflicts remain blocking. Follow [dispatch](dispatch.md) and
[factory guidance](factory.md); creating a new plan is not a bypass.

For uncertain planning admission, follow the
[owner-local transport receipt protocol](planning.md#owner-local-large-payload-transport), not a
replacement launch. A completed `needs-review` plan with a delivery-contract conflict requires
revisiting [route selection](planning.md#choose-the-route-first); successful transport does not
authorize commits or make the plan importable. Preserve the failed report's original provenance.
The captured session-management failure applies to its extension RPC operation/route, not every
conceivable workflow/transport route. Primary App-path support is neither adapter support nor a
fallback grant. The default production parallel host remains unavailable; missing required host
capabilities retain a hold. For package consumption after restart, re-resolve immutable producer receipts and
corroborate the authorized consumer entry before materialization; persisted descriptors grant no authority.
This is a recovery requirement, not evidence that App-restart recovery or live permissions were tested.

## Completed planning repair

Local source provides bounded recovery for a completed registered `plan` result that is structurally
valid but `needs-review` solely on its original failed semantic verdict. The invoking owner must
retain the original canonical input, both complete critics and native run/agent observations.
An explicit `synthesisRepair: null` with no historical budget field is eligible; missing, malformed,
foreign, renamed/custom or already-repaired lineage is not. Current results must carry the same
original run ID and an unused budget. The native API observations corroborate identity; they do not
cryptographically attest recipe code or independently authenticate an agent's claims.

1. In the **original owning session**, call
   `foundry_prepare_plan_repair({ runId, repositoryPath })` with the original native run ID and exact
   canonical repository path. The operation reads the native result itself; never supply a saved
   result, critics, caller ownership or a fabricated budget. It rechecks current repository/capability/
   contract authority and returns `preparationId`, `preparationDigest`, state and unchanged `launchSpec`.
2. With the existing task/resource authority, call
   `foundry_launch_plan_repair({ preparationId, preparationDigest })` once. This durably records intent
   before invoking that exact stored `plan-repair` launch through the current session's offered
   `run_dynamic_workflow` tool and its ordinary native permission flow. Do **not** separately invoke
   the returned `launchSpec`, change its arguments/limits, or use another transport. If the route is
   unavailable, denied, malformed or uncertain, retain the claim and failure; never retry the launch.
3. If admission was uncertain, use
   `foundry_reconcile_plan_repair({ preparationId, preparationDigest })`. This reads a bounded native
   inventory and binds only a unique matching owner-native observation. Missing, conflicting,
   incomplete or ambiguous observations hold; tool-call correlation is not idempotency. Denial or an
   unavailable route cannot become a fresh permission through reconciliation.
4. After the distinct repair run completes `ready`, call
   `foundry_import_plan_repair({ preparationId, preparationDigest, id, repository, runId, expectedRevision: 0 })`,
   where `repository` is `{ workingDirectory: <the prepared canonical path>, baseBranch: <the intended base> }`
   and `runId` is the distinct repair run. Import rechecks the original native source, completed
   result, journal, owner and current authority. Negative or missing conservation review, stale
   authority or changed bytes cannot create a draft.
5. Submit the ordinary draft with `foundry_submit_plan` and obtain the exact named-revision approval
   through the normal [approval path](planning.md#app-planning-and-approval). Recovery neither approves
   nor activates a plan and grants no implementation, commit, merge or replacement permission.

The original result remains immutable. Preparation, original input/critics/verdict, admission
intent/outcomes, author candidate and conservation result are retained in the original owner's
`files/foundry/foundry.sqlite` plan database (schema 3, application ID `0x464e4452`), not the separate
shared-admission database. A root-run and canonical-input claim prevents structural repair, semantic
repair, replay, a fresh run ID or repair-only recovery from allocating another author allowance.
An interrupted author with no retained output remains held; a retained candidate may be reviewed
again on the same native run without regenerating it. A completed result replays without new agents.
No automatic retry, expiry, budget reset, schema migration or permission fallback is provided.

These are source-supported operations, not evidence that the current installed extension offers
them, that native permission has been granted, or that a live repair has run. Installation/reload,
live admission and plan approval remain separate actions. Do not modify the failed source or
rename a workflow to manufacture eligibility.

## Plan and capability storage

The current store starts fresh in `files/foundry/foundry.sqlite` in the session workspace.
Old JSON files and runs are not migrated or interpreted; leave them untouched. Use
`foundry_export_plan` and explicit `foundry_import_plan` for current-format interchange only.
Import does not launch work or activate coordination, and referenced external work must still
pass normal ownership checks.

Long-lived capability authority is separate, in repository-keyed per-user Foundry SQLite storage.
`foundry_get_factory` works from another session or sibling worktree without importing native run
ownership. Current-format `foundry_import_factory` requires an empty store of the same canonical
repository and replays immutable decisions; it does not activate plans or external runs.
If `factory_sync_pending` is reported, the attempt/plan mutation already committed. Inspect
`foundry_get_status.factory.synchronization`, resolve the precise storage error, and call
`foundry_sync_factory`. Synchronization is idempotent and uses exact persisted attempt/run identities.
Every pending learning/evaluation receipt is included, not just the automatic summary. Invalid
new reports are rejected before terminal persistence and can be corrected on the active attempt.
For older invalid terminal reports, cancellation records abandonment without requiring invalid
assurance publication; the report can remain non-governing learning.
Delayed valid receipts remain publishable as historical observations. Current assurance uses actual
observation time and stable execution/judgment identity, not append order or a renamed receipt.
Before retrying a failed evaluation plan, synchronize its prior terminal receipts. Retry/reservation
and owned synchronization restore conservative evaluation retirement holds; a historical completion
replay cannot clear a later active retry. Complete or explicitly abandon the current work to release it.

Current v2 authority upgrades non-destructively to physical SQLite schema 4. Old cached writers
must restart; there is no seal or logical JSON migration. Record/segment bounds replace the old
lifetime event ceiling so in-flight receipts and retirement can progress. Use pinned export pages
and staged import for histories above the single-JSON bound. Incomplete import data is not authority;
explicit abandonment retains the received staged history.
Historical v2 duplicate-origin receipts and their already-recorded acceptance decisions are preserved,
including decisions valid under the old publication-order rules. Current support is derived conservatively
from the original observation, and new publication/selection still enforce the strengthened rules.

Use `action: "pause"` only when the user asks to pause a native workflow; App child sessions are
unaffected. Resume retains the original limits and awaits the next settled attempt. For a reached
limit, obtain explicit approval and use `run_dynamic_workflow({ resumeFromRunId: "<run-id>", limits })`
to raise only that limit. Never resume during cancellation or treat a checkpoint as plan approval.
