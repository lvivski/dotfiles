"""hello.py — Phase 1 smoke test harness.

Fans out three independent subagents and prints each answer plus the total cost.
Exercises wf.fan_out -> wf.agent -> JSONL parsing -> credit accounting end to end.

Run:
    cwf run examples/hello.py --disable-mcp
"""

QUESTIONS = [
    "In one sentence, what is a Python list comprehension?",
    "In one sentence, what is a Python generator?",
    "In one sentence, what is a Python decorator?",
]

results = wf.fan_out(
    QUESTIONS,
    lambda q: wf.agent(q, model="claude-haiku-4.5", label=q.rstrip("?").split()[-1], timeout=180),
)

for r in results:
    print("\n## %s\n%s" % (r.label, r.content.strip()))

total = sum(r.premium_requests for r in results)
print("\n[smoke] %d agents, %.2f premium credits" % (len(results), total))
