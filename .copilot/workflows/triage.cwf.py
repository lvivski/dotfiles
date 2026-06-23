# triage.cwf.py — classify, cross-check, and summarize a batch of tickets.
# Saved workflow: `cwf run ~/.copilot/workflows/triage.cwf.py --args '["...", "..."]'`
tickets = args or ["app crashes on export", "please add dark mode", "how do I reset my password?"]


def handle(t):
    kind = wf.classify(t, ["bug", "feature", "question"], model="claude-haiku-4.5")
    detail = wf.agent(f"In one sentence, suggest next action for this {kind}: {t}",
                      model="claude-haiku-4.5", label=kind)
    return {"ticket": t, "kind": kind, "action": detail.content.strip()}


with wf.phase("triage"):
    rows = wf.fan_out(tickets, handle)

report = wf.synthesize(
    [f"{r['kind']}: {r['ticket']} -> {r['action']}" for r in rows],
    prompt="Group these by kind into a short triage report.",
    model="claude-sonnet-4.5",
)
print(report.content)
