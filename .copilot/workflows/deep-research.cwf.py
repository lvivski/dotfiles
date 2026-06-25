# deep-research.cwf.py — fan out research across angles, cross-check, synthesize a cited report.
#
#   cwf run ~/.copilot/workflows/deep-research.cwf.py --budget 30 \
#       --args '"What changed in the Python packaging ecosystem between 2020 and 2024?"'
#   cwf run ~/.copilot/workflows/deep-research.cwf.py --args '{"question":"...","angles":6}'
#
# Note: research workers use whatever web-search/fetch tools the agent has, so run WITHOUT
# --disable-mcp (network access is the point here).

# ---- inputs ---------------------------------------------------------------
if isinstance(args, dict):
    question = args.get("question") or args.get("q")
    max_angles = int(args.get("angles", 5))
elif isinstance(args, str):
    question, max_angles = args, 5
else:
    question, max_angles = None, 5

if not question:
    question = "What are the most important changes in HTTP/3 adoption since 2022?"
    wf.log("deep-research: no question supplied via --args; using a sample question.")


# ---- 1) decompose into independent angles ---------------------------------
plan = wf.structured(
    "Break the following research question into %d independent sub-questions or angles "
    "to investigate.\n\nQuestion: %s"
    % (max_angles, question),
    {"type": "array", "items": {"type": "string"}},
    model="claude-sonnet-4.5", label="plan",
)
angles = ([a.strip() for a in plan.value if str(a).strip()] if plan.ok else []) or [question]
wf.log("deep-research: %d angle(s)" % len(angles))
no_tools = wf.quarantine(allow_all_tools=False)


# ---- 2/3) research each angle, then verify as soon as it returns ------------
def research(angle):
    return angle, wf.agent(
        "Research this question using web search. State concrete findings and cite EVERY claim "
        "with a source URL. If evidence is thin or conflicting, say so.\n\nQuestion: %s" % angle,
        model="claude-haiku-4.5", label=angle[:24], phase="research",
        # Reads untrusted web content -> deny shell/write to contain prompt injection,
        # but keep network + MCP (web access is the whole point of this step).
        **wf.quarantine(deny_url=[], disable_mcp=False),
    )


def verify_finding(reviewed):
    angle, finding = reviewed
    verdict = wf.verify(
        finding,
        rubric="every factual claim is supported by a cited, credible source URL",
        refute=True,
        model="claude-haiku-4.5",
        phase="verify",
        label=angle[:24],
        **no_tools,
    )
    return angle, finding, verdict


checked = [
    row for row in wf.pipeline(angles, research, verify_finding)
    if row is not None
]
findings = [finding for (_, finding, _) in checked]
trusted = [finding for (_, finding, verdict) in checked if verdict.passed]
wf.log("deep-research: %d/%d findings survived verification" % (len(trusted), len(findings)))

# ---- 4) synthesize a cited report -----------------------------------------
report = wf.synthesize(
    trusted or findings,
    prompt=("Write a well-structured, cited report that answers the question below using the "
            "findings. Keep only well-sourced claims; list any open questions at the end.\n\n"
            "Question: %s" % question),
    model="claude-sonnet-4.5", label="report",
    **no_tools,
)
print(report.content)
