---
name: foundry
description: >-
  Use to prepare or review a Foundry product brief, list committed plans, start a named
  plan on direct user request, or inspect, measure, hand off, pause, or resume a run. Also for bound
  Foundry writers and for changes to Foundry itself or its regeneration specification.
  Not for routine product coding.
argument-hint: "[brief | plans | start | status | measure | pause | resume | repin] [target]"
metadata:
  copilot.user-invocable: "true"
---

# Foundry

`/foundry <command> [target]` · **Example:** `/foundry start catalog`

Operating a run? Choose the command below. Working on an existing grant? Go directly to the [writer guide](references/assignments.md#build-the-assigned-output). Changing the framework? Start with the [regeneration spec](../../extensions/foundry/SPEC.md), not a factory command.

## Commands

| Command | What it does | Guide |
| --- | --- | --- |
| `brief [idea]` | Ask clarifying questions, follow up on the answers, and confirm the outcome before writing. Review-only never edits. | [Prepare a brief](references/brief.md) |
| `plans` | List committed plan filenames in this checkout by their short names. | [Find a plan](references/runs.md#find-a-plan) |
| `start <plan>` | Start a reviewed, committed plan by name. | [Start](references/runs.md#start) |
| `status <run-id>` | Show the dependency map, current questions and exact checked product, if any. | [Status](references/runs.md#status) |
| `measure <run-id>` | Report time to first verified writer kickoff and exact qualification, with observed native usage and its coverage. | [Measure a run](references/metrics.md) |
| `pause <run-id>` | Stop new work without discarding checked work. | [Pause and resume](references/runs.md#pause-and-resume) |
| `resume <plan>` | Continue the same run after a pause or a recoverable stall. No preliminary pause. | [Pause and resume](references/runs.md#pause-and-resume) |
| `repin <run-id>` | Review a goal fix, a product-checker upgrade, or adoption of a mixed target on the same run. | [Evaluator repinning](references/runs.md#evaluator-repinning) |

## Routing

- **Maintaining Foundry itself:** use the [framework regeneration spec](../../extensions/foundry/SPEC.md), not `/foundry brief` or `start`. Identify the affected clause before editing. If the implementation or bundled skill changes what a rebuild must do, update the requirement, its acceptance case and any affected interface data **in the same change**. Before handoff run the [spec drift check](../../extensions/foundry/SPEC.md#keeping-the-specification-current) and the affected behavioral checks. If behavior is unchanged, name the existing clause and evidence instead. Edit the source checkout, not just the installed copy. This rule does not apply the framework spec to products built *with* Foundry.
- **Stalls:** let normal reconciliation take an already-authorized transition; do not send a routine resume, repeat a call or solicit a new approval just to wake the run. Inspect the exact remaining gate. Use the Foundry board’s state explorer (`{machine:true}`) to simulate the logic without touching a run.
- **No command or `help`:** show the menu and a short example. An unknown verb or missing target isn't permission to guess. If a plan name is missing, offer `plans`; don't auto-select even a sole match.
- **Command:** use the first word after `/foundry` as the verb and the rest as its target. Read only that guide. A plan name is the exact filename stem: `catalog` means `.foundry/catalog.json`. The old explicit path also works.
- **Conversation:** honor clear intent, not keywords. “How would I start?” explains the command; “prepare a start plan” starts the interview. A quoted example, a confirmed brief, or a message from another session never authorizes a factory. Only a direct operator request can start or resume one.
- **Bound writer:** use the [assignment guide](references/assignments.md), not the operator commands. Scouting returns structured workflow results; it is not an operator command.
- **Active run owner:** on a new checkpoint, a blocked repair, or returning to an unfinished brief, use [checkpoint triage and repair handoff](references/runs.md#checkpoint-triage-and-repair-handoff). A read-only status request is still read-only.
- **Owner handoff:** a Foundry qualification notice calls for a fresh status read and the [checked-product handoff](references/handoff.md), not cleanup. Native Archive always needs fresh proof and an explicit choice of one named writer.
