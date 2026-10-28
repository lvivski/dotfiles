# Verification and completion

Read before dispatching the final verifier, importing verification, or approving a correction wave
or completion.

1. The approved DAG ends in one ordinary `verify` task. Dispatch it through the same
   reserve/create/attach flow as every other task, using its unchanged read-only prompt.
2. The verifier detach-checks out the target commit and returns one evidence record per required
   `checkId`, including `final-integration` and `workspace-integrity`. It reports the final observed
   commit as the attempt commit. Failed checks still produce a `done` verifier report.
3. Once every task is done, call `foundry_prepare_verification` with a stable reservation ID.
4. If it returns `launchSpec`, invoke it exactly once with `run_dynamic_workflow`. If it returns
   `launchSpec: null`, use the returned `runId` and do not relaunch.
5. Call `foundry_complete_verification` for the authoritative run. It waits natively if the run
   is active, then rechecks the plan revision and reservation ownership before importing the
   completed result. Verification cannot pass from task-owner evidence alone: every criterion
   and final integration must use the independently reported evidence.
6. On failure, show the attributed gaps and correction tasks. Start a correction wave only after
   explicit user approval through `foundry_approve_plan` with `approvalType: "retry"`.
7. On success, request explicit completion approval, then call `foundry_approve_plan` with
   `approvalType: "completion"`.
8. If the current session is linked to a GitHub issue, preserve the approved plan and final
   verification report as issue artifacts. Do not create artifacts without a linked issue.

Interrupting the import wait does not cancel the Workflow. Paused and failed runs require recovery,
not automatic resume or a replacement launch. Cancellation still follows its separate protocol.
