# Foundry

Foundry takes a committed brief and works toward one result: a Git commit that passes both the product check and the final goal check. Scouts identify missing behavior, writers produce independent outputs, and new evidence determines the next work. A passing checkpoint is progress, not release. Foundry leaves the target branch untouched.

| I want to… | Start here |
|---|---|
| Describe what success looks like | [`/foundry brief <idea>`](../../skills/foundry/references/brief.md). Reviewing or confirming a brief does not start work. |
| Run a reviewed plan | [`/foundry plans`, then `/foundry start <plan>`](../../skills/foundry/references/runs.md#start), in the owning repository session. |
| Understand an assignment or a wait | [`/foundry status <run-id>`](#see-what-can-run-in-parallel). Reading the board cannot advance the run. |
| Everything appears stuck | [When nothing is moving](../../skills/foundry/references/runs.md#when-nothing-is-moving): read `recovery` for the named actor, evidence, and next allowed step. The owner need not author fixes. |
| Recover a broken test without changing the product | Commit [independent controls](PROTOCOL.md#automatic-test-recovery) alongside the evaluator before starting. The owner diagnoses a signed failure and rechecks the same work. |
| Correct a failed adopted assembly or evaluator | [Let a bounded writer draft the correction](../../skills/foundry/references/runs.md#evaluator-repinning). Review scope and exact bytes; an existing external patch can still be imported. |
| Stop new work or continue the same run | [Pause and resume](../../skills/foundry/references/runs.md#pause-and-resume). Existing receipts and work stay in place. |
| Change or regenerate Foundry itself | [Regeneration specification](SPEC.md) for the contract and acceptance cases; [protocol reference](PROTOCOL.md) for precise formats and limits. |

### See what can run in parallel

The **Work graph** answers “What is this assignment for, and whose output does it need?” Select a node to read its task. If the behavior was defined in a file instead, **Read assigned specification** opens its pinned text. **Requires** names the producer outputs declared by this assignment; **Used by** names its visible consumers. Solid arrows mean checked input, dashed arrows mean pending. No arrow means no declared link in this view, not proof that every prerequisite or shared resource is available.

The status strip separates the run phase from assignment counts. Each count uses the same icon and color as its graph cards; open **Run** to filter by that status or inspect the checkpoint, goal and blockers. Use **Trace selection** to follow a dependency chain, **/** to find work, and **Assignment evidence** for exact scope, evaluator and pins. Assigned means a writer is bound, not necessarily running. A participant sees only its own visible work. [Board controls and status meanings](PROTOCOL.md#see-what-can-run-in-parallel)

### Explore a state machine

**A machine decides; a chart shows the rules.** For example, a run can be held by a permission check or paused by its operator. When permissions return, the machine can clear the matching hold. It cannot undo the operator's pause. The chart shows why the same event has different outcomes.

Open **State explorer** from the board or open the Foundry canvas with `{machine:true}`. Follow the straight lanes and rounded corners to see where transitions split, rejoin or return. Every event label has a border; hover or focus it to highlight its line without firing it. Choose a state on the diagram or in the inspector; **Fit chart** shows the whole region. Select an event to see why it fires. **Ordered rules** shows its guards, destination, context update, queued effect and admission where applicable. A loop returns to its state; an event drawn inside it acts without leaving it. The explorer uses the installed runtime definitions with hypothetical guard inputs. It cannot change a ledger or run an effect. [Simulation and recovery signals](PROTOCOL.md#interruptions)

## Commit the contract

Put the user journey and independent checks under `.foundry/`. Set the plan's direction to the whole outcome and give each squad a bounded area to inspect. Pin what counts as success before asking Foundry to start. [Plan fields and complete example](PROTOCOL.md#commit-the-contract)

### Discover and split work

Give each proposed assignment a task that says what must become true. Declare a dependency when the writer needs another **checked output**, not because one task usually happens first. A cited interface, permission to read prior files and access to a shared resource are different prerequisites. [Discovery, research and ownership rules](PROTOCOL.md#discover-and-split-work)

## Run operations

Use the [owner runbook](../../skills/foundry/references/runs.md) for the next action and the [writer guide](../../skills/foundry/references/assignments.md) for an existing grant. Neither a status read nor a request for a preview authorizes a different task. [Choose a native tool or migrate an older call](PROTOCOL.md#choose-a-foundry-tool).

### Regeneration and checks

A writer submits the complete granted output from its frozen inputs. In new runs, independent **Rubber Duck** review is part of that same writing assignment: a component pass freezes the candidate for review, without starting another writer or spending another assignment. Only approval makes it available to dependents or the product check. Blocking findings go back to the same writer within its repair budget; an unavailable review leaves the output unpublished. `foundry_status` distinguishes the component receipt from the code review. Only a separate product pass establishes a checkpoint; a goal run needs both product and goal passes on the same commit. [Evaluator inputs, ownership and receipts](PROTOCOL.md#regeneration-and-checks)

### Hand off and measure the result

Report the exact accepted commit and checked target. Exporting, landing and archiving are separate actions. [Handoff](../../skills/foundry/references/handoff.md) · [Timing and usage](../../skills/foundry/references/metrics.md)

### Interruptions

Start with the original obligation. Foundry watches for receipts, restored permissions and changed inputs; it does not replay an uncertain call. An explicit pause stays paused. If a changed target contract prevents integration, the owner session proposes adoption. If an included component then fails, it can propose an exact correction to inherited files or to that output alone, without adopting the target again. An owned replacement must earn a new component pass and any required review. Automatic approvals wait for the owner turn to finish. A reattached owner can restore an abandoned form, not answer it or duplicate a live request. [Recovery by symptom](../../skills/foundry/references/runs.md#pause-and-resume) · [Exact recovery contracts](PROTOCOL.md#interruptions)

## Development

Follow the [red/green and independent Rubber Duck requirements](AGENTS.md#verification). Change the [specification and acceptance case](SPEC.md#keeping-the-specification-current) alongside the implementation. The declaration comparison is `node --test .copilot/extensions/foundry/test/interface.test.mjs`; it supplements, rather than replaces, behavior tests. [Full development commands](PROTOCOL.md#development-checks)

### State, signals and authority

The interpreter computes the next snapshot and effects from an event. The scheduler uses those decisions to plan work; the ledger owns durable state, and only the authorized issuer makes a native call. [Architecture and extension API](PROTOCOL.md#state-signals-and-authority)

### Goal-verdict contract for a blind rebuild

An independent verifier must distinguish a checked milestone from exact goal qualification. [Full verdict contract](PROTOCOL.md#goal-verdict-contract-for-a-blind-rebuild)

### Installed-SDK checker contract

The checker must resolve the SDK installed on the host without modifying the implementation it checks. [Checker invocation, inputs and failure behavior](PROTOCOL.md#installed-sdk-checker-contract)
