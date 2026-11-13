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
