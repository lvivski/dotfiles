prompt = args or "Propose an API name for this feature."

candidates = wf.generate_and_filter(
    prompt,
    n=8,
    rubric="short, memorable, unambiguous, and consistent with this repository",
    model="claude-haiku-4.5",
    label="name",
)

for index, candidate in enumerate(candidates, 1):
    print(f"{index}. {candidate.content.strip()}")
