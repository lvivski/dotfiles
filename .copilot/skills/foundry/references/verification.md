# Verification and completion

Read before dispatching the final verifier, importing verification, or approving a correction wave
or completion.

1. The approved DAG ends in one ordinary `verify` task. Dispatch it through the same
   reserve/create/attach flow as every other task, using its unchanged read-only prompt.
2. The verifier detach-checks out the target commit and returns one evidence record per required
   `checkId`, including `final-integration` and `workspace-integrity`. It reports the final observed
   commit as the attempt commit. Failed checks still produce a `done` verifier report. For factory
   candidates, also return every selected executable `factoryEvaluations` record with actual output,
   evaluator digest, environment/workload and independence explanation. The two outcome sets
   must agree; the implementation cannot edit its evaluator to pass.
   Human modalities/judgment procedures need an explicit human review through
   `foundry_record_human_judgment`; an App-agent verdict cannot satisfy them. Missing or stale
   human evidence holds final verification. Keep the publication receipt `id` separate from the actual
   `judgmentId`, stable `sourceRef` and required `performedAt`; publication retry is not a new assessment.
   The launch reservation freezes governing definitions,
   separately non-governing rationale and human evidence; retries never substitute mutable current
   context into an existing reservation.
   For an explicitly UI-producing unit, the declared visual report is required even on an initial
   discovery plan with no accepted candidate. Apply the visual evidence protocol below.
3. Once every task is done, call `foundry_prepare_verification` with a stable reservation ID.
4. If it returns `launchSpec`, invoke it exactly once with `run_dynamic_workflow`. If it returns
   `launchSpec: null`, use the returned `runId` and do not relaunch.
5. Call `foundry_complete_verification` for the authoritative run. It persists the run binding
   before waiting natively, then rechecks the plan revision and reservation ownership before importing the
   completed result. Verification cannot pass from task-owner evidence alone: every criterion
   and final integration must use the independently reported evidence.
6. On failure, show the attributed gaps and correction tasks. Start a correction wave only after
   explicit user approval through `foundry_approve_plan` with `approvalType: "retry"` for discovery
   plans. Delivered factory candidates are immutable: prepare a new candidate against the same
   accepted contract and a new approved bounded plan, not an overwrite/retry of the failed artifact.
   If delivery is unchanged and only assurance needs repair or refresh, create a separately owned
   `foundry_create_evaluation_plan`. Its sole task is read-only verification against the immutable
   target, with no fabricated implementation work. The original completion and selection remain intact.
   Its frozen context distinguishes that plan's observations from current repository support. A valid
   delayed receipt can complete a historical evaluation even when a newer observation fails; it cannot
   override the newer failure or renew support after a later signal.
7. On success, review the exact awaiting-completion revision. With an explicitly completion-scoped
   delegation, follow the technical-closure protocol below without another user prompt. Otherwise
   request explicit manual completion approval and call `foundry_approve_plan` with
   `approvalType: "completion"` and `approvedBy`.
8. If the current session is linked to a GitHub issue, preserve the approved plan and final
   verification report as issue artifacts. Do not create artifacts without a linked issue.

## Package assessment source entry

Call registered `foundry_assess_package` with `planId` and the delivered package's `taskId`, omitting
`report`, to prepare its exact assurance subject. Supply `report` to assess evidence against that
subject; a changed subject requires fresh preparation, not substituting its digest. Complete current
contributor identity, including runtime helpers, and reviewer identity/applicability come only from
trusted host readers, never caller-supplied author/reviewer lists or report claims. Every recursively
contributing package producer is also included. Missing or incomplete host authorship/reviewer
authority holds; the default production host is unavailable.

An assessed result exposes `executablePassed` separately from `pendingHuman` and retains
`independent-claim` provenance. Assessment does not persist terminal verification, authorize completion,
clear required human judgment or replace the separate read-only verifier. Continue the existing
verifier/evaluation, human-gate and final-verification sequence above.

## Integration evidence and holds

Prepared, reserved, initialized, attached, executing, delivered and independently verified are
distinct [evidence stages](dispatch.md#truthful-stages), not interchangeable success labels.
A terminal verifier report can contain failures. Leaf tests, compiled ports, delivery receipts or
concurrent authorship do not establish independently verified final integration.

For explicit package decomposition, review complete immutable declarations against every successful
producer attempt/commit/path/mode/digest, actual post-attachment/handoff consumer materialization and
execution, and integration ancestry at the exact final commit. A manifest, bootstrap base or mutable
branch tip is not dependency-output consumption. Do not retrofit package requirements onto historical
omitted-decomposition plans. Run relevant executable seam/whole-delivery checks; retain missing
route/operation capabilities, invocation or materialization as holds, not passing evidence.
No source/fixture result proves live permission, App restart, notifications or native visual fidelity.
Final visual evidence must assess the combined exact delivery, not only earlier leaf captures.

The `test/application/parallel.test.mjs` composed tiny-Git case uses production admission, shared journal and input services with
synthetic App transport/observations: two producers feed actual consumer snapshots, the consumer
uses both outputs and preserves both commit ancestries, then a separate read-only verifier path and
synthetic human-gate record allow final-verification preparation. This is not completed final
verification, a real human judgment, installed support, live visual/notification behavior or an
App-restart test; reconstructing service instances in the fixture does not establish those facts.

An original owner's DONE receipt, past attachment or coordinator artifact cannot authorize
supplemental correction. The [supported current binding](dispatch.md#supplemental-original-owner-corrections)
to the active integration attempt is absent here: retain the delivery hold for an explicit authorized
correction decision, without reopening DONE, expanding the DAG or transferring scope. Neither initial
plan approval nor technical-completion delegation waives missing binding, evidence or resource authority.

## Delegated technical milestone completion

Only an explicit user instruction authorizing bounded **technical milestone closure** enables this
route. Record it once through `foundry_plan_approval_delegation`, `action: "grant"`,
`approvalType: "completion"`, a new stable `id`, exact reference `planId`/`expectedRevision` and
`authority`. Follow the [instruction provenance protocol](planning.md#delegated-execution-plan-approval):
retain the original instruction verbatim, direct/relayed source and revision; this is agent-attested
authority, not authenticated user identity or a per-milestone human click. Do not repeat a consent
form for an instruction already given. Without explicit authority, ask once or retain manual approval.
Existing initial-only/native-form grants stay immutable and usable for initial plans only.

Inspect the completion grant and review the exact named plan, immutable delivery, authoritative
independent verification and unresolved holds. Every task must be done and the plan must be
`awaiting-completion-approval`, with its bound verification PASSED. The runtime rebuilds the canonical
verification input, compares its digest, checks independent passing evidence and the exact delivered
target, and rechecks current factory/human evidence gates. Missing, stale, failed or mismatched
evidence is a hold, never something delegation can waive. Do not rerun or substitute a verification
Workflow merely to obtain approval.

If eligible, call `foundry_approve_plan` with `approvalType: "completion"`, exact `planId` and
`expectedRevision`, `delegationId` and a substantive technical `review`; omit `approvedBy`.
The receipt retains the original grant, native approving session/call, exact pre-approval revision,
blueprint digest, verification reservation/run/input digest and immutable target commit. Revision
conflicts require a fresh read and comparison with the recorded result, not a duplicate decision.
Owner/repository/capability/contract scope and revocation are checked through the existing transaction.
Exported receipts are history, not transferable active authority; revoke stops future decisions
without rewriting closed milestones.

This closes only the verified technical milestone. It does not supply missing human-modality
judgments, aesthetic/visual or final-design acceptance, authorize a correction wave, replace a
capability/contract, deploy, push, create/merge a PR, use real accounts, override shared resources or
skip native permissions. Keep those separately gated even after technical closure.

## Visual evidence

For `unit.visualEvaluation`, return the exact evaluator in `factoryEvaluations` alongside the ordinary
canonical check evidence. Its `report` is JSON with this shape (placeholders are not evidence):

```json
{
  "format": "foundry-visual-report-v1",
  "deliveryCommit": "<exact full delivered commit>",
  "environment": "<declared evaluator environment>",
  "states": [{
    "id": "<declared state>",
    "referenceDigest": "<declared reference SHA-256>",
    "capture": {
      "path": "<absolute durable regular PNG/JPEG/WebP capture file>",
      "digest": "<capture bytes SHA-256>",
      "capturedAt": "<ISO instant>",
      "method": "native-screenshot",
      "viewport": "<actual viewport, scale and relevant display configuration>"
    },
    "assessment": {
      "composition": { "outcome": "passed", "finding": "<actual comparison against reference intent>" },
      "navigation": { "outcome": "passed", "finding": "<actual comparison>" },
      "paneBoundaries": { "outcome": "passed", "finding": "<actual comparison>" },
      "hierarchyDensity": { "outcome": "passed", "finding": "<actual comparison>" },
      "typography": { "outcome": "passed", "finding": "<actual comparison>" },
      "actionPlacement": { "outcome": "passed", "finding": "<actual comparison>" }
    }
  }]
}
```

`browser-screenshot` is also supported. Cover every declared state exactly once; record concrete
findings relative to the actual reference, including scoped normal/empty/error behavior. Outcomes
may be `failed` or `inconclusive`; do not turn mismatches into advisory prose. If capture is blocked,
use `capture: null`, a concrete `blocker`, nonpassing assessment and nonpassing outer evaluator/
canonical check outcomes. A terminal verifier report can retain failure, but verification/completion
cannot pass it. Never fabricate captures, replace screenshots with SVG/code/geometry reports, or
reuse a reference as an alleged output capture. Keep capture files outside the immutable delivered
worktree, retain them through verification/closure and explicitly transfer artifacts for later reuse.

The existing independent App verifier must actually view both the renderable reference and output.
The protected command evaluator checks the report/artifacts; the restricted verification Workflow
reviews recorded evidence, not images it cannot access. Foundry checks exact reference material,
capture bytes/digests, delivery/state/environment bindings and nonpassing findings. These are identity
and consistency checks, not proof of capture provenance or that an agent saw pixels: visual verdicts
remain independent agent claims. A correctly fabricated image/inspection narrative cannot be
cryptographically detected by this API. Native permissions and any required human judgment remain
separate. No automatic capture, additional agent, image-diff service or paid budget increase is added.

Plan completion is not capability replacement or a regeneration proof. Inspect current factory
assurance and compare alternatives against the same pinned obligations. Record explicit selection
with `foundry_decide_candidate`, including the expected incumbent and reason. Expired/context-
mismatched evidence, missing preservation/independence, or a superseded contract blocks selection.
Selection records authority only; deployment and data cutover require their own approved work.

Interrupting the import wait does not cancel the Workflow or remove its binding. Re-read the plan
revision before retrying: binding is a durable mutation even when waiting is interrupted.
Completed results establish their reservation through canonical input and digest checks; progress
markers remain necessary for result-less launch discovery. Paused and failed runs require recovery,
not automatic resume or a replacement launch. Cancellation still follows its separate protocol.
