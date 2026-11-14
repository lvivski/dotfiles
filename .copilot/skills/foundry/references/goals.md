# Squads and goals

This reference describes internal model/service ports, not authoritative state,
public tool registration, a launcher, or an installed operating model.

## Canonical entry points

[`createFactoryService`](../../../extensions/foundry/factory.mjs) exposes
`operating`, `squads`, and `goals` over the same canonical repository snapshot.
`operating.prepare/commit` handles an atomic batch; the squad and goal facades
restrict their respective record kinds. Both facade writes and direct operating
writes enforce the same charter ownership, actor, graph, revision, and decision
receipt rules. Reopen, replay, repository publication, and single/paged imports
validate the complete historical effective graphs. Adapter-supplied domain
checks can add constraints, not replace the canonical validators.

The [version-1 DTOs](../../../extensions/foundry/types/operating.d.ts) and
[closed codecs](../../../extensions/foundry/plan/schemas/operating.mjs) define
charters, goals, typed relationships, decisions, criterion/evaluator pins,
producer inputs, context commitments, snapshots, and publication envelopes.
Unknown fields and versions reject. Revisions are contiguous, immutable, and
kind-stable. Changing a record requires its exact predecessor and a fresh whole
snapshot; references never silently resolve to a newer producer or contract.

`squads.history/generation` project exact charter/decision history.
`goals.inspect/generation/exportHistory/importHistory` project support and
transfer canonical portable knowledge. Import checks repository identity before
rebinding its local common-directory address. Names, imported history, and
readiness projections convey **no native authority**.

## Storage and commit boundary

Portable knowledge belongs to repository `.foundry` publication. Existing
factory SQLite retains the immutable `recordOperating` journal (factory format
v2, storage schema 4). Existing owner-plan SQLite retains the authorization
outbox and private bindings/references in `plan.operating` (plan schema 3).
There is no additional authority database, lease, or scheduler.

The snapshot token binds the repository, factory revision, and digest of the
entire read set, including resolved knowledge, contracts, candidates, and
evidence. The lock order is existing admission writer, factory writer, then
owner-plan writer. The factory writer repeats validation against its locked
snapshot. The owner writer rereads revision, owner, running attempt,
reservation, attachment, cancellation, and any supplied delegation before
committing the exact publication and local authorization marker.

Owner COMMIT linearizes authorization/outbox intent; factory COMMIT linearizes
the graph; immutable repository publication follows. This is not a
cross-database ACID transaction. Precommit failures leave no intent. A later
publication failure retains the exact authorized digest for `reconcile`.
Reconciliation is idempotent and never rebases a stale snapshot. Subsequent
revocation prevents new work without erasing already committed historical
intent. Imported history lacks the local marker and cannot reconcile as a local
authorization.

## Authority ports

[`OperatingPorts`](../../../extensions/foundry/types/operating.d.ts) supplies the
existing admission `withFence`, owner persistence, and a synchronous trusted
native ownership assertion. Missing, asynchronous, or mutating assertions hold.
Cached metadata and synthetic test observations do not establish supported
action-time App ownership.

For general model composition, supply the supported native ownership port to
`createFactoryService`. Its optional `coordinatorSessionId` is trusted
composition metadata, never a request DTO. A delegation requires that identity
and exact current owner/repository/capability/file scope. Historical delegated
decisions additionally require the original plan/completion or bounded
technical receipt. The charter cannot manufacture a receipt or execute its
decision. Contract, human, replacement, external, and resource acceptance remain
separate.

[`createSquadAuthority`](../../../extensions/foundry/application/squads.mjs)
remains an optional charter-only adapter; do not install it as a general
goal-writing port. The canonical writer shares its decision-receipt checks.
[`createGoalService`](../../../extensions/foundry/application/goals.mjs) accepts
narrow operating, admission-observation, environment, and portable-transfer
ports. The root service's default admission projection is `unknown`; a consumer
needing current readiness must supply actual supported observations. Neither
service reserves, launches, approves, or replaces workers. Worker replacement
uses the existing reconciled attempt and admission lifecycle.

## Evidence and privacy

[`validateGoals`](../../../extensions/foundry/factory/goals.mjs) rejects logical
cycles across typed relationships and checks exact producer goal, charter,
attempt, delivery, input, contract, and evaluator identities.
[`goalRollup/goalImpact`](../../../extensions/foundry/factory/rollup.mjs) derive
criterion support and selective downstream reopening from canonical evidence.
Missing, failed, conflicting, stale, non-independent, human-pending,
visually-rejected, and unavailable-platform evidence remains visible.
Implementation task completion does not close unsupported criteria.

Portable identities are historical commitments. Active bindings and private
reference targets stay owner-local and are stripped on plan export/import.
Generation projections omit private/comparison-only context; a comparison lead
is not an accepted incumbent or generation input. Bounded summaries and content
digests provide reproducibility, not secret detection, execution attestation,
or OS-level source isolation.

## Delivery and open program boundary

The source composition retains actual ancestry from baseline
`202e694bb05b336ebb3684b122ac75deb578c916`, checkpoint
`8dcecea93862e45be39e5d326f15c5da60490025`, squad delivery
`53d93229d20a662003b32d24965a28b68cf176c8`, and goal delivery
`7fabda58728275f6b69f4184a10b8b209b6aed43`. Original reports and failed checks
remain separate from final composed evidence. Shared DTO serialization,
snapshot/fence semantics, protected evaluators, runner, and legacy conservation
checks are not replaced by this reference.

`regenerationGoal` persists an explicitly open model and portable export with
nine unresolved needs: accepted boundary/contract/evaluators, incumbent
selection, fresh generation, independent evaluation, replacement acceptance,
consumer use, public registration/lifecycle wiring, supported live App
execution, and data-preserving cleanup. Retained fixture stores are isolated
model provenance, not live App registration. The Calendar comparison lead is
private recovery context; shared six-resource SR1 authority, Mail/Chat, and
shared limits remain preserved unless a different boundary is explicitly
accepted.

Common operating integration, concurrent native/retention integration, real
cleanup, supported-host checks, and full Hyper regeneration remain separately
admitted outcomes. Retention source work has no dependency on this schema.
Neither held hosts nor archived children are experiment surfaces. Native SDK
TS2344 remains a separately reported non-pass; source/offline success cannot
replace native, platform, human, service, or replacement evidence.
