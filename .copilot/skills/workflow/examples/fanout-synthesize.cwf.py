items = args or ["README.md"]

parts = wf.fan_out(
    items,
    lambda item: wf.agent(
        f"Summarize the relevant facts from {item}.",
        agent="worker",
        phase="summarize",
        label=str(item)[:24],
    ),
)

report = wf.synthesize(
    parts,
    prompt="Write one coherent overview from these summaries.",
    label="report",
)
print(report.content)
