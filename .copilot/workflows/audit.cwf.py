# audit.cwf.py — audit files for a concern, adversarially verify findings, synthesize a report.
#
#   cwf run ~/.copilot/workflows/audit.cwf.py --budget 20 --disable-mcp \
#       --args '{"paths":["src/a.py","src/b.py"],"concern":"missing input validation"}'
#   cwf run ~/.copilot/workflows/audit.cwf.py --args '["src/a.py","src/b.py"]'
#
# Read-only: agents view the files from the directory cwf is launched in.
DEFAULT_CONCERN = "bugs, security issues, and missing error handling"

if isinstance(args, dict):
    paths = args.get("paths") or []
    concern = args.get("concern", DEFAULT_CONCERN)
elif isinstance(args, list):
    paths, concern = args, DEFAULT_CONCERN
else:
    paths, concern = [], DEFAULT_CONCERN

if not paths:
    print('audit: provide files, e.g. --args \'{"paths":["a.py"],"concern":"..."}\'')
    raise SystemExit(2)

no_tools = wf.quarantine(allow_all_tools=False)


def review(path):
    finding = wf.agent(
        "Review the file `%s` for: %s. List concrete issues with line references, or reply "
        "exactly 'NO ISSUES' if there are none." % (path, concern),
        model="claude-haiku-4.5", label=path, phase="audit",
        **wf.quarantine(),  # untrusted file content: read-only, no shell/write/network/MCP
    )
    return path, finding


def verify_review(reviewed):
    path, finding = reviewed
    if not finding.ok or "NO ISSUES" in finding.content.upper():
        return path, finding, None
    verdict = wf.verify(
        finding,
        rubric="each reported issue is real and relevant to: %s" % concern,
        refute=True,
        model="claude-haiku-4.5",
        label=path,
        phase="verify",
        **no_tools,
    )
    return path, finding, verdict


checked = [
    row for row in wf.pipeline(paths, review, verify_review)
    if row is not None
]
solid = [(p, f) for (p, f, v) in checked if v and v.passed]
if not solid:
    print("audit: no verified issues found for: %s" % concern)
else:
    report = wf.synthesize(
        ["## %s\n%s" % (p, f.content) for (p, f) in solid],
        prompt="Summarize these verified findings about '%s'. Group by severity, most serious "
               "first, and give a one-line fix suggestion per issue." % concern,
        model="claude-sonnet-4.5", label="report",
        **no_tools,
    )
    print(report.content)
