# Recovery

Read before resuming uncertain work, repairing activation or plan artifacts, or replacing an
unusable verification run.

1. If activation state is unreadable, call `foundry_deactivate_plan`; it removes the invalid record
   and reports `repaired: true`.
2. If `foundry_list_plans` reports an invalid stored plan, show its validation details. Call
   `foundry_quarantine_plan` only after explicit user approval, with the user's identity and reason.
   Quarantine preserves the original document and attribution in SQLite while releasing the plan ID.
3. Enumerate App sessions and inspect every session attached to an active attempt.
4. Call `foundry_get_status` with the causally current inventory.
5. Follow the first safe projected action. Missing sessions remain `unknown` unless the supplied
   inventory is exhaustive and newer than the attempt.
6. Resolve stale reservations explicitly as blocked attempts, then retry; never expire or replace
   them silently.
7. Inspect paused or failed runs with `dynamic_workflows_manage` (`inspect-run`), or include native
   state in `foundry_get_status` with `includeWorkflows: true`. After the user asks to continue,
   use `foundry_control_workflow` with `action: "resume"` and the same `runId`. Verification controls
   require `planId` and `expectedRevision`, and reject non-authoritative runs or cancelling plans.
   Eligibility comes from native `canResume`, not status alone. A paused run retains its reservation
   until explicitly cancelled. Replace a terminal non-importable verification run only with an
   attributed reason and actor.

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
