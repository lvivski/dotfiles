# Parallel implementation contracts (v1)

This is a shared implementation seam, not an accepted capability contract or an
installed parallel dispatcher. `parallel-capability-factory@1` remains discovery-only.
The existing two-task recipe remains unchanged until T-002/T-007 compose an explicitly
supplied decomposition. No legacy plan, seal, grant or imported history is rewritten.

## Owners and executable entry points

The exact approved file map is
`../../../extensions/foundry/test/parallel/fixtures/ownership.json`.
It is mechanically extracted from `foundry-parallel-engineering-v1` approved revision 3
(observed revision 5, blueprint digest recorded in the map), not a newly invented scope.
Its 57 paths have no leaf-to-leaf overlap.

| Owner | Exclusive implementation responsibility | Focused entry point after implementation |
| --- | --- | --- |
| T-001 | `types/parallel.d.ts`, `plan/parallel-contracts.mjs`, `storage/parallel-protocol.mjs`, native schema capture, shared fixture infrastructure and runner | `node test/parallel/run.mjs tests test/parallel/contracts.test.mjs test/plan/validation.test.mjs` |
| T-002 | Package compiler, exact-commit output resolution and authorized consumer materialization | `node test/parallel/run.mjs tests test/plan/packages.test.mjs test/bridge/packages.test.mjs test/bridge/plans.test.mjs` |
| T-003 | Dependency/scope/team/resource readiness; sole claim/reservation/release authority | `node test/parallel/run.mjs tests test/plan/admission.test.mjs test/storage/admission.test.mjs test/application/admission.test.mjs` |
| T-004 | Native adapter and side-effect journal, not another admission authority | `node test/parallel/run.mjs tests test/application/dispatch.test.mjs test/native/dispatch.test.mjs test/storage/dispatch.test.mjs` |
| T-005 | Requirement/evaluator conservation and substantive independent assurance; retained visual gate | `node test/parallel/run.mjs tests test/bridge/assurance.test.mjs test/analysis/assurance.test.mjs test/bridge/visual.test.mjs` |
| T-006 | Cancellation/recovery decisions through T-003/T-004 ports; deterministic workloads | `node test/parallel/run.mjs tests test/application/recovery.test.mjs test/native/cancellation.test.mjs test/parallel/scaling.test.mjs` |
| T-007 | Public registration and composition of exact leaf commits | Composed production checks, not fixture-only scheduler evidence |

Leaf commands are implementation obligations, not claims that downstream files already
exist. Each leaf also runs its complete approved selectors and `node test/parallel/run.mjs
offline`. T-004 and final integration additionally run `native`. No unfinished sibling
imports are needed: `AdmissionPort`, `DispatchJournalPort`, `InputPort` and
`OfferedToolExecutor` are injected interfaces. During fan-out T-001 alone changes these
shared definitions; T-007 owns subsequent public composition.

## Identity and immutable inputs

`PackageDecomposition` names real inputs/outputs and exact requirement/evaluator
revisions. `GoverningBindings.authority` cannot promote null discovery authority into an
accepted contract. Visual applicability retains its declared exact evaluator; the
adopted frozen definition, reference, capture and independent-comparison semantics
remain authoritative for its gate. Human judgment is separate.

`AdmissionIdentity` is owner/repository/plan/task/reservation, known before native
reservation. `AttemptIdentity` adds the returned attempt ID; never predict it.
`ReservedInputs` distinguishes the native bootstrap branch/commit from **every**
producer's exact successful attempt, delivered commit and path/mode/content identity.
Its digest binds the complete descriptor. `assertInputCoverage` compares against the
immutable complete package declaration; checking a supplied subset against itself is
insufficient. T-002 resolves actual Git bytes and delivery freshness. T-004 carries that
descriptor unchanged. Only T-002's attached and handed-off consumer entry materializes
inputs. Setup never dirties bootstrap HEAD; materialized snapshots do not replace exact
delivery ancestry integration.

Parsers validate closed wire/persisted documents and cross-object consistency. They do
not authenticate callers or grant execution. Observations are `observation-only`;
`parallelHistory` imports are `history-only` and have no store activation API.
Admission writers obtain records from their anchored owner-local store, never from an
imported document. Existing plan JSON remains untouched.

## Fenced transaction and recovery protocol

Use the existing anchored `createArtifactDatabase` synchronous writer transaction.
T-003's claim store is the shared serialization boundary for claims, fence checks and
T-004 journal mutations. A `FencedTransaction` is passed only inside that transaction.
The journal never opens its own claim authority, allocates capacity or releases claims.
Every writer compares exact identity, expected revision and cancellation epoch.
Native calls must occur **outside** the transaction after a durable start receipt.

Plan reservations and shared resource claims can inhabit different databases.
Do not claim distributed atomicity: acquisition follows the recoverable protocol
below. A pending claim already consumes its resource/team capacity. Reconciliation
retains it until native reservation absence or the exact matching reservation is
authoritatively established. No timeout or missing/incomplete inventory releases it.
A settled unbound claim retains `reservationFailure` from a definitive no-reservation
outcome or a fenced cancellation-before-reservation transition. A momentary absent
attempt does not settle a previously started request that may still return.

| Transition | Authoritative writer | Preconditions and expected revision | Durable postcondition | Recovery disposition |
| --- | --- | --- | --- | --- |
| Claim | T-003 admission store | Owner/repository scope; dependencies, capacity and resources supported; expected store revision (0 only for new identity) | `claim-held`, stable reservation ID, capacity deducted | Replay same identity/payload; conflicting identity fails |
| Reservation | T-003 through existing `foundry_reserve_task` | Claim held; current plan revision, approved/active plan and scope | Native reservation then `reserved` binding to exact returned attempt; shared store CAS | Crash between databases retains claim; reread plan/reservation; uncertain outcome holds, never reserve another attempt |
| Creation intent | T-004 through T-003 `withFence` | Reserved claim, exact revision/epoch; unchanged setup/base/payload digest | Journal `intent` before any native call | Pending intent can be cancelled-before-start atomically |
| Creation start | T-004 through T-003 `withFence` | Same active fence; intent not previously consumed | `in-flight`; one authorized native call slot | Crash or lost response is uncertain; retain claim and reconcile same correlation |
| Creation outcome | T-004 journal through settlement-capable fence | Match immutable intent/attempt/payload; current revision; outcome can arrive after cancellation | Succeeded/definitive-failure/uncertain receipt, actual returned child identity only | A late child becomes a cancellation obligation; no second create on uncertainty |
| Attachment | T-003/native attach authority; T-004 journals intent/outcome | Exact setup acknowledgement; fresh same-child/project/creator/worktree/base/clean-state corroboration; current plan and admission revision/epoch | Exact child attached, native attachment receipt retained | Alias/rename requires supported reconciliation; dirty/base drift or incomplete observation holds |
| Handoff | T-004 journal; owning coordinator invokes offered tool | Successful attachment; unchanged reserved delegation/input descriptor; active fence, start receipt | Coordinator-only normal-tool outcome retained | Rejected/uncertain handoff is not execution; reconcile same child's transcript, no blind resend |
| Delivery | Existing `foundry_complete_task`, then T-003 `deliver` | Exact owner/attempt and commit; current plan revision, existing delivery/evidence gates | Terminal task persisted **before** newly ready work; exact `DeliveryReceipt` then settled claim | Plan/store crash gap is held and reconciled; completed task can release only with no pending effects/runs |
| Cancellation | T-003 `cancel`, decision supplied by T-006 | Current revision, exact owner; no foreign-plan takeover | Epoch advances and `cancelling`; all known children, started effects and authoritative runs retained | No new effect start. A pre-fence in-flight call may return late and must be reconciled, not erased |
| Settlement | T-003 `settle`, decision supplied by T-006 | Fresh complete terminal inventory; exact native identities; every owned run/effect accounted for | `settled` with no unresolved obligations | Missing/uncertain effect, partial inventory or live run holds |
| Release | T-003 only | Current revision and safely settled disposition; no unresolved reservation gap | `released`; resource/team capacity returned once | Duplicate release returns matching postcondition; no T-004/T-006 direct claim writes |

Intent/start is the native-side-effect linearization point. Cancellation cannot recall
an already in-flight host request; treating such a request as nonexistent is incorrect.
Settlement accepts late outcomes while rejecting new starts. Revision conflicts require
fresh reads and matching-postcondition comparison, not replay with a guessed revision.
`synchronousTransition` rejects asynchronous work inside the writer boundary.

`test/parallel/fixture.mjs` supplies separate SQLite connections, explicit fault
schedules and invariant assertions. Its self-tests prove the harness, not production
admission/dispatch/recovery. T-003/T-004/T-006 run these contracts against their production
ports, and T-007 runs their composition. No polling, App test workers or fabricated
terminal inventory is part of these fixtures.

## Actual native contracts and supported invocation

Captured actual offered schemas are
`test/parallel/fixtures/native-tools.json`, SHA256
`cf9444d4d80c86863819c4f761ee1f8401d358ba4747d3bc7b5e9f6646f9dadf`,
captured by the owning coordinator at `2026-11-13T05:36:20.438Z`. All ten requested
tools were present. `native-contracts.mjs` supplies request assertions against this
capture; it does not infer a result schema, permission or execution success.

SDK declaration hashes/byte sizes are pinned in `fixtures/sdk-identities.json` for
`session.d.ts`, `generated/rpc.d.ts`, `workflow.d.ts`, `types.d.ts`,
`generated/session-events.d.ts`, `cliVersion.d.ts` and `sdkProtocolVersion.d.ts`.
The installed declaration identity is CLI
`1.0.106-8.unstable.r43162459260.gbfc9f50`, protocol 3, from
`/Applications/GitHub Copilot.app/Contents/Resources/copilot-sdk`.
This is an SDK input identity, not a claim about a newly installed extension.
`types/parallel-conformance.ts` checks the execute port against both offline and native
declarations without changing the existing Elicitation assertion.

The sequence is `foundry_get_status` → `foundry_reserve_task` → `create_session`
with the returned base, setup-only kickoff and `notify_on_idle: "always"` → actual
setup acknowledgement → fresh `get_session`/complete inventory corroboration →
`foundry_attach_task` → unchanged `send_session_message` with `coordinator_only: true`.
Record terminal completion with `foundry_complete_task` before admitting newly ready work.

Only the owning coordinator invokes these tools. Its local extension handler may use
`CopilotSession.rpc.tools.execute({name, arguments, toolCallId?})` through the offered
tool's normal invocation/permission pipeline. The correlation ID is not a lease or
authority. **Metadata does not prove execution availability:** the captured
`native-rpc-failure.json` records `This session management tool is disabled` on that
route. The primary App tool later admitted this existing worker's task after owner
reconciliation. Do not equate the two paths or retry through an alternate path
automatically; the unavailable adapter returns a hold.

`session.on(...)` subscribes to this session's SDK events. `workflow.run_updated` is a
workflow invalidation event; neither it nor `session.idle` is a documented cross-App-child
completion subscription. `system.notification` has session notification data, not a
guaranteed child inventory/identity contract. The App `notify_on_idle` option delivers
coordinator notifications, not a new SDK subscription API. Use notifications to wake the
coordinator and an explicitly invoked **bounded** reconciliation entry. No polling
timers or invented child-event APIs. Prepared `run_dynamic_workflow` payloads stay
unchanged; `session.workflow.run` and nested workflows are not fallbacks.

Live permission dialogs, real App setup/acknowledgement and notification delivery, and
App-restart recovery remain external evidence gaps. They require a separately authorized
real App-host check by the owning coordinator using a normally reserved worker and exact
source/package identity. This task does not authorize installation or test sessions.

## Reproducible confined checks

Run from `.copilot/extensions/foundry`. Node 22.13+ with `node:sqlite` is the minimum;
the captured environment uses Node 26.8.1. Dependencies live outside the recursively
checked extension source: `.copilot/skills/foundry/.parallel-check/toolchain/node_modules`
contains TypeScript 7.0.2, `@types/node` 26.6.6 and `vscode-jsonrpc` 10.0.0.
Restore these only after a selected check demonstrates they are missing, with npm
prefix/cache/TMP confined beneath `.parallel-check`; never install them in the extension.

Each runner invocation creates a distinct scratch root, verifies canonical
TMPDIR/TMP/TEMP in children, isolates relative-CWD legacy fixtures and records argv,
toolchain fingerprints, diagnostics and exit status in its own `evidence.json`.
Native compiler scratch uses the same invocation root. The write preflight detects
out-of-scratch writes, including hard-coded fixture/database paths; it is not an OS
sandbox. No shared writable fixtures, global configuration or live services are needed.
Before cleanup, copy evidence and necessary captured artifacts to authorized coordinator
artifacts. A later invocation must not depend on deleted temporary outputs.

`node test/parallel/run.mjs visual-baseline` runs exactly the 14 selectors in frozen
visual evidence SHA256 `8e845a7b3c4f6b70433ebfd85f2cb23fb11e1da7b7ae5edded6feeea0cae1a6f`.
`offline` checks every owned module under recursive strict `jsconfig.json`.
`native` invokes the unchanged SDK checker. The known baseline diagnostic is
`sdk-conformance.ts(24,33): error TS2344: Type 'false' does not satisfy the constraint 'true'.`
Normalize only generated scratch prefixes when comparing. This remains a failing
native SDK check, not a pass; any new or changed diagnostic blocks delivery.
