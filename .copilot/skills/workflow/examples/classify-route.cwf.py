tickets = args or ["app crashes on export", "please add dark mode", "how do I reset my password?"]
no_tools = wf.quarantine(allow_all_tools=False)


def classify_ticket(ticket):
    return wf.classify(
        ticket,
        ["bug", "feature", "question"],
        model="claude-haiku-4.5",
        label="classify",
        **no_tools,
    )


def suggest_action(kind, ticket):
    detail = wf.agent(
        f"In one sentence, suggest the next action for this {kind}: {ticket}",
        model="claude-haiku-4.5",
        phase="triage",
        label=kind,
        **no_tools,
    )
    return {"ticket": ticket, "kind": kind, "action": detail.content.strip()}


rows = [row for row in wf.pipeline(tickets, classify_ticket, suggest_action) if row is not None]
report = wf.synthesize(
    [f"{row['kind']}: {row['ticket']} -> {row['action']}" for row in rows],
    prompt="Group these by kind into a short triage report.",
    model="claude-sonnet-4.5",
    label="report",
    **no_tools,
)
print(report.content)
