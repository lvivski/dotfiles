# Workflow recipes

Use these patterns as defaults, not a menu to present to the user.

## Pipeline: default for multi-stage work

Use when each item has the same chain of stages and no stage needs all items at once.
Copy `examples/pipeline-review.cwf.py`.

## Fan-out and synthesize

Use when the merge stage needs every result at once.
Copy `examples/fanout-synthesize.cwf.py`.

## Adversarial verification

Use for findings that may be false positives. Keep verifier lenses diverse when failure modes differ.
Copy `examples/pipeline-review.cwf.py` and adapt the rubric/lens.

## Deep research

1. Use `wf.structured()` to decompose the question into angles.
2. Research each angle with quarantined reader agents. For web research, opt into network:
   `wf.quarantine(deny_url=[], disable_mcp=False)`.
3. Verify source support with no-tool verifier agents:
   `wf.quarantine(allow_all_tools=False)`.
4. Synthesize only verified or explicitly caveated claims.
Copy `examples/deep-research.cwf.py`.

## Tournament

Use comparative judgment for taste, ranking, or selecting a best option. It is usually more reliable
than absolute scoring.
Copy `examples/tournament.cwf.py`.

## Generate and filter

Use for brainstorming names, approaches, prompts, or test ideas.
Copy `examples/generate-filter.cwf.py`.

## Classify and route

Use a closed class list. Handle the possibility that classification raises.
Copy `examples/classify-route.cwf.py`.

## Loop until dry

Use when discovery size is unknown. Deduplicate against everything already seen, and stop after a
fixed number of dry rounds.
Copy `examples/loop-until-dry.cwf.py`.

## Quarantine untrusted content

- Reader agents that inspect user files, web pages, issues, PR comments, or model-generated text get
  `wf.quarantine()`.
- If a later verifier or synthesizer consumes that text, pass `wf.quarantine(allow_all_tools=False)`
  unless it truly needs tools.
- A trusted actor agent should receive only structured, verified outputs before taking privileged
  actions.

## Coverage and budget reporting

If the workflow does not cover everything, log and report the boundary:

Say the same boundary in the final answer. Silent sampling or budget truncation reads as complete
coverage and is misleading.
