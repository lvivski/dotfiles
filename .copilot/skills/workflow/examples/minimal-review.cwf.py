items = args or ["item one", "item two"]


def review(item):
    return wf.agent(
        f"Review this item and report concrete findings: {item}",
        agent="worker",
        phase="review",
        label=str(item)[:24],
    )


def verify(result, item):
    return {
        "item": item,
        "finding": result,
        "verdict": wf.verify(
            result,
            rubric="specific, supported, and actionable",
            phase="verify",
            label=str(item)[:24],
        ),
    }


rows = [row for row in wf.pipeline(items, review, verify) if row is not None]
kept = [row["finding"] for row in rows if row["verdict"].passed]

report = wf.synthesize(
    kept,
    prompt="Deduplicate and summarize these verified findings.",
    label="report",
)
print(report.content)
