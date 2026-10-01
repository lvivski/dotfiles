---
name: deep-research
description: >-
  Use this skill for source-backed reports, market or technology research, and current-state
  investigations that need independent web research and source verification. Do not use it for
  local codebase audits, PR review queues, or quick factual lookups.
compatibility: Requires GitHub Copilot CLI with the Foundry extension loaded and web access.
metadata:
  copilot.user-invocable: "true"
---

# Deep research

## Workflow

1. Form a bounded question from the user's request, retaining its scope, time frame, and constraints.
2. Launch the registered workflow once; its default is five research angles:
   ```text
   run_dynamic_workflow({
     name: "deep-research",
     args: { question: "<bounded research question>" }
   })
   ```
3. Keep the returned `runId`, wait for completion, and inspect that run with
   `dynamic_workflows_manage` using `operation: "inspect-run"`. A pending or temporarily unobservable run
   is not permission to launch another.
4. Return the cited report with its coverage, limitations, and open questions. Preserve unsupported
   or incomplete results rather than filling gaps with unverified claims.

## Essential safeguards

Do not pass `limits` to `run_dynamic_workflow`; use the workflow's declared limits unless the user explicitly
requests an override. Never lower a declared limit without an explicit user request.

Only source-verified findings may support the synthesis. Failed or rejected research is not evidence.
Use the registered workflow rather than building another parallel research pool.

## Read when needed

Read [execution controls and recovery](references/execution.md) before changing research breadth,
interpreting failed coverage, or resuming a failed run.
