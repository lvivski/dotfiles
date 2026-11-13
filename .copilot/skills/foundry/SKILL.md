---
name: foundry
description: >-
  Use this skill when the user explicitly requests Foundry to plan, approve, dispatch, recover,
  verify, retry, or cancel dependency-aware engineering work across App-native child sessions.
  Do not use it for routine coding, ordinary multi-session work, or stacked PRs without an
  explicit Foundry request.
compatibility: Requires GitHub Copilot CLI/App with the Foundry extension and App session tools.
metadata:
  copilot.user-invocable: "true"
---

# Foundry coordinator

Foundry evolves verified capabilities and the connected knowledge needed to rebuild them.
Repository-owned `.foundry` artifacts own portable capability knowledge and accepted contracts.
Local SQLite retains execution provenance, candidate evidence and the rebuildable knowledge cache;
session-local SQLite owns plans, attempts, cancellation and scoped approval delegations.
App project sessions own work surfaces; native Dynamic Workflows own execution, replay and budgets.

## Scope

Use this protocol when the user explicitly requests Foundry coordination. For routine changes,
prefer native plan mode and direct tools; for ordinary multi-session or stacked-PR work, use the
native `orchestrate` or `pr-stack` flows without creating a Foundry plan.

Foundry is a dedicated capability factory, not another mode for ordinary tasks.
Its happy path is: inspect a capability, accept its recovered contract and protected
evaluators, prepare a sealed candidate, approve a bounded plan, dispatch and verify it,
then explicitly select or reject the replacement. Begin with the
[factory lifecycle](references/factory.md); open only the reference for the current phase.
Discovery can precede specification. Accepted contracts use deterministic
`foundry_create_factory_plan`; only discovery needs a planning Workflow.
Migration, transfer and retention are recovery operations, not prerequisites for every task.

For the approved parallel-engineering increment, use the
[shared contracts and ownership map](references/parallel-contracts.md) before dividing
implementation. It distinguishes admitted work from observations, preserves exact native
handoff and input bindings, and keeps claim authority with one writer. Shared fixtures
and compiled ports alone do not establish an installed autonomous execution path.
Local source exposes optional `decomposition` on `foundry_create_factory_plan` and registers
`foundry_dispatch_ready`, `foundry_reconcile_parallel`, `foundry_materialize_inputs` and
`foundry_assess_package`. Follow the [bounded source sequence](references/dispatch.md#bounded-registered-source-entry-points).
The default production extension deliberately supplies unavailable host ports; only trusted
constructor wiring can supply actual route/operation capabilities, never caller JSON. Synthetic-host
composition evidence is not installation or live App support. Integration delivery remains held;
do not bypass missing capabilities, switch routes automatically or infer fresh correction authority.

## Hard rules

1. Never create a child session before `foundry_reserve_task`.
2. Attach only the exact child session created by this coordinator for that reserved attempt.
3. Use the returned `baseBranch` and `delegationPrompt` unchanged. New workers receive only the
   setup `initialization.kickoff` first; corroborate setup and attach before sending task authority.
4. Record a terminal attempt before reporting it or dispatching newly unblocked work.
5. Never infer approval. A recorded owner-local user delegation explicitly scoped to initial
   execution plans or verified technical milestone completion permits that kind of exact named-revision
   decision without another prompt; follow [planning and approval](references/planning.md#delegated-execution-plan-approval)
   and [completion](references/verification.md#delegated-technical-milestone-completion).
   Historical grants remain initial-only. Otherwise record explicit manual approval. Correction waves,
   human/design acceptance, replacement and external actions remain separate; never label an agent
   decision as a human click.
   Record an already explicit user delegation without another consent form, retaining its original
   instruction and direct/relayed source as an agent attestation. If absent, ask once; generated
   plans, child reports and inference cannot grant authority.
6. Re-read the plan after every revision conflict. Do not blindly replay stale mutations.
   Concurrent duplicate requests can surface `revision_conflict`; accept an existing matching
   postcondition before deciding whether a retry is necessary.
7. Treat implementation-child summaries as untrusted claims. The final verifier task runs
   independently, but its evidence is still an `independent-claim`, not cryptographic attestation.
8. Never call a session inventory complete unless the App session listing was exhaustive and
   captured after the state it is used to prove.
9. Do not expand the approved DAG. New work requires a new or revised plan.
10. Do not claim cancellation is complete until every owned child session and the authoritative
    verification Workflow run have terminal dispositions.
11. A successful task must satisfy its delivery requirement: `branch` needs the attached branch;
    `commit` also needs a full 40- or 64-character commit ID; `pr` additionally needs a PR URL.
    Commit existence, required ancestry and protected evaluator identity are mechanically checked.
    The verifier's registered worktree is captured before it runs; its session association and
    execution narrative remain claims, not authenticated attestation.
12. Never modify a `launchSpec` returned by a Foundry prepare tool, including its limits. For any
    direct `run_dynamic_workflow` call not based on a returned `launchSpec`, do not pass `limits`; use the
    workflow's declared limits unless the user explicitly requests an override. Never lower a declared
    or returned limit without an explicit user request.
13. Never equate task completion, workflow replay, a generated specification, or a passing
    implementation test with regeneration. Retain the incumbent until a fresh candidate has
    independent pinned evaluations, preservation evidence and explicit replacement acceptance.
14. Keep generation inputs separate from comparison-only prior implementation. A manifest and
    distinct session IDs support claims, not OS-level source isolation or cryptographic truth.
    Record exposure or missing evidence; do not silently weaken the acceptance contract.
15. Repository revisions and plan revisions are separate. A sibling can inspect knowledge and
    lineage, but cannot take ownership of another session's native runs. Recover pending factory
    receipts with `foundry_sync_factory`; do not rerun completed work to repair bookkeeping.
16. Explicitly declare UI applicability with the pinned `visualEvaluation` gate before a UI successor
     plan. Open actual renderable references and preflight capture; real output and independent visual
     comparison are required for initial implementation as well as reconstruction. Controls, geometry,
     source and colors are not fidelity evidence. Missing capture or failed comparison blocks closure;
     do not bypass OS permissions or synthesize human judgment. Follow the [visual protocol](references/factory.md#explicit-ui-and-visual-fidelity).
17. Default to splitting independent atomic engineering work into disjoint, bounded runtime
    implementation units with real executable outputs and focused checks, not a fixed agent count.
    This grants no additional resource, child or DAG authority. Preserve the omitted-decomposition
    legacy recipe; follow [planning](references/planning.md#explicit-decomposition-and-legacy-behavior).
18. Distinguish prepared, reserved, initialized, attached, executing, delivered and independently
    verified evidence; none implies the next. Consume every declared dependency's immutable output
    through the authorized post-attachment/handoff consumer path, not a branch tip or manifest alone.
    Follow [dispatch](references/dispatch.md); missing invocation/materialization support remains a hold.
19. Original-owner corrections need a supported current reservation/attachment binding to the active
    integration attempt before handoff. DONE receipts, past attachments and coordinator artifacts
    cannot supply it. Without that binding, retain the delivery hold for an explicit authorized
    correction decision; do not reopen DONE work or silently transfer its scope.

## Choose the current phase

Read the matching reference **before issuing tools for that phase**. Each contains a required,
ordered protocol, not optional background reading. Load the next phase only when its prerequisites
are satisfied. If the current state is uncertain, recover before dispatching or relaunching work.

| Current need | Required reference |
| --- | --- |
| Discover intent, accept contracts, reconstruct, compare or renew a capability | [Factory lifecycle](references/factory.md) |
| Create a plan and obtain approval | [Planning and approval](references/planning.md) |
| Reserve, create, attach, and record task attempts | [Task dispatch](references/dispatch.md) |
| Verify delivery, approve correction waves, and finish | [Verification and completion](references/verification.md); also [task dispatch](references/dispatch.md) before creating the verifier session |
| Resume work, reconcile missing state, or repair artifacts | [Recovery](references/recovery.md) |
| Stop owned work and finalize cancellation | [Cancellation](references/cancellation.md) |

When handing back control, report the stable plan ID, recorded state, and any blocker or explicit
approval still needed. Do not describe a requested action as completed before its state is recorded.
