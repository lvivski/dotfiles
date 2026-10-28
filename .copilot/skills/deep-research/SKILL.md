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
   For comparisons and gap analysis, supply the actual baseline or clearly identify what has not been
   inspected; a selective summary is not evidence that a topic is absent.
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
4. Return the cited report with its finding-level coverage, corrections, limitations, and open
   questions. Supported findings survive even when other claims fail. Keep the deterministic
   verification notes; never present unresolved claims as established facts.

## Essential safeguards

Do not pass `limits` to `run_dynamic_workflow`; use the workflow's declared limits unless the user explicitly
requests an override. Never lower a declared limit without an explicit user request.

Only individually source-verified findings may support the synthesis. Each angle gets at most one
targeted correction pass and independent re-verification of unresolved findings, within the existing
budget. A correction proposal is not evidence until reverified, and a failed claim does not invalidate
other supported findings from the same draft.

Distinguish incorrect claims, inaccessible sources, and insufficient evidence. Do not weaken
verification to obtain a complete-looking report. Use the registered workflow rather than building
another parallel research pool.

## Read when needed

Read [execution controls and recovery](references/execution.md) before changing research breadth,
interpreting failed coverage, resuming a failed run, or recovering saved drafts. Implementation
changes do not authorize another paid run.
