---
name: deep-research
description: >-
  Use only for explicitly requested deep or exhaustive web research, or a heavy multi-angle
  investigation the user has approved escalating to a multi-agent workflow. Default to ordinary
  search/fetch for answers, fact checks, documentation lookups, recommendations, simple comparisons,
  or current information. Requests for research, sources, or accuracy alone are not triggers.
  Not for local codebase audits or PR review queues.
compatibility: Requires GitHub Copilot CLI with the Foundry extension loaded and web access.
metadata:
  copilot.user-invocable: "true"
---

# Deep research

## Activation gate

Ordinary research is the default. Answer routine questions with direct web search, page retrieval,
or documentation inspection, including when the answer needs citations or up-to-date information.
Words such as "research", "look into", "find out", or "compare" do not authorize this workflow.

Reserve this heavyweight workflow for substantial investigations needing multiple distinct research
threads, independent source cross-checking, and significant synthesis. Proceed only when the user
explicitly requests deep/exhaustive research or invokes `/deep-research`, or approves escalating a
specific heavy investigation. Loading this skill is not itself authorization to launch a workflow.

If ordinary research reveals genuinely substantial remaining work, explain the scope and additional
time/credit cost and ask for approval with `ask_user` before escalating. When basic research suffices,
answer directly and stop; do not routinely offer an upgrade or manufacture extra angles to justify one.

## Workflow

Follow these steps only after the activation gate is satisfied.

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
   An hourly time-review pause is a user decision, not lost research. Foundry offers another hour,
   keeping the run paused, or stopping it through the native host dialog. Do not duplicate that
   question or resume while the decision is pending. Re-read the run before acting on a paused
   notification: the user may already have resumed it.
4. Return the cited report with its finding-level coverage, corrections, limitations, and open
   questions. Supported findings survive even when other claims fail. Keep the deterministic
   verification notes; never present unresolved claims as established facts.
5. If an explicit Foundry capability context already exists and the report matches its scope,
   retain the exact completed report with `foundry_capture_analysis`, or record scoped observations,
   proposals and knowledge gaps with `foundry_record_knowledge`. Preserve source references,
   uncertainty and contrary evidence. This does not accept product obligations, authorize
   reconstruction, or change the heavy-research activation gate. Unrelated research stays standalone.

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
