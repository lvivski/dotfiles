question = args if isinstance(args, str) else "What changed in this topic recently?"
no_tools = wf.quarantine(allow_all_tools=False)

plan = wf.structured(
    f"Break this research question into 4 independent angles:\n\n{question}",
    {"type": "array", "items": {"type": "string"}},
    label="plan",
    **no_tools,
)
angles = ([angle.strip() for angle in plan.value if str(angle).strip()] if plan.ok else []) or [question]


def research(angle):
    return angle, wf.agent(
        "Research this angle. Cite every factual claim with a source URL and flag uncertainty.\n\n"
        f"Angle: {angle}",
        agent="researcher",
        phase="research",
        label=angle[:24],
        **wf.quarantine(deny_url=[], disable_mcp=False),
    )


def verify_finding(reviewed):
    angle, finding = reviewed
    verdict = wf.verify(
        finding,
        rubric="every factual claim has a credible source URL and uncertainty is explicit",
        phase="verify",
        label=angle[:24],
        **no_tools,
    )
    return angle, finding, verdict


checked = [row for row in wf.pipeline(angles, research, verify_finding) if row is not None]
trusted = [finding for _, finding, verdict in checked if verdict.passed]
fallback = [finding for _, finding, _ in checked]

report = wf.synthesize(
    trusted or fallback,
    prompt=f"Answer the question with only sourced claims. Question: {question}",
    label="report",
    **no_tools,
)
print(report.content)
