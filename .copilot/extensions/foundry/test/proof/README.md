# Foundry proof coverage

The checked-in modules are **prewritten lifecycle fixtures**. They exercise recovered
obligations, candidate comparison, rejection, preservation, and renewal. The evaluator
runs in a separate Node process and records its actual process ID and observation time.
These fixtures are not evidence that an agent reconstructed an implementation.

## Live native experiment

The isolated experiment attempted on 2026-11-10 was blocked before factory initialization.
The host launched both the project-scoped snapshot and the older user-scoped Foundry
extension. The project provider exited during registration with:

```
Workflow "audit" is already registered by extension "user:foundry"
```

The user provider reached readiness. The project provider did not. The documented
project-shadowing behavior therefore could not be relied on in this runtime.
No live factory, accepted contract, plan, task reservation, candidate or verification
Workflow was created in that attempt. The global extension was left unchanged.
Preflight and loader evidence were retained in the experiment's session artifacts.
The user chose to finish review and ship the code with this blocker documented.

A separate bounded evaluator checked the proposed canonical-JSON contract against
the incumbent module successfully. This establishes that the contract describes
those incumbent behaviors; it does not demonstrate a fresh implementation.

## Retry conditions

Use an isolated runtime that registers only the intended Foundry provider, and verify
its tools, canvas and native Workflow registry before creating authority. Do not silently
substitute the older global implementation, direct module calls, mocked Workflow results,
or caller-supplied verdicts.

Supply a fresh App generation session with the sealed contract and allowed foundations,
without incumbent source or implementation history. Follow the [dispatch protocol](../../../../skills/foundry/references/dispatch.md):
reserve, create with setup-only kickoff, corroborate completion and the unchanged base/worktree,
attach, then send its exact delegation prompt coordinator-only. Attach the distinct verifier before it
detaches to the immutable target commit. Run the pinned evaluator and the real native
verification Workflow, retaining exact inputs, commits, process/session/run identities
and output.

Contract, plan, completion and replacement decisions remain separate explicit approvals.
Include a genuinely nonconforming negative control and retain the incumbent on failure.
Only a completed live run supports a bounded reconstruction claim; unit tests and this
preflight do not close that evidence gap.
