---
name: foundry
description: Use only when the user explicitly requests Foundry for durable parallel or nested engineering work, continuous factory goals, or recovery of its recorded work. Routine coding stays on ordinary native tools.
---

# Foundry

Foundry is a repository-local software factory, not an approval workflow. Native sessions,
local coordinators, in-session work and deterministic jobs execute; one SQLite store at
`<git-common-dir>/foundry/work.sqlite` records goals, ownership, versions, effects and outcomes.
Current controller/completion metadata lives in that same canonical store; retired operational
formats are not imported. Mixed-version Foundry writers are unsupported; quiesce old participants
and reset obsolete canonical state before upgrading. Missing factory assignment snapshots, legacy
message effects and flat check receipts are not migrated or replayed. Current checks require their
exclusive finished runner receipts; current prepared native requests retain their identities.

## Running a squad from direction

With an active direction policy, each bound squad owns discovery and ordering within its charter.
On a wake, `foundry_advance` returns your `squadActions` with exact bindings. For direction and
evidence use `foundry_get_context({view:"backlog"})`; continue with `version` and `nextOffset` as `offset`.
Compare an assigned outcome with its actual product
behavior or consumer need. Use `foundry_inspect_evidence` for a charter source or scoped
committed file, then `foundry_observe_work` to record the gap, the improvement and how to tell
when it is done. A bounded question is useful when evidence is missing; advisory suggestions
are not requirements. With no justified gap, record an evidenced `no-gap` for the observed
generation. Yielding capacity or consuming a wake does not dispose of a review.
If pinned evidence makes a specific queued item obsolete, include `withdrawItemId` in
the `no-gap` observation. Do not start a pointless job or retire an item needed by a
consumer. A plain no-gap does not withdraw work. Directors: read `squadHandoffs` on
advance. For an unconfirmed send the issuing worker can advance its own originating
goal; never replay an uncertain send or interpret queue acceptance as pickup. A lead
that stops twice with the same due action surfaces a blocker instead of a wake loop.

Use `foundry_pull_work` on the highest-ranked ready item. It admits a bounded job, not a new
direction. Before staffing, use `foundry_split_work` if producers can deliver independently
checkable outputs; preserve the governing checks on the combined result. Communicate with the
actual consumer, not through the director. When an increment is accepted, reassess the outcome
and pull the next eligible item rather than reopening the old one. On an explicit operator
change, use `foundry_revise_direction`; stale work cannot grant new authority. Respect real
holds, limits and host availability without treating one lane's wait as a factory-wide stop.

On a desktop host that offers only `archive_session(id)`, leave workspaces for operator-reviewed
archival. Report the retention reason rather than deleting the checkout. Likewise, a qualified
join is not a landing receipt: if Foundry cannot update the authorized target safely, keep the
candidate and identify the remaining landing step.

## Deliver usable increments

For requested software delivery, choose the smallest coherent runnable increment and assign its
integration/delivery owner at admission, not after producer publication. Design packets, code
bundles and component passes are intermediate inputs. Give the bounded delivery producer actual
named inputs and executable checks of the combined candidate. For a factory, `completionTaskId`
must identify that requested delivery, not an intermediate packet. Use existing checks and input
edges; do not add a separate approval workflow or impose app-delivery stages on research-only work.

For a first usable product flow, build and exercise one real end-to-end journey on the
runnable candidate. For design work, compare the actual interface with the agreed reference.
Add focused checks for material risks in the slice, not a broad regression matrix for the
prototype or debug UI. Expand coverage once the flow works; keep already-governing checks.

Include landing, build, launch and visual inspection when required by the user's requested outcome.
Respect actual Git/release authorization: do not invent no-commit/no-landing restrictions, infer
permission from a task, or call an unlanded/unlaunched artifact delivered when those steps are
required. Report the exact outstanding step and its owner if permission or evidence is missing.

Keep the current delivery cut fixed through repair and qualification; put new proposals in the next
increment unless they fix a concrete blocker in this cut. Useful independent work may continue.
Preserve real regression assertions. Report implemented, qualified, integrated, landed and runnable
outcomes distinctly; factory-active labels, message acceptance and status relays are not delivery.
Ongoing coordination continues with the next concrete increment or a genuine event wait, not
speculative tasks, additional management layers or polling to stay busy.

## Unattended factories

Keep ordinary goal execution below activation-free. Only an explicitly requested unattended
factory uses `foundry_start_factory` with an accepted `.foundry` `foundry-factory` version 2
policy. The user's direct request to start or restart within the agreed policy scope is authorization;
do not request a separate activation dialog or duplicate chat approval. Inspect the exact snapshot
and actual native-owner continuation mode. Native permissions remain authoritative; scope expansion
still requires the user's authorization. Installation, tokens, timer wakes, and hook-generated user
messages do not authorize activation or restart.
Quiesce old participants before enabling this protocol.
This revision requires its current canonical schema and does not migrate old stores. Finish or explicitly
dispose of every unfinished old job and stop all old workers/commands/usage writers before an
authorized upgrade; pausing a factory alone is insufficient. Preserve database and evidence/artifact/
request/receipt/worktree history together. Never reset or sync/reload a live old-protocol factory
merely to try these features.

The main coordinator may stay interactive while a `native` factory's `goal.scope.mode` remains
`autopilot` for its workers. Do not require switching the main session to Autopilot or supplying
`blocks` for native continuation. Interactive coordinators resume on native messages, user input,
or an explicitly scheduled heartbeat; they do not get an automatic stop-hook loop. Exclusive
`stop-hook` continuation still needs interactive workers and coordinator, an observed stop hook,
and a positive `blocks` bound, defaulting internally to 3 when omitted. Preserve real native
user-input requests and resume the same work after the answer.

Omit tuning unless a meaningful override is needed; do not ask users to estimate internal counters.
`maximumJobs` defaults to 1 whole delivery job, which can run many independent leads and subtasks
in parallel. Higher values require multi-job intake from trusted issues or direction-driven squads,
not more subtasks. Do not copy
that bound into worker limits or invent worker, credit, deadline, or repair caps. Preserve actual
user/runtime constraints and schedule ready independent work within them; investigate concrete
dependencies and contention as work proceeds, not through a mandatory tuning preflight.
Native factories reject `blocks`; stop-hook overrides must be positive, not estimated from task
complexity. Activation `settings` and context `factories[].settings` report effective values and
their origins. Present these without stopping for another approval. `policy` records a document
value, not user provenance; do not call it user-chosen or runtime-observed without actual evidence.
Reload uses the persisted resolution; source edits do not silently change active settings.

Use `foundry_advance` for current locally owned actions. Keep its native `started` receipts;
execute only the remaining `prepared` calls, even alongside per-task capacity blockers. Do not
replay an uncertain create or send resume or reserved repair to creation.
Request the actual task's context before implementation. Hooks only classify; native side effects
run in ordinary turns. Input, abort, permission refusal and stalled continuation pause truthfully.
User-requested restart resumes safely parked coordination without inventing checked failures or
spending a code-repair allowance. Unknown effects and native requests remain blockers.

Only final executable acceptance seals a bounded job's current required producer/input closure.
Required mutable in-job production must float. Do not remove protected inputs, combine candidate
versions, or publish unattended code without evaluated file-bound evidence. Delivered-but-unsettled
is not finished native ownership. Explicit `foundry_reopen_job` supersedes completion while keeping
history; `foundry_cancel_job` cancels without claiming acceptance.

Optional trusted GitHub intake uses `foundry_ingest` or one explicitly bounded `foundry_poll`
page. Inspect actual author/editor provenance, not caller event JSON. Polling never activates work
or creates a synthetic seed job. Preserve capacity-deferred events and opaque provider cursors;
do not claim stable complete coverage across changing pages. Any recurring heartbeat belongs to
the actual native owner and the qualified host route, never an extension timer or replacement
automation. Use `foundry_set_heartbeat` only with a user-chosen `everyMinutes`; its native dialog
confirms the cadence. Reconcile uncertain saves rather than resaving. `foundry_pause_factory`
fences work before inspecting/removing the recorded owned heartbeat. Do not overwrite unrelated
schedules or claim the host supports atomic conditional mutations against concurrent app edits.

Reusable charters capture declared native roles and evidenced, hash-pinned repository knowledge;
curation is explicit, not automatic policy promotion. Grain generators use their declared
specification/context and a conserved implementation-free base commit, without implicit
team/lesson history. Admission stores the resolved context, native agent and base commit on the task;
dispatch does not reinterpret policy or infer template membership from its ID.
Pin independent evaluators and boundaries. Worktrees and prompts do not enforce
an old-source read sandbox; retain honest audit/provenance and never claim stronger exclusion.

## Execute

1. Establish the user's actual goal, allowed work types, repository paths, restrictions,
   delegation and execution mode with `foundry_start_goal`. Supply only limits the user or
   native runtime actually specified. An accepted `.foundry` source contract compiles without
   model planning. Do not introduce a mandatory discovery or review pipeline.
2. Create useful units with `foundry_create_task`; record a persistent native child or job when
   it needs independent admission, shared-write ownership or recovery. Give children their
   parent task and only narrowing scope overrides; restrictions inherit automatically.
   Recursive `foundry_create_unit` metadata describes organizations, teams and subteams without a
   fixed department list. Delegated units require their actual `taskId` boundary; `parentId` names
   another unit. Metadata membership does not grant task authority.
3. Use `foundry_dispatch` to start native children concurrently. `started` entries already have
   a native worker; execute only `prepared` fallback calls, unchanged. Each worker reads its own
   frozen brief with `foundry_get_context({assignmentId})`. Follow `nextOffset` with `offset`;
   supply `checkId` to inspect one exact evaluator. If binding is pending, reconcile your own
   native session with `foundry_reconcile_native`, not a message to the creator.
   `autopilot` executes authorized autonomous work; `interactive` preserves narrower supervision.
   Never default executing children to `plan`, demand a readiness acknowledgment, or send an
   activation. Native pre/post hooks record issuance and returned identity without another
   model turn. A token/name correlates an attempt; it is not authority.
4. Use `foundry_start_task` for work in the current native session or a deterministic job rather
   than creating an unnecessary model session. Lightweight subagents remain part of that
   attempt unless they cross the independent-record boundary. Never multiply a goal budget
   at each delegation level.
5. Use `foundry_get_context` to inspect work without advancing it. On a wake, call
   `foundry_advance` for that goal to consume the notification and recover unfinished native
   bookkeeping. This does not mark the coordination generation handled. Ownership is parent-local. A parent may delegate
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

Latest check evidence follows canonical admission sequence, not completion timestamps. Findings
are diagnostic; governing new obligations must become explicitly assigned/protected checks.
An early report is history, not a pending automatic promotion: report again explicitly after
binding/evidence arrives, using current admitted evidence and a new result ID if the observation
changed. Already-promoted replay normalizes references without republishing captured bytes.

For a bounded reproducible file unit, give every relevant check the same `artifactFiles` list of
existing implementation files inside its task paths, with required module/package files included.
Pin evaluator files separately with repository-relative `oracleFiles`. Those checks run in a captured
bundle; the mutable checkout is not their execution directory. Report code/artifact outputs using
the actual returned `evidence.candidate.version`, with its reference for the unit or a declared
filename for an entry. Do not substitute a newer checkout or combine passing checks from different
candidate versions. Integration declares and evaluates its final unit too. This opt-in format
does not pin undeclared runtime/data dependencies or require commits. Non-artifact checks still run
their assigned commands without capturing a file bundle.
If the worker base omits evaluator or retained support files, declare `oracleCommit` on the
artifact-bound check before admission. Use a full local commit containing all SHA-256-pinned
oracle files; only those files are read into the runner's private bundle. Missing support is a
provisioning blocker, not a product-code repair. Do not copy support into a restricted generator
checkout, change old attempts' snapshots, or publish an out-of-band evaluation.
When publication of the evaluated unit is intended, use `publish: "<output name>"` on
`foundry_run_check`. It uses the normal promotion path once all governing checks pass on the same
candidate, without another model turn. Partial acceptance keeps work running; mixed candidates
block publication without inventing a failed check. Unchanged publication retries retain their
identity; changed governing receipts produce a fresh result. Already-published replay does not rerun.
An unavailable/corrupt managed input is a recorded blocker, not a reason to keep recoding its
consumer; route the actual failed input identity to its accountable owner.

## Continue locally

Parents integrate declared child outputs. Only real named-output prerequisites serialize work;
delegation edges do not. Regenerate independent modules in separate worktrees against their
declared, pinned interfaces and fixtures. Keep a blocker on the affected work only; continue
eligible independent work without waiting on the same release or landing surface. Preserve
actual permissions, effects and claims; do not extend a completed maintenance hold to new work.
Record genuine native input pauses with their actual request IDs using
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
Signals target accountable coordinators. `foundry_reassign_unit` changes descriptive metadata,
not authority or execution. Use exact settled `foundry_handoff_task` for coordinator replacement;
unknown recipients and unavailable outgoing coordinators require actual native inspection.
Charters organize existing scoped tasks, not new root-level authority for a leaf. Add work through
the goal owner or an existing delegating task in the canonical tree.
Pure notification bookkeeping needs no executing attempt. Known unavailable recipients wake an
existing accountable ancestor, not an automatically appointed replacement.
Preserve reproducible procedures, versioned authorized inputs, parameters and raw results for
analyses; a disproved hypothesis can be a completed result. Curate concise evidenced lessons by
goal/work type with `foundry_record_lesson`, not global prohibitions or full-history prompts.

## Coordinate organizations

Explicit `role: "coordinator"` tasks retain ongoing responsibility under the same canonical task
tree and goal scope. Staff real native worker subsessions and useful subordinate coordinators;
do not end the role at its first report or invent headcounts, idle departments or extra approval
gates. Give producer children their concrete executable checks/inputs; the role itself publishes
no product result. Unit templates in accepted `goal.units` persist structure, not cross-job
authority, sessions or multiplied budgets. A native coordinator carries one active goal.

Keep the same role attempt/session across events. Yield with
`foundry_wait_task(kind: "events", attemptId, reason)` before dispatching children when needed
for an explicit worker ceiling. Management requires no implementation slot; resume normally
before commands/file edits or use a bounded admitted producer. Context exposes pending/handled
coordination generations separately from native wakes. After staffing or genuinely waiting/
exhausting the observed work, record `handledGeneration` and relevant task/request `relatedIds`
with the event wait. Reading context is not acknowledgment of completed coordination work.
Newer generations stay pending. Do not poll, redispatch a waiting role, or create self-wake loops.
A settled natural stop releases capacity and escalates undisposed work once to its sponsor;
there is no independent dead-process watchdog.

Send scoped questions, advisory feedback, and handoff notes directly with `send_session_message`
when you know the native session bound to the peer's assignment. A directory owner alone does not
establish that binding. If you cannot identify or reach the peer and work is blocked, ask your local
coordinator for help; don't copy the director on routine exchanges. The director owns priorities,
cross-team tradeoffs, and shared delivery blockers peer owners cannot resolve. When escalating,
name the concrete blocker and decision needed. Do not make advisory feedback a delivery prerequisite
or change existing governing checks.

Use `foundry_request_collaboration` for a named output from a peer coordinator task in this
canonical store. A required proposal blocks its own producer consumer. Discover peer coordinator
task identities in assigned-goal context `directory`; continue its bounded pages with `nextOffset`
as `directoryOffset`. Directory metadata grants no peer
backlog/mutation rights or unassigned-goal discovery. The destination accepts
through `foundry_respond_collaboration(action: "accept", producer)` under its own current scope,
staffing its child and acquiring an outgoing obligation atomically. No peer receives general
source-task mutation rights. Required requests fence acceptance on both sides.
Fulfill only actual published named outputs. Cross-goal delivery pins the exact immutable
version; mutable in-job production floats. Changed/unavailable consumers retain delivery with
`bound: false` for explicit source `bind`. Decline/block/cancel is not delivery; source `release`
can remove this derived obligation, never original protected inputs/checks. Preserve request
IDs/revisions for retry and let actual dependency cycles reject admission, not harmless peer
collaboration. Narrow request/output notification entitlement is not general cross-goal access.

`foundry_handoff_task` moves only exact settled no-transfer work. Preserve native creation
ancestry and independently delegated workers; move outgoing-owned pending descendants only.
Actual recorded execution worktree/HEAD must be verifiably unchanged, including untracked and
ignored files. Missing/dirty/unknown worktrees, claims, commands and real input requests block
handoff. Replacement execution conserves the verified commit; a newer project HEAD is not a
substitute. Do not fabricate checked failures, evolve requirements for cosmetic ancestry, or
debit repairs. Dirty checkpoint relocation and cross-repository federation are unsupported.

Only executable product acceptance seals a job and retires coordinator roles. Explicit reopen
can restore settled leases in their existing sessions without repair debit; settle real outstanding
native work before restoring those leases. New jobs get fresh native coordinators.
Read `get_context.capabilities`: same-store organizations/goals are supported, but native peer
provenance, durable cross-store receipts and artifact transport remain unqualified. Mock tests do
not prove host lifecycle, permission, wake/accounting ordering or restart guarantees.

## Recover without replay

For an ordinary command whose genuine completion was missed, its actual native worker can use
`foundry_reconcile_native(sessionId: "<this session>", toolCallId: "<original issued call>")`.
This reads the actual session's retained start/completion events, verifies issued arguments and
session/project identity, and settles only a real final shell exit, including retired attempts.
Do not pass reconstructed receipts, rerun the command or force-release its claims. Missing native
history remains a blocker. Quoted historical check markers in ordinary stdout are data, not evidence.

Keep the actual native result if its shape needs reconciliation. `foundry_reconcile_native`
inspects the actual session ID and recovers its known assignment; an issued-but-unbound call is
uncertain, not permission to create another child. A prepared, definitely unissued intent can
resume only after retiring its previous dispatch owner.
Original session inspection preserves already-bound history without replacing a newer warm attempt.
An existing worker can recover its actual outstanding shells and yield or resume its current
execution after coordinator handoff; it does not acquire new delegation authority.

Checked repair normally uses `repair: true` on `foundry_run_check` or `foundry_report_result`.
Assigned commands have one exclusively claimed, atomically finished runner receipt. Your
`foundry_advance` and `foundry_run_check` calls recover finished receipts without rerunning, retaining their
`runner-receipt` source and assigned evidence checks. A recovered check replays its result; use
`foundry_prepare_check` for an explicit new evaluation. Started-only receipts and ordinary commands
without actual completion remain unknown; never manufacture settlement.
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
