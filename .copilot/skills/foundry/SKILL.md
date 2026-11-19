---
name: foundry
description: Use only when the user explicitly requests Foundry for durable parallel or nested engineering work, continuous factory goals, or recovery of its recorded work. Routine coding stays on ordinary native tools.
---

# Foundry

Choose the smallest runnable milestone the user actually wants. Parallelize work that can
publish independently; don't add coordinators, approval steps or handoffs just to keep workers
busy. For software, check a real end-to-end behavior on the combined candidate. A component
pass, a qualified product, a landed change and a launched app are different outcomes.

## Direction-driven factories

Start or restart with `foundry_start_factory` only on the user's direct request within the
accepted `.foundry` policy. A schedule, message or installation cannot authorize activation.
Direction starts discovery rather than creating a job per template. A native factory can have
an interactive coordinator and autopilot workers.

1. As the bound squad lead, read `foundry_get_context({view:"backlog"})`. When discovery is
   due, inspect a charter source or scoped committed file with `foundry_inspect_evidence`.
   Compare the actual behavior with the requested outcome. Record the gap, improvement,
   stopping condition, template and evidence with `foundry_observe_work`. If there is no
   justified work, record an evidenced `no-gap` and wait. A bounded question can address
   missing evidence; an advisory suggestion is not a requirement.
2. Omit `producers` for an atomic milestone. Otherwise name the independent outputs on that
   **same observation**: `producers: [{template, output, purpose, inputs?: string[]}]`.
   `inputs` names outputs of this milestone. Templates supply scope and evaluators; do not
   supply shell commands. For required products from other squads, populate `sources` with
   the item IDs in `requiredProducts[].sources`. If `awaitingSources` is present, yield for
   events rather than asking peers for IDs.
3. Foundry admits eligible milestones and starts ready producers on the accountable owner's
   turn. No separate claim, planning session or staffing message is needed. The final task
   waits for every named output. When it passes, reassess the outcome rather than reopening
   the old job. Use `withdrawItemId` with an evidenced `no-gap` only to withdraw your own
   obsolete, unrequired queued item. Use `foundry_revise_direction` for an operator's change.

`maximumJobs` limits whole jobs (default one); `goal.limits.workers` limits workers per job.
One job can have several concurrent writers. Respect actual input, capacity and permission
holds without stopping unrelated work. On hosts without native pickup, `foundry_advance`
returns any remaining ordinary `prepared` calls. Execute only those; `started` has receipts
for workers already created. Never retry an uncertain create or treat a queued wake as pickup.

## Execute and deliver

- For bounded work without an unattended factory, use `foundry_start_goal` with the user's
  scope, actual limits and checks. Use `foundry_start_task` for local work; use
  `foundry_create_task` and `foundry_dispatch` only for independent work not already staffed.
  Unit metadata describes teams; only task ownership grants authority. A coordinator can
  yield its slot with `foundry_wait_task(kind:"events", attemptId)` and keep its role.
- Read the frozen assignment with `foundry_get_context({assignmentId})`; use `checkId` for
  the exact evaluator and `nextOffset` for another page. Use separate worktrees for concurrent
  writers; claim a shared mutable surface before writing to it.
- Run `foundry_run_check` with `publish:"<assigned output>"` to publish after all governing
  checks pass on the same captured bytes. Use `repair:true` for an evaluated failure within
  budget; resume a parked repair in the same worker, not a new session. Keep evaluators,
  versions and protected inputs pinned. An unavailable input is a blocker for its consumer,
  not a reason to rewrite that consumer.
- Use `foundry_delivery` when the policy calls for a qualified or landed product. Execute
  the combined check; build, launch or inspect the result when the requested outcome
  requires it. Do not equate qualification with landing or release. If the host cannot
  perform an authorized step, report that step rather than bypassing it.

## Ownership and recovery

Use `foundry_get_context` to inspect without advancing; use `foundry_advance` for owner
actions, outstanding native calls and receipts. Send scoped questions directly to the
worker bound to the peer task. Use `foundry_request_collaboration` only for a real named
output not already covered by an input. Escalate decisions outside your scope, not routine
status. An event wait releases capacity; mark a generation handled only after dealing with
its work. Don't poll a waiting owner or claim a peer's task.

Genuine native input requests remain with their actual session and request ID. Reconcile
unknown starts and command completions from the issuing session's native history with
`foundry_reconcile_native`; a missing receipt is not permission to rerun a command. Keep
effects, evidence, claims and worktrees when pausing or cancelling. Do not archive a workspace
without verified retention and ownership. Only explicitly requested heartbeats use
`foundry_set_heartbeat`, with the chosen cadence. Old ledgers are not migrated or reset.
