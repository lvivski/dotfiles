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
7. On success, request explicit completion approval, then call `foundry_approve_plan` with
   `approvalType: "completion"`.
8. If the current session is linked to a GitHub issue, preserve the approved plan and final
   verification report as issue artifacts. Do not create artifacts without a linked issue.

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
