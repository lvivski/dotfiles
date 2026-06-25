items = args or ["README.md"]

parts = wf.fan_out(
    items,
    lambda item: wf.agent(
        f"Summarize the relevant facts from {item}.",
        model="claude-haiku-4.5",
        phase="summarize",
        label=str(item)[:24],
    ),
)

report = wf.synthesize(
    parts,
    prompt="Write one coherent overview from these summaries.",
    model="claude-sonnet-4.5",
    label="report",
)
print(report.content)
