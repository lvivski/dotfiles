# Planning and approval

Read before creating or submitting a Foundry plan.

1. Gather a bounded repository summary: working directory, base branch, relevant architecture,
   likely files, constraints, and existing validation commands.
2. Choose a stable lowercase plan ID and call `foundry_prepare_plan`.
3. Invoke the returned `launchSpec` exactly once with `run_dynamic_workflow`.
4. Call `foundry_create_plan` with the returned `runId`, `expectedRevision: 0`, and the exact
   repository identity. It uses native event-driven waiting for an active run and imports only a
   completed result; no separate status-polling step is needed.
5. Call `foundry_submit_plan`, present the plan to the user, and wait for explicit approval.
6. After approval, call `foundry_approve_plan` with `approvalType: "plan"` and the user's identity,
   then activate it with `foundry_activate_plan`.

Interrupting the import wait does not cancel the Workflow. A paused or failed run is not imported
or automatically resumed; follow the recovery protocol with the same `runId`.

Planning currently has no pre-launch reservation. Keep the planning `runId` until it is imported,
and never launch a replacement merely because the first run is temporarily unobservable.
