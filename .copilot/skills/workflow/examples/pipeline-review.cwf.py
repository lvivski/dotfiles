files = args or ["README.md"]


def review(path):
    return wf.agent(
        f"Review {path} for real, reproducible bugs. Say NO ISSUES if none.",
        model="claude-haiku-4.5",
        phase="review",
        label=path,
    )


def verify(review_result, path):
    return {
        "path": path,
        "review": review_result,
        "verdict": wf.verify(
            review_result,
            rubric="real, reproducible bug with enough evidence to act",
            model="claude-haiku-4.5",
            phase="verify",
            label=path,
        ),
    }


rows = [row for row in wf.pipeline(files, review, verify) if row is not None]
solid = [row for row in rows if row["verdict"].passed]

if not solid:
    print("No verified issues found.")
else:
    report = wf.synthesize(
        [f"{row['path']}:\n{row['review'].content}" for row in solid],
        prompt="Group these verified findings by severity.",
        model="claude-sonnet-4.5",
        label="report",
    )
    print(report.content)
