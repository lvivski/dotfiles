"""patterns_demo.py — exercise a few patterns against the real Copilot CLI.

Validates that a real model emits JSON the patterns can parse (classify/verify).

    cwf run examples/patterns_demo.py
"""

ticket = (
    "When I click 'Export', the app crashes with a NullPointerException in "
    "ReportBuilder.java line 412. Happens every time on v2.3.1."
)

category = wf.classify(
    ticket,
    ["bug", "feature-request", "question", "documentation"],
)
print("classify -> %s" % category)

claim = "The capital of Australia is Sydney."
verdict = wf.verify(
    claim,
    rubric="The statement must be factually correct.",
)
print("verify   -> passed=%s score=%s reasons=%s" % (
    verdict.passed, verdict.score, verdict.reasons[:80]))

# pipeline: stream each ticket through classify -> next-action, no inter-stage barrier.
tickets = [ticket, "Please add a dark mode toggle.", "How do I reset my password?"]
rows = wf.pipeline(
    tickets,
    lambda t: wf.classify(t, ["bug", "feature-request", "question"]),
    lambda kind, t, i: "%d. [%s] %s" % (i, kind, wf.agent(
        "In one short sentence, the next action for this %s: %s" % (kind, t),
        agent="worker", phase="triage", label=kind).content.strip()),
)
print("pipeline ->\n  " + "\n  ".join(rows))
