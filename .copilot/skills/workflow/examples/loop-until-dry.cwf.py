question = args or "Find likely issues in this project."
seen = set()
dry_rounds = 0


def find_more(round_index):
    global dry_rounds
    result = wf.agent(
        "Find new issues not already seen.\n\n"
        f"Question: {question}\n\nAlready seen:\n{sorted(seen)}",
        model="claude-haiku-4.5",
        phase="discover",
        label=f"round-{round_index}",
    )
    candidates = [line.strip() for line in result.content.splitlines() if line.strip()]
    new = [line for line in candidates if line not in seen]
    seen.update(new)
    dry_rounds = dry_rounds + 1 if not new else 0
    wf.log(f"round {round_index}: {len(new)} new finding(s)")
    return new


wf.loop_until(find_more, lambda _: dry_rounds >= 2, max_iters=6)

report = wf.synthesize(
    sorted(seen),
    prompt="Deduplicate and summarize these findings. Note uncertainty and evidence gaps.",
    model="claude-sonnet-4.5",
    label="report",
)
print(report.content)
