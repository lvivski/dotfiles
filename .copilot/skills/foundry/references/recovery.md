# Recovery

Read before resuming uncertain work, repairing activation or plan artifacts, or replacing an
unusable verification run.

1. If activation state is unreadable, call `foundry_deactivate_plan`; it removes the invalid marker
   and reports `repaired: true`.
2. If `foundry_list_plans` reports an unreadable artifact, show its validation details. Call
   `foundry_quarantine_plan` only after explicit user approval, with the user's identity and reason.
   Quarantine preserves the original artifact under a hidden filename while releasing the plan ID.
3. Enumerate App sessions and inspect every session attached to an active attempt.
4. Call `foundry_get_status` with the causally current inventory.
5. Follow the first safe projected action. Missing sessions remain `unknown` unless the supplied
   inventory is exhaustive and newer than the attempt.
6. Resolve stale reservations explicitly as blocked attempts, then retry; never expire or replace
   them silently.
7. Inspect paused or failed runs with `factories_manage` (`inspect-run`). After the user asks to
   continue, use native `canResume` and `run_factory({ resumeFromRunId: "<run-id>" })`; never
   infer eligibility from status alone. A paused run retains its reservation until explicitly
   cancelled. Replace a terminal non-importable verification run only with an attributed reason
   and actor.
