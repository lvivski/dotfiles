# Native adapter source integration

This is the bounded `foundry-native-bridge-v2` source reference, not activation,
host attestation, a capability contract, or replacement acceptance. The source
baseline is `202e694bb05b336ebb3684b122ac75deb578c916`. The exact independent
deliveries are host `3e84e287eb290799de57fe972b2d802884ff82bb`, TechnicalExecutor
`22c23c9eee266f838b63aa345247dc87d22dace5`, and SDK
`33fc0a9d2c5d924a48005c30ba0fb3743c5f1b7f`. Integration preserves all three as
ancestors. No model, retention, evaluator, shared storage, or root registration
change belongs to this increment.

Paths below are relative to `.copilot/extensions/foundry/`. Check aliases resolve
to named cases below, not to assumed coverage. The complete retained operation
index and criterion crosswalk accompany the immutable integration handoff; they
preserve original leaf reports and raw failures. Source tests use real confined
Git/SQLite/Node processes and **simulated** App identity, permission, transcript,
review and visual observations. They do not prove an available production provider.

## Supported partial runtime: current boundary

`foundry-supported-runtime-v1` narrows the current increment to supported partial
runtime, not the full lifecycle. Its pinned production route is the public
`session.rpc.tools.execute` entry point, identified as `extension-rpc`, for narrowly
closed `run_dynamic_workflow` and warm `coordinator_only` `send_session_message`
bindings only. The existing trusted workflow-result decoder must remain forwarded
through root native dispatch. Do not invent another launcher, generic executor or
automatic alternate-route replay.

`native/supported-runtime.mjs:createSupportedRuntime({getSession})` supplies the closed
public-RPC callbacks `workflow` and `warmHandoff`, plus `capabilities()`, `host(access?)`
and `completionEvent(input,retentionFor)`. `extension.mjs` binds `runtime.host` and
`getNativeRuntime`. The default host state is `partial`, not `available`, preserving
omitted-decomposition legacy behavior. `host(access)` binds only with separately
trusted complete current `NativeHostAccess`; callbacks do not prove observers or
fabricate authenticated project, setup or child access.

`getStatus` adds a `nativeCapabilities` projection. Partial parallel dispatch returns
`parallel_identity_unsupported`, retaining operation, route, prerequisite, disposition
and capability records. The existing repair launch is the production consumer of
bound `runtime.workflow` through `getWorkflowRoute`; its existing journal, raw result
decoding and reconciliation remain in place. This is not support for every adapter route.

Advertised names and metadata are not callable bindings. A callable binding is not
observed admission; admission is not a successful effect or observed execution.
Normal account/resource permission and exact result correlation remain required.
Cold coordinator-only first delivery fails before bootstrap and remains unavailable;
warm messaging does not establish a cold bootstrap path. Omitted strategy retains
the existing reserve/setup/corroborate/attach/unchanged-handoff protocol, not an
idle-first worker promise.

Missing current project/identity and authenticated setup, child, effect, recovery,
review and contributor observation providers prevent the automatic parallel
operations that depend on them. They do not universally prevent invocation of a
supported workflow. Bounded TechnicalExecutor and authenticated observations remain
absent. Preserve the canonical once-only intent/start/outcome and complete original
receipts after denial, interruption, malformed results or persistence failure.
Reconcile only the original operation; never resend an uncertain effect.

Root `completionEvent` is constructor-only. It validates native owner invocation,
then passes `{repositoryPath,eventId}` to the existing canonical
`retentionFor().completionEvent`. Missing persistence throws
`retention_persistence_unsupported`. No notification subscription or automatic
`completeTask`-to-archive path is installed by this binding; see [retention](retention.md).

The inventories and check tables below retain the original native-bridge baseline,
including its workflow-only RPC and missing-decoder/common-wiring status. Those are
historical scope statements, not the current partial-runtime route definition above;
do not rewrite their original evidence as a pass. Source recording-boundary checks
are not live-host authenticated evidence, installation or full-factory acceptance.
This boundary description records no new test execution and makes no UI/visual claim.

## Route, identity and permission profiles

| Profile | Contract and authority | Support and later proof |
| --- | --- | --- |
| C: current context | `native/observations.mjs:bindNativeContext` pins current workspace/session/project/repository, outside Workflow/subagent execution; rechecks after awaits. `readPlan` and `taskPolicies` are trusted canonical readers, not tool arguments. | Source validation only. Missing identity holds. Installed current-invocation binding remains W below. |
| P: primary App | `native/host.mjs:NativeArguments` is a closed operation-specific subset of offered public inputs in `test/parallel/fixtures/native-tools.json`. Actual callbacks must enter the normal App permission pipeline. `native/admission.mjs:createOfferedDispatchTransport` decodes actual SDK string/ToolResult envelopes and retains raw source/correlation. | Primary App calls have historical admission evidence, not an installed in-process callback binding. No callback means unavailable. C and W apply to every P row. |
| R: extension RPC | `CopilotSession.rpc.tools.execute({name,arguments,toolCallId})` is an offered-tool call, not blanket permission. `createRpcWorkflowRoute` binds only `run_dynamic_workflow`. | All eight other adapter routes remain unavailable, even with matching metadata or primary callbacks. The retained disabled session-management result is not repaired by this source. No fallback or automatic replay. |
| O: observation | Private `Capture {context,subjectDigest,capturedAt,source,complete,value}` is a trusted-provider validation envelope, **not an offered public API**. It binds the unchanged complete request, fresh canonical time within the read, source, completeness and current attempt/delivery. | Operation-specific providers are missing as detailed below. Caller JSON, imported history, idle notifications and a claimed complete flag cannot authenticate a provider. |
| I: input | `InputPort` and `ConsumerEntry` in `types/parallel.d.ts`; canonical `bridge.packageInputs` and `bridge/package-inputs.mjs` retain all producer commit/path/mode/digest identities and successful attachment/handoff journal receipts. | Source composition uses the real materializer. Live child and ordinary write permissions still require W and O providers. No alternate materializer. |
| A: assurance | Canonical governing bindings, exact delivery/producer, complete contributors and all four review modalities feed `analysis/assurance.mjs` and `bridge/evidence.mjs`. `factory/visual.mjs` owns native/reference report validation. | Read-only source assessment, not evaluation execution or human acceptance. Missing/failed/stale/mismatched UI evidence stays non-passing. W, reviews, contributors and visual providers remain required. |
| T: technical | Unchanged `types/factory.d.ts:TechnicalExecutor` input/result; `native/technical.mjs` validates trusted constructor pins, current owner/project/repository/tool-call identity and complete immutable procedures. | Both production routes are unsupported. The only implemented execution port is explicitly `fixture-process`; its permission receipts are simulated. No generic shell/tool proxy or Workflow substitute. |

**W (common wiring and host work):** separately admitted
`foundry-operating-integration-v1` must provide the trusted composition and real-host
proof. Where no public capability exists, separately authorized **App/SDK
host-provider work outside this repository** must supply it first. These are
outstanding dependencies, not newly scheduled tasks or permission grants.
Every row inherits its profile's identity/permission requirements and W unless it
explicitly identifies a more specific missing provider. Historical success never
establishes execution of the joined constructors.

## Complete baseline host inventory

The denominator is all **14** `ParallelHost` members in baseline
`types/parallel.d.ts:144-166`, including optional ports. No absent port is removed
from coverage. Each row identifies the baseline obligation, delivered constructor,
production consumer, source check and specific live hold.

| ID / baseline member | Implementation to consumer; input/result and obligation | Profile / unsupported condition | Checks |
| --- | --- | --- | --- |
| H.session | `bindNativeContext` / `createNativeHost` to `operations.mjs:hostFor`; current owner identity, never name-derived | C; absent/drifting identity holds | H-owner, H-drift, J-held |
| H.executor | `createNativeHost.executor` to `createOfferedDispatchTransport`; nine closed `{name,arguments,toolCallId}` operations, actual raw result | P/R; no operation-specific callback, no invocation | H-routes, H-errors |
| H.offered | Callable-route set to transport `ensure`; returned set cannot enable an unbound operation | C/P/R; metadata is not support | H-routes |
| H.availability | Current route name to supported/unavailable; checked at invocation | C/P/R; disabled RPC stays unavailable | H-routes, J-missing |
| H.taskPolicies | Current plan to canonical task admission policies; no second scheduler | C; foreign/stale revision rejected | H-policy |
| H.decodeCreated | `decodeSessionDetail` / optional decoder to native dispatch; actual canonical worktree/project/both creators, not creation prose | P; missing correlated fresh detail decoder holds preflight | H-detail, J-missing |
| H.decodeHandoff | Optional correlated decoder to native dispatch; `{sessionId,accepted:true}` is queue admission only | P; missing actual admission decoder holds preflight | H-exact, J-missing |
| H.observeSetup | `createNativeObservations` to `corroborate`; exact post-creation assistant acknowledgement/current reservation | O; missing authorized cross-child transcript API, stale/foreign/inexact turn holds before attach | O-setup, O-negative, J-missing |
| H.observeChild | Observation adapter to `corroborate`; child/detail/inventory/after to complete canonical aliases/base/HEAD/clean Git observation | O; public metadata alone lacks complete correlated Git/base/alias evidence | O-child, J-main, J-held |
| H.reconcile | Observation adapter to dispatch effect recovery; exact receipt and complete payload to original raw native result or null | O; missing exact tool/transcript receipt API leaves uncertainty, never replay | O-effects, J-held |
| H.observeRecovery | Observation adapter to `application/recovery.mjs`; current owned attempt to complete session **and run** inventory | O; missing exhaustive native inventory/authoritative terminal observations holds resources | O-recovery, J-recovery |
| H.observeOutcomes | Observation adapter to `operations.mjs:reconcileParallel`; requested effects to exact correlated terminal outcomes; partial result leaves others unresolved | O; missing native effect receipt provider cannot infer success/absence | O-effects, R-late |
| H.readReviews | Observation adapter to native/canonical assurance; current exact delivered plan/task to four explicit applicability/reviewer modalities | O/A; missing independent review-authority provider, stale/foreign/missing modalities hold | O-ui, O-ui-negative, J-main |
| H.readContributors | Observation adapter to assurance; delivered commit to all native/runtime contributors including producer | O/A; missing complete commit-bound provenance cannot use Git names or visible top-level children as substitute | O-ui, O-ui-negative, J-main |

`decodeRun` is an additional adapter return port, not a secretly added baseline
`ParallelHost` member. The unchanged root composition does **not** forward it to
native dispatch. Later common contract/wiring and an actual result decoder are
required before workflow launch can be claimed through that composition.

## All transport and admission routes

The denominator is **nine** names in baseline `native/admission.mjs:offeredNames`
and the native dispatch operations. P means a separately injected primary callback;
R supports only the explicitly bound workflow call. Neither route proves ordinary
native permission merely because a function exists.

| ID / public operation | Public request subset and actual result contract | Constructor / consumer and live limitation | Checks |
| --- | --- | --- | --- |
| R.foundry_get_status | `{planId}` to ToolResult containing `{plan,...}`; exact owned validated plan | `createNativeHost` to `createNativeAdmission.status`; P, unavailable on R | H-admission, J-main |
| R.foundry_reserve_task | `{planId,taskId,reservationId,expectedRevision}` to canonical plan/task/attempt/base/prompt/setup result | Host to admission `reserve`; exact returned attempt/repository; P only | H-admission, J-main |
| R.foundry_attach_task | Plan/task/attempt/revision plus session/branch/bootstrap worktree/base to canonical `FoundryPlan` | Host to admission `attach`; actual postcondition after corroboration; P only | H-admission, J-main |
| R.foundry_complete_task | Unchanged `Request<"completeTask">`, absent optional fields stay absent, to canonical plan | Host to admission `complete` and existing terminal/delivery authority; P only | H-admission, J-main |
| R.create_session | Project/base, worktree, coordinated=true, notify=always, interactive setup-only kickoff to actual creation receipt | Host to native/application dispatch; needs correlated created-detail decoder, setup and child providers; P only | H-exact, H-detail, J-main, J-missing |
| R.get_session | `{project_session_id}` to actual App detail: id/project/both creators/session_type/path/branch plus UI metadata | Host and `decodeSessionDetail` to corroboration; detail alone proves neither setup nor complete Git inventory; P only | H-detail, O-setup |
| R.list_sessions_and_chats | `{}` to actual listing; no invented public completeness/result schema | Host to corroboration/recovery observation; exhaustive correlated capture is separate; P only | H-routes, O-child, J-recovery |
| R.send_session_message | Exact session/message plus coordinator_only=true, immediate, autopilot to actual queue-admission receipt | Host to durable handoff; needs actual correlated decoder; no execution/completion claim; P only | H-exact, J-main, J-held |
| R.run_dynamic_workflow | Exact prepared `{name,args?,limits?}`, including omission, to native run receipt | Host / `createRpcWorkflowRoute` to native dispatch; explicit P or R, never fallback. Missing result decoder/common forwarding holds | H-workflow, H-sdk, A-workflow |

## Dispatch, materialization and assurance boundaries

These are the remaining **nine dispatch/decoding** and **six input/assurance**
baseline obligations, not additional public tools.

| ID / baseline symbol | Implementation and consumer; contract | Profile / hold | Checks |
| --- | --- | --- | --- |
| D.dispatchReservation | `native/dispatch.mjs:dispatchReservation` to application dispatch; closed full reservation, descriptor, required inputs and exact acknowledgement | C/I; missing/truncated/substituted descriptor rejected | D-reservation, J-main |
| D.createdChild | Existing `createdChild` reused by host and live/saved dispatch decoding; closed canonical absolute child | C/P; malformed/foreign child rejected | H-detail, D-reservation |
| D.preflight | Existing native preflight with delivered host; checks required routes and all creation/handoff/setup/child ports before side effects | P/O; absent prerequisite holds before reservation/creation in public composition | J-missing |
| D.create | `createArguments/create/decodeCreated` to journaled creation; unchanged reserved setup, exact project/creator | P; no creation without native admission and supported decoder | H-exact, J-main |
| D.corroborate | Existing native corroboration with delivered observations; exact acknowledgement then fresh detail/inventory/base/clean state | O; idle, ambiguous aliases, partial or stale capture never authorizes attachment | O-negative, O-child, J-held |
| D.handoff | Existing `handoff/decodeHandoff`; full descriptor/delegation unchanged, exact accepted target | P; denied/uncertain result retains original slot, no resend | H-exact, J-held |
| D.launch | Existing `launch/decodeRun`; full prepared launch to actual run ID | P/R; missing decoder/wiring holds, no `workflow.run` or nested launcher | H-workflow, A-workflow |
| D.errors | `DispatchNativeError`, offered result decoder and `classifyError`; preserve actual class/code/disposition/raw receipt, reject lookalikes | P/R; denial definitive, lost/disabled/malformed outcome uncertain, no alternate route | H-errors, J-held |
| D.reconcile | `createNativeObservations` to dispatch/recovery through sole canonical journal/admission authority | O; unresolved effect remains held; no polling, timeout release or archive | O-effects, J-recovery |
| I.resolve | `createNativeInputs.resolve` to existing `createPackageInputs.resolve`; complete producer identities/commit/path/mode/digest to reserved descriptor | C/I; producer/coverage/authority changes rejected, no writes | O-inputs, J-main |
| I.materialize | Native wrapper to sole canonical materializer; resolved descriptor plus authorized entry to exact artifact bytes/modes | C/I; pre-handoff/wrong/dirty/stale entries reject; do not skip current resolution | O-inputs, J-main |
| I.entry | Existing `bridge.packageInputs.entry`; canonical plan/admission/journal to current attached/handed-off consumer or null | I; imported success/history and attachment alone cannot authorize writes | J-main, B-entry |
| I.subject | `createNativeAssurance.prepare` to `buildAssuranceSubject`; exact governing/inputs/delivery/producers and observed review/contributor authority | C/O/A; stale caller plan/attempt, missing modality/provider holds | O-ui, O-ui-negative, J-main |
| I.assess | Native assurance to `validatePackageAssurance` / `visualReport`; immutable evaluator/artifact checks and nested capture max-age/future gate | A; missing native/reference, failed comparison, wrong commit/reference/evaluator or stale capture remains non-passing | O-ui-negative, J-main |
| I.independence | Complete native authors/reviewers to existing assurance subject; runtime helpers cannot review their own contributions | O/A; incomplete/stale/foreign contributor or reviewer provider holds, no empty successful default | O-ui-negative, J-main |

No observer authenticates its own provenance. Complete host inventory, actual
setup turns, authoritative session/run termination, correlated effect receipts,
review authority, all contributors, evaluator execution and live native/reference
capture are distinct missing public-provider obligations. No nondestructive
termination API is presumed. Archiving removes worktrees; it is not cancellation
or a recovery workaround.

## Complete TechnicalExecutor boundary

All **15** T-002 inventory obligations map to the unchanged baseline
`types/factory.d.ts:TechnicalExecutor/TechnicalExecution` and
`application/technical.mjs:renewContract`. `native/technical.mjs` implements the
source checks below. Its output is consumed only through the existing injectable
`executeTechnical` boundary; canonical grant, revocation, protected evaluator and
owner-local `technical_authorizations` publication semantics are unchanged.

| ID | Input/result obligation and implementation | Route/disposition and source check |
| --- | --- | --- |
| T.constructor | `createNativeTechnicalExecutor` retains `(repositoryPath,before,after,agreement; signal?) -> TechnicalExecution` | T; no fixture means `technical_execution_unavailable`; T-exact, T-unavailable, J-technical |
| T.ownership | `binding/context` pins owner/session/project/repository/toolCall, excludes Workflow/subagent, checks each await | T; real current native identity provider still missing; T-owner |
| T.repository | Exact canonical absolute path equals trusted binding and workload before material/execution | T; no caller JSON or imported history authority; T-input |
| T.before-bundle | Complete immutable before commit/root/entry/support/argv/cwd/procedure digest; canonical evaluator resolution | T; only pinned literal Node entry point, not arbitrary tool dispatch; T-material |
| T.after-bundle | Immutable after material; conserve inventory/modes/dependencies/reference/executable except canonical case assertion | T; protected changes reject; T-material |
| T.agreement | Byte/digest-identical canonical agreement; only obsolete cancelled late-denial outcome changes, noncancelled denial/data/focus controls conserved | T; domain permission remains separate; T-exact, J-technical |
| T.signal | Same AbortSignal forwarded; before/after-await checks, cancellation precedes late denial | T; no native termination guarantee for an unresponsive provider; T-cancel |
| T.permission | Correlated authorization before execution, no override/retry/fallback | T; fixture permission is simulated and cannot substitute for canonical delegation or real resource permission; T-permission, J-technical |
| T.result-correlation | Closed result request nonce/digest/context/workload/permissionSource match | T; private protocol is not a public result schema; T-result |
| T.source-environment | Nonempty exact source/environment; fixture evidence cannot claim a native source | T; host attestation absent; T-result |
| T.exit-codes | Actual before exit 1 / after exit 0, not missing/coerced/inferred statuses | T; actual confined source processes only; T-exact, J-technical |
| T.case-results | Every ordered unique case and complete outcome/access/data/focus, no missing/extra/truncated evidence | T; exact controls remain required; T-result, J-technical |
| T.publication | No adapter publish/store/grant API; canonical transactional renewal rechecks authority and preserves marker | T; accepted fixture decision is not real acceptance; J-technical, F-renewal |
| T.primary-app | No offered bounded cancellation-aware evaluator API binds all procedures, native identity, normal permission and complete outcomes | Unsupported; separate App/SDK provider then W in real macOS App environment; T-unavailable, J-technical |
| T.extension-rpc | `tools.execute` is offered dispatch, not the missing evaluator API; disabled session route supplies no executor | Unsupported; same provider/proof owner as above, no fallback; T-unavailable |

## Named source checks and SDK conformance

Aliases below identify exact case names (parameterized groups retain each expanded
case in raw output). Unchanged supporting selector suites are part of the final
union, not replacements for execution of the delivered adapters.

| Alias | Selector / named case |
| --- | --- |
| H-routes | `test/native/host.test.mjs`: host binds every supported primary operation without manufacturing a metadata-based RPC route |
| H-owner / H-drift | Same: all owner/project/repository/workflow/subagent drift is rejected before native invocation; asynchronous ownership drift retains uncertainty and prevents dependent native calls |
| H-errors | Same: canonical native errors keep their class identity and rejected/uncertain/malformed results never replay |
| H-policy / H-admission | Same: policy snapshots use the existing authority and reject stale/foreign plans; all four admission routes retain exact request fields and canonical current attempt postconditions |
| H-detail / H-exact | Same: public get_session decoder requires both creator identities and does not invent create-result metadata; setup-only creation and complete delegation retain exact payloads without permission overrides |
| H-workflow / H-sdk | Same: prepared workflow forwarding preserves nested arguments, limits and their absence on either explicit route; the public SDK workflow adapter invokes only tools.execute with the unchanged complete launch |
| O-setup / O-negative / O-child | `test/native/observations.test.mjs`: fresh sourced setup and canonical child observations flow through production dispatch corroboration; missing, incomplete, stale, future, foreign and substituted observation captures cannot advance setup; child provider rejects ambiguous alias, missing coordinating owner and substituted identity |
| O-effects / O-recovery | Same: outcome and reconciliation readers retain exact attempt, effect, payload, session and run correlation; recovery retains idle and unknown states without inventing terminal, absent or replay evidence |
| O-inputs | Same: canonical materializer through native context preserves full Git inputs and rejects pre-handoff, stale, wrong and dirty consumption |
| O-ui / O-ui-negative | Same: production UI assurance preserves the valid synthetic comparison and full runtime contributor set; UI-applicable native assurance holds SCENARIO without completion or release (all 17 scenarios) |
| D-reservation | `test/native/dispatch.test.mjs`: injected canonical decoders preserve exports and reject malformed reservations and saved children |
| A-workflow | `test/application/dispatch.test.mjs`: workflow exact prepared launch, uncertainty and restart share one durable invocation slot |
| R-late | `test/application/recovery.test.mjs`: observation racing a late outcome is discarded rather than releasing stale ownership |
| B-entry | `test/bridge/packages.test.mjs`: consumer entry syntax alone cannot authorize setup, a different consumer, dirty bootstrap or a different HEAD |
| T-exact / T-unavailable | `test/native/technical.test.mjs`: NB-TECH-01/03/04/05: exact adapter executes immutable old-failing/new-passing workload and preserves every control; NB-TECH-02: production is explicitly unsupported; neither primary tools nor extension RPC can be selected as a fixture route |
| T-input | Same: NB-TECH-01: every input identity is closed and pinned before permission or execution; NB-TECH-01/02: missing native observations, foreign repository bindings and caller-supplied support flags fail closed |
| T-material | Same: NB-TECH-01/04: trusted pins cannot admit another procedure, agreement, executable edit or weakened conservation |
| T-owner | Same: NB-TECH-01/03: all current identity fields are checked before and after each asynchronous boundary; NB-TECH-01/03: caller input, exact request and port substitution are rejected across awaits |
| T-result | Same: NB-TECH-03: closed correlated output rejects missing, duplicate, foreign, truncated and malformed evidence without replay |
| T-permission | Same: NB-TECH-02/03/04: unsupported, denied, uncertain and mismatched calls never publish or retry |
| T-cancel | Same: NB-TECH-03/04: cancellation wins over late denied results and rejections at both boundaries without publication |
| F-renewal | `test/application/factory.test.mjs` and `test/bridge/receipts.test.mjs`: unchanged canonical technical renewal, revocation and publication controls |
| J-main | `test/native/bridge.test.mjs`: NB-JOIN-02/03: delivered host composes canonical admission, exact handoff, Git inputs and independent UI assurance |
| J-missing | Same: NB-JOIN-03: composed dispatch holds missing PORT before reservation or creation (seven ports/routes) |
| J-held | Same: NB-JOIN-03: composed SCENARIO retains original journal and never replays or falls back (denied, uncertain, native-error, owner-drift, incomplete) |
| J-recovery | Same: NB-JOIN-02/07: native recovery observations retain idle and incomplete holds in canonical storage |
| J-technical | Same: NB-JOIN-02/05: canonical technical authority composes the delivered executor without turning fixture permission into a grant |

The actual bundled `ElicitationResult` permits `undefined` values inside optional
content maps. `types/sdk.d.ts` now matches that API rather than narrowing it.
`types/check.mjs` retains the original `ElicitationOutput` assertion and adds exact
shape/value equality; it replaces, rather than merges, the offline shim for native
checking. `types/sdk.test.ts` and `types/parallel-conformance.ts` retain negative
compile-time guards. `test/native/sdk.test.mjs` exercises unchanged production
confirmation consumers: absent/undefined/malformed identities reject; decline/cancel
do not mutate; valid attributed fixtures do. Native compilation is neither a live
dialog nor resource-permission test. SDK/toolchain fingerprints must match the final
target's retained run; future SDK differences require explicit reconciliation.

The joined native check also covers the newly delivered host fixtures. The
workflow adapter depends on the SDK's exact `tools.execute` signature, not its
unrelated tools-management methods. Recording results retain the literal
`success` type; missing SDK tooling is exercised by removing the fixture port at
runtime. Neither negative tests nor SDK declarations are excluded or weakened to
make the composition compile.

## Criterion and original-requirement conservation

All 31 implementation IDs remain: NB-HOST-01..10, NB-TECH-01..06,
NB-SDK-01..06, NB-JOIN-01..09. The retained lossless crosswalk includes original
and successor criterion text, task, dependencies, file scope and exact evidence.
Host criteria map to H/R/D/I rows; technical criteria to T rows; SDK criteria to
the native/offline checker and SDK fixtures; join criteria to the composition
suite, inventory audit, ancestry/scope/provenance manifests and this reference.
T-001/T-002/T-003 remain independent source prerequisites of T-004; T-005 alone
is the separate read-only verification sink. There is no archive-before-verifier
requirement.

| Original ID | Bounded mapping and exact source outcome | Outstanding responsible stream/environment |
| --- | --- | --- |
| OM-01 durable squads | Separately verified source `9b998dcf00c250c2a271645123bfb1fbc7ecc2b4`; not merged here. Native prerequisites only. | Squads/goals source ownership retained; later admitted common integration and real App team operation. Source verification is not live team acceptance. |
| OM-02 goals/evidence rollup | Same separately verified squads/goals target and original evidence; no goal model or rollup implementation in this plan. | Same source owner plus later common integration; observable live goal/evidence operation remains open. |
| OM-03 native execution | NB-HOST/NB-TECH/NB-SDK/NB-JOIN provide bounded source protocols and SDK conformance; fixture and compiler evidence remain separate. | W plus absent App/SDK providers: actual public permission, overlapping useful workers, live materialization/assurance, same-owned-attempt recovery and platform proof remain mandatory/open. |
| OM-04 retention | Corrected separately verified source `0d1810484de48b1379a5fee96771b31e21bea260`; not merged here. | Retention source owner and later common integration; real safe cleanup/archival only after preservation and fresh holds. No archival proof here. |
| OM-05 Hyper Calendar boundary/evaluator recovery | Foundations retains range/detail source and active DAG. No Hyper changes, evaluator renewal or incumbent acceptance here. | Separately coordinated Foundations/Hyper environment: accepted contract, retained incumbent, fresh generation, independent evaluation/preservation, explicit replacement and actual consumer use all remain separately gated/open. |
| OM-06 lifecycle-wide operating model | Only this native support reference is delivered; no SKILL/common wiring changes. Original planning-repair `ca8b3c44794468bfd8359ea7e376dbb1e771a4de` remains historically blocked at 90/91; registry-helper companion stays separate. | Later admitted operating integration combines independently verified exact targets, common lifecycle skill/wiring and actual end-to-end operation, recovery, cancellation and safe cleanup before rollout. Unadmitted dependencies are not represented as scheduled or accepted. |

Original source references for OM-01..06 are the complete retained
`operating-model-plan-v1` input/candidate/original and repaired results, then the
native predecessor's T-004 crosswalk. The older combined run is
`a48936f8-3ecc-4c38-aaa3-d513f4035587`, input digest
`3bbd5263e83081486576d7af6dd2648fa302eaf9a426c0ce9b5a2418c0cf20f3`;
its preparation/receipt hashes are respectively
`43db82770adfa7df44f5517fb5ac6ec7aa182ab99c55e11b78d1ba661a6a0d31` and
`deee18a5577f1450a0a5158b7b6eb3053ae9cce12290e8719545e48f02fd5906`.
It remains needs-review, unimported and undispatched.

The distinct native predecessor is `d90f26d0-c976-4ad7-beed-ba0e5496c5aa`,
input digest `811b5f2c0032b29d4d93933c92387430128d5a79447fbd802511ef21e326fef7`;
its complete original raw result hash is
`191a6141784acea31488806836d3d87f24f5404167959c4e03a9663297aa3cf7`.
Its candidate, critics, failed verification, needs-review/unimported/undispatched
outcome, erroneous historical text and null synthesisRepair remain unchanged.
Its single repair allowance remains unused. The successor has distinct input
digest `6011778c3ff4da5b91d2483377b8ab308f0057781469cf8cf883ed50a711c2fb`;
it is **not** a frozen-input semantic repair.

The two authority amendments are explicit inclusion of this `native.md` in the
source allowlist and the subsequent isolated integration-merge authorization.
The original local-commit receipt `call_Lj0u7W772jR8Sl7hmDTIv8Aq`
(`2026-11-13T04:35:41.648Z`) excluded merges. The separate later receipt
`call_ButjeIVc0oGLlHV7XfwD58Yu` (`2026-11-13T23:49:14.414Z`) permits isolated
dotfiles integration of approved leaves, not main/master, push, PR or global
installation. Both original start/human-response/completion events are retained;
the later receipt does not rewrite the first. The approved review assigns actual
bootstrap branches to canonical reservations while retaining `202e694` common
ancestry; this integration starts from the reserved exact T-001 delivery.

The supplied direct owner input reference
`42a0d627-3f6a-49c5-9422-25ec7cb08e27@47`, "ok execute those next steps",
retains its sequence: registry fix/independent verification; controlled repair and
blocked native-planning resolution; native wiring with verified squads/goals and
retention; real end-to-end operation/recovery/cancellation/safe cleanup before
rollout. This task performs only the bounded native-source join. The reference
is retained provenance, not a substitute for native/external/install/replacement
permission. `parallel-capability-factory@1` remains discovery-only; observations
and proposals never become accepted authority.

## Reproducible final checks and handoff

Use macOS, readable current bundled SDK, Node 26+, Git and the exact locked
toolchain. From `.copilot/extensions/foundry`, run against the **final committed
bytes**, in order:

```sh
node test/parallel/run.mjs tests test/native/host.test.mjs test/native/observations.test.mjs test/native/dispatch.test.mjs test/application/dispatch.test.mjs test/application/recovery.test.mjs test/bridge/packages.test.mjs test/native/technical.test.mjs test/application/factory.test.mjs test/bridge/receipts.test.mjs test/native/sdk.test.mjs test/native/bridge.test.mjs test/application/parallel.test.mjs test/structure.test.mjs
node test/parallel/run.mjs offline
node test/parallel/run.mjs native
```

Keep the original missing-dependency and historical TS2344 failures. Restore only
the retained exact manifest/lock after a real missing-dependency result. Keep
runner, source, SDK and complete toolchain fingerprints, exact argv/selectors,
raw stdout/stderr/status, criterion/operation indexes, both authorization receipts,
full original reports and all three leaf commit identities. Preserve scratch
evidence before moving generated outputs out of the worktree; verify clean
tracked/index/all-untracked state and unchanged protected baseline identities.

Later common integration must wire `getParallelHost`, exact route-specific native
callbacks and current identities, optional decoders including `decodeRun`, native
input/assurance wrappers and the missing bounded TechnicalExecutor provider.
No application service gains a native transport import here. Strict recursive
checks, closed decoding, nine existing compound-path exceptions, acyclic layering,
canonical admission/journal/factory authorities and the protected cancellation
agreement remain unchanged.

T-005 independently verifies the pinned final commit read-only; author checks are
not independent acceptance. Cleanup eligibility is later work: actual completion,
released attempts/resources, preserved source/evidence, and fresh ownership,
activity, consumer/evaluation, dirty-state, PR/merge and automation holds are all
required. No source test discharges these real-host obligations.
