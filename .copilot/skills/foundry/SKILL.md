---
name: foundry
description: Use only when the user explicitly requests Foundry for durable parallel or nested engineering work, continuous factory goals, or recovery of its recorded work. Routine coding stays on ordinary native tools.
---

# Foundry

Foundry is a repository-local software factory, not an approval workflow. Native sessions,
local coordinators, in-session work and deterministic jobs execute; one SQLite store at
`<git-common-dir>/foundry/work.sqlite` records goals, ownership, versions, effects and outcomes.
No old operational database is opened or migrated.

## Execute

1. Establish the user's actual goal, allowed work types, repository paths, restrictions,
   delegation and execution mode with `foundry_start_goal`. Supply only limits the user or
   native runtime actually specified. An accepted `.foundry` source contract compiles without
   model planning. Do not introduce a mandatory discovery or review pipeline.
2. Create useful units with `foundry_create_task`; record a persistent native child or job when
   it needs independent admission, shared-write ownership or recovery. Give children their
   parent task and only narrowing scope overrides; restrictions inherit automatically.
   Teams are open-ended, not a fixed list of departments.
3. Use `foundry_prepare_dispatch` for native children. Execute independent returned
   `create_session` calls concurrently, preserving their complete kickoff and explicit mode.
   `autopilot` executes authorized autonomous work; `interactive` preserves narrower supervision.
   Never default executing children to `plan`, demand a readiness acknowledgment, or send an
   activation. Native pre/post hooks record issuance and returned identity without another
   model turn. A token/name correlates an attempt; it is not authority.
4. Use `foundry_start_task` for work in the current native session or a deterministic job rather
   than creating an unnecessary model session. Lightweight subagents remain part of that
   attempt unless they cross the independent-record boundary. Never multiply a goal budget
   at each delegation level.
5. Retrieve only relevant `foundry_get_context`. If `refreshRequired` is true, read the changed
   context again: a concurrent update was not covered, not a request to poll. Ownership is
   parent-local. A parent may delegate
   further while its parent finishes bookkeeping. An early ownership-specific mutation can
   reconcile actual `get_session` metadata inline; ordinary assignment work does not stop.
   Use separate native worktrees for concurrent writers and claim actual shared integration
   surfaces/resources with `foundry_claim`. Goal/coordinator context summarizes procedures;
   request the assigned `taskId` for its complete executable definition.
6. Every governing check, including artifact/judgment checks, needs an executable procedure;
   presence or unsupported opinion does not pass implicitly. Execute assigned procedures
   with `foundry_run_check`, normally using `repair: true`. Its assigned command goes through the
   ordinary native permission pipeline; a checked failure records evidence and reserves
   a fresh same-worker attempt atomically under that goal's limits. Implement the repair next using the returned attempt,
   without a report/retry/start chain or an activation. Honest capacity/limit waits remain explicit.
   A capacity-parked repair stays reserved for you: use `foundry_start_task` or replay the exact
   report after its capacity wake, not a new session. Immediate warm repairs need no parent notification.
   Use `foundry_prepare_check` only for separate advanced command handling.
   Evaluators and inputs stay pinned to the attempt. Report outcomes and named,
   versioned outputs with `foundry_report_result`. Concrete checked failures can justify repair;
   unsupported review opinions remain advisory. Completion does not need another plan approval.

For a bounded reproducible file unit, give every relevant check the same `artifactFiles` list of
existing implementation files inside its task paths, with required module/package files included.
Pin evaluator files separately with repository-relative `oracleFiles`. Those checks run in a captured
bundle; the mutable checkout is not their execution directory. Report code/artifact outputs using
the actual returned `evidence.candidate.version`, with its reference for the unit or a declared
filename for an entry. Do not substitute a newer checkout or combine passing checks from different
candidate versions. Integration declares and evaluates its final unit too. This opt-in format
does not pin undeclared runtime/data dependencies or require commits. Legacy checks remain unchanged.
When publication of the evaluated unit is intended, use `publish: "<output name>"` on
`foundry_run_check`. It uses the normal promotion path once all governing checks pass on the same
candidate, without another model turn. Partial acceptance keeps work running; mixed candidates
block publication without inventing a failed check. Already-published replay does not rerun.
An unavailable/corrupt managed input is a recorded blocker, not a reason to keep recoding its
consumer; route the actual failed input identity to its accountable owner.

## Continue locally

Parents integrate declared child outputs. Only real named-output prerequisites serialize work;
delegation edges do not. Record genuine native input pauses with their actual request IDs using
`foundry_wait_task`, without duplicating the question. A solely waiting parent releases capacity
only after substantive commands settle; `foundry_resume_task` reacquires through the same per-goal allocator.
Unrelated ready goals never block an admission with available capacity.
Evolution preserves a retired attempt's genuine pending request without holding the graph hostage.
Do not answer or withdraw it by changing a task; explicit native clearance resolves its record.
When multiple local attempts execute, use `foundry_prepare_command` for an ordinary command's exact
unit affinity. Otherwise a shared command retains all possible units until its actual settlement.

Deliver coalesced wakes to **current** owners and process self-directed work locally. Native queue
acceptance is not execution. Use bounded initial idle notifications (`once`), then explicit
milestone/blocker/output reporting to local parents; never relay every leaf turn to the director.
Reporting/publication does not wait for message delivery. If context reports a disabled native
session-management route, use its returned ordinary `send_session_message` wake/stop arguments;
mark only a genuinely accepted wake generation with `foundry_mark_wake_sent`. Do not retry the
blocked extension route, change host policy or replay an uncertain delivery.
Actual command completion and stopped-shell receipts also drain affected-goal notifications
automatically. This covers live settlement, not recovery of a dead session or independent watchdog.
Use `foundry_record_signal` for scoped production, security, design, review or performance feedback.
Use `foundry_evolve_task` with the affected task's current version for concrete in-scope input or
derived-check changes. It preserves user/contract/standing obligations, retires superseded attempts
and reevaluates only unpinned dependents. Explicitly pinned published inputs retain their meanings.
Propagation stops at producers without published outputs, avoiding revision churn during setup.
Signals alone do not change requirements or dispatch a speculative repair.
Signals target accountable coordinators. Use `foundry_reassign_team` to retain a charter and its
delegated leaves through coordinator replacement; unknown recipients are verified once natively.
Charters organize existing scoped tasks, not new root-level authority for a leaf. Add work through
the goal owner or an existing delegating task in the canonical tree.
Pure notification bookkeeping needs no executing attempt. Known unavailable recipients wake an
existing accountable ancestor, not an automatically appointed replacement.
Preserve reproducible procedures, versioned authorized inputs, parameters and raw results for
analyses; a disproved hypothesis can be a completed result. Curate concise evidenced lessons by
goal/work type with `foundry_record_lesson`, not global prohibitions or full-history prompts.

## Recover without replay

Keep the actual native result if its shape needs reconciliation. `foundry_reconcile_native`
inspects the actual session ID and recovers its known assignment; an issued-but-unbound call is
uncertain, not permission to create another child. A prepared, definitely unissued intent can
resume only after retiring its previous dispatch owner.
Original session inspection preserves already-bound history without replacing a newer warm attempt.
An existing worker can recover its actual outstanding shells and yield or resume its current
execution after coordinator handoff; it does not acquire new delegation authority.

Checked repair normally uses `repair: true` on `foundry_run_check` or `foundry_report_result`.
New assigned commands have one exclusively claimed, atomically finished runner receipt. Your
normal context/check calls recover finished receipts without rerunning, retaining their
`runner-receipt` source and assigned evidence checks. A recovered check replays its result; use
`foundry_prepare_check` for an explicit new evaluation. Started-only receipts, legacy random-name
receipts and ordinary commands without actual completion remain unknown; never manufacture settlement.
Self-ended settled terminal claims release automatically. Waiting/unknown work and ancestor-ended
attempts keep ownership; warm same-worker repair transfers claims atomically with fresh IDs.
Separate advanced retries use `foundry_retry_task` against the exact current failed attempt.
Both retain history, produce a fresh token and preserve replacement coordinator ownership.
Evolution and dispatch handoff do not consume the repair allowance.
Cancelled or superseded outcomes remain history: they cannot publish current outputs, unblock
consumers, release newer claims or create a duplicate repair.

`foundry_cancel_task` cancels the recorded subtree and schedules cooperative stops directly to
known descendants. A stop message does not prove a command stopped.
Stop shells only in their actual executing native session; coordinators send affected workers
attempt-specific cooperative notices. Settled finished attempts need no stop; a definitely
unavailable recipient is recorded rather than repeatedly messaged.
Preserve unresolved effects, claims, worktrees and artifacts; never archive as routine cancellation or demand a whole-factory
terminal inventory. Reassign only under existing subtree authority or a genuine native user
decision. Native permissions and actual user-message provenance cannot be manufactured by records.

Native AI credits are ingested automatically with stable receipt identities and request-start
affinity. Do not manually repeat observed receipts. If a separate manual observation is necessary,
use its actual native event ID or returned receipt ID rather than inventing an alias.
Missing billing and unobserved restart/history gaps remain explicit; a null reported subtotal
does not mean zero. Cross-goal ambiguity stays unallocated rather than inventing a split.
Goal context reports scoped receipts and correlated ambiguity, not unrelated lifetime session spend.
Idle turns have one persisted boundary; they do not keep charging the previous completed assignment.
Recorded-worker limits do not control every hidden model call/process. Do not substitute token estimates, refund spending or describe post-hoc
accounting as a hard ceiling. Report missing hard-limit support specifically.
