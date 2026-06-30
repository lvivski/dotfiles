#!/usr/bin/env python3
"""A fake `copilot` for zero-credit testing of the cwf runtime.

It speaks just enough of the real `copilot -p ... --output-format json` contract:
emit some ignorable JSONL events, one `assistant.message` with `content`, and a
terminal `result` carrying `sessionId`, `exitCode`, and a session shutdown AIC record.

Behavior is steered by directives embedded anywhere in the prompt:

    [[FAKE:{"category": "bug"}]]      -> emits that JSON as the message's final line
    [[FAKE:{"_content": "hello"}]]    -> uses "hello" as the whole message content
    [[FAKE:{"_cr": 0.5, ...}]]        -> reports 0.5 fallback cost units
    [[FAKE:{"_exit": 2}]]             -> exits non-zero (simulate failure)
    [[FAKE:{"_sleep": 1.0}]]          -> sleeps 1.0s before output (simulate a hang)
    [[FAKE:{"_session_error": "x"}]]  -> emits a soft session.error event

The LAST directive in the prompt wins. With no directive, it echoes the prompt.
"""
import json
import os
import re
import sys
import time
import uuid


def main() -> int:
    argv = sys.argv[1:]
    prompt = ""
    for i, a in enumerate(argv):
        if a in ("-p", "--prompt") and i + 1 < len(argv):
            prompt = argv[i + 1]
            break

    payload = {}
    for raw in re.findall(r"\[\[FAKE:(.*?)\]\]", prompt, re.S):
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {}

    cr = 0.01
    exit_code = 0
    content = None
    sleep_s = 0.0
    session_error = None
    error_type = "model_call"
    if isinstance(payload, dict):
        cr = float(payload.pop("_cr", 0.01))
        exit_code = int(payload.pop("_exit", 0))
        sleep_s = float(payload.pop("_sleep", 0.0))
        session_error = payload.pop("_session_error", None)
        error_type = str(payload.pop("_error_type", error_type))
        if "_content" in payload:
            content = str(payload.pop("_content"))

    if content is None:
        if payload:
            content = "stub reasoning.\n" + json.dumps(payload)
        else:
            content = "stub reply to: " + prompt[:60].replace("\n", " ")

    sid = str(uuid.uuid4())
    out_tokens = max(1, len(content) // 4)
    copilot_home = os.environ.get("COPILOT_HOME") or os.path.expanduser("~/.copilot")
    state = os.path.join(copilot_home, "session-state", sid)
    os.makedirs(state, exist_ok=True)
    with open(os.path.join(state, "events.jsonl"), "w", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "type": "session.shutdown",
            "data": {"shutdownType": "routine", "totalNanoAiu": int(cr * 1_000_000_000)},
        }) + "\n")

    def emit(obj):
        sys.stdout.write(json.dumps(obj) + "\n")

    if sleep_s > 0:  # simulate a hung agent so the runtime's timeout/kill path can be tested
        time.sleep(sleep_s)

    # ignorable events the parser must skip over
    emit({"type": "session.skills_loaded", "data": {"skills": []}, "ephemeral": True})
    emit({"type": "assistant.turn_start", "data": {"turnId": "0"}})
    emit({"type": "assistant.reasoning_delta", "data": {"deltaContent": "thinking"}, "ephemeral": True})
    if session_error is not None:
        emit({"type": "session.error", "data": {
            "errorType": error_type, "message": str(session_error),
        }})
    emit({"type": "assistant.message", "data": {
        "messageId": sid, "model": "fake", "content": content,
        "toolRequests": [], "outputTokens": out_tokens,
    }})
    emit({"type": "assistant.turn_end", "data": {"turnId": "0"}})
    emit({"type": "result", "sessionId": sid, "exitCode": exit_code, "usage": {
        "premiumRequests": cr, "totalApiDurationMs": 1, "sessionDurationMs": 1,
        "codeChanges": {"linesAdded": 0, "linesRemoved": 0, "filesModified": []},
    }})
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
