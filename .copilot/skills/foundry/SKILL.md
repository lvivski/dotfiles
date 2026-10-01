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

Foundry is the authority for plan, task, attempt, evidence, verification, and cancellation state.
This skill drives App-native tools around that state machine. App project sessions own repository
mutation; native Dynamic Workflows perform bounded analysis only.

## Scope

Use this protocol when the user explicitly requests Foundry coordination. For routine changes,
prefer native plan mode and direct tools; for ordinary multi-session or stacked-PR work, use the
native `orchestrate` or `pr-stack` flows without creating a Foundry plan.

Keep the complete coordinator protocol even for a small task. A native plan-mode document is not
a substitute for the completed planning Workflow result required by `foundry_create_plan`.

## Hard rules

1. Never create a child session before `foundry_reserve_task`.
2. Attach only the exact child session created by this coordinator for that reserved attempt.
3. Use the returned `baseBranch` and `delegationPrompt` unchanged.
4. Record a terminal attempt before reporting it or dispatching newly unblocked work.
5. Never infer plan, correction-wave, or completion approval. Ask the user and record the named
   approver only after an explicit answer.
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
    These delivery fields remain child-reported claims; the final verify task checks the exact commit
    from a separate read-only App session.
12. Never modify a `launchSpec` returned by a Foundry prepare tool, including its limits. For any
    direct `run_dynamic_workflow` call not based on a returned `launchSpec`, do not pass `limits`; use the
    workflow's declared limits unless the user explicitly requests an override. Never lower a declared
    or returned limit without an explicit user request.

## Choose the current phase

Read the matching reference **before issuing tools for that phase**. Each contains a required,
ordered protocol, not optional background reading. Load the next phase only when its prerequisites
are satisfied. If the current state is uncertain, recover before dispatching or relaunching work.

| Current need | Required reference |
| --- | --- |
| Create a plan and obtain approval | [Planning and approval](references/planning.md) |
| Reserve, create, attach, and record task attempts | [Task dispatch](references/dispatch.md) |
| Verify delivery, approve correction waves, and finish | [Verification and completion](references/verification.md); also [task dispatch](references/dispatch.md) before creating the verifier session |
| Resume work, reconcile missing state, or repair artifacts | [Recovery](references/recovery.md) |
| Stop owned work and finalize cancellation | [Cancellation](references/cancellation.md) |

When handing back control, report the stable plan ID, recorded state, and any blocker or explicit
approval still needed. Do not describe a requested action as completed before its state is recorded.
