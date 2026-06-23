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


def review(path):
    finding = wf.agent(
        "Review the file `%s` for: %s. List concrete issues with line references, or reply "
        "exactly 'NO ISSUES' if there are none." % (path, concern),
        model="claude-haiku-4.5", label=path,
        **wf.quarantine(),  # untrusted file content: read-only, no shell/write/network/MCP
    )
    return path, finding


with wf.phase("audit"):
    found = wf.fan_out(paths, review)

# keep only files that reported issues, then adversarially verify those
flagged = [(p, f) for (p, f) in found if f.ok and "NO ISSUES" not in f.content.upper()]
with wf.phase("verify"):
    checked = wf.fan_out(flagged, lambda pf: (
        pf[0], pf[1],
        wf.verify(pf[1], rubric="each reported issue is real and relevant to: %s" % concern,
                  refute=True, model="claude-haiku-4.5")))

solid = [(p, f) for (p, f, v) in checked if v.passed]
if not solid:
    print("audit: no verified issues found for: %s" % concern)
else:
    report = wf.synthesize(
        ["## %s\n%s" % (p, f.content) for (p, f) in solid],
        prompt="Summarize these verified findings about '%s'. Group by severity, most serious "
               "first, and give a one-line fix suggestion per issue." % concern,
        model="claude-sonnet-4.5", label="report",
    )
    print(report.content)
