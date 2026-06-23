#!/usr/bin/env python3
"""A fake `copilot` for zero-credit testing of the cwf runtime.

It speaks just enough of the real `copilot -p ... --output-format json` contract:
emit some ignorable JSONL events, one `assistant.message` with `content`, and a
terminal `result` carrying `sessionId`, `exitCode`, and `usage.premiumRequests`.

Behavior is steered by directives embedded anywhere in the prompt:

    [[FAKE:{"category": "bug"}]]      -> emits that JSON as the message's final line
    [[FAKE:{"_content": "hello"}]]    -> uses "hello" as the whole message content
    [[FAKE:{"_cr": 0.5, ...}]]        -> reports 0.5 premium credits
    [[FAKE:{"_exit": 2}]]             -> exits non-zero (simulate failure)

The LAST directive in the prompt wins. With no directive, it echoes the prompt.
"""
import json
import re
import sys
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
    if isinstance(payload, dict):
        cr = float(payload.pop("_cr", 0.01))
        exit_code = int(payload.pop("_exit", 0))
        if "_content" in payload:
            content = str(payload.pop("_content"))

    if content is None:
        if payload:
            content = "stub reasoning.\n" + json.dumps(payload)
        else:
            content = "stub reply to: " + prompt[:60].replace("\n", " ")

    sid = str(uuid.uuid4())
    out_tokens = max(1, len(content) // 4)

    def emit(obj):
        sys.stdout.write(json.dumps(obj) + "\n")

    # ignorable events the parser must skip over
    emit({"type": "session.skills_loaded", "data": {"skills": []}, "ephemeral": True})
    emit({"type": "assistant.turn_start", "data": {"turnId": "0"}})
    emit({"type": "assistant.reasoning_delta", "data": {"deltaContent": "thinking"}, "ephemeral": True})
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
