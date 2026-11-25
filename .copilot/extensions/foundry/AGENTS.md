# Maintaining Foundry

Make each change leave Foundry simpler to operate or maintain. Name the step an operator no longer takes or the code path a maintainer no longer has to reason about. Prefer removing a rule or reusing an existing path: if the same writer can safely finish the same work, do not send it through another review. Fix a product-specific gap in its brief or evaluator, not with a framework mode.

Before adding a command, state, approval or retry, identify the concrete case the simpler path cannot handle. If there is none, leave it out. Moving a decision from code into an agent prompt is not a simplification if the agent still has to make it. Never simplify by weakening permissions, ownership, evidence or release checks.

Keep a confirmation only when its answer changes what is authorized or settles a question the evidence cannot answer. If the request and verified inputs already settle it, remove the dialog in every mode; do not move it into chat or synthesize a yes. Preserve earlier declines and unresolved dialogs.

Keep Foundry product-neutral. A run's product names, directory layout and domain vocabulary belong in its brief and evidence, not in framework code, prompts, documentation or test fixtures. Use synthetic examples for those. Preserve the actual evidence verbatim when handling a run.

Preserve complete valid reports and scheduling data. A model's context window limits what it can see at once, not what the runner should accept or retain. Pass runner-owned file paths to processes and scoped, immutable references with searchable pages to scouts. A preview, a file offer or scheduling feedback is not permission, a citation to unseen text, or a passing receipt.

Before adding a limit that rejects input, drops evidence or forces another check, name the actual host constraint or explicit operator budget. A convenient preview length is not one. Deduplicate identical requests and stop on no progress, not on the number of distinct findings.

Reproduce a framework defect with a synthetic test in a disposable checkout. Observe it fail before the fix and pass afterward; test the user-visible outcome (e.g. exact bytes and all changed paths delivered), not the value of a constant. Never use a live run, a replay, or a repin for red/green validation.

Put regression cases in `<module>.test.mjs` beside the implementation so editors can group them. Keep shared setup in `test/`. Run the cases with the normal Node test runner; do not add a separate proof runner.

When refactoring a regression test, run the original and revised test against the same known defect and its correction. Both must fail for the intended reason and pass with the behavior restored. Distinguish an intentional change in expectations from a test-only refactor.

For recovery, first reproduce the already-affected assignment or review in a disposable run. Upgrade **that run** and exercise the supported operator or writer action for **the same work** through its next useful outcome. A different offer or an unrelated writer succeeding does not demonstrate recovery. Preserve original reports, receipts, earned outputs and outstanding calls; check late or duplicate results where relevant. If no safe path exists, report “prevented for future runs; existing work remains blocked” and explain what is missing. Missing evidence is not a failed product verdict.

Keep work admission separate from release qualification. An independent writer can bind to a checked checkpoint while the goal is pending. A new checkpoint is not by itself a reason to stop or restart another assignment. At integration, check the input pins and ownership: name what changed and hold only the work that depends on it. Verify that unrelated writers can finish with their original assignments and drafts. Respect worker limits and operator holds; the combined product still needs its own passing checks.

Give each scheduler module one reason to change. Project ledger evidence into facts; decide transitions without Git, SQLite, a clock, or the SDK; execute the selected action through the existing guarded adapter. Add live policy settings only for future admissions, never for the meaning of a receipt. Inject narrow capabilities for recovery (read, observe, wake), not the entire runtime. Exercise the same decision function in status and tests rather than reimplementing its rules.

Use `capacity.mjs` for reservation accounting. A proposal can wait for a free worker, so check its remaining lifetime budget separately; an actual reservation needs both. Handle every release state and action explicitly so adding a variant cannot inherit qualification or silently skip dispatch.
