# deep-research.cwf.py — fan out research across angles, cross-check, synthesize a cited report.
#
#   cwf run ~/.copilot/workflows/deep-research.cwf.py --budget 30 \
#       --args '"What changed in the Python packaging ecosystem between 2020 and 2024?"'
#   cwf run ~/.copilot/workflows/deep-research.cwf.py --args '{"question":"...","angles":6}'
#
# Note: research workers use whatever web-search/fetch tools the agent has, so run WITHOUT
# --disable-mcp (network access is the point here).
import json
import re

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


def extract_str_array(text):
    for block in reversed(re.findall(r"\[(?:[^\[\]]|\n)*\]", text or "", re.S)):
        try:
            val = json.loads(block)
        except Exception:
            continue
        if isinstance(val, list) and val:
            return [str(x).strip() for x in val if str(x).strip()]
    return None


# ---- 1) decompose into independent angles ---------------------------------
plan = wf.agent(
    "Break the following research question into %d independent sub-questions or angles "
    "to investigate. Return ONLY a JSON array of strings on the final line.\n\nQuestion: %s"
    % (max_angles, question),
    model="claude-sonnet-4.5", label="plan",
)
angles = extract_str_array(plan.content) or [question]
wf.log("deep-research: %d angle(s)" % len(angles))

# ---- 2) fan out: research each angle, citing sources ----------------------
with wf.phase("research"):
    findings = wf.fan_out(angles, lambda a: wf.agent(
        "Research this question using web search. State concrete findings and cite EVERY claim "
        "with a source URL. If evidence is thin or conflicting, say so.\n\nQuestion: %s" % a,
        model="claude-haiku-4.5", label=a[:24],
        # Reads untrusted web content -> deny shell/write to contain prompt injection,
        # but keep network + MCP (web access is the whole point of this step).
        **wf.quarantine(deny_url=[], disable_mcp=False),
    ))

# ---- 3) adversarially verify each finding ---------------------------------
with wf.phase("verify"):
    checked = wf.fan_out(findings, lambda f: (
        f, wf.verify(f, rubric="every factual claim is supported by a cited, credible source URL",
                     refute=True, model="claude-haiku-4.5")))
trusted = [f for (f, v) in checked if v.passed]
wf.log("deep-research: %d/%d findings survived verification" % (len(trusted), len(findings)))

# ---- 4) synthesize a cited report -----------------------------------------
report = wf.synthesize(
    trusted or findings,
    prompt=("Write a well-structured, cited report that answers the question below using the "
            "findings. Keep only well-sourced claims; list any open questions at the end.\n\n"
            "Question: %s" % question),
    model="claude-sonnet-4.5", label="report",
)
print(report.content)
