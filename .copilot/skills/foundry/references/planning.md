# Planning and approval

Read before creating or submitting a Foundry plan.

1. Read the [factory lifecycle](factory.md), inspect repository authority and select/define the
   coherent capability. Gather a bounded repository summary: working directory, base branch, relevant architecture,
   likely files, constraints, and existing validation commands.
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
5. Call `foundry_submit_plan`, present the plan to the user, and wait for explicit approval.
6. After approval, call `foundry_approve_plan` with `approvalType: "plan"` and the user's identity,
   then activate it with `foundry_activate_plan`.

Interrupting the import wait does not cancel the Workflow. A paused or failed run is not imported
or automatically resumed; follow the recovery protocol with the same `runId`.

Planning currently has no pre-launch reservation. Keep the planning `runId` until it is imported,
and never launch a replacement merely because the first run is temporarily unobservable.
