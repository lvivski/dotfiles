# Foundry

Foundry is a dedicated capability factory: it produces and evolves verified software and the durable connected
knowledge needed to rebuild it. Repository-owned `.foundry` artifacts govern meaning, boundaries, accepted
contracts and candidate replacement. Session plans coordinate bounded work through App-native
project sessions and native Dynamic Workflows, without a second execution runtime.

## When to use Foundry

Foundry coordination is already opt-in. Routine changes can use native plan mode and direct tools;
ordinary multi-session work and dependent PRs can use the native `orchestrate` and `pr-stack` flows.
Those flows do not require a Foundry plan.

Use Foundry when explicitly requesting capability discovery, reconstruction, renewal, or a durable dependency-aware plan with approval gates,
reserved task attempts, delivery/evidence contracts, and cross-session recovery. Native workflow
journals and session tools provide the execution primitives, not an equivalent to those policies.
An explicit Foundry request follows the complete coordinator protocol. Discovery planning imports
a factory-scoped planning Workflow. A pinned accepted contract can instead assemble a bounded draft
deterministically, with no paid planning agents. Both paths require recorded plan approval:
manual user approval, or an exact named-revision agent decision under an owner-local delegation
recorded from explicit user instruction without a redundant form (historical native-form grants
remain valid). See the [approval protocol](../../skills/foundry/references/planning.md#delegated-execution-plan-approval).
Verified technical milestone completion may use a separately recorded `approvalType: "completion"`
delegation through the same mechanism. Historical untyped grants remain initial-only; closure rechecks
the authoritative verification/delivery binding and current independent/human evidence. It does not
accept design, replace a capability, authorize correction waves or grant external/resource actions.

Explicit `approvalType: "technical"` uses a separate owner-local grant for bounded discovery retry
and frozen consumer-expectation alignment. Historical plan/completion grants do not expand.
The existing delegation, approval and contract tools retain verbatim instruction attestation and
exact named-revision agent decisions without a redundant form. See
[technical decisions](../../skills/foundry/references/planning.md#delegated-bounded-technical-decisions)
and [supported renewal](../../skills/foundry/references/factory.md#delegated-consumer-expectation-renewal).

Renewal supports only the pinned canonical JSON cancelled late-denial scenario's `expected.outcome`
change from `denied` to `cancelled`. A frozen accepted obligation independently pins the agreement
SHA-256; granted access/data/focus, noncancelled-denial controls, unrelated cases, executable files,
modes and invocation stay unchanged. Structural checks plus actual immutable reference/control
executions (old fail/new pass with complete conserved traces) are required; boolean/prose equivalence,
matching counts and a green result alone are insufficient. The same evaluator's next revision and
new contract/context require fresh candidate/plan lineage, independent evidence and separate
human/replacement gates.
The reference executor is a trusted host port with no production default; unavailable support and
native denials remain explicit holds. Fixture execution is not installation or live-host proof.

Authorization linearizes at the owner-local SQLite decision/outbox commit, with current native
owner, grant, revocation and exact revision checks. Repository factory append, portable publication
and head acknowledgment are later reconciliation boundaries, not new grants. Revocation before the
commit blocks it; later revocation permits only the exact committed publication. Conflicts require a
fresh read and matching-receipt comparison, never blind replay or an unauthorized usable successor.
The same plan SQLite transaction retains `technical_authorizations(plan_id, decision_id, digest)`,
the exact owner-commit marker required for pending publication, not a new authority database.
It survives restart/revocation for exact reconciliation but is not restored by export/import.
Receipts preserve predecessor failures and export as history, not active grants or publication
authority; already-published matching history remains inspectable.

The [parallel implementation contracts](../../skills/foundry/references/parallel-contracts.md)
define the shared package/input, admission-fence and native-receipt ports, exact leaf ownership,
captured host schemas and confined test runner. Composed source and fixture evidence do not
establish installation, supported live host invocation or an accepted capability contract.

### Execution planning and ownership

The [planning and approval checklist](../../skills/foundry/references/planning.md#plan-executable-workstreams-not-just-concurrent-authorship)
defaults to useful independent runtime workers for separable implementation, focused tests and
skill/documentation work. One accountable App owner does not imply one executor. Every serial
dependency needs a concrete consumed artifact/file or exclusive-resource reason; shared interfaces
justify a minimal interface checkpoint, not serializing all implementation, tests and skill work.
Keep exclusive writes, scoped authority, App reservation/attachment, native limits and independent
final verification. This neither mandates a worker count nor authorizes new App sessions/DAG tasks.
Retain later execution-strategy corrections separately from the unchanged original plan and handoff;
an authorized strategy adjustment is not retrospective approval or broader execution authority.

### Explicit work-package drafts

The source `foundry_create_factory_plan` tool accepts optional `decomposition` in the closed
`foundry-packages-v1` format. Its `bindings` must match the candidate's sealed contract,
requirements, evaluator revisions and visual applicability. Each package declares disjoint
`expectedFiles`, named `outputs` with repository-relative paths, and `inputs` naming a producer,
output and consumer destination. `target` names the final package. The compiler derives the
dependency graph from those real inputs, adds independent final verification and preserves the
existing executable-plan limits; the 128-package wire limit is not a larger execution grant.

Omitting `decomposition` retains the historical implementation-plus-verifier recipe. An explicit
invalid decomposition never falls back to it. Draft compilation starts no child, grants no
approval and materializes no input. Valid owner-local initial-plan delegation does not need
reconfirmation, but technical completion, commits, contract/replacement acceptance, human judgment
and external/resource permissions remain distinct.

The source registers these bounded operations over the actual admission, journal, dispatch,
input and recovery modules:

| Tool | Input and effect |
| --- | --- |
| `foundry_dispatch_ready` | `planId`, `limit`: retain completed deliveries, then consider ready or retained reservations once. |
| `foundry_reconcile_parallel` | `planId`, `taskId`, `reservationId`: reconcile that exact owned reservation once, including cancellation obligations. |
| `foundry_materialize_inputs` | `planId`, `taskId`, `attemptId`: resolve and materialize the complete pinned input set after setup, attachment and unchanged successful handoff. |
| `foundry_assess_package` | `planId`, `taskId`, optional `report`: prepare the exact assurance subject or assess its bound report, retaining separate human obligations. |

Claim authority is one private database under the trusted Git common directory, shared across
coordinator owners; ownership remains a separate binding. Native intents, results and full
reservations use its fenced journal. Recovery retains whole observations in the same store.
No timer, speculative replacement child or second reservation engine drives these operations.

The extension currently reports unavailable host ports: a registered tool is not live invocation
support. A trusted constructor must provide current coordinator/project identity, supported
operation-and-route-specific invocation, actual result/setup/canonical observations, resource
policies, and complete current contributor/reviewer authority. Caller JSON, imported history and
old terminal receipts cannot provide those bindings. The captured disabled session-management
extension-RPC route cannot inherit support from the primary App route or trigger automatic fallback.
No non-destructive App child termination port is currently exposed; idle is not terminal and
archiving removes worktrees, so uncertain cancellation remains held.

Parallel cancellation persists the native plan request, then uses the actual admission
`cancelPlan` transaction to install a permanent owner/plan fence and fence its current rows.
Shared admission schema 3 rejects new and replayed claims even after every prior row is released;
unchanged v1/v2 writers reject the upgraded database. The shared journal requires that same schema.
Cancellation still does not settle effects, release claims or terminate native work.
`readCancellation` supplies a consistent census including released history and whole observations.
Finalization requires every admission released through its writer, fresh trusted terminal evidence
for all retained bound attempts (including completed producers), and the existing native plan/
verification guards. Unresolved joins retain `parallel_cancellation_join_pending`; caller inventory,
idle state or `finalizationOverride` cannot substitute for the parallel native proof. Interrupted
plan/store joins remain held until the same cancellation request or explicit reconciliation resumes.
If finalization discovers new native identities after an admission was released, it preserves the
whole positive capture in the owning plan's optional `cancellation.parallelObservations`, then
holds for a fresh read/observation. Later omission or restart cannot forget those identities.
These records only constrain cancellation: they neither reopen delivered admissions nor allocate
claims, grant authority or replace the admission store's existing recovery observations.

Registered tiny-Git fixtures execute two-producer consumption, immutable provenance, convergence,
independent verification preparation and human gates through these production modules with
synthetic native transport. Unchanged 32/128 logical workloads exercise production contention,
dispatch and recovery; their cancellation-terminal availability barriers are not successful
producer deliveries. Neither proof establishes real App permissions, setup/notifications/restart,
platform behavior or native visual capture/perception. Those require separately authorized host
validation against the exact delivered source and package identities.

### Release composition and operational boundaries

The root `createFoundryDispatch` composition forwards the trusted `ParallelHost.decodeRun`
unchanged to native dispatch, alongside creation, handoff and observation ports. Missing decoders
remain explicit errors, not SDK-result guesses. The common factory bridge exposes `operatingFor`,
`squadsFor` and `goalsFor` over its cached canonical factory services. Root `getOperating` supplies
trusted admission/native ports; persistence is always the current owner's existing plan outbox.
Whole-snapshot contention, native denial and absent authority retain the canonical failure paths.

Root `retentionFor(repositoryPath)` is constructor-bound through optional `getRetention`.
It composes the delivered retention operations and persistence only with an explicitly supplied,
matching owner/repository canonical archive transaction/outbox. No such production outbox is
provided by default. A dispatch journal is not a retention store. Missing persistence throws
`retention_persistence_unsupported`; missing action-time guards/reconciliation retain
`retention_action_time_unsupported`. Conditional archival, subject-wide exclusion and authoritative
original archive outcomes remain separate host obligations, not wrappers around `archive_session`.

The normal registry includes the existing repair tools and original `plan-repair` workflow.
Repair launch uses the existing native offered-tool handler and resource-permission boundary,
with unchanged launch specifications, owner-local journals and one durable admission. Injected
source tests are not actual offered-tool availability, a native permission decision or activation.
Production bounded technical execution, authenticated observations and permission providers remain
unavailable until separately bound and observed; no fixture provider is installed.

Source composition is non-UI: it does not change rendering or claim visual fidelity. Existing
visual evaluator definitions, review/adoption evidence and failed native captures remain intact.
A source commit, even with passing checks, does not establish a push, installation, reload,
archival, full-factory acceptance, replacement or regeneration. Operational deployment must compare
the complete immutable source against installed files, preserve dirty/custom increments, retain
individual divergence holds and use the exact independently verified delivery under current
owner authority and normal account/resource checks. A held deployment is not install-ready.

## Repository capability lifecycle

A capability is coherent behavior with named exclusive authority, stable interfaces, conserved data
and user contracts, dependencies and independent obligations. It is not a task, file, or renamed DAG.
The [factory protocol](../../skills/foundry/references/factory.md) describes the complete lifecycle:

1. Explore or implement, then capture discoveries, inferences/proposals, uncertainty and provenance.
2. Recover specification and executable evaluation definitions; explicitly accept immutable
   obligation/evaluation and boundary revisions with reasons and contradiction resolutions.
3. Prepare a candidate against sealed knowledge, keeping generation inputs separate from
   comparison-only prior implementation. Adopt pre-existing artifacts honestly, or reconstruct in
   a fresh session/process; adoption never invents retrospective generation provenance.
4. Dispatch bounded approved work, capture learning and exact delivery/evaluation receipts, and
   evaluate alternatives against the same pinned obligations. Retain the incumbent until selection.
5. Explicitly select a supported replacement. Later incidents, changed assumptions and stale or
   context-mismatched evidence identify bounded renewal needs and known downstream dependents.

Implementation tests, durable boundary checks, operational evidence and human judgment are distinct.
Explicit UI-producing successors declare `unit.visualEvaluation`, a pinned independent command
evaluator with a `visual` state/reference/capture profile. Initial discovery and deterministic
reconstruction both conserve its gate. Actual renderable references and output image identities,
state/environment/delivery bindings and independent visual findings are required; controls, geometry,
source and palette checks cannot replace them. Missing capture and failed comparison hold closure.
This adds no agents or automatic capture; image identity and reported perception remain distinct.
See the [visual protocol](../../skills/foundry/references/factory.md#explicit-ui-and-visual-fidelity).
Boundary/preservation evaluations require independent evidence; human evaluations require a human
source. Evidence binds exact candidate, contract/context/evaluator revisions, commit, task/attempt or
external run, source/time, environment and workload. Procedures are pinned by digest, so changing an
oracle cannot make the same contract pass through the supported executable path: the service resolves
the actual immutable Git bundle, protects its entire root and support paths, and checks that the
candidate contains the unchanged bundle. The digest includes the invocation, not only an entry file.
Commit existence and dependency ancestry are checked before accepting delivery. Registered verifier
worktree HEAD and cleanliness are checked at the actual attached worktree, never a substitute checkout.
Coverage, expiry, context and independence gaps block
unsupported selection; a completed task or successful Workflow replay is not a regeneration proof.

The factory ledger format remains `foundry-factory-v2`; new accepted contexts use seal version 3,
with source and statement commitments that survive portable projection. Existing v2 seals are retained.
Physical SQLite storage is schema 4; current v2 documents upgrade without changing their events,
seals or ownership, and cached older writers fail closed until restarted. There is no provisional-v1
migration. Accepted context pins dependency contracts, bounded non-governing causal rationale and
decision lineage. Generation omits source artifact/run paths, and rejects comparison-only references
leaking through its remaining text. Known generation origins cannot count as new fresh contexts.
Renewal signals link explicitly to contract decisions and candidates; accepting changed intent does
not declare the incident fixed. Inspection distinguishes proposed, awaiting-evaluation, partially
supported and supported renewal, without changing historical proposals or acceptance.

Context manifests and distinct producer IDs support `claimed` / `independent-claim` provenance, not
OS-level isolation, authenticated human identity, deterministic generation or cryptographic truth.
App work surfaces may contain incumbent source; declared separation must be established and
reported honestly. Selection records authority, not a deployment, merge or data migration.

`factory.mjs` exposes `createFactoryService({repositoryPath, storageRoot?, clock?})` for bounded
experiments. Mutations use a repository-wide `expectedRevision` and return the new `revision` plus
their record (`unit`, `knowledge`, `contract`, `candidate`, `evidence`, `decision`, or `signal`/`renewal`).
`snapshot()` is the current complete view; `executionSnapshot()` retains pinned owned execution
history when a checked-out knowledge conflict holds new dispatch. `inspect()` is bounded and filters
by unit/candidate, kinds, query and related knowledge. Its opaque cursor pins a snapshot; continuation
uses the same filters and limit. Discovery retrieves connected relevant knowledge ahead of generic
attempt noise and reports its selection reasons and omissions.
`bridge.mjs` composes the repository-to-session bridge over the existing execution state machine.
The source fixtures execute prewritten modules and boundary assertions in a genuine separate
process. They demonstrate lifecycle behavior, not generation. Live reconstruction is a separately
approved App-native experiment, never an implicit part of the test suite or proof of arbitrary
regeneration. `knowledge: "local"` is an explicit low-level service option for legacy storage
maintenance and isolated ledger tests; normal App tools always use repository-owned knowledge.
The [proof coverage record](test/proof/README.md) documents the blocked native experiment
and its retry conditions; no successful live reconstruction is claimed.

## Module boundaries

Filenames use meaningful one-word stems, with conventional `.test` and `.d.ts` suffixes.
`copilot-extension.json` retains its required standard name. Directory context carries the subject
instead of compound filename prefixes. There are no legacy-path shim modules.

The separately approved closed legacy exception set contains exactly these extension-relative
paths; no directory, basename-only or pattern exception is implied:

```text
bridge/package-inputs.mjs
plan/parallel-contracts.mjs
storage/parallel-protocol.mjs
types/parallel-conformance.ts
test/parallel/native-contracts.mjs
test/parallel/fixtures/native-capabilities.json
test/parallel/fixtures/native-rpc-failure.json
test/parallel/fixtures/native-tools.json
test/parallel/fixtures/sdk-identities.json
```

This preserves the explicitly planned `package-inputs.mjs` name and historical identities without
relaxing the general naming rule. Structural tests reject every unlisted compound filename.

| Boundary | Responsibility |
| --- | --- |
| `extension.mjs`, `canvas.mjs` | Native registration and per-panel lifecycle |
| `data.mjs`, `digest.mjs`, `errors.mjs`, `prompt.mjs` | Cross-cutting unknown-value decoding, canonical serialization, shared canonical-input error identity and safe prompt encoding |
| `operations.mjs`, `application/` | Explicitly wired application services: approval, tasks, verification, cancellation, inspection and repository requests |
| `plan/`, `plan/schemas/` | Pure plan transitions, scheduling/delivery rules and closed persisted-document validation |
| `analysis/` | Planning inputs, frozen verification inputs and fail-closed verdict aggregation |
| `factory.mjs`, `factory/` | Repository service composition, attributed replay, governed knowledge, sealed candidates, observation ordering, assurance and retention |
| `bridge.mjs`, `bridge/` | Owned plan bindings, deterministic drafts, immutable outbox receipts, evidence gates and dispatch context |
| `storage.mjs`, `storage/`, `factory/storage.mjs` | Plan records, shared anchored SQLite transactions and repository ledger/archive storage |
| `workflow.mjs`, `native/` | Native Workflow reads, controls, reservation discovery and validated result import |
| `workflows/`, `review/`, `research/` | Native recipes, with supplied-evidence preparation, claim readers and report rendering separated from orchestration |
| `tools.mjs`, `tools/`, `requests.mjs`, `hooks/` | Tool schemas/results, unknown-input decoding and conservative opt-in guardrail classifiers |
| `server.mjs`, `server/` | Capability-protected loopback transport, bounded HTTP framing, explicit action mediation and a closed asset registry |
| `renderer/` | Native ES modules for transport, actions, monotonic snapshots, the single serialized reader and isolated plan/factory/workflow views |
| `types/` | Separate JSON, plan, repository, analysis and native-port contracts; offline SDK declarations and compile-only guards |
| `test/` | Responsibility-scoped suites and reusable fixtures; suites never import other suites |

Composition passes named, narrowly typed dependencies rather than a shared mutable context.
The plan/factory rules do not import application or transport code. Factory code and its transitive
runtime dependencies do not import analysis; analysis may consume factory definitions. The common
digest primitive and its unchanged error definition therefore live at the root, not under analysis.
Browser modules import only other registered browser assets. Structural tests enforce these
directions, acyclic runtime imports, recursive checking and exact asset coverage.

`analysis/verdicts.mjs` owns verdict aggregation; `bridge/pinning.mjs` owns context/evaluator pinning.
Both consume the common pure `factory/criterion.mjs` evaluation criterion helper, which reuses the
unchanged canonical visual criterion. Native dispatch injects its canonical `dispatchReservation`,
`createdChild` and class-identity-preserving `classifyError` functions; application orchestration
does not import the native layer or duplicate its decoders. `WorkflowAnalysisPort` requires
`isMissingWorkflowRun` and `isTerminalWorkflowStatus`; root composition delegates them to native
guards without exposing mutable terminal-state data.
Tests share one `test/workflows/` directory and use singular `fixture.mjs` for scenario data.
`test/factory/accessors.mjs` holds the typed service/export accessors.

Source names are not public identities. `workflows/registry.mjs` explicitly maps `deep-research`,
`review-queue` and `security-review` to `research.mjs`, `review.mjs` and `security.mjs`; native workflow
IDs, tool/action names, journal keys, durable record formats and historical provenance stay unchanged.
Copied proof implementations and independent evaluators live under `test/proof/`. Historical artifact
names and captured generation-package references are not rewritten to pretend they originated at
the new source paths.

## Dynamic workflows

| Workflow | Purpose |
| --- | --- |
| `plan` | Create, critique, synthesize, and verify a dependency-aware plan |
| `plan-repair` | Recover one eligible owner-bound semantic rejection without relaunching the original plan |
| `verify` | Produce the final fail-closed evidence verdict |
| `audit` | Audit files for a specified concern |
| `deep-research` | Heavy, opt-in multi-angle research with independently verified findings and retained partial evidence |
| `review-queue` | Triage correctness and maintainability risks in supplied diffs |
| `security-review` | Run a multi-perspective static security review |
| `triage` | Classify and prioritize tickets |

The `plan` workflow defaults to two hours (7,200 seconds) of accumulated active
execution across attempts. Its concurrency, agent-count, and credit limits are
unchanged. Other workflows retain their own limits, and existing runs retain
their approved limits until an explicit override is approved.

All planning stages share the same task-graph rules. The read-only final verifier
has no authored criteria or files: it evaluates the implementation tasks' criteria
against the committed integration snapshot. Critics must not invent a conflicting
verifier contract or bypass required commit authorization.

Generation schemas and instructions use the central plan field bounds, including the
2,000-character acceptance-criterion limit. An invalid synthesis gets one bounded repair agent
in the same native run, with its exact diagnostic, original candidate, canonical input, pinned
authority, decomposition and critiques. Repair must conserve requirements, task identities and
dependency intent, not truncate or drop content. The repaired candidate passes the same domain
validator and independent verifier; missing or invalid repair never promotes a fallback plan.
The result's `synthesisRepair` retains the rejected original, diagnostic, repair candidate and
repair validation issue (or `null`). Resolved diagnostics remain history rather than unresolved
`issues`; uncertain conservation or missing review keeps `needs-review`. Valid synthesis adds
no repair agent, and native replay reuses completed agents without restarting planning.

Invoke these workflows with `run_dynamic_workflow` and inspect the returned `runId` with
`dynamic_workflows_manage` (`inspect-run`). The five general workflows use the native workflow
lifecycle directly and never mutate Foundry plan state. When an explicit capability context exists,
`foundry_capture_analysis` retains a matching current-session report as non-governing observations,
including uncertainty and exact report/run provenance. Multi-repository or oversized reports need
deliberately scoped knowledge entries, not indiscriminate attachment to one capability.

Ordinary research uses direct search, page retrieval, or documentation inspection. Needing sources,
current information, recommendations, or a simple comparison does not justify `deep-research`.
Reserve it for explicit deep/exhaustive research requests or a substantial investigation the user
has approved escalating; do not turn every question into a multi-agent run.

Definitions live in `workflows/` and register through `defineWorkflow` and `joinSession({ workflows })`.
The control-plane adapter uses `session.workflow` for inspection, pause, resume, and cancellation.
Foundry binds observed verification run IDs before waiting; ordinary diagnostics use those bindings,
while launch recovery and completion/cancellation retain collision checks.

Plan and verification imports use native `waitForRun` for active runs instead of requiring a
separate wait/inspect/retry cycle. Interrupting the tool stops waiting, not the Workflow.
Paused or failed runs still require explicit recovery; verification rechecks revision and
reservation ownership after waiting, and completion still requires manual approval or its separate
recorded completion delegation.

### Pause, resume, and checkpoints

Use the board's Pause/Resume buttons or `foundry_control_workflow({ runId, action: "pause" | "resume" })`
only when the user requests it. Resume checks native `canResume`, keeps the same run, journal,
arguments, accounting, and limits, and waits for the next settled attempt. Board updates remain live
while that request waits, so Pause remains available once execution starts. These controls do not
pause App task sessions, import results, grant approvals, or start replacement runs.
Interrupting the tool or closing the board stops its wait, not the resumed workflow.

Verification controls also require `planId` and `expectedRevision`; the run must be the unique owner
of the running plan's active reservation. Controls are unavailable during cancellation or after the
reservation has been consumed. Reached limits require an explicitly approved increase through native
`run_dynamic_workflow` or the research time-review decision below, not an automatic retry with higher limits.

All five standalone recipes accept `pauseBeforeWork: true` in their object arguments. The default is
false, and existing string/array shorthand still works. Research pauses after angle planning and
security review after orientation; audit, triage, and review queue pause after preparing their bounded
work scope but before bulk agents start. Read the logged scope before resuming.

Prepared scopes use versioned native `step` journals; agents retain the SDK's own memoization.
The one-shot `pause` checkpoint stops the first attempt and returns on resume. The workflow body
restarts, replaying completed work; interrupted agents may need to run again. These checkpoints are
not Foundry approval records. The `plan` and `verify` recipes keep their existing approval protocol.

### Research time review

Unfinished deep research requests a native checkpoint one minute before its approved active-time
ceiling: normally at 59 minutes of the default hour. This uses native accumulated usage, including
previous attempts, rather than a new hour for each resume. Paused time is excluded. Explicitly
unbounded runs have no time-review timer, and completed research does not pause.

On hosts supporting native elicitation, Foundry asks **Extend by one hour**, **Keep paused**, or
**Stop**, even with the board closed. Extension adds exactly 3,600 seconds to the existing total
timeout and resumes the same run; it never changes credit, concurrency, or agent-count limits.
Dismissal leaves the run stopped. Stop cancels only that workflow. Completed agent results remain
journaled, but interrupted agents may repeat. The original hard timeout remains a final guard.

Observed active research runs use the SDK's abortable `waitForRun`, whose durable rereads recover
missed checkpoint invalidations. Decisions are checked against fresh native state before dispatch. Duplicate notifications do not
repeat a decision within the provider lifetime, and a pending resume does not block the next hourly
question. Provider restart can rediscover recent paused checkpoints and ask again; it never resumes
them automatically. If the hard timeout wins, recovery is offered only for research observed active
by this provider, not every historical timeout.

Unsupported hosts receive explicit coordinator guidance; native dialog errors leave the run stopped
and are reported rather than silently treated as acceptance. The
[recovery instructions](../../skills/deep-research/references/execution.md#hourly-time-decisions)
cover manual continuation. Ordinary board Resume does not add another hour.

### Workflow diagnostics

The board follows native `workflow.run_updated` invalidations and re-reads current state.
Mutation requests return acknowledgments, not competing state snapshots; one serialized GET queue
owns plan and detail updates. One shared
ten-second refresh also updates live observations while the document is visible and runs are active;
it stops when hidden, inactive, or closed. Native revisions are separate from plan revisions, and
`observedAt` orders live observations within an equal revision.

Summaries show AI credits, accumulated active time, budgeted agent admissions, effective concurrency
limits, and typed failure information. Credits are `nanoAiu / 1,000,000,000`, not currency. Paused time
is excluded from active duration, and admissions are separate from direct-agent counts. Unapproved,
unbounded, and unavailable limits remain distinct. Soft-limit excess and incomplete accounting are
shown explicitly rather than clamped or presented as a final bill.

The repository factory section shows capability boundaries, accepted versus non-governing knowledge,
reasons/provenance, sealed candidate comparison, current assurance gaps and renewal. Repository
revisions are independent of plan and native-run revisions. The same serialized GET queue owns all
three; the visible board refreshes repository evidence even when no native workflow is active.
Native/fallback candidate decisions call the same business rules as agent tools, with explicit actor,
reason, expected repository revision and incumbent guards. No mutation response owns a competing view.

Expand a run to fetch native phases, direct-agent status, requested/resolved models, activity, and
progress. Older progress uses native cursors with at most 100 records per page; only the selected
page is retained. Live refresh preserves disclosures, keyboard focus, scroll position, and a selected
historical page. These observations are read-only and never change a plan revision.

Recent history is bounded to 20 terminal runs plus active runs;
the current plan's verification run is included even outside that window. Unrelated verification
runs are excluded from both listings and detail reads. Disconnected views refresh on SSE reconnection;
Refresh is also available.
`foundry_get_status` exposes the same view with `includeWorkflows: true`; unavailable native state
is reported separately and never prevents reading the plan. Listing runs does not eagerly load details.

### Board decisions

Hosts advertising `session.capabilities.ui.elicitation` use native confirmation for retry/pause/resume
and a single structured form for plan/completion approval or cancellation. The server collects the
decision directly; browser fields cannot substitute for host acceptance. Explicit actor attribution
is still required and is not an authenticated identity supplied by the dialog.

Unsupported hosts retain browser prompts and confirmation. A supported native UI failure is reported,
not silently retried through the fallback. Decline, dismissal, stale revisions, and abandoned requests
before dispatch make no mutation. Closing a board cannot forcibly dismiss the SDK dialog, but a late
answer cannot dispatch an action. Once dispatched, closing stops waiting, not the operation. Pending
resume does not block a subsequent Pause. Existing plan approvals and cancellation reconciliation remain
authoritative; native dialogs do not add confirmations to agent-facing tools.

### Structured output and workload bounds

Every workflow declares an SDK argument schema so structurally malformed model invocations fail before
approval or credit spend. Workload bounds count actual agent admissions: the SDK's structured-output
correction turns reuse the same agent, consuming time and credits but no additional agent slots.
Independent review, correction, and verification stages still need separate agents.

Model contracts contain authored content and judgments; code assembles immutable planning input,
canonical coverage, evidence IDs, and correction identities. Structured output objects declare explicit types, all fields as required, and
`additionalProperties: false`. Flat audit/review-queue verification verdicts, security verdicts, and
ticket classifications fit the provider-native schema subset on eligible model routes. Array-heavy
result contracts retain their existing shapes and the SDK's parsed/validated fallback rather than
adding conversion layers.
Runtime schema validation is structural, not full JSON Schema validation; semantic and evidence
checks remain necessary on every route.

Deep research batches atomic claim verdicts within each angle, preserving supported findings while
distinguishing incorrect claims, inaccessible sources, and insufficient evidence. Only unresolved
findings get one targeted correction and independent re-verification. Synthesis receives supported
claims and their source evidence, not unverified drafts; rejection reasons, correction history, and
stage failures remain in the returned report. The supported findings ledger survives both successful
and failed synthesis; narrative is presentation, not its authority. Audit likewise retains verified
findings when its narrative stage fails.

Explicitly supplied `drafts` can recover saved research without repeating planning or broad discovery.
The existing limits are unchanged: capacity is reserved for independent correction and reverification,
allowing up to nine fresh angles or twelve saved drafts. Oversized recovery input is rejected, not
truncated. See the
[deep-research skill](../../skills/deep-research/SKILL.md) for approval and recovery rules.

The review queue pipelines each PR through review and verification independently. A PR must still
finish every chunk review before it can enter verification, and only complete, clean evidence that
passes the configured policy can be recommended for approval. The final queue report waits for all
PRs; pipelining does not reduce reviewer count or expand the supplied-evidence scope.

Review covers correctness and maintainability. The report includes observed line changes and
actionable concerns rather than quality scores; counts alone do not block approval. Material
concerns and incomplete evidence require human review. The workflow remains diff-only, without
additional checkouts, analyzers, or reviewers. Start with the
[review-queue skill](../../skills/review-queue/SKILL.md); load its local references only when adjusting
queue options or interpreting the detailed review criteria and metric limits.
Pass the fetcher's complete `{prs, fetch}` object as workflow arguments. Per-account revision,
completeness, assignment, and failure records are authoritative inputs; a `"full diff"` string alone
cannot establish completeness. Incomplete fetch output is retained with a nonzero exit status.

## Plan model

Discovery/generation plans contain one or more implementation tasks and exactly one final verifier task. Every
implementation path converges into the verifier's single implementation dependency. The final
implementation task must deliver a commit or PR; the read-only verifier reports canonical evidence
for every acceptance criterion plus `final-integration` and `workspace-integrity`.

That topology applies to discovery/generation. Re-evaluation uses a separately owned verifier-only
plan with an immutable external candidate target, selected pinned evaluators, and no fabricated
implementation task. It uses the same approval, reservation, attachment, cancellation and native
verification machinery while preserving the original generation binding, delivery, completion and
selection. Failed factory work offers fresh generation for code changes or read-only evaluation for
unchanged-code assurance repair; ordinary generation retry cannot overwrite a delivered candidate.

Human modalities and judgment procedures have an explicitly attributed human path. App reports
cannot satisfy them; pending human evidence is visible and holds final verification. Recording a
human judgment requires the actual `judgmentId`, stable `sourceRef` and `performedAt`, independent of the
publication receipt `id`; replaying or retiming publication is not a new judgment. These identities
remain claims, not authenticated-human attestation. Native verify
reservations freeze governing definitions, non-governing rationale and human evidence, rather than
substituting current context on resume. Existing critics and independent review also perform bounded
conceptual simplification review; proposals conserve named external meaning/evaluations and remain
non-governing knowledge until explicitly accepted.

Foundry owns:

- optimistic plan revisions and explicit approval gates;
- reserve-before-create task attempts and immediate App-session attachment;
- explicit same-session branch-rename reconciliation through `foundry_attach_task.rename`,
  retaining the attempt, start time and a bounded audit history. Supply the recorded old branch,
  App-observed canonical worktree path, actor and reason. The old ref must be absent and the new
  branch must have a direct post-attachment rename in its latest 256 reflog entries (Git timestamps
  have one-second precision). A unique local linked worktree in the same repository is required;
  an existing verifier pin or prior rename worktree identity cannot change. A pinned worktree may
  already be detached for exact-commit verification, provided the renamed branch is not checked
  out elsewhere. Initial implementation
  attachments do not pin worktrees, so retrospective reconciliation corroborates local Git evidence
  and the caller's App-session association, not authenticated identity. Missing evidence, remote
  worktrees, replacement sessions, terminal/cancelling attempts and ordinary branch mismatches
  remain rejected; never rename App-managed branches with raw Git to repair bookkeeping;
- delivery requirements for branches, commits, and pull requests;
- causal session inventories for retry and cancellation safety;
- canonical evidence, correction waves, and final workflow verification;
- SQLite transactions, cross-process revision checks, and deterministic recovery projections;
- session-local guardrails and the interactive `foundry-board` canvas;
- a bounded, revisioned activity timeline rendered from the authoritative plan document.

Foundry planning/verification Workflow agents perform analysis only. App-native project attempts
own repository mutation and may use explicitly authorized bounded runtime workers without
transferring ownership or creating new App tasks.
Task readiness is derived from approved state and completed dependencies, not persisted as a
separate mutable status. `foundry_get_status` exposes one scheduling view with ready and dispatchable
IDs, scope holds, and launch guidance.

## Persistence

Session execution authority is `files/foundry/foundry.sqlite` under the Copilot session workspace.
Portable capability authority is `.foundry/repository.json`, pointing to immutable, content-addressed
JSON objects under `.foundry/objects/`. Its logical repository ID travels with committed knowledge.
Local execution history and the rebuildable projection remain at
`$COPILOT_HOME/foundry/repositories/<local-checkout-id>/foundry.sqlite`
(default `~/.copilot/foundry/...`). The local ID hashes the canonical Git common directory, so
independent clones do not collide in one runtime store. Sibling worktrees can share that local
history only while their checked-out knowledge heads agree. Neither publication nor migration stages,
commits or pushes files.

Portable objects retain capability/knowledge revisions, accepted contracts, causal links and
historical selection summaries. Raw native reports, worktree paths, active bindings and execution
authority remain local. Reports have explicit opaque statement/source commitments in portable
context; they are not replaced with invented summaries. A fresh clone can reconstruct knowledge
without inheriting native sessions or current candidate assurance. Historical v2 contexts that
needed private report contents remain `historyOnly` and require explicit re-acceptance before
generation.

Publication uses a private Git-common-directory SQLite mutex, immutable objects and an atomic head.
The local journal is a durable outbox: `factory_publication_pending` can recover publication after a
restart without repeating the mutation. A divergent checked-out head holds new work rather than
overwriting another branch. Existing owned attempts can still record terminal results and cancel
against their local pinned history. Legacy local ledgers require attributed `foundry_migrate_factory`;
the original journal and historical seals remain intact. Migration cannot replace divergent knowledge.

The local stores use the same private-artifact SQLite safety and synchronous transaction implementation in
`storage.mjs`, including symlink/hard-link rejection, anchored directories/database identity,
revision checks and SQLite rollback. Native `node:sqlite` (Node.js 22.13+) is required; unsupported
runtimes fail explicitly. No transaction crosses a Workflow wait or external App action.
Activation is session-local metadata; ordinary hooks do not load the full plan.

Factory authority is an append-only, current-format event ledger replayed through its business rules.
Accepted revisions/decisions are immutable; later incidents/expiry change support projections, not
historical outcomes. Previously valid v2 receipts and their accepted selections remain readable under
their original publication rules. Current assurance coalesces duplicate origins at their earliest
claimed observation; prospective publication and selection enforce the current rules. Views are bounded.
The former 8,192-event lifetime ceiling is explicitly replaced
by bounded records and archive pages: 128 KiB per event, 8,192 events / 32 MiB per archive segment,
and 256 events / 4 MiB per transfer page. Appends retain headroom through transactional automatic
rollover. Retirement hides superseded default views; storage compaction relocates/compresses exact
event ranges without deleting logical knowledge, reasons, decisions or evidence. Content integrity is
checked on decode. This is storage maintenance, not conceptual simplification or a quality metric.

Whole current-format JSON transfers remain bounded to 32 MiB. Larger histories use pinned export
pages and restartable staged import; no partial import becomes authority, and explicit abandonment
retains the received staged data. Archival and new appends preserve the pinned logical sequence.
No user artifacts are deleted; SQLite file size may not shrink. Capacity is governed by explicit
record/page bounds and available SQLite storage, not a lifetime event counter that blocks receipts.

The session plan is a durable outbox for factory learning and execution receipts. Publishable receipt
invariants are prevalidated before terminal persistence, so wrong-commit or impossible-provenance
reports do not strand completed attempts. Bounded rejected reports can remain non-governing learning.
A valid task may still commit
before its repository receipt; `factory_sync_pending` explicitly reports that state and
`foundry_sync_factory` recovers idempotently from exact task/attempt/commit/run identities. Draft
assembly reserves its repository binding before creating the session plan and can recover either
side of that commit boundary. Pending state uses the complete deterministic receipt enumeration.
Valid delayed receipts remain historical evidence: actual observation time, not publication order,
determines current support, and conflicting newest observations fail closed. Read-only evaluation
plans complete against their own pinned observations without overwriting newer assurance or later
renewal signals. Outstanding evaluation bindings hold candidate retirement across retries; terminal
completion/abandonment releases the hold, but replaying an old completion does not release new work.
Terminal cancellation publishes abandonment before learning and does not require invalid assurance
to be published. This is not a distributed transaction or a parallel orchestration runtime.

Old JSON plans, activation files, and lock artifacts are ignored and left
untouched; there is no migration or backward-compatibility layer. Explicit JSON import/export
supports the current format only. Import preserves the supplied plan state but does not launch
external work, activate a plan, or bypass subsequent ownership checks.
Factory import replays current-format authority only into an empty store for the same canonical
repository. Foreign session plans remain inspectable but cannot activate or control native work.
This plan-import restriction is distinct from repository knowledge migration and normal Git cloning.

## Tool surface

Tools share the native `foundry` namespace for grouped discovery on supporting model/provider routes.
Other routes keep flat functions. The SDK's default automatic deferral remains in use;
there is no separate catalog state machine.

| Area | Tools |
| --- | --- |
| Capabilities and knowledge | `foundry_get_factory`, `foundry_define_unit`, `foundry_record_knowledge`, `foundry_accept_contract`, `foundry_capture_analysis` |
| Candidates | `foundry_prepare_candidate`, `foundry_create_factory_plan`, `foundry_record_delivery`, `foundry_record_evaluation`, `foundry_decide_candidate` |
| Assurance renewal | `foundry_create_evaluation_plan`, `foundry_record_human_judgment` |
| Renewal and retention | `foundry_record_signal`, `foundry_retire_artifact`, `foundry_compact_factory`, `foundry_sync_factory` |
| Factory interchange | `foundry_migrate_factory`, `foundry_export_factory`, `foundry_import_factory`, `foundry_export_factory_page`, `foundry_import_factory_page`, `foundry_abandon_factory_import` |
| Planning | `foundry_prepare_plan`, `foundry_create_plan`, `foundry_submit_plan`, `foundry_approve_plan`, `foundry_plan_approval_delegation` |
| Inspection | `foundry_get_status`, `foundry_list_plans` |
| Interchange | `foundry_import_plan`, `foundry_export_plan` |
| Native workflows | `foundry_control_workflow` |
| Recovery | `foundry_quarantine_plan` |
| Tasks | `foundry_reserve_task`, `foundry_attach_task`, `foundry_complete_task`, `foundry_retry_task` |
| Verification | `foundry_prepare_verification`, `foundry_complete_verification` |
| Cancellation | `foundry_cancel`, `foundry_cancel_verification_run`, `foundry_finalize_cancellation` |
| Hooks | `foundry_activate_plan`, `foundry_deactivate_plan` |

The coordinator protocol lives in
[`../../skills/foundry/SKILL.md`](../../skills/foundry/SKILL.md).

Activation and plan storage are local to the current Copilot session. The shell classifiers are
conservative friction, not a sandbox or a complete shell parser; indirect execution remains subject
to the host permission boundary. Deactivation removes an unreadable activation record and reports
that repair instead of leaving the session stuck behind corrupt metadata.

Session-plan SQLite uses schema 3. Historical schema 2 introduced durable approval grants and
irreversible revocations in `approval_delegations`; schema 3 adds `technical_authorizations`.
Transactional migration from schema 1 adds both tables, while schema 2 adds only
`technical_authorizations`, retaining existing grants, revocations, plan documents and activation.
This is separate from factory SQLite schema 4 and its logical-format/seal compatibility. Approval
checks its grant in the same transaction as the plan revision update; technical decisions also
retain their exact owner-commit marker there. Exported plan receipts are historical evidence,
not live grants or restorable publication markers.

Coordinator context is supplied on activation and session start. Ordinary successful Foundry tool
calls do not add repetitive reminders; activation, deactivation, unreadable-state, and failure
guidance remain available. This does not change permission checks or revision enforcement.

New task reservations return a separate setup-only `initialization.kickoff`. Native creation starts
the backing child; the coordinator waits for its acknowledgement, verifies the same owner/identity
and worktree, then attaches with the pre-create immutable `bootstrap.baseCommit` and observed path.
Git corroboration rejects wrong/dirty/substitute worktrees or base drift. Only then is the unchanged
task prompt sent with `coordinator_only`. Setup is not OS-enforced inactivity; failed or uncertain
creation/delivery keeps the reservation occupied. See the [dispatch protocol](../../skills/foundry/references/dispatch.md).

The board can request cancellation, but the coordinator must still stop owned App sessions, cancel
the authoritative verification workflow run, and finalize with a fresh causal inventory.

Open the canvas with `{repositoryPath, unitId?}` for explicitly read-only repository inspection
without a session plan or native ownership. `{planId}` opens the operational plan board;
`readOnly: true` disables its mutations. Source-only previews can call `startServer` directly with
`repositoryPath`, `workspacePath`, the shared operations service and a subscription callback,
without loading/reloading the installed extension. Historical rejected/superseded candidates retain
their assurance details but do not produce actionable recovery banners. Contract summaries identify
their capability and current versus historical acceptance.
The returned loopback URL is a secret per-instance capability. Bootstrap, relative assets, API and
SSE reads all require it, in addition to loopback/Host/Origin checks; mutation requests still require
the action token and explicit decision rules. Responses set `Referrer-Policy: no-referrer`.
Do not publish the capability URL. Restarting/closing the preview invalidates the old instance.

Plans have one strict current shape. Activity entries contain the event, timestamp, and resulting
revision; correction approval also retains its actor and prior verification run ID.
`foundry_list_plans` reports invalid-record details. After explicit approval,
`foundry_quarantine_plan` preserves the raw document, revision, requester, and reason transactionally
and returns a quarantine ID while releasing the plan ID.

## Validation

```sh
node --experimental-vm-modules --test '.copilot/extensions/foundry/**/*.test.mjs'
```

The quoted recursive glob discovers every suite after directory moves. The VM flag is only for the
isolated browser fixture: it links and executes the real ES module graph without transpiling or
concatenating scripts. The browser itself uses native modules and needs no bundler or extra runtime.
HTTP tests fetch every registered asset through the secret capability path and reject other files.

With TypeScript and compatible Node.js type declarations available, check every owned JavaScript
and TypeScript file, including the renderer, declarations, compile-only regressions, subprocess
fixtures, and nested `test/proof/` implementations:

```sh
tsc --project .copilot/extensions/foundry/jsconfig.json
```

The configuration enables `strict`, `checkJs`, and declaration checking (`skipLibCheck: false`).
There are no `noImplicitAny` or catch-variable exceptions and no excluded test directories.
Compile-only guards in `types/guards.test.ts` also fail if implicit-parameter or unknown-catch
checking is disabled.
Runtime and renderer modules use explicit `.mjs` semantics; ambient SDK declarations remain
declarations rather than script globals. When using a scratch compiler, pass its `node_modules/@types`
directory with `--typeRoots`.

The offline SDK declarations are not the source of truth. Check the same complete source inventory
against the installed SDK, with the offline module replaced rather than merged into it:

```sh
node .copilot/extensions/foundry/types/check.mjs \
  "/Applications/GitHub Copilot.app/Contents/Resources/copilot-sdk" \
  "/path/to/node_modules/typescript/bin/tsc" \
  "/path/to/node_modules/@types" \
  "/path/to/declaration-dependencies/node_modules"
```

The last argument is optional when the SDK's declaration dependencies resolve normally. An app
bundle that ships declarations without `vscode-jsonrpc` needs compatible declaration dependencies
in a scratch directory; `vscode-jsonrpc@10.0.0` supports the current iterator declarations.
This does not install an SDK dependency in Foundry, change runtime resolution, reload the extension,
or launch workflows. The command also checks the offline tool, canvas, hook, workflow, event,
elicitation, and logging contracts against the actual API and removes its temporary project.

The known native `sdk-conformance.ts` `TS2344` remains a failing SDK-conformance gap, not a pass.
Retain it and any new diagnostics separately. Source fixtures and offline checks do not establish
native App no-elicitation, permission/restart/platform behavior, installation or full-factory
acceptance; those require separately authorized host evidence.

DTOs are scoped in `types/json.d.ts`, `types/plan.d.ts`, `types/factory.d.ts`, `types/analysis.d.ts`
and `types/workflow.d.ts`; there is no shared barrel. JSON, command, journal, structured-agent, HTTP,
and IPC inputs remain unknown until their relevant readers or validators check them. The renderer's
`contracts.mjs` validates only the read-only fields it consumes, without claiming to authorize
mutations. Native workflow summaries carry `currentPhase.id` and `ordinal`; phase titles belong
to detailed phase observations, not the summary identity.

The few type assertions are confined to checked record-key construction, the array-keyed record
index cache, and graph membership/numeric invariants in the copied proof implementations.
Those proof copies retain their algorithms, including the intentionally mutating initial policy.
Invalid-input tests use local, explained `@ts-expect-error` boundaries; no file disables checking.
Tool results use namespaced telemetry, and workflow inspection preserves typed failure and pause
metadata. A paused attempt is settled in the SDK, but is still not terminal evidence for Foundry
cancellation.
