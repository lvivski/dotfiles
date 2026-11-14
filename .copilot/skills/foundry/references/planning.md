# Planning and approval

Read before creating or submitting a Foundry plan.

## Choose the route first

Select the authorized deliverable before `foundry_prepare_plan` or a paid `run_dynamic_workflow`.
App implementation/discovery plans require implementation tasks converging to one final
commit- or PR-delivered implementation target, followed by a commit-delivered read-only verifier.
Earlier leaves may be branch-delivered. `intent: "discovery"` changes the authority context,
not this execution topology or commit-pinned implementation verification.

Artifact-only/read-only research or design proposals without commit authorization should use
already-user-authorized standalone analysis, not an impossible App task DAG. Retain scoped
non-governing observations/proposals under the [factory lifecycle](factory.md#authority-and-discovery).
Do not infer commit permission from planning, resource admission, or an unavailable user.
If the needed analysis or delivery is not authorized, wait for that authorization; preserve
explicit contract, plan and completion approval.

Use `foundry_capture_analysis` only for supported registered workflows `audit`, `deep-research`,
`review-queue`, `security-review`, and `triage`: the report must be completed, owned by the current
session and wholly match the capability scope. Preserve the complete original regardless of size.
Custom-fleet reports, failed/non-importable plan reports and mixed-scope research instead need deliberate
scoped `foundry_record_knowledge` entries. Preserve original source references, run identity,
observation time, digest, uncertainty and coverage gaps. Never rename a run or rerun research merely
to satisfy the importer; retained proposals do not become governing requirements.

## App planning and approval

1. Read the [factory lifecycle](factory.md), inspect repository authority and select/define the
   coherent capability. Gather complete relevant repository context: working directory, base branch, relevant architecture,
   likely files, constraints, existing runnable checks/shared scaffolding and platform gaps.
   Apply the executable-workstream checklist below before preparing the plan.
   Explicitly review UI applicability. UI-producing successors must declare the
   [visual evaluator](factory.md#explicit-ui-and-visual-fidelity), pinned renderable references,
   intended ordinary/empty/error states and early capture feasibility. Initial discovery is not an
   escape from visual evidence merely because there is no accepted contract/candidate.
2. For fresh reconstruction from an accepted contract, prepare a sealed candidate and use
   `foundry_create_factory_plan`; this creates a draft without a planning Workflow. Continue at
   step 5. For exploration/general planning choose a stable lowercase plan ID and call
   `foundry_prepare_plan` with `repositoryPath` and `unitId`.
   An already accepted capability defaults to the candidate path; use `intent: "discovery"` only
   for explicit exploration, not as a way to bypass candidate evaluation/replacement acceptance.
3. With the user's resource approval, invoke the returned `launchSpec` exactly once with
   `run_dynamic_workflow`. Planning receives accepted authority or explicitly non-governing
   discovery context; it cannot silently turn observations into requirements.
4. Call `foundry_create_plan` with the returned `runId`, `expectedRevision: 0`, and the exact
   repository identity. It uses native event-driven waiting for an active run and imports only a
   completed result with its canonical factory context; no separate status-polling step is needed.
5. Call `foundry_submit_plan` and review the exact named revision, including its critical path and
   executable-workstream checklist. Record the concrete artifact/file/resource reason for each
   serial dependency and how useful independent runtime work will proceed. With a valid recorded
   delegation, follow the delegated path below. Otherwise present the plan and wait for explicit approval.
6. Record manual approval with `foundry_approve_plan`, `approvalType: "plan"` and `approvedBy`
   containing the user's identity, or record the delegated decision below. Then activate the approved
   plan with `foundry_activate_plan`.

Interrupting the import wait does not cancel the Workflow. A paused or failed run is not imported
or automatically resumed; follow the recovery protocol with the same `runId`.

Prospective structural and semantic correction uses independently governed effects, not a shared
numeric author allowance. A constructor-bound host must retain authentic baseline and comparison
observations, independently review each proposed effect, and atomically recheck its current
authority, cancellation, provider, resources and actual budgets before invocation.
Every continuation must newly resolve an obligation unresolved in its latest predecessor, preserve
all prior supported obligations and decisive evidence, and reject repetition, cycles or uncertainty.
Missing host support or complete comparison evidence remains a hold, not another native agent call.
Content and collection convenience ceilings do not authorize shortened requirements or lost evidence.
Repair retains task identities, dependencies, file scope and delivery commitments and must pass
domain validation plus independent substantive conservation review. Both agents receive the full
canonical input, both original critics, rejected candidate and original diagnostics/verdict.
Inspect the complete retained effect history and native receipts. Historical `synthesisRepair` and
`repairBudget` values remain unchanged claims; an old unused allowance does not grant a new effect.
Producer-authored evidence may be separated from later independent final confirmation, but the
independent obligation and every check remain. A support matrix can move to an artifact only when
the original authority already permits that disposition, never by inventing a source-scope exception.
Unresolved, missing or uncertain conservation remains `needs-review` and cannot be imported.
Do not truncate criteria, approve a fallback, raise caps, or restart the whole pipeline to conceal
an invalid result. Approval and provenance requirements are unchanged.

An eligible completed legacy semantic rejection can use the separate
[owner-bound repair recovery](recovery.md#completed-planning-repair) source entry points. It does not
resume the completed run or rerun decomposition/critics. Registration and fixture results are not
installation, native permission or live-repair evidence; activation and any live use require separate
authorization. All eight prospective recipe declarations omit invented resource ceilings;
real native permission, explicit scope choices and accumulated approved budgets remain applicable.

Planning currently has no pre-launch reservation. Keep the planning `runId` until it is imported,
and never launch a replacement merely because the first run is temporarily unobservable.

## Plan executable workstreams, not just concurrent authorship

Default to useful independent runtime workers for separable implementation, focused tests and
skill/documentation work, with disjoint bounded writes and appropriate outputs/checks. Use the smallest
coherent boundaries, not fixed agent-count targets or cosmetic parallelism. One accountable App owner,
claim writer or integration task does not imply one executor. This is a planning default, not
delegation or resource permission: each worker needs current authority and supported execution.
Do not create unreserved App children, expand an approved DAG, or silently transfer another owner's
scope to achieve parallelism.

Before generation and approval, use existing task descriptions/criteria and review notes to check:

- **Critical path:** identify the longest prerequisite chain and unavoidable serial tail. Expose
  genuinely independent, disjoint scopes. For every dependency edge or serial execution choice,
  name the concrete artifact/file/resource, its producer/owner and the readiness condition that the
  consumer actually needs. List order, one accountable owner or "shared interfaces" alone is not a
  reason. If proposing one executor despite separable work, record the concrete constraint.
- **Owner versus executors:** an already reserved/attached App attempt may use explicitly authorized
  bounded runtime workers without creating App sessions or adding DAG tasks. Assign exclusive write
  paths and focused outputs/checks; keep integration and terminal recording with the accountable
  owner. Helpers are not separately reserved/attached Foundry tasks and cannot exercise the owner's
  grants or expand scope. Keep the final verifier independent of every contributor, including helpers.
- **Runnable leaves:** identify each executable leaf's focused behavior check, command/entry point, required
  environment and observable expected result. If missing, assign minimal shared runner, fixtures
  and a stable interface checkpoint before only the work that consumes them. Then fan out useful
  implementation, focused-test and skill/documentation work; a frozen interface can support test
  authorship before implementation finishes. Do not serialize all work behind the shared interface,
  gate unrelated work on scaffolding it does not use or duplicate shared authority to avoid an edge.
  Documentation-only workers use focused interface/link review, not invented executable checks.
- **Actual inputs/outputs:** declare every producer output and consumer destination, immutable
  requirement/evaluator revisions, bounded write paths and shared-resource claims. A dependency
  edge, task summary or manifest is not consumption: require exact delivered bytes and actual
  consumer execution through the [post-handoff input path](dispatch.md#dependency-output-consumption).
- **Evidence and gaps:** compilation/typechecking is build evidence, not execution of fixtures.
  Run focused checks before leaf delivery rather than first discovering leaf failures in integration.
  If a check cannot run, name the concrete blocker, missing evidence and later owning task/environment.
  Do not invent a runnable command, report a gap as passing, or weaken accepted criteria.
- **Visual fidelity:** retain the exact declared visual criterion on the final implementation
  target, open the real pinned reference material and preflight capture before UI fan-out. Reserve
  independent reference-to-output assessment of real delivery captures, not first user discovery
  of mismatched composition. Missing/blocked capture or failed comparison is a hold; controls,
  geometry, colors and source checks cannot substitute. Do not add a human gate unless required
  by the governing evaluation.
- **Real exclusivity:** distinguish independently runnable worktree builds/fixtures with isolated
  outputs from shared-file writes, foreground native input, package-producing steps and final checks
  tied to an exact delivered package/commit. Disjoint paths do not isolate shared writable resources.
  Keep only necessary serialized work; integration should focus on seams and whole-app evidence.

For example, freeze the minimal types/runner checkpoint, then run disjoint state/reconnect,
view/selection, focused-test and skill/documentation work wherever their actual inputs permit.
An existing attached owner can coordinate authorized runtime workers without inventing new App
tasks. Integration checks the seams and produces the exact package; independent final verification
follows the pinned delivery. If the interface/runner already exists, omit the extra prerequisite.
Explain unavoidable packaging/native deferrals rather than concentrating every check in integration.

The native planning recipe supplies this review to decomposition, critics, synthesis and verification.
This guidance does not rewrite a running approved DAG, authorize additional tasks, change contracts/
protected evaluators, relax [dispatch](dispatch.md) holds or increase resource limits.

### Later execution-strategy corrections

Retain a later user request to parallelize as a separate attributed instruction with its source;
do not rewrite the original plan, approval, returned `delegationPrompt` or handoff to pretend it was
always present. Review the current work against the checklist and issue bounded supplemental guidance
only within the authority actually given. A runtime-worker strategy correction does not itself permit
new App sessions, DAG tasks, workflows, broader write scope or budget increases. If it requires a
changed DAG/scope, obtain the appropriate revised plan rather than silently editing accepted history.
Supported reservation/attachment, immutable recipe-specific startup, resource permissions and final
independent verification remain mandatory. Fresh reservations carry the entire final assignment in
interactive kickoff, then receipt/corroboration/attachment/short activation; only stored legacy
reservations retain original setup/attach/full-handoff. Follow [dispatch](dispatch.md); runtime
helpers cannot bypass an unavailable App dispatch capability or upgrade a stored reservation.

## Explicit decomposition and legacy behavior

Local source exposes optional closed `decomposition` on existing `foundry_create_factory_plan`:
`format: "foundry-packages-v1"`, `bindings`, `packages` and final `target`. Each package declares
`id`, `title`, bounded `expectedFiles`, `inputs` (`producer`, `output`, `destination`), `outputs`
(`id`, `path`), and exact `requirements`/`evaluators` references. Bindings pin the repository,
unit/contract and complete governing requirements/evaluators, including declared visual applicability.
The registered handler decodes through the package parser/compiler; malformed, substituted or
protected-input declarations fail before mutation. This is source support, not installation evidence.

Explicit decomposition produces disjoint bounded packages with real prerequisite edges converging
on one final implementation target and independent verifier. Preserve all requirements/evaluators,
including visual and human gates; splitting implementation does not weaken acceptance. Frozen
declarations and complete dependency outputs govern consumption, not a caller-selected subset.
Omission retains the deterministic one-producer/one-verifier recipe and historical plans, seals and
grants unchanged. Read-only evaluation plans remain verifier-only, without implementation decomposition.

Source registers the [bounded dispatch, reconciliation, materialization and assessment tools](dispatch.md#bounded-registered-source-entry-points).
Plan compilation still launches nothing. The default production extension supplies unavailable host
ports, so registration alone does not permit execution; a trusted constructor must provide actual
current owner/route/operation support. Tool arguments cannot manufacture those capabilities. Retain
host holds without internal-port or alternate-route bypasses, extra workers or discovery-mode evasion.

## Delegated execution-plan approval

An explicit user instruction in the coordinator's current context is required. If the user already
delegated named execution-plan approval, **record that instruction, do not ask them to confirm it
again or fill out another form**. If no such instruction exists, ask for delegation once, or retain
manual per-plan approval. A generated plan, child report, agent inference or imported approval receipt
cannot invent a grant. For an existing grant, inspect and reuse it unchanged; do not revoke/regrant it
merely to update the provenance format.

Record a new initial-plan grant with `foundry_plan_approval_delegation`, `action: "grant"`,
`approvalType: "plan"` (the default), a stable `id`, exact
reference `planId`/`expectedRevision`, and `authority`:
`{ instruction, grantedBy, source: { kind, sessionId, messageRef, messageRevision?, relayedBySessionId? } }`.
Preserve the original user instruction verbatim and its original `messageRef`; retain a separately
available revision in optional `messageRevision`, without inventing either. `grantedBy` is claimed
user attribution. Use `kind: "direct-user"` only when `source.sessionId` is this native invoking
coordinator. For an explicit user instruction relayed
from oversight, use `kind: "relayed-user"`, the original user's App session ID and message reference,
and the relaying coordinator's `relayedBySessionId`; retain the relay context, not an invented click.

This is **agent-attested user-instruction provenance**, like the manual approval path, not an
authenticated import of user-message consent. The public SDK cannot independently authenticate these
source claims. Foundry binds the actual recording session/tool call and scope, and records
`method: "user-instruction-attestation"` with `attestedBy`; it does not call a custom consent form.
Normal native tool/resource permissions still apply. The grant pins repository path/identity,
capability revision, accepted contract digest (or discovery-only null), and owning coordinator.
Missing instruction/source, foreign direct attribution or a stale reference revision fails closed.
Retain the grant ID. Historical `native-ui-elicitation` grants remain readable and immutable and
continue to authorize within their original scope; they are not silently converted or replaced.
Grants without `scope.approvalType`, including historical native-form grants, authorize initial plans
only. [Verified technical completion](verification.md#delegated-technical-milestone-completion) needs
a **different grant ID**, explicit `approvalType: "completion"` and its own explicit user instruction.
Never broaden/rewrite an existing grant or treat plan approval as completion authority. Both scopes
use the same instruction-attestation, owner checks, revocation and transactional decision machinery.

Before each decision, inspect the grant with `action: "inspect"` and review the submitted plan's
objective, constraints, file scopes, dependency/delivery topology and independent verification against
the authorized capability, including the executable-workstream checklist and each serial dependency's
concrete reason. Delegation is not a reason to default to one executor. If it qualifies, call
`foundry_approve_plan` with the exact `planId`, `expectedRevision`, `approvalType: "plan"`,
`delegationId` and a substantive `review`; omit `approvedBy`.
Do not ask the user again solely for this plan approval. Out-of-scope work needs its own authority,
not a self-expanding grant. No valid delegation means the existing manual path.

The receipt records the native approving session/tool call, exact named submitted revision and
blueprint digest, review and original grant. It is an agent decision, not a per-plan human click.
Attributed subagent calls and foreign owners are rejected. An omitted native `agentId` is not proof
of root-agent identity on every host; Foundry records only the known session/call, not an invented
agent or human identity. Revision conflicts require a fresh read: an already matching receipt is
the result, not a reason to manufacture a second approval or replay the stale request.

Use `action: "revoke"`, the grant `id` and `reason` to stop future delegated decisions. Revocation
is irreversible for that ID and checked in the same SQLite transaction as approval. It preserves
historical receipts and does not cancel already approved/running work. Plan JSON exports contain
historical approval evidence, not a transferable active delegation. This does not delegate contract
acceptance, correction/replacement approval, human or aesthetic acceptance, commit permission, shared-resource scope
overrides, verification, native resource permission or external actions. Existing owner, authority,
synchronization and dispatch checks still apply; it does not transfer another coordinator's plans.
An initial-plan grant also does not authorize completion; even a separately completion-scoped grant
authorizes only the technical closure described in the verification protocol.

## Delegated bounded technical decisions

Use `foundry_plan_approval_delegation`, `action: "grant"`, a **new** grant `id`,
`approvalType: "technical"` and exact reference `planId`/`expectedRevision` only when the user
explicitly delegates bounded technical corrections or compatibility alignment. Preserve `authority`:
the verbatim instruction, claimed user attribution and direct/relayed `authority.source`;
`messageRevision` can retain the original revision separately from `messageRef`. Record, inspect
and reuse existing explicit authority without another consent form. Planning context, a proposal,
a worker report or an old plan/completion grant is not this authority. Grant IDs cannot change scope
or reactivate after revocation. This is agent-attested provenance, not authenticated user consent
or a human click.

The existing `foundry_plan_approval_delegation` accepts `technical: { kinds, agreement }`.
Supported kinds are `retry` and `consumer-expectation`. Retry-only authority uses `agreement: null`.
Consumer alignment also pins `{ evaluation: { id, revision }, path, digest }` for a pre-existing
executable agreement inside the accepted evaluator bundle; `digest` is its canonical JSON SHA-256,
independently pinned by an already accepted obligation, not a newly invented equivalence claim.
Repository identity/path, native owner, capability revision, exact file scope and accepted contract
(or explicit discovery-only null) are
retained with the grant; the scope's files come from the named plan, not caller-added scope.
An accepted-contract successor is eligible only through conserved technical decision lineage back
to that anchor, not simply because its revision is newer.

Each decision names its exact plan revision/blueprint and factory revision, substantive reason,
triggering failure references, old/new scope and applicable immutable agreement/evaluator identities.
Attribution is the actual native agent session/tool call, not `approvedBy` or a human click.
The canonical owner-local SQLite writer rechecks current native owner, grant, revocation and exact
plan/factory revisions before atomically persisting the decision and its replayable outbox. Revocation
before this commit blocks authorization; afterward it allows only that exact publication reconciliation.
The same plan SQLite transaction retains an owner-local publication marker bound to the exact
plan/decision/digest. It survives restart and later revocation for reconciliation only, not new decisions.

After a conflict, read the current plan and repository. A matching existing receipt is the historical
result; a different postcondition is not success and cannot be fixed by blindly retrying at a newer
revision. `foundry_sync_factory` publishes a committed renewal through the existing factory journal,
portable knowledge publication and synchronization acknowledgment. A pending/conflicting publication
does not authorize a usable broader successor. Pending publication requires the exact owner-commit
marker. Export/import retains historical attribution and failures, not that marker or active
owner-local grants. Already-published matching history remains inspectable; imported history cannot
authorize a new factory append.

Use the [correction protocol](verification.md#delegated-discovery-correction) for retry and the
[bounded renewal protocol](factory.md#delegated-consumer-expectation-renewal) for protected evaluator
alignment. This changes neither the approved DAG nor accepted product meaning. Human/design and
replacement judgments, independent evaluation, commits, external actions and real resource
permissions remain separate. A native denial is not a technical disagreement to override.

## Owner-local large-payload transport

Authoring needs separate write authorization; native workflow approval is not file-write permission.
With Foundry active, only the invoking owner's already registered, running session extension named
`foundry-exact-relay` has a helper-directory exception. Foundry derives its directory from
`CopilotSession.workspacePath` and `session.rpc.extensions.list()` (`source: "session"`), after
matching the native hook session identities. Allowed edits still use normal native permission checks;
Foundry does not auto-approve them. Missing ownership, workspace or registration metadata fails closed.
Foreign/unregistered helpers, other session artifacts, traversal and linked paths are not covered;
every target in a mixed patch must remain in the repository or the verified helper directory.
If the helper is not registered/running or the API is unavailable, stop rather than widen the boundary
or disable Foundry. Registration and reload are separate authorized actions, not effects of this guard.

If a prepared payload cannot be reliably relayed in a model tool call, retain its complete bytes
and full-payload digest; do not truncate, reprepare to shrink it, or launch from another owner.
The helper-directory exception is only a write boundary, not invocation or resource authority.
`CopilotSession.rpc.tools.execute` declarations and captured offered schemas do not establish support.
The captured session-management operation on that extension RPC route returned
`This session management tool is disabled`; it does not establish support for that operation/route,
nor rule out every workflow or transport route. Check capability support per operation and route.
Normal primary App-path admission does not transfer to an extension adapter or authorize automatic
retry through another route.

Use only a demonstrably supported owner-local offered-tool path, with the prepared ownership binding,
complete digest and unchanged workflow name, args and limits, under its normal native permissions.
If a required operation lacks supported transport on its intended route, retain the hold. Never override permissions,
fall back to `session.workflow.run` (SDK-initiated runs do not request native resource permission),
or wrap this in a nested workflow (unsupported). Valid initial-plan or completion delegation is
not invocation, file-write, commit, shared-resource or external-action permission.

Retain an owner-local admission-intent record before any supported invocation, then retain the native
outcome receipt and exact `runId`. That record is not a native reservation or execution grant.
`toolCallId` is correlation, not an idempotency key. Uncertain admission requires reconciling
the owner's runs against the prepared binding and receipt, never a blind retry. Native admission
does not prove a separate human click or grant plan approval; a later delivery-contract
`needs-review` is a plan validation outcome, not a transport failure.

If an authorized adapter already exists, remove it only at a terminal safe point, retaining
source/checks, prepared payload, admission receipt and result evidence. This protocol authorizes
neither installation/reload nor live permission, restart or native visual validation.
SDK API references: `CopilotSession.rpc` (`session.d.ts`), `ToolsExecuteRequest` and
`createSessionRpc().tools.execute` (`generated/rpc.d.ts`), and the permission contract of
`SessionWorkflowApi.run` (`workflow.d.ts`; Dynamic Workflows guide, "Run and resume").
