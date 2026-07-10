# Workflow recipes

Use these patterns as defaults, not a menu to present to the user. Copy the matching `.mjs`
example from `examples/`.

## Pipeline: default for multi-stage work

Use when each item has the same chain of stages and no stage needs all items at once. If a stage
throws, that item becomes `null`; filter/report those rows explicitly. Pass a trailing
`{ errors: "raise" }` when any failed item should abort the whole pipeline, or `{ concurrency: N }`
to throttle (e.g. parallel checkouts). A dropped item makes the run `partial`. For a fail-fast outer
pipeline, catch item-local model/parse failures inside the stage and return a failure sentinel; let
only systemic errors escape. Copy `examples/pipeline-review.mjs`.

## Fan-out and synthesize

Use when the merge stage needs every result at once. `fanOut()` defaults to re-raising branch errors;
pass `{ errors: "drop" }` to keep partial results. `parallel()` is the barrier helper for thunks and
defaults to dropping branch errors to `null`; either kind of drop is counted and makes the run
`partial`. Copy `examples/fanout-synthesize.mjs`.

## Adversarial verification

Use for findings that may be false positives. Keep verifier lenses diverse when failure modes differ.
`verify()` is fail-closed (a verifier failure yields a failed verdict, not a crash). Copy
`examples/pipeline-review.mjs` and adapt the rubric/lens.

## Deep research

1. Use `structured()` to decompose the question into angles.
2. Research each angle with quarantined reader agents. For web research, opt into network:
   `quarantine({ denyUrl: [], enableMcp: true })`.
3. Verify source support by opening the cited URLs with separately quarantined network/MCP readers;
   shell and write remain denied.
4. Synthesize only verified or explicitly caveated claims.

Copy `examples/deep-research.mjs`.

## Tournament

Use comparative judgment for taste, ranking, or selecting a best option — usually more reliable than
absolute scoring. Copy `examples/tournament.mjs`.

## Consensus verification

Use `consensus(subject, rubric, { reviewers: 3 })` when critical work needs independent dual/triple
review. It requires a successful-reviewer quorum, then keeps the majority verdict plus dissenting
reasons. For high-stakes checks, prefer optional model-family diversity with `{ models: [...] }` so
reviewers are less likely to share blind spots; leave it unset for ordinary consensus.

## Generate and filter

Use for brainstorming names, approaches, prompts, or test ideas. Copy `examples/generate-filter.mjs`.

## Classify and route

Use a closed class list. `classify()` throws if no valid class is returned — handle it. Copy
`examples/classify-route.mjs`. In batch workflows, convert that item-local error to an explicit row
instead of aborting healthy siblings.

## Loop until dry

Use when discovery size is unknown. Deduplicate against everything already seen, and stop after a
fixed number of dry rounds. Copy `examples/loop-until-dry.mjs`.

## Cross-run memory

For recurring workflows, persist progress with a `memory` file: `memory.read()` prior state,
`memory.append(...)` the next step (per-run checkpoints reset each run). Copy
`examples/loop-memory.mjs`.

## Quarantine untrusted content

- Reader agents that inspect user files, web pages, issues, PR comments, or model-generated text get
  `quarantine()`.
- If a later verifier or synthesizer consumes that text, pass `quarantine({ allowAllTools: false })`
  unless it truly needs tools.
- A trusted actor agent should receive only structured, verified outputs before taking privileged
  actions.

## Coverage and budget reporting

If the workflow does not cover everything, `log()` the boundary and say the same in the final answer.
Silent sampling or budget truncation reads as complete coverage and is misleading.
