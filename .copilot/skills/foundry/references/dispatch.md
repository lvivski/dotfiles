# Task dispatch

Read before dispatching ready work or recording an attempt's result.

## Truthful stages

These are evidence labels, not new public operations or replacements for stored task states.

| Stage | Required evidence |
| --- | --- |
| Prepared | Bounded immutable declarations/payload retained; no reservation, child or execution implied. |
| Reserved | Exact durable task/attempt reservation and applicable current resource claims; no worker implied. |
| Initialized | Actual setup acknowledgement and fresh same-child/owner/worktree/base corroboration. |
| Attached | Successful native attachment to that exact reserved attempt; task handoff still separate. |
| Executing | Successful unchanged handoff plus observed authorized task work; an accepted send or stored `running` flag alone is insufficient. |
| Delivered | Terminal attempt recorded with its required exact artifact and evidence; neither release of unresolved claims nor passing verification implied. |
| Independently verified | Independent passing evidence bound to the exact final delivery and governing checks; not completion, human or replacement approval. |

## Bounded registered source entry points

These source tools are registered and composed, not proof of installation or live host support.
Their top-level inputs are closed:

| Tool | Inputs | Bounded purpose |
| --- | --- | --- |
| `foundry_dispatch_ready` | `planId`, `limit` (integer 1–128) | Visit one ready set, retaining terminal deliveries and considering existing reservations before fresh work. |
| `foundry_reconcile_parallel` | `planId`, `taskId`, `reservationId` | Reconcile that exact owned admission once; never create a replacement. |
| `foundry_materialize_inputs` | `planId`, `taskId`, `attemptId` | Materialize the complete journal-pinned input descriptor into its authorized consumer worktree. |
| `foundry_assess_package` | `planId`, `taskId`, optional `report` | Prepare the delivered assurance subject or assess its report; see [verification](verification.md#package-assessment-source-entry). |

After normal plan approval/activation, invoke dispatch once with an explicit visit bound, not a
target agent count or new resource budget. It drives the native sequence below. A `bounded` response
can contain held results; `handed-off` still reports `inputsMaterialized: false` and
`executionObserved: false`. On an actual notification or explicit authorized request, reconcile the
retained admission once, record any terminal result with `foundry_complete_task`, then reconsider
ready work. Do not poll, reconstruct the sealed prompt/input payload, or manually continue a held
create/attach/handoff through another route.

The default production extension supplies `{ state: "unavailable" }` host ports. Only the trusted
`createFoundryOperations` constructor's `getParallelHost` may provide actual offered-tool execution,
per-operation availability, result decoders, setup/canonical-child observations, resource policies
and recovery, complete contributor and reviewer readers. Tool JSON, imported receipts and schema metadata cannot supply them.
Calls require the current owning coordinator's native invocation outside workflows/subagents.
Absent host support returns `held` (`parallel_host_unavailable`); missing operation-specific
decoders/observations also hold. There is no legacy or workflow fallback for admitted parallel work.

## Native dispatch sequence

1. Call `foundry_get_status` and read `projection.scheduling`.
2. Dispatch only IDs in `projection.scheduling.dispatchableTaskIds`. Read its `launches` and
   `scopeConflicts` for delivery guidance and holds. Readiness is derived, not a stored task state.
   An overlapping task needs a user-attributed
   `scopeOverride`; never manufacture one.
3. Reserve each task with a unique stable `reservationId` and the current revision.
4. Retain the reservation and complete create/admission receipts in the coordinator's session
   artifacts. Before creation, resolve the exact `baseBranch` to a full commit ID on the execution
   host and retain it as `baseCommit`; do not recalculate it after setup to excuse drift. Resolve
   the plan repository's App project, then call native `create_session` **once** with:
   - `base_branch` equal to the reservation's `baseBranch`;
   - a distinct `workspace_type: "worktree"` and an explicit short `name`;
   - `kickoff` equal to the returned `initialization.kickoff` (setup only, interactive);
   - `coordinate_with_creator: true` and `notify_on_idle: "always"` so setup does not consume
     the task-completion notification. Do not pass the task prompt, task attachments or a schedule.
   A null `initialization` on replay means no new kickoff. Even a non-null one is not permission
   to create twice: reconcile the first admission and retained child identity before doing anything.
5. Wait for actual setup-turn completion and its exact `initialization.acknowledgement`, then
   corroborate the same created child as described below. An accepted kickoff, navigation, an idle
   flag alone or `active_session_id` presence/absence is not setup-completion proof.
   Re-read the plan and attach with `foundry_attach_task`, the current revision, canonical native
   child ID, freshly observed branch and
   `bootstrap: { worktreePath: "<retained canonical child path>", baseCommit: "<pre-create SHA>" }`.
   This checks the distinct registered repository worktree, exact unchanged HEAD, clean tracked
   and untracked state/index, and unchanged reserved base. Missing local access fails closed;
   never substitute the coordinator checkout. Preserve the input observations with the receipt.
6. Send the reservation's exact `delegationPrompt` to the attached child with
   native `send_session_message`, `coordinator_only: true`, `delivery_mode: "immediate"` and
   `mode: "autopilot"`, **only after successful attachment**. Do not add implementation or
   comparison-only material, drop attribution flags, or manufacture a user-source quote.
   The verifier's registered worktree is captured at attachment; only then may it
   detach to the exact target commit. Never substitute the coordinator's checkout
   for that verifier worktree.
7. Record an unattached attempt as `blocked` only when creation definitively produced no worker.
   If any child exists, setup fails, its identity is ambiguous, or admission is uncertain, retain
   the reservation/scope and failure receipts. Do not create a replacement, free scope through an
   unattached failure, or pretend setup/task delivery succeeded. Follow [recovery](recovery.md);
   retries require reconciliation, not merely a new tool call ID.
8. Wait for actual App `notify_on_idle` notifications rather than polling. A notification or explicit
   authorized intervention wakes one bounded reconciliation invocation; it is not completion evidence.
   Intervene only for a child request, explicit steering, a stuck session, or cancellation. Do not
   invent a cross-child SDK event API or turn missing notifications into a timer/retry loop.
9. Record `done`, `failed`, or `blocked` with the child result, branch, commit/PR when present, and
   concrete evidence. Resolve and record the full commit and PR metadata required by the task before
   recording `done`. Before recording an attached failure, terminate/archive its session and supply
   a fresh complete terminal inventory. Then re-read ready work.

## Dependency-output consumption

`foundry_materialize_inputs` accepts identities only, not paths, descriptors, receipts or caller
authority. It reads the full descriptor sealed in the creation journal, re-resolves current producer
deliveries and checks the same authorized consumer entry. Missing host support is a hold, not
permission to call internal ports or copy inputs manually.

Freeze the complete package declarations before admission: every producer/output, consumer
destination, governing revision, bounded path and resource claim. Keep the bootstrap branch/commit
separate from all producer inputs. Resolve every input from its current owner-local successful
attempt/delivery receipt, exact full commit, path, mode and content digest; check actual Git bytes
and complete declaration coverage. DONE prose, imported history and mutable branch tips cannot
replace those bindings.

Only the authorized consumer entry, after successful attachment **and unchanged successful handoff**,
may materialize the complete snapshots into that consumer's distinct worktree. Recheck current
authority, receipts and the pinned clean bootstrap before writing; setup must not dirty it.
Do not overwrite existing destinations or protected evaluator material, or import comparison-only
sources into generation inputs.
Record the actual consumer entry point, consumed identities and execution outcomes; resolution or a
manifest alone is not consumption. Snapshots do not replace exact delivered-commit ancestry integration.
Missing/stale bindings, incomplete inputs or unavailable supported materialization retain a hold.
A successful `materialized` result records its input digest/artifacts, not execution or verification.
Repeating materialization does not overwrite existing snapshots; retain the result rather than retrying.

## Shared transition and invocation ownership

Follow the [shared transition map](parallel-contracts.md#fenced-transaction-and-recovery-protocol):
the admission writer alone owns claims, fences, settlement and release; dispatch journals native
intents/outcomes through that fence; recovery/cancellation request transitions through those owners.
Input resolution/materialization does not grant claims or approval. Keep native side effects outside
the writer transaction, after a durable start receipt. Separate plan/resource stores are not a
distributed atomic transaction: retain uncertain gaps and late outcomes; re-read on revision conflicts.

Only the owning coordinator may invoke the supported offered-tool path under normal permissions.
The captured session-management operation failed on its extension RPC route; primary App-path
success does not transfer to that operation/adapter. Support must be established separately for each
operation and route, not inferred as universally available or unavailable. No automatic alternate-path
fallback, `session.workflow.run`, nested workflow or fabricated event subscription repairs a hold.
Source/fixture evidence proves neither installed composition nor live
permission, setup/notification, restart or native visual behavior; retain those evidence gaps.

## Setup corroboration and failure holds

Native kickoff initializes a new local child's backing session before submitting its first turn;
it avoids the cold-target `send_session_message` classification path. It does not await a completed
setup response. Normal App startup, repository trust and resource permission still apply.
The setup prompt is a behavioral instruction, **not** enforced inactivity or worker revocation.
Inspect its response/activity and retain any unexpected command, edit, branch change or failure.
No implementation or verification is authorized until attachment and the separate task handoff.

Use fresh public `get_session`/inventory evidence: the returned created ID and any App-resolved
canonical alias must identify the SAME retained project, creator AND coordinating creator,
worktree path and reserved base. Preserve both IDs; never infer alias equivalence from similar names
or paths, change providers to reinterpret an ID, or bind an unrelated worker. Inspect the existing
child's canonical path and actual checked-out branch on its host. The bootstrap check corroborates
Git state; session association and setup acknowledgement remain claims, not host attestation.

Creation's response may precede naming or metadata refresh. An explicit name suppresses automatic
kickoff title generation, not every possible branch rename. If only the branch name changed before
attachment, corroborate the SAME worktree/Git directory, absent old ref and direct rename reflog
since creation, with unchanged HEAD/base and clean files; then attach its fresh branch. Retain this
pre-attachment rename evidence, rather than fabricating a post-attachment rename receipt. Unexpected
history, detached HEAD, moved paths, changed owner/base or dirty state holds dispatch. Recheck after
revision conflicts; do not resend setup or task work merely because attachment was replayed.
After attachment, use the existing rename reconciliation below if necessary.

An explicit handoff rejection is retained as a failure, not success; ambiguous delivery must be
reconciled against the same child's history before any retry. Never initialize an existing cold
worker by stripping `coordinator_only`, sending a peer/oversight message, or requesting another
manual bootstrap as the normal dispatch path. If native kickoff cannot initialize the same owned
worker, hold and report the host limitation; do not bypass native admission. This sequence needs
owner-run live validation on the next normally reserved worker, not speculative test children.

Factory context is included in the reserved prompt. Do not add comparison-only prior implementation
to a reconstruction child's inputs. Keep the incumbent until explicit replacement selection.
Record discovered facts, inferences and proposals in `learning`; they are not accepted obligations.
The verifier must return selected pinned executable `factoryEvaluations` as well as canonical check
evidence. Human modalities/judgment procedures use explicit human review, never an agent verdict.
Verifier-only renewal plans retain an external immutable target; they do not contain or reopen an
implementation task.
If factory synchronization fails after task completion, recover with `foundry_sync_factory`;
the persisted attempt is the outbox, so never rerun the child to repair a receipt.
New work requires the current portable knowledge head. A divergent branch does not
authorize more dispatch, but existing owned attempts can still report results or
cancel against their pinned execution history.

If the App renames a branch after attachment, do not restore it with raw Git or replace the
attached session. Inspect the same App session's actual branch and canonical worktree path,
then call `foundry_attach_task` with the original session ID, current revision and new branch,
plus `rename: { fromBranch, worktreePath, actor, reason }`. This explicit reconciliation requires
an absent old ref, a direct post-attachment rename in the latest 256 Git reflog entries and the
same registered repository. Existing verifier or prior-reconciliation worktree pins cannot change;
a pinned detached verifier is supported if the new branch is not checked out elsewhere.
Session association remains a claim, not authenticated attestation. Missing evidence, unsupported
hosts or terminal/cancelling attempts remain blockers. Re-read state on conflicts; never edit
stored attempts or weaken completion's branch checks to bypass a mismatch.

## Supplemental original-owner corrections

An approved integration clause is necessary but insufficient. **Before any correction handoff**, an
existing supported reservation/attachment mechanism must demonstrably bind the retained original
session/worktree, exact bounded paths, immutable base, resource claims and current authority to the
**active integration attempt**. Preserve its actual binding receipt and failure/evidence context.
DONE receipts, past attachments, task prose and append-only coordinator artifacts grant no fresh
authority and cannot substitute for that mechanism.

**No such supported mechanism/binding exists here. Retain the integration delivery hold for an
explicit authorized correction decision.** A decision alone cannot make an unavailable mechanism
exist. Do not hand off correction work, reopen DONE, use `foundry_retry_task` on it, create an extra
child/task, bypass guards or silently transfer leaf scope to the coordinator/integrator. Attachment
replay and branch-rename reconciliation are not supplemental authority. Valid initial-plan or
completion delegation does not waive this hold or approve a correction wave.

Preserve original terminal receipts. If supplemental activity already exists, historical DONE is
not proof it stopped: reconcile it and retain [cancellation](cancellation.md) and
[verification](verification.md) holds. Any subsequently authorized, genuinely bound contribution
must deliver an exact clean descendant commit, bounded changed scope and evidence, preserving the
pinned base/original-delivery ancestry. Integration must use that exact SHA and rerun affected checks,
not substitute a branch tip or relabel failed work as successful delivery.
