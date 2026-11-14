# Retention source integration

This is the source contract for `foundry-retention-v1`, not a registered public
automatic-cleanup path. Completion triggers assessment, never permission or archival.
T-005 independently verifies the exact integrated source without waiting for any live
archive. Source verification and later actual cleanup are both required program outcomes.

## Supported partial runtime: completion is assessment only

The current `foundry-supported-runtime-v1` increment is partial runtime support, not
automatic cleanup or full lifecycle acceptance. `native/supported-runtime.mjs` exports
`createSupportedRuntime({getSession})`, which supplies
`completionEvent(input,retentionFor)`. Root `completionEvent` is **constructor-only**:
it validates native owner invocation, then passes `{repositoryPath,eventId}` to the
existing canonical `retentionFor().completionEvent`. It does not subscribe to
notifications or connect `completeTask` automatically to archive.

Completion can trigger the **existing** retention assessment only when canonical
notification authority and the existing canonical archive transaction/outbox are
supplied. Without that persistence binding, it throws
`retention_persistence_unsupported`; do not create a second store or substitute the
dispatch journal. Neither the constructor binding nor a completion notification
authorizes an archive.

The narrow public `session.rpc.tools.execute` bindings for workflow invocation and
warm coordinator-only messaging use `extension-rpc`; neither binds an archive route
nor supplies retention authority. Advertised metadata, callable binding, admission
and successful effect remain distinct. No automatic alternate-route replay, private
workflow launcher or generic executor may repair an unavailable retention operation.

Every missing prerequisite retains its specific hold and permits **zero archive
effects**: artifact preservation, current eligibility, host-wide action-time
all-writer exclusion, normal native permission and correlated original-outcome
observation/reconciliation. App lifecycle serialization, typed retirement and
dirty-preservation do not by themselves prove these prerequisites. Neither do source
recording-boundary checks: those are not live-host authenticated evidence, installation
or full-factory acceptance. Authenticated observations and bounded TechnicalExecutor
remain absent; no UI/visual claim applies.

Keep the canonical once-only intent/start/outcome and complete original receipts
after denial, interruption, malformed results or persistence failure. Reconciliation
retains the original operation and receipt; never resend an uncertain archive.
The historical source tables, decisions, rejected proposals, failures and evidence
below remain intact. This current contract records no new test run or live cleanup.

## Authoritative interfaces

The single orchestration declaration is
[`types/retention.d.ts`](../../../extensions/foundry/types/retention.d.ts).
Do not introduce a second permission, hold, retry or scheduling authority.
The source delivery manifest pins the final commit, every listed source/test hash,
all three input commits, original reports and raw invocations. Consume that immutable
commit, not a mutable branch tip or reconstructed implementation.

| Delivered binding | Role |
| --- | --- |
| [`plan/retention.mjs`](../../../extensions/foundry/plan/retention.mjs)::`assessRetention` | Closed, bounded pure policy; `candidate` is not authorization. |
| [`application/retention.mjs`](../../../extensions/foundry/application/retention.mjs)::`createRetentionOperations` | The only completion/reassessment/start/reconciliation orchestration. |
| `createRetentionOperations().completionEvent({eventId})` | Resolve the canonical completion, assess once and retain the identity-bound intent. Duplicate delivery does not start an effect. |
| `createRetentionOperations().reassess({eventId,subject})` | Observe genuine later authority changes. No cleanup/release flags are accepted. |
| `createRetentionOperations().execute({intentId})` | Guard current observation, preservation, canonical single-start admission and the one native route. |
| `createRetentionOperations().reconcile({intentId})` | Read-only original-operation reconciliation; never reset admission or retry an uncertain call. |
| [`storage/retention.mjs`](../../../extensions/foundry/storage/retention.mjs)::`createRetentionPersistence` | Adapt existing canonical synchronous transactions, revision CAS and immutable outbox outcomes. No database or schema is created. |
| [`plan/artifacts.mjs`](../../../extensions/foundry/plan/artifacts.mjs)::`planArtifactRetention`, `readArtifactManifest` | Deterministic complete artifact/ref inventory, original attribution and bounded paths. |
| [`native/artifacts.mjs`](../../../extensions/foundry/native/artifacts.mjs)::`createArtifactRetention` | `retain` uses the ordinary authorized provider; `observe` independently checks private bytes and self-contained Git objects/refs. Both explicitly report `raceSafe:false`. |
| `application/retention.mjs`::`createRetentionArtifactPort` | Inject the delivered artifact observer into the application contract without importing native runtime code. |
| [`native/retention.mjs`](../../../extensions/foundry/native/retention.mjs)::`retentionSubject`, `createNativeRetention` | Exact owner/child/project/repository/attempt/run correlation, ordered exhaustive inspection, conditional native archive and original-result reconciliation. |
| `application/retention.mjs`::`createRetentionArchivePort` | Inject that native protocol plus an actual outer host guard into the application contract. |
| [`hooks/paths.mjs`](../../../extensions/foundry/hooks/paths.mjs)::`observeRetentionPath` | Canonical bounded path/inode observation; not an outside-workspace write grant or hostile-writer isolation. |

The immutable input deliveries are policy
`1dfc6b0f64d1d77ec7959926e250fc85cfb6f023`, artifacts
`1c6d6e3606cbec843a3f4af27d39e60e2c6e5276`, and native protocol
`e115ee8142db529bc38e7774fd8565a77c87b099`, each descending from baseline
`202e694bb05b336ebb3684b122ac75deb578c916`. The T-004 final delivery must retain
all three as actual Git ancestors. Its criterion index covers RET-C01-10,
RET-A01-08, RET-N01-09 and RET-I01-10. Generated implementation tests do not become
accepted factory evaluators merely because they pass.

The corrected policy delivery adds the explicit RET-C05 canonical cross-task
non-completion assertion and positive control; runtime policy is unchanged.
Original policy `3da44fbb1a9180523ec8619f1cea8e53f431e564`, integration
`c3730bc3787aa07c88e97c857eae06d4827dcbf0`, their reports and the failed
authoritative verification remain historical evidence, not retroactively passed.
The corrected integration retains the original composed behavior and assertions.

## Composition and authority

Construct ports in trusted integration code, never from tool-request JSON. Inject
the resulting artifact/archive ports into `createRetentionOperations`; application
code does not import native runtime modules.

`createRetentionArtifactPort` binds one canonical completion, the corresponding
artifact manifest and a canonical opaque `ownerId` alias. The integrating owner
must establish that alias; it must not infer ownership by transforming a path.
Use the **same** `retentionRoot` and `retainedRepository` as the injected
`createArtifactRetention` instance, with the independent bare repository nested
inside the private retention root. Its authoritative `readBinding` must cover
the complete inventory and every removal root, including session-side footprints.
Missing or changed inventory holds; a successful copy receipt does not prove retention.
The projection records file SHA256s and Git commit/ref binding digests, not invented
SHA256 content hashes of Git objects. Original failure artifacts remain required
artifacts, with original IDs/producers intact. Projection overflow holds rather than
truncating the lower-level inventory.

`createRetentionArchivePort` binds the exact native subject and sends the canonical
`operationId` as the native protocol's `intentId`. The canonical intent ID remains
unchanged in the application outbox. Its additional `withSubjectGuard` must be a
real host exclusion boundary spanning application observation, artifact inspection,
start admission and the native conditional effect. The native protocol's
`conditionalArchive` must recheck current owner, identity, all work/holds, retention,
workspace writers and native permission at the effect boundary. Neither a snapshot,
JSON token, local mutex nor a SQLite admission fence supplies those host semantics.
Omit unsupported bindings; do not wrap ordinary check-then-archive and call it safe.

Only the owning canonical authorities may report terminal tasks, attempts and runs,
or release consumers/evaluators. Exhaust all observation pages causally after current
detail in the same host domain. Do not equate terminal task status, idle UI state,
an expired timestamp or a cleanup flag with release or absence.

The baseline archive registration gap is explicit:
[`types/parallel.d.ts`](../../../extensions/foundry/types/parallel.d.ts)::`EffectKind`
and [`plan/parallel-contracts.mjs`](../../../extensions/foundry/plan/parallel-contracts.mjs)::`effectReceipt`
allow only creation, attachment, handoff and workflow. The existing
[`storage/admission.mjs`](../../../extensions/foundry/storage/admission.mjs)::`withFence`
also applies `assertAdmissionFence` and is not an archive transaction for an already
settled subject. No archive may be mislabeled as one of those effects.
`RetentionCanonicalPort` must be bound by the shared canonical/schema owner using
the existing transaction authority, with durable read/insert/replace, scope/revision
and retry/cancellation checks, subject-wide exclusion and action-time hold checks.
Missing binding produces `retention_persistence_unsupported`, not a production pass.

## Receipts and recovery

Preserve the complete original native result in the canonical outcome receipt.
The adapter timestamp is its observation time, **not** an invented native timestamp.
Native original source, receipt, reasons and evidence remain inside that result.
`archived` maps only to `archived`; denial stays denied; unsupported stays unavailable;
held/not-archived become failed; unresolved disposition stays uncertain.
The application hold includes the original actionable error code and message.

`readOriginal` reads the exact original native result from the canonical outbox or
its authorized private evidence binding. It must not manufacture a result from
directory absence, create a shadow retry database or forget a failure on restart.
Missing original evidence remains held. Reconciliation appends the new observation
without changing the original receipt or invoking archive again.

Non-JSON native errors, oversized evidence and failed outcome writes return an
explicit `unpersisted` hold containing the original value. Retain that complete value
through an authorized private evidence route before recovering it; do not stringify
an `Error` to `{}`, truncate a receipt, retry the effect or route around a denied write.
Keep durable intent/outcome storage, original reports, decisions, evaluator bindings,
source commits/refs and required artifacts outside every directory the action removes.
Archive is not cancellation, termination or permanent deletion.

## Evidence and later real proof

The composed cases in
[`test/application/retention.test.mjs`](../../../extensions/foundry/test/application/retention.test.mjs)
execute the delivered policy, persistence adapter, artifact observer and native
protocol through the application entry points. They use actual isolated SQLite,
Git objects and private filesystem bytes, but a **synthetic** canonical archive schema,
inventory domain, outer guard and conditional host. The effect is a counter.
Separate tracked, untracked and ignored writes occur after final reassessment and
before the attempted effect; each keeps its bytes, records ordering and an actionable
hold, and performs zero archive effects. These cases are not App-level race proof.

Run the pinned Node 26 runner from `.copilot/extensions/foundry`:

```sh
node test/parallel/run.mjs tests test/plan/retention.test.mjs test/application/retention.test.mjs test/storage/retention.test.mjs test/plan/artifacts.test.mjs test/native/artifacts.test.mjs test/native/retention.test.mjs test/hooks.test.mjs test/structure.test.mjs test/native/imports.test.mjs
node test/parallel/run.mjs offline
node test/parallel/run.mjs native
```

The final native result is compared to the unchanged baseline under the pinned
Node/compiler/dependency/SDK inputs. Retain complete diagnostics and all failures.
The known SDK `TS2344` remains a native **non-pass**; any additional diagnostic
blocks delivery. Preserve recursive strict checking, closed decoders, layer boundaries,
the exact nine filename exceptions and protected evaluator identities.

The separately admitted **`foundry-operating-integration-v1`** owns common root
registration, completion-event wiring and the actual canonical/host bindings together
with the native and squads/goals owners. Its real proof must:

1. Pin the T-004 immutable source commit, exported APIs and exact source/test/evaluator
   digests from its delivery manifest. Confirm applicability rather than reimplement
   cleanup or substitute unrelated historical suites.
2. Select a genuinely independently completed, owned native-adapter or squads/goals
   plan subject. Retain its exact task/attempt/session/run/source identities and
   independent verification. Its consumer/evaluator holds must genuinely end.
3. Retain all unique source commits/refs, private context/decisions, original reports,
   failures, evaluator bindings and required bytes outside all removal footprints.
   Capture exhaustive causally current observation and preservation evidence.
4. Establish actual supported native permission and host-wide action-time/race
   semantics, then run these exact APIs through the ordinary supported archive route.
   An unavailable/denied/uncertain route remains an explicit hold with no fallback.
5. Preserve the original native receipt and independently corroborate the exact
   subject's removal plus continued readability of conserved bytes/commits/artifacts.

No disposable child, archived predecessor, fixture counter or historical manual
cleanup substitutes for this proof. The subject need not be archived before T-005
finishes. Public registration, installation, real cleanup, unavailable platform/host
guarantees and broader human/contract/replacement acceptance remain open obligations;
this source plan waives none of them and does not establish full-factory completion.
