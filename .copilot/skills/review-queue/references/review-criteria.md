# Review criteria and metric limits

Use this reference when explaining a result, interpreting a metric, or revising review behavior.
The factory includes its review instructions directly in each agent prompt; normal runs do not
require another review pass or external material.

## Decision contract

Recommend `Approve` only when all supplied diff evidence is complete, every chunk is low-risk and
clean, every independent check passes, and assignment policy permits it. This is a recommendation,
never permission to approve a PR on the user's behalf.

Material correctness or maintainability concerns, missing tests, unresolved uncertainty, incomplete
evidence, and failed review or verification results require `Needs review`. Preserve concrete
findings and independent verifier rejection reasons in the report. Model agreement is a triage
safeguard, not proof of quality or a substitute for human judgment.

## Maintainability rubric

Assess maintainability separately from correctness. Both review stages look for newly introduced
or worsened problems that make future changes materially harder.

| Concern | Evidence to look for in the supplied diff |
| --- | --- |
| Duplication | Repeated behavior that must be kept in sync across multiple implementations |
| Unnecessary abstraction | Indirection or extra APIs that add maintenance work without a demonstrated need |
| Unnecessary growth | Verbose scaffolding or machinery beyond what the visible behavior requires |
| Concentrated complexity | Functions accumulating branching or unrelated responsibilities |

Each concern must identify its category and include a visible file/hunk, or a chunk plus exact
excerpt when location context is missing; the changed-code evidence; its concrete maintenance
cost; and a simpler behavior-preserving approach.

Do not invent locations, unseen duplicates, or baseline behavior. Do not report pre-existing debt,
formatting preferences, speculative future requirements, or guesses about AI authorship. A wrapper
being single-use is not sufficient evidence by itself. Distinguish production logic from tests,
documentation, generated code, lockfiles, and justified compatibility code before judging growth.
Missing context for a specific material concern is uncertainty, not a fabricated finding.

## Observed line changes

The factory counts added and deleted textual hunk lines and their net difference before chunking,
for both GitHub and Azure DevOps. File headers are excluded; comments, blank lines, tests, docs,
generated files, and lockfiles are included. These are observed diff-line counts, not source LOC.

Counts provide context, never an approval threshold: necessary growth is not a defect, and fewer
lines are not automatically better. Partial counts cover only observed text. Missing or binary-only
text is unavailable rather than zero. Truncated or opaque evidence cannot produce `Approve`.

## Unmeasured structural metrics

**Verbosity** describes redundant source lines. Measuring it requires full-source AST-based
redundancy checks and clone detection, with overlapping flagged lines counted only once.
**Erosion** describes the concentration of code in large, complex functions. Measuring it requires
full function boundaries, cyclomatic complexity, and source-line counts.

This diff-only workflow reports both as **not measured**. Do not estimate ratios from chunks, use
numeric quality rankings, or add checkout/analyzer work implicitly. Unavailable metrics alone do
not block approval.
