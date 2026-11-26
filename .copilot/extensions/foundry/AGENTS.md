# Maintaining Foundry

Make each change leave Foundry simpler to operate or maintain. Name the step an operator no longer takes or the code path a maintainer no longer has to reason about. Prefer removing a rule or reusing an existing path: if the same writer can safely finish the same work, do not send it through another review. Fix a product-specific gap in its brief or evaluator, not with a framework mode.

**Maintain the [regeneration specification](SPEC.md) with the implementation.** Before a framework or bundled-skill change, identify the affected requirement and its acceptance case. Update them, and any affected declared interfaces, in the same change. For unchanged behavior, cite the existing clause and check. Follow the [spec drift procedure](SPEC.md#keeping-the-specification-current); never bless an unexpected implementation difference by merely refreshing a snapshot.

Keep the [operator guide](README.md) short: point to a task first, a behavior or decision in the [spec](SPEC.md) next, and exact formats in the [protocol reference](PROTOCOL.md) only when needed. Keep public section links usable.

## State and recovery

**Recovery is part of the normal state machine.** For each stall, name the fact that would make the next action both unique and already authorized. Register the guarded transition, its wake source (including after reload), and its return to normal dispatch. Do not stop at adding an operator command. If no such fact exists, identify the exact decision, missing evidence or permission and leave the run waiting. A clock is a reason to observe, not evidence that a call failed.

Start with the entity that owns the state, not an operator command. Put each literal destination, context update and intended effect on its executable rule. Production code sends a typed event through `transition`; use required mode for commands and optional mode for ignorable observations. Bind effects with `executor` rather than choosing an action again in the caller. `step` and `compose().plan` are for pure inspection. Keep Git, timers, SDK calls and domain policy out of the generic interpreter. Never treat an unknown action or unhandled required decision as success.

Assignments (`assignment.mjs`), calls and reviews (`dispatch.mjs`), activity, release, checkpoint quiescence and the issuer's independent observation regions have different lifetimes. Keep them separate. Link them through verified signals and the existing ledger transaction, not a second mutable copy of the run. When changing the graph, validate the proposed edit before applying it and preserve unrelated entities and original pins. Acyclicity does not establish readiness. Register the **executable** definition and any parallel group in the state explorer's catalog; don't maintain a second diagram. Test both sides of each guard, ignored and duplicate events, and recovery on the old snapshot.

For automatic recovery, go red on a disposable stalled run, reload its issuer, and drive only the production wake or ordinary turn. Assert the original work reaches its next useful outcome, the original receipt survives, and repeated wakes, a stale read or an explicit operator stop cannot issue it again. Manual rescue proves only the manual path.

Explain each exported region, state and transition where it is declared. Describe Foundry concepts by their behavior: a *machine* defines the rules; a *chart* shows them. Keep purpose text distinct from diagnostics, evidence and guards. Both diagrams must be first-party projections of those inputs; neither a generic layout dependency nor a copy of the transition table belongs in the renderer.

After a state-machine edit, regenerate `spec/interface.json` from `test/interface.mjs`, review the semantic diff, and run the interface and execution/diagram parity tests. A passing JSON comparison alone cannot establish that the real ledger receives the right context or that an effect executes once.

## Changes in authority

Before adding a command, state, approval or retry, identify the concrete case the simpler path cannot handle. If there is none, leave it out. Moving a decision from code into an agent prompt is not a simplification if the agent still has to make it. Never simplify by weakening permissions, ownership, evidence or release checks.

Keep a confirmation only when its answer changes what is authorized or settles a question the evidence cannot answer. If the request and verified inputs already settle it, remove the dialog in every mode; do not move it into chat or synthesize a yes. Preserve earlier declines and unresolved dialogs.

Keep Foundry product-neutral. A run's product names, directory layout and domain vocabulary belong in its brief and evidence, not in framework code, prompts, documentation or test fixtures. Use synthetic examples for those. Preserve the actual evidence verbatim when handling a run.

Preserve complete valid reports and scheduling data. A model's context window limits what it can see at once, not what the runner should accept or retain. Pass runner-owned file paths to processes and scoped, immutable references with searchable pages to scouts. A preview, a file offer or scheduling feedback is not permission, a citation to unseen text, or a passing receipt.

Before adding a limit that rejects input, drops evidence or forces another check, name the actual host constraint or explicit operator budget. A convenient preview length is not one. Deduplicate identical requests and stop on no progress, not on the number of distinct findings.

## Verification

Reproduce a framework defect with a synthetic test in a disposable checkout. Observe it fail before the fix and pass afterward; test the user-visible outcome (e.g. exact bytes and all changed paths delivered), not the value of a constant. Never use a live run, a replay, or a repin for red/green validation.

Put regression cases in `<module>.test.mjs` beside the implementation so editors can group them. Keep shared setup in `test/`. Run the cases with the normal Node test runner; do not add a separate proof runner.

When refactoring a regression test, run the original and revised test against the same known defect and its correction. Both must fail for the intended reason and pass with the behavior restored. Distinguish an intentional change in expectations from a test-only refactor.

For recovery, first reproduce the already-affected assignment or review in a disposable run. Upgrade **that run** and exercise the supported operator or writer action for **the same work** through its next useful outcome. A different offer or an unrelated writer succeeding does not demonstrate recovery. Preserve original reports, receipts, earned outputs and outstanding calls; check late or duplicate results where relevant. If no safe path exists, report “prevented for future runs; existing work remains blocked” and explain what is missing. Missing evidence is not a failed product verdict.

Keep work admission separate from release qualification. An independent writer can bind to a checked checkpoint while the goal is pending. A new checkpoint is not by itself a reason to stop or restart another assignment. At integration, check the input pins and ownership: name what changed and hold only the work that depends on it. Verify that unrelated writers can finish with their original assignments and drafts. Respect worker limits and operator holds; the combined product still needs its own passing checks.

Give each scheduler module one reason to change. Project ledger evidence into facts; decide transitions without Git, SQLite, a clock, or the SDK; execute the selected action through the existing guarded adapter. Add live policy settings only for future admissions, never for the meaning of a receipt. Inject narrow capabilities for recovery (read, observe, wake), not the entire runtime. Exercise the same decision function in status and tests rather than reimplementing its rules.

Use `capacity.mjs` for reservation accounting. A proposal can wait for a free worker, so check its remaining lifetime budget separately; an actual reservation needs both. Handle every release state and action explicitly so adding a variant cannot inherit qualification or silently skip dispatch.
